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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {IOracleRelay} from "../oracle/IOracleRelay.sol";
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
 *      Includes a USDC peg circuit-breaker (via {IOracleRelay}) and a redemption queue
 *      for when the buffer is empty. Convenience functions wrap/unwrap OkuDollar via
 *      the vault.
 *
 *      Peg-check semantics: every mint/redeem path calls `oracleRelay.checkUsdcPeg()`
 *      when the relay is configured. Operators can disable the check by calling
 *      `setOracleRelay(address(0))` (operational kill switch for incident response).
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
        // USDC peg circuit-breaker. `address(0)` disables the check.
        IOracleRelay oracleRelay;
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
    error InsufficientBuffer(uint256 available, uint256 required);
    error WouldStrandQueue(uint256 remainingBalance, uint256 queueObligation);
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
    /// @dev The OracleRelay is wired post-deploy via {setOracleRelay}; until then,
    ///      the peg check is bypassed. This bootstrap path is required because
    ///      the chain-specific Chainlink feed address may not be known at the
    ///      moment the PSM proxy is deployed.
    function initialize(
        address _okuMoney,
        address _okuDollar,
        address _usdc,
        address _redemptionQueue,
        address _admin
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_okuDollar == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_redemptionQueue == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuDollar = IOkuDollar(_okuDollar);
        $.usdc = IERC20(_usdc);
        $.redemptionQueue = RedemptionQueue(_redemptionQueue);

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

    function okuMoney() external view returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    function okuDollar() external view returns (IOkuDollar) {
        return _getLitePSMStorage().okuDollar;
    }

    function usdc() external view returns (IERC20) {
        return _getLitePSMStorage().usdc;
    }

    function redemptionQueue() external view returns (RedemptionQueue) {
        return _getLitePSMStorage().redemptionQueue;
    }

    function oracleRelay() external view returns (IOracleRelay) {
        return _getLitePSMStorage().oracleRelay;
    }

    /// @notice Decimal conversion multiplier for the configured USDC variant.
    function usdcDecimalMultiplier() external view returns (uint256) {
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
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        // Cycle 4 (EVM-17): peg check hoisted above the math + transfers
        // so the depeg-revert path doesn't waste compute on the
        // dollar-conversion ladder.
        _pegCheck($);
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

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(msg.sender, okuMAmount);

        emit OkuMMinted(msg.sender, usdcAmount, okuMAmount, okuMMult);
    }

    /// @notice Redeem OkuMoney for USDC.
    /// @dev usdcAmount = okuMAmount * okuMMultiplier / PRECISION (scaled to USDC decimals).
    /// @param okuMAmount Amount of OkuMoney to redeem (18 decimals)
    function redeemOkuM(uint256 okuMAmount)
        external
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
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
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
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
        _pegCheck($);
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        // Cycle 4 (EVM-05): reject sub-USDC-unit redemptions BEFORE
        // doing any math. Without this guard, an input less than the
        // decimal multiplier could in principle compute a non-zero
        // `usdcAmount` whose slippage floor (`okuMFloor`) collapses
        // to zero and trivially passes the post-conversion check.
        // Minimum redemption granularity = 1 USDC-unit worth of OkuM.
        if (okuMAmount < decimalMultiplier) revert AmountTooSmall();

        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue18 = MathLib.okuMToDollars(okuMAmount, okuMMult);
        usdcAmount = MathLib.dollarsToUsdc(dollarValue18, decimalMultiplier);
        if (usdcAmount == 0) revert AmountTooSmall();

        // Slippage protection: truncate input to USDC-representable floor and require
        // the converted USDC matches that floor. Sub-USDC dust is dropped favorably.
        // The divide-before-multiply below is intentional USDC-precision flooring, not a
        // rounding vulnerability. Slither's divide-before-multiply detector will flag it.
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
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        // Cycle 4 (EVM-17): peg check hoisted above the math.
        _pegCheck($);
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
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
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
        nonReentrant
        whenNotPaused
        whenYieldNotDistributing
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        IERC20Permit(address($.okuDollar))
            .permit(msg.sender, address(this), usdAmount, deadline, v, r, s);
        _redeemUsdOku(msg.sender, usdAmount);
    }

    function _redeemUsdOku(address user, uint256 usdAmount) internal {
        if (usdAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        _pegCheck($);

        // Measure actual UsdOku received: OkuDollar is share-based with a continuously
        // compounding usdMultiplier. `transferFrom(amount)` floors the share conversion
        // (OkuDollar.transferFrom), while `unwrap(amount)` ceils the share burn
        // (OkuDollar.unwrap). When `usdMultiplier > 1e18`, the two diverge by up to 1
        // share and `unwrap(usdAmount)` would revert with InsufficientBalance because
        // the PSM holds 1 share less than `unwrap` demands. Reading the post-transfer
        // balance delta and passing that to `unwrap` guarantees the share counts align.
        // Same balance-delta pattern as OkuDollar.wrap (handles share-based / fee-on-
        // transfer tokens generally).
        uint256 balBefore = IERC20(address($.okuDollar)).balanceOf(address(this));
        IERC20(address($.okuDollar)).safeTransferFrom(user, address(this), usdAmount);
        uint256 received = IERC20(address($.okuDollar)).balanceOf(address(this)) - balBefore;
        if (received == 0) revert AmountTooSmall();

        // Reverts if vault undercollateralized (distinct failure mode).
        uint256 okuMReturned = $.okuDollar.unwrap(received, address(this));
        // UsdOkuRedeemed is the sole event for this path (no underlying OkuMRedeemed).
        uint256 usdcOut = _redeemOkuMFromSelf(user, okuMReturned);

        emit UsdOkuRedeemed(user, received, usdcOut, $.okuMoney.okuMMultiplier());
    }

    /// @notice Process queued redemptions (called by operator when buffer refilled).
    /// @param startIndex First queue index to process (inclusive)
    /// @param endIndex Last queue index to process (exclusive)
    /// @param approveAmount USDC amount to approve for processing (sum of entries by backend)
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        nonReentrant
        whenNotPaused
        onlyRole(Roles.PSM_QUEUE_PROCESSOR)
    {
        LitePSMStorage storage $ = _getLitePSMStorage();

        $.usdc.setExactAllowance(address($.redemptionQueue), approveAmount);
        $.redemptionQueue.processQueue(startIndex, endIndex);
        $.usdc.revokeAllowance(address($.redemptionQueue));

        emit BufferRefilled($.usdc.balanceOf(address(this)), startIndex, endIndex);
    }

    // ============ Oracle Relay Management ============

    /// @notice Wire (or unwire) the USDC peg circuit-breaker.
    /// @dev `address(0)` disables the check — operational kill switch
    ///      for incident response. When set to a non-zero address,
    ///      every mint and redeem path calls `relay.checkUsdcPeg()`
    ///      and reverts on depeg / unhealthy oracle data.
    ///
    ///      Cycle 4 (EVM-03): emits a dedicated `OracleRelayDisabled`
    ///      event in addition to `OracleRelayUpdated` so monitoring
    ///      tooling can distinguish a routine rotation from a
    ///      kill-switch trip. The disable event only fires when an
    ///      actually-configured relay is being cleared (i.e.
    ///      `oldRelay != 0`); a no-op `setOracleRelay(0)` on a fresh
    ///      deploy does not pollute the monitoring feed.
    function setOracleRelay(address newRelay) external onlyRole(Roles.PSM_ORACLE_MANAGER) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        address oldRelay = address($.oracleRelay);
        $.oracleRelay = IOracleRelay(newRelay);
        emit OracleRelayUpdated(oldRelay, newRelay);
        if (newRelay == address(0) && oldRelay != address(0)) {
            emit OracleRelayDisabled(msg.sender, oldRelay, block.number);
        }
    }

    /// @dev Single peg-check call site reused by every mint/redeem path. When the
    ///      relay is not configured the check is a no-op (matches the relay
    ///      bootstrap path; see {initialize}).
    function _pegCheck(LitePSMStorage storage $) internal view {
        IOracleRelay relay = $.oracleRelay;
        if (address(relay) != address(0)) {
            relay.checkUsdcPeg();
        }
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    /// @dev `whenYieldNotDistributing` guards the `totalQueuedUsdc()` read below,
    ///      which is multiplier-aware. Without the guard a same-block yield
    ///      distribution would shift the queue obligation while the buffer
    ///      balance held still, opening a thin sandwich window against the
    ///      `WouldStrandQueue` check.
    function withdrawUsdc(
        address to,
        uint256 amount
    )
        external
        whenYieldNotDistributing
        onlyRole(Roles.PSM_BUFFER_WITHDRAWER)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 balance = $.usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBuffer(balance, amount);
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
