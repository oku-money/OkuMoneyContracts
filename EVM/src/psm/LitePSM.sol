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
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OverrideBlockGuard} from "../lib/OverrideBlockGuard.sol";
import {LitePSMEvents} from "../lib/events/LitePSMEvents.sol";

/// @dev Minimal view onto OZ `Pausable` for the OkuMoney instance (not part of IOkuMoney).
interface IPausableView {
    function paused() external view returns (bool);
}

/**
 * @title LitePSM
 * @notice Multiplier-aware Peg Stability Module for USDC <-> OkuMoney/OkuDollar swaps
 * @dev Only the zero-fee swap and the decimal conversion factor come from MakerDAO's
 *      DssLitePsm. The redemption flow is original: OkuM is minted on demand (bounded by the
 *      minter allowance), and redemptions the USDC buffer can't cover go to {RedemptionQueue}.
 *
 *      OkuMoney is non-rebasing — okuMMultiplier() tracks appreciation separately. The
 *      PSM converts at dollar value via okuMMultiplier(): depositing 100 USDC at
 *      okuMMultiplier=$1.05 yields ~95.24 OkuM; redeeming those OkuM returns ~100 USDC.
 *      Convenience functions wrap/unwrap OkuDollar via the vault. USDC peg monitoring is
 *      off-chain; operators `pause()` the PSM on a detected depeg.
 *
 *      The USDC-side decimal multiplier is computed at init from
 *      `IERC20Metadata(usdc).decimals()` and stored on the proxy, so the PSM runs on
 *      chains with non-6-decimal USDC variants without a code change.
 *
 *      See Constants.sol for terminology legend.
 *      See {OkuMoney.initialize} for the unified role-grant policy.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    OverrideBlockGuard,
    UUPSUpgradeable,
    LitePSMEvents
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.LitePSM
    struct LitePSMStorage {
        IOkuMoney okuMoney;
        IOkuDollar okuDollar;
        IERC20 usdc;
        RedemptionQueue redemptionQueue;
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
    // OverrideInProgress is inherited from OverrideBlockGuard.
    error AmountTooSmall();
    // There is deliberately no slippage/drift error here. Two once existed
    // (`RoundTripDriftTooLarge`, `OutputBelowMinimum`); both read as slippage protection,
    // neither could protect anything, and one bricked mints at 18-decimal collateral.
    // Do not reintroduce them — see {redeemOkuM} for why a min-out has nothing to bound.
    // {OkuDollar} keeps its own `OutputBelowMinimum` for `wrap`; that one is reachable
    // and unrelated.
    //
    // `BelowMinimumRedemption` below is NOT one of those — it is an anti-griefing
    // floor on redemption SIZE (queue-entry dust), not a slippage/min-out check on
    // redemption PRICE. Monotonicity of `okuMMultiplier` has nothing to say about it.
    // Do not fold it into the "no min-out" argument above or delete it under that
    // banner.
    error InsufficientBuffer(uint256 available, uint256 required);
    error WouldStrandQueue(uint256 remainingBalance, uint256 queueObligation);
    /// @dev Reverted when the configured USDC reports more decimals than supported (>18).
    error UsdcDecimalsTooLarge(uint8 reported);
    /// @dev `_okuDollar` must wrap the same OkuMoney instance passed as `_okuMoney` —
    ///      every PSM/vault price computation assumes a single shared multiplier.
    error AssetMismatch();
    /// @dev `_redemptionQueue` must be configured with the same USDC as this PSM —
    ///      otherwise this PSM approves spending of its own USDC while the queue reads
    ///      balance/allowance on a different token, silently zeroing `usdcAvailable` in
    ///      every batch (see `RedemptionQueue.processQueue`).
    error QueueUsdcMismatch(address queueUsdc, address psmUsdc);
    /// @dev `_redemptionQueue` must be configured with the same OkuMoney as `_okuMoney` —
    ///      otherwise `RedemptionQueue.processQueue` burns the wrong token's escrow against
    ///      entries denominated in this one.
    error QueueOkuMoneyMismatch(address queueOkuMoney, address psmOkuMoney);
    /// @dev Reverted by the redeem path's dust floor. See
    ///      `Constants.MIN_REDEMPTION_OKUM` and {_redeemOkuMShared}.
    error BelowMinimumRedemption(uint256 provided, uint256 minimum);
    error UserBlacklisted(address user);
    error OkuMoneyPaused();

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
        if (IOkuDollar(_okuDollar).asset() != _okuMoney) revert AssetMismatch();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuDollar = IOkuDollar(_okuDollar);
        $.usdc = IERC20(_usdc);
        $.redemptionQueue = RedemptionQueue(_redemptionQueue);

        // >18 decimals is rejected: OkuMoney is 18 decimals, so a higher-precision USDC
        // would force negative-exponent math.
        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier = 10 ** (uint256(Constants.OKU_M_DECIMALS) - uint256(usdcDecimals));

        // Wiring validation: the queue is always deployed and initialized BEFORE this PSM
        // (deploy/index.ts and every test fixture), so its `usdc()`/`okuMoney()` are
        // already set and safe to read here. This is a read, not the QUEUE_PSM role grant
        // — no circularity with the deliberate omission at
        // `RedemptionQueue.sol` initialize (that one is about the grant, not reads).
        // Placed after this PSM's own config is validated (zero-address, asset mismatch,
        // decimals) so a malformed `_usdc`/`_okuMoney` reports its OWN defect rather than
        // being masked by a wiring error against an otherwise-unrelated queue.
        // Deploy-time only: does not protect against an already-deployed queue being
        // repointed post-upgrade, or against a manual (non-script) deployment that skips
        // this constructor path entirely for an already-initialized queue proxy reused
        // via a stale address book — see `scripts/deploy/index.ts`'s `verifyDeployment`
        // for the check that covers that path.
        RedemptionQueue queueRef = RedemptionQueue(_redemptionQueue);
        address queueUsdc = address(queueRef.usdc());
        if (queueUsdc != _usdc) revert QueueUsdcMismatch(queueUsdc, _usdc);
        address queueOkuMoney = address(queueRef.okuMoney());
        if (queueOkuMoney != _okuMoney) revert QueueOkuMoneyMismatch(queueOkuMoney, _okuMoney);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.PSM_UPGRADER, _admin);
        _grantRole(Roles.PSM_PAUSER, _admin);
        _grantRole(Roles.PSM_UNPAUSER, _admin);
        _grantRole(Roles.PSM_QUEUE_PROCESSOR, _admin);
        _grantRole(Roles.PSM_BUFFER_DEPOSITOR, _admin);
        _grantRole(Roles.PSM_BUFFER_WITHDRAWER, _admin);
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

    /// @notice Decimal conversion multiplier for the configured USDC variant.
    /// @return Multiplier such that `usdcAmount * multiplier` converts to 18-decimal dollars.
    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getLitePSMStorage().usdcDecimalMultiplier;
    }

    // ============ Yield Distribution Lock ============

    /// @inheritdoc OverrideBlockGuard
    function _overrideBlockOkuMoney() internal view override returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    // ============ OkuMoney Swap Functions (Multiplier-Aware) ============

    /// @notice Mint OkuMoney by depositing USDC.
    /// @dev okuMAmount = usdcValue18 * PRECISION / okuMMultiplier.
    ///      At okuMMultiplier=$1.05, depositing 100 USDC mints ~95.24 OkuM.
    ///
    ///      NO SLIPPAGE PARAMETER, BY DESIGN — see {redeemOkuM} for the full argument.
    ///      The short version for this direction: the caller fixes `usdcAmount`, and
    ///      `okuMAmount` scales inversely with the multiplier while each unit is worth
    ///      proportionally more, so the DOLLAR value received is invariant to when the
    ///      transaction lands. There is no adverse price movement for a bound to catch.
    ///
    ///      `dollarsToOkuM` floors, so the caller forfeits up to one raw OkuM unit —
    ///      worth `okuMMultiplier / PRECISION` collateral units — to the protocol on
    ///      every mint. That is dust at 6-decimal collateral and still sub-cent at 18,
    ///      and it is the only value difference between minting now and minting later.
    /// @param usdcAmount Amount of USDC to deposit (USDC native decimals)
    function mintOkuM(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        uint256 usdcValue18 = MathLib.usdcToDollars(usdcAmount, decimalMultiplier);
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        if (okuMAmount == 0) revert AmountTooSmall();

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(msg.sender, okuMAmount);

        emit OkuMMinted(msg.sender, usdcAmount, okuMAmount, okuMMult);
    }

    /// @notice Redeem OkuMoney for USDC.
    /// @dev usdcAmount = okuMAmount * okuMMultiplier / PRECISION (scaled to USDC decimals).
    ///
    ///      NO SLIPPAGE PARAMETER, BY DESIGN. A `minUsdcOut` would protect against the
    ///      multiplier moving adversely between signing and execution — but it cannot
    ///      move adversely. `okuMMultiplier` is monotonically non-decreasing: streaming
    ///      accrual compounds a rate that {OkuMoney._setOkuMYieldRate} rejects below
    ///      `PRECISION`, and the discrete override {OkuMoney.setOkuMMultiplier} requires
    ///      a strict increase. Redemption output is linear and increasing in it, so a
    ///      delayed, reordered or front-run redemption pays the caller MORE, never less.
    ///      There is no downside to bound. Pinned by
    ///      `test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier`.
    ///
    ///      This argument has one load-bearing precondition: THE PSM CHARGES NO FEE.
    ///      A fee was considered (see `TRACKER.md` git history) and ruled out as
    ///      protocol policy — a `tin`/`tout` would make output non-monotone in time
    ///      and the reasoning above would collapse. If that policy is ever
    ///      reversed, min-out parameters must land in the SAME change that adds a
    ///      fee, not after.
    ///
    ///      SVM DIVERGES DELIBERATELY: `lite-psm`'s `redeem_oku_m` does take a
    ///      `min_usdc_out`. Same monotonicity holds there, so it is client-side
    ///      defence-in-depth rather than a structural need — see that instruction's
    ///      doc comment, which documents the divergence from the other side.
    /// @param okuMAmount Amount of OkuMoney to redeem (18 decimals)
    /// @return usdcAmount USDC paid immediately; `0` means queued (not a failure) — see
    ///         {_redeemOkuMShared}.
    function redeemOkuM(uint256 okuMAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256 usdcAmount)
    {
        return _redeemOkuMShared(msg.sender, okuMAmount, false);
    }

    /// @dev Shared core for the four redemption paths. `okuMAtPsm`: false -> pull OkuM
    ///      from `user` and emit OkuMRedeemed on the instant path; true -> OkuM is already
    ///      held here (by `_redeemUsdOku` after `okuDollar.unwrap()`), so do not emit —
    ///      the caller emits its own user-facing event.
    ///      Returns `0` when the buffer is insufficient and the redemption is queued
    ///      instead — a successful call, not a failure. Callers distinguishing
    ///      "settled" vs. "queued" should check this return value or listen for
    ///      `OkuMRedeemed` vs. `RedemptionQueue.RedemptionQueued`.
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

        // Minimum redemption granularity: the queue's dust floor.
        //
        // Every redemption the buffer cannot cover becomes a `QueueEntry` costing two
        // SSTOREs to create and full loop-body gas plus an external `burn` to process,
        // so without a floor an attacker could stuff the queue with economically
        // meaningless entries at the processor's expense.
        //
        // `decimalMultiplier` (`10**(18-d)`) is a real floor at 6-decimal collateral
        // (1e12 OkuM wei, ~$0.000001) but COLLAPSES TO 1 — no floor at all — at
        // 18-decimal collateral (e.g. Binance-Peg USDC on BSC). `MIN_REDEMPTION_OKUM`
        // is an absolute constant floor independent of collateral decimals, so the
        // effective floor is whichever of the two is larger; 6-decimal chains are
        // unaffected since `decimalMultiplier` already dominates there.
        uint256 minRedemption = decimalMultiplier > Constants.MIN_REDEMPTION_OKUM
            ? decimalMultiplier
            : Constants.MIN_REDEMPTION_OKUM;
        if (okuMAmount < minRedemption) revert BelowMinimumRedemption(okuMAmount, minRedemption);

        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 dollarValue18 = MathLib.okuMToDollars(okuMAmount, okuMMult);
        usdcAmount = MathLib.dollarsToUsdc(dollarValue18, decimalMultiplier);
        // NO `usdcAmount == 0` check here (unlike `mintOkuM`'s): provably unreachable given
        // `minRedemption` above and `okuMMult >= PRECISION`, since that makes
        // `usdcAmount >= 1` always. See the error declarations above re: not reintroducing
        // dead checks.

        // The UsdOku path never touches the user's OkuMoney balance, so check here.
        if ($.okuMoney.isBlacklisted(user)) revert UserBlacklisted(user);

        // Instant only from USDC above what the queue is already owed, so the public
        // can't overtake queued claims. The backend still controls order via processQueue.
        uint256 usdcBalance = $.usdc.balanceOf(address(this));
        if (usdcBalance >= usdcAmount + $.redemptionQueue.totalQueuedUsdc()) {
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
    /// @param usdcAmount Amount of USDC to deposit (USDC native decimals).
    /// @dev Multiplier-aware. SINGLE MULTIPLIER: `okuDollar.usdMultiplier()` IS
    ///      `okuMoney.okuMMultiplier()` (enforced by `initialize`'s wiring check), so
    ///      `wrap`'s share formula is the identity and its dollar output is exactly
    ///      {MathLib.okuMToDollars}.
    ///
    ///      No slippage parameter, for the same reason as {mintOkuM} — see that
    ///      function's NatSpec. Note this is distinct from the `minAmountOut` passed
    ///      DOWN to {OkuDollar.wrap} below: that one is a real, reachable check
    ///      guarding the OkuM -> UsdOku leg against the vault minting less than the
    ///      exact share-formula identity predicts, and it stays.
    function mintUsdOku(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        uint256 usdcValue18 = MathLib.usdcToDollars(usdcAmount, decimalMultiplier);
        uint256 okuMMult = $.okuMoney.okuMMultiplier();
        uint256 okuMAmount = MathLib.dollarsToOkuM(usdcValue18, okuMMult);
        if (okuMAmount == 0) revert AmountTooSmall();
        // OkuM is minted to the PSM, so OkuMoney's own check never sees the user.
        if ($.okuMoney.isBlacklisted(msg.sender)) revert UserBlacklisted(msg.sender);

        // Expected wrap output, using the same truncation `wrap` performs — the tightest
        // possible slippage floor. It can only diverge if the vault multiplier moves
        // between here and the wrap (impossible: we hold the reentrancy and
        // yield-distribution guards) or if OkuM becomes fee-on-transfer (covered by
        // `wrap`'s own balance-delta check).
        uint256 expectedUsdMinted = MathLib.okuMToDollars(okuMAmount, okuMMult);

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(address(this), okuMAmount);

        // One-shot allowance to the vault: wrap will pull okuMAmount; we revoke after.
        IERC20 okuMoneyToken = IERC20(address($.okuMoney));
        okuMoneyToken.forceApprove(address($.okuDollar), okuMAmount);
        uint256 usdMinted = $.okuDollar.wrap(okuMAmount, msg.sender, expectedUsdMinted);
        okuMoneyToken.forceApprove(address($.okuDollar), 0);

        emit UsdOkuMinted(msg.sender, usdcAmount, usdMinted, okuMMult);
    }

    /// @notice Redeem OkuDollar for USDC (OkuDollar -> unwrap -> burn OkuM -> USDC to user).
    /// @param usdAmount Amount of OkuDollar to redeem (dollar terms, 18 decimals).
    /// @dev Reverts if the vault is undercollateralized (unwrap fails).
    ///      If the buffer is insufficient, OkuM is queued (the user earns yield while
    ///      queued via okuMMultiplier appreciation).
    /// @return usdcOut USDC paid immediately; `0` means queued, same convention as
    ///         {redeemOkuM}.
    function redeemUsdOku(uint256 usdAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256 usdcOut)
    {
        return _redeemUsdOku(msg.sender, usdAmount);
    }

    function _redeemUsdOku(address user, uint256 usdAmount) internal returns (uint256 usdcOut) {
        if (usdAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        // Fail before pulling UsdOku.
        if ($.okuMoney.isBlacklisted(user)) revert UserBlacklisted(user);

        // Measure actual UsdOku received. `OkuDollar.transferFrom(amount)` floors the
        // share conversion while `OkuDollar.unwrap(amount)` ceils the share burn, so at
        // `usdMultiplier > 1e18` the two diverge by up to 1 share and `unwrap(usdAmount)`
        // would revert with InsufficientBalance. Passing the post-transfer balance delta
        // to `unwrap` keeps the share counts aligned. Same balance-delta pattern as
        // OkuDollar.wrap (also covers fee-on-transfer tokens).
        uint256 balBefore = IERC20(address($.okuDollar)).balanceOf(address(this));
        IERC20(address($.okuDollar)).safeTransferFrom(user, address(this), usdAmount);
        uint256 received = IERC20(address($.okuDollar)).balanceOf(address(this)) - balBefore;
        if (received == 0) revert AmountTooSmall();

        // Reverts if vault undercollateralized (distinct failure mode).
        uint256 okuMReturned = $.okuDollar.unwrap(received, address(this));
        // UsdOkuRedeemed is the sole event for this path (no underlying OkuMRedeemed).
        usdcOut = _redeemOkuMShared(user, okuMReturned, true);

        emit UsdOkuRedeemed(user, received, usdcOut, $.okuMoney.okuMMultiplier());
    }

    /// @notice Process queued redemptions (called by operator when buffer refilled).
    /// @param startIndex First queue index to process (inclusive)
    /// @param endIndex Last queue index to process (exclusive)
    /// @param approveAmount USDC amount to approve for processing (sum of entries by backend)
    /// @dev `whenNoOverrideThisBlock` is required because
    ///      `RedemptionQueue.processQueue` caches `okuMMultiplier()` once and pays real
    ///      USDC against it, so a discrete multiplier bump in the same block would shift
    ///      every payout in the batch. Every multiplier-consuming path here carries it.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        onlyRole(Roles.PSM_QUEUE_PROCESSOR)
    {
        _processQueue(startIndex, endIndex, approveAmount);
    }

    /// @dev Callers handle role, PSM pause, reentrancy and override-block checks.
    ///      OkuMoney's pause is checked here because `burn` isn't pause-gated.
    function _processQueue(uint256 startIndex, uint256 endIndex, uint256 approveAmount) internal {
        LitePSMStorage storage $ = _getLitePSMStorage();
        if (IPausableView(address($.okuMoney)).paused()) revert OkuMoneyPaused();

        $.usdc.forceApprove(address($.redemptionQueue), approveAmount);
        $.redemptionQueue.processQueue(startIndex, endIndex);
        $.usdc.forceApprove(address($.redemptionQueue), 0);

        emit QueueProcessed($.usdc.balanceOf(address(this)), startIndex, endIndex);
    }

    /// @dev `_processQueue` behind the override guard (a modifier can't be conditional).
    function _processQueueGuarded(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        internal
        whenNoOverrideThisBlock
    {
        _processQueue(startIndex, endIndex, approveAmount);
    }

    // ============ Admin Functions ============

    /// @notice Pause the PSM (blocks minting, redeeming, and queue processing).
    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    /// @notice Unpause the PSM.
    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    /// @notice Withdraw USDC from the PSM buffer.
    /// @param to Recipient of the USDC.
    /// @param amount Amount of USDC to withdraw (native decimals).
    /// @dev Pause-gated: while paused, no USDC leaves the PSM by any path.
    ///
    ///      `whenNoOverrideThisBlock` guards the multiplier-aware `totalQueuedUsdc()`
    ///      read: without it a same-block yield distribution would shift the queue
    ///      obligation while the buffer balance held still, opening a sandwich window
    ///      against the `WouldStrandQueue` check.
    function withdrawUsdc(
        address to,
        uint256 amount
    )
        external
        whenNotPaused
        whenNoOverrideThisBlock
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

    /// @notice Deposit USDC into the PSM buffer for redemptions.
    /// @param amount Amount of USDC to deposit (native decimals).
    /// @param processQueue_ Also process `[startIndex, endIndex)` in the same tx. Requires
    ///        `PSM_QUEUE_PROCESSOR` and the same pause/override conditions as {processQueue}.
    ///        The remaining arguments are ignored when false.
    function depositBuffer(
        uint256 amount,
        bool processQueue_,
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        nonReentrant
        onlyRole(Roles.PSM_BUFFER_DEPOSITOR)
    {
        if (amount == 0) revert Errors.ZeroAmount();
        if (processQueue_) {
            _checkRole(Roles.PSM_QUEUE_PROCESSOR);
            _requireNotPaused();
        }

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount, $.usdc.balanceOf(address(this)));

        if (processQueue_) {
            _processQueueGuarded(startIndex, endIndex, approveAmount);
        }
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.PSM_UPGRADER) {}
}
