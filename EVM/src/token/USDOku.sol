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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {IUSDOku} from "../interfaces/IUSDOku.sol";
import {IUSDOkuWrapper} from "../interfaces/IUSDOkuWrapper.sol";

/**
 * @title USDOku
 * @notice Rebasing $1-denominated wrapper over OkuM (ticker `USDOku`).
 * @dev Continuous smoothed rate (`M_usd` / `usdOkuIndex()`), driven by
 *      `baseIndex` / `ratePerSecond` / `lastAccrualTime` / `rateEnd` — the Aave
 *      liquidity-index / sDAI `chi` pattern. Every `setUsdOkuRate` write requires
 *      a bounded future `rateEnd`; there is no open-ended rate and no pending-rate
 *      staging field (calling `setUsdOkuRate` before the current `rateEnd` simply
 *      extends accrual with no gap and no step).
 *
 *      Does NOT implement ERC-8056: `balanceOf` already returns dollars (it
 *      rebases). An 8056 multiplier on top would double-scale. See
 *      `EVM/README.md § USDOku does not implement ERC-8056`.
 *
 *      No wrap/unwrap/reserves surface — that lives on `USDOkuWrapper`. USDOku
 *      only knows its own share ledger and rebase index; the wrapper is the sole
 *      holder of `OKU_MINTER`/`OKU_BURNER` on this contract.
 *
 *      Storage uses the ERC-7201 namespaced storage pattern:
 *      https://eips.ethereum.org/EIPS/eip-7201
 */
contract USDOku is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IUSDOku
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.UsdOkuIndex
    struct UsdOkuIndexStorage {
        mapping(address => uint256) usdShares;
        uint256 totalUsdShares;
        uint256 baseIndex; // M_usd anchor, snapshotted at last rate write
        uint256 ratePerSecond; // Compound per-second (1e18 = no yield)
        uint256 lastAccrualTime;
        uint256 rateEnd; // Accrual halts here until the next setUsdOkuRate
        bool accrualHalted; // OKU_GUARDIAN latch
        /// @dev Solvency source for {setUsdOkuRate}'s projected-gap check. Wired
        ///      once post-deploy via {setWrapper} — the wrapper does not exist
        ///      yet when USDOku initializes.
        address wrapper;
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.UsdOkuIndex")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant USD_OKU_INDEX_STORAGE_LOCATION =
        0xedd6c63389521e0dee25b474011a8d95929a46909eab75a23368da09adf59400;

    function _getUsdOkuIndexStorage() private pure returns (UsdOkuIndexStorage storage $) {
        assembly {
            $.slot := USD_OKU_INDEX_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Shared errors (ZeroAddress, ZeroAmount, InsufficientBalance,
    // MultiplierCannotDecrease, MultiplierAboveMaximum) live in lib/Errors.sol.
    // `MultiplierCannotDecrease` doubles as USDOku's "IndexCannotDecrease" check —
    // both assert the same monotonic-increase property.
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
    error RateAboveMaximum();
    error RateEndNotInFuture();
    error RateDurationTooLong();
    error AccrualIsHalted();
    error WrapperNotSet();
    /// @notice Projected gap at `rateEnd` would breach `Constants.MAX_SOLVENCY_GAP_BPS`.
    error SolvencyGapExceeded(uint256 projectedGapBps, uint256 maxGapBps);
    /// @dev Defensive guard: the inherited ERC-20 `_update` path must never
    ///      execute — USDOku uses share-based accounting via {mint}/{burn}.
    error UsePrivilegedMintBurn();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the USDOku proxy.
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol (canonical ticker is `USDOku`).
    /// @param _admin Admin address; receives the full role set.
    function initialize(
        string memory name_,
        string memory symbol_,
        address _admin
    )
        public
        initializer
    {
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();

        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        $.baseIndex = Constants.PRECISION;
        $.ratePerSecond = Constants.PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.rateEnd = block.timestamp; // already "expired" — reads PRECISION until first write

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.USD_UPGRADER, _admin);
        _grantRole(Roles.USD_PAUSER, _admin);
        _grantRole(Roles.USD_UNPAUSER, _admin);
        _grantRole(Roles.OKU_RATE_SETTER, _admin);
        _grantRole(Roles.OKU_GUARDIAN, _admin);
        _grantRole(Roles.OKU_ACCRUAL_RESUMER, _admin);
        // Shared with OkuM — a single grant covers both tokens' blacklist.
        _grantRole(Roles.OKU_BLACKLISTER, _admin);
        _grantRole(Roles.OKU_UNBLACKLISTER, _admin);
        // Shared with OkuM — granted to admin at init; production wiring grants
        // this to the USDOkuWrapper proxy post-deploy.
        _grantRole(Roles.OKU_MINTER, _admin);
        _grantRole(Roles.OKU_BURNER, _admin);
    }

    // ============ Wiring ============

    /// @notice Wire the solvency source for {setUsdOkuRate}'s projected-gap check.
    /// @dev Cold, one-time post-deploy wiring — the wrapper does not exist yet at
    ///      `initialize` time (deploy order: OkuM, SubscriptionModule, USDOku,
    ///      USDOkuWrapper). `setUsdOkuRate` fails closed (`WrapperNotSet`) until
    ///      this is called.
    function setWrapper(address newWrapper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWrapper == address(0)) revert Errors.ZeroAddress();
        _getUsdOkuIndexStorage().wrapper = newWrapper;
        emit WrapperSet(newWrapper);
    }

    function wrapper() external view returns (address) {
        return _getUsdOkuIndexStorage().wrapper;
    }

    // ============ Events ============

    event UsdOkuRateSet(
        uint256 oldRatePerSecond, uint256 newRatePerSecond, uint256 rateEnd, uint256 snapshotIndex
    );
    event AccrualHalted(uint256 atIndex);
    event AccrualResumed(uint256 atIndex);
    event WrapperSet(address indexed wrapper);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    /// @dev Shares-denominated, distinct from the dollar-denominated `Transfer` event.
    event SharesTransferred(
        address indexed from, address indexed to, uint256 shares, uint256 dollarValue
    );

    // ============ Storage Accessor Views ============

    function usdBaseIndex() external view returns (uint256) {
        return _getUsdOkuIndexStorage().baseIndex;
    }

    function usdRatePerSecond() external view returns (uint256) {
        return _getUsdOkuIndexStorage().ratePerSecond;
    }

    function usdLastAccrualTime() external view returns (uint256) {
        return _getUsdOkuIndexStorage().lastAccrualTime;
    }

    function usdRateEnd() external view returns (uint256) {
        return _getUsdOkuIndexStorage().rateEnd;
    }

    function accrualHalted() external view returns (bool) {
        return _getUsdOkuIndexStorage().accrualHalted;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _getUsdOkuIndexStorage().isBlacklisted[account];
    }

    // ============ IUSDOku ============

    /// @inheritdoc IUSDOku
    function sharesOf(address account) external view returns (uint256) {
        return _getUsdOkuIndexStorage().usdShares[account];
    }

    /// @inheritdoc IUSDOku
    function totalShares() external view returns (uint256) {
        return _getUsdOkuIndexStorage().totalUsdShares;
    }

    /// @inheritdoc IUSDOku
    /// @dev Continuous accrual. Frozen at the value it reached at `rateEnd` once
    ///      `block.timestamp > rateEnd`, until the next {setUsdOkuRate} call —
    ///      there is no pending-rate continuation.
    function usdOkuIndex() public view returns (uint256) {
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        uint256 t = block.timestamp > $.rateEnd ? $.rateEnd : block.timestamp;
        uint256 elapsed = t - $.lastAccrualTime;
        return _compoundFor($.baseIndex, $.ratePerSecond, elapsed);
    }

    /// @notice The index this segment will have reached at `rateEnd`.
    /// @dev Exposed so `USDOkuWrapper.wrap` can check that newly minted shares
    ///      are also pre-funded for the remainder of the live segment. The
    ///      `setUsdOkuRate` projection only covers shares outstanding AT WRITE
    ///      TIME; without this, a mid-segment wrap would add shares that accrue
    ///      with no backing behind them and quietly break the solvency invariant.
    ///      Returns the live index once the segment has expired.
    function projectedIndexAtRateEnd() public view returns (uint256) {
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if (block.timestamp >= $.rateEnd) return usdOkuIndex();
        return _compoundFor($.baseIndex, $.ratePerSecond, $.rateEnd - $.lastAccrualTime);
    }

    /// @dev Compound `base` by `rate^elapsed`. Identity when `elapsed == 0`. Caps
    ///      at `Constants.MAX_MULTIPLIER` as a view-level backstop — the setter's
    ///      own projection check is what actually prevents reaching it.
    function _compoundFor(
        uint256 base,
        uint256 rate,
        uint256 elapsed
    )
        internal
        pure
        returns (uint256)
    {
        if (elapsed == 0) return base;
        uint256 result = Math.mulDiv(
            base,
            MathLib.rpow(rate, elapsed, Constants.PRECISION),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
        return result > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : result;
    }

    // ============ ERC20 Overrides (share-based) ============

    function totalSupply() public view override(ERC20Upgradeable, IERC20) returns (uint256) {
        return Math.mulDiv(
            _getUsdOkuIndexStorage().totalUsdShares,
            usdOkuIndex(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IERC20)
        returns (uint256)
    {
        return Math.mulDiv(
            _getUsdOkuIndexStorage().usdShares[account],
            usdOkuIndex(),
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
        uint256 index = usdOkuIndex();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, index, Math.Rounding.Floor);
        _transferUsdShares(msg.sender, to, shares);
        uint256 effective = Math.mulDiv(shares, index, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(msg.sender, to, effective);
        return true;
    }

    /// @dev Allowance is debited by the caller-supplied `amount`, while the actual
    ///      moved value floors to `effective`. See `EVM/README.md` on max-send.
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
        uint256 index = usdOkuIndex();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, index, Math.Rounding.Floor);
        _transferUsdShares(from, to, shares);
        uint256 effective = Math.mulDiv(shares, index, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(from, to, effective);
        return true;
    }

    function _transferUsdShares(address from, address to, uint256 shares) internal {
        if (from == address(0)) revert Errors.ZeroAddress();
        if (to == address(0)) revert Errors.ZeroAddress();

        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        uint256 fromBalance = $.usdShares[from];
        if (fromBalance < shares) revert Errors.InsufficientBalance();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        uint256 dollarValue =
            Math.mulDiv(shares, usdOkuIndex(), Constants.PRECISION, Math.Rounding.Floor);
        emit SharesTransferred(from, to, shares, dollarValue);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

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
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ Inherited ERC20 guard ============

    /// @dev All supply changes go through {mint}/{burn}, which manage `usdShares`
    ///      directly. The inherited `_update` hook must never execute.
    function _update(address, address, uint256) internal pure override {
        revert UsePrivilegedMintBurn();
    }

    // ============ Privileged Mint / Burn (USDOkuWrapper only) ============

    /// @inheritdoc IUSDOku
    /// @dev Denominated in shares, not dollars — see {IUSDOku}. `to` is the
    ///      end-user receiving USDOku from a wrap; the wrapper computes `shares`
    ///      from the dollar amount it intends to credit via {usdOkuIndex}.
    function mint(address to, uint256 shares) external onlyRole(Roles.OKU_MINTER) whenNotPaused {
        if (to == address(0)) revert Errors.ZeroAddress();
        if (shares == 0) revert Errors.ZeroAmount();
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if ($.isBlacklisted[to]) revert RecipientBlacklisted();

        $.totalUsdShares += shares;
        $.usdShares[to] += shares;

        uint256 dollarValue =
            Math.mulDiv(shares, usdOkuIndex(), Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(address(0), to, dollarValue);
    }

    /// @inheritdoc IUSDOku
    /// @dev `from` is debited directly without a prior transfer step — the
    ///      wrapper is trusted to only burn what it is unwrapping on the user's
    ///      behalf. Not pause-gated, mirroring `OkuM.burn`.
    function burn(address from, uint256 shares) external onlyRole(Roles.OKU_BURNER) {
        if (shares == 0) revert Errors.ZeroAmount();
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if ($.isBlacklisted[from]) revert SenderBlacklisted();
        if ($.usdShares[from] < shares) revert Errors.InsufficientBalance();

        uint256 dollarValue =
            Math.mulDiv(shares, usdOkuIndex(), Constants.PRECISION, Math.Rounding.Floor);
        $.totalUsdShares -= shares;
        $.usdShares[from] -= shares;

        emit Transfer(from, address(0), dollarValue);
    }

    // ============ Rate Management (OKU_RATE_SETTER) ============

    /// @notice Set the USDOku accrual rate.
    /// @param newRate Per-second compounding rate (1e18 = no yield). Must be
    ///        `>= PRECISION` and its nominal annualization `<= MAX_IMPLIED_APR_BPS`.
    /// @param endTimestamp Must be strictly in the future and no more than
    ///        `Constants.MAX_RATE_DURATION` away. Accrual freezes at this value
    ///        until the next call.
    /// @dev **THE FORWARD RATE MUST BE PRE-FUNDED.** Because
    ///      `Constants.MAX_SOLVENCY_GAP_BPS == 0`, this reverts
    ///      `SolvencyGapExceeded` unless the liability projected to `endTimestamp`
    ///      is ALREADY covered by OkuM held in the wrapper. The operational
    ///      sequence is therefore: transfer the forward yield into
    ///      `USDOkuWrapper` first, then declare the rate that pays it out.
    ///      Declaring a rate you have not funded is not possible.
    ///
    ///      This is what makes `backing >= liability` a maintained invariant, and
    ///      hence what makes `USDOkuWrapper.unwrap` unable to revert for want of
    ///      reserves. See `Constants.MAX_SOLVENCY_GAP_BPS`.
    ///
    ///      Calling before the current `rateEnd` re-anchors `baseIndex` at the
    ///      live index with no gap and no step.
    ///
    ///      ESCAPE HATCH: the solvency check is skipped entirely when
    ///      `newRate == PRECISION`. That case is a full stop — `rpow` at
    ///      `PRECISION` is the identity, so the projected index equals the live
    ///      index and the projected liability equals the current liability. It is
    ///      provably non-worsening and MUST always be available: when funding
    ///      lapses, switching accrual off is the correct response and it cannot
    ///      itself be blocked by a funding shortfall. It also means a stop works
    ///      before {setWrapper} has been wired, since `WrapperNotSet` lives inside
    ///      the skipped check.
    ///
    ///      Under a zero bound a shortfall should be unreachable in normal
    ///      operation — it would require a fall in `M_oku` (forbidden by
    ///      monotonicity) or a defect in `withdrawSurplus`. The hatch is retained
    ///      as a safety property, not as a routine remedy.
    function setUsdOkuRate(
        uint256 newRate,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.OKU_RATE_SETTER)
    {
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if ($.accrualHalted) revert AccrualIsHalted();
        if (newRate < Constants.PRECISION) revert Errors.MultiplierCannotDecrease();
        if (MathLib.impliedAprBps(newRate) > Constants.MAX_IMPLIED_APR_BPS) {
            revert RateAboveMaximum();
        }
        if (endTimestamp <= block.timestamp) revert RateEndNotInFuture();
        if (endTimestamp - block.timestamp > Constants.MAX_RATE_DURATION) {
            revert RateDurationTooLong();
        }

        uint256 liveIndex = usdOkuIndex();
        uint256 projectedIndex = _compoundFor(liveIndex, newRate, endTimestamp - block.timestamp);
        if (projectedIndex > Constants.MAX_MULTIPLIER) revert Errors.MultiplierAboveMaximum();

        // Full stop is always permitted — see the escape-hatch note above.
        if (newRate > Constants.PRECISION) {
            _checkSolvency(
                Math.mulDiv(
                    $.totalUsdShares, projectedIndex, Constants.PRECISION, Math.Rounding.Floor
                )
            );
        }

        uint256 oldRate = $.ratePerSecond;
        $.baseIndex = liveIndex;
        $.lastAccrualTime = block.timestamp;
        $.ratePerSecond = newRate;
        $.rateEnd = endTimestamp;

        emit UsdOkuRateSet(oldRate, newRate, endTimestamp, liveIndex);
    }

    /// @dev The one live call site for `Constants.MAX_SOLVENCY_GAP_BPS`, which is
    ///      zero — so this requires `projectedLiability <= backing` outright.
    ///      `USDOkuWrapper.wrap` cannot increase the gap (it moves liability and
    ///      backing by the identical dollar amount, and floors the share credit),
    ///      so gating `wrap` on this bound would be dead code. See
    ///      `EVM/README.md § Solvency`.
    function _checkSolvency(uint256 projectedLiability) internal view {
        address w = _getUsdOkuIndexStorage().wrapper;
        if (w == address(0)) revert WrapperNotSet();
        uint256 backing = IUSDOkuWrapper(w).realizedBacking();
        if (projectedLiability <= backing) return;
        if (backing == 0) {
            revert SolvencyGapExceeded(type(uint256).max, Constants.MAX_SOLVENCY_GAP_BPS);
        }
        uint256 gapBps = Math.mulDiv(
            projectedLiability - backing, Constants.BASIS_POINTS, backing, Math.Rounding.Ceil
        );
        if (gapBps > Constants.MAX_SOLVENCY_GAP_BPS) {
            revert SolvencyGapExceeded(gapBps, Constants.MAX_SOLVENCY_GAP_BPS);
        }
    }

    /// @notice Freeze accrual (`M_usd` stops moving). Warm.
    function haltUsdOkuAccrual() external onlyRole(Roles.OKU_GUARDIAN) {
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        uint256 index = usdOkuIndex();
        $.baseIndex = index;
        $.ratePerSecond = Constants.PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.rateEnd = block.timestamp;
        $.accrualHalted = true;
        emit AccrualHalted(index);
    }

    /// @notice Reverse a halt. Cold-only — see `OkuM.resumeAccrual` for the same
    ///         warm-stop/cold-restart rationale.
    function resumeUsdOkuAccrual() external onlyRole(Roles.OKU_ACCRUAL_RESUMER) {
        _getUsdOkuIndexStorage().accrualHalted = false;
        emit AccrualResumed(usdOkuIndex());
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(Roles.OKU_BLACKLISTER) {
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(Roles.OKU_UNBLACKLISTER) {
        UsdOkuIndexStorage storage $ = _getUsdOkuIndexStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(Roles.USD_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.USD_UNPAUSER) {
        _unpause();
    }

    // ============ ERC-165 ============
    // No override needed: USDOku does not inherit ScaledUIAmountUpgradeable, so
    // `supportsInterface(0xa60bf13d)` already falls through to
    // AccessControlUpgradeable's default and returns false. Asserted in the
    // invariant suite so a future refactor cannot quietly add ERC-8056 here.

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.USD_UPGRADER) {}
}
