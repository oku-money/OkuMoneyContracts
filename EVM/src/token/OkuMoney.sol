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
import {MathLib} from "../lib/MathLib.sol";

/**
 * @title OkuMoney
 * @notice Non-rebasing base token backed by US T-Bills with rear-facing yield
 * @dev Standard ERC-20 balances (static). Yield is expressed through multiplier appreciation
 *      tracked by a stored `okuMMultiplier` written discretely by an orchestrator via
 *      `setOkuMMultiplier()` or `distributeYield()`.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMMultiplier() is a separate view function for pricing — used by PSM and vault.
 *
 *      See Constants.sol for terminology legend.
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
        // Dollar value per token multiplier (starts at 1e18 = $1.00, written by OKUM_REBASER)
        uint256 okuMMultiplier;
        // Minter allowance system (Circle pattern)
        mapping(address => uint256) minterAllowance;
        // Supply cap in token units
        uint256 maxSupply;
        // Blacklist
        mapping(address => bool) isBlacklisted;
        // Block number of last yield distribution (for sandwich attack prevention)
        uint256 lastYieldDistributionBlock;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMoney")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OKUMONEY_STORAGE_LOCATION =
        0xa46c29efb747c5ba816fcb25c64c7053e640ad72653ff106cdc2a03e8238d100;

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

    /// @notice Emitted when multiplier is updated directly via setOkuMMultiplier
    /// @param oldMultiplier Previous multiplier value
    /// @param newMultiplier New multiplier value
    /// @param totalSupply Token supply at time of update (for dollar value calculations)
    event OkuMMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply);

    /// @notice Emitted when yield is distributed via distributeYield
    /// @param yieldAmount Dollar yield distributed (18 decimals)
    /// @param oldMultiplier Previous multiplier value
    /// @param newMultiplier New multiplier value
    /// @param totalSupply Token supply at time of distribution
    event YieldDistributed(
        uint256 yieldAmount, uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply
    );
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    /// @notice Emitted alongside the standard ERC-20 Transfer with the dollar-denominated value
    /// @dev dollarValue = amount × okuMMultiplier / PRECISION
    event TransferValue(
        address indexed from, address indexed to, uint256 amount, uint256 dollarValue
    );

    // ============ Custom Errors ============

    error ZeroAddress();
    error MultiplierCannotDecrease();
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
        $.okuMMultiplier = PRECISION;
        $.maxSupply = initialMaxSupply;

        // Grant the full role set to admin at deployment. Admin is expected to
        // redistribute operational roles to other parties (multisigs, hot wallets,
        // bridge contracts) post-deploy. Doing so consistently across every contract
        // means deployment scripts never need contract-specific role plumbing.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OKUM_UPGRADER, admin);
        _grantRole(OKUM_PAUSER, admin);
        _grantRole(OKUM_UNPAUSER, admin);
        _grantRole(OKUM_MINTER, admin);
        _grantRole(OKUM_REBASER, admin);
        _grantRole(OKUM_BLACKLISTER, admin);
        _grantRole(OKUM_UNBLACKLISTER, admin);
        _grantRole(OKUM_CAP_MANAGER, admin);
        _grantRole(OKUM_ALLOWANCE_MANAGER, admin);
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

    /**
     * @notice Block number when yield was last distributed
     * @dev Used by PSM and OkuDollar to prevent sandwich attacks during yield distribution.
     *      Operations in the same block as yield distribution are blocked.
     */
    function lastYieldDistributionBlock() public view returns (uint256) {
        return _getOkuMoneyStorage().lastYieldDistributionBlock;
    }

    // ============ Multiplier Logic ============

    /**
     * @notice Stored OkuM multiplier (dollar value per token)
     * @dev Starts at 1e18 ($1.00). Written discretely by OKUM_REBASER via setOkuMMultiplier
     *      or distributeYield. Never decreases.
     *
     *      Key: balanceOf() is NOT affected by okuMMultiplier(). Multiplier appreciation is
     *      tracked separately for use by the PSM and vault.
     */
    function okuMMultiplier() public view returns (uint256) {
        return _getOkuMoneyStorage().okuMMultiplier;
    }

    /**
     * @notice Directly override the stored multiplier
     * @param newMultiplier New multiplier value (must be >= current multiplier)
     * @dev Records block.number to prevent sandwich attacks via PSM/vault operations
     */
    function setOkuMMultiplier(uint256 newMultiplier) external onlyRole(OKUM_REBASER) {
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 currentMultiplier = $.okuMMultiplier;
        if (newMultiplier < currentMultiplier) revert MultiplierCannotDecrease();
        $.lastYieldDistributionBlock = block.number;
        $.okuMMultiplier = newMultiplier;
        emit OkuMMultiplierUpdated(currentMultiplier, newMultiplier, totalSupply());
    }

    /**
     * @notice Distribute realized dollar yield across all token holders
     * @dev Increases okuMMultiplier by yieldAmount / totalSupply.
     *      yieldAmount is dollar-denominated (18 decimals).
     *      E.g., $1000 yield on 10000 tokens → +$0.10/token.
     *      Records block.number to prevent sandwich attacks via PSM/vault operations.
     * @param yieldAmount Dollar yield to distribute (18 decimals)
     */
    function distributeYield(uint256 yieldAmount) external onlyRole(OKUM_REBASER) {
        uint256 supply = totalSupply();
        if (supply == 0) revert ZeroSupply();
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        $.lastYieldDistributionBlock = block.number;
        uint256 oldMultiplier = $.okuMMultiplier;
        uint256 newMultiplier = oldMultiplier + (yieldAmount * PRECISION / supply);
        $.okuMMultiplier = newMultiplier;
        emit YieldDistributed(yieldAmount, oldMultiplier, newMultiplier, supply);
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

        uint256 dollarValue = MathLib.okuMToDollars(amount, $.okuMMultiplier);
        emit TransferValue(from, to, amount, dollarValue);
    }

    // ============ Minting & Burning ============

    /**
     * @notice Mint raw tokens to an address
     * @dev Creates raw tokens; minting 100 tokens when okuMMultiplier = $1.05 creates $105 of value.
     *      The PSM handles USDC <-> OkuM conversion using okuMMultiplier().
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
