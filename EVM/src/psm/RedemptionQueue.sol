// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuMoney redemptions when PSM buffer is depleted
 * @dev Stores OkuM token amounts (not shares — OkuMoney is non-rebasing).
 *      Queued OkuM tokens do not grow in balance, but appreciate in price via okuMPrice().
 *      When the queue processes, the user receives USDC based on okuMAmount × okuMPrice()
 *      at processing time. The economic result is that users earn yield while queued
 *      through price appreciation rather than balance growth.
 *
 *      Tokens are transferred into the queue by the PSM before enqueue() is called;
 *      enqueue() is record-only and does not pull tokens from the user.
 *
 *      If a queue entry becomes permanently unprocessable (e.g., USDC-blacklisted recipient),
 *      the QUEUE_RESCUER role can call rescueQueueEntry() to return the OkuMoney to the
 *      original user or an alternate address and clear the slot. Operators should call
 *      rescueQueueEntry() on any stuck entries before running processQueue() on that range.
 */
contract RedemptionQueue is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuMoney is 18 decimals)
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // 18 - 6 = 12
    uint256 private constant PRECISION = 1e18;

    // Granular RBAC roles (prefixed with QUEUE_ for consistency)
    bytes32 public constant QUEUE_UPGRADER = keccak256("QUEUE_UPGRADER");
    bytes32 public constant QUEUE_PSM = keccak256("QUEUE_PSM");

    /// @notice Role that can rescue stuck queue entries by returning OkuMoney to an alternate address
    bytes32 public constant QUEUE_RESCUER = keccak256("QUEUE_RESCUER");

    struct QueueEntry {
        address user;
        uint256 okuMAmount; // Raw OkuM token amount (non-rebasing, appreciates via okuMPrice)
        uint256 timestamp;
    }

    mapping(uint256 => QueueEntry) public queue;
    uint256 public queueHead;
    uint256 public queueTail;

    /// @notice Running counter of OkuM tokens queued (O(1) totalQueuedUsdc)
    uint256 public totalQueuedOkuM;

    IOkuMoney public okuMoney;

    // Events
    event RedemptionQueued(address indexed user, uint256 okuMAmount, uint256 position);
    event RedemptionProcessed(address indexed user, uint256 okuMAmount, uint256 usdcAmount);

    /// @notice Emitted when QUEUE_RESCUER returns OkuMoney for a stuck entry
    event RedemptionRescued(
        uint256 indexed index,
        address indexed originalUser,
        address indexed recipient,
        uint256 okuMAmount
    );

    // Custom errors
    error ZeroAddress();
    error StartBelowHead();
    error EndAboveTail();
    error InvalidIndex();
    error EntryAlreadyCleared();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _okuMoney, address admin) public initializer {
        if (_okuMoney == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        __AccessControl_init();

        okuMoney = IOkuMoney(_okuMoney);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(QUEUE_UPGRADER, admin);
        _grantRole(QUEUE_RESCUER, admin);
        // NOTE: QUEUE_PSM role is NOT granted here — must be granted post-deployment to the
        // LitePSM proxy address. This is intentional to avoid a circular dependency
        // at deployment time.
    }

    // ============ Queue Management ============

    /**
     * @notice Record a redemption in the queue
     * @param user User requesting redemption
     * @param okuMTokenAmount Amount of OkuMoney tokens to redeem
     * @dev Tokens must already be in this contract before calling (PSM transfers them first).
     *      This function is record-only: it stores the raw OkuM amount and pushes an entry.
     */
    function enqueue(address user, uint256 okuMTokenAmount) external onlyRole(QUEUE_PSM) {
        uint256 position = queueTail;
        queue[position] =
            QueueEntry({user: user, okuMAmount: okuMTokenAmount, timestamp: block.timestamp});
        queueTail = position + 1;
        totalQueuedOkuM += okuMTokenAmount;

        emit RedemptionQueued(user, okuMTokenAmount, position);
    }

    /**
     * @notice Process queued redemptions within an index range
     * @param startIndex First queue index to process (inclusive)
     * @param endIndex Last queue index to process (exclusive)
     * @param usdcToken USDC token address
     * @param - OkuMoney token address (unused, kept for interface compat)
     * @dev Price-aware: USDC output = okuMAmount × okuMPrice() / PRECISION (scaled to 6 decimals).
     *      okuMPrice() is cached once before the loop — all entries in a batch are converted at
     *      the same price, which is consistent within a single block and saves gas.
     *      Allows operator to skip blocked entries (e.g., USDC-blacklisted users) by calling
     *      rescueQueueEntry() first, then processing the cleared range.
     *      Entries are deleted after processing. queueHead advances past consecutive
     *      deleted entries at the front of the queue.
     */
    function processQueue(
        uint256 startIndex,
        uint256 endIndex,
        address usdcToken,
        address /* okuMoneyToken */
    )
        external
        onlyRole(QUEUE_PSM)
    {
        if (startIndex < queueHead) revert StartBelowHead();
        if (endIndex > queueTail) revert EndAboveTail();

        IERC20 usdc = IERC20(usdcToken);
        uint256 usdcBalance = usdc.balanceOf(msg.sender);

        // Cache price once — consistent within a block, avoids repeated external calls
        uint256 cachedPrice = okuMoney.okuMPrice();

        for (uint256 i = startIndex; i < endIndex && usdcBalance > 0; i++) {
            QueueEntry memory entry = queue[i];
            if (entry.user == address(0)) continue; // Already processed/deleted or rescued

            // Price-aware: dollarValue = okuMAmount × cachedPrice / PRECISION
            uint256 dollarValue18 = (entry.okuMAmount * cachedPrice) / PRECISION;

            // Convert to USDC (6 decimals)
            uint256 usdcAmount = dollarValue18 / DECIMAL_MULTIPLIER;

            if (usdcBalance < usdcAmount) break;

            // Burn OkuM tokens held by queue
            okuMoney.burn(entry.okuMAmount);

            // Transfer USDC to user (price-aware value)
            usdc.safeTransferFrom(msg.sender, entry.user, usdcAmount);

            totalQueuedOkuM -= entry.okuMAmount;

            emit RedemptionProcessed(entry.user, entry.okuMAmount, usdcAmount);

            delete queue[i];
            usdcBalance -= usdcAmount;
        }

        // Advance head past consecutive deleted/processed entries
        while (queueHead < queueTail && queue[queueHead].user == address(0)) {
            queueHead++;
        }
    }

    /**
     * @notice Return OkuMoney for a stuck queue entry without burning it
     * @dev Used when an entry is permanently unprocessable (e.g., recipient is USDC-blacklisted).
     *      Transfers the queued OkuMoney back to the original user or an alternate address,
     *      then deletes the entry and advances queueHead if possible.
     *
     *      Operator flow: identify stuck entry → rescueQueueEntry(index, recipient) → processQueue
     *
     * @param index Queue index to rescue
     * @param alternateRecipient Address to receive the OkuMoney (can be the original user or another)
     */
    function rescueQueueEntry(
        uint256 index,
        address alternateRecipient
    )
        external
        onlyRole(QUEUE_RESCUER)
    {
        if (index < queueHead || index >= queueTail) revert InvalidIndex();
        if (alternateRecipient == address(0)) revert ZeroAddress();

        QueueEntry memory entry = queue[index];
        if (entry.user == address(0)) revert EntryAlreadyCleared();

        // Transfer OkuMoney back — do not burn, the user is reclaiming their tokens
        IERC20(address(okuMoney)).safeTransfer(alternateRecipient, entry.okuMAmount);

        totalQueuedOkuM -= entry.okuMAmount;

        emit RedemptionRescued(index, entry.user, alternateRecipient, entry.okuMAmount);

        delete queue[index];

        // Advance head past any contiguous cleared entries at the front
        while (queueHead < queueTail && queue[queueHead].user == address(0)) {
            queueHead++;
        }
    }

    /**
     * @notice Get total USDC owed across all pending queue entries (price-aware)
     * @return O(1) calculation via running totalQueuedOkuM counter and okuMPrice()
     */
    function totalQueuedUsdc() external view returns (uint256) {
        uint256 dollarValue18 = (totalQueuedOkuM * okuMoney.okuMPrice()) / PRECISION;
        return dollarValue18 / DECIMAL_MULTIPLIER;
    }

    /**
     * @notice Get queue upper bound (includes any rescued/processed slots not yet past head)
     * @dev This is an approximation. Use off-chain iteration for an exact live-entry count.
     */
    function queueUpperBound() external view returns (uint256) {
        return queueTail - queueHead;
    }

    /**
     * @notice Get queue entry at index
     */
    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        if (index < queueHead || index >= queueTail) revert InvalidIndex();
        return queue[index];
    }

    /**
     * @notice Get current dollar value for a queue entry (price-aware)
     * @param index Queue index
     * @return Current dollar value of the queued OkuM tokens (18 decimals)
     */
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        if (index < queueHead || index >= queueTail) revert InvalidIndex();
        return (queue[index].okuMAmount * okuMoney.okuMPrice()) / PRECISION;
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(QUEUE_UPGRADER)
    {}

    // ============ Storage Gap ============

    /**
     * Storage layout:
     * - queue mapping: 1 slot (mapping head)
     * - queueHead: 1 slot
     * - queueTail: 1 slot
     * - totalQueuedOkuM: 1 slot
     * - okuMoney: 1 slot
     * Total: 5 slots used
     * Gap: 50 - 5 = 45 slots
     */
    uint256[45] private __gap;
}
