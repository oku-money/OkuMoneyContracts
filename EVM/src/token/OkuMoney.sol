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
 * @dev Standard ERC-20 balances (static). Yield is expressed through price appreciation
 *      tracked by an internal `okuMPrice()` view function using `MathLib.rpow` continuous accrual.
 *      DeFi and bridge compatible out of the box — no share conversion needed.
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
        // Price accrual mechanism (continuous)
        uint256 basePrice; // last snapshot of price (starts at 1e18 = $1.00)
        uint256 ratePerSecond; // compound rate per second (1e18 = no yield)
        uint256 lastAccrualTime; // timestamp of last basePrice snapshot
        uint256 rateEnd; // when current rate expires (0 = no expiry)
        uint256 pendingRatePerSecond; // next rate, activates at rateEnd
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
    uint256 public constant MAX_RATE = Constants.MAX_RATE;

    // ============ Events ============

    event OkuMPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event YieldRateUpdated(uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotPrice);
    event NextYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinterAllowanceUpdated(
        address indexed minter, uint256 oldAllowance, uint256 newAllowance
    );
    event MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply);
    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ============ Custom Errors ============

    error ZeroAddress();
    error InvalidRate();
    error RateTooHigh();
    error EndTimestampInPast();
    error NoRateEndSet();
    error PriceCannotDecrease();
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
        $.basePrice = PRECISION;
        $.ratePerSecond = PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.pendingRatePerSecond = PRECISION;
        $.maxSupply = initialMaxSupply;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OKUM_UPGRADER, admin);
        _grantRole(OKUM_PAUSER, admin);
    }

    // ============ Storage Accessor Views ============

    function ratePerSecond() public view returns (uint256) {
        return _getOkuMoneyStorage().ratePerSecond;
    }

    function lastAccrualTime() public view returns (uint256) {
        return _getOkuMoneyStorage().lastAccrualTime;
    }

    function rateEnd() public view returns (uint256) {
        return _getOkuMoneyStorage().rateEnd;
    }

    function pendingRatePerSecond() public view returns (uint256) {
        return _getOkuMoneyStorage().pendingRatePerSecond;
    }

    function minterAllowance(address minter_) public view returns (uint256) {
        return _getOkuMoneyStorage().minterAllowance[minter_];
    }

    function maxSupply() public view returns (uint256) {
        return _getOkuMoneyStorage().maxSupply;
    }

    function isBlacklisted(address account) public view returns (bool) {
        return _getOkuMoneyStorage().isBlacklisted[account];
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
        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        uint256 rate = $.ratePerSecond;

        if (rate <= PRECISION) {
            // No yield accrual — check if pending rate has activated
            if ($.rateEnd != 0 && block.timestamp > $.rateEnd) {
                uint256 pendingRate = $.pendingRatePerSecond;
                if (pendingRate > PRECISION) {
                    uint256 elapsedPending = block.timestamp - $.rateEnd;
                    return ($.basePrice * MathLib.rpow(pendingRate, elapsedPending, PRECISION))
                        / PRECISION;
                }
            }
            return $.basePrice;
        }

        uint256 base = $.basePrice;

        if ($.rateEnd != 0 && block.timestamp > $.rateEnd) {
            // Current rate expired — accrue current rate up to rateEnd, then pending rate after
            uint256 elapsedCurrent = $.rateEnd - $.lastAccrualTime;
            if (elapsedCurrent > 0) {
                base = (base * MathLib.rpow(rate, elapsedCurrent, PRECISION)) / PRECISION;
            }
            // Apply pending rate for remaining time
            uint256 pendingRate = $.pendingRatePerSecond;
            if (pendingRate > PRECISION) {
                uint256 elapsedPending = block.timestamp - $.rateEnd;
                if (elapsedPending > 0) {
                    base = (base * MathLib.rpow(pendingRate, elapsedPending, PRECISION)) / PRECISION;
                }
            }
            return base;
        }

        uint256 elapsed = block.timestamp - $.lastAccrualTime;
        if (elapsed == 0) return base;
        return (base * MathLib.rpow(rate, elapsed, PRECISION)) / PRECISION;
    }

    /**
     * @notice Get the base price (last snapshot, before accrual)
     */
    function basePrice() public view returns (uint256) {
        return _getOkuMoneyStorage().basePrice;
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
        if (newRatePerSecond < PRECISION) revert InvalidRate();
        if (newRatePerSecond > MAX_RATE) revert RateTooHigh();
        if (endTimestamp != 0 && endTimestamp <= block.timestamp) revert EndTimestampInPast();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();

        // Snapshot current state
        $.basePrice = okuMPrice();
        $.lastAccrualTime = block.timestamp;

        $.ratePerSecond = newRatePerSecond;
        $.rateEnd = endTimestamp;
        $.pendingRatePerSecond = PRECISION;

        emit YieldRateUpdated(newRatePerSecond, endTimestamp, $.basePrice);
    }

    /**
     * @notice Schedule the next yield rate (activates when current rate expires)
     * @param newRatePerSecond Compound rate per second for the next period
     */
    function setNextYieldRate(uint256 newRatePerSecond) external onlyRole(OKUM_REBASER) {
        if (newRatePerSecond < PRECISION) revert InvalidRate();
        if (newRatePerSecond > MAX_RATE) revert RateTooHigh();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        if ($.rateEnd == 0) revert NoRateEndSet();

        $.pendingRatePerSecond = newRatePerSecond;

        emit NextYieldRateSet(newRatePerSecond, $.rateEnd);
    }

    /**
     * @notice Emergency override — snapshots computed price, resets rate to zero yield
     * @param newPrice New price value (must be >= current computed price)
     */
    function updateOkuMPrice(uint256 newPrice) external onlyRole(OKUM_REBASER) {
        uint256 currentPrice = okuMPrice();
        if (newPrice < currentPrice) revert PriceCannotDecrease();

        OkuMoneyStorage storage $ = _getOkuMoneyStorage();
        $.basePrice = newPrice;
        $.ratePerSecond = PRECISION;
        $.rateEnd = 0;
        $.pendingRatePerSecond = PRECISION;
        $.lastAccrualTime = block.timestamp;

        emit OkuMPriceUpdated(currentPrice, newPrice);
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
