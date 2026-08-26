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
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {Roles} from "../lib/Roles.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";
import {IUSDOku} from "../interfaces/IUSDOku.sol";

/**
 * @title USDOkuWrapper
 * @notice OkuM <-> USDOku conversion at `M_oku`, and the home of the solvency
 *         views.
 *
 * @dev **Both directions price at `M_oku`, the realized index — never at
 *      `M_usd`.** This is the load-bearing rule of the whole two-token design.
 *      `M_usd` determines how fast a USDOku *balance* grows; it never determines
 *      a conversion rate. If unwrap priced at `M_usd`, USDOku holders could
 *      extract the smoothing gap directly from the OkuM backing pool, converting
 *      a bounded accounting gap into an unbounded drain on senior holders.
 *
 *      ```
 *      wrap:    usdOku = okuM * M_oku / PRECISION
 *      unwrap:  okuM   = usdOku * PRECISION / M_oku
 *      ```
 *
 *      Consequence, stated so nobody has to derive it: a USDOku holder whose
 *      balance grew at the declared rate above realized CAN unwrap for more
 *      OkuM than they wrapped. That extraction is exactly the solvency gap, it
 *      is funded by the wrapper's OkuM buffer (donations / issuer top-ups), and
 *      it is bounded by `MAX_SOLVENCY_GAP_BPS` at the rate write. It is not a
 *      bug; it is the mechanism.
 *
 *      WRAP IS NOT SOLVENCY-GATED. A wrap adds equal liability and backing at
 *      the moment of conversion (`usdOku minted == okuM value received`), so it
 *      can only *shrink* `gapBps` — a wrap-side solvency revert would be
 *      unreachable code. The honest control is `setUsdOkuRate`'s projection
 *      check on USDOku. UNWRAP IS NEVER GATED ON SOLVENCY either: refusing to
 *      let people out of a wrapper because the wrapper is under-funded is how a
 *      slow problem becomes a panic. Unwrap fails only on `InsufficientBacking`
 *      (the buffer genuinely cannot cover it) — and that failure mode is exactly
 *      the gap being realized faster than it is funded.
 *
 *      SUNSET. USDOku is transitional: `WRAPPER_ADMIN` (cold) can disable
 *      `wrap`; there is NO code path that disables `unwrap`, deliberately.
 *
 *      SURPLUS WITHDRAWAL. `withdrawSurplus` (`WRAPPER_RESERVE_MANAGER`, cold)
 *      recovers issuer capital once realized backing exceeds declared
 *      liability — the other end of the funding mechanism above. Bounded by
 *      `surplus()`, which is `0` whenever the wrapper is at or below full
 *      backing: a withdrawal may only remove backing the protocol does not
 *      need, never spend down to `MAX_SOLVENCY_GAP_BPS`. That ceiling is what
 *      `setUsdOkuRate` may spend INTO when it opens a new gap; letting a
 *      withdrawal spend down TO it would let capital walk the gap back open
 *      from the other side.
 *
 *      Storage uses ERC-7201 namespaced storage.
 */
contract USDOkuWrapper is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.USDOkuWrapper
    struct USDOkuWrapperStorage {
        IOkuM okuM;
        IUSDOku usdOku;
        /// @dev Sunset step 1: disable wrap, leave unwrap open indefinitely.
        bool wrapEnabled;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.USDOkuWrapper")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant WRAPPER_STORAGE_LOCATION =
        0x746c0addff87be07555f8f01375a53d4c1892eca9cb88c203061f4fd00a5eb00;

    function _getWrapperStorage() private pure returns (USDOkuWrapperStorage storage $) {
        assembly {
            $.slot := WRAPPER_STORAGE_LOCATION
        }
    }

    // ============ Errors ============

    /// @notice `wrap` has been disabled (USDOku sunset step 1). Unwrap is open.
    error WrapDisabled();
    error AmountTooSmall();
    /// @notice The wrapper's OkuM buffer cannot cover this unwrap.
    error InsufficientBacking(uint256 available, uint256 required);

    /// @notice A `withdrawSurplus` request would leave `realizedBacking()`
    ///         below `declaredLiability()`.
    /// @dev The bound is deliberately stricter than "within
    ///      `MAX_SOLVENCY_GAP_BPS`": surplus withdrawal moves capital OUT, so
    ///      only genuinely EXCESS backing may leave. Widening any gap through
    ///      this path — even one still inside the bound — would let issuer
    ///      capital game the same ceiling `setUsdOkuRate` polices, from the
    ///      other side. See `surplus()`.
    error ExceedsSurplus(uint256 requested, uint256 available);

    // ============ Events ============

    event Wrapped(
        address indexed user, uint256 okuMAmount, uint256 usdOkuAmount, uint256 multiplier
    );
    event Unwrapped(
        address indexed user, uint256 usdOkuAmount, uint256 okuMAmount, uint256 multiplier
    );
    /// @notice The series to alarm on. Emitted on every wrap and unwrap.
    /// @param gapBps Signed: negative when over-backed.
    event SolvencyGapUpdated(uint256 liability, uint256 backing, int256 gapBps);
    event WrapEnabledSet(bool enabled);
    /// @notice Issuer capital withdrawn from genuinely excess backing.
    event SurplusWithdrawn(address indexed to, uint256 okuMAmount, int256 gapBpsAfter);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the wrapper proxy.
    /// @param _okuM The OkuM share token.
    /// @param _usdOku The USDOku rebasing token. This wrapper must hold
    ///        `OKU_MINTER` and `OKU_BURNER` on it (granted post-deploy).
    /// @param _admin Receives the full wrapper role set.
    function initialize(address _okuM, address _usdOku, address _admin) public initializer {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_usdOku == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        $.okuM = IOkuM(_okuM);
        $.usdOku = IUSDOku(_usdOku);
        $.wrapEnabled = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.WRAPPER_UPGRADER, _admin);
        _grantRole(Roles.WRAPPER_PAUSER, _admin);
        _grantRole(Roles.WRAPPER_UNPAUSER, _admin);
        _grantRole(Roles.WRAPPER_ADMIN, _admin);
        _grantRole(Roles.WRAPPER_RESERVE_MANAGER, _admin);
    }

    // ============ Storage accessors ============

    function okuM() external view returns (IOkuM) {
        return _getWrapperStorage().okuM;
    }

    function usdOku() external view returns (IUSDOku) {
        return _getWrapperStorage().usdOku;
    }

    function wrapEnabled() external view returns (bool) {
        return _getWrapperStorage().wrapEnabled;
    }

    // ============ Quotes ============

    /// @notice USDOku `wrap(okuMAmount)` would mint right now. Floors.
    function quoteWrap(uint256 okuMAmount) external view returns (uint256) {
        return _getWrapperStorage().okuM.toUIAmount(okuMAmount);
    }

    /// @notice OkuM `unwrap(usdOkuAmount)` would return right now. Floors.
    /// @dev Approximate to within 1 wei: the real path floors twice (share
    ///      settlement, then conversion). Never overstates by more than that.
    function quoteUnwrap(uint256 usdOkuAmount) external view returns (uint256) {
        return _getWrapperStorage().okuM.fromUIAmount(usdOkuAmount);
    }

    // ============ Wrap / unwrap ============

    /// @notice Wrap OkuM into USDOku at `M_oku`.
    /// @param okuMAmount Raw OkuM to wrap (18 dp).
    /// @return usdOkuOut Dollars of USDOku minted to the caller.
    function wrap(uint256 okuMAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdOkuOut)
    {
        return _wrap(okuMAmount, msg.sender);
    }

    /// @notice Wrap OkuM into USDOku at `M_oku`, minting to `receiver`.
    /// @param okuMAmount Raw OkuM to wrap (18 dp), pulled from the caller.
    /// @param receiver Address credited with the minted USDOku.
    /// @dev The overload that makes `SubscriptionModule.mintUsdOku` a single
    ///      transaction: the module pulls USDC, mints OkuM to itself, then
    ///      calls this with `receiver = the end user` so USDOku is minted
    ///      directly to them — no second transfer, and therefore no share
    ///      flooring on a forwarding hop.
    function wrap(
        uint256 okuMAmount,
        address receiver
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdOkuOut)
    {
        return _wrap(okuMAmount, receiver);
    }

    function _wrap(uint256 okuMAmount, address receiver) internal returns (uint256 usdOkuOut) {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        if (!$.wrapEnabled) revert WrapDisabled();

        uint256 multiplier = $.okuM.uiMultiplier();
        usdOkuOut = $.okuM.toUIAmount(okuMAmount);
        if (usdOkuOut == 0) revert AmountTooSmall();

        IERC20(address($.okuM)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        $.usdOku.mint(receiver, usdOkuOut);

        emit Wrapped(msg.sender, okuMAmount, usdOkuOut, multiplier);
        _emitSolvencyGap($);
    }

    /// @notice Unwrap USDOku back into OkuM at `M_oku`.
    /// @param usdOkuAmount Dollars of USDOku to unwrap (18 dp).
    /// @return okuMOut Raw OkuM returned to the caller.
    /// @dev Settles on the dollar value of the shares actually received (the
    ///      `transferFrom` floors the share count), then floors again into OkuM
    ///      — every rounding is against the caller, in the protocol's favour.
    ///      A max-unwrap should be computed from `sharesOf`, not `balanceOf`.
    function unwrap(uint256 usdOkuAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 okuMOut)
    {
        return _unwrap(usdOkuAmount, msg.sender);
    }

    /// @notice Unwrap USDOku pulled from the caller, paying OkuM to `receiver`.
    /// @dev The overload `SubscriptionModule.redeemUsdOku` uses: the module
    ///      first pulls USDOku from the user into itself (measuring the share
    ///      delta, since a plain `transferFrom` floors shares independently of
    ///      this contract's own flooring), then calls this with
    ///      `receiver = address(module)` so the OkuM lands where the module can
    ///      redeem it for USDC in the same transaction.
    function unwrap(
        uint256 usdOkuAmount,
        address receiver
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 okuMOut)
    {
        return _unwrap(usdOkuAmount, receiver);
    }

    function _unwrap(uint256 usdOkuAmount, address receiver) internal returns (uint256 okuMOut) {
        if (usdOkuAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();
        USDOkuWrapperStorage storage $ = _getWrapperStorage();

        uint256 sharesBefore = $.usdOku.sharesOf(address(this));
        IERC20(address($.usdOku)).safeTransferFrom(msg.sender, address(this), usdOkuAmount);
        uint256 sharesReceived = $.usdOku.sharesOf(address(this)) - sharesBefore;
        if (sharesReceived == 0) revert AmountTooSmall();

        // Dollar value actually delivered, at the index the transfer settled at.
        uint256 index = $.usdOku.usdOkuIndex();
        uint256 effectiveUsdOku =
            Math.mulDiv(sharesReceived, index, Constants.PRECISION, Math.Rounding.Floor);

        uint256 multiplier = $.okuM.uiMultiplier();
        okuMOut = $.okuM.fromUIAmount(effectiveUsdOku);
        if (okuMOut == 0) revert AmountTooSmall();

        uint256 available = $.okuM.balanceOf(address(this));
        if (available < okuMOut) revert InsufficientBacking(available, okuMOut);

        $.usdOku.burnShares(sharesReceived);
        IERC20(address($.okuM)).safeTransfer(receiver, okuMOut);

        emit Unwrapped(msg.sender, effectiveUsdOku, okuMOut, multiplier);
        _emitSolvencyGap($);
    }

    // ============ Solvency views ============

    /// @notice Total declared liability: `USDOku.totalSupply()`, in dollars.
    function declaredLiability() public view returns (uint256) {
        return _getWrapperStorage().usdOku.totalSupply();
    }

    /// @notice Realized backing: the wrapper's OkuM holding valued at `M_oku`,
    ///         in dollars.
    /// @dev Donations of OkuM to this contract count as backing, deliberately —
    ///      topping up the buffer IS the funding mechanism for the gap.
    function realizedBacking() public view returns (uint256) {
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        return $.okuM.toUIAmount($.okuM.balanceOf(address(this)));
    }

    /// @notice The solvency gap in basis points of backing. Signed: negative
    ///         when over-backed.
    /// @dev `type(int256).max` when there is liability against zero backing.
    function solvencyGapBps() public view returns (int256) {
        uint256 liability = declaredLiability();
        uint256 backing = realizedBacking();
        if (backing == 0) {
            return liability == 0 ? int256(0) : type(int256).max;
        }
        return
            (int256(liability) - int256(backing)) * int256(Constants.BASIS_POINTS) / int256(backing);
    }

    /// @notice `backing / liability` in basis points. `type(uint256).max` when
    ///         there is no liability.
    function backingRatioBps() external view returns (uint256) {
        uint256 liability = declaredLiability();
        if (liability == 0) return type(uint256).max;
        return
            Math.mulDiv(realizedBacking(), Constants.BASIS_POINTS, liability, Math.Rounding.Floor);
    }

    function _emitSolvencyGap(USDOkuWrapperStorage storage) private {
        emit SolvencyGapUpdated(declaredLiability(), realizedBacking(), solvencyGapBps());
    }

    // ============ Surplus withdrawal ============

    /// @notice OkuM withdrawable right now without dropping below full backing.
    /// @dev `0` whenever `realizedBacking() <= declaredLiability()` — including
    ///      every block in which a gap is open. Deliberately NOT
    ///      `MAX_SOLVENCY_GAP_BPS`-denominated: that bound is the ceiling
    ///      `setUsdOkuRate` polices when ADDING liability, and letting a
    ///      withdrawal spend down TO the same ceiling would let issuer capital
    ///      walk the gap back open from the other side, immediately after a
    ///      rate write legitimately opened it. Surplus is what backing exceeds
    ///      $1-for-$1, no more.
    function surplus() public view returns (uint256) {
        uint256 liability = declaredLiability();
        uint256 backing = realizedBacking();
        if (backing <= liability) return 0;
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        // Surplus in dollars, converted back to raw OkuM at the live
        // multiplier so the caller gets a directly-withdrawable amount rather
        // than a value they would have to re-derive.
        return $.okuM.fromUIAmount(backing - liability);
    }

    /// @notice Withdraw genuinely excess OkuM backing to issuer capital.
    /// @param to Recipient. Must be nonzero.
    /// @param okuMAmount Raw OkuM to withdraw.
    /// @dev THE RECOVERY PATH FOR ISSUER TOP-UPS. Realized marks eventually
    ///      overtake declared liability (that is the whole point of donating
    ///      backing to fund a gap opened by `setUsdOkuRate`), and without this
    ///      there is no code path back out — capital committed to the wrapper
    ///      would be permanently stranded once it stopped being needed.
    ///
    ///      Checked AFTER the transfer against the pre-computed `surplus()`
    ///      bound is unsafe against reentrancy into `realizedBacking()`
    ///      (an `IOkuM` implementation is not assumed hostile, but the pattern
    ///      is cheap to get right): compute the bound, transfer, done — no
    ///      second read of on-chain state that the transfer itself could have
    ///      moved. `nonReentrant` covers the token call regardless.
    ///
    ///      Sync-gated: `surplus()` is `M_oku`-priced, so it must not be read
    ///      or spent while a step is propagating.
    function withdrawSurplus(
        address to,
        uint256 okuMAmount
    )
        external
        nonReentrant
        whenNotPaused
        onlyRole(Roles.WRAPPER_RESERVE_MANAGER)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        if (okuMAmount == 0) revert Errors.ZeroAmount();

        uint256 available = surplus();
        if (okuMAmount > available) revert ExceedsSurplus(okuMAmount, available);

        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        IERC20(address($.okuM)).safeTransfer(to, okuMAmount);

        emit SurplusWithdrawn(to, okuMAmount, solvencyGapBps());
    }

    // ============ Sunset / admin ============

    /// @notice Enable or disable `wrap`. Sunset step 1 is `setWrapEnabled(false)`.
    /// @dev There is deliberately no equivalent for `unwrap` — winding down by
    ///      making redemption fail for whoever is last in line is a bank run
    ///      with a published starting gun, not a sunset.
    function setWrapEnabled(bool enabled) external onlyRole(Roles.WRAPPER_ADMIN) {
        _getWrapperStorage().wrapEnabled = enabled;
        emit WrapEnabledSet(enabled);
    }

    // ============ Pause ============

    function pause() external onlyRole(Roles.WRAPPER_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.WRAPPER_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.WRAPPER_UPGRADER) {}
}
