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
import {IOkuM} from "../interfaces/IOkuM.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";

/**
 * @title LitePSM
 * @notice Bounded, permissionless USDC <-> OkuM conversion at `M_oku`.
 *
 * @dev ## What this is, and what it is not
 *
 *      This is a CONVENIENCE window, not the redemption path. It offers a deliberately
 *      small amount of on-chain liquidity — order $100k per chain — so that
 *      integrations have a real exit and the price is observable on-chain. Anything
 *      larger goes through the off-chain path.
 *
 *      Sized that way, the USDC buffer IS the security bound: the worst case from any
 *      pricing error or key compromise is the buffer, per chain. Redemption simply
 *      reverts when the buffer is exhausted. There is no queue — an exhausted window
 *      is instant-or-nothing.
 *
 *      Deleting the queue removes FIFO fairness, stranded users, and a specific flaw
 *      in the predecessor design where pausing to stop an outflow ALSO froze payouts
 *      to everyone already queued. That is why `pause()` here does not gate anything a
 *      user needs in order to get out of a pending state: there are no pending states.
 *
 *      ## No fees, and why none are needed
 *
 *      A fee floor exists in PSM designs to make a round-trip across a multiplier STEP
 *      unprofitable. `M_oku` accrues continuously, so a round-trip earns exactly the
 *      elapsed-time yield and nothing more — which is what a legitimate holder earns.
 *      With the arbitrage gone, the fee has nothing left to defend and is omitted.
 *
 *      ## Two independent gates
 *
 *      `mintEnabled` / `redeemEnabled` (PSM_GATEKEEPER) are the KMS back-end's routine
 *      levers, deliberately separate from `pause()` (PSM_PAUSER, an incident
 *      response). `OkuM.setOkuMRate` does NOT require this window closed: a routine
 *      declaration moves slope, not level, so there is nothing for an open window to
 *      expose. The only level-moving case (a re-anchor) is bounded on OkuM's side by
 *      `MAX_REANCHOR_BPS` and forced to take effect immediately rather than land
 *      unattended — see {IOkuM.setOkuMRate}. `mintEnabled`/`redeemEnabled` remain
 *      available for market-hours policy, but are no longer load-bearing for that.
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.LitePSM
    struct LitePSMStorage {
        IOkuM okuM;
        IERC20 usdc;
        /// @dev 10 ** (18 - usdcDecimals). Resolved at init from the token itself.
        uint256 usdcDecimalMultiplier;
        bool mintEnabled;
        bool redeemEnabled;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.LitePSM")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LITEPSM_STORAGE_LOCATION =
        0x3513f3377f3ae2495699e5bd066d9c7b1ec04346bbec81953fcd75e4450d9100;

    function _getLitePSMStorage() private pure returns (LitePSMStorage storage $) {
        assembly {
            $.slot := LITEPSM_STORAGE_LOCATION
        }
    }

    // ============ Events ============

    event OkuMMinted(address indexed user, uint256 usdcIn, uint256 okuMOut, uint256 multiplier);
    event OkuMRedeemed(address indexed user, uint256 okuMIn, uint256 usdcOut, uint256 multiplier);
    event BufferDeposited(address indexed from, uint256 amount, uint256 newBalance);
    event BufferWithdrawn(address indexed to, uint256 amount, uint256 newBalance);
    event MintEnabledSet(bool enabled);
    event RedeemEnabledSet(bool enabled);

    // ============ Errors ============

    error AmountTooSmall();
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    /// @dev The permissionless window cannot cover this redemption. Not a failure
    ///      state — the window is bounded on purpose. Use the off-chain path.
    error InsufficientBuffer(uint256 available, uint256 required);
    error MintDisabled();
    error RedeemDisabled();
    error UsdcDecimalsTooLarge(uint8 reported);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _okuM, address _usdc, address _admin) public initializer {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuM = IOkuM(_okuM);
        $.usdc = IERC20(_usdc);

        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));

        // Both windows start CLOSED. The rate setter requires a closed window, so a
        // fresh deployment can publish its first segment before ever opening.
        $.mintEnabled = false;
        $.redeemEnabled = false;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.PSM_UPGRADER, _admin);
        _grantRole(Roles.PSM_PAUSER, _admin);
        _grantRole(Roles.PSM_UNPAUSER, _admin);
        _grantRole(Roles.PSM_GATEKEEPER, _admin);
        _grantRole(Roles.PSM_BUFFER_DEPOSITOR, _admin);
        _grantRole(Roles.PSM_BUFFER_WITHDRAWER, _admin);
    }

    // ============ Views ============

    function okuM() external view returns (IOkuM) {
        return _getLitePSMStorage().okuM;
    }

    function usdc() external view returns (IERC20) {
        return _getLitePSMStorage().usdc;
    }

    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getLitePSMStorage().usdcDecimalMultiplier;
    }

    function mintEnabled() external view returns (bool) {
        return _getLitePSMStorage().mintEnabled;
    }

    function redeemEnabled() external view returns (bool) {
        return _getLitePSMStorage().redeemEnabled;
    }

    /// @notice Whether ANY permissionless conversion can currently execute.
    /// @dev Read by `OkuM.setOkuMRate`, which refuses to publish while this is true.
    ///      Deliberately includes the pause state: a paused PSM is a closed window.
    function conversionsOpen() external view returns (bool) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return !paused() && ($.mintEnabled || $.redeemEnabled);
    }

    /// @notice USDC currently redeemable through the permissionless window.
    /// @dev Integrators should read this BEFORE submitting a redemption. It is the
    ///      whole bound on this contract's exposure.
    function availableToRedeem() public view returns (uint256) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        if (paused() || !$.redeemEnabled) return 0;
        return $.usdc.balanceOf(address(this));
    }

    /// @notice OkuM a given USDC amount would mint, at the current `M_oku`.
    function quoteMint(uint256 usdcAmount) external view returns (uint256) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.fromUIAmount(
            MathLib.usdcToDollars(usdcAmount, $.usdcDecimalMultiplier), $.okuM.uiMultiplier()
        );
    }

    /// @notice USDC a given OkuM amount would redeem for, at the current `M_oku`.
    function quoteRedeem(uint256 okuMAmount) external view returns (uint256) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        return MathLib.dollarsToUsdc(
            MathLib.toUIAmount(okuMAmount, $.okuM.uiMultiplier()), $.usdcDecimalMultiplier
        );
    }

    // ============ Permissionless conversion ============

    /// @notice USDC -> OkuM at the live `M_oku`.
    /// @param usdcAmount USDC in, native decimals.
    /// @param minOkuMOut Slippage floor, raw OkuM.
    function mintOkuM(
        uint256 usdcAmount,
        uint256 minOkuMOut
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 okuMOut)
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        if (!$.mintEnabled) revert MintDisabled();

        uint256 multiplier = $.okuM.uiMultiplier();
        uint256 dollars = MathLib.usdcToDollars(usdcAmount, $.usdcDecimalMultiplier);
        okuMOut = MathLib.fromUIAmount(dollars, multiplier);
        if (okuMOut == 0) revert AmountTooSmall();
        if (okuMOut < minOkuMOut) revert OutputBelowMinimum(okuMOut, minOkuMOut);

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuM.mint(msg.sender, okuMOut);

        emit OkuMMinted(msg.sender, usdcAmount, okuMOut, multiplier);
    }

    /// @notice OkuM -> USDC at the live `M_oku`, bounded by the buffer.
    /// @dev Reverts rather than queueing when the buffer cannot cover the amount.
    ///      That is the design, not a degraded mode.
    /// @param okuMAmount Raw OkuM in.
    /// @param minUsdcOut Slippage floor, USDC native decimals.
    function redeemOkuM(
        uint256 okuMAmount,
        uint256 minUsdcOut
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdcOut)
    {
        if (okuMAmount == 0) revert Errors.ZeroAmount();

        LitePSMStorage storage $ = _getLitePSMStorage();
        if (!$.redeemEnabled) revert RedeemDisabled();

        uint256 multiplier = $.okuM.uiMultiplier();
        uint256 dollars = MathLib.toUIAmount(okuMAmount, multiplier);
        usdcOut = MathLib.dollarsToUsdc(dollars, $.usdcDecimalMultiplier);
        if (usdcOut == 0) revert AmountTooSmall();
        if (usdcOut < minUsdcOut) revert OutputBelowMinimum(usdcOut, minUsdcOut);

        uint256 buffer = $.usdc.balanceOf(address(this));
        if (buffer < usdcOut) revert InsufficientBuffer(buffer, usdcOut);

        // Pull, burn, pay. The PSM burns from its own balance, so OkuM must arrive
        // here first — `OKUM_BURNER` only ever burns the caller's own tokens.
        IERC20(address($.okuM)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        $.okuM.burn(okuMAmount);
        $.usdc.safeTransfer(msg.sender, usdcOut);

        emit OkuMRedeemed(msg.sender, okuMAmount, usdcOut, multiplier);
    }

    // ============ Window control (KMS) ============

    function setMintEnabled(bool enabled) external onlyRole(Roles.PSM_GATEKEEPER) {
        _getLitePSMStorage().mintEnabled = enabled;
        emit MintEnabledSet(enabled);
    }

    function setRedeemEnabled(bool enabled) external onlyRole(Roles.PSM_GATEKEEPER) {
        _getLitePSMStorage().redeemEnabled = enabled;
        emit RedeemEnabledSet(enabled);
    }

    /// @notice Close both windows in one transaction.
    /// @dev The normal precondition for publishing a rate.
    function closeWindow() external onlyRole(Roles.PSM_GATEKEEPER) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.mintEnabled = false;
        $.redeemEnabled = false;
        emit MintEnabledSet(false);
        emit RedeemEnabledSet(false);
    }

    /// @notice Open both windows in one transaction.
    function openWindow() external onlyRole(Roles.PSM_GATEKEEPER) {
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.mintEnabled = true;
        $.redeemEnabled = true;
        emit MintEnabledSet(true);
        emit RedeemEnabledSet(true);
    }

    // ============ Buffer ============

    /// @notice Top up the redemption buffer. Permissionless — funding only helps.
    function depositBuffer(uint256 amount) external nonReentrant {
        if (amount == 0) revert Errors.ZeroAmount();
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount, $.usdc.balanceOf(address(this)));
    }

    /// @notice Withdraw from the buffer.
    /// @dev NOT pause-gated by design: during an incident the buffer withdrawer may
    ///      need to move USDC to safety precisely while the PSM is paused. There is no
    ///      queue obligation to strand, so unlike the predecessor design this cannot
    ///      leave a user unpayable.
    function withdrawBuffer(
        address to,
        uint256 amount
    )
        external
        nonReentrant
        onlyRole(Roles.PSM_BUFFER_WITHDRAWER)
    {
        if (to == address(0)) revert Errors.ZeroAddress();
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 balance = $.usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBuffer(balance, amount);
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, balance - amount);
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
