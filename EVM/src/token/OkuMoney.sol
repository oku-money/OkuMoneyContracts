// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OkuMoneyRateSchedule} from "./OkuMoneyRateSchedule.sol";
import {
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
} from "../interfaces/IScaledUIAmount.sol";

/**
 * @title OkuMoney
 * @notice Non-rebasing base token (ticker `OkuM`) backed by US T-Bills with rear-facing yield
 * @dev The multiplier and its rate schedule live in {OkuMoneyRateSchedule}; this contract is
 *      the ERC-20 plus supply, minter-allowance (Circle FiatToken pattern), blacklist and
 *      pause controls, and the conversion half of ERC-8056. See Constants.sol for the
 *      terminology legend; storage is ERC-7201 namespaced.
 */
contract OkuMoney is
    Initializable,
    OkuMoneyRateSchedule,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoney
    struct OkuMoneyStorage {
        mapping(address => uint256) minterAllowance; // Circle FiatToken pattern
        uint256 maxSupply; // supply cap in raw token units
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMoney")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUMONEY_STORAGE_LOCATION =
        0xa46c29efb747c5ba816fcb25c64c7053e640ad72653ff106cdc2a03e8238d100;

    function _getOkuMoneyStorage() private pure returns (OkuMoneyStorage storage $) {
        assembly {
            $.slot := OKUMONEY_STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param name_ ERC-20 name
    /// @param symbol_ ERC-20 symbol (canonical ticker is `OkuM`)
    /// @param _admin Receives every role; operators redistribute post-deploy (roles are per-contract).
    /// @param initialMaxSupply Initial supply cap
    function initialize(
        string memory name_,
        string memory symbol_,
        address _admin,
        uint256 initialMaxSupply
    )
        public
        initializer
    {
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();

        __OkuMoneyRateSchedule_init();
        _getOkuMoneyStorage().maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.OKUM_UPGRADER, _admin);
        _grantRole(Roles.OKUM_PAUSER, _admin);
        _grantRole(Roles.OKUM_UNPAUSER, _admin);
        _grantRole(Roles.OKUM_MINTER, _admin);
        _grantRole(Roles.OKUM_BURNER, _admin);
        _grantRole(Roles.OKUM_REBASER, _admin);
        _grantRole(Roles.OKUM_BLACKLISTER, _admin);
        _grantRole(Roles.OKUM_UNBLACKLISTER, _admin);
        _grantRole(Roles.OKUM_CAP_MANAGER, _admin);
        _grantRole(Roles.OKUM_ALLOWANCE_MANAGER, _admin);
    }

    // ============ ERC-20 Metadata ============

    /// @notice Fixed at {Constants.OKU_M_DECIMALS} (18), the scale PSM conversion and PRECISION share.
    function decimals() public pure override returns (uint8) {
        return Constants.OKU_M_DECIMALS;
    }

    // ============ Storage Accessor Views ============

    /// @notice Remaining minter allowance for `minter_`, in raw token units.
    function minterAllowance(address minter_) external view returns (uint256) {
        return _getOkuMoneyStorage().minterAllowance[minter_];
    }

    /// @notice Global supply cap in raw token units.
    function maxSupply() external view returns (uint256) {
        return _getOkuMoneyStorage().maxSupply;
    }

    /// @notice Whether `account` is on the blacklist.
    function isBlacklisted(address account) external view returns (bool) {
        return _getOkuMoneyStorage().isBlacklisted[account];
    }

    function _supplyForOverrideEvent() internal view override returns (uint256) {
        return totalSupply();
    }

    // ============ ERC-8056: Conversion and Balances ============

    /// @inheritdoc IScaledUIAmountConversion
    function toUIAmount(uint256 rawAmount) external view returns (uint256) {
        return MathLib.okuMToDollars(rawAmount, okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountConversion
    function fromUIAmount(uint256 uiAmount) external view returns (uint256) {
        return MathLib.dollarsToOkuM(uiAmount, okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountBalances
    function balanceOfUI(address account) external view returns (uint256) {
        return MathLib.okuMToDollars(balanceOf(account), okuMMultiplier());
    }

    /// @inheritdoc IScaledUIAmountBalances
    function totalSupplyUI() external view returns (uint256) {
        return MathLib.okuMToDollars(totalSupply(), okuMMultiplier());
    }

    /// @notice ERC-165 interface detection (required by ERC-8056).
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return interfaceId == type(IScaledUIAmount).interfaceId
            || interfaceId == type(IScaledUIAmountNewUIMultiplier).interfaceId
            || interfaceId == type(IScaledUIAmountConversion).interfaceId
            || interfaceId == type(IScaledUIAmountBalances).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

    /// @dev Blocks blacklisted owners/spenders. Not pause-gated: approvals work while paused.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        public
        virtual
        override
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[owner]) revert Errors.SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert Errors.RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    /// @dev Blocks a blacklisted owner or spender from creating allowances (as Circle
    ///      FiatToken). Existing allowances are not revoked; {transferFrom} stops a
    ///      blacklisted spender from using them.
    function approve(
        address spender,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[_msgSender()]) revert Errors.SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert Errors.RecipientBlacklisted();
        return super.approve(spender, value);
    }

    /// @notice Spend an allowance to move tokens from `from` to `to`.
    /// @dev Also checks the spender, which `_update` cannot see (as Circle FiatToken).
    ///      LitePSM is a spender here, so blacklisting it would halt redemptions; same
    ///      accepted self-brick as {mint}.
    function transferFrom(
        address from,
        address to,
        uint256 value
    )
        public
        override(ERC20Upgradeable, IERC20)
        returns (bool)
    {
        if (_getOkuMoneyStorage().isBlacklisted[_msgSender()]) revert Errors.SenderBlacklisted();
        return super.transferFrom(from, to, value);
    }

    // ============ ERC20 Transfer Hook (Blacklist + Pause) ============

    /// @dev Pause blocks peer-to-peer transfers only (mint has its own gate; burn proceeds).
    ///      Blacklist applies to the non-zero side(s).
    function _update(address from, address to, uint256 amount) internal override {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if (from != address(0) && $.isBlacklisted[from]) revert Errors.SenderBlacklisted();
        if (to != address(0) && $.isBlacklisted[to]) revert Errors.RecipientBlacklisted();

        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);
        // No TransferValue event: the dollar value would cost an rpow per transfer;
        // indexers derive it from the rate schedule.
    }

    // ============ Minting & Burning ============

    /// @notice Mint raw tokens to an address.
    /// @param to Recipient of the minted tokens.
    /// @param amount Number of raw tokens to mint.
    /// @dev Also checks the minter's blacklist status (as Circle FiatToken). OKUM_MINTER is
    ///      held by LitePSM, so blacklisting it would halt minting; accepted.
    function mint(address to, uint256 amount) external onlyRole(Roles.OKUM_MINTER) whenNotPaused {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if ($.isBlacklisted[msg.sender]) revert Errors.SenderBlacklisted();
        if ($.isBlacklisted[to]) revert Errors.RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        $.minterAllowance[msg.sender] -= amount;

        _mint(to, amount);
    }

    /// @notice Burn raw tokens from the caller's balance. Allowed while paused.
    /// @param amount Number of raw tokens to burn.
    /// @dev `OKUM_BURNER` is separate from `OKUM_MINTER` so burn can be revoked independently.
    function burn(uint256 amount) external onlyRole(Roles.OKUM_BURNER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[msg.sender]) revert Errors.SenderBlacklisted();
        _burn(msg.sender, amount);
    }

    // ============ Minter Allowance Management ============

    /// @notice Set or update the minter allowance for `minter_`.
    /// @param minter_ Address whose allowance is being configured.
    /// @param newAllowance New allowance in raw token units.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: no external call precedes the emit (role check and storage writes only); false positive.
    function configureMinterAllowance(
        address minter_,
        uint256 newAllowance
    )
        external
        onlyRole(Roles.OKUM_ALLOWANCE_MANAGER)
    {
        if (minter_ == address(0)) revert Errors.ZeroAddress();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldAllowance = $.minterAllowance[minter_];
        $.minterAllowance[minter_] = newAllowance;
        emit MinterAllowanceUpdated(minter_, oldAllowance, newAllowance);
    }

    // ============ Supply Cap Management ============

    /// @notice Update the global supply cap.
    /// @param newMaxSupply New cap in raw token units (must be >= current totalSupply).
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: no external call precedes the emit (role check and storage writes only); false positive.
    function setMaxSupply(uint256 newMaxSupply) external onlyRole(Roles.OKUM_CAP_MANAGER) {
        if (newMaxSupply < totalSupply()) revert BelowCurrentSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    /// @notice Add `account` to the blacklist.
    /// @param account Address to blacklist.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: no external call precedes the emit (role check and storage writes only); false positive.
    function blacklist(address account) external onlyRole(Roles.OKUM_BLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[account]) revert Errors.AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Remove `account` from the blacklist.
    /// @param account Address to unblacklist.
    // forge-lint: disable-next-item(reentrancy-events)
    // Reason: no external call precedes the emit (role check and storage writes only); false positive.
    function unblacklist(address account) external onlyRole(Roles.OKUM_UNBLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if (!$.isBlacklisted[account]) revert Errors.NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    /// @notice Pause minting and peer-to-peer transfers. Burns, approvals, blacklist changes
    ///         and rate decreases still work.
    function pause() external onlyRole(Roles.OKUM_PAUSER) {
        _pause();
    }

    /// @notice Unpause the contract.
    function unpause() external onlyRole(Roles.OKUM_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.OKUM_UPGRADER) {}
}
