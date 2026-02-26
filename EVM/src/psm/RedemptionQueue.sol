// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuUSD} from "../interfaces/IOkuUSD.sol";

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuUSD redemptions when PSM buffer is depleted
 * @dev Stores shares (not tokens) so users earn yield while waiting.
 *      Tokens are transferred into the queue by the PSM before enqueue() is called;
 *      enqueue() is record-only and does not pull tokens from the user.
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

    mapping(uint256 => QueueEntry) public queue;
    uint256 public queueHead;
    uint256 public queueTail;

    /// @notice Running counter of shares queued (O(1) totalQueuedUsdc)
    uint256 public totalQueuedShares;

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
     * @notice Record a redemption in the queue
     * @param user User requesting redemption
     * @param okuUsdAmount Amount of OkuUSD to redeem (in tokens)
     * @dev Tokens must already be in this contract before calling (PSM transfers them first).
     *      This function is record-only: it converts tokens to shares and pushes an entry.
     */
    function enqueue(address user, uint256 okuUsdAmount) external onlyRole(PSM) {
        // Convert tokens to shares for storage
        uint256 shares = okuUsd.tokensToShares(okuUsdAmount);

        uint256 position = queueTail;
        queue[position] = QueueEntry({user: user, shares: shares, timestamp: block.timestamp});
        queueTail = position + 1;
        totalQueuedShares += shares;

        emit RedemptionQueued(user, shares, okuUsdAmount, position);
    }

    /**
     * @notice Process queued redemptions (FIFO)
     * @param maxEntries Maximum number of entries to process
     * @param usdcToken USDC token address
     * @param - OkuUSD token address (unused, kept for interface compat)
     * @dev Converts shares back to tokens at current multiplier - users benefit from yield accrued.
     *      Per-entry truncation from 18->6 decimal conversion is at most ~$0.000001.
     */
    function processQueue(
        uint256 maxEntries,
        address usdcToken,
        address /* okuUsdToken */
    )
        external
        onlyRole(PSM)
    {
        IERC20 usdc = IERC20(usdcToken);

        uint256 processed = 0;
        uint256 usdcBalance = usdc.balanceOf(msg.sender);

        while (processed < maxEntries && usdcBalance > 0) {
            // Enforce queueHead < queueTail (no processing empty/ghost mappings)
            if (queueHead >= queueTail) break;

            QueueEntry memory entry = queue[queueHead];

            // Convert shares to current token value (includes yield earned while queued)
            uint256 okuUsdAmount = okuUsd.sharesToTokens(entry.shares);

            // Convert OkuUSD (18 decimals) to USDC amount (6 decimals)
            uint256 usdcAmount = okuUsdAmount / DECIMAL_MULTIPLIER;

            if (usdcBalance >= usdcAmount) {
                // Self-burn OkuUSD held by queue (Circle model)
                okuUsd.burn(okuUsdAmount);

                // Transfer USDC to user (1:1 value, converted for decimals)
                usdc.safeTransferFrom(msg.sender, entry.user, usdcAmount);

                totalQueuedShares -= entry.shares;

                emit RedemptionProcessed(entry.user, entry.shares, okuUsdAmount, usdcAmount);

                // Delete processed entry (gas refund)
                delete queue[queueHead];

                usdcBalance -= usdcAmount;
                queueHead++;
                processed++;
            } else {
                break;
            }
        }
    }

    /**
     * @notice Get total USDC owed across all pending queue entries
     * @return O(1) calculation via running totalQueuedShares counter
     */
    function totalQueuedUsdc() external view returns (uint256) {
        return okuUsd.sharesToTokens(totalQueuedShares) / DECIMAL_MULTIPLIER;
    }

    /**
     * @notice Get queue length
     */
    function queueLength() external view returns (uint256) {
        return queueTail - queueHead;
    }

    /**
     * @notice Get queue entry at index
     */
    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        require(index >= queueHead && index < queueTail, "Invalid index");
        return queue[index];
    }

    /**
     * @notice Get current token value for a queue entry (includes accrued yield)
     * @param index Queue index
     * @return Current OkuUSD token value of the queued shares
     */
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        require(index >= queueHead && index < queueTail, "Invalid index");
        return okuUsd.sharesToTokens(queue[index].shares);
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}
}
