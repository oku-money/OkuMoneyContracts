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
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
 * @notice Rebasing $1-pegged stablecoin (ticker `UsdOku`) backed by OkuMoney reserves
 * @dev NOT an ERC-4626 vault. Custom rebasing token with its own shares/multiplier.
 *      Holds OkuMoney as reserves. Independent yield rate enables revenue extraction
 *      (OkuM rate > USD rate) or forward-facing yield (USD rate > OkuM rate).
 *
 *      Wrap/unwrap are multiplier-aware: they use okuMMultiplier() and usdMultiplier() to convert
 *      between OkuMoney token amounts and OkuDollar amounts at their respective dollar values.
 *
 *      See Constants.sol for terminology legend.
 *      See {OkuMoney.initialize} for the unified role-grant policy.
 *
 *      Storage uses the ERC-7201 namespaced storage pattern for upgrade safety.
 *      See https://eips.ethereum.org/EIPS/eip-7201
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
    IOkuDollar
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuDollar
    struct OkuDollarStorage {
        IOkuMoney okuMoney;
        // USD rebasing mechanism (mirrors OkuMoney pattern)
        mapping(address => uint256) usdShares;
        uint256 totalUsdShares;
        uint256 usdBaseMultiplier;
        uint256 usdRatePerSecond;
        uint256 usdLastAccrualTime;
        uint256 usdRateEnd;
        uint256 usdPendingRatePerSecond;
        // Collateralization
        uint256 minCollateralRatio;
        // Blacklist — uses shared OKUM_BLACKLISTER / OKUM_UNBLACKLISTER roles so a single
        // role grant covers both OkuMoney and OkuDollar. This mirrors regulatory requirements:
        // a blacklisted address should not be able to hold or transfer UsdOku either.
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
    error RatioExceedsMax();
    error RatioBelowFloor();
    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientReserves();
    error BelowMinimumCollateral();
    error InvalidRate();
    error RateTooHigh();
    error EndTimestampInPast();
    error RateAlreadyExpired();
    error NoRateEndSet();
    /// @notice Defensive guard: direct `_mint` is forbidden; use `wrap()` instead.
    error UseWrapInstead();
    /// @notice Defensive guard: direct `_burn` is forbidden; use `unwrap()` instead.
    error UseUnwrapInstead();
    /// @notice Defensive guard: OkuDollar uses share-based accounting; the inherited
    ///         ERC-20 `_update` path must never execute for any transfer type.
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
    /// @param _minCollateralRatio Initial minimum collateral ratio enforced by `withdrawSurplus`
    ///        (1e18 = 100%). Must be within [MIN_COLLATERAL_RATIO_FLOOR, PRECISION].
    function initialize(
        address _okuMoney,
        string memory name_,
        string memory symbol_,
        address _admin,
        uint256 _minCollateralRatio
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (_minCollateralRatio > Constants.PRECISION) revert RatioExceedsMax();
        if (_minCollateralRatio < Constants.MIN_COLLATERAL_RATIO_FLOOR) revert RatioBelowFloor();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.minCollateralRatio = _minCollateralRatio;
        $.usdBaseMultiplier = Constants.PRECISION;
        $.usdRatePerSecond = Constants.PRECISION;
        $.usdLastAccrualTime = block.timestamp;
        $.usdPendingRatePerSecond = Constants.PRECISION;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.VAULT_UPGRADER, _admin);
        _grantRole(Roles.VAULT_REBASER, _admin);
        _grantRole(Roles.VAULT_RESERVE_MANAGER, _admin);
        _grantRole(Roles.VAULT_PAUSER, _admin);
        _grantRole(Roles.VAULT_UNPAUSER, _admin);
        _grantRole(Roles.VAULT_ADMIN, _admin);
        // Shared blacklist roles: a single grant covers both OkuMoney and OkuDollar.
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() external view returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    /// @notice Active per-second accrual rate for the USD multiplier (1e18 = no yield).
    function usdRatePerSecond() external view returns (uint256) {
        return _getOkuDollarStorage().usdRatePerSecond;
    }

    /// @notice Timestamp when the base multiplier was last snapshotted.
    function usdLastAccrualTime() external view returns (uint256) {
        return _getOkuDollarStorage().usdLastAccrualTime;
    }

    /// @notice Timestamp at which the active rate expires (0 = open-ended).
    function usdRateEnd() external view returns (uint256) {
        return _getOkuDollarStorage().usdRateEnd;
    }

    /// @notice Pending per-second rate that activates after `usdRateEnd` (1e18 = no yield).
    function usdPendingRatePerSecond() external view returns (uint256) {
        return _getOkuDollarStorage().usdPendingRatePerSecond;
    }

    /// @notice Minimum collateral ratio enforced by `withdrawSurplus` (1e18 = 100%).
    function minCollateralRatio() external view returns (uint256) {
        return _getOkuDollarStorage().minCollateralRatio;
    }

    /// @notice Total internal share tokens across all holders.
    function totalUsdShares() external view returns (uint256) {
        return _getOkuDollarStorage().totalUsdShares;
    }

    /// @notice Internal share balance for `account`.
    function usdSharesOf(address account) external view returns (uint256) {
        return _getOkuDollarStorage().usdShares[account];
    }

    /// @notice Snapshotted base multiplier before continuous accrual is applied.
    function usdBaseMultiplier() external view returns (uint256) {
        return _getOkuDollarStorage().usdBaseMultiplier;
    }

    /// @notice Whether `account` is on the OkuDollar blacklist.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuDollarStorage().isBlacklisted[account];
    }

    // ============ USD Multiplier (Continuous Accrual) ============

    /// @notice Computed USD multiplier with continuous yield accrual.
    /// @dev Uses {MathLib.rpow} for exponential accrual. Branches:
    ///      1. Active rate at `PRECISION` (no yield): returns base, optionally compounded
    ///         by a pending rate after `usdRateEnd` has elapsed.
    ///      2. Active rate above `PRECISION`: compounds base by the active rate up to
    ///         `usdRateEnd` (or `now`), then by the pending rate for any time past.
    function usdMultiplier() public view returns (uint256) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 rate = $.usdRatePerSecond;
        uint256 base = $.usdBaseMultiplier;
        uint256 rateEnd = $.usdRateEnd;
        uint256 pendingRate = $.usdPendingRatePerSecond;

        // Branch 1: active rate is the no-yield placeholder.
        if (rate <= Constants.PRECISION) {
            if (rateEnd != 0 && block.timestamp > rateEnd && pendingRate > Constants.PRECISION) {
                return _compoundFor(base, pendingRate, block.timestamp - rateEnd);
            }
            return base;
        }

        // Branch 2: active rate is yielding.
        if (rateEnd != 0 && block.timestamp > rateEnd) {
            uint256 elapsedCurrent = rateEnd - $.usdLastAccrualTime;
            base = _compoundFor(base, rate, elapsedCurrent);
            if (pendingRate > Constants.PRECISION) {
                base = _compoundFor(base, pendingRate, block.timestamp - rateEnd);
            }
            return base;
        }

        return _compoundFor(base, rate, block.timestamp - $.usdLastAccrualTime);
    }

    /// @dev Compound `base` by `rate^elapsed`. Identity when `elapsed == 0`.
    ///      Caps the result at `Constants.MAX_MULTIPLIER` for symmetry with
    ///      `OkuMoney.setOkuMMultiplier`. A long-running rate at `MAX_RATE`
    ///      would otherwise push `usdMultiplier` beyond the overflow-safe region.
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

    // ============ ERC20 Overrides (USD Share-based) ============

    function totalSupply() public view override(ERC20Upgradeable, IOkuDollar) returns (uint256) {
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
        override(ERC20Upgradeable, IOkuDollar)
        returns (uint256)
    {
        return Math.mulDiv(
            _getOkuDollarStorage().usdShares[account],
            usdMultiplier(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        uint256 multiplier = usdMultiplier();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
        _transferUsdShares(msg.sender, to, shares);
        // Emit `Transfer` with the effective post-rounding dollar amount
        // (`shares * multiplier / 1e18`) rather than the caller-specified
        // `amount`, keeping the ERC-20 invariant `sum(Transfer.value) ==
        // Δ balanceOf` intact for indexers/accounting.
        uint256 effective =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(msg.sender, to, effective);
        return true;
    }

    /// @dev Allowance is debited by the caller-supplied `amount`, while the
    ///      actual moved value is `effective = floor(shares * multiplier / 1e18)`.
    ///      Because share derivation floors, `effective <= amount` always, and
    ///      the gap (at most 1 wei per call) is consumed from the allowance
    ///      rather than the holder's balance. This is in the protocol's favor
    ///      and mirrors the same flooring direction documented on `wrap` /
    ///      `unwrap`. Indexers should reconstruct the moved value from the
    ///      `Transfer` event payload, not from the allowance delta.
    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        uint256 multiplier = usdMultiplier();
        uint256 shares = Math.mulDiv(amount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
        _transferUsdShares(from, to, shares);
        // See `transfer` above.
        uint256 effective =
            Math.mulDiv(shares, multiplier, Constants.PRECISION, Math.Rounding.Floor);
        emit Transfer(from, to, effective);
        return true;
    }

    /// @dev Public ERC-20 `Transfer` event is emitted by the calling function with the
    ///      original token amount. This helper only tracks share movement + dollar value.
    function _transferUsdShares(address from, address to, uint256 shares) internal {
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
            Math.mulDiv(shares, usdMultiplier(), Constants.PRECISION, Math.Rounding.Floor);
        emit TransferValue(from, to, shares, dollarValue);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @notice EIP-2612 permit with blacklist enforcement.
    /// @dev ALLOWANCE SEMANTICS NOTE: `value` is denominated in dollar terms (same units
    ///      as `balanceOf` and `transferFrom`). Internally OkuDollar stores balances as
    ///      shares; `transferFrom(amount)` floors the share conversion while `unwrap(amount)`
    ///      ceils it. When `usdMultiplier > 1e18`, multiple sequential `transferFrom` calls
    ///      against a single permit-approved allowance may under-consume shares by ~1 share
    ///      per call due to this floor truncation. Integrators that plan batched `transferFrom`
    ///      against a permit allowance should account for this 1-wei per-call dust.
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

    // ============ Inherited ERC20 guard ============

    /// @dev OkuDollar overrides `transfer`/`transferFrom` to use share-based accounting.
    ///      The inherited ERC-20 `_update` hook must never execute — all supply changes
    ///      go through `wrap()`/`unwrap()` which manage `usdShares` directly, and
    ///      peer-to-peer transfers are handled by the overridden `transfer`/`transferFrom`.
    ///
    ///      Unconditional revert (with diagnostic sub-errors for mint/burn) ensures that
    ///      no future code change can accidentally write to the inherited `_balances`
    ///      mapping, which `balanceOf()` never reads.  This matches the hard-revert
    ///      pattern used by stETH and Aave aToken.
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
    /// @dev usdMinted = okuMAmount * okuMMultiplier / usdMultiplier.
    ///      100 OkuM at okuMMultiplier=$1.05, usdMultiplier=1.0 -> 105 UsdOku.
    /// @param okuMAmount Amount of OkuMoney tokens to wrap
    /// @param receiver Address to receive OkuDollar
    /// @param minAmountOut Minimum OkuDollar to receive (slippage protection)
    /// @return usdMinted Amount of OkuDollar minted
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        external
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

        // shares = actualReceived * okuMMultiplier / usdMultiplier
        // usdMinted = shares * usdMultiplier / PRECISION
        // Both steps are sourced from MathLib so LitePSM.mintUsdOku can replicate
        // wrap's exact rounding when computing its slippage floor.
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 usdMult = usdMultiplier();
        uint256 sharesToMint = MathLib.wrappedSharesFromOkuM(actualReceived, okuMMult, usdMult);
        if (sharesToMint == 0) revert AmountTooSmall();

        usdMinted = MathLib.okuMToWrappedUsd(actualReceived, okuMMult, usdMult);
        if (usdMinted < minAmountOut) revert OutputBelowMinimum(usdMinted, minAmountOut);

        $.totalUsdShares += sharesToMint;
        $.usdShares[receiver] += sharesToMint;

        emit Transfer(address(0), receiver, usdMinted);
        emit TransferValue(address(0), receiver, sharesToMint, usdMinted);
        emit Wrapped(msg.sender, receiver, actualReceived, usdMinted, okuMMult, usdMult);
    }

    /// @notice Unwrap OkuDollar back to OkuMoney.
    /// @dev okuMReturned = usdAmount * PRECISION / okuMMultiplier.
    ///      105 UsdOku at okuMMultiplier=$1.05 -> 100 OkuM (regardless of usdMultiplier).
    ///      usdMultiplier converts shares <-> dollars; okuMMultiplier converts dollars <-> OkuMoney.
    ///      Reverts if vault holds insufficient OkuMoney.
    /// @param usdAmount Amount of OkuDollar to unwrap (in dollar terms)
    /// @param receiver Address to receive OkuMoney
    /// @return okuMReturned Amount of OkuMoney tokens returned
    function unwrap(
        uint256 usdAmount,
        address receiver
    )
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        returns (uint256 okuMReturned)
    {
        if (usdAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        // Symmetric with `wrap`: both sides of the principal flow are
        // checked. The receiver gets OkuMoney back, and OkuMoney's `_update`
        // hook independently enforces its own blacklist on the recipient.
        // We add the explicit check here so a user blacklisted only on
        // OkuDollar (but not OkuMoney) cannot route OkuM to a third party
        // via `unwrap(amount, victimAddr)`.
        if ($.isBlacklisted[receiver]) revert RecipientBlacklisted();

        uint256 usdMult = usdMultiplier();
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        okuMReturned = Math.mulDiv(usdAmount, Constants.PRECISION, okuMMult, Math.Rounding.Floor);

        // Ceil to favor vault on share burn.
        uint256 sharesToBurn =
            Math.mulDiv(usdAmount, Constants.PRECISION, usdMult, Math.Rounding.Ceil);
        if ($.usdShares[msg.sender] < sharesToBurn) revert Errors.InsufficientBalance();

        uint256 reserves = IERC20(address($.okuMoney)).balanceOf(address(this));
        if (reserves < okuMReturned) revert InsufficientReserves();

        $.totalUsdShares -= sharesToBurn;
        $.usdShares[msg.sender] -= sharesToBurn;

        IERC20(address($.okuMoney)).safeTransfer(receiver, okuMReturned);

        emit Transfer(msg.sender, address(0), usdAmount);
        emit TransferValue(msg.sender, address(0), sharesToBurn, usdAmount);
        emit Unwrapped(msg.sender, receiver, usdAmount, okuMReturned, okuMMult, usdMult);
    }

    // ============ Reserve Management ============

    /// @notice Convert an OkuMoney token amount to its dollar value at the current multiplier.
    function _okuMToDollarValue(uint256 okuMAmount) internal view returns (uint256) {
        return MathLib.okuMToDollars(okuMAmount, _getOkuDollarStorage().okuMoney.okuMMultiplier());
    }

    /// @notice Deposit OkuMoney without minting OkuDollar shares (top up reserves).
    /// @param okuMAmount Amount of OkuMoney tokens to deposit.
    /// @dev Used when USD rate > OkuM rate (vault undercollateralized). OkuMoney is
    ///      non-rebasing — token value depends on okuMMultiplier().
    ///
    ///      No `whenYieldNotDistributing` guard needed: deposits only increase
    ///      reserves, no downstream value depends on the multiplier read here
    ///      (the multiplier appears only in the informational event field), and
    ///      `withdrawSurplus` carries the cross-side guard that protects the
    ///      collateralization invariant.
    ///
    ///      No `nonReentrant` guard: the only external call is `safeTransferFrom`
    ///      on OkuMoney, which is a controlled, standard ERC-20 with no transfer
    ///      hooks. A reentrant callback is not possible today. If OkuMoney is ever
    ///      upgraded to introduce hooks, the risk is limited to inflating the
    ///      `ReservesDeposited` event (reserves only increase, so the accounting
    ///      invariant cannot be broken by a reentrant deposit).
    function depositReserves(uint256 okuMAmount)
        external
        whenNotPaused
        onlyRole(Roles.VAULT_RESERVE_MANAGER)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 balBefore = IERC20(address($.okuMoney)).balanceOf(address(this));
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = IERC20(address($.okuMoney)).balanceOf(address(this)) - balBefore;
        emit ReservesDeposited(
            msg.sender, actualReceived, _okuMToDollarValue(actualReceived), collateralizationRatio()
        );
    }

    /// @notice Withdraw surplus OkuMoney without burning OkuDollar shares.
    /// @param okuMAmount Amount of OkuMoney tokens to withdraw.
    /// @dev Enforces `collateralizationRatio() >= minCollateralRatio` BEFORE the
    ///      token transfer (correct CEI ordering). `nonReentrant` is applied as
    ///      defense-in-depth — OkuMoney today is a standard ERC-20 with no
    ///      transfer callbacks, but if a future upgrade ever introduces hooks
    ///      (ERC-777 / ERC-4337 callouts) a reentrant call back into
    ///      `wrap`/`unwrap` between the transfer and a post-check would
    ///      observe a temporarily-inflated reserve balance.
    ///      `whenYieldNotDistributing` mirrors the guard on `wrap`/`unwrap` —
    ///      a yield distribution in the same block changes `okuMMultiplier`, which
    ///      is read inside `collateralizationRatio()` and `withdrawSurplus`'s own
    ///      post-withdrawal ratio check. Without this guard a privileged operator
    ///      could sandwich a yield distribution and a withdrawal in the same block.
    ///      This guard only prevents the intra-block case; see
    ///      `EVM/README.md § Accepted Risks (2)` for the cross-block trust
    ///      assumption on `VAULT_REBASER` + `VAULT_RESERVE_MANAGER`.
    function withdrawSurplus(uint256 okuMAmount)
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
        onlyRole(Roles.VAULT_RESERVE_MANAGER)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();

        OkuDollarStorage storage $ = _getOkuDollarStorage();

        // Compute the post-withdrawal collateralization ratio against the
        // reserve balance the vault WILL HAVE after `safeTransfer` completes,
        // and revert before moving any tokens if that ratio breaches the floor.
        uint256 currentReserves = totalOkuMReserves();
        if (currentReserves < okuMAmount) revert InsufficientReserves();
        uint256 postReserves;
        unchecked {
            // Safe: just bounds-checked above.
            postReserves = currentReserves - okuMAmount;
        }

        uint256 obligations = totalUsdObligations();
        uint256 postRatio;
        if (obligations == 0) {
            postRatio = type(uint256).max;
        } else {
            uint256 postReservesDollarValue =
                MathLib.okuMToDollars(postReserves, $.okuMoney.okuMMultiplier());
            postRatio = Math.mulDiv(
                postReservesDollarValue, Constants.PRECISION, obligations, Math.Rounding.Floor
            );
        }
        if (postRatio < $.minCollateralRatio) revert BelowMinimumCollateral();

        IERC20(address($.okuMoney)).safeTransfer(msg.sender, okuMAmount);

        emit SurplusWithdrawn(msg.sender, okuMAmount, _okuMToDollarValue(okuMAmount), postRatio);
    }

    // ============ Admin ============

    /// @notice Update the minimum collateral ratio enforced by `withdrawSurplus`.
    /// @param newRatio New ratio (1e18 = 100%). Must be within
    ///        [MIN_COLLATERAL_RATIO_FLOOR, PRECISION] and <= current live ratio.
    /// @dev Gated on `VAULT_ADMIN` rather than `DEFAULT_ADMIN_ROLE` so the
    ///      vault-config key can be rotated independently of the AccessControl
    ///      meta-role holder. Mirrors the granular-role posture used by every
    ///      other admin function on this contract.
    ///
    ///      Live-health gate: any new floor that the vault doesn't already meet
    ///      is rejected. Without this check, raising the floor above the live
    ///      ratio would silently brick `withdrawSurplus` (and any future
    ///      collateralization-checked operation) until the reserve manager
    ///      deposited additional OkuMoney. Operational expectation: call
    ///      `depositReserves` first to lift the live ratio above the new bar,
    ///      then call this in the same operational batch.
    function setMinCollateralRatio(uint256 newRatio) external onlyRole(Roles.VAULT_ADMIN) {
        if (newRatio > Constants.PRECISION) revert RatioExceedsMax();
        if (newRatio < Constants.MIN_COLLATERAL_RATIO_FLOOR) revert RatioBelowFloor();
        if (collateralizationRatio() < newRatio) revert BelowMinimumCollateral();
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 oldRatio = $.minCollateralRatio;
        $.minCollateralRatio = newRatio;
        emit MinCollateralRatioUpdated(oldRatio, newRatio);
    }

    // ============ Collateralization Views (Price-Aware) ============

    /// @notice Total OkuMoney tokens held as reserves
    function totalOkuMReserves() public view returns (uint256) {
        return IERC20(address(_getOkuDollarStorage().okuMoney)).balanceOf(address(this));
    }

    /// @notice Total OkuDollar obligations (in dollar terms)
    function totalUsdObligations() public view returns (uint256) {
        return totalSupply();
    }

    /// @notice Multiplier-aware collateralization ratio.
    /// @dev (reservesDollarValue * PRECISION) / totalSupply, where reservesDollarValue
    ///      converts the OkuM token reserves to dollars via okuMMultiplier().
    function collateralizationRatio() public view returns (uint256) {
        uint256 obligations = totalUsdObligations();
        if (obligations == 0) return type(uint256).max;
        return Math.mulDiv(
            _okuMToDollarValue(totalOkuMReserves()),
            Constants.PRECISION,
            obligations,
            Math.Rounding.Floor
        );
    }

    /// @notice Extractable surplus as OkuMoney tokens (0 if undercollateralized).
    /// @return Amount of OkuMoney tokens withdrawable without breaching the floor.
    function surplus() external view returns (uint256) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 reservesDollarValue =
            Math.mulDiv(totalOkuMReserves(), okuMMult, Constants.PRECISION, Math.Rounding.Floor);
        uint256 obligations = totalUsdObligations();
        if (reservesDollarValue <= obligations) return 0;
        return MathLib.dollarsToOkuM(reservesDollarValue - obligations, okuMMult);
    }

    // ============ Rate Management (VAULT_REBASER) ============

    /// @notice Set the USD multiplier accrual rate.
    /// @param newRate Per-second rate (1e18 = no yield). Must be in [PRECISION, MAX_RATE].
    /// @param endTimestamp Unix timestamp at which the rate expires (0 = open-ended).
    /// @dev Does NOT stamp a separate
    ///      `lastUsdRateUpdateBlock`. Rate changes manifest over time
    ///      (the multiplier moves linearly per-second), not instantly,
    ///      so the same-block sandwich attack vector that `OkuMoney`'s
    ///      `distributeYield` carries does not apply: a tx landing in
    ///      the same block as `setUsdYieldRate` reads the (just-
    ///      recomputed) `usdBaseMultiplier` and `usdLastAccrualTime`,
    ///      so its `usdMultiplier()` view returns the pre-jump value
    ///      until at least one second has elapsed. The
    ///      `whenYieldNotDistributing` modifier on user-facing paths
    ///      (`wrap`, `unwrap`, `transfer`) still defends against
    ///      OkuMoney-side `distributeYield` collisions, which is the
    ///      attack class that does have instantaneous impact.
    ///
    ///      `endTimestamp == 0` is the "open-ended" sentinel: the rate
    ///      accrues indefinitely until the next `setUsdYieldRate` call.
    ///      Non-zero values must be strictly in the future. While an
    ///      open-ended rate is active, `setNextUsdYieldRate` cannot
    ///      schedule a successor (it reverts with `NoRateEndSet`); the
    ///      operator must re-call `setUsdYieldRate` to switch.
    ///
    ///      Pause-bypass is intentional: operators may need to ZERO the
    ///      rate (pass `newRate = PRECISION`) during an incident response,
    ///      and pausing this setter would defeat that. The companion
    ///      rate-effect setters on `OkuMoney` (`setOkuMMultiplier`,
    ///      `distributeYield`) ARE pause-gated — see those for the
    ///      effect-vs-config split rationale.
    function setUsdYieldRate(
        uint256 newRate,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.VAULT_REBASER)
    {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();
        if (endTimestamp != 0 && endTimestamp <= block.timestamp) revert EndTimestampInPast();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 oldRate = $.usdRatePerSecond;
        $.usdBaseMultiplier = usdMultiplier();
        $.usdLastAccrualTime = block.timestamp;

        $.usdRatePerSecond = newRate;
        $.usdRateEnd = endTimestamp;
        $.usdPendingRatePerSecond = Constants.PRECISION;

        emit UsdYieldRateUpdated(oldRate, newRate, endTimestamp, $.usdBaseMultiplier);
    }

    /// @notice Schedule a successor rate that activates after the current rate's `usdRateEnd`.
    /// @param newRate Per-second rate (1e18 = no yield). Must be in [PRECISION, MAX_RATE].
    /// @dev Requires a non-zero `usdRateEnd` (cannot schedule against an open-ended rate)
    ///      and the current rate must not have already expired.
    function setNextUsdYieldRate(uint256 newRate) external onlyRole(Roles.VAULT_REBASER) {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        if ($.usdRateEnd == 0) revert NoRateEndSet();
        // Staging a pending rate after the current rate has already expired would let
        // the pending rate accrue from the (past) usdRateEnd timestamp the moment it
        // activates, snapshotting an arbitrary amount of unearned yield at that
        // boundary. Force the operator to call setUsdYieldRate() with a fresh end
        // timestamp instead.
        if (block.timestamp >= $.usdRateEnd) revert RateAlreadyExpired();

        $.usdPendingRatePerSecond = newRate;

        emit NextUsdYieldRateSet(newRate, $.usdRateEnd);
    }

    // ============ Blacklist (Works While Paused) ============
    // Reuses the OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role *hashes* so the same
    // role name spans both OkuMoney and OkuDollar — regulatory enforcement is
    // cross-token by design. Note that AccessControl mappings are per-contract,
    // so the role must still be granted on OkuMoney AND OkuDollar separately
    // (handled by initialize() below and by deploy/grantRoles scripts).

    /// @notice Add `account` to the OkuDollar blacklist.
    /// @dev Blacklisted accounts cannot send or receive UsdOku (wrap, unwrap, transfer, transferFrom).
    ///      Reuses the OKUM_BLACKLISTER role hash so the role name spans both tokens;
    ///      the grant itself is per-contract (see header comment above).
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
