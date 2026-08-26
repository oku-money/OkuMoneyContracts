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
import {IOkuM} from "../interfaces/IOkuM.sol";
import {IUSDOku} from "../interfaces/IUSDOku.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {USDOkuWrapper} from "../wrapper/USDOkuWrapper.sol";

/**
 * @title SubscriptionModule
 * @notice USDC <-> OkuM at `M_oku`. The sole user-facing mint/redeem surface.
 *
 * @dev RENAMED FROM `LitePSM`. Nothing here is pegged: this is a mint/redeem
 *      facility quoting at the current realized index. A contract called *PSM*,
 *      in a product with a dollar token, with `tin`/`tout` fees, would be read
 *      by integrators and counsel as a peg mechanism — OkuM has no peg and never
 *      will. (USDOku's $1 unit comes from the wrapper's 1:1 definition, not from
 *      a stability module.) The `tin`/`tout` names and the lifecycle
 *      (deposit -> buffer -> queued redemption -> processQueue -> withdraw) are
 *      kept, inherited from MakerDAO's `DssLitePsm`:
 *      https://github.com/makerdao/dss-lite-psm/blob/main/src/DssLitePsm.sol
 *
 *      ```
 *      USDC -> raw:  raw  = (usdcAmount * usdcDecimalMultiplier) * PRECISION / uiMultiplier()
 *      raw -> USDC:  usdc = (raw * uiMultiplier() / PRECISION) / usdcDecimalMultiplier
 *      ```
 *
 *      At `uiMultiplier = 1.05e18`, depositing 100 USDC yields ~95.24 raw
 *      (displayed as $100.00); redeeming 95.24 raw returns ~100 USDC.
 *
 *      FEES ARE A LIVE DEFENCE, NOT PARITY PARAMETERS. `M_oku` steps, so the
 *      round trip mint-at-M0 / redeem-at-M1 extracts the step unless fees cover
 *      it: `profit per unit = M1/M0 - 1 - (tin + tout)/10_000`. The
 *      STEP-COVERAGE INVARIANT is static and per-leg:
 *
 *          MAX_STEP_BPS <= tin,  MAX_STEP_BPS <= tout       (`setFees`, here)
 *          stepBps <= MAX_STEP_BPS                          (`OkuM.setOkuMultiplier`)
 *
 *      Composed, every admissible step is covered on each leg independently for
 *      all time. No state, no ratchet, no cross-contract read, and no escape
 *      hatch — the guarantee is a property of the constants. Per-leg rather than
 *      combined because a cross-chain round trip pays `tin` on one chain and
 *      `tout` on the other; see `setFees` for the full argument.
 *
 *      NOT SYNC-WINDOW GATED. Nothing in this contract is. A single-chain
 *      operation priced at this chain's own `M_oku` is correct by definition
 *      whatever a peer chain believes, so the window would buy nothing while
 *      costing a post-mark outage on every mint and redeem. The window fences
 *      the bridge legs (`OkuM.mint`/`burn`), where raw crosses a multiplier
 *      boundary and the pair genuinely mis-prices.
 *
 *      USDC <-> USDOku IN ONE TRANSACTION. `mintUsdOku` / `redeemUsdOku` chain
 *      the OkuM leg above through `USDOkuWrapper.wrap`/`unwrap` so a user never
 *      has to hold the intermediate OkuM themselves — mint OkuM to this
 *      contract, wrap it straight to the caller (or the reverse). This exists
 *      because USDOku is the instrument for wallets that cannot yet render
 *      ERC-8056, and making it the HARDEST asset to acquire (mint, approve,
 *      wrap — three transactions) would defeat that purpose. Wired post-deploy
 *      via `setUsdOkuWrapper`; both revert `UsdOkuWrapperNotSet` until then.
 *
 *      USDC peg monitoring is off-chain; operators pause on a detected depeg.
 *
 *      Storage uses ERC-7201 namespaced storage.
 */
contract SubscriptionModule is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using SafeApprove for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.SubscriptionModule
    struct SubscriptionModuleStorage {
        IOkuM okuM;
        IERC20 usdc;
        RedemptionQueue redemptionQueue;
        uint256 usdcDecimalMultiplier;
        /// @dev Mint fee in bps, charged on deposited USDC. Bounded above by
        ///      `MAX_FEE_BPS` and below by `MAX_STEP_BPS` (per-leg step
        ///      coverage). Seeded at the floor by `initialize` and never
        ///      permitted below it, so coverage holds from block one.
        uint256 tin;
        /// @dev Redemption fee in bps, charged on the USDC paid out. Same
        ///      bounds. Each leg independently covers a maximal step.
        uint256 tout;
        /// @dev The USDOku wrapper, wired post-deploy (it does not exist yet
        ///      when this contract initializes — deploy order is OkuM, queue,
        ///      module, USDOku, wrapper). Zero until wired; `mintUsdOku` and
        ///      `redeemUsdOku` fail closed until it is.
        USDOkuWrapper usdOkuWrapper;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.SubscriptionModule")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MODULE_STORAGE_LOCATION =
        0xecd0cb33fb25c826f207d6173dfc2e3b8a1f214fee397fc84b1785e86d97ea00;

    function _getModuleStorage() private pure returns (SubscriptionModuleStorage storage $) {
        assembly {
            $.slot := MODULE_STORAGE_LOCATION
        }
    }

    // ============ Modifiers ============

    // ============ Errors ============

    error AmountTooSmall();
    /// @dev Round-trip USDC -> raw -> USDC differs by more than one USDC unit.
    error RoundTripDriftTooLarge(uint256 actual, uint256 expected);
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error InsufficientBuffer(uint256 available, uint256 required);
    error WouldStrandQueue(uint256 remainingBalance, uint256 queueObligation);
    error UsdcDecimalsTooLarge(uint8 reported);
    /// @notice The supplied USDC does not match `okuM.asset()`.
    error AssetMismatch(address expected, address supplied);
    /// @notice The locally-derived decimal multiplier disagrees with the token's.
    error DecimalMultiplierMismatch(uint256 expected, uint256 derived);
    /// @notice `sweepToken` cannot move USDC — the buffer has its own gated path.
    error CannotSweepAsset();
    /// @notice Proposed `tin` or `tout` exceeds `MAX_FEE_BPS`.
    error FeeAboveMaximum(uint256 requested, uint256 maximum);
    /// @notice Proposed `tin` or `tout` is below the static step-coverage floor.
    /// @dev Each leg must independently cover the largest admissible step
    ///      (`MAX_STEP_BPS`). See `setFees` for why the floor is per-leg rather
    ///      than on the combined round trip.
    error FeeBelowStepFloor(uint256 requested, uint256 floorBps);
    /// @notice `mintUsdOku` / `redeemUsdOku` called before `setUsdOkuWrapper`.
    error UsdOkuWrapperNotSet();

    // ============ Events ============

    event Minted(address indexed user, uint256 usdcAmount, uint256 rawOut, uint256 uiMultiplier);
    event Redeemed(address indexed user, uint256 rawIn, uint256 usdcOut, uint256 uiMultiplier);
    event RedemptionEnqueued(address indexed user, uint256 rawIn, uint256 queueIndex);
    event BufferDeposited(address indexed from, uint256 amount, uint256 newBalance);
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBalance);
    event BufferRefilled(uint256 newBalance, uint256 startIndex, uint256 endIndex);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event FeesUpdated(uint256 oldTin, uint256 newTin, uint256 oldTout, uint256 newTout);
    /// @notice USDC minted directly to USDOku in one transaction.
    event UsdOkuMinted(
        address indexed user, uint256 usdcAmount, uint256 usdOkuOut, uint256 uiMultiplier
    );
    /// @notice USDOku redeemed directly for USDC in one transaction.
    event UsdOkuRedeemed(
        address indexed user, uint256 usdOkuIn, uint256 usdcOut, uint256 uiMultiplier
    );
    event UsdOkuWrapperSet(address indexed oldWrapper, address indexed newWrapper);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the module proxy.
    /// @param _okuM The OkuM token.
    /// @param _usdc USDC address. MUST equal `_okuM.asset()`.
    /// @param _redemptionQueue The queue proxy.
    /// @param _admin Receives the full module role set.
    function initialize(
        address _okuM,
        address _usdc,
        address _redemptionQueue,
        address _admin
    )
        public
        initializer
    {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_redemptionQueue == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        SubscriptionModuleStorage storage $ = _getModuleStorage();
        $.okuM = IOkuM(_okuM);
        $.usdc = IERC20(_usdc);
        $.redemptionQueue = RedemptionQueue(_redemptionQueue);

        // Single source of truth: cross-assert against the token rather than
        // maintaining a second independently-supplied copy. A misconfigured
        // deployment would otherwise get silently divergent pricing between
        // `convertToAssets` and this contract.
        address tokenAsset = IOkuM(_okuM).asset();
        if (tokenAsset != _usdc) revert AssetMismatch(tokenAsset, _usdc);

        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        uint256 derived = 10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));
        uint256 expected = IOkuM(_okuM).usdcDecimalMultiplier();
        if (expected != derived) revert DecimalMultiplierMismatch(expected, derived);
        $.usdcDecimalMultiplier = derived;

        // Fees ship AT THE STEP-COVERAGE FLOOR, not at zero.
        //
        // This is load-bearing, not a convenience. `OkuM.setOkuMultiplier` does
        // not read the fee schedule — coverage is guaranteed by the invariant
        // `tin, tout >= MAX_STEP_BPS` holding at all times. Shipping zero would
        // leave a window between deployment and the first `setFees` call in
        // which steps were admissible and uncovered, which is precisely the
        // arbitrage condition. There is no "inert but installed" state for this
        // mechanism, and that is the point: the protocol is accrual-ready and
        // covered from `initialize`, with no ordering an operator can get wrong.
        //
        // The earlier design shipped `(0, 0)` and relied on the token reading
        // the schedule back and failing closed. That made zero-fee deployment
        // safe but non-accruing, i.e. a launch-blocking step someone had to
        // remember. Cold can raise either leg later, never lower it below here.
        $.tin = Constants.MAX_STEP_BPS;
        $.tout = Constants.MAX_STEP_BPS;

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

    function okuM() external view returns (IOkuM) {
        return _getModuleStorage().okuM;
    }

    function usdc() external view returns (IERC20) {
        return _getModuleStorage().usdc;
    }

    function redemptionQueue() external view returns (RedemptionQueue) {
        return _getModuleStorage().redemptionQueue;
    }

    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getModuleStorage().usdcDecimalMultiplier;
    }

    function usdOkuWrapper() external view returns (USDOkuWrapper) {
        return _getModuleStorage().usdOkuWrapper;
    }

    /// @notice Wire the USDOku wrapper for `mintUsdOku` / `redeemUsdOku`.
    /// @dev `PSM_FEE_MANAGER` — the same cold key as `OkuM.setStepFeeSource`
    ///      and `USDOku.setSolvencySource` performs this class of one-time
    ///      post-deploy wiring; a dedicated role would add a key without
    ///      adding separation of duties. Fails closed until called: both
    ///      convenience functions revert `UsdOkuWrapperNotSet` at a zero
    ///      address, which is the state right after `initialize`.
    function setUsdOkuWrapper(address newWrapper) external onlyRole(Roles.PSM_FEE_MANAGER) {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        address old = address($.usdOkuWrapper);
        $.usdOkuWrapper = USDOkuWrapper(newWrapper);
        emit UsdOkuWrapperSet(old, newWrapper);
    }

    // ============ Quotes ============

    /// @notice Raw tokens `mint(usdcAmount)` would produce right now.
    /// @dev Fee-inclusive. An integrator pricing off a fee-free quote would
    ///      over-estimate output by `tin` and mis-size every downstream trade.
    function quoteMint(uint256 usdcAmount) public view returns (uint256 rawOut) {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars(MathLib.applyFee(usdcAmount, $.tin), $.usdcDecimalMultiplier),
            $.okuM.uiMultiplier()
        );
    }

    /// @notice USDC `redeem(rawAmount)` would produce right now.
    /// @dev Fee-inclusive, i.e. the amount actually received after `tout`.
    function quoteRedeem(uint256 rawAmount) public view returns (uint256 usdcOut) {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        return MathLib.applyFee(
            MathLib.dollarsToUsdc(
                MathLib.toUiAmount(rawAmount, $.okuM.uiMultiplier()), $.usdcDecimalMultiplier
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
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        return MathLib.fromUiAmount(
            MathLib.usdcToDollars($.usdc.balanceOf(address(this)), $.usdcDecimalMultiplier),
            $.okuM.uiMultiplier()
        );
    }

    /// @notice Mint fee in basis points. Read by OkuM's step-coverage check.
    function tin() external view returns (uint256) {
        return _getModuleStorage().tin;
    }

    /// @notice Redemption fee in basis points. Read by OkuM's step-coverage check.
    function tout() external view returns (uint256) {
        return _getModuleStorage().tout;
    }

    /// @notice Dollars of USDOku `mintUsdOku(usdcAmount)` would mint right now.
    /// @dev An UPPER-BOUND approximation, not exact like `quoteMint`: the real
    ///      path measures the wrapper's actual OkuM receipt, which can floor a
    ///      wei below this composed estimate. Fine for UI display; do not use
    ///      it as a slippage floor.
    function quoteMintUsdOku(uint256 usdcAmount) external view returns (uint256) {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        return $.usdOkuWrapper.quoteWrap(quoteMint(usdcAmount));
    }

    /// @notice USDC `redeemUsdOku(usdOkuAmount)` would produce right now.
    /// @dev Same approximation caveat as `quoteMintUsdOku` — the real path
    ///      settles on the dollar value of the shares actually pulled, which
    ///      the module measures by balance delta, not on the nominal input.
    function quoteRedeemUsdOku(uint256 usdOkuAmount) external view returns (uint256) {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        return quoteRedeem($.usdOkuWrapper.quoteUnwrap(usdOkuAmount));
    }

    // ============ Mint / redeem ============

    /// @notice Mint OkuM by depositing USDC.
    /// @param usdcAmount USDC to deposit, native decimals.
    /// @return rawOut Raw OkuM minted to the caller.
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused returns (uint256 rawOut) {
        return _mint(usdcAmount, msg.sender);
    }

    /// @notice Mint USDOku directly from USDC, in one transaction.
    /// @param usdcAmount USDC to deposit, native decimals.
    /// @return usdOkuOut Dollars of USDOku minted to the caller.
    /// @dev Mints OkuM to THIS contract rather than the caller, then wraps it
    ///      straight to them — no intermediate OkuM balance the caller has to
    ///      hold or approve. Priced at whatever `M_oku` the module's `mint`
    ///      leg used; the wrapper leg is then value-neutral (see
    ///      `USDOkuWrapper.wrap`).
    function mintUsdOku(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdOkuOut)
    {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        USDOkuWrapper wrapper_ = $.usdOkuWrapper;
        if (address(wrapper_) == address(0)) revert UsdOkuWrapperNotSet();

        uint256 rawOut = _mint(usdcAmount, address(this));

        IERC20 okuMToken = IERC20(address($.okuM));
        okuMToken.setExactAllowance(address(wrapper_), rawOut);
        usdOkuOut = wrapper_.wrap(rawOut, msg.sender);
        okuMToken.revokeAllowance(address(wrapper_));

        emit UsdOkuMinted(msg.sender, usdcAmount, usdOkuOut, $.okuM.uiMultiplier());
    }

    function _mint(uint256 usdcAmount, address okuMRecipient) internal returns (uint256 rawOut) {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        SubscriptionModuleStorage storage $ = _getModuleStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;
        uint256 multiplier = $.okuM.uiMultiplier();

        // Apply `tin` before conversion. The full `usdcAmount` still enters the
        // buffer; the fee portion simply has no OkuM minted against it, which
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

        // `okuMRecipient` is deliberately independent of who the USDC is pulled
        // from: `mintUsdOku` mints here-and-wraps rather than to `msg.sender`,
        // but the USDC still always comes from the caller — the event
        // attributes to `msg.sender` in both cases.
        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuM.mint(okuMRecipient, rawOut);

        emit Minted(msg.sender, usdcAmount, rawOut, multiplier);
    }

    /// @notice Redeem raw OkuM for USDC.
    /// @param rawAmount Raw OkuM to redeem (18 dp).
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
        return _redeem(msg.sender, rawAmount, true);
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
    ///      incident: a UI amount round-tripped back to raw. It only stays
    ///      benign because `fromUIAmount` floors. Flipping that direction to
    ///      Ceil — the natural "fix" for the dust — makes this revert. Pinned by
    ///      `MaxSendTest`; see the assertions there before changing any rounding
    ///      direction in `MathLib`.
    function redeemUiAmount(uint256 uiAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdcOut)
    {
        if (uiAmount == 0) revert Errors.ZeroAmount();
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        uint256 rawAmount = $.okuM.fromUIAmount(uiAmount);
        if (rawAmount == 0) revert AmountTooSmall();
        return _redeem(msg.sender, rawAmount, true);
    }

    /// @notice Redeem USDOku directly for USDC, in one transaction.
    /// @param usdOkuAmount Dollars of USDOku to redeem.
    /// @return usdcOut USDC paid, or 0 if the OkuM leg was queued.
    /// @dev THE ROUNDING HAZARD THIS FUNCTION EXISTS TO GET RIGHT: pulling
    ///      `usdOkuAmount` from the caller floors to shares independently of
    ///      whatever the wrapper's own unwrap does with the figure it is
    ///      handed next — passing the nominal `usdOkuAmount` straight through
    ///      could ask the wrapper to pull marginally more than this contract
    ///      actually holds. So this measures the SHARE DELTA of its own pull,
    ///      converts that back to the dollar value it actually received
    ///      (floored), and hands the wrapper that — provably no more than it
    ///      holds, because flooring twice can only ask for the same or fewer
    ///      shares than flooring once. At most 1 wei of USDOku dust can be left
    ///      behind in this contract; nothing user-facing rounds unfavourably.
    function redeemUsdOku(uint256 usdOkuAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdcOut)
    {
        if (usdOkuAmount == 0) revert Errors.ZeroAmount();
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        USDOkuWrapper wrapper_ = $.usdOkuWrapper;
        if (address(wrapper_) == address(0)) revert UsdOkuWrapperNotSet();

        IUSDOku usdOkuToken = wrapper_.usdOku();
        IERC20 usdOkuErc20 = IERC20(address(usdOkuToken));

        uint256 sharesBefore = usdOkuToken.sharesOf(address(this));
        usdOkuErc20.safeTransferFrom(msg.sender, address(this), usdOkuAmount);
        uint256 sharesReceived = usdOkuToken.sharesOf(address(this)) - sharesBefore;
        if (sharesReceived == 0) revert AmountTooSmall();

        uint256 effectiveUsdOku = MathLib.toUiAmount(sharesReceived, usdOkuToken.usdOkuIndex());

        usdOkuErc20.setExactAllowance(address(wrapper_), effectiveUsdOku);
        uint256 okuMOut = wrapper_.unwrap(effectiveUsdOku, address(this));
        usdOkuErc20.revokeAllowance(address(wrapper_));

        uint256 multiplier = $.okuM.uiMultiplier();
        usdcOut = _redeem(msg.sender, okuMOut, false);

        emit UsdOkuRedeemed(msg.sender, usdOkuAmount, usdcOut, multiplier);
    }

    function _redeem(
        address user,
        uint256 rawAmount,
        bool pullFromUser
    )
        internal
        returns (uint256 usdcOut)
    {
        if (rawAmount == 0) revert Errors.ZeroAmount();

        SubscriptionModuleStorage storage $ = _getModuleStorage();
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        // Reject sub-USDC-unit redemptions before any math: an input below the
        // decimal multiplier could compute a non-zero payout whose slippage
        // floor collapses to zero and trivially passes the check below.
        if (rawAmount < decimalMultiplier) revert AmountTooSmall();

        uint256 multiplier = $.okuM.uiMultiplier();
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

        IERC20 token = IERC20(address($.okuM));

        if ($.usdc.balanceOf(address(this)) >= usdcOut) {
            if (pullFromUser) token.safeTransferFrom(user, address(this), rawAmount);
            $.okuM.burn(rawAmount);
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
        //
        // `pullFromUser` false means this contract already holds `rawAmount`
        // (the `redeemUsdOku` path, paid out by the wrapper) — moved to the
        // queue with a plain `transfer`, not `transferFrom`, since there is no
        // allowance to spend against.
        if (pullFromUser) {
            token.safeTransferFrom(user, address($.redemptionQueue), rawAmount);
        } else {
            token.safeTransfer(address($.redemptionQueue), rawAmount);
        }
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
    ///      `MAX_SYNC_WINDOW`, so the worst case is a short delay — and leaving
    ///      it open would be a real hole, because the queue prices at the live
    ///      multiplier (`RedemptionQueue.processQueue` caches `uiMultiplier()`
    ///      per batch) and would therefore settle mid-propagation.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        uint256 approveAmount
    )
        external
        nonReentrant
        onlyRole(Roles.PSM_QUEUE_PROCESSOR)
    {
        SubscriptionModuleStorage storage $ = _getModuleStorage();
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
        SubscriptionModuleStorage storage $ = _getModuleStorage();
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
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        uint256 balance = $.usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBuffer(balance, amount);
        uint256 queueObligation = $.redemptionQueue.totalQueuedUsdc();
        uint256 remaining = balance - amount;
        if (remaining < queueObligation) revert WouldStrandQueue(remaining, queueObligation);
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, remaining);
    }

    /// @notice Sweep a non-USDC token out of the module.
    /// @dev The module holds no OkuM between calls by construction, but anyone
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
        SubscriptionModuleStorage storage $ = _getModuleStorage();
        if (token == address($.usdc)) revert CannotSweepAsset();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert Errors.ZeroAmount();
        emit TokenSwept(token, to, balance);
        IERC20(token).safeTransfer(to, balance);
    }

    // ============ Fees ============

    /// @notice Set the `tin` / `tout` fee schedule in basis points.
    /// @dev `PSM_FEE_MANAGER`, intended for the same cold key that holds
    ///      `OKU_CAP_MANAGER` — a fee schedule is economic policy, the same class
    ///      as `setMaxSupply`. It is a distinct, PSM-namespaced constant rather
    ///      than `OKU_CAP_MANAGER` itself because AccessControl mappings are
    ///      per-contract: no new key, but a correctly-scoped capability.
    ///
    ///      THE STEP-COVERAGE FLOOR LIVES HERE, and it is static:
    ///
    ///          MAX_STEP_BPS <= tin <= MAX_FEE_BPS
    ///          MAX_STEP_BPS <= tout <= MAX_FEE_BPS
    ///
    ///      Since `OkuM.setOkuMultiplier` independently caps a step at
    ///      `MAX_STEP_BPS`, every admissible step is covered on each leg for all
    ///      time — no state, no ratchet, no escape hatch, and nothing the token
    ///      needs to read back from this contract.
    ///
    ///      PER-LEG RATHER THAN COMBINED, and the difference matters. A
    ///      cross-chain round trip pays `tin` on the chain it mints on and
    ///      `tout` on the chain it redeems on, so a combined `tin + tout` bound
    ///      enforced separately on each chain does not bound the pair: fees of
    ///      `(0, 2x)` on one chain and `(2x, 0)` on the other each satisfy a
    ///      combined check while the cross-chain round trip pays nothing. A
    ///      per-leg floor is the only form that survives that composition.
    ///
    ///      `initialize` seeds both legs AT the floor, so the invariant holds
    ///      from deployment and this function can only ever raise them. There
    ///      is deliberately no way to reach a zero-fee state: `setOkuMultiplier`
    ///      does not read the schedule, so a zero-fee window would be an
    ///      uncovered-step window.
    ///
    ///      Fees accrue to the USDC buffer: `tin` is deposited but not credited,
    ///      `tout` is owed but not paid out. There is no recipient address and no
    ///      sweep, so a fee raises the collateral ratio rather than being
    ///      extracted.
    ///
    ///      Does NOT retroactively affect entries already in the redemption
    ///      queue — each snapshots the `tout` prevailing when it was enqueued.
    function setFees(uint256 newTin, uint256 newTout) external onlyRole(Roles.PSM_FEE_MANAGER) {
        if (newTin > Constants.MAX_FEE_BPS) {
            revert FeeAboveMaximum(newTin, Constants.MAX_FEE_BPS);
        }
        if (newTout > Constants.MAX_FEE_BPS) {
            revert FeeAboveMaximum(newTout, Constants.MAX_FEE_BPS);
        }
        if (newTin < Constants.MAX_STEP_BPS) {
            revert FeeBelowStepFloor(newTin, Constants.MAX_STEP_BPS);
        }
        if (newTout < Constants.MAX_STEP_BPS) {
            revert FeeBelowStepFloor(newTout, Constants.MAX_STEP_BPS);
        }

        SubscriptionModuleStorage storage $ = _getModuleStorage();

        uint256 oldTin = $.tin;
        uint256 oldTout = $.tout;
        $.tin = newTin;
        $.tout = newTout;

        emit FeesUpdated(oldTin, newTin, oldTout, newTout);
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
