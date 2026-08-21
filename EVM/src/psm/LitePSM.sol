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
 *      NO SANDWICH GUARD, NO ANNOUNCEMENT WINDOW, NO FORWARD PRICING.
 *      Continuous accrual has no distribution transaction to sandwich and no
 *      scheduled step to front-run, so pricing reads `uiMultiplier()` directly.
 *      This is the main practical dividend of the continuous design.
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
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.LitePSMV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LITEPSM_STORAGE_LOCATION =
        0x952f98385f783df99339c223f883c63698c43fdc03355b407aa2180810717000;

    function _getLitePSMStorage() private pure returns (LitePSMStorage storage $) {
        assembly {
            $.slot := LITEPSM_STORAGE_LOCATION
        }
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

    // ============ Events ============

    event Minted(address indexed user, uint256 usdcAmount, uint256 rawOut, uint256 uiMultiplier);
    event Redeemed(address indexed user, uint256 rawIn, uint256 usdcOut, uint256 uiMultiplier);
    event RedemptionEnqueued(address indexed user, uint256 rawIn, uint256 queueIndex);
    event BufferDeposited(address indexed from, uint256 amount, uint256 newBalance);
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBalance);
    event BufferRefilled(uint256 newBalance, uint256 startIndex, uint256 endIndex);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);

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
    function quoteMint(uint256 usdcAmount) public view returns (uint256 rawOut) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars(usdcAmount, $.usdcDecimalMultiplier), $.okuDollar.uiMultiplier()
        );
    }

    /// @notice USDC `redeem(rawAmount)` would produce right now.
    function quoteRedeem(uint256 rawAmount) public view returns (uint256 usdcOut) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.dollarsToUsdc(
            MathLib.toUiAmount(rawAmount, $.okuDollar.uiMultiplier()), $.usdcDecimalMultiplier
        );
    }

    /// @notice Largest raw amount redeemable instantly from the current buffer.
    /// @dev Passing this straight into `redeem` never over-draws the buffer: the
    ///      raw figure is floored, so the USDC it converts back to is <= balance.
    ///      Redemption capacity is exposed here, where it lives, rather than
    ///      mirrored onto the token as ERC-4626 `max*` views.
    function redeemableNow() external view returns (uint256 maxRawInstant) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars($.usdc.balanceOf(address(this)), $.usdcDecimalMultiplier),
            $.okuDollar.uiMultiplier()
        );
    }

    // ============ Mint / redeem ============

    /// @notice Mint rUSDOku by depositing USDC.
    /// @param usdcAmount USDC to deposit, native decimals.
    /// @return rawOut Raw rUSDOku minted to the caller.
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused returns (uint256 rawOut) {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;
        uint256 multiplier = $.okuDollar.uiMultiplier();

        rawOut =
            MathLib.fromUiAmount(MathLib.usdcToDollars(usdcAmount, decimalMultiplier), multiplier);
        if (rawOut == 0) revert AmountTooSmall();

        // Round-trip drift: usdc -> raw -> usdc must land within one USDC unit.
        // Truncation always favours the protocol; the 1-unit tolerance prevents
        // reverts at non-even multipliers. Mirrors MakerDAO LitePSM tin/tout dust.
        uint256 roundTrip =
            MathLib.dollarsToUsdc(MathLib.toUiAmount(rawOut, multiplier), decimalMultiplier);
        if (roundTrip + 1 < usdcAmount) revert RoundTripDriftTooLarge(roundTrip, usdcAmount);

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
        usdcOut =
            MathLib.dollarsToUsdc(MathLib.toUiAmount(rawAmount, multiplier), decimalMultiplier);
        if (usdcOut == 0) revert AmountTooSmall();

        // Slippage floor: truncate the input to USDC granularity and require the
        // payout to match. Sub-USDC dust is dropped in the protocol's favour.
        // The divide-before-multiply is intentional USDC-precision flooring, not a
        // rounding bug: it snaps the input down to the nearest whole USDC unit so
        // the payout comparison is made against a representable amount.
        // slither-disable-next-line divide-before-multiply
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 rawFloor = (rawAmount / decimalMultiplier) * decimalMultiplier;
        uint256 minExpected =
            MathLib.dollarsToUsdc(MathLib.toUiAmount(rawFloor, multiplier), decimalMultiplier);
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
        token.safeTransferFrom(user, address($.redemptionQueue), rawAmount);
        uint256 index = $.redemptionQueue.enqueue(user, rawAmount);
        emit RedemptionEnqueued(user, rawAmount, index);
        return 0;
    }

    // ============ Queue processing ============

    /// @notice Process queued redemptions.
    /// @param startIndex First index, inclusive.
    /// @param endIndex Last index, exclusive.
    /// @param approveAmount USDC to approve the queue to pull for this batch.
    /// @dev Not blocked by pause: pause must not lock users into the queue.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        nonReentrant
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

    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.PSM_UPGRADER) {}
}
