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
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {MathLib} from "../lib/MathLib.sol";

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuMoney redemptions when PSM buffer is depleted
 * @dev Stores OkuM token amounts (not shares — OkuMoney is non-rebasing).
 *      Queued OkuM tokens do not grow in balance, but appreciate via okuMMultiplier().
 *      When the queue processes, the user receives USDC based on okuMAmount × okuMMultiplier()
 *      at processing time. The economic result is that users earn yield while queued
 *      through multiplier appreciation rather than balance growth.
 *
 *      Tokens are transferred into the queue by the PSM before enqueue() is called;
 *      enqueue() is record-only and does not pull tokens from the user.
 *
 *      If a queue entry becomes permanently unprocessable (e.g., USDC-blacklisted recipient),
 *      the QUEUE_RESCUER role can call rescueQueueEntry() to return the OkuMoney to the
 *      original user or an alternate address and clear the slot. Operators should call
 *      rescueQueueEntry() on any stuck entries before running processQueue() on that range.
 *
 *      See Constants.sol for terminology legend.
 *
 *      Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 */
contract RedemptionQueue is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ============ ERC-7201 Namespaced Storage ============

    struct QueueEntry {
        address user;
        uint256 okuMAmount; // Raw OkuM token amount (non-rebasing, appreciates via okuMMultiplier)
        uint256 timestamp;
    }

    /// @custom:storage-location erc7201:okumoney.storage.RedemptionQueue
    struct RedemptionQueueStorage {
        mapping(uint256 => QueueEntry) queue;
        uint256 queueHead;
        uint256 queueTail;
        uint256 totalQueuedOkuM;
        IOkuMoney okuMoney;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.RedemptionQueue")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REDEMPTIONQUEUE_STORAGE_LOCATION =
        0x4e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e00;

    function _getRedemptionQueueStorage() private pure returns (RedemptionQueueStorage storage $) {
        assembly {
            $.slot := REDEMPTIONQUEUE_STORAGE_LOCATION
        }
    }

    // ============ Constants (from shared library) ============

    uint256 private constant DECIMAL_MULTIPLIER = Constants.DECIMAL_MULTIPLIER;
    uint256 private constant PRECISION = Constants.PRECISION;

    // ============ Role Constants (from shared library) ============

    bytes32 public constant QUEUE_UPGRADER = Roles.QUEUE_UPGRADER;
    bytes32 public constant QUEUE_PSM = Roles.QUEUE_PSM;
    bytes32 public constant QUEUE_RESCUER = Roles.QUEUE_RESCUER;

    // ============ Events ============

    /// @notice Emitted when a redemption is added to the queue
    /// @param user Address requesting redemption
    /// @param okuMAmount OkuMoney queued (18 decimals)
    /// @param dollarValue Dollar value at time of queuing (18 decimals)
    /// @param position Queue position (index)
    /// @param queueLength Total entries in queue after this addition
    event RedemptionQueued(
        address indexed user,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 position,
        uint256 queueLength
    );

    /// @notice Emitted when a queued redemption is processed
    /// @param user Address receiving USDC
    /// @param okuMAmount OkuMoney burned (18 decimals)
    /// @param dollarValue Dollar value at processing time (18 decimals)
    /// @param usdcAmount USDC transferred (6 decimals)
    /// @param waitTime Seconds between queuing and processing
    event RedemptionProcessed(
        address indexed user,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 usdcAmount,
        uint256 waitTime
    );

    /// @notice Emitted when processQueue skips a cleared/rescued entry
    event RedemptionSkipped(uint256 indexed index, RedemptionSkipReason reason);

    /// @notice Emitted when QUEUE_RESCUER returns OkuMoney for a stuck entry
    /// @param index Queue position of rescued entry
    /// @param originalUser Original requester
    /// @param recipient Address receiving the OkuMoney
    /// @param okuMAmount OkuMoney returned
    /// @param dollarValue Dollar value at rescue time
    event RedemptionRescued(
        uint256 indexed index,
        address indexed originalUser,
        address indexed recipient,
        uint256 okuMAmount,
        uint256 dollarValue
    );

    // ============ Enums ============

    enum RedemptionSkipReason {
        AlreadyCleared, // Entry was previously processed or rescued
        InsufficientFunds // Not enough USDC to process this entry
    }

    // ============ Custom Errors ============

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

        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        $.okuMoney = IOkuMoney(_okuMoney);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(QUEUE_UPGRADER, admin);
        _grantRole(QUEUE_RESCUER, admin);
        // NOTE: QUEUE_PSM role is NOT granted here — must be granted post-deployment to the
        // LitePSM proxy address. This is intentional to avoid a circular dependency
        // at deployment time.
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getRedemptionQueueStorage().okuMoney;
    }

    function queueHead() public view returns (uint256) {
        return _getRedemptionQueueStorage().queueHead;
    }

    function queueTail() public view returns (uint256) {
        return _getRedemptionQueueStorage().queueTail;
    }

    function totalQueuedOkuM() public view returns (uint256) {
        return _getRedemptionQueueStorage().totalQueuedOkuM;
    }

    function queue(uint256 index) public view returns (QueueEntry memory) {
        return _getRedemptionQueueStorage().queue[index];
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
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        uint256 position = $.queueTail;
        $.queue[position] =
            QueueEntry({user: user, okuMAmount: okuMTokenAmount, timestamp: block.timestamp});
        $.queueTail = position + 1;
        $.totalQueuedOkuM += okuMTokenAmount;

        uint256 dollarValue = MathLib.okuMToDollars(okuMTokenAmount, $.okuMoney.okuMMultiplier());
        uint256 queueLength = $.queueTail - $.queueHead;
        emit RedemptionQueued(user, okuMTokenAmount, dollarValue, position, queueLength);
    }

    /**
     * @notice Process queued redemptions within an index range
     * @param startIndex First queue index to process (inclusive)
     * @param endIndex Last queue index to process (exclusive)
     * @param usdcToken USDC token address
     * @param - OkuMoney token address (unused, kept for interface compat)
     * @dev Multiplier-aware: USDC output = okuMAmount × okuMMultiplier() / PRECISION (scaled to 6 decimals).
     *      okuMMultiplier() is cached once before the loop — all entries in a batch are converted at
     *      the same multiplier, which is consistent within a single block and saves gas.
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
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (startIndex < $.queueHead) revert StartBelowHead();
        if (endIndex > $.queueTail) revert EndAboveTail();

        IERC20 usdcContract = IERC20(usdcToken);
        uint256 usdcBalance = usdcContract.balanceOf(msg.sender);

        // Cache multiplier once — consistent within a block, avoids repeated external calls
        uint256 cachedMult = $.okuMoney.okuMMultiplier();

        for (uint256 i = startIndex; i < endIndex; i++) {
            QueueEntry memory entry = $.queue[i];

            if (entry.user == address(0)) {
                // Already processed/deleted or rescued
                emit RedemptionSkipped(i, RedemptionSkipReason.AlreadyCleared);
                continue;
            }

            // Multiplier-aware: dollarValue = okuMAmount × cachedMult / PRECISION
            uint256 dollarValue18 = MathLib.okuMToDollars(entry.okuMAmount, cachedMult);

            // Convert to USDC (6 decimals)
            uint256 usdcAmount = MathLib.dollarsToUsdc(dollarValue18);

            if (usdcBalance < usdcAmount) {
                emit RedemptionSkipped(i, RedemptionSkipReason.InsufficientFunds);
                break;
            }

            // Burn OkuM tokens held by queue
            $.okuMoney.burn(entry.okuMAmount);

            // Transfer USDC to user (multiplier-aware value)
            usdcContract.safeTransferFrom(msg.sender, entry.user, usdcAmount);

            $.totalQueuedOkuM -= entry.okuMAmount;

            uint256 waitTime = block.timestamp - entry.timestamp;
            emit RedemptionProcessed(
                entry.user, entry.okuMAmount, dollarValue18, usdcAmount, waitTime
            );

            delete $.queue[i];
            usdcBalance -= usdcAmount;
        }

        // Advance head past consecutive deleted/processed entries
        while ($.queueHead < $.queueTail && $.queue[$.queueHead].user == address(0)) {
            $.queueHead++;
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
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        if (alternateRecipient == address(0)) revert ZeroAddress();

        QueueEntry memory entry = $.queue[index];
        if (entry.user == address(0)) revert EntryAlreadyCleared();

        // Transfer OkuMoney back — do not burn, the user is reclaiming their tokens
        IERC20(address($.okuMoney)).safeTransfer(alternateRecipient, entry.okuMAmount);

        $.totalQueuedOkuM -= entry.okuMAmount;

        uint256 dollarValue = MathLib.okuMToDollars(entry.okuMAmount, $.okuMoney.okuMMultiplier());
        emit RedemptionRescued(index, entry.user, alternateRecipient, entry.okuMAmount, dollarValue);

        delete $.queue[index];

        // Advance head past any contiguous cleared entries at the front
        while ($.queueHead < $.queueTail && $.queue[$.queueHead].user == address(0)) {
            $.queueHead++;
        }
    }

    /**
     * @notice Get total USDC owed across all pending queue entries (multiplier-aware)
     * @return O(1) calculation via running totalQueuedOkuM counter and okuMMultiplier()
     */
    function totalQueuedUsdc() external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        uint256 dollarValue18 =
            MathLib.okuMToDollars($.totalQueuedOkuM, $.okuMoney.okuMMultiplier());
        return MathLib.dollarsToUsdc(dollarValue18);
    }

    /**
     * @notice Get queue upper bound (includes any rescued/processed slots not yet past head)
     * @dev This is an approximation. Use off-chain iteration for an exact live-entry count.
     */
    function queueUpperBound() external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        return $.queueTail - $.queueHead;
    }

    /**
     * @notice Get queue entry at index
     */
    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        return $.queue[index];
    }

    /**
     * @notice Get current dollar value for a queue entry (multiplier-aware)
     * @param index Queue index
     * @return Current dollar value of the queued OkuM tokens (18 decimals)
     */
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        return MathLib.okuMToDollars($.queue[index].okuMAmount, $.okuMoney.okuMMultiplier());
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(QUEUE_UPGRADER)
    {}
}
