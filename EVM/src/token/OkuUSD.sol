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

/**
 * @title OkuUSD
 * @notice Rebasing yield-bearing stablecoin backed 1:1 by US T-Bills
 * @dev Implements share-based storage where balanceOf = shares * rewardMultiplier
 */
contract OkuUSD is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // Granular RBAC roles
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    bytes32 public constant REBASER_ROLE = keccak256("REBASER_ROLE");
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");
    bytes32 public constant UNBLACKLISTER_ROLE = keccak256("UNBLACKLISTER_ROLE");
    bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
    bytes32 public constant ALLOWANCE_MANAGER_ROLE = keccak256("ALLOWANCE_MANAGER_ROLE");

    uint256 public constant PRECISION = 1e18;

    // Share-based storage
    mapping(address => uint256) private _shares;
    uint256 private _totalShares;

    // Rebasing mechanism
    uint256 public rewardMultiplier;

    // Minter allowance system (Circle pattern)
    mapping(address => uint256) public minterAllowance;

    // Supply cap
    uint256 public maxSupply;

    // Blacklist
    mapping(address => bool) public isBlacklisted;

    // Events
    event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event MinterAllowanceUpdated(address indexed minter, uint256 oldAllowance, uint256 newAllowance);
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

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
        __ERC20_init(name, symbol);
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        rewardMultiplier = PRECISION;
        maxSupply = initialMaxSupply;
    }

    // ============ Rebasing Logic ============

    /**
     * @notice Update reward multiplier to distribute yield
     * @param newMultiplier New multiplier value (must be >= current)
     */
    function updateRewardMultiplier(uint256 newMultiplier) external onlyRole(REBASER_ROLE) {
        require(newMultiplier >= rewardMultiplier, "Multiplier cannot decrease");
        uint256 oldMultiplier = rewardMultiplier;
        rewardMultiplier = newMultiplier;
        emit RebaseEvent(oldMultiplier, newMultiplier);
    }

    /**
     * @notice Get shares owned by account
     */
    function sharesOf(address account) public view returns (uint256) {
        return _shares[account];
    }

    /**
     * @notice Get total shares
     */
    function totalShares() public view returns (uint256) {
        return _totalShares;
    }

    /**
     * @notice Convert shares to token amount
     */
    function sharesToTokens(uint256 shares) public view returns (uint256) {
        return (shares * rewardMultiplier) / PRECISION;
    }

    /**
     * @notice Convert token amount to shares
     */
    function tokensToShares(uint256 tokens) public view returns (uint256) {
        return (tokens * PRECISION) / rewardMultiplier;
    }

    // ============ ERC20 Overrides (Share-based) ============

    function totalSupply() public view override returns (uint256) {
        return sharesToTokens(_totalShares);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return sharesToTokens(_shares[account]);
    }

    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        _transferShares(msg.sender, to, tokensToShares(amount));
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        public
        override
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        _transferShares(from, to, tokensToShares(amount));
        return true;
    }

    function _transferShares(address from, address to, uint256 shares) internal {
        require(from != address(0), "Transfer from zero address");
        require(to != address(0), "Transfer to zero address");
        require(!isBlacklisted[from], "Sender blacklisted");
        require(!isBlacklisted[to], "Recipient blacklisted");

        uint256 fromBalance = _shares[from];
        require(fromBalance >= shares, "Insufficient balance");

        unchecked {
            _shares[from] = fromBalance - shares;
            _shares[to] += shares;
        }

        emit Transfer(from, to, sharesToTokens(shares));
    }

    // ============ Minting & Burning ============

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        require(!isBlacklisted[to], "Recipient blacklisted");
        require(totalSupply() + amount <= maxSupply, "Exceeds supply cap");
        require(minterAllowance[msg.sender] >= amount, "Exceeds minter allowance");

        unchecked {
            minterAllowance[msg.sender] -= amount;
        }

        uint256 shares = tokensToShares(amount);
        _totalShares += shares;
        _shares[to] += shares;

        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        require(!isBlacklisted[from], "Account blacklisted");

        uint256 shares = tokensToShares(amount);
        require(_shares[from] >= shares, "Insufficient balance");

        unchecked {
            _shares[from] -= shares;
            _totalShares -= shares;
        }

        emit Transfer(from, address(0), amount);
    }

    // ============ Minter Allowance Management ============

    function configureMinterAllowance(
        address minter,
        uint256 allowance
    )
        external
        onlyRole(ALLOWANCE_MANAGER_ROLE)
    {
        uint256 oldAllowance = minterAllowance[minter];
        minterAllowance[minter] = allowance;
        emit MinterAllowanceUpdated(minter, oldAllowance, allowance);
    }

    // ============ Supply Cap Management ============

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(CAP_MANAGER_ROLE) {
        uint256 oldMaxSupply = maxSupply;
        maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(BLACKLISTER_ROLE) {
        isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(UNBLACKLISTER_ROLE) {
        isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(UNPAUSER_ROLE) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}
