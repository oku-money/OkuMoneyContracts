// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuNote} from "../interfaces/IOkuNote.sol";

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuNote redemptions when PSM buffer is depleted
 * @dev Stores note token amounts (not shares — OkuNote is non-rebasing).
 *      Queued note tokens do not grow in balance, but appreciate in price via notePrice().
 *      When the queue processes, the user receives USDC based on noteAmount × notePrice()
 *      at processing time. The economic result is that users earn yield while queued
 *      through price appreciation rather than balance growth.
 *
 *      Tokens are transferred into the queue by the PSM before enqueue() is called;
 *      enqueue() is record-only and does not pull tokens from the user.
 */
contract RedemptionQueue is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuNote is 18 decimals)
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // 18 - 6 = 12
    uint256 private constant PRECISION = 1e18;

    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant PSM = keccak256("PSM");

    struct QueueEntry {
        address user;
        uint256 noteAmount; // Raw note token amount (non-rebasing, appreciates via notePrice)
        uint256 timestamp;
    }

    mapping(uint256 => QueueEntry) public queue;
    uint256 public queueHead;
    uint256 public queueTail;

    /// @notice Running counter of note tokens queued (O(1) totalQueuedUsdc)
    uint256 public totalQueuedNotes;

    IOkuNote public okuNote;

    // Events
    event RedemptionQueued(address indexed user, uint256 noteAmount, uint256 position);
    event RedemptionProcessed(address indexed user, uint256 noteAmount, uint256 usdcAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _okuNote, address admin) public initializer {
        __AccessControl_init();

        okuNote = IOkuNote(_okuNote);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
    }

    // ============ Queue Management ============

    /**
     * @notice Record a redemption in the queue
     * @param user User requesting redemption
     * @param noteTokenAmount Amount of OkuNote tokens to redeem
     * @dev Tokens must already be in this contract before calling (PSM transfers them first).
     *      This function is record-only: it stores the raw note amount and pushes an entry.
     */
    function enqueue(address user, uint256 noteTokenAmount) external onlyRole(PSM) {
        uint256 position = queueTail;
        queue[position] =
            QueueEntry({user: user, noteAmount: noteTokenAmount, timestamp: block.timestamp});
        queueTail = position + 1;
        totalQueuedNotes += noteTokenAmount;

        emit RedemptionQueued(user, noteTokenAmount, position);
    }

    /**
     * @notice Process queued redemptions within an index range
     * @param startIndex First queue index to process (inclusive)
     * @param endIndex Last queue index to process (exclusive)
     * @param usdcToken USDC token address
     * @param - OkuNote token address (unused, kept for interface compat)
     * @dev Price-aware: USDC output = noteAmount × notePrice() / PRECISION (scaled to 6 decimals).
     *      Allows operator to skip blocked entries (e.g., USDC-blacklisted users).
     *      Entries are deleted after processing. queueHead advances past consecutive
     *      deleted entries at the front of the queue.
     */
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        address usdcToken,
        address /* okuNoteToken */
    )
        external
        onlyRole(PSM)
    {
        require(startIndex >= queueHead, "Start below head");
        require(endIndex <= queueTail, "End above tail");

        IERC20 usdc = IERC20(usdcToken);
        uint256 usdcBalance = usdc.balanceOf(msg.sender);

        for (uint256 i = startIndex; i < endIndex && usdcBalance > 0; i++) {
            QueueEntry memory entry = queue[i];
            if (entry.user == address(0)) continue; // Already processed/deleted

            // Price-aware: dollarValue = noteAmount × notePrice / PRECISION
            uint256 price = okuNote.notePrice();
            uint256 dollarValue18 = (entry.noteAmount * price) / PRECISION;

            // Convert to USDC (6 decimals)
            uint256 usdcAmount = dollarValue18 / DECIMAL_MULTIPLIER;

            if (usdcBalance < usdcAmount) break;

            // Burn note tokens held by queue
            okuNote.burn(entry.noteAmount);

            // Transfer USDC to user (price-aware value)
            usdc.safeTransferFrom(msg.sender, entry.user, usdcAmount);

            totalQueuedNotes -= entry.noteAmount;

            emit RedemptionProcessed(entry.user, entry.noteAmount, usdcAmount);

            delete queue[i];
            usdcBalance -= usdcAmount;
        }

        // Advance head past consecutive deleted/processed entries
        while (queueHead < queueTail && queue[queueHead].user == address(0)) {
            queueHead++;
        }
    }

    /**
     * @notice Get total USDC owed across all pending queue entries (price-aware)
     * @return O(1) calculation via running totalQueuedNotes counter and notePrice()
     */
    function totalQueuedUsdc() external view returns (uint256) {
        uint256 dollarValue18 = (totalQueuedNotes * okuNote.notePrice()) / PRECISION;
        return dollarValue18 / DECIMAL_MULTIPLIER;
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
     * @notice Get current dollar value for a queue entry (price-aware)
     * @param index Queue index
     * @return Current dollar value of the queued note tokens (18 decimals)
     */
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        require(index >= queueHead && index < queueTail, "Invalid index");
        return (queue[index].noteAmount * okuNote.notePrice()) / PRECISION;
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}

    // ============ Storage Gap ============

    uint256[45] private __gap;
}
