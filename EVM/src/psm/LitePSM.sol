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
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../interfaces/IOkuDollar.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {SharedErrors} from "../lib/errors/SharedErrors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OverrideBlockGuard} from "../lib/OverrideBlockGuard.sol";
import {LitePSMEvents} from "../lib/events/LitePSMEvents.sol";
import {LitePSMErrors} from "../lib/errors/LitePSMErrors.sol";

/**
 * @title LitePSM
 * @notice Multiplier-aware Peg Stability Module for reserve <-> OkuMoney/OkuDollar swaps.
 *         The reserve is one ERC-20 (USDC or USDT) fixed at init; `usdc` names it in code.
 * @dev Zero-fee swap and decimal conversion factor follow MakerDAO's DssLitePsm. OkuM is
 *      minted on demand (bounded by the minter allowance) and redemptions are paid from
 *      the USDC buffer held here; a redemption the buffer cannot cover reverts with
 *      {InsufficientBuffer}.
 *
 *      Conversions are at dollar value via `okuMMultiplier()`: depositing 100 USDC at a
 *      multiplier of 1.05 mints ~95.24 OkuM, and redeeming those returns ~100 USDC.
 *      Reserve peg monitoring is off-chain; operators `pause()` on a detected depeg.
 *
 *      NO SLIPPAGE PARAMETERS, BY DESIGN. `okuMMultiplier` is monotonically
 *      non-decreasing and the PSM charges no fee, so a delayed or reordered mint/redeem
 *      can only deliver equal or greater dollar value. If a fee is ever introduced,
 *      min-out parameters must land in the same change. (SVM's `redeem_oku_m` takes a
 *      `min_usdc_out` as client-side defence-in-depth.)
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    OverrideBlockGuard,
    UUPSUpgradeable,
    LitePSMEvents,
    LitePSMErrors
{
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.LitePSM
    struct LitePSMStorage {
        // Wiring, set once in `initialize` and never changed.
        IOkuMoney okuMoney;
        IOkuDollar okuDollar;
        IERC20 usdc;
        // 10 ** (18 - usdc.decimals()), resolved at init. 1e12 for a 6-decimal reserve.
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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time setup behind the proxy: wire the PSM to its tokens and give the
    ///         admin every PSM role.
    /// @param _okuMoney  The OkuMoney proxy the PSM mints and burns.
    /// @param _okuDollar The OkuDollar proxy; must wrap `_okuMoney` (checked).
    /// @param _usdc      The reserve token (USDC or USDT); at most 18 decimals (checked).
    /// @param _admin Receives the full PSM role set; see {OkuMoney.initialize}.
    function initialize(
        address _okuMoney,
        address _okuDollar,
        address _usdc,
        address _admin
    )
        public
        initializer
    {
        if (_okuMoney == address(0)) revert SharedErrors.ZeroAddress();
        if (_okuDollar == address(0)) revert SharedErrors.ZeroAddress();
        if (_usdc == address(0)) revert SharedErrors.ZeroAddress();
        if (_admin == address(0)) revert SharedErrors.ZeroAddress();
        // OkuDollar must wrap this OkuMoney, or every UsdOku path would price against a
        // different multiplier than the one it mints with.
        if (IOkuDollar(_okuDollar).asset() != _okuMoney) revert AssetMismatch();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuDollar = IOkuDollar(_okuDollar);
        $.usdc = IERC20(_usdc);

        // Scale factor from USDC units to 18-decimal dollars, computed once
        // (10**12 for 6-decimal USDC).
        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier = 10 ** (uint256(Constants.OKU_M_DECIMALS) - uint256(usdcDecimals));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.PSM_UPGRADER, _admin);
        _grantRole(Roles.PSM_PAUSER, _admin);
        _grantRole(Roles.PSM_UNPAUSER, _admin);
        _grantRole(Roles.PSM_BUFFER_DEPOSITOR, _admin);
        _grantRole(Roles.PSM_BUFFER_WITHDRAWER, _admin);
    }

    // ============ Views ============

    function okuMoney() external view returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    function okuDollar() external view returns (IOkuDollar) {
        return _getLitePSMStorage().okuDollar;
    }

    function usdc() external view returns (IERC20) {
        return _getLitePSMStorage().usdc;
    }

    /// @notice Multiplier such that `usdcAmount * multiplier` is an 18-decimal dollar value.
    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getLitePSMStorage().usdcDecimalMultiplier;
    }

    /// @inheritdoc OverrideBlockGuard
    function _overrideBlockOkuMoney() internal view override returns (IOkuMoney) {
        return _getLitePSMStorage().okuMoney;
    }

    // ============ OkuMoney ============

    /// @notice Mint OkuMoney by depositing USDC.
    /// @dev `okuMAmount = usdcValue18 * PRECISION / okuMMultiplier`, floored (the caller
    ///      forfeits at most one raw OkuM unit).
    /// @param usdcAmount USDC to deposit (native decimals).
    function mintOkuM(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
    {
        LitePSMStorage storage $ = _getLitePSMStorage();

        // Take the reserve, then mint to the caller against what arrived. No explicit
        // blacklist check here: `OkuMoney.mint` rejects a blacklisted recipient itself.
        uint256 received = _pullReserve($, usdcAmount);
        (uint256 okuMAmount, uint256 okuMMult) = _quoteMint($, received);
        $.okuMoney.mint(msg.sender, okuMAmount);

        emit OkuMMinted(msg.sender, received, okuMAmount, okuMMult);
    }

    /// @notice Redeem OkuMoney for USDC from the buffer.
    /// @dev `usdcAmount = okuMAmount * okuMMultiplier / PRECISION`, scaled to USDC decimals.
    /// @param okuMAmount OkuMoney to redeem (18 decimals).
    /// @return usdcAmount USDC paid to the caller.
    function redeemOkuM(uint256 okuMAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256 usdcAmount)
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        if ($.okuMoney.isBlacklisted(msg.sender)) revert UserBlacklisted(msg.sender);
        uint256 okuMMult;
        (usdcAmount, okuMMult) = _quoteRedeem($, okuMAmount);

        // Pull the OkuM into the PSM, burn it, then pay out USDC from the buffer.
        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        $.okuMoney.burn(okuMAmount);
        $.usdc.safeTransfer(msg.sender, usdcAmount);

        emit OkuMRedeemed(msg.sender, okuMAmount, usdcAmount, okuMMult);
    }

    // ============ OkuDollar ============

    /// @notice Mint OkuDollar by depositing USDC (USDC -> OkuM -> wrap).
    /// @dev Passes the exact expected output as {OkuDollar.wrap}'s `minAmountOut`.
    /// @param usdcAmount USDC to deposit (native decimals).
    function mintUsdOku(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        // `OkuDollar.wrap` would also reject the user; this fails first, clearly.
        if ($.okuMoney.isBlacklisted(msg.sender)) revert UserBlacklisted(msg.sender);

        uint256 received = _pullReserve($, usdcAmount);
        (uint256 okuMAmount, uint256 okuMMult) = _quoteMint($, received);
        uint256 expectedUsdMinted = MathLib.okuMToDollars(okuMAmount, okuMMult);

        $.okuMoney.mint(address(this), okuMAmount);

        // Wrap the freshly minted OkuM for the user: approve exactly this amount, wrap
        // (with `expectedUsdMinted` as the minimum out), then clear the approval so no
        // standing allowance is left on the PSM. `forceApprove` handles tokens that
        // reject changing a non-zero allowance.
        IERC20 okuMoneyToken = IERC20(address($.okuMoney));
        okuMoneyToken.forceApprove(address($.okuDollar), okuMAmount);
        uint256 usdMinted = $.okuDollar.wrap(okuMAmount, msg.sender, expectedUsdMinted);
        okuMoneyToken.forceApprove(address($.okuDollar), 0);

        emit UsdOkuMinted(msg.sender, received, usdMinted, okuMMult);
    }

    /// @notice Redeem OkuDollar for USDC (unwrap -> burn OkuM -> pay USDC).
    /// @dev Reverts if the vault is undercollateralized (unwrap fails).
    /// @param usdAmount OkuDollar to redeem (dollar terms, 18 decimals).
    /// @return usdcOut USDC paid to the caller.
    function redeemUsdOku(uint256 usdAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256 usdcOut)
    {
        if (usdAmount == 0) revert SharedErrors.ZeroAmount();
        LitePSMStorage storage $ = _getLitePSMStorage();
        // `OkuDollar.transferFrom` would also reject the user; this fails first, clearly.
        if ($.okuMoney.isBlacklisted(msg.sender)) revert UserBlacklisted(msg.sender);

        // Unwrap the measured balance delta, not `usdAmount`: `transferFrom` floors the
        // share conversion while `unwrap` ceils the share burn, so they can differ by
        // one share at `usdMultiplier > 1e18`.
        IERC20 okuDollarToken = IERC20(address($.okuDollar));
        uint256 balBefore = okuDollarToken.balanceOf(address(this));
        okuDollarToken.safeTransferFrom(msg.sender, address(this), usdAmount);
        uint256 received = okuDollarToken.balanceOf(address(this)) - balBefore;
        if (received == 0) revert SharedErrors.AmountTooSmall();

        uint256 okuMAmount = $.okuDollar.unwrap(received, address(this));
        uint256 okuMMult;
        (usdcOut, okuMMult) = _quoteRedeem($, okuMAmount);

        $.okuMoney.burn(okuMAmount);
        $.usdc.safeTransfer(msg.sender, usdcOut);

        emit UsdOkuRedeemed(msg.sender, received, usdcOut, okuMMult);
    }

    // ============ Reserve Intake ============

    /// @dev Pulls `amount` of the reserve from the caller and returns the balance delta,
    ///      so a fee-on-transfer reserve (e.g. USDT with its fee enabled) cannot
    ///      under-back a mint or overstate a deposit.
    function _pullReserve(
        LitePSMStorage storage $,
        uint256 amount
    )
        private
        returns (uint256 received)
    {
        if (amount == 0) revert SharedErrors.ZeroAmount();
        uint256 balBefore = $.usdc.balanceOf(address(this));
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        received = $.usdc.balanceOf(address(this)) - balBefore;
        if (received == 0) revert SharedErrors.AmountTooSmall();
    }

    // ============ Quotes ============

    /// @dev OkuM owed for `usdcAmount` of reserve at the current multiplier, rounded
    ///      down: reserve -> 18-decimal dollars -> OkuM. Reverts on a zero input or a
    ///      zero result (so reserve is never taken for nothing).
    function _quoteMint(
        LitePSMStorage storage $,
        uint256 usdcAmount
    )
        private
        view
        returns (uint256 okuMAmount, uint256 okuMMult)
    {
        if (usdcAmount == 0) revert SharedErrors.ZeroAmount();
        okuMMult = $.okuMoney.okuMMultiplier();
        okuMAmount = MathLib.dollarsToOkuM(
            MathLib.usdcToDollars(usdcAmount, $.usdcDecimalMultiplier), okuMMult
        );
        if (okuMAmount == 0) revert SharedErrors.AmountTooSmall();
    }

    /// @dev Reverts if the output rounds to zero or exceeds the buffer.
    function _quoteRedeem(
        LitePSMStorage storage $,
        uint256 okuMAmount
    )
        private
        view
        returns (uint256 usdcAmount, uint256 okuMMult)
    {
        if (okuMAmount == 0) revert SharedErrors.ZeroAmount();
        okuMMult = $.okuMoney.okuMMultiplier();
        usdcAmount = MathLib.dollarsToUsdc(
            MathLib.okuMToDollars(okuMAmount, okuMMult), $.usdcDecimalMultiplier
        );
        if (usdcAmount == 0) revert SharedErrors.AmountTooSmall();
        uint256 buffer = $.usdc.balanceOf(address(this));
        if (buffer < usdcAmount) revert InsufficientBuffer(buffer, usdcAmount);
    }

    // ============ Admin ============

    /// @notice Pause every user path (mint and redeem, OkuM and UsdOku) and both buffer
    ///         moves.
    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    /// @notice Resume the paths `pause` stopped.
    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    /// @notice Withdraw USDC from the buffer. No USDC leaves while paused.
    /// @dev Trusted role: checked only against the buffer balance, not against
    ///      outstanding OkuM. Not `nonReentrant`: it makes a single transfer of the
    ///      configured USDC as its last step.
    /// @param to     Recipient of the USDC.
    /// @param amount USDC to send (native decimals).
    function withdrawUsdc(
        address to,
        uint256 amount
    )
        external
        whenNotPaused
        whenNoOverrideThisBlock
        onlyRole(Roles.PSM_BUFFER_WITHDRAWER)
    {
        if (to == address(0)) revert SharedErrors.ZeroAddress();
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 balance = $.usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBuffer(balance, amount);
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, balance - amount);
    }

    /// @notice Deposit USDC into the redemption buffer.
    /// @param amount USDC to pull from the caller (native decimals); needs prior approval.
    function depositBuffer(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        onlyRole(Roles.PSM_BUFFER_DEPOSITOR)
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        uint256 received = _pullReserve($, amount);
        emit BufferDeposited(msg.sender, received, $.usdc.balanceOf(address(this)));
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.PSM_UPGRADER) {}
}
