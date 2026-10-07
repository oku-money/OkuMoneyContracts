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
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OverrideBlockGuard} from "../lib/OverrideBlockGuard.sol";
import {LitePSMEvents} from "../lib/events/LitePSMEvents.sol";
import {LitePSMErrors} from "../lib/errors/LitePSMErrors.sol";

/**
 * @title LitePSM
 * @notice Multiplier-aware Peg Stability Module for USDC <-> OkuMoney/OkuDollar swaps.
 * @dev Zero-fee swap and decimal conversion factor follow MakerDAO's DssLitePsm. OkuM is
 *      minted on demand (bounded by the minter allowance) and redemptions are paid from
 *      the USDC buffer held here; a redemption the buffer cannot cover reverts with
 *      {InsufficientBuffer}.
 *
 *      Conversions are at dollar value via `okuMMultiplier()`: depositing 100 USDC at a
 *      multiplier of 1.05 mints ~95.24 OkuM, and redeeming those returns ~100 USDC.
 *      USDC peg monitoring is off-chain; operators `pause()` on a detected depeg.
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
        IOkuMoney okuMoney;
        IOkuDollar okuDollar;
        IERC20 usdc;
        // 10 ** (18 - usdc.decimals()), resolved at init. 1e12 for Circle USDC.
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
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_okuDollar == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        if (IOkuDollar(_okuDollar).asset() != _okuMoney) revert AssetMismatch();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        LitePSMStorage storage $ = _getLitePSMStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.okuDollar = IOkuDollar(_okuDollar);
        $.usdc = IERC20(_usdc);

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
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: nonReentrant; the only external calls are to the configured USDC and protocol OkuMoney/OkuDollar, and the event reports values fixed before them.
    function mintOkuM(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        (uint256 okuMAmount, uint256 okuMMult) = _quoteMint($, usdcAmount);

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(msg.sender, okuMAmount);

        emit OkuMMinted(msg.sender, usdcAmount, okuMAmount, okuMMult);
    }

    /// @notice Redeem OkuMoney for USDC from the buffer.
    /// @dev `usdcAmount = okuMAmount * okuMMultiplier / PRECISION`, scaled to USDC decimals.
    /// @param okuMAmount OkuMoney to redeem (18 decimals).
    /// @return usdcAmount USDC paid to the caller.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: nonReentrant; the only external calls are to the configured USDC and protocol OkuMoney/OkuDollar, and the event reports values fixed before them.
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

        IERC20(address($.okuMoney)).safeTransferFrom(msg.sender, address(this), okuMAmount);
        $.okuMoney.burn(okuMAmount);
        $.usdc.safeTransfer(msg.sender, usdcAmount);

        emit OkuMRedeemed(msg.sender, okuMAmount, usdcAmount, okuMMult);
    }

    // ============ OkuDollar ============

    /// @notice Mint OkuDollar by depositing USDC (USDC -> OkuM -> wrap).
    /// @dev `minAmountOut` passed to {OkuDollar.wrap} is the exact share-formula output,
    ///      guarding the wrap leg (e.g. against a fee-on-transfer OkuM).
    /// @param usdcAmount USDC to deposit (native decimals).
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: nonReentrant; the only external calls are to the configured USDC and protocol OkuMoney/OkuDollar, and the event reports values fixed before them.
    function mintUsdOku(uint256 usdcAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
    {
        LitePSMStorage storage $ = _getLitePSMStorage();
        (uint256 okuMAmount, uint256 okuMMult) = _quoteMint($, usdcAmount);
        // OkuM is minted to the PSM, so OkuMoney's own blacklist check never sees the user.
        if ($.okuMoney.isBlacklisted(msg.sender)) revert UserBlacklisted(msg.sender);

        uint256 expectedUsdMinted = MathLib.okuMToDollars(okuMAmount, okuMMult);

        $.usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        $.okuMoney.mint(address(this), okuMAmount);

        IERC20 okuMoneyToken = IERC20(address($.okuMoney));
        okuMoneyToken.forceApprove(address($.okuDollar), okuMAmount);
        uint256 usdMinted = $.okuDollar.wrap(okuMAmount, msg.sender, expectedUsdMinted);
        okuMoneyToken.forceApprove(address($.okuDollar), 0);

        emit UsdOkuMinted(msg.sender, usdcAmount, usdMinted, okuMMult);
    }

    /// @notice Redeem OkuDollar for USDC (unwrap -> burn OkuM -> pay USDC).
    /// @dev Reverts if the vault is undercollateralized (unwrap fails).
    /// @param usdAmount OkuDollar to redeem (dollar terms, 18 decimals).
    /// @return usdcOut USDC paid to the caller.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: nonReentrant; the only external calls are to the configured USDC and protocol OkuMoney/OkuDollar, and the event reports values fixed before them.
    function redeemUsdOku(uint256 usdAmount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        returns (uint256 usdcOut)
    {
        if (usdAmount == 0) revert Errors.ZeroAmount();
        LitePSMStorage storage $ = _getLitePSMStorage();
        // The OkuM leg never touches the user's OkuMoney balance, so check here.
        if ($.okuMoney.isBlacklisted(msg.sender)) revert UserBlacklisted(msg.sender);

        // Unwrap the measured balance delta, not `usdAmount`: `transferFrom` floors the
        // share conversion while `unwrap` ceils the share burn, so they can differ by
        // one share at `usdMultiplier > 1e18`.
        IERC20 okuDollarToken = IERC20(address($.okuDollar));
        uint256 balBefore = okuDollarToken.balanceOf(address(this));
        okuDollarToken.safeTransferFrom(msg.sender, address(this), usdAmount);
        uint256 received = okuDollarToken.balanceOf(address(this)) - balBefore;
        if (received == 0) revert Errors.AmountTooSmall();

        uint256 okuMAmount = $.okuDollar.unwrap(received, address(this));
        uint256 okuMMult;
        (usdcOut, okuMMult) = _quoteRedeem($, okuMAmount);

        $.okuMoney.burn(okuMAmount);
        $.usdc.safeTransfer(msg.sender, usdcOut);

        emit UsdOkuRedeemed(msg.sender, received, usdcOut, okuMMult);
    }

    // ============ Quotes ============

    function _quoteMint(
        LitePSMStorage storage $,
        uint256 usdcAmount
    )
        private
        view
        returns (uint256 okuMAmount, uint256 okuMMult)
    {
        if (usdcAmount == 0) revert Errors.ZeroAmount();
        okuMMult = $.okuMoney.okuMMultiplier();
        okuMAmount = MathLib.dollarsToOkuM(
            MathLib.usdcToDollars(usdcAmount, $.usdcDecimalMultiplier), okuMMult
        );
        if (okuMAmount == 0) revert Errors.AmountTooSmall();
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
        if (okuMAmount == 0) revert Errors.ZeroAmount();
        okuMMult = $.okuMoney.okuMMultiplier();
        usdcAmount = MathLib.dollarsToUsdc(
            MathLib.okuMToDollars(okuMAmount, okuMMult), $.usdcDecimalMultiplier
        );
        if (usdcAmount == 0) revert Errors.AmountTooSmall();
        uint256 buffer = $.usdc.balanceOf(address(this));
        if (buffer < usdcAmount) revert InsufficientBuffer(buffer, usdcAmount);
    }

    // ============ Admin ============

    /// @notice Pause minting, redeeming and buffer withdrawals.
    function pause() external onlyRole(Roles.PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PSM_UNPAUSER) {
        _unpause();
    }

    /// @notice Withdraw USDC from the buffer. No USDC leaves while paused.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: nonReentrant; the only external calls are to the configured USDC and protocol OkuMoney/OkuDollar, and the event reports values fixed before them.
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
        $.usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount, balance - amount);
    }

    /// @notice Deposit USDC into the redemption buffer.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: nonReentrant; the only external calls are to the configured USDC and protocol OkuMoney/OkuDollar, and the event reports values fixed before them.
    function depositBuffer(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        whenNoOverrideThisBlock
        onlyRole(Roles.PSM_BUFFER_DEPOSITOR)
    {
        if (amount == 0) revert Errors.ZeroAmount();
        LitePSMStorage storage $ = _getLitePSMStorage();
        $.usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount, $.usdc.balanceOf(address(this)));
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.PSM_UPGRADER) {}
}
