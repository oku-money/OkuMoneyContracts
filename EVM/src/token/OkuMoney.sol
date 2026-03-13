// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";

/**
 * @title OkuMoney
 * @notice Non-rebasing base token backed by US T-Bills with rear-facing yield
 * @dev Standard ERC-20 balances (static). Yield is expressed through price appreciation
 *      tracked by a stored `okuMPrice` written discretely by an orchestrator via
 *      `setOkuMPrice()` or `distributeYield()`.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMPrice() is a separate view function for pricing — used by PSM and vault.
 *
 *      Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract OkuMoney is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoney
    struct OkuMoneyStorage {
        // Stored price ratio (starts at 1e18 = $1.00, written by OKUM_REBASER)
        uint256 okuMPrice;
        // Minter allowance system (Circle pattern)
        mapping(address => uint256) minterAllowance;
        // Supply cap in token units
        uint256 maxSupply;
        // Blacklist
        mapping(address => bool) isBlacklisted;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMoney")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUMONEY_STORAGE_LOCATION =
        0x7b4f5e3a1c8d9f0a2b3e4c5d6a7f8e9d0c1b2a3e4f5d6c7b8a9e0f1d2c3b4a00;

    function _getOkuMoneyStorage() private pure returns (OkuMoneyStorage storage $) {
        assembly {
            $.slot := OKUMONEY_STORAGE_LOCATION
        }
    }

    // ============ Role Constants (from shared library) ============

    bytes32 public constant OKUM_UPGRADER = Roles.OKUM_UPGRADER;
    bytes32 public constant OKUM_PAUSER = Roles.OKUM_PAUSER;
    bytes32 public constant OKUM_UNPAUSER = Roles.OKUM_UNPAUSER;
    bytes32 public constant OKUM_MINTER = Roles.OKUM_MINTER;
    bytes32 public constant OKUM_REBASER = Roles.OKUM_REBASER;
    bytes32 public constant OKUM_BLACKLISTER = Roles.OKUM_BLACKLISTER;
    bytes32 public constant OKUM_UNBLACKLISTER = Roles.OKUM_UNBLACKLISTER;
    bytes32 public constant OKUM_CAP_MANAGER = Roles.OKUM_CAP_MANAGER;
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = Roles.OKUM_ALLOWANCE_MANAGER;

    // ============ Constants (from shared library) ============

    uint256 public constant PRECISION = Constants.PRECISION;

    // ============ Events ============

    event OkuMPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event YieldDistributed(uint256 yieldAmount, uint256 oldPrice, uint256 newPrice);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    /// @notice Emitted alongside the standard ERC-20 Transfer with the dollar-denominated value
    /// @dev dollarValue = amount × okuMPrice / PRECISION
    event TransferValue(address indexed from, address indexed to, uint256 amount, uint256 dollarValue);

    // ============ Custom Errors ============

    error ZeroAddress();
    error PriceCannotDecrease();
    error ZeroSupply();
    error ExceedsSupplyCap();
    error BelowCurrentSupply();
    error ExceedsAllowance();
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        address admin,
        uint256 initialMaxSupply
    )
        public
        initializer
    {
        if (admin == address(0)) revert ZeroAddress();

        __ERC20_init(name, symbol);
        __ERC20Permit_init(name);
        __AccessControl_init();
        __Pausable_init();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        $.okuMPrice = PRECISION;
        $.maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OKUM_UPGRADER, admin);
        _grantRole(OKUM_PAUSER, admin);
    }

    // ============ Storage Accessor Views ============

    function minterAllowance(address minter_) public view returns (uint256) {
        return _getOkuMoneyStorage().minterAllowance[minter_];
    }

    function maxSupply() public view returns (uint256) {
        return _getOkuMoneyStorage().maxSupply;
    }

    function isBlacklisted(address account) public view returns (bool) {
        return _getOkuMoneyStorage().isBlacklisted[account];
    }

    // ============ Price Logic ============

    /**
     * @notice Stored OkuM price ratio
     * @dev Starts at 1e18 ($1.00). Written discretely by OKUM_REBASER via setOkuMPrice
     *      or distributeYield. Never decreases.
     *
     *      Key: balanceOf() is NOT affected by okuMPrice(). Price appreciation is
     *      tracked separately for use by the PSM and vault.
     */
    function okuMPrice() public view returns (uint256) {
        return _getOkuMoneyStorage().okuMPrice;
    }

    /**
     * @notice Directly override the stored price ratio
     * @param newPrice New price value (must be >= current price)
     */
    function setOkuMPrice(uint256 newPrice) external onlyRole(OKUM_REBASER) {
        uint256 currentPrice = _getOkuMoneyStorage().okuMPrice;
        if (newPrice < currentPrice) revert PriceCannotDecrease();
        _getOkuMoneyStorage().okuMPrice = newPrice;
        emit OkuMPriceUpdated(currentPrice, newPrice);
    }

    /**
     * @notice Distribute realized dollar yield across all token holders
     * @dev Increases okuMPrice by yieldAmount / totalSupply.
     *      yieldAmount is dollar-denominated (18 decimals).
     *      E.g., $1000 yield on 10000 tokens → +$0.10/token.
     * @param yieldAmount Dollar yield to distribute (18 decimals)
     */
    function distributeYield(uint256 yieldAmount) external onlyRole(OKUM_REBASER) {
        uint256 supply = totalSupply();
        if (supply == 0) revert ZeroSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldPrice = $.okuMPrice;
        uint256 newPrice = oldPrice + (yieldAmount * PRECISION / supply);
        $.okuMPrice = newPrice;
        emit YieldDistributed(yieldAmount, oldPrice, newPrice);
    }

    // ============ ERC20Permit Override (Blacklist Check) ============

    /**
     * @dev Override permit to check blacklist status of owner and spender
     *      Prevents blacklisted users from pre-signing permits before being blacklisted
     *      Note: Intentionally does NOT check pause state — approvals are allowed while paused
     */
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
        if ($.isBlacklisted[owner]) revert SenderBlacklisted();
        if ($.isBlacklisted[spender]) revert RecipientBlacklisted();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    // ============ ERC20 Transfer Hook (Blacklist + Pause) ============

    /**
     * @dev Override _update to enforce blacklist and pause checks on all transfers.
     *      Mint (from == address(0)): blacklist checked on recipient only.
     *      Burn (to == address(0)): no pause check — burn works while paused.
     *      Transfer: blocked when paused, blocked if either party is blacklisted.
     */
    function _update(address from, address to, uint256 amount) internal override {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        // Blacklist checks (skip for mint/burn zero-address side)
        if (from != address(0)) {
            if ($.isBlacklisted[from]) revert SenderBlacklisted();
        }
        if (to != address(0)) {
            if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        }

        // Pause check: block peer-to-peer transfers when paused.
        // Mint has its own whenNotPaused modifier. Burn is always allowed.
        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);

        uint256 dollarValue = (amount * $.okuMPrice) / PRECISION;
        emit TransferValue(from, to, amount, dollarValue);
    }

    // ============ Minting & Burning ============

    /**
     * @notice Mint raw tokens to an address
     * @dev Creates raw tokens; minting 100 tokens when okuMPrice = $1.05 creates $105 of value.
     *      The PSM handles USDC <-> OkuM conversion using okuMPrice().
     */
    function mint(address to, uint256 amount) external onlyRole(OKUM_MINTER) whenNotPaused {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        if ($.isBlacklisted[to]) revert RecipientBlacklisted();
        if (totalSupply() + amount > $.maxSupply) revert ExceedsSupplyCap();
        if ($.minterAllowance[msg.sender] < amount) revert ExceedsAllowance();

        unchecked {
            $.minterAllowance[msg.sender] -= amount;
        }

        _mint(to, amount);
    }

    /**
     * @notice Burn raw tokens from caller
     * @dev No whenNotPaused — burn works while paused.
     */
    function burn(uint256 amount) external onlyRole(OKUM_MINTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[msg.sender]) revert SenderBlacklisted();
        _burn(msg.sender, amount);
    }

    // ============ Minter Allowance Management ============

    function configureMinterAllowance(
        address minter_,
        uint256 allowance
    )
        external
        onlyRole(OKUM_ALLOWANCE_MANAGER)
    {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldAllowance = $.minterAllowance[minter_];
        $.minterAllowance[minter_] = allowance;
        emit MinterAllowanceUpdated(minter_, oldAllowance, allowance);
    }

    // ============ Supply Cap Management ============

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(OKUM_CAP_MANAGER) {
        if (newMaxSupply < totalSupply()) revert BelowCurrentSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 oldMaxSupply = $.maxSupply;
        $.maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(OKUM_BLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.isBlacklisted[account]) revert AlreadyBlacklisted();
        $.isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(OKUM_UNBLACKLISTER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if (!$.isBlacklisted[account]) revert NotBlacklisted();
        $.isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(OKUM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(OKUM_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(OKUM_UPGRADER)
    {}
}
