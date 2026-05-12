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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {SafeApprove} from "../lib/SafeApprove.sol";
import {YieldSandwichGuard} from "../lib/YieldSandwichGuard.sol";
import {LitePSMEvents} from "../lib/events/LitePSMEvents.sol";

/**
 * @title LitePSM
 * @notice Multiplier-aware Peg Stability Module for USDC <-> OkuMoney/OkuDollar swaps
 * @dev Lifecycle (deposit -> buffer -> queued redemption -> processQueue -> withdraw)
 *      mirrors MakerDAO's `DssLitePsm` design — buffer-backed mints with a redemption
 *      queue when the buffer is depleted.
 *      Taken from https://github.com/makerdao/dss-lite-psm/blob/main/src/DssLitePsm.sol
 *
 *      OkuMoney is non-rebasing — okuMMultiplier() tracks appreciation separately.
 *      The PSM converts at dollar value via okuMMultiplier(): depositing 100 USDC at
 *      okuMMultiplier=$1.05 yields ~95.24 OkuM; redeeming those OkuM returns ~100 USDC.
 *      Includes PoR oracle checks and a redemption queue for when the buffer is empty.
 *      Convenience functions wrap/unwrap OkuDollar via the vault.
 *
 *      Decimal flexibility: the USDC-side decimal multiplier is computed at init from
 *      `IERC20Metadata(usdc).decimals()` and stored on the proxy. This lets the PSM run
 *      on chains with non-6-decimal USDC variants without a code change.
 *
 *      See Constants.sol for terminology legend.
 *      See {OkuMoney.initialize} for the unified role-grant policy.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    YieldSandwichGuard,
    UUPSUpgradeable,
    LitePSMEvents
{
    using SafeERC20 for IERC20;
    using SafeApprove for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.LitePSM
    struct LitePSMStorage {
        IOkuMoney okuMoney;
        IOkuDollar okuDollar;
        IERC20 usdc;
        RedemptionQueue redemptionQueue;
        // Oracle configuration
        IAggregatorV3 porOracle;
        uint256 stalenessThreshold;
        bool oracleEnabled;
        // Decimal conversion multiplier resolved at init from IERC20Metadata(usdc).decimals().
        // For Circle USDC (6 decimals) this is 1e12.
        uint256 usdcDecimalMultiplier;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.LitePSM")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LITEPSM_STORAGE_LOCATION =
        0x3513f3377f3ae2495699e5bd066d9c7b1ec04346bbec81953fcd75e4450d9100;

    function _getLitePSMStorage() private pure returns (LitePSMStorage storage $) {
        assembly {
            $.slot := LITEPSM_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress, ZeroAmount) live in lib/Errors.sol.
    // YieldDistributionInProgress is inherited from YieldSandwichGuard.
    error AmountTooSmall();
    /// @dev Round-trip USDC -> OkuM -> USDC differs by more than 1 USDC unit (rounding tolerance).
    ///      Truncation always favors the protocol; the 1-unit tolerance prevents reverts at
    ///      non-even multipliers. Mirrors MakerDAO LitePSM's tin/tout dust handling.
    error RoundTripDriftTooLarge(uint256 actual, uint256 expected);
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error OracleNotConfigured();
    error IncompleteOracleRound();
    error StaleOracleData();
    error InvalidOracleResponse();
    error ExceedsReserves(uint256 newSupply, uint256 reserves);
    error InsufficientBuffer(uint256 available, uint256 required);
    error WouldStrandQueue(uint256 remainingBalance, uint256 queueObligation);
    error InvalidStaleness(uint256 provided, uint256 minAllowed, uint256 maxAllowed);
    /// @dev Reverted when the configured USDC reports more decimals than supported (>18).
    error UsdcDecimalsTooLarge(uint8 reported);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the PSM proxy.
    /// @param _okuMoney OkuMoney token address
    /// @param _okuDollar OkuDollar vault address
    /// @param _usdc USDC token address (must implement IERC20Metadata.decimals())
    /// @param _redemptionQueue RedemptionQueue address
    /// @param _admin Admin address (receives full role set; see {OkuMoney.initialize})
    /// @param _stalenessThreshold Initial PoR oracle staleness threshold (seconds);
    ///        bounded by Constants.ORACLE_MIN_STALENESS / Constants.ORACLE_MAX_STALENESS.
    function initialize(
        address _okuMoney,
        address _okuDollar,
        address _usdc,
        address _redemptionQueue,
        address _admin,
        uint256 _stalenessThreshold
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_okuDollar == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_redemptionQueue == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (
            _stalenessThreshold < Constants.ORACLE_MIN_STALENESS
                || _stalenessThreshold > Constants.ORACLE_MAX_STALENESS
        ) {
            revert InvalidStaleness(
                _stalenessThreshold, Constants.ORACLE_MIN_STALENESS, Constants.ORACLE_MAX_STALENESS
            );
        }

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuDollar = IOkuDollar(_okuDollar);
        $.usdc = IERC20(_usdc);
        $.redemptionQueue = RedemptionQueue(_redemptionQueue);
        $.stalenessThreshold = _stalenessThreshold;

        // Resolve decimal multiplier from the USDC contract. Token decimal counts of >18
        // are rejected — OkuMoney is 18 decimals, so a higher-precision USDC would force
        // negative-exponent math.
        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.PSM_UPGRADER, _admin);
        _grantRole(Roles.PSM_PAUSER, _admin);
        _grantRole(Roles.PSM_UNPAUSER, _admin);
        _grantRole(Roles.PSM_QUEUE_PROCESSOR, _admin);
        _grantRole(Roles.PSM_BUFFER_DEPOSITOR, _admin);
        _grantRole(Roles.PSM_BUFFER_WITHDRAWER, _admin);
        _grantRole(Roles.PSM_ORACLE_MANAGER, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    function okuDollar() public view returns (IOkuDollar) {
        return _getLitePSMStorage().okuDollar;
    }

    function usdc() public view returns (IERC20) {
        return _getLitePSMStorage().usdc;
    }

    function redemptionQueue() public view returns (RedemptionQueue) {
        return _getLitePSMStorage().redemptionQueue;
    }

    function porOracle() public view returns (IAggregatorV3) {
        return _getLitePSMStorage().porOracle;
    }

    function stalenessThreshold() public view returns (uint256) {
        return _getLitePSMStorage().stalenessThreshold;
    }

    function oracleEnabled() public view returns (bool) {
        return _getLitePSMStorage().oracleEnabled;
    }

    /// @notice Decimal conversion multiplier for the configured USDC variant.
    function usdcDecimalMultiplier() public view returns (uint256) {
        return _getLitePSMStorage().usdcDecimalMultiplier;
    }

    // ============ Yield Distribution Lock ============

    /// @inheritdoc YieldSandwichGuard
    function _yieldSandwichOkuMoney() internal view override returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    // ============ OkuMoney Swap Functions (Multiplier-Aware) ============

    /// @notice Mint OkuMoney by depositing USDC.
    /// @dev okuMAmount = usdcValue18 * PRECISION / okuMMultiplier.
    ///      At okuMMultiplier=$1.05, depositing 100 USDC mints ~95.24 OkuM.
    /// @param usdcAmount Amount of USDC to deposit (USDC native decimals)
    function mintOkuM(uint256 usdcAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        uint256 usdcValue18 = MathLib.usdcToDollars(usdcAmount, decimalMultiplier);
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        if (okuMAmount == 0) revert AmountTooSmall();

        // Round-trip drift check: usdcAmount -> okuMAmount -> usdcAmount must be within
        // 1 USDC unit. Truncation in `dollarsToOkuM` can drop sub-USDC dust in the
        // protocol's favor; the 1-unit tolerance prevents reverts at non-even multipliers
        // (e.g. $1.05). Pattern mirrors MakerDAO LitePSM's tin/tout dust handling.
        uint256 roundTripUsdc =
            MathLib.dollarsToUsdc(MathLib.okuMToDollars(okuMAmount, okuMMult), decimalMultiplier);
        if (roundTripUsdc + 1 < usdcAmount) {
            revert RoundTripDriftTooLarge(roundTripUsdc, usdcAmount);
        }

        if ($.oracleEnabled && address($.porOracle) != address(0)) {
            _checkReserves(okuMAmount);
        }

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(msg.sender, okuMAmount);

        emit OkuMMinted(msg.sender, usdcAmount, okuMAmount, okuMMult);
    }

    /// @notice Redeem OkuMoney for USDC.
    /// @dev usdcAmount = okuMAmount * okuMMultiplier / PRECISION (scaled to USDC decimals).
    /// @param okuMAmount Amount of OkuMoney to redeem (18 decimals)
    function redeemOkuM(uint256 okuMAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        _redeemOkuMShared(msg.sender, okuMAmount, false);
    }

    /// @notice Redeem OkuMoney for USDC using EIP-2612 permit (single transaction).
    function redeemOkuMWithPermit(
        uint256 okuMAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        IERC20Permit(address($.okuMoney))
            .permit(msg.sender, address(this), okuMAmount, deadline, v, r, s);
        _redeemOkuMShared(msg.sender, okuMAmount, false);
    }

    /// @notice Redeem OkuMoney for USDC where the OkuM is already held by the PSM.
    /// @dev Used by `_redeemUsdOku` after `okuDollar.unwrap()` deposits the OkuM here.
    ///      Does NOT emit `OkuMRedeemed`; callers emit their own user-facing event.
    /// @return usdcAmount USDC transferred to user (0 if queued).
    function _redeemOkuMFromSelf(
        address user,
        uint256 okuMAmount
    )
        internal
        returns (uint256 usdcAmount)
    {
        return _redeemOkuMShared(user, okuMAmount, true);
    }

    /// @dev Shared core for the four redemption paths.
    ///      `okuMAtPsm`: false -> pull OkuM from `user`, emit OkuMRedeemed on instant path;
    ///                   true  -> OkuM is already held by this contract; do not emit.
    function _redeemOkuMShared(
        address user,
        uint256 okuMAmount,
        bool okuMAtPsm
    )
        internal
        returns (uint256 usdcAmount)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue18 = MathLib.okuMToDollars(okuMAmount, okuMMult);
        usdcAmount = MathLib.dollarsToUsdc(dollarValue18, decimalMultiplier);
        if (usdcAmount == 0) revert AmountTooSmall();

        // Slippage protection: truncate input to USDC-representable floor and require
        // the converted USDC matches that floor. Sub-USDC dust is dropped favorably.
        uint256 okuMFloor = (okuMAmount / decimalMultiplier) * decimalMultiplier;
        uint256 minUsdcExpected =
            MathLib.dollarsToUsdc(MathLib.okuMToDollars(okuMFloor, okuMMult), decimalMultiplier);
        if (usdcAmount < minUsdcExpected) {
            revert OutputBelowMinimum(usdcAmount, minUsdcExpected);
        }

        // If buffer covers the redemption: burn OkuM (pulled or held), pay USDC.
        // Otherwise: route OkuM to the queue. Pull OkuM from user only when not held.
        uint256 usdcBalance = $.usdc.balanceOf(address(this));
        if (usdcBalance >= usdcAmount) {
            if (!okuMAtPsm) {
                IERC20(address($.okuMoney)).safeTransferFrom(user, address(this), okuMAmount);
            }
            $.okuMoney.burn(okuMAmount);
            $.usdc.safeTransfer(user, usdcAmount);
            if (!okuMAtPsm) {
                emit OkuMRedeemed(user, okuMAmount, usdcAmount, okuMMult);
            }
            return usdcAmount;
        }

        // Insufficient buffer: queue the redemption.
        if (!okuMAtPsm) {
            IERC20(address($.okuMoney)).safeTransferFrom(user, address(this), okuMAmount);
        }
        IERC20(address($.okuMoney)).safeTransfer(address($.redemptionQueue), okuMAmount);
        $.redemptionQueue.enqueue(user, okuMAmount);
        return 0; // queued, not paid
    }

    // ============ OkuDollar Convenience Functions ============

    /// @notice Mint OkuDollar by depositing USDC (USDC -> mint OkuM -> wrap -> OkuDollar to user).
    /// @dev Multiplier-aware. The slippage floor passed to `wrap` is computed by
    ///      replicating `wrap`'s exact two-step floor math via {MathLib.okuMToWrappedUsd}.
    ///      Passing `usdcValue18` directly would revert at non-even multipliers because
    ///      `dollarsToOkuM` truncates okuMAmount in the protocol's favor and `wrap`'s
    ///      output is bounded above by `usdcValue18`, so the naive floor is unreachable.
    ///      A symmetric 1-USDC-unit round-trip drift check mirrors {mintOkuM}.
    function mintUsdOku(uint256 usdcAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        uint256 usdcValue18 = MathLib.usdcToDollars(usdcAmount, decimalMultiplier);
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        if (okuMAmount == 0) revert AmountTooSmall();

        // Expected wrap output computed with the same truncation `wrap` performs.
        // This is the tightest possible slippage floor: it can only diverge if the
        // vault's multipliers move between this call and the wrap (impossible — we
        // hold the reentrancy guard and the yield-distribution guard) or if OkuM
        // becomes fee-on-transfer (handled by `wrap`'s own balance-delta check).
        uint256 usdMult = $.okuDollar.usdMultiplier();
        uint256 expectedUsdMinted = MathLib.okuMToWrappedUsd(okuMAmount, okuMMult, usdMult);

        // Round-trip drift check: usdcAmount -> usdMinted -> usdcAmount must be within
        // 1 USDC unit. Mirrors the pattern in {mintOkuM}; truncation favors the
        // protocol but the 1-unit tolerance prevents reverts at non-even multipliers.
        uint256 roundTripUsdc = MathLib.dollarsToUsdc(expectedUsdMinted, decimalMultiplier);
        if (roundTripUsdc + 1 < usdcAmount) {
            revert RoundTripDriftTooLarge(roundTripUsdc, usdcAmount);
        }

        if ($.oracleEnabled && address($.porOracle) != address(0)) {
            _checkReserves(okuMAmount);
        }

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(address(this), okuMAmount);

        // One-shot allowance to the vault: wrap will pull okuMAmount; we revoke after.
        IERC20 okuMoneyToken = IERC20(address($.okuMoney));
        okuMoneyToken.setExactAllowance(address($.okuDollar), okuMAmount);
        uint256 usdMinted = $.okuDollar.wrap(okuMAmount, msg.sender, expectedUsdMinted);
        okuMoneyToken.revokeAllowance(address($.okuDollar));

        emit UsdOkuMinted(msg.sender, usdcAmount, usdMinted, okuMMult);
    }

    /// @notice Redeem OkuDollar for USDC (OkuDollar -> unwrap -> burn OkuM -> USDC to user).
    /// @dev Reverts if the vault is undercollateralized (unwrap fails).
    ///      If the buffer is insufficient, OkuM is queued (the user earns yield while
    ///      queued via okuMMultiplier appreciation).
    function redeemUsdOku(uint256 usdAmount)
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        _redeemUsdOku(msg.sender, usdAmount);
    }

    /// @notice Redeem OkuDollar for USDC using EIP-2612 permit (single transaction).
    function redeemUsdOkuWithPermit(
        uint256 usdAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        whenYieldNotDistributing
        nonReentrant
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        IERC20Permit(address($.okuDollar))
            .permit(msg.sender, address(this), usdAmount, deadline, v, r, s);
        _redeemUsdOku(msg.sender, usdAmount);
    }

    function _redeemUsdOku(address user, uint256 usdAmount) internal {
        if (usdAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();

        IERC20(address($.okuDollar)).safeTransferFrom(user, address(this), usdAmount);
        // Reverts if vault undercollateralized (distinct failure mode).
        uint256 okuMReturned = $.okuDollar.unwrap(usdAmount, address(this));
        // UsdOkuRedeemed is the sole event for this path (no underlying OkuMRedeemed).
        uint256 usdcOut = _redeemOkuMFromSelf(user, okuMReturned);

        emit UsdOkuRedeemed(user, usdAmount, usdcOut, $.okuMoney.okuMMultiplier());
    }

    /// @notice Process queued redemptions (called by operator when buffer refilled).
    /// @param startIndex First queue index to process (inclusive)
    /// @param endIndex Last queue index to process (exclusive)
    /// @param approveAmount USDC amount to approve for processing (sum of entries by backend)
    /// @dev TODO: re-evaluate `whenYieldNotDistributing` omission. Queue settlement is currently
    ///      always callable so admins can drain obligations during yield events; revisit when
    ///      the off-chain orchestrator has explicit yield-window awareness.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        whenNotPaused
        onlyRole(Roles.PSM_QUEUE_PROCESSOR)
        nonReentrant
    {
        LitePSMStorage storage $ = _getLitePSMStorage();

        $.usdc.setExactAllowance(address($.redemptionQueue), approveAmount);
        $.redemptionQueue.processQueue(startIndex, endIndex);
        $.usdc.revokeAllowance(address($.redemptionQueue));

        emit BufferRefilled($.usdc.balanceOf(address(this)), startIndex, endIndex);
    }

    // ============ Oracle Management ============

    function configureOracle(
        address _oracle,
        uint256 _stalenessThreshold,
        bool _enabled
    )
        external
        onlyRole(Roles.PSM_ORACLE_MANAGER)
    {
        // Configuring an "enabled" oracle at address(0) silently bypasses reserve checks
        // (the runtime guard skips when porOracle == 0); reject that footgun here.
        if (_enabled && _oracle == address(0)) revert Errors.ZeroAddress();
        // Bound the staleness threshold to a sensible range. Outside this range either
        // every oracle read reverts (too low) or stale data is silently accepted (too high).
        if (
            _stalenessThreshold < Constants.ORACLE_MIN_STALENESS
                || _stalenessThreshold > Constants.ORACLE_MAX_STALENESS
        ) {
            revert InvalidStaleness(
                _stalenessThreshold, Constants.ORACLE_MIN_STALENESS, Constants.ORACLE_MAX_STALENESS
            );
        }

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.porOracle = IAggregatorV3(_oracle);
        $.stalenessThreshold = _stalenessThreshold;
        $.oracleEnabled = _enabled;
        emit OracleConfigured(_oracle, _stalenessThreshold, _enabled);
    }

    function _checkReserves(uint256 mintAmount) internal view {
        LitePSMStorage storage $ = _getLitePSMStorage();
        if (address($.porOracle) == address(0)) revert OracleNotConfigured();

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            $.porOracle.latestRoundData();

        if (answeredInRound < roundId) revert IncompleteOracleRound();
        if (block.timestamp - updatedAt >= $.stalenessThreshold) revert StaleOracleData();
        if (answer < 0) revert InvalidOracleResponse();

        uint256 newSupply = $.okuMoney.totalSupply() + mintAmount;
        uint256 reserves = SafeCast.toUint256(answer);
        if (reserves < newSupply) revert ExceedsReserves(newSupply, reserves);
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    /// @dev TODO: revisit yield-distribution guard policy. Currently buffer ops are always
    ///      callable to keep withdrawals/refills available during yield events. Confirm with
    ///      orchestrator design before relying on this in production.
    function withdrawUsdc(
        address to,
        uint256 amount
    )
        external
        onlyRole(Roles.PSM_BUFFER_WITHDRAWER)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 balance = $.usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBuffer(balance, amount);
        // NOTE: queueObligation is computed at the current okuMMultiplier. Race with a
        // yield event is possible but PSM_BUFFER_WITHDRAWER is permissioned. Tracked
        // for revisit alongside the yield-distribution guard policy above.
        uint256 queueObligation = $.redemptionQueue.totalQueuedUsdc();
        uint256 remainingBalance = balance - amount;
        if (remainingBalance < queueObligation) {
            revert WouldStrandQueue(remainingBalance, queueObligation);
        }
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, remainingBalance);
    }

    /// @notice Deposit USDC to PSM buffer for redemptions.
    function depositBuffer(uint256 amount) external onlyRole(Roles.PSM_BUFFER_DEPOSITOR) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount, $.usdc.balanceOf(address(this)));
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(Roles.PSM_UPGRADER)
    {}
}
