// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IOkuUSD {
    function burn(address from, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function tokensToShares(uint256 tokens) external view returns (uint256);
    function sharesToTokens(uint256 shares) external view returns (uint256);
}

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuUSD redemptions when PSM buffer is depleted
 * @dev Stores shares (not tokens) so users earn yield while waiting
 */
contract RedemptionQueue is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuUSD is 18 decimals)
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // 18 - 6 = 12

    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant PSM = keccak256("PSM");

    struct QueueEntry {
        address user;
        uint256 shares; // Stored as shares so users earn yield while queued
        uint256 timestamp;
    }

    QueueEntry[] public queue;
    uint256 public queueHead;

    IOkuUSD public okuUsd;

    // Events
    event RedemptionQueued(
        address indexed user, uint256 shares, uint256 okuUsdAmount, uint256 position
    );
    event RedemptionProcessed(
        address indexed user, uint256 shares, uint256 okuUsdAmount, uint256 usdcAmount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _okuUsd, address admin) public initializer {
        __AccessControl_init();

        okuUsd = IOkuUSD(_okuUsd);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
    }

    // ============ Queue Management ============

    /**
     * @notice Add redemption to queue
     * @param user User requesting redemption
     * @param okuUsdAmount Amount of OkuUSD to redeem (in tokens)
     * @dev Converts tokens to shares for storage so users earn yield while queued
     */
    function enqueue(address user, uint256 okuUsdAmount) external onlyRole(PSM) {
        // Transfer OkuUSD to queue (locks it)
        require(okuUsd.transferFrom(user, address(this), okuUsdAmount), "Transfer failed");

        // Convert tokens to shares for storage
        uint256 shares = okuUsd.tokensToShares(okuUsdAmount);

        queue.push(QueueEntry({user: user, shares: shares, timestamp: block.timestamp}));

        emit RedemptionQueued(user, shares, okuUsdAmount, queue.length - 1);
    }

    /**
     * @notice Process queued redemptions (FIFO)
     * @param maxEntries Maximum number of entries to process
     * @param usdcToken USDC token address
     * @param okuUsdToken OkuUSD token address
     * @dev Converts shares back to tokens at current multiplier - users benefit from yield accrued
     */
    function processQueue(
        uint256 maxEntries,
        address usdcToken,
        address okuUsdToken
    )
        external
        onlyRole(PSM)
    {
        IERC20 usdc = IERC20(usdcToken);
        IOkuUSD oku = IOkuUSD(okuUsdToken);

        uint256 processed = 0;
        uint256 usdcBalance = usdc.balanceOf(msg.sender);

        while (queueHead < queue.length && processed < maxEntries && usdcBalance > 0) {
            QueueEntry memory entry = queue[queueHead];

            // Convert shares to current token value (includes yield earned while queued)
            uint256 okuUsdAmount = oku.sharesToTokens(entry.shares);

            // Convert OkuUSD (18 decimals) to USDC amount (6 decimals)
            uint256 usdcAmount = okuUsdAmount / DECIMAL_MULTIPLIER;

            if (usdcBalance >= usdcAmount) {
                // Burn OkuUSD from queue (use token amount)
                oku.burn(address(this), okuUsdAmount);

                // Transfer USDC to user (1:1 value, converted for decimals)
                usdc.safeTransferFrom(msg.sender, entry.user, usdcAmount);

                emit RedemptionProcessed(entry.user, entry.shares, okuUsdAmount, usdcAmount);

                usdcBalance -= usdcAmount;
                queueHead++;
                processed++;
            } else {
                break;
            }
        }
    }

    /**
     * @notice Get queue length
     */
    function queueLength() external view returns (uint256) {
        return queue.length - queueHead;
    }

    /**
     * @notice Get queue entry at index
     */
    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        require(index >= queueHead && index < queue.length, "Invalid index");
        return queue[index];
    }

    /**
     * @notice Get current token value for a queue entry (includes accrued yield)
     * @param index Queue index
     * @return Current OkuUSD token value of the queued shares
     */
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        require(index >= queueHead && index < queue.length, "Invalid index");
        return okuUsd.sharesToTokens(queue[index].shares);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER)
    {}
}
