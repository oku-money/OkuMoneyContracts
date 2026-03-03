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

/**
 * @title OkuUSD
 * @notice Rebasing yield-bearing stablecoin backed 1:1 by US T-Bills
 * @dev Implements share-based storage where balanceOf = shares * rewardMultiplier
 */
contract OkuUSD is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant OKUUSD_PAUSER = keccak256("OKUUSD_PAUSER");
    bytes32 public constant MINTER = keccak256("MINTER");

    // Granular RBAC roles
    bytes32 public constant OKUUSD_UNPAUSER = keccak256("OKUUSD_UNPAUSER");
    bytes32 public constant REBASER = keccak256("REBASER");
    bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
    bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
    bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
    bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");

    uint256 public constant PRECISION = 1e18;

    // Share-based storage
    mapping(address => uint256) private _shares;
    uint256 private _totalShares;

    // Rebasing mechanism — continuous yield accrual
    uint256 internal _baseMultiplier;
    uint256 public ratePerSecond;
    uint256 public lastAccrualTime;
    uint256 public rateEnd;
    uint256 public pendingRatePerSecond;

    // Minter allowance system (Circle pattern)
    mapping(address => uint256) public minterAllowance;

    // Supply cap
    uint256 public maxSupply;

    // Blacklist
    mapping(address => bool) public isBlacklisted;

    // Blacklist-exempt infrastructure addresses (bridge, router)
    address public blacklistExempt1;
    address public blacklistExempt2;
    bool private _blacklistExemptInitialized;

    // Events
    event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event YieldRateUpdated(
        uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotMultiplier
    );
    event NextYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
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
        __ERC20Permit_init(name);
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
        _grantRole(OKUUSD_PAUSER, admin);

        _baseMultiplier = PRECISION;
        ratePerSecond = PRECISION;
        lastAccrualTime = block.timestamp;
        pendingRatePerSecond = PRECISION;
        maxSupply = initialMaxSupply;
    }

    // ============ Rebasing Logic ============

    /**
     * @notice Computed reward multiplier with continuous yield accrual
     * @dev Handles current rate, rate expiry, and pending rate crossover
     */
    function rewardMultiplier() public view returns (uint256) {
        uint256 rate = ratePerSecond;
        if (rate <= PRECISION) {
            // No yield accrual — check if pending rate has activated
            if (rateEnd != 0 && block.timestamp > rateEnd) {
                uint256 pendingRate = pendingRatePerSecond;
                if (pendingRate > PRECISION) {
                    uint256 elapsedPending = block.timestamp - rateEnd;
                    return
                        (_baseMultiplier * _rpow(pendingRate, elapsedPending, PRECISION))
                            / PRECISION;
                }
            }
            return _baseMultiplier;
        }

        uint256 base = _baseMultiplier;

        if (rateEnd != 0 && block.timestamp > rateEnd) {
            // Current rate expired — accrue current rate up to rateEnd, then pending rate after
            uint256 elapsedCurrent = rateEnd - lastAccrualTime;
            if (elapsedCurrent > 0) {
                base = (base * _rpow(rate, elapsedCurrent, PRECISION)) / PRECISION;
            }
            // Apply pending rate for remaining time
            uint256 pendingRate = pendingRatePerSecond;
            if (pendingRate > PRECISION) {
                uint256 elapsedPending = block.timestamp - rateEnd;
                if (elapsedPending > 0) {
                    base = (base * _rpow(pendingRate, elapsedPending, PRECISION)) / PRECISION;
                }
            }
            return base;
        }

        uint256 elapsed = block.timestamp - lastAccrualTime;
        if (elapsed == 0) return base;
        return (base * _rpow(rate, elapsed, PRECISION)) / PRECISION;
    }

    /**
     * @notice Get the base multiplier (last snapshot, before accrual)
     */
    function baseMultiplier() public view returns (uint256) {
        return _baseMultiplier;
    }

    /**
     * @notice Set active yield rate with optional end time
     * @param newRatePerSecond Compound rate per second (1e18 = no yield)
     * @param endTimestamp When current rate expires (0 = no expiry)
     */
    function setYieldRate(
        uint256 newRatePerSecond,
        uint256 endTimestamp
    )
        external
        onlyRole(REBASER)
    {
        require(newRatePerSecond >= PRECISION, "Rate cannot be negative");
        require(endTimestamp == 0 || endTimestamp > block.timestamp, "End must be in the future");

        // Snapshot current state
        _baseMultiplier = rewardMultiplier();
        lastAccrualTime = block.timestamp;

        ratePerSecond = newRatePerSecond;
        rateEnd = endTimestamp;
        pendingRatePerSecond = PRECISION;

        emit YieldRateUpdated(newRatePerSecond, endTimestamp, _baseMultiplier);
    }

    /**
     * @notice Schedule the next yield rate (activates when current rate expires)
     * @param newRatePerSecond Compound rate per second for the next period
     */
    function setNextYieldRate(uint256 newRatePerSecond) external onlyRole(REBASER) {
        require(newRatePerSecond >= PRECISION, "Rate cannot be negative");
        require(rateEnd != 0, "Current rate has no end");

        pendingRatePerSecond = newRatePerSecond;

        emit NextYieldRateSet(newRatePerSecond, rateEnd);
    }

    /**
     * @notice Emergency override — snapshots computed multiplier, resets rate to zero yield
     * @param newMultiplier New multiplier value (must be >= current computed multiplier)
     */
    function updateRewardMultiplier(uint256 newMultiplier) external onlyRole(REBASER) {
        uint256 currentMultiplier = rewardMultiplier();
        require(newMultiplier >= currentMultiplier, "Multiplier cannot decrease");
        _baseMultiplier = newMultiplier;
        ratePerSecond = PRECISION;
        rateEnd = 0;
        pendingRatePerSecond = PRECISION;
        lastAccrualTime = block.timestamp;
        emit RebaseEvent(currentMultiplier, newMultiplier);
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
        return (shares * rewardMultiplier()) / PRECISION;
    }

    /**
     * @notice Convert token amount to shares
     */
    function tokensToShares(uint256 tokens) public view returns (uint256) {
        return (tokens * PRECISION) / rewardMultiplier();
    }

    // ============ Exponentiation by Squaring (MakerDAO DSS) ============

    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring)
     * @dev Copied from MakerDAO's jug.sol / pot.sol — battle-tested since 2017
     */
    function _rpow(uint256 x, uint256 n, uint256 b) internal pure returns (uint256 z) {
        assembly {
            switch x
            case 0 {
                switch n
                case 0 { z := b }
                default { z := 0 }
            }
            default {
                switch mod(n, 2)
                case 0 { z := b }
                default { z := x }
                let half := div(b, 2)
                for { n := div(n, 2) } n { n := div(n, 2) } {
                    let xx := mul(x, x)
                    if iszero(eq(div(xx, x), x)) { revert(0, 0) }
                    let xxRound := add(xx, half)
                    if lt(xxRound, xx) { revert(0, 0) }
                    x := div(xxRound, b)
                    if mod(n, 2) {
                        let zx := mul(z, x)
                        if and(iszero(iszero(x)), iszero(eq(div(zx, x), z))) {
                            revert(0, 0)
                        }
                        let zxRound := add(zx, half)
                        if lt(zxRound, zx) { revert(0, 0) }
                        z := div(zxRound, b)
                    }
                }
            }
        }
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

        _shares[from] = fromBalance - shares;
        _shares[to] += shares;

        emit Transfer(from, to, sharesToTokens(shares));
    }

    // ============ Minting & Burning ============

    function mint(address to, uint256 amount) external onlyRole(MINTER) whenNotPaused {
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

    function burn(uint256 amount) external onlyRole(MINTER) {
        require(!isBlacklisted[msg.sender], "Account blacklisted");

        uint256 shares = tokensToShares(amount);
        require(_shares[msg.sender] >= shares, "Insufficient balance");

        _shares[msg.sender] -= shares;
        _totalShares -= shares;

        emit Transfer(msg.sender, address(0), amount);
    }

    // ============ Minter Allowance Management ============

    function configureMinterAllowance(
        address minter,
        uint256 allowance
    )
        external
        onlyRole(ALLOWANCE_MANAGER)
    {
        uint256 oldAllowance = minterAllowance[minter];
        minterAllowance[minter] = allowance;
        emit MinterAllowanceUpdated(minter, oldAllowance, allowance);
    }

    // ============ Supply Cap Management ============

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(CAP_MANAGER) {
        uint256 oldMaxSupply = maxSupply;
        maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist-Exempt Infrastructure ============

    /**
     * @notice One-time setter for blacklist-exempt infrastructure addresses (bridge, router)
     * @dev Uses CREATE2 deterministic addresses. Cannot be called twice.
     */
    function initializeBlacklistExempt(
        address bridge,
        address router
    )
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(!_blacklistExemptInitialized, "Already initialized");
        require(bridge != address(0) && router != address(0), "Zero address");
        blacklistExempt1 = bridge;
        blacklistExempt2 = router;
        _blacklistExemptInitialized = true;
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(BLACKLISTER) {
        require(
            account != blacklistExempt1 && account != blacklistExempt2,
            "Account is blacklist-exempt"
        );
        isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(UNBLACKLISTER) {
        isBlacklisted[account] = false;
        emit Unblacklisted(account);
    }

    // ============ Pause Management ============

    function pause() external onlyRole(OKUUSD_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(OKUUSD_UNPAUSER) {
        _unpause();
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}

    // ============ Storage Gap ============

    uint256[37] private __gap;
}
