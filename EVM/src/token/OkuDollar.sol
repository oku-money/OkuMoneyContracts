// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuDollar")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUDOLLAR_STORAGE_LOCATION =
        0x47ad802b8b69e1fb26602029cb9d680d20222bfb119aa501ef9624c481132900;

    function _getOkuDollarStorage() private pure returns (OkuDollarStorage storage $) {
        assembly {
            $.slot := OKUDOLLAR_STORAGE_LOCATION
        }
    }

    /// @notice Bundled rate-and-share status for off-chain consumers / scripts.
    /// @dev Convenience view; the existing individual getters remain available.
    struct OkuDollarStatus {
        uint256 usdMultiplier;
        uint256 usdBaseMultiplier;
        uint256 usdRatePerSecond;
        uint256 usdPendingRatePerSecond;
        uint256 usdLastAccrualTime;
        uint256 usdRateEnd;
        uint256 totalUsdShares;
        uint256 minCollateralRatio;
        uint256 collateralizationRatio;
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress, MultiplierCannotDecrease, ZeroAmount, InsufficientBalance)
    // live in lib/Errors.sol. YieldDistributionInProgress is inherited from YieldSandwichGuard.
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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuMoney,
        string memory name,
        string memory symbol,
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

        __ERC20_init(name, symbol);
        __ERC20Permit_init(name);
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
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getOkuDollarStorage().okuMoney;
    }

    function usdRatePerSecond() public view returns (uint256) {
        return _getOkuDollarStorage().usdRatePerSecond;
    }

    function usdLastAccrualTime() public view returns (uint256) {
        return _getOkuDollarStorage().usdLastAccrualTime;
    }

    function usdRateEnd() public view returns (uint256) {
        return _getOkuDollarStorage().usdRateEnd;
    }

    function usdPendingRatePerSecond() public view returns (uint256) {
        return _getOkuDollarStorage().usdPendingRatePerSecond;
    }

    function minCollateralRatio() public view returns (uint256) {
        return _getOkuDollarStorage().minCollateralRatio;
    }

    function totalUsdShares() public view returns (uint256) {
        return _getOkuDollarStorage().totalUsdShares;
    }

    function usdSharesOf(address account) public view returns (uint256) {
        return _getOkuDollarStorage().usdShares[account];
    }

    function usdBaseMultiplier() public view returns (uint256) {
        return _getOkuDollarStorage().usdBaseMultiplier;
    }

    /// @notice Snapshot of all rate-and-share state in one call.
    function getStatus() external view returns (OkuDollarStatus memory) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        return OkuDollarStatus({
            usdMultiplier: usdMultiplier(),
            usdBaseMultiplier: $.usdBaseMultiplier,
            usdRatePerSecond: $.usdRatePerSecond,
            usdPendingRatePerSecond: $.usdPendingRatePerSecond,
            usdLastAccrualTime: $.usdLastAccrualTime,
            usdRateEnd: $.usdRateEnd,
            totalUsdShares: $.totalUsdShares,
            minCollateralRatio: $.minCollateralRatio,
            collateralizationRatio: collateralizationRatio()
        });
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
        uint256 result =
            (base * MathLib.rpow(rate, elapsed, Constants.PRECISION)) / Constants.PRECISION;
        return result > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : result;
    }

    // ============ ERC20 Overrides (USD Share-based) ============

    function totalSupply() public view override(ERC20Upgradeable, IOkuDollar) returns (uint256) {
        return (_getOkuDollarStorage().totalUsdShares * usdMultiplier()) / Constants.PRECISION;
    }

    function balanceOf(address account)
        public
        view
        override(ERC20Upgradeable, IOkuDollar)
        returns (uint256)
    {
        return (_getOkuDollarStorage().usdShares[account] * usdMultiplier()) / Constants.PRECISION;
    }

    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        uint256 shares = (amount * Constants.PRECISION) / usdMultiplier();
        _transferUsdShares(msg.sender, to, shares);
        // Emit caller-specified amount; share-reconverted value can drift 1 wei due to truncation.
        emit Transfer(msg.sender, to, amount);
        return true;
    }

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
        uint256 shares = (amount * Constants.PRECISION) / usdMultiplier();
        _transferUsdShares(from, to, shares);
        emit Transfer(from, to, amount);
        return true;
    }

    /// @dev Public ERC-20 `Transfer` event is emitted by the calling function with the
    ///      original token amount. This helper only tracks share movement + dollar value.
    function _transferUsdShares(address from, address to, uint256 shares) internal {
        if (from == address(0)) revert Errors.ZeroAddress();
        if (to == address(0)) revert Errors.ZeroAddress();

        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 fromBalance = $.usdShares[from];
        if (fromBalance < shares) revert Errors.InsufficientBalance();

        $.usdShares[from] = fromBalance - shares;
        $.usdShares[to] += shares;
        uint256 dollarValue = (shares * usdMultiplier()) / Constants.PRECISION;
        emit TransferValue(from, to, shares, dollarValue);
    }

    // ============ Inherited ERC20 guard ============

    /// @dev OkuDollar overrides `transfer`/`transferFrom` to use share-based accounting.
    ///      The inherited ERC20 `_update` hook is therefore only reachable via the
    ///      inherited `_mint` (from == address(0)) or `_burn` (to == address(0)) paths,
    ///      which must never be called — all supply changes go through `wrap()`/`unwrap()`
    ///      which manage `usdShares` directly.
    ///      Peer-to-peer `_update` calls (both from and to non-zero) should also never
    ///      occur since `transfer`/`transferFrom` bypass ERC20's internal path, but they
    ///      are allowed to fall through to `super._update` harmlessly.
    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0)) revert("OkuDollar: use wrap()");
        if (to == address(0)) revert("OkuDollar: use unwrap()");
        super._update(from, to, amount);
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

        uint256 usdMult = usdMultiplier();
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        okuMReturned = (usdAmount * Constants.PRECISION) / okuMMult;

        // Ceiling division to favor the vault on share burn.
        uint256 sharesToBurn = ((usdAmount * Constants.PRECISION) + usdMult - 1) / usdMult;
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
    /// @dev Used when USD rate > OkuM rate (vault undercollateralized). OkuMoney is
    ///      non-rebasing — token value depends on okuMMultiplier().
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
            postRatio = (postReservesDollarValue * Constants.PRECISION) / obligations;
        }
        if (postRatio < $.minCollateralRatio) revert BelowMinimumCollateral();

        IERC20(address($.okuMoney)).safeTransfer(msg.sender, okuMAmount);

        emit SurplusWithdrawn(msg.sender, okuMAmount, _okuMToDollarValue(okuMAmount), postRatio);
    }

    // ============ Admin ============

    /// @notice Update the minimum collateral ratio enforced by `withdrawSurplus`.
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
        return (_okuMToDollarValue(totalOkuMReserves()) * Constants.PRECISION) / obligations;
    }

    /// @notice Extractable surplus as OkuMoney tokens (0 if undercollateralized).
    function surplus() public view returns (uint256) {
        OkuDollarStorage storage $ = _getOkuDollarStorage();
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = (totalOkuMReserves() * okuMMult) / Constants.PRECISION;
        uint256 obligations = totalUsdObligations();
        if (reservesDollarValue <= obligations) return 0;
        return MathLib.dollarsToOkuM(reservesDollarValue - obligations, okuMMult);
    }

    // ============ Rate Management (VAULT_REBASER) ============

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

    // ============ Pause Management ============

    function pause() external onlyRole(Roles.VAULT_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.VAULT_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(Roles.VAULT_UPGRADER)
    {}
}
