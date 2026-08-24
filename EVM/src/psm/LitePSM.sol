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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {Roles} from "../lib/Roles.sol";
import {SafeApprove} from "../lib/SafeApprove.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";

/**
 * @title LitePSM
 * @notice Peg Stability Module — USDC <-> rUSDOku at the UI multiplier.
 *
 * @dev Lifecycle (deposit -> buffer -> queued redemption -> processQueue ->
 *      withdraw) mirrors MakerDAO's `DssLitePsm`.
 *      Taken from https://github.com/makerdao/dss-lite-psm/blob/main/src/DssLitePsm.sol
 *
 *      ```
 *      USDC -> raw:  raw  = (usdcAmount * usdcDecimalMultiplier) * PRECISION / uiMultiplier()
 *      raw -> USDC:  usdc = (raw * uiMultiplier() / PRECISION) / usdcDecimalMultiplier
 *      ```
 *
 *      At `uiMultiplier = 1.05e18`, depositing 100 USDC yields ~95.24 raw
 *      (displayed as $100.00); redeeming 95.24 raw returns ~100 USDC.
 *
 *      NO *LOCAL* SANDWICH GUARD AND NO FORWARD PRICING. Continuous accrual has
 *      no distribution transaction to sandwich and no scheduled step to
 *      front-run, so pricing reads `uiMultiplier()` directly. This remains the
 *      main practical dividend of the continuous design, and it is why this side
 *      needs no `tout`-style step-arbitrage control the way a stepped chain does.
 *
 *      THERE IS A CROSS-CHAIN SYNC WINDOW, which is a different concern. A
 *      multiplier tick is not atomic across chains, and during propagation the
 *      peer chain prices a raw token differently. `mint`, `redeem`,
 *      `redeemUiAmount` and `processQueue` therefore revert while
 *      `okuDollar.isSyncLocked()`. That window is bounded, auto-expiring and
 *      duty-cycled (`Constants.MAX_SYNC_WINDOW` / `MIN_SYNC_WINDOW_GAP`), and it
 *      is inert until an operator sets a nonzero duration.
 *
 *      USDC peg monitoring is off-chain; operators pause on a detected depeg.
 *
 *      Storage uses ERC-7201 namespaced storage.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using SafeApprove for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.LitePSMV2
    struct LitePSMStorage {
        IOkuDollar okuDollar;
        IERC20 usdc;
        RedemptionQueue redemptionQueue;
        uint256 usdcDecimalMultiplier;
        /// @dev Mint fee in bps, charged on deposited USDC. Bounded by
        ///      `MAX_FEE_BPS`. Defaults to 0 — fees ship inert.
        uint256 tin;
        /// @dev Redemption fee in bps, charged on the USDC paid out.
        ///
        ///      On this chain `tout` is present for parity with the upstream
        ///      `dss-lite-psm` design and with the SVM side, NOT because EVM has
        ///      a step-arbitrage surface to defend: accrual here is continuous,
        ///      so there is no discrete step to hold across. It is SVM's stepped
        ///      multiplier that makes `tout` load-bearing. Keeping the parameter
        ///      on both sides keeps the fee schedule, runbook and monitoring
        ///      symmetric.
        uint256 tout;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.LitePSMV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LITEPSM_STORAGE_LOCATION =
        0x952f98385f783df99339c223f883c63698c43fdc03355b407aa2180810717000;

    function _getLitePSMStorage() private pure returns (LitePSMStorage storage $) {
        assembly {
            $.slot := LITEPSM_STORAGE_LOCATION
        }
    }

    // ============ Modifiers ============

    /// @dev Reject operations that convert value through the multiplier while a
    ///      cross-chain tick is in flight.
    ///
    ///      GATING RULE: an operation is sync-gated iff it prices through the
    ///      multiplier. That is the whole rule, and it is what keeps the
    ///      exemptions principled rather than ad hoc — `depositBuffer`,
    ///      `withdrawUsdc` and `advanceHead` all move value at par or move no
    ///      value, so a stale multiplier cannot mis-price them.
    ///
    ///      Read from the token rather than mirrored here: one source of truth,
    ///      and the token is where the multiplier authority lives.
    modifier whenNotSyncLocked() {
        IOkuDollar okuDollar_ = _getLitePSMStorage().okuDollar;
        if (okuDollar_.isSyncLocked()) {
            // Second read only on the revert path, so the happy path pays for
            // one call rather than two. Gives the caller a retry-after instead
            // of an opaque failure.
            revert SyncWindowActive(okuDollar_.syncLockedUntil());
        }
        _;
    }

    // ============ Errors ============

    error AmountTooSmall();
    /// @dev Round-trip USDC -> raw -> USDC differs by more than one USDC unit.
    error RoundTripDriftTooLarge(uint256 actual, uint256 expected);
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientBuffer(uint256 available, uint256 required);
    error WouldStrandQueue(uint256 remainingBalance, uint256 queueObligation);
    error UsdcDecimalsTooLarge(uint8 reported);
    /// @notice The supplied USDC does not match `okuDollar.asset()`.
    error AssetMismatch(address expected, address supplied);
    /// @notice The locally-derived decimal multiplier disagrees with the token's.
    error DecimalMultiplierMismatch(uint256 expected, uint256 derived);
    /// @notice `sweepToken` cannot move USDC — the buffer has its own gated path.
    error CannotSweepAsset();
    /// @notice A cross-chain multiplier tick is propagating; operations that
    ///         price through the multiplier are blocked until it lands.
    /// @dev Distinct from `EnforcedPause`: bounded, auto-expiring, and driven by
    ///      the tick protocol rather than by incident response. Integrators
    ///      should retry rather than treat it as an outage.
    error SyncWindowActive(uint256 lockedUntil);
    /// @notice Proposed `tin` or `tout` exceeds `MAX_FEE_BPS`.
    error FeeAboveMaximum(uint256 requested, uint256 maximum);

    // ============ Events ============

    event Minted(address indexed user, uint256 usdcAmount, uint256 rawOut, uint256 uiMultiplier);
    event Redeemed(address indexed user, uint256 rawIn, uint256 usdcOut, uint256 uiMultiplier);
    event RedemptionEnqueued(address indexed user, uint256 rawIn, uint256 queueIndex);
    event BufferDeposited(address indexed from, uint256 amount, uint256 newBalance);
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBalance);
    event BufferRefilled(uint256 newBalance, uint256 startIndex, uint256 endIndex);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event FeesUpdated(uint256 oldTin, uint256 newTin, uint256 oldTout, uint256 newTout);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the PSM proxy.
    /// @param _okuDollar The rUSDOku token.
    /// @param _usdc USDC address. MUST equal `_okuDollar.asset()`.
    /// @param _redemptionQueue The queue proxy.
    /// @param _admin Receives the full PSM role set.
    function initialize(
        address _okuDollar,
        address _usdc,
        address _redemptionQueue,
        address _admin
    )
        public
        initializer
    {
        if (_okuDollar == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_redemptionQueue == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuDollar = IOkuDollar(_okuDollar);
        $.usdc = IERC20(_usdc);
        $.redemptionQueue = RedemptionQueue(_redemptionQueue);

        // Single source of truth: cross-assert against the token rather than
        // maintaining a second independently-supplied copy. A misconfigured
        // deployment would otherwise get silently divergent pricing between
        // `convertToAssets` and this contract.
        address tokenAsset = IOkuDollar(_okuDollar).asset();
        if (tokenAsset != _usdc) revert AssetMismatch(tokenAsset, _usdc);

        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        uint256 derived = 10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));
        uint256 expected = IOkuDollar(_okuDollar).usdcDecimalMultiplier();
        if (expected != derived) revert DecimalMultiplierMismatch(expected, derived);
        $.usdcDecimalMultiplier = derived;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.PSM_UPGRADER, _admin);
        _grantRole(Roles.PSM_PAUSER, _admin);
        _grantRole(Roles.PSM_UNPAUSER, _admin);
        _grantRole(Roles.PSM_QUEUE_PROCESSOR, _admin);
        _grantRole(Roles.PSM_BUFFER_DEPOSITOR, _admin);
        _grantRole(Roles.PSM_BUFFER_WITHDRAWER, _admin);
        _grantRole(Roles.PSM_FEE_MANAGER, _admin);
    }

    // ============ Storage accessors ============

    function okuDollar() external view returns (IOkuDollar) {
        return _getLitePSMStorage().okuDollar;
    }

    function usdc() external view returns (IERC20) {
        return _getLitePSMStorage().usdc;
    }

    function redemptionQueue() external view returns (RedemptionQueue) {
        return _getLitePSMStorage().redemptionQueue;
    }

    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getLitePSMStorage().usdcDecimalMultiplier;
    }

    // ============ Quotes ============

    /// @notice Raw tokens `mint(usdcAmount)` would produce right now.
    /// @dev Fee-inclusive. An integrator pricing off a fee-free quote would
    ///      over-estimate output by `tin` and mis-size every downstream trade.
    function quoteMint(uint256 usdcAmount) public view returns (uint256 rawOut) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars(MathLib.applyFee(usdcAmount, $.tin), $.usdcDecimalMultiplier),
            $.okuDollar.uiMultiplier()
        );
    }

    /// @notice USDC `redeem(rawAmount)` would produce right now.
    /// @dev Fee-inclusive, i.e. the amount actually received after `tout`.
    function quoteRedeem(uint256 rawAmount) public view returns (uint256 usdcOut) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.applyFee(
            MathLib.dollarsToUsdc(
                MathLib.toUiAmount(rawAmount, $.okuDollar.uiMultiplier()), $.usdcDecimalMultiplier
            ),
            $.tout
        );
    }

    /// @notice Largest raw amount redeemable instantly from the current buffer.
    /// @dev Passing this straight into `redeem` never over-draws the buffer: the
    ///      raw figure is floored, so the USDC it converts back to is <= balance.
    ///      Redemption capacity is exposed here, where it lives, rather than
    ///      mirrored onto the token as ERC-4626 `max*` views.
    ///
    ///      `tout` only makes this MORE conservative — a fee reduces the USDC
    ///      leaving the buffer for a given raw input — so the "never over-draws"
    ///      property is preserved without adjusting for it here. Deliberately
    ///      left fee-free so the figure remains a pure capacity bound.
    function redeemableNow() external view returns (uint256 maxRawInstant) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars($.usdc.balanceOf(address(this)), $.usdcDecimalMultiplier),
            $.okuDollar.uiMultiplier()
        );
    }

    /// @notice Mint fee in basis points.
    function tin() external view returns (uint256) {
        return _getLitePSMStorage().tin;
    }

    /// @notice Redemption fee in basis points.
    function tout() external view returns (uint256) {
        return _getLitePSMStorage().tout;
    }

    // ============ Mint / redeem ============

    /// @notice Mint rUSDOku by depositing USDC.
    /// @param usdcAmount USDC to deposit, native decimals.
    /// @return rawOut Raw rUSDOku minted to the caller.
    function mint(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNotSyncLocked
        returns (uint256 rawOut)
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;
        uint256 multiplier = $.okuDollar.uiMultiplier();

        // Apply `tin` before conversion. The full `usdcAmount` still enters the
        // buffer; the fee portion simply has no rUSDOku minted against it, which
        // is how the fee accretes to the buffer — and therefore to the
        // collateral ratio — with no recipient account and no second transfer.
        uint256 creditedUsdc = MathLib.applyFee(usdcAmount, $.tin);
        if (creditedUsdc == 0) revert AmountTooSmall();

        rawOut = MathLib.fromUiAmount(
            MathLib.usdcToDollars(creditedUsdc, decimalMultiplier), multiplier
        );
        if (rawOut == 0) revert AmountTooSmall();

        // Round-trip drift: usdc -> raw -> usdc must land within one USDC unit.
        // Truncation always favours the protocol; the 1-unit tolerance prevents
        // reverts at non-even multipliers.
        //
        // Compared against `creditedUsdc`, NOT `usdcAmount`. Against the gross
        // deposit this check would treat the fee itself as drift and revert every
        // mint the moment `tin` became nonzero — the fee is an intended,
        // exactly-known deduction, not round-trip error. At `tin == 0` the two
        // are identical, so behaviour is unchanged while fees are disabled.
        uint256 roundTrip =
            MathLib.dollarsToUsdc(MathLib.toUiAmount(rawOut, multiplier), decimalMultiplier);
        if (roundTrip + 1 < creditedUsdc) revert RoundTripDriftTooLarge(roundTrip, creditedUsdc);

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuDollar.mint(msg.sender, rawOut);

        emit Minted(msg.sender, usdcAmount, rawOut, multiplier);
    }

    /// @notice Redeem raw rUSDOku for USDC.
    /// @param rawAmount Raw rUSDOku to redeem (18 dp).
    /// @return usdcOut USDC paid, or 0 if the redemption was queued.
    /// @dev If the buffer cannot cover the payout the tokens are escrowed in the
    ///      queue and 0 is returned. The user keeps earning yield while queued,
    ///      because the escrowed raw amount appreciates with the multiplier.
    function redeem(uint256 rawAmount)
        external
        nonReentrant
        whenNotPaused
        whenNotSyncLocked
        returns (uint256 usdcOut)
    {
        return _redeem(msg.sender, rawAmount);
    }

    /// @notice Redeem by UI (dollar) amount rather than raw.
    /// @param uiAmount Dollar amount to redeem (18 dp).
    /// @return usdcOut USDC paid, or 0 if queued.
    /// @dev CONVENIENCE ONLY, AND A ROUNDING HAZARD. `fromUIAmount` floors, so
    ///      passing `balanceOfUI(msg.sender)` here redeems the caller's whole
    ///      balance minus up to 1 wei — it leaves dust rather than reverting.
    ///      For a true max-redeem use `redeem(balanceOf(msg.sender))`.
    ///
    ///      This is the shape of the May-2026 Sepolia `InsufficientBalance()`
    ///      incident: a UI amount round-tripped back to raw. The share ledger
    ///      that caused it is gone, but the *shape* survives here, and it only
    ///      stays benign because `fromUIAmount` floors. Flipping that direction
    ///      to Ceil — the natural "fix" for the dust — makes this revert.
    ///      Pinned by `MaxSendTest`; see the assertions there before changing
    ///      any rounding direction in `MathLib`.
    function redeemUiAmount(uint256 uiAmount)
        external
        nonReentrant
        whenNotPaused
        whenNotSyncLocked
        returns (uint256 usdcOut)
    {
        if (uiAmount == 0) revert Errors.ZeroAmount();
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 rawAmount = $.okuDollar.fromUIAmount(uiAmount);
        if (rawAmount == 0) revert AmountTooSmall();
        return _redeem(msg.sender, rawAmount);
    }

    function _redeem(address user, uint256 rawAmount) internal returns (uint256 usdcOut) {
        if (rawAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        // Reject sub-USDC-unit redemptions before any math: an input below the
        // decimal multiplier could compute a non-zero payout whose slippage
        // floor collapses to zero and trivially passes the check below.
        if (rawAmount < decimalMultiplier) revert AmountTooSmall();

        uint256 multiplier = $.okuDollar.uiMultiplier();
        uint256 toutBps = $.tout;

        // Gross dollar value of the raw being redeemed, then `tout`. The
        // withheld amount is simply never transferred out — it stays in the
        // buffer, so the fee accrues without a recipient or a second transfer.
        uint256 grossUsdc =
            MathLib.dollarsToUsdc(MathLib.toUiAmount(rawAmount, multiplier), decimalMultiplier);
        usdcOut = MathLib.applyFee(grossUsdc, toutBps);
        // Checked on the NET payout: at a nonzero `tout` a dust redemption can
        // have its whole payout rounded into the fee, and burning the user's
        // tokens for a zero transfer would be theft rather than a fee.
        if (usdcOut == 0) revert AmountTooSmall();

        // Slippage floor: truncate the input to USDC granularity and require the
        // payout to match. Sub-USDC dust is dropped in the protocol's favour.
        // The divide-before-multiply is intentional USDC-precision flooring, not a
        // rounding bug: it snaps the input down to the nearest whole USDC unit so
        // the payout comparison is made against a representable amount.
        //
        // BOTH SIDES ARE POST-FEE. Comparing a post-fee payout against a fee-free
        // expectation would revert every redemption the instant `tout` became
        // nonzero. `applyFee` is monotone non-decreasing in `gross`, so the
        // inequality still holds for its intended purpose (catching genuine
        // conversion drift) once the fee is applied consistently. At `tout == 0`
        // this is bit-identical to the fee-free form.
        // slither-disable-next-line divide-before-multiply
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 rawFloor = (rawAmount / decimalMultiplier) * decimalMultiplier;
        uint256 minExpected = MathLib.applyFee(
            MathLib.dollarsToUsdc(MathLib.toUiAmount(rawFloor, multiplier), decimalMultiplier),
            toutBps
        );
        if (usdcOut < minExpected) revert OutputBelowMinimum(usdcOut, minExpected);

        IERC20 token = IERC20(address($.okuDollar));

        if ($.usdc.balanceOf(address(this)) >= usdcOut) {
            token.safeTransferFrom(user, address(this), rawAmount);
            $.okuDollar.burn(rawAmount);
            $.usdc.safeTransfer(user, usdcOut);
            emit Redeemed(user, rawAmount, usdcOut, multiplier);
            return usdcOut;
        }

        // Buffer short: escrow in the queue.
        //
        // The prevailing `tout` is snapshotted into the entry rather than read
        // at processing time, so a later fee change cannot retroactively tax
        // users who were already waiting. They were quoted this rate when they
        // joined the queue.
        token.safeTransferFrom(user, address($.redemptionQueue), rawAmount);
        uint256 index = $.redemptionQueue.enqueue(user, rawAmount, toutBps);
        emit RedemptionEnqueued(user, rawAmount, index);
        return 0;
    }

    // ============ Queue processing ============

    /// @notice Process queued redemptions.
    /// @param startIndex First index, inclusive.
    /// @param endIndex Last index, exclusive.
    /// @param approveAmount USDC to approve the queue to pull for this batch.
    /// @dev Not blocked by pause: pause must not lock users into the queue.
    ///
    ///      IS blocked by the sync window, and the distinction is the point.
    ///      Pause is unbounded and incident-driven, so gating queue processing
    ///      on it could strand users indefinitely. The sync window is bounded by
    ///      `MAX_SYNC_WINDOW` and duty-cycled by `MIN_SYNC_WINDOW_GAP`, so the
    ///      worst case is a short delay — and leaving it open would be a real
    ///      hole, because the queue prices at the live multiplier
    ///      (`RedemptionQueue.processQueue` caches `uiMultiplier()` per batch)
    ///      and would therefore settle at a stale cross-chain price.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        nonReentrant
        whenNotSyncLocked
        onlyRole(Roles.PSM_QUEUE_PROCESSOR)
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.setExactAllowance(address($.redemptionQueue), approveAmount);
        $.redemptionQueue.processQueue(startIndex, endIndex);
        $.usdc.revokeAllowance(address($.redemptionQueue));
        emit BufferRefilled($.usdc.balanceOf(address(this)), startIndex, endIndex);
    }

    // ============ Buffer management ============

    /// @notice Deposit USDC into the redemption buffer.
    /// @dev Not pause-gated: topping up the buffer during an incident is the
    ///      remediation, not an attack surface.
    function depositBuffer(uint256 amount) external onlyRole(Roles.PSM_BUFFER_DEPOSITOR) {
        if (amount == 0) revert Errors.ZeroAmount();
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount, $.usdc.balanceOf(address(this)));
    }

    /// @notice Withdraw USDC from the buffer.
    /// @dev Not pause-gated by design: during an incident the buffer withdrawer
    ///      may need to move USDC to safety while user-facing mint/redeem is
    ///      halted. Cannot drop the buffer below outstanding queue obligations.
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
        uint256 queueObligation = $.redemptionQueue.totalQueuedUsdc();
        uint256 remaining = balance - amount;
        if (remaining < queueObligation) revert WouldStrandQueue(remaining, queueObligation);
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, remaining);
    }

    /// @notice Sweep a non-USDC token out of the PSM.
    /// @dev The PSM holds no rUSDOku between calls by construction, but anyone
    ///      can transfer tokens here for free. Without this, donations are
    ///      stranded. USDC is explicitly excluded — the buffer has its own gated
    ///      path (`withdrawUsdc`) with the `WouldStrandQueue` check, and routing
    ///      around it here would defeat that guard.
    function sweepToken(
        address token,
        address to
    )
        external
        nonReentrant
        onlyRole(Roles.PSM_BUFFER_WITHDRAWER)
    {
        if (token == address(0) || to == address(0)) revert Errors.ZeroAddress();
        LitePSMStorage storage $ = _getLitePSMStorage();
        if (token == address($.usdc)) revert CannotSweepAsset();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert Errors.ZeroAmount();
        emit TokenSwept(token, to, balance);
        IERC20(token).safeTransfer(to, balance);
    }

    // ============ Pause ============

    /// @notice Set the `tin` / `tout` fee schedule in basis points.
    /// @dev `PSM_FEE_MANAGER`, intended for the same cold key that holds
    ///      `OKU_CAP_MANAGER` — a fee schedule is economic policy, the same class
    ///      as `setMaxSupply`. It is a distinct, PSM-namespaced constant rather
    ///      than `OKU_CAP_MANAGER` itself because AccessControl mappings are
    ///      per-contract: no new key, but a correctly-scoped capability.
    ///      Both fees bounded by `MAX_FEE_BPS`.
    ///
    ///      Fees accrue to the USDC buffer: `tin` is deposited but not credited,
    ///      `tout` is owed but not paid out. There is no recipient address and no
    ///      sweep, so a fee raises the collateral ratio rather than being
    ///      extracted.
    ///
    ///      Does NOT retroactively affect entries already in the redemption
    ///      queue — each snapshots the `tout` prevailing when it was enqueued.
    ///
    ///      Ported from the upstream this PSM was modelled on, which carries
    ///      `tin`/`tout` and which the original port omitted.
    ///      Taken from https://github.com/makerdao/dss-lite-psm/blob/master/src/DssLitePsm.sol
    function setFees(uint256 newTin, uint256 newTout) external onlyRole(Roles.PSM_FEE_MANAGER) {
        if (newTin > Constants.MAX_FEE_BPS) {
            revert FeeAboveMaximum(newTin, Constants.MAX_FEE_BPS);
        }
        if (newTout > Constants.MAX_FEE_BPS) {
            revert FeeAboveMaximum(newTout, Constants.MAX_FEE_BPS);
        }

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 oldTin = $.tin;
        uint256 oldTout = $.tout;
        $.tin = newTin;
        $.tout = newTout;

        emit FeesUpdated(oldTin, newTin, oldTout, newTout);
    }

    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.PSM_UPGRADER) {}
}
