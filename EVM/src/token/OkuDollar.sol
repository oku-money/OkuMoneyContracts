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
import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {YieldSandwichGuard} from "../lib/YieldSandwichGuard.sol";
import {OkuDollarEvents} from "../lib/events/OkuDollarEvents.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";

/**
 * @title OkuDollar
 * @notice Rebasing $1-pegged stablecoin (ticker `UsdOku`) wrapping OkuMoney.
 * @dev SINGLE MULTIPLIER DESIGN: `usdMultiplier()` is exactly
 *      `okuMoney.okuMMultiplier()` — OkuDollar has no independent yield rate. README.md
 *      § Token Model covers the consequences (collateralization exactly 1.0, ERC-4626
 *      inflation-attack immunity, why donations need {rescueDonation}); the "ERC-4626
 *      Surface" section below covers why `ERC4626Upgradeable` is not inherited.
 *
 *      TERMINOLOGY HAZARD: internal `usdShares` (non-rebasing accounting unit) and
 *      ERC-4626 "shares" (the rebasing displayed balance) are DIFFERENT quantities.
 *      `convertToShares` returns the latter.
 *
 *      See Constants.sol for terminology legend and {OkuMoney.initialize} for the unified
 *      role-grant policy. Storage uses ERC-7201 (https://eips.ethereum.org/EIPS/eip-7201).
 */
contract OkuDollar is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    YieldSandwichGuard,
    UUPSUpgradeable,
    OkuDollarEvents,
    IOkuDollar,
    IERC4626
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuDollar
    struct OkuDollarStorage {
        IOkuMoney okuMoney;
        // Internal share accounting. NOT the ERC-4626 "shares" quantity — see the
        // terminology hazard in the contract NatSpec. Under the single-multiplier design
        // these are numerically identical to raw OkuM deposited.
        mapping(address => uint256) usdShares;
        uint256 totalUsdShares;
        // Uses the shared OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role names: a blacklisted
        // address must not be able to hold or transfer UsdOku either.
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuDollar")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUDOLLAR_STORAGE_LOCATION =
        0x47ad802b8b69e1fb26602029cb9d680d20222bfb119aa501ef9624c481132900;

    function _getOkuDollarStorage() private pure returns (OkuDollarStorage storage $) {
        assembly {
            $.slot := OKUDOLLAR_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress, MultiplierCannotDecrease, ZeroAmount, InsufficientBalance)
    // live in lib/Errors.sol. YieldDistributionInProgress is inherited from YieldSandwichGuard.
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientReserves();
    /// @notice {rescueDonation} would dip into OkuM that backs outstanding shares.
    error NoDonationAvailable();
    /// @notice Direct `_mint` is forbidden; use `wrap()`.
    error UseWrapInstead();
    /// @notice Direct `_burn` is forbidden; use `unwrap()`.
    error UseUnwrapInstead();
    /// @notice The inherited ERC-20 `_update` path must never execute — OkuDollar uses
    ///         share-based accounting for every transfer type.
    error OkuDollarDoesNotUseInternalUpdate();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the OkuDollar proxy.
    /// @param _okuMoney OkuMoney token address (backing reserve asset).
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol (canonical ticker is `usdOku`).
    /// @param _admin Admin address (receives full vault role set; see {OkuMoney.initialize}).
    /// @dev Takes no collateral-ratio parameter: collateralization is exactly 1.0 by
    ///      construction under the single-multiplier design.
    function initialize(
        address _okuMoney,
        string memory name_,
        string memory symbol_,
        address _admin
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.okuMoney = IOkuMoney(_okuMoney);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.VAULT_UPGRADER, _admin);
        _grantRole(Roles.VAULT_PAUSER, _admin);
        _grantRole(Roles.VAULT_UNPAUSER, _admin);
        _grantRole(Roles.VAULT_RESCUER, _admin);
        // Shared blacklist roles: a single grant covers both OkuMoney and OkuDollar.
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
    }

    // ============ ERC-20 Metadata ============

    /// @notice Token decimals — fixed at {Constants.OKU_M_DECIMALS} (18).
    /// @dev Overridden rather than inherited from OZ's default deliberately, and matches
    ///      {OkuMoney.decimals} by construction: UsdOku is quoted in the same 18-decimal
    ///      dollar scale as `Constants.PRECISION`, and the PSM's USDC conversion exponent
    ///      (`10 ** (OKU_M_DECIMALS - usdcDecimals)`) is derived from the same constant.
    ///      Returning the constant binds the reported value to that source of truth
    ///      instead of coincidentally agreeing with it.
    ///
    ///      NOTE: unlike OZ's {ERC4626Upgradeable}, this vault does NOT offset decimals
    ///      against the underlying asset — `asset()` (OkuM) and this share token are both
    ///      fixed at 18, so there is no offset to apply. See the ERC-4626 Surface section
    ///      for why `ERC4626Upgradeable` is not inherited.
    function decimals() public pure override(ERC20Upgradeable, IERC20Metadata) returns (uint8) {
        return Constants.OKU_M_DECIMALS;
    }

    // ============ Storage Accessor Views ============

    function okuMoney() external view returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    /// @notice Total internal share tokens across all holders.
    /// @dev NOT the ERC-4626 `totalSupply()` of shares (see the contract NatSpec
    ///      terminology hazard). Equals the raw OkuM held as reserves.
    function totalUsdShares() external view returns (uint256) {
        return _getOkuDollarStorage().totalUsdShares;
    }

    /// @notice Internal share balance for `account`.
    function usdSharesOf(address account) external view returns (uint256) {
        return _getOkuDollarStorage().usdShares[account];
    }

    /// @notice Whether `account` is on the OkuDollar blacklist.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuDollarStorage().isBlacklisted[account];
    }

    // ============ USD Multiplier (Delegated to OkuMoney) ============

    /// @notice Dollar value per UsdOku share, 1e18 = $1.00.
    /// @dev SINGLE MULTIPLIER: exactly `okuMoney.okuMMultiplier()`. OkuDollar holds no
    ///      rate state of its own, so OkuM and UsdOku cannot diverge and there is one
    ///      schedule to keep in sync across chains. Inherits OkuMoney's continuous
    ///      streaming: no discrete step, nothing to sandwich.
    function usdMultiplier() public view returns (uint256) {
        return _getOkuDollarStorage().okuMoney.okuMMultiplier();
    }

    // ============ ERC20 Overrides (USD Share-based) ============

    function totalSupply()
        public
        view
        override(ERC20Upgradeable, IOkuDollar, IERC20)
        returns (uint256)
    {
        return Math.mulDiv(
            _getOkuDollarStorage().totalUsdShares,
            usdMultiplier(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IOkuDollar, IERC20)
        returns (uint256)
    {
        return Math.mulDiv(
            _getOkuDollarStorage().usdShares[account],
            usdMultiplier(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
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
        uint256 multiplier = usdMultiplier();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
        _transferUsdShares(msg.sender, to, shares, multiplier);
        // Emit the effective post-rounding dollar amount rather than the caller's
        // `amount`: it is the closest single number to the value that moved, and never
        // above it.
        //
        // NO emitted value can make `sum(Transfer.value) == Δ balanceOf` hold.
        // `balanceOf` floors PER ACCOUNT, so the sender's decrease and the receiver's
        // increase each depend on that party's own residue and need not agree. At
        // `m = 1.5e18`, `transfer(bob, 2)` moves 1 share: Alice's balanceOf falls 1
        // while Bob's rises 2. One event cannot report both.
        //
        // INTEGRATORS MUST READ BALANCES FROM `balanceOf()`. `Transfer.value` is
        // advisory, +/-1 wei per transfer and unbounded in aggregate. Same for `wrap`'s
        // and `_unwrap`'s mint/burn events. Inherent to share-based rebasing; stETH
        // behaves identically.
        //
        // Related: `totalSupply()` floors the AGGREGATE share count while `sum(balanceOf)`
        // floors each holder, so `totalSupply() >= sum(balanceOf)` with a gap up to
        // `holders - 1` wei. Direction is safe, but conservation invariants must use
        // `>=`, not `==`.
        uint256 effective =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(msg.sender, to, effective);
        return true;
    }

    /// @dev Allowance is debited by the caller-supplied `amount`, while the value actually
    ///      moved is `effective = floor(shares * multiplier / 1e18)`. Share derivation
    ///      floors, so `effective <= amount` always and the gap (at most 1 wei per call)
    ///      is consumed from the allowance rather than the holder's balance — in the
    ///      protocol's favor, the same flooring direction as `wrap` / `unwrap`. Indexers
    ///      should read the moved value from the `Transfer` event, not the allowance delta.
    ///
    ///      Checks the SPENDER's blacklist status, matching Circle FiatToken's
    ///      `transferFrom` (`notBlacklisted(msg.sender)` alongside `from`/`to`).
    ///      `_transferUsdShares` below already blocks a blacklisted `from`/`to`; it
    ///      has no spender parameter to also check the third party in this call —
    ///      the approved caller moving someone else's clean funds between clean
    ///      addresses. A pre-existing allowance survives blacklisting unrevoked (see
    ///      `approve`'s NatSpec), so without this check it stayed fully exercisable.
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
        if (_getOkuDollarStorage().isBlacklisted[_msgSender()]) revert SenderBlacklisted();
        _spendAllowance(from, msg.sender, amount);
        uint256 multiplier = usdMultiplier();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
        _transferUsdShares(from, to, shares, multiplier);
        // See `transfer` above.
        uint256 effective =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(from, to, effective);
        return true;
    }

    /// @dev The public ERC-20 `Transfer` event is emitted by the calling function, which
    ///      uses the post-rounding `effective` value, NOT the caller's raw input amount.
    ///      This helper only tracks share movement plus dollar value. `multiplier` is
    ///      threaded in by the caller (which already read `usdMultiplier()` to compute
    ///      `shares`) rather than re-read here — halves the cross-contract
    ///      `okuMoney.okuMMultiplier()` calls (and the `rpow` behind them) per transfer.
    function _transferUsdShares(
        address from,
        address to,
        uint256 shares,
        uint256 multiplier
    )
        internal
    {
        if (from == address(0)) revert Errors.ZeroAddress();
        if (to == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        uint256 fromBalance = $.usdShares[from];
        if (fromBalance < shares) revert Errors.InsufficientBalance();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        uint256 dollarValue =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit TransferValue(from, to, shares, dollarValue);
    }

    // ============ Allowances, Permit and Nonces ============
    //
    // DELIBERATELY NOT reimplemented against `usdShares`. Balances are overridden because
    // they are share-denominated and must rebase; allowances are not. An allowance is
    // already quoted in the same dollar unit as `transfer`/`transferFrom`'s `amount`
    // parameter, so the inherited `_allowances` mapping (and `_approve` /
    // `_spendAllowance` / `ERC20PermitUpgradeable`'s `_nonces`) is the correct store and
    // is read/written by OZ's own code paths unchanged.
    //
    // Consequence worth stating explicitly: unlike `_balances` above — which is dead
    // storage the `_update` guard keeps unreachable — this inherited OZ storage IS live
    // and load-bearing. `allowance()`, `nonces()` and `DOMAIN_SEPARATOR()` are inherited
    // verbatim and intentionally un-overridden. Only the two entry points needing a
    // blacklist gate are overridden below.
    //
    // Aave's aToken makes the same split (custom packed balances, plain allowance
    // mapping); the dollar-vs-share rounding consequence of it is documented on `permit`.

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @notice EIP-2612 permit with blacklist enforcement.
    /// @dev ALLOWANCE SEMANTICS: `value` is in dollar terms (same units as `balanceOf`
    ///      and `transferFrom`), but balances are stored as shares; `transferFrom(amount)`
    ///      floors the share conversion while `unwrap(amount)` ceils it. When
    ///      `usdMultiplier > 1e18`, sequential `transferFrom` calls against one
    ///      permit-approved allowance may under-consume shares by ~1 per call. Integrators
    ///      batching `transferFrom` against a permit allowance must budget for that dust.
    ///
    ///      Not pause-gated — approvals are allowed while paused (mirrors OkuMoney.permit).
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
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    /// @dev Blocks a blacklisted owner OR spender from creating a new allowance,
    ///      matching Circle FiatToken's `approve`. Does NOT retroactively revoke an
    ///      allowance already granted before either side was blacklisted — see
    ///      `transferFrom`'s NatSpec for why that residual is safe.
    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[_msgSender()]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        return super.approve(spender, value);
    }

    // ============ Inherited ERC20 guard ============

    /// @dev All supply changes go through `wrap()`/`unwrap()`, which manage `usdShares`
    ///      directly, and peer-to-peer moves through the overridden
    ///      `transfer`/`transferFrom`, so the inherited ERC-20 `_update` hook must never
    ///      execute. The unconditional revert (with diagnostic sub-errors for mint/burn)
    ///      ensures no future change can accidentally write to the inherited `_balances`
    ///      mapping, which `balanceOf()` never reads. Dead code today by construction —
    ///      nothing in this contract calls `_mint`/`_burn`/`_transfer` — and kept as a
    ///      tripwire rather than because any live path reaches it.
    ///
    ///      NOT the pattern stETH or Aave's aToken use, despite the superficial
    ///      similarity: neither inherits a stock ERC-20 at all (stETH implements IERC20
    ///      from scratch over its own `shares` mapping; Aave's `IncentivizedERC20` uses a
    ///      packed `_userState` struct), so neither has an inherited balance mapping or
    ///      `_update` hook to defend in the first place. This contract DOES inherit
    ///      `ERC20Upgradeable` — for `ERC20PermitUpgradeable`'s sake — and therefore
    ///      carries an inherited `_balances`/`_totalSupply` that must be kept
    ///      unreachable. That is the hazard this guard exists for, and it is specific to
    ///      this inheritance choice, not borrowed practice.
    function _update(address from, address to, uint256) internal pure override {
        if (from == address(0)) revert UseWrapInstead();
        if (to == address(0)) revert UseUnwrapInstead();
        revert OkuDollarDoesNotUseInternalUpdate();
    }

    // ============ Yield Distribution Lock ============

    /// @inheritdoc YieldSandwichGuard
    function _yieldSandwichOkuMoney() internal view override returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    // ============ Wrap / Unwrap (Price-Aware) ============

    /// @notice Wrap OkuMoney into OkuDollar.
    /// @dev usdMinted = okuMAmount * okuMMultiplier / PRECISION, and the shares minted
    ///      equal `okuMAmount` exactly (single multiplier). 100 OkuM at
    ///      okuMMultiplier=$1.05 mints 105 UsdOku.
    /// @param okuMAmount Amount of OkuMoney tokens to wrap
    /// @param receiver Address to receive OkuDollar
    /// @param minAmountOut Minimum OkuDollar to receive (slippage protection)
    /// @return usdMinted Amount of OkuDollar minted
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        public
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 usdMinted)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        // Measure actual tokens received (handles fee-on-transfer edge cases)
        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;

        // SINGLE MULTIPLIER: usdMultiplier() IS okuMoney.okuMMultiplier() (enforced at
        // LitePSM.initialize / this contract's asset() wiring), so shares track raw OkuM
        // 1:1 exactly — mulDiv(actualReceived, m, m, Floor) == actualReceived, no loss.
        uint256 mult = $.okuMoney.okuMMultiplier();
        uint256 sharesToMint = actualReceived;
        if (sharesToMint == 0) revert AmountTooSmall();

        usdMinted = MathLib.okuMToDollars(actualReceived, mult);
        if (usdMinted < minAmountOut) revert OutputBelowMinimum(usdMinted, minAmountOut);

        $.totalUsdShares += sharesToMint;
        $.usdShares[receiver] += sharesToMint;

        emit Transfer(address(0), receiver, usdMinted);
        emit TransferValue(address(0), receiver, sharesToMint, usdMinted);
        // `Wrapped`'s last two params are (okuMMultiplier, usdMultiplier); both are `mult`
        // because they are provably identical. Kept as two params for indexer/ABI stability.
        emit Wrapped(msg.sender, receiver, actualReceived, usdMinted, mult, mult);
        emit Deposit(msg.sender, receiver, actualReceived, usdMinted);
    }

    /// @notice Unwrap OkuDollar back to OkuMoney.
    /// @dev okuMReturned = floor(usdAmount * PRECISION / okuMMultiplier); the shares burned
    ///      use the same ratio rounded UP, favouring the vault. 105 UsdOku at
    ///      okuMMultiplier=$1.05 returns 100 OkuM. Reverts if the vault holds
    ///      insufficient OkuMoney.
    /// @param usdAmount Amount of OkuDollar to unwrap (in dollar terms)
    /// @param receiver Address to receive OkuMoney
    /// @return okuMReturned Amount of OkuMoney tokens returned
    function unwrap(
        uint256 usdAmount,
        address receiver
    )
        public
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 okuMReturned)
    {
        return _unwrap(msg.sender, usdAmount, receiver);
    }

    /// @dev Shared core for {unwrap} and the ERC-4626 {withdraw}/{redeem} paths. `owner`
    ///      is the share source (whose balance is burned); `msg.sender` (via
    ///      `_msgSender()`) only populates the `Withdraw` event's `sender` field when
    ///      acting on another owner's behalf via an allowance — see {_redeemShares}.
    ///      Burning directly from `owner` computes the ceil-rounded share burn exactly
    ///      once, against a single balance.
    function _unwrap(
        address owner,
        uint256 usdAmount,
        address receiver
    )
        internal
        returns (uint256 okuMReturned)
    {
        if (usdAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        // Symmetric with `wrap`: both sides of the principal flow are checked. OkuMoney's
        // `_update` enforces its own blacklist on the recipient, but the explicit check
        // here stops a user blacklisted only on OkuDollar from routing OkuM to a third
        // party via `unwrap(amount, victimAddr)`.
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        // SINGLE MULTIPLIER: one external read suffices (usdMultiplier() would re-derive
        // the identical value). The two mulDiv calls below use DIFFERENT rounding on
        // purpose — floor on the OkuM returned, ceil on the shares burned — both favoring
        // the vault; that asymmetry is a rounding-policy choice, not redundancy.
        uint256 mult = $.okuMoney.okuMMultiplier();
        okuMReturned = Math.mulDiv(usdAmount, Constants.PRECISION, mult, Math.Rounding.Floor);

        // Ceil to favor vault on share burn.
        uint256 sharesToBurn = Math.mulDiv(usdAmount, Constants.PRECISION, mult, Math.Rounding.Ceil);
        if ($.usdShares[owner] < sharesToBurn) revert Errors.InsufficientBalance();

        uint256 reserves = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (reserves < okuMReturned) revert InsufficientReserves();

        $.totalUsdShares -= sharesToBurn;
        $.usdShares[owner] -= sharesToBurn;

        IERC20(address($.okuMoney)).safeTransfer(receiver, okuMReturned);

        emit Transfer(owner, address(0), usdAmount);
        emit TransferValue(owner, address(0), sharesToBurn, usdAmount);
        // See `wrap`'s NatSpec on the identical `mult, mult` pattern.
        emit Unwrapped(owner, receiver, usdAmount, okuMReturned, mult, mult);
        emit Withdraw(_msgSender(), receiver, owner, okuMReturned, usdAmount);
    }

    // ============ ERC-4626 Surface ============
    // OkuM = `asset`, UsdOku = `shares`. Deliberately NOT inheriting OZ's
    // ERC4626Upgradeable: its _convertTo* assume a static share balance with a floating
    // ratio, whereas UsdOku shares rebase (balance grows with `m`, price pinned at $1).
    // Conversions use the multiplier directly rather than totalAssets/totalSupply, which
    // is what makes the vault structurally immune to the 4626 inflation attack.

    /// @notice Underlying asset (OkuMoney).
    function asset() public view override(IERC4626, IOkuDollar) returns (address) {
        return address(_getOkuDollarStorage().okuMoney);
    }

    /// @notice Total OkuM managed by the vault.
    function totalAssets() public view returns (uint256) {
        return totalOkuMReserves();
    }

    /// @notice Dollar value of `assets` OkuM at the current multiplier.
    /// @dev Rounds down, per spec (convertTo* MUST always round down).
    function convertToShares(uint256 assets) public view returns (uint256) {
        return MathLib.okuMToDollars(assets, usdMultiplier());
    }

    /// @notice OkuM equivalent of `shares` dollars at the current multiplier.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return MathLib.dollarsToOkuM(shares, usdMultiplier());
    }

    /// @dev Zero while paused or when `receiver` is blacklisted. Such deposits revert on
    ///      `wrap`'s own checks either way; reporting it here makes the condition visible
    ///      to spec-conforming integrators instead of only surfacing as a revert.
    function maxDeposit(address receiver) public view returns (uint256) {
        if (paused() || _getOkuDollarStorage().isBlacklisted[receiver]) return 0;
        return type(uint256).max;
    }

    /// @dev Delegates to {maxDeposit}: both only return `0` or `type(uint256).max`, valid
    ///      blocked/unlimited sentinels in either unit (assets vs. shares), so no
    ///      conversion is needed.
    function maxMint(address receiver) public view returns (uint256) {
        return maxDeposit(receiver);
    }

    /// @dev Spec requires the ASSET (OkuM) equivalent, not the raw share/dollar
    ///      balance — `balanceOf(owner)` is dollars, not OkuM.
    ///
    ///      Zero while paused or when `owner` is blacklisted, mirroring
    ///      {maxDeposit}'s pattern — `withdraw`/`redeem` carry `whenNotPaused` and
    ///      `_unwrap` reverts on a blacklisted `owner`, so without this the view
    ///      claimed a non-zero max for a call that would revert, same spec gap
    ///      {maxDeposit} already closes on the deposit side. (The 4626 signature has
    ///      no `receiver` parameter to also check; `owner`'s own status is what the
    ///      spec means by "cannot be redeemed".)
    ///
    ///      DELIBERATELY NOT MODELLED: `whenYieldNotDistributing`. `withdraw`/`redeem`
    ///      also revert for the remainder of the block in which
    ///      {OkuMoney.setOkuMMultiplier} executes, so strictly this view over-reports
    ///      during that window. Omitted because the condition is transient by one block
    ///      and fires only on the emergency override — returning 0 would make every
    ///      integrator's sizing logic briefly see an empty position, which is a worse
    ///      failure than a call that reverts and can be retried. {maxDeposit} omits it
    ///      on the same grounds, so the two sides stay symmetric.
    function maxWithdraw(address owner) public view returns (uint256) {
        if (paused() || _getOkuDollarStorage().isBlacklisted[owner]) return 0;
        return convertToAssets(balanceOf(owner));
    }

    /// @dev See {maxWithdraw} — same pause/blacklist gating, share units.
    function maxRedeem(address owner) public view returns (uint256) {
        if (paused() || _getOkuDollarStorage().isBlacklisted[owner]) return 0;
        return balanceOf(owner);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    /// @dev Rounds up — assets the caller must supply to receive `shares`.
    function previewMint(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, Constants.PRECISION, usdMultiplier(), Math.Rounding.Ceil);
    }

    /// @dev Rounds up — dollar amount burned to withdraw `assets` of OkuM.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, usdMultiplier(), Constants.PRECISION, Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    /// @notice Deposit `assets` OkuM, minting UsdOku to `receiver`.
    /// @dev Thin alias over {wrap}. The 4626 signature carries no slippage parameter, so
    ///      `minAmountOut` is 0 — EOAs should prefer {wrap}. Deliberately carries NO
    ///      `nonReentrant` / `whenNotPaused` / `whenYieldNotDistributing`: `wrap` already
    ///      enforces all three, and repeating them here would re-enter `wrap`'s own
    ///      `nonReentrant` guard and revert every call. {withdraw}/{redeem} DO carry
    ///      explicit modifiers because they route through the internal `_unwrap`.
    function deposit(uint256 assets, address receiver) external returns (uint256) {
        return wrap(assets, receiver, 0);
    }

    /// @notice Mint `shares` dollars of UsdOku to `receiver`.
    /// @dev See {deposit} — no guards here either, for the same reason.
    function mint(uint256 shares, address receiver) external returns (uint256) {
        uint256 assets = previewMint(shares);
        wrap(assets, receiver, 0);
        return assets;
    }

    /// @notice Withdraw `assets` OkuM to `receiver`, burning `owner`'s UsdOku.
    /// @return shares The number of UsdOku shares burned.
    /// @dev Returns SHARES, not assets — EIP-4626 requires `withdraw` to return the shares
    ///      burned, while its counterpart {redeem} returns the assets delivered.
    ///      `_redeemShares` returns ASSETS (it tail-calls `_unwrap`, whose return is
    ///      `okuMReturned`), so its result is deliberately discarded here.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 shares)
    {
        shares = previewWithdraw(assets);
        _redeemShares(shares, receiver, owner);
        return shares;
    }

    /// @notice Redeem `shares` dollars of UsdOku from `owner` for OkuM to `receiver`.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256)
    {
        return _redeemShares(shares, receiver, owner);
    }

    /// @dev Shared 4626 withdraw/redeem path, guarded by the caller ({withdraw} /
    ///      {redeem}). Spends `owner`'s allowance when acting on their behalf, then burns
    ///      directly from `owner` via {_unwrap}.
    ///
    ///      Checks the CALLER's blacklist status when acting as a third-party spender
    ///      — matching the same `transferFrom` parity rationale above. `_unwrap`
    ///      already blocks a blacklisted `owner`/`receiver`; neither it nor
    ///      `_spendAllowance` has visibility into `_msgSender()` as a distinct third
    ///      party. When `owner == _msgSender()` this is redundant with `_unwrap`'s own
    ///      owner-check (skipped, not an extra SLOAD); it only has teeth in the
    ///      allowance-spending branch, which is exactly where the gap was.
    function _redeemShares(
        uint256 shares,
        address receiver,
        address owner
    )
        internal
        returns (uint256 assets)
    {
        if (owner != _msgSender()) {
            if (_getOkuDollarStorage().isBlacklisted[_msgSender()]) revert SenderBlacklisted();
            _spendAllowance(owner, _msgSender(), shares);
        }
        return _unwrap(owner, shares, receiver);
    }

    // ============ Reserves & Donation Rescue ============

    /// @notice Total OkuMoney tokens held as backing.
    /// @dev Doubles as ERC-4626 `totalAssets()`.
    function totalOkuMReserves() public view returns (uint256) {
        return IERC20(address(_getOkuDollarStorage().okuMoney)).balanceOf(address(this));
    }

    /// @notice Total UsdOku obligations, in dollar terms.
    function totalUsdObligations() public view returns (uint256) {
        return totalSupply();
    }

    /// @notice Rescue OkuM donated directly to the vault.
    /// @param amount Raw OkuM to withdraw.
    /// @param receiver Recipient of the rescued tokens.
    /// @dev Conversions use `m` rather than `totalAssets/totalSupply`, which makes the
    ///      vault structurally immune to the ERC-4626 inflation attack; the corollary is
    ///      that a direct OkuM transfer to this contract accrues to NOBODY and would
    ///      otherwise be locked forever. This is the escape hatch.
    ///
    ///      Cannot touch backing: `totalUsdShares` is the OkuM required to honour every
    ///      outstanding share (shares track raw OkuM 1:1), so anything above it is surplus.
    ///      CAVEAT: that 1:1 identity holds only while `wrap`/`unwrap` are the sole
    ///      mutators — `unwrap` ceils `sharesToBurn` while flooring `okuMReturned`, so each
    ///      unwrap can leave up to 1 wei of reserves ABOVE `totalUsdShares`, classified as
    ///      rescuable donation here. Directionally safe (favours the protocol, and the
    ///      rescuer is trusted) but 1-wei-per-unwrap optimistic.
    function rescueDonation(
        uint256 amount,
        address receiver
    )
        external
        nonReentrant
        onlyRole(Roles.VAULT_RESCUER)
    {
        if (amount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 backing = $.totalUsdShares;
        uint256 held = totalOkuMReserves();
        if (held <= backing) revert NoDonationAvailable();

        uint256 available;
        unchecked {
            available = held - backing;
        }
        if (amount > available) revert NoDonationAvailable();

        IERC20(address($.okuMoney)).safeTransfer(receiver, amount);
        emit DonationRescued(receiver, amount);
    }

    // ============ Blacklist (Works While Paused) ============
    // Reuses the OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role *hashes* so one role name
    // spans both tokens — regulatory enforcement is cross-token by design. AccessControl
    // mappings are per-contract, so the role must still be granted on OkuMoney AND
    // OkuDollar separately (done by initialize() and the deploy/grantRoles scripts).

    /// @notice Add `account` to the OkuDollar blacklist.
    /// @dev Blacklisted accounts cannot send or receive UsdOku (wrap, unwrap, transfer,
    ///      transferFrom). See the section header above on the shared role hash.
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the OkuDollar blacklist.
    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    /// @notice Pause the vault (blocks wrap, unwrap, transfers, and reserve management).
    function pause() external onlyRole(Roles.VAULT_PAUSER) {
        _pause();
    }

    /// @notice Unpause the vault.
    function unpause() external onlyRole(Roles.VAULT_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.VAULT_UPGRADER) {}
}
