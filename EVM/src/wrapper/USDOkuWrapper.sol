// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";
import {IUSDOku} from "../interfaces/IUSDOku.sol";
import {IUSDOkuWrapper} from "../interfaces/IUSDOkuWrapper.sol";

/**
 * @title USDOkuWrapper
 * @notice OkuM <-> USDOku wrapper. Both directions price at `M_oku`, the
 *         realized index — NEVER at `M_usd`. Owns the on-chain solvency views.
 * @dev `wrap` deposits OkuM into the wrapper as reserves and mints USDOku shares
 *      1:1 in dollar terms — it does not touch OkuM's mint/burn surface. `unwrap`
 *      burns USDOku shares and pays out from those same OkuM reserves. The
 *      wrapper never mints or burns OkuM; it only holds it as backing.
 *
 *      If `unwrap` priced at `M_usd`, USDOku holders could extract the smoothing
 *      gap directly from OkuM's backing pool, converting a bounded accounting
 *      gap into an unbounded drain on senior (OkuM) holders. There is a
 *      differential test against a mutant that uses `M_usd`.
 *
 *      Both `wrap` and `unwrap` are permissionless, unlike `SubscriptionModule`'s
 *      reviewed conversion — USDOku's purpose is a frictionless dollar view, and
 *      gating the wrapper would defeat it. `unwrap` is NEVER gated on solvency:
 *      refusing exit because the wrapper is under-funded is how a slow problem
 *      becomes a panic. `wrap` is also NOT gated on solvency — it moves liability
 *      and backing by the identical dollar amount, so it cannot increase the
 *      gap; a solvency check on `wrap` would be dead code (see
 *      `EVM/README.md § Solvency` and `USDOku._checkSolvency`, the one live
 *      call site for `Constants.MAX_SOLVENCY_GAP_BPS`).
 *
 *      Storage uses the ERC-7201 namespaced storage pattern:
 *      https://eips.ethereum.org/EIPS/eip-7201
 */
contract USDOkuWrapper is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IUSDOkuWrapper
{
    using SafeERC20 for IERC20;

    /// @custom:storage-location erc7201:okumoney.storage.USDOkuWrapper
    struct USDOkuWrapperStorage {
        IOkuM okuM;
        IUSDOku usdOku;
        bool wrapEnabled;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.USDOkuWrapper")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant USDOKU_WRAPPER_STORAGE_LOCATION =
        0x746c0addff87be07555f8f01375a53d4c1892eca9cb88c203061f4fd00a5eb00;

    function _getWrapperStorage() private pure returns (USDOkuWrapperStorage storage $) {
        assembly {
            $.slot := USDOKU_WRAPPER_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    error AmountTooSmall();
    error InsufficientReserves(uint256 available, uint256 required);
    error WrapDisabled();
    /// @notice `withdrawSurplus` would leave backing below declared liability.
    error WouldBreachBacking(uint256 postBacking, uint256 liability);

    // ============ Events ============

    event Wrapped(
        address indexed user,
        address indexed receiver,
        uint256 okuMAmount,
        uint256 usdOkuOut,
        uint256 okuMMultiplier,
        uint256 usdMultiplier
    );
    event Unwrapped(
        address indexed user,
        address indexed receiver,
        uint256 usdOkuAmount,
        uint256 okuMOut,
        uint256 okuMMultiplier,
        uint256 usdMultiplier
    );
    event SolvencyGapUpdated(uint256 liability, uint256 backing, int256 gapBps);
    event WrapEnabledUpdated(bool enabled);
    event SurplusWithdrawn(
        address indexed to, uint256 okuMAmount, uint256 postBacking, uint256 liability
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _okuM, address _usdOku, address _admin) public initializer {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_usdOku == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();

        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        $.okuM = IOkuM(_okuM);
        $.usdOku = IUSDOku(_usdOku);
        $.wrapEnabled = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.WRAPPER_UPGRADER, _admin);
        _grantRole(Roles.WRAPPER_ADMIN, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuM() external view returns (IOkuM) {
        return _getWrapperStorage().okuM;
    }

    function usdOku() external view returns (IUSDOku) {
        return _getWrapperStorage().usdOku;
    }

    function wrapEnabled() external view returns (bool) {
        return _getWrapperStorage().wrapEnabled;
    }

    // ============ Wrap / Unwrap ============

    /// @notice Wrap OkuM into USDOku.
    /// @dev usdOkuOut = okuMAmount * M_oku / PRECISION (dollars, 1:1 as USDOku).
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minUsdOkuOut
    )
        external
        nonReentrant
        returns (uint256 usdOkuOut)
    {
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        if (!$.wrapEnabled) revert WrapDisabled();
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        IERC20 okuMToken = IERC20(address($.okuM));
        uint256 balBefore = okuMToken.balanceOf(address(this));
        okuMToken.safeTransferFrom(msg.sender, address(this), okuMAmount);
        uint256 actualReceived = okuMToken.balanceOf(address(this)) - balBefore;

        uint256 okuMMult = $.okuM.uiMultiplier();
        uint256 usdMult = $.usdOku.usdOkuIndex();

        // Dollar value of the OkuM received, then the share count that value buys.
        // The share conversion floors, so the balance actually credited can be up
        // to 1 wei below the raw dollar value — slippage MUST be checked against
        // what is credited, not against the pre-rounding quote, or a caller
        // passing an exact `minUsdOkuOut` from `quoteWrap` could be silently
        // short-changed by a wei while the check passes.
        uint256 shares = Math.mulDiv(
            MathLib.toUIAmount(actualReceived, okuMMult),
            Constants.PRECISION,
            usdMult,
            Math.Rounding.Floor
        );
        if (shares == 0) revert AmountTooSmall();

        usdOkuOut = Math.mulDiv(shares, usdMult, Constants.PRECISION, Math.Rounding.Floor);
        if (usdOkuOut < minUsdOkuOut) revert OutputBelowMinimum(usdOkuOut, minUsdOkuOut);

        $.usdOku.mint(receiver, shares);

        // Newly minted shares must ALSO be pre-funded for the remainder of the
        // live rate segment. `setUsdOkuRate` only projects the shares
        // outstanding at write time, so without this check a mid-segment wrap
        // would add shares that accrue with no backing behind them — which
        // breaks `backingCoversLiability` a fraction of a percent at a time.
        // Found by the stateful-fuzz suite, not by inspection.
        _requireProjectedBackingCovers($);

        emit Wrapped(msg.sender, receiver, actualReceived, usdOkuOut, okuMMult, usdMult);
        _emitSolvencyGap();
    }

    /// @notice Unwrap USDOku back to OkuM.
    /// @dev okuMOut = usdOkuAmount * PRECISION / M_oku, regardless of `M_usd`.
    ///      Reverts if the wrapper's OkuM reserves are insufficient — NEVER
    ///      gated on solvency otherwise; see contract NatSpec.
    function unwrap(
        uint256 usdOkuAmount,
        address receiver
    )
        external
        nonReentrant
        returns (uint256 okuMOut)
    {
        if (usdOkuAmount == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        uint256 okuMMult = $.okuM.uiMultiplier();
        uint256 usdMult = $.usdOku.usdOkuIndex();

        okuMOut = MathLib.fromUIAmount(usdOkuAmount, okuMMult);

        // Ceil to favor the wrapper on share burn — mirrors the ERC-4626 convention.
        uint256 sharesToBurn =
            Math.mulDiv(usdOkuAmount, Constants.PRECISION, usdMult, Math.Rounding.Ceil);

        IERC20 okuMToken = IERC20(address($.okuM));
        uint256 reserves = okuMToken.balanceOf(address(this));
        if (reserves < okuMOut) revert InsufficientReserves(reserves, okuMOut);

        $.usdOku.burn(msg.sender, sharesToBurn);
        okuMToken.safeTransfer(receiver, okuMOut);

        emit Unwrapped(msg.sender, receiver, usdOkuAmount, okuMOut, okuMMult, usdMult);
        _emitSolvencyGap();
    }

    /// @notice USDOku balance `wrap(okuMAmount, ...)` would credit right now.
    /// @dev Replicates {wrap}'s two-step floor exactly (dollars -> shares -> dollars)
    ///      so a caller can pass this straight back as `minUsdOkuOut` without the
    ///      share-rounding wei causing a spurious `OutputBelowMinimum`.
    function quoteWrap(uint256 okuMAmount) external view returns (uint256) {
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        uint256 usdMult = $.usdOku.usdOkuIndex();
        uint256 shares = Math.mulDiv(
            MathLib.toUIAmount(okuMAmount, $.okuM.uiMultiplier()),
            Constants.PRECISION,
            usdMult,
            Math.Rounding.Floor
        );
        return Math.mulDiv(shares, usdMult, Constants.PRECISION, Math.Rounding.Floor);
    }

    function quoteUnwrap(uint256 usdOkuAmount) external view returns (uint256) {
        return MathLib.fromUIAmount(usdOkuAmount, _getWrapperStorage().okuM.uiMultiplier());
    }

    // ============ Solvency Views ============

    /// @inheritdoc IUSDOkuWrapper
    function declaredLiability() public view returns (uint256) {
        return IERC20(address(_getWrapperStorage().usdOku)).totalSupply();
    }

    /// @inheritdoc IUSDOkuWrapper
    function realizedBacking() public view returns (uint256) {
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        uint256 reserves = IERC20(address($.okuM)).balanceOf(address(this));
        return MathLib.toUIAmount(reserves, $.okuM.uiMultiplier());
    }

    /// @inheritdoc IUSDOkuWrapper
    /// @dev Positive = liability exceeds backing (the expected steady state while
    ///      `M_usd` outruns `M_oku`). Negative = surplus. `type(int256).max` is
    ///      the sentinel for "backing is zero but liability is not".
    function solvencyGapBps() public view returns (int256) {
        uint256 liability = declaredLiability();
        uint256 backing = realizedBacking();
        if (backing == 0) {
            return liability == 0 ? int256(0) : type(int256).max;
        }
        if (liability >= backing) {
            return int256(
                Math.mulDiv(
                    liability - backing, Constants.BASIS_POINTS, backing, Math.Rounding.Floor
                )
            );
        }
        return -int256(
            Math.mulDiv(backing - liability, Constants.BASIS_POINTS, backing, Math.Rounding.Floor)
        );
    }

    /// @inheritdoc IUSDOkuWrapper
    function backingRatioBps() external view returns (uint256) {
        uint256 liability = declaredLiability();
        if (liability == 0) return Constants.BASIS_POINTS;
        return
            Math.mulDiv(realizedBacking(), Constants.BASIS_POINTS, liability, Math.Rounding.Floor);
    }

    /// @notice The core solvency invariant: realized backing covers declared liability.
    /// @dev Because `Constants.MAX_SOLVENCY_GAP_BPS == 0`, every forward rate must be
    ///      pre-funded, which makes this a MAINTAINED invariant rather than a
    ///      monitoring threshold. It is established by `USDOku.setUsdOkuRate`'s
    ///      projection to `rateEnd` and preserved by `wrap` (floors the share credit,
    ///      building a surplus) and `unwrap` (ceils the share burn, so liability falls
    ///      at least as fast as backing). Asserted in the invariant suite.
    function backingCoversLiability() public view returns (bool) {
        return realizedBacking() >= declaredLiability();
    }

    /// @notice Liability this wrapper will owe once the live rate segment ends.
    /// @dev The forward-looking counterpart to {declaredLiability}. `wrap` and
    ///      `withdrawSurplus` are both checked against this rather than against
    ///      the spot figure, because spot coverage today says nothing about
    ///      coverage at `rateEnd`.
    function projectedLiabilityAtRateEnd() public view returns (uint256) {
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        return Math.mulDiv(
            $.usdOku.totalShares(),
            $.usdOku.projectedIndexAtRateEnd(),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    /// @dev Reverts unless current backing covers the liability projected to
    ///      `rateEnd`. This is what keeps `backingCoversLiability` true for the
    ///      whole segment rather than only at the instant a rate is written.
    function _requireProjectedBackingCovers(USDOkuWrapperStorage storage $) internal view {
        uint256 backing = MathLib.toUIAmount(
            IERC20(address($.okuM)).balanceOf(address(this)), $.okuM.uiMultiplier()
        );
        uint256 projected = projectedLiabilityAtRateEnd();
        if (backing < projected) revert WouldBreachBacking(backing, projected);
    }

    function _emitSolvencyGap() internal {
        emit SolvencyGapUpdated(declaredLiability(), realizedBacking(), solvencyGapBps());
    }

    // ============ Admin (sunset) ============

    /// @notice Toggle `wrap` availability. Sunset step 1 per `EVM/README.md`.
    /// @dev No corresponding ability to disable `unwrap` — deliberate.
    function setWrapEnabled(bool enabled) external onlyRole(Roles.WRAPPER_ADMIN) {
        _getWrapperStorage().wrapEnabled = enabled;
        emit WrapEnabledUpdated(enabled);
    }

    /// @notice Recover pre-funded OkuM that is no longer needed to cover liability.
    /// @dev The counterpart to pre-funding. Because forward rates must be funded in
    ///      advance (`MAX_SOLVENCY_GAP_BPS == 0`), the issuer can end up holding more
    ///      OkuM in the wrapper than the declared liability requires — for example
    ///      after a rate is halted early, or after realized `M_oku` steps up and
    ///      covers ground the pre-funding already paid for.
    ///
    ///      Safe to expose ONLY because the invariant is real: the post-withdrawal
    ///      backing is computed and checked against liability BEFORE any transfer
    ///      (correct CEI ordering), so this can never create the shortfall that
    ///      `unwrap` would otherwise hit. It is NOT a general escape hatch — it
    ///      cannot touch backing that any USDOku holder has a claim on.
    ///
    ///      This is the one place OkuM leaves the wrapper other than `unwrap`, so it
    ///      is deliberately `WRAPPER_ADMIN` (cold) and emits for monitoring.
    function withdrawSurplus(
        uint256 okuMAmount,
        address to
    )
        external
        nonReentrant
        onlyRole(Roles.WRAPPER_ADMIN)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        if (to == address(0)) revert Errors.ZeroAddress();

        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        IERC20 okuMToken = IERC20(address($.okuM));

        uint256 reserves = okuMToken.balanceOf(address(this));
        if (reserves < okuMAmount) revert InsufficientReserves(reserves, okuMAmount);

        uint256 postBacking = MathLib.toUIAmount(reserves - okuMAmount, $.okuM.uiMultiplier());
        // Checked against the PROJECTED liability, not the spot figure: funding
        // committed to the remainder of a live rate segment is not surplus.
        uint256 liability = projectedLiabilityAtRateEnd();
        if (postBacking < liability) revert WouldBreachBacking(postBacking, liability);

        okuMToken.safeTransfer(to, okuMAmount);

        emit SurplusWithdrawn(to, okuMAmount, postBacking, liability);
        _emitSolvencyGap();
    }

    /// @notice Largest OkuM amount `withdrawSurplus` would currently permit.
    /// @dev Measured against the PROJECTED liability at `rateEnd`, so funding
    ///      still committed to a live segment is correctly excluded.
    function withdrawableSurplus() external view returns (uint256) {
        USDOkuWrapperStorage storage $ = _getWrapperStorage();
        uint256 backing = realizedBacking();
        uint256 liability = projectedLiabilityAtRateEnd();
        if (backing <= liability) return 0;
        return MathLib.fromUIAmount(backing - liability, $.okuM.uiMultiplier());
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.WRAPPER_UPGRADER) {}
}
