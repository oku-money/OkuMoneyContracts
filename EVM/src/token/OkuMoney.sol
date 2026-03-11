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
 * @title OkuMoney
 * @notice Non-rebasing base token backed by US T-Bills with rear-facing yield
 * @dev Standard ERC-20 balances (static). Yield is expressed through price appreciation
 *      tracked by an internal `okuMPrice()` view function using `_rpow` continuous accrual.
 *      DeFi and bridge compatible out of the box — no share conversion needed.
 *
 *      Key distinction: balanceOf() returns raw token count (standard ERC-20).
 *      okuMPrice() is a separate view function for pricing — used by PSM and vault.
 */
contract OkuMoney is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
    bytes32 public constant MINTER = keccak256("MINTER");

    // Granular RBAC roles
    bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
    bytes32 public constant OKUM_REBASER = keccak256("OKUM_REBASER");
    bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
    bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
    bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
    bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");

    uint256 public constant PRECISION = 1e18;
    // Max rate: ~3700% APY safety cap (well beyond any T-Bill rate)
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    // Price accrual mechanism (continuous)
    uint256 internal _basePrice; // last snapshot of price (starts at 1e18 = $1.00)
    uint256 public ratePerSecond; // compound rate per second (1e18 = no yield)
    uint256 public lastAccrualTime; // timestamp of last _basePrice snapshot
    uint256 public rateEnd; // when current rate expires (0 = no expiry)
    uint256 public pendingRatePerSecond; // next rate, activates at rateEnd

    // Minter allowance system (Circle pattern)
    mapping(address => uint256) public minterAllowance;

    // Supply cap in token units
    uint256 public maxSupply;

    // Blacklist
    mapping(address => bool) public isBlacklisted;

    // Storage gap accounts for three slots previously occupied by blacklist-exempt variables
    // (blacklistExempt1, blacklistExempt2, _blacklistExemptInitialized) that have been removed.
    // Gap is [40] instead of [37] to maintain the same total storage footprint across upgrades.

    // Events
    event OkuMPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event YieldRateUpdated(uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotPrice);
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
        _grantRole(OKUM_PAUSER, admin);

        _basePrice = PRECISION;
        ratePerSecond = PRECISION;
        lastAccrualTime = block.timestamp;
        pendingRatePerSecond = PRECISION;
        maxSupply = initialMaxSupply;
    }

    // ============ Price Accrual Logic ============

    /**
     * @notice Computed OkuM price with continuous yield accrual
     * @dev Handles current rate, rate expiry, and pending rate crossover.
     *      okuMPrice() starts at 1e18 ($1.00) and grows as rear-facing T-Bill yield accrues.
     *      After one year at 4.5% APY, okuMPrice() returns ~1.045e18 ($1.045).
     *
     *      Key: balanceOf() is NOT affected by okuMPrice(). Price appreciation is
     *      tracked separately for use by the PSM and vault.
     */
    function okuMPrice() public view returns (uint256) {
        uint256 rate = ratePerSecond;
        if (rate <= PRECISION) {
            // No yield accrual — check if pending rate has activated
            if (rateEnd != 0 && block.timestamp > rateEnd) {
                uint256 pendingRate = pendingRatePerSecond;
                if (pendingRate > PRECISION) {
                    uint256 elapsedPending = block.timestamp - rateEnd;
                    return (_basePrice * _rpow(pendingRate, elapsedPending, PRECISION)) / PRECISION;
                }
            }
            return _basePrice;
        }

        uint256 base = _basePrice;

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
     * @notice Get the base price (last snapshot, before accrual)
     */
    function basePrice() public view returns (uint256) {
        return _basePrice;
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
        onlyRole(OKUM_REBASER)
    {
        require(newRatePerSecond >= PRECISION, "Rate cannot be negative");
        require(newRatePerSecond <= MAX_RATE, "Rate too high");
        require(endTimestamp == 0 || endTimestamp > block.timestamp, "End must be in the future");

        // Snapshot current state
        _basePrice = okuMPrice();
        lastAccrualTime = block.timestamp;

        ratePerSecond = newRatePerSecond;
        rateEnd = endTimestamp;
        pendingRatePerSecond = PRECISION;

        emit YieldRateUpdated(newRatePerSecond, endTimestamp, _basePrice);
    }

    /**
     * @notice Schedule the next yield rate (activates when current rate expires)
     * @param newRatePerSecond Compound rate per second for the next period
     */
    function setNextYieldRate(uint256 newRatePerSecond) external onlyRole(OKUM_REBASER) {
        require(newRatePerSecond >= PRECISION, "Rate cannot be negative");
        require(newRatePerSecond <= MAX_RATE, "Rate too high");
        require(rateEnd != 0, "Current rate has no end");

        pendingRatePerSecond = newRatePerSecond;

        emit NextYieldRateSet(newRatePerSecond, rateEnd);
    }

    /**
     * @notice Emergency override — snapshots computed price, resets rate to zero yield
     * @param newPrice New price value (must be >= current computed price)
     */
    function updateOkuMPrice(uint256 newPrice) external onlyRole(OKUM_REBASER) {
        uint256 currentPrice = okuMPrice();
        require(newPrice >= currentPrice, "Price cannot decrease");
        _basePrice = newPrice;
        ratePerSecond = PRECISION;
        rateEnd = 0;
        pendingRatePerSecond = PRECISION;
        lastAccrualTime = block.timestamp;
        emit OkuMPriceUpdated(currentPrice, newPrice);
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

    // ============ ERC20 Transfer Hook (Blacklist + Pause) ============

    /**
     * @dev Override _update to enforce blacklist and pause checks on all transfers.
     *      Mint (from == address(0)): blacklist checked on recipient only.
     *      Burn (to == address(0)): no pause check — burn works while paused.
     *      Transfer: blocked when paused, blocked if either party is blacklisted.
     */
    function _update(address from, address to, uint256 amount) internal override {
        // Blacklist checks (skip for mint/burn zero-address side)
        if (from != address(0)) {
            require(!isBlacklisted[from], "Sender blacklisted");
        }
        if (to != address(0)) {
            require(!isBlacklisted[to], "Recipient blacklisted");
        }

        // Pause check: block peer-to-peer transfers when paused.
        // Mint has its own whenNotPaused modifier. Burn is always allowed.
        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
        }

        super._update(from, to, amount);
    }

    // ============ Minting & Burning ============

    /**
     * @notice Mint raw tokens to an address
     * @dev Creates raw tokens; minting 100 tokens when okuMPrice = $1.05 creates $105 of value.
     *      The PSM handles USDC <-> OkuM conversion using okuMPrice().
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER) whenNotPaused {
        require(amount > 0, "Amount too small");
        require(!isBlacklisted[to], "Recipient blacklisted");
        require(totalSupply() + amount <= maxSupply, "Exceeds supply cap");
        require(minterAllowance[msg.sender] >= amount, "Exceeds minter allowance");

        unchecked {
            minterAllowance[msg.sender] -= amount;
        }

        _mint(to, amount);
    }

    /**
     * @notice Burn raw tokens from caller
     * @dev No whenNotPaused — burn works while paused.
     */
    function burn(uint256 amount) external onlyRole(MINTER) {
        require(!isBlacklisted[msg.sender], "Account blacklisted");
        _burn(msg.sender, amount);
    }

    // ============ Minter Allowance Management ============

    function configureMinterAllowance(
        address minter_,
        uint256 allowance
    )
        external
        onlyRole(ALLOWANCE_MANAGER)
    {
        uint256 oldAllowance = minterAllowance[minter_];
        minterAllowance[minter_] = allowance;
        emit MinterAllowanceUpdated(minter_, oldAllowance, allowance);
    }

    // ============ Supply Cap Management ============

    function setMaxSupply(uint256 newMaxSupply) external onlyRole(CAP_MANAGER) {
        require(newMaxSupply >= totalSupply(), "Below current supply");
        uint256 oldMaxSupply = maxSupply;
        maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(oldMaxSupply, newMaxSupply);
    }

    // ============ Blacklist (Works While Paused) ============

    function blacklist(address account) external onlyRole(BLACKLISTER) {
        isBlacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unblacklist(address account) external onlyRole(UNBLACKLISTER) {
        isBlacklisted[account] = false;
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

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}

    // ============ Storage Gap ============

    // [40] = original [37] + 3 slots reclaimed from removed blacklist-exempt variables
    // (blacklistExempt1, blacklistExempt2, _blacklistExemptInitialized)
    uint256[40] private __gap;
}
