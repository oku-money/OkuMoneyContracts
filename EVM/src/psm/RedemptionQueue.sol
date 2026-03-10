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
 */
contract RedemptionQueue is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // Decimal conversion constant (USDC is 6 decimals, OkuMoney is 18 decimals)
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // 18 - 6 = 12
    uint256 private constant PRECISION = 1e18;

    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant PSM = keccak256("PSM");

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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _okuMoney, address admin) public initializer {
        __AccessControl_init();

        okuMoney = IOkuMoney(_okuMoney);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER, admin);
    }

    // ============ Queue Management ============

    /**
     * @notice Record a redemption in the queue
     * @param user User requesting redemption
     * @param okuMTokenAmount Amount of OkuMoney tokens to redeem
     * @dev Tokens must already be in this contract before calling (PSM transfers them first).
     *      This function is record-only: it stores the raw OkuM amount and pushes an entry.
     */
    function enqueue(address user, uint256 okuMTokenAmount) external onlyRole(PSM) {
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
     *      Allows operator to skip blocked entries (e.g., USDC-blacklisted users).
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
        onlyRole(PSM)
    {
        require(startIndex >= queueHead, "Start below head");
        require(endIndex <= queueTail, "End above tail");

        IERC20 usdc = IERC20(usdcToken);
        uint256 usdcBalance = usdc.balanceOf(msg.sender);

        for (uint256 i = startIndex; i < endIndex && usdcBalance > 0; i++) {
            QueueEntry memory entry = queue[i];
            if (entry.user == address(0)) continue; // Already processed/deleted

            // Price-aware: dollarValue = okuMAmount × okuMPrice / PRECISION
            uint256 price = okuMoney.okuMPrice();
            uint256 dollarValue18 = (entry.okuMAmount * price) / PRECISION;

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
     * @notice Get total USDC owed across all pending queue entries (price-aware)
     * @return O(1) calculation via running totalQueuedOkuM counter and okuMPrice()
     */
    function totalQueuedUsdc() external view returns (uint256) {
        uint256 dollarValue18 = (totalQueuedOkuM * okuMoney.okuMPrice()) / PRECISION;
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
     * @return Current dollar value of the queued OkuM tokens (18 decimals)
     */
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        require(index >= queueHead && index < queueTail, "Invalid index");
        return (queue[index].okuMAmount * okuMoney.okuMPrice()) / PRECISION;
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER) {}

    // ============ Storage Gap ============

    uint256[45] private __gap;
}
