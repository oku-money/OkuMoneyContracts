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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";

interface IOkuUSD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface IAggregatorV3 {
    function latestAnswer() external view returns (int256);
    function latestTimestamp() external view returns (uint256);
}

/**
 * @title LitePSM
 * @notice Peg Stability Module for 1:1 USDC <-> OkuUSD swaps with zero slippage
 * @dev Includes PoR oracle checks and redemption queue for when buffer is depleted
 */
contract LitePSM is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuUSD is 18 decimals)
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // 18 - 6 = 12

    // Granular RBAC roles (contract-specific prefixes)
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 public constant QUEUE_PROCESSOR = keccak256("QUEUE_PROCESSOR");
    bytes32 public constant BUFFER_DEPOSITOR = keccak256("BUFFER_DEPOSITOR");
    bytes32 public constant BUFFER_WITHDRAWER = keccak256("BUFFER_WITHDRAWER");
    bytes32 public constant ORACLE_MANAGER = keccak256("ORACLE_MANAGER");

    IOkuUSD public okuUsd;
    IERC20 public usdc;
    RedemptionQueue public redemptionQueue;

    // Oracle configuration
    IAggregatorV3 public porOracle;
    uint256 public stalenessThreshold;
    bool public oracleEnabled;

    // Events
    event Mint(address indexed user, uint256 usdcAmount, uint256 okusdAmount);
    event Redeem(address indexed user, uint256 okuUsdIn, uint256 usdcOut);
    event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
    event BufferRefilled(uint256 amount);
    event BufferDeposited(address indexed depositor, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _okuUsd,
        address _usdc,
        address _redemptionQueue,
        address admin
    )
        public
        initializer
    {
        __AccessControl_init();
        __Pausable_init();

        okuUsd = IOkuUSD(_okuUsd);
        usdc = IERC20(_usdc);
        redemptionQueue = RedemptionQueue(_redemptionQueue);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PSM_UPGRADER, admin);
        _grantRole(PSM_PAUSER, admin);
        _grantRole(QUEUE_PROCESSOR, admin);

        stalenessThreshold = 1 hours;
    }

    // ============ Swap Functions ============

    /**
     * @notice Mint OkuUSD by depositing USDC at 1:1 rate
     * @param usdcAmount Amount of USDC to deposit (6 decimals)
     */
    function mint(uint256 usdcAmount) external whenNotPaused {
        require(usdcAmount > 0, "Amount must be positive");

        // Convert USDC (6 decimals) to OkuUSD amount (18 decimals)
        uint256 okuUsdAmount = usdcAmount * DECIMAL_MULTIPLIER;

        // Check PoR oracle if enabled
        if (oracleEnabled && address(porOracle) != address(0)) {
            _checkReserves(okuUsdAmount);
        }

        // Transfer USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Mint OkuUSD to user (1:1 in value, converted for decimals)
        okuUsd.mint(msg.sender, okuUsdAmount);

        emit Mint(msg.sender, usdcAmount, okuUsdAmount);
    }

    /**
     * @notice Redeem OkuUSD for USDC at 1:1 rate
     * @param okuUsdAmount Amount of OkuUSD to redeem (18 decimals)
     */
    function redeem(uint256 okuUsdAmount) external whenNotPaused {
        require(okuUsdAmount > 0, "Amount must be positive");

        // Convert OkuUSD (18 decimals) to USDC amount (6 decimals)
        uint256 usdcAmount = okuUsdAmount / DECIMAL_MULTIPLIER;
        require(usdcAmount > 0, "Amount too small");

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - process immediately
            okuUsd.burn(msg.sender, okuUsdAmount);
            usdc.safeTransfer(msg.sender, usdcAmount);
            emit Redeem(msg.sender, okuUsdAmount, usdcAmount);
        } else {
            // Insufficient buffer - queue redemption
            redemptionQueue.enqueue(msg.sender, okuUsdAmount);
        }
    }

    /**
     * @notice Process queued redemptions (called by operator when buffer refilled)
     * @param maxEntries Maximum number of queue entries to process
     */
    function processQueue(uint256 maxEntries) external onlyRole(QUEUE_PROCESSOR) {
        //approve our USDC balance to the redemption queue so we can fill the orders
        uint256 balance = usdc.balanceOf(address(this));
        usdc.approve(address(redemptionQueue), balance);

        //process queue
        redemptionQueue.processQueue(maxEntries, address(usdc), address(okuUsd));

        //revoke approval for remaining USDC
        usdc.approve(address(redemptionQueue), 0);

        //emit
        emit BufferRefilled(usdc.balanceOf(address(this)));
    }

    // ============ Oracle Management ============

    function configureOracle(
        address _oracle,
        uint256 _stalenessThreshold,
        bool _enabled
    )
        external
        onlyRole(ORACLE_MANAGER)
    {
        porOracle = IAggregatorV3(_oracle);
        stalenessThreshold = _stalenessThreshold;
        oracleEnabled = _enabled;
        emit OracleConfigured(_oracle, _stalenessThreshold, _enabled);
    }

    function _checkReserves(uint256 mintAmount) internal view {
        require(address(porOracle) != address(0), "Oracle not configured");

        int256 reserves = porOracle.latestAnswer();
        uint256 lastUpdate = porOracle.latestTimestamp();

        require(block.timestamp - lastUpdate < stalenessThreshold, "Stale oracle data");
        require(reserves >= 0, "Invalid oracle response");

        uint256 newSupply = okuUsd.totalSupply() + mintAmount;
        // Safe cast: reserves >= 0 checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        require(uint256(reserves) >= newSupply, "Exceeds reserves");
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(PSM_UNPAUSER) {
        _unpause();
    }

    function withdrawUsdc(address to, uint256 amount) external onlyRole(BUFFER_WITHDRAWER) {
        usdc.safeTransfer(to, amount);
    }

    /**
     * @notice Deposit USDC to PSM buffer for redemptions
     * @param amount Amount of USDC to deposit
     */
    function depositBuffer(uint256 amount) external onlyRole(BUFFER_DEPOSITOR) {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BufferDeposited(msg.sender, amount);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(PSM_UPGRADER)
    {}
}
