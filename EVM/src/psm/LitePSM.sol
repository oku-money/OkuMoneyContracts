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
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {RedemptionQueue} from "./RedemptionQueue.sol";
import {IOkuUSD} from "../interfaces/IOkuUSD.sol";

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
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
    ReentrancyGuard,
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
    event BufferWithdrawn(address indexed to, uint256 amount);

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
    function mint(uint256 usdcAmount) external whenNotPaused nonReentrant {
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
    function redeem(uint256 okuUsdAmount) external whenNotPaused nonReentrant {
        _redeem(msg.sender, okuUsdAmount);
    }

    /**
     * @notice Redeem OkuUSD for USDC using EIP-2612 permit (single transaction)
     * @param okuUsdAmount Amount of OkuUSD to redeem (18 decimals)
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     */
    function redeemWithPermit(
        uint256 okuUsdAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        whenNotPaused
        nonReentrant
    {
        IERC20Permit(address(okuUsd))
            .permit(msg.sender, address(this), okuUsdAmount, deadline, v, r, s);
        _redeem(msg.sender, okuUsdAmount);
    }

    function _redeem(address user, uint256 okuUsdAmount) internal {
        require(okuUsdAmount > 0, "Amount must be positive");

        // Convert OkuUSD (18 decimals) to USDC amount (6 decimals)
        uint256 usdcAmount = okuUsdAmount / DECIMAL_MULTIPLIER;
        require(usdcAmount > 0, "Amount too small");

        // Align OkuUSD amount to USDC precision to avoid truncation loss
        // User keeps any sub-USDC dust
        uint256 alignedOkuUsdAmount = usdcAmount * DECIMAL_MULTIPLIER;

        uint256 usdcBalance = usdc.balanceOf(address(this));

        if (usdcBalance >= usdcAmount) {
            // Sufficient buffer - transfer-then-burn (Circle model: self-burn only)
            IERC20(address(okuUsd)).safeTransferFrom(user, address(this), alignedOkuUsdAmount);
            okuUsd.burn(alignedOkuUsdAmount);
            usdc.safeTransfer(user, usdcAmount);
            emit Redeem(user, alignedOkuUsdAmount, usdcAmount);
        } else {
            // Insufficient buffer - queue redemption
            // Pull aligned OkuUSD from user to PSM
            IERC20(address(okuUsd)).safeTransferFrom(user, address(this), alignedOkuUsdAmount);
            // Transfer from PSM to queue, then record
            IERC20(address(okuUsd)).safeTransfer(address(redemptionQueue), alignedOkuUsdAmount);
            redemptionQueue.enqueue(user, alignedOkuUsdAmount);
        }
    }

    /**
     * @notice Process queued redemptions (called by operator when buffer refilled)
     * @param maxEntries Maximum number of queue entries to process
     * @param approveAmount USDC amount to approve for processing (backend calculates by summing entries)
     */
    function processQueue(
        uint256 maxEntries,
        uint256 approveAmount
    )
        external
        onlyRole(QUEUE_PROCESSOR)
        nonReentrant
    {
        // Approve exact amount needed for queue processing
        usdc.approve(address(redemptionQueue), approveAmount);

        // Process queue
        redemptionQueue.processQueue(maxEntries, address(usdc), address(okuUsd));

        // Revoke approval for remaining USDC
        usdc.approve(address(redemptionQueue), 0);

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

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            porOracle.latestRoundData();

        require(answeredInRound >= roundId, "Incomplete oracle round");
        require(block.timestamp - updatedAt < stalenessThreshold, "Stale oracle data");
        require(answer >= 0, "Invalid oracle response");

        uint256 newSupply = okuUsd.totalSupply() + mintAmount;
        // Safe cast: answer >= 0 checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        require(uint256(answer) >= newSupply, "Exceeds reserves");
    }

    // ============ Admin Functions ============

    function pause() external onlyRole(PSM_PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(PSM_UNPAUSER) {
        _unpause();
    }

    function withdrawUsdc(address to, uint256 amount) external onlyRole(BUFFER_WITHDRAWER) {
        uint256 balance = usdc.balanceOf(address(this));
        require(balance >= amount, "Insufficient USDC balance");
        uint256 queueObligation = redemptionQueue.totalQueuedUsdc();
        require(balance - amount >= queueObligation, "Would strand queue");
        usdc.safeTransfer(to, amount);
        emit BufferWithdrawn(to, amount);
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

    // ============ Storage Gap ============

    uint256[44] private __gap;
}
