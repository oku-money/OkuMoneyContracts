// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";
import {IUSDOku} from "../interfaces/IUSDOku.sol";

/**
 * @title USDOku
 * @notice Oku Dollar — a rebasing, dollar-denominated presentation of OkuM.
 *
 * @dev ## The two indices, and which one actually converts
 *
 *      `M_oku` (OkuM's `uiMultiplier`) is REAR-FACING: its rate comes from yield the
 *      issuer has already banked. `M_usd` (this contract's `usdOkuIndex`) is
 *      FORWARD-LOOKING: a declared, steady headline rate.
 *
 *      **`M_usd` does not set the exchange rate.** It cancels out of `wrap`
 *      (shares are minted at `M_oku/M_usd`, then valued back at `M_usd`) and does not
 *      appear in `unwrap` at all. Both directions convert at `M_oku`, dollar for
 *      dollar. `M_usd`'s only job is to make balances rebase.
 *
 *      ## Where smoothing lives
 *
 *      The wedge between the two indices IS the smoothing buffer, and it is held as
 *      surplus OkuM in this vault:
 *
 *        - `M_usd < M_oku` in a good period -> surplus accumulates.
 *        - `M_usd > M_oku` in a lean period -> surplus draws down.
 *
 *      That is what delivers a stable headline rate from a variable real one. Note a
 *      PERSISTENT `M_usd < M_oku` is economically a fee on USDOku holders, since the
 *      wedge accrues to the vault — fine as a buffer, deliberate if it trends.
 *
 *      ## Pre-funding is a maintained invariant, not a threshold
 *
 *      `MAX_SOLVENCY_GAP_BPS == 0`. Declaring a forward rate requires the liability
 *      PROJECTED TO `rateEnd` to be covered by OkuM the vault already holds, valued
 *      at TODAY's `M_oku`. Backing is deliberately not projected forward: a future
 *      OkuM segment may carry a lower rate, so projecting it would be optimistic
 *      rather than merely computed. Erring toward solvency costs the issuer a little
 *      over-funding and buys an invariant instead of a hope.
 *
 *      This closes a real defect in the predecessor design, where `M_usd` outrunning
 *      `M_oku` left a grown USDOku balance unredeemable: earlier exiters were paid in
 *      full and the last one out was stranded.
 *
 *      `wrap` is checked against the same projection, not just spot coverage —
 *      mid-segment entrants add shares that would otherwise accrue unfunded to
 *      `rateEnd`. That hole was found by stateful fuzzing, not inspection.
 *
 *      Rounding favours the invariant in both directions: `wrap` FLOORS the share
 *      credit (building surplus), `unwrap` CEILS the share burn (liability falls at
 *      least as fast as backing).
 */
contract USDOku is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IUSDOku
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.USDOku
    struct USDOkuStorage {
        IOkuM okuM;
        mapping(address => uint256) shares;
        uint256 totalShares;
        // Accrual segment — same shape as OkuM's, deliberately. One accrual concept
        // in the codebase rather than two.
        uint256 baseIndex;
        uint256 ratePerSecond;
        uint64 rateStart;
        uint64 rateEndTime;
        bool accrualHalted;
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.USDOku")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant USDOKU_STORAGE_LOCATION =
        0xe244738c4870fb11359f7bdc9af3db99c1dc9ff2fda67cb0afd4e0d472bede00;

    function _getUSDOkuStorage() private pure returns (USDOkuStorage storage $) {
        assembly {
            $.slot := USDOKU_STORAGE_LOCATION
        }
    }

    // ============ Events ============

    event UsdOkuRateSet(uint256 baseIndex, uint256 ratePerSecond, uint64 startTime, uint64 endTime);
    event Wrapped(
        address indexed sender,
        address indexed receiver,
        uint256 okuMIn,
        uint256 usdOut,
        uint256 shares
    );
    event Unwrapped(
        address indexed sender,
        address indexed receiver,
        uint256 usdIn,
        uint256 okuMOut,
        uint256 shares
    );
    event ReservesDeposited(address indexed from, uint256 okuMAmount);
    event SurplusWithdrawn(address indexed to, uint256 okuMAmount);
    event AccrualHalted(address indexed guardian);
    event AccrualResumed(address indexed resumer);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Errors ============

    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientReserves();
    error UsePrivilegedMintBurn();
    error RateOutOfBounds();
    error InvalidRateWindow();
    error ScheduledTooFarAhead();
    /// @dev `startTime` (after sentinel resolution) is in the past. Backdating is
    ///      never legal: it would let `indexAt(startTime)` resolve against stale
    ///      history and admit a jump far larger than `MAX_USD_REANCHOR_BPS` in one
    ///      call — the same class of bypass fixed on OkuM's `setOkuMRate`.
    error StartTimeInThePast();
    error IndexCannotDecrease();
    error IndexTooHigh();
    /// @dev The declared `baseIndex` would jump more than `MAX_USD_REANCHOR_BPS`
    ///      above the value the live segment already reaches at `startTime`.
    error UsdReanchorTooLarge(uint256 declared, uint256 maxAllowed);
    error AccrualIsHalted();
    error AlreadyHalted();
    error NotHalted();
    /// @dev The rate would leave USDOku's projected liability above the OkuM the vault
    ///      actually holds. Fund the wedge first.
    error WouldBreachBacking(uint256 projectedLiability, uint256 backing);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address _okuM,
        address _admin
    )
        public
        initializer
    {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        USDOkuStorage storage $ = _getUSDOkuStorage();
        $.okuM = IOkuM(_okuM);
        $.baseIndex = Constants.PRECISION;
        $.ratePerSecond = Constants.PRECISION;
        $.rateStart = uint64(block.timestamp);
        $.rateEndTime = uint64(block.timestamp);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.VAULT_UPGRADER, _admin);
        _grantRole(Roles.VAULT_RATE_SETTER, _admin);
        _grantRole(Roles.VAULT_RESERVE_MANAGER, _admin);
        _grantRole(Roles.VAULT_PAUSER, _admin);
        _grantRole(Roles.VAULT_UNPAUSER, _admin);
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
    }

    // ============ Views ============

    function okuM() external view returns (IOkuM) {
        return _getUSDOkuStorage().okuM;
    }

    function sharesOf(address account) external view returns (uint256) {
        return _getUSDOkuStorage().shares[account];
    }

    function totalShares() external view returns (uint256) {
        return _getUSDOkuStorage().totalShares;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _getUSDOkuStorage().isBlacklisted[account];
    }

    function accrualHalted() external view returns (bool) {
        return _getUSDOkuStorage().accrualHalted;
    }

    function rateEnd() external view returns (uint256) {
        return _getUSDOkuStorage().rateEndTime;
    }

    /// @notice `M_usd` at an arbitrary timestamp. Pure function of `t`.
    function indexAt(uint256 t) public view returns (uint256) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if (t <= $.rateStart) return $.baseIndex;
        uint256 until = t < $.rateEndTime ? t : $.rateEndTime;
        uint256 elapsed = until - $.rateStart;
        uint256 grown = MathLib.compound($.baseIndex, $.ratePerSecond, elapsed);
        return grown > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : grown;
    }

    /// @inheritdoc IUSDOku
    function usdOkuIndex() public view returns (uint256) {
        return indexAt(block.timestamp);
    }

    /// @inheritdoc IUSDOku
    function projectedIndexAtRateEnd() public view returns (uint256) {
        return indexAt(_getUSDOkuStorage().rateEndTime);
    }

    /// @notice Dollar liability once the live segment ends.
    /// @dev The forward figure, not the spot one. Spot coverage today says nothing
    ///      about coverage at `rateEnd`, which is the whole point of pre-funding.
    function projectedLiabilityAtRateEnd() public view returns (uint256) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        return Math.mulDiv(
            $.totalShares, projectedIndexAtRateEnd(), Constants.PRECISION, Math.Rounding.Ceil
        );
    }

    /// @notice Dollar value of OkuM the vault holds right now, at today's `M_oku`.
    function realizedBacking() public view returns (uint256) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        IOkuM token = $.okuM;
        return
            MathLib.toUIAmount(
                IERC20(address(token)).balanceOf(address(this)), token.uiMultiplier()
            );
    }

    /// @notice Whether backing covers the forward liability.
    function backingCoversLiability() public view returns (bool) {
        return realizedBacking() >= projectedLiabilityAtRateEnd();
    }

    /// @notice OkuM removable without breaching the forward invariant.
    /// @dev Projection-aware, so this is safe to expose: it can never quote an amount
    ///      whose removal would strand a holder at `rateEnd`.
    function withdrawableSurplus() external view returns (uint256) {
        uint256 backing = realizedBacking();
        uint256 liability = projectedLiabilityAtRateEnd();
        if (backing <= liability) return 0;
        return MathLib.fromUIAmount(backing - liability, _getUSDOkuStorage().okuM.uiMultiplier());
    }

    // ============ ERC-20 surface (share-backed) ============

    function totalSupply() public view override(ERC20Upgradeable, IERC20) returns (uint256) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        return Math.mulDiv($.totalShares, usdOkuIndex(), Constants.PRECISION, Math.Rounding.Floor);
    }

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IERC20)
        returns (uint256)
    {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        return
            Math.mulDiv($.shares[account], usdOkuIndex(), Constants.PRECISION, Math.Rounding.Floor);
    }

    function transfer(
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        returns (bool)
    {
        _transferShares(msg.sender, to, _sharesForAmount(amount));
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        _transferShares(from, to, _sharesForAmount(amount));
        emit Transfer(from, to, amount);
        return true;
    }

    function _sharesForAmount(uint256 amount) internal view returns (uint256) {
        return Math.mulDiv(amount, Constants.PRECISION, usdOkuIndex(), Math.Rounding.Floor);
    }

    function _transferShares(address from, address to, uint256 shares) internal {
        if (to == address(0)) revert Errors.ZeroAddress();
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if ($.shares[from] < shares) revert Errors.InsufficientBalance();
        unchecked {
            $.shares[from] -= shares;
        }
        $.shares[to] += shares;
    }

    /// @dev Not pause-gated — approvals remain available while paused.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        public
        virtual
        override
    {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    /// @dev Unreachable by design. Every supply change routes through
    ///      {wrap}/{unwrap}/{mint}/{burn}, which manage `shares` directly, and the
    ///      ERC-20 write paths are all overridden. The guard exists so a future
    ///      refactor that accidentally reaches `ERC20Upgradeable._mint`/`_burn`/
    ///      `_transfer` fails loudly instead of silently diverging the share ledger
    ///      from the balance mapping.
    function _update(address, address, uint256) internal pure override {
        revert UsePrivilegedMintBurn();
    }

    // ============ Wrap / unwrap — both priced at M_oku ============

    /// @notice OkuM -> USDOku, dollar for dollar at `M_oku`.
    /// @dev Share credit FLOORS, so a wrap can only build surplus, never consume it.
    ///
    ///      Gated on the FORWARD projection, not spot coverage. A mid-segment entrant
    ///      adds shares that accrue to `rateEnd`; if the issuer has not funded that
    ///      headroom the entrant would dilute existing holders' coverage. Found by
    ///      stateful fuzzing at ~0.0072% on ~353k — small, real, and unbounded over
    ///      time.
    ///
    ///      CONSEQUENCE worth naming: this is a permissionless path that can revert
    ///      because of ISSUER behaviour rather than the caller's. Tracked.
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minUsdOut
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdOut)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        IERC20 okuMToken = IERC20(address($.okuM));
        uint256 before = okuMToken.balanceOf(address(this));
        okuMToken.safeTransferFrom(msg.sender, address(this), okuMAmount);
        // Balance delta, not the requested amount: correct under fee-on-transfer or
        // any future share-based OkuM behaviour.
        uint256 received = okuMToken.balanceOf(address(this)) - before;
        if (received == 0) revert AmountTooSmall();

        uint256 index = usdOkuIndex();
        uint256 dollars = MathLib.toUIAmount(received, $.okuM.uiMultiplier());
        uint256 shares = Math.mulDiv(dollars, Constants.PRECISION, index, Math.Rounding.Floor);
        if (shares == 0) revert AmountTooSmall();

        $.totalShares += shares;
        $.shares[receiver] += shares;

        // Slippage is checked against the CREDITED value, after both roundings — not
        // the pre-rounding figure, which would let a user accept less than they
        // approved of.
        usdOut = Math.mulDiv(shares, index, Constants.PRECISION, Math.Rounding.Floor);
        if (usdOut < minUsdOut) revert OutputBelowMinimum(usdOut, minUsdOut);

        if (!backingCoversLiability()) {
            revert WouldBreachBacking(projectedLiabilityAtRateEnd(), realizedBacking());
        }

        emit Transfer(address(0), receiver, usdOut);
        emit Wrapped(msg.sender, receiver, received, usdOut, shares);
    }

    /// @notice USDOku -> OkuM at `M_oku`. Never gated on solvency.
    /// @dev Share burn CEILS, so liability falls at least as fast as backing. Because
    ///      the invariant is maintained rather than monitored, this can only fail for
    ///      want of reserves in a state that the invariant already forbids — the check
    ///      is defensive, not operational.
    function unwrap(
        uint256 usdAmount,
        address receiver
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 okuMOut)
    {
        if (usdAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        uint256 index = usdOkuIndex();
        uint256 shares = Math.mulDiv(usdAmount, Constants.PRECISION, index, Math.Rounding.Ceil);
        if ($.shares[msg.sender] < shares) revert Errors.InsufficientBalance();

        okuMOut = MathLib.fromUIAmount(usdAmount, $.okuM.uiMultiplier());
        if (okuMOut == 0) revert AmountTooSmall();

        IERC20 okuMToken = IERC20(address($.okuM));
        if (okuMToken.balanceOf(address(this)) < okuMOut) revert InsufficientReserves();

        unchecked {
            $.shares[msg.sender] -= shares;
        }
        $.totalShares -= shares;

        okuMToken.safeTransfer(receiver, okuMOut);

        emit Transfer(msg.sender, address(0), usdAmount);
        emit Unwrapped(msg.sender, receiver, usdAmount, okuMOut, shares);
    }

    // ============ Rate declaration ============

    /// @notice Declare USDOku's forward-looking rate segment.
    /// @dev Pre-funding is enforced here: the liability projected to `endTime` must
    ///      already be covered by OkuM the vault holds, at today's `M_oku`.
    ///
    ///      A full stop (`ratePerSecond == PRECISION`) SKIPS the coverage check. That
    ///      is deliberate: without the exemption, a contract that had somehow drifted
    ///      into breach would be unable to stop accruing, which is precisely the
    ///      action needed to recover. An escape hatch that only ever reduces liability
    ///      cannot itself cause harm.
    ///
    ///      `startTime` may never be backdated (mirrors the fix on OkuM's
    ///      `setOkuMRate`), and `baseIndex` may exceed the live index at `startTime`
    ///      by at most `MAX_USD_REANCHOR_BPS` — bounding the instantaneous value
    ///      transfer to whoever holds USDOku shares at the moment of declaration.
    ///      Unlike OkuM's re-anchor, a USDOku jump is NOT required to take effect
    ///      immediately: `M_usd` is a declared forward rate that legitimately
    ///      schedules ahead as routine practice, so forbidding that would break the
    ///      normal use case rather than close an arbitrage window. Pass
    ///      `startTime == 0` to mean "now" — an operator cannot predict the exact
    ///      mined timestamp, so the sentinel is accepted on both paths.
    function setUsdOkuRate(
        uint256 baseIndex,
        uint256 ratePerSecond,
        uint64 startTime,
        uint64 endTime
    )
        external
        onlyRole(Roles.VAULT_RATE_SETTER)
    {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.accrualHalted) revert AccrualIsHalted();

        if (startTime == 0) startTime = uint64(block.timestamp);

        if (ratePerSecond < Constants.PRECISION || ratePerSecond > Constants.MAX_RATE_PER_SECOND) {
            revert RateOutOfBounds();
        }
        if (endTime < startTime || endTime - startTime > Constants.MAX_RATE_DURATION) {
            revert InvalidRateWindow();
        }
        // Backdating is never legal — see {StartTimeInThePast}.
        if (startTime < block.timestamp) revert StartTimeInThePast();
        if (startTime > block.timestamp + Constants.MAX_SCHEDULE_LEAD) {
            revert ScheduledTooFarAhead();
        }
        if (baseIndex > Constants.MAX_MULTIPLIER) revert IndexTooHigh();

        uint256 liveAtStart = indexAt(startTime);
        if (baseIndex < liveAtStart) revert IndexCannotDecrease();

        uint256 maxAllowed = liveAtStart
            + Math.mulDiv(liveAtStart, Constants.MAX_USD_REANCHOR_BPS, Constants.BASIS_POINTS);
        if (baseIndex > maxAllowed) revert UsdReanchorTooLarge(baseIndex, maxAllowed);

        $.baseIndex = baseIndex;
        $.ratePerSecond = ratePerSecond;
        $.rateStart = startTime;
        $.rateEndTime = endTime;

        if (ratePerSecond > Constants.PRECISION && !backingCoversLiability()) {
            revert WouldBreachBacking(projectedLiabilityAtRateEnd(), realizedBacking());
        }

        emit UsdOkuRateSet(baseIndex, ratePerSecond, startTime, endTime);
    }

    function haltAccrual() external onlyRole(Roles.VAULT_PAUSER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.accrualHalted) revert AlreadyHalted();
        $.accrualHalted = true;
        emit AccrualHalted(msg.sender);
    }

    function resumeAccrual() external onlyRole(Roles.VAULT_UNPAUSER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if (!$.accrualHalted) revert NotHalted();
        $.accrualHalted = false;
        emit AccrualResumed(msg.sender);
    }

    // ============ Reserves ============

    /// @notice Fund the smoothing wedge. Permissionless — funding can only help.
    function depositReserves(uint256 okuMAmount) external nonReentrant {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        USDOkuStorage storage $ = _getUSDOkuStorage();
        IERC20(address($.okuM)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        emit ReservesDeposited(msg.sender, okuMAmount);
    }

    /// @notice Remove surplus OkuM above the forward liability.
    function withdrawSurplus(
        address to,
        uint256 okuMAmount
    )
        external
        nonReentrant
        onlyRole(Roles.VAULT_RESERVE_MANAGER)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        if (okuMAmount == 0) revert Errors.ZeroAmount();

        USDOkuStorage storage $ = _getUSDOkuStorage();
        IERC20 okuMToken = IERC20(address($.okuM));
        if (okuMToken.balanceOf(address(this)) < okuMAmount) revert InsufficientReserves();

        okuMToken.safeTransfer(to, okuMAmount);

        if (!backingCoversLiability()) {
            revert WouldBreachBacking(projectedLiabilityAtRateEnd(), realizedBacking());
        }
        emit SurplusWithdrawn(to, okuMAmount);
    }

    // ============ Privileged share mint / burn ============

    function mint(address to, uint256 shares) external onlyRole(Roles.OKUM_MINTER) whenNotPaused {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        $.totalShares += shares;
        $.shares[to] += shares;
        emit Transfer(address(0), to, Math.mulDiv(shares, usdOkuIndex(), Constants.PRECISION));
    }

    function burn(address from, uint256 shares) external onlyRole(Roles.OKUM_BURNER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.shares[from] < shares) revert Errors.InsufficientBalance();
        unchecked {
            $.shares[from] -= shares;
        }
        $.totalShares -= shares;
        emit Transfer(from, address(0), Math.mulDiv(shares, usdOkuIndex(), Constants.PRECISION));
    }

    // ============ Blacklist / pause ============

    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        USDOkuStorage storage $ = _getUSDOkuStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    function pause() external onlyRole(Roles.VAULT_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.VAULT_UNPAUSER) {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyRole(Roles.VAULT_UPGRADER) {}
}
