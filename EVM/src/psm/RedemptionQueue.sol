// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {MathLib} from "../lib/MathLib.sol";
import {RedemptionQueueEvents} from "../lib/events/RedemptionQueueEvents.sol";

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuMoney redemptions when PSM buffer is depleted
 * @dev Stores OkuM token amounts (not shares — OkuMoney is non-rebasing).
 *      Queued OkuM tokens do not grow in balance, but appreciate via okuMMultiplier().
 *      When the queue processes, the user receives USDC based on okuMAmount * okuMMultiplier()
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
 *      Decimal flexibility: like LitePSM, the USDC-side decimal multiplier is computed at
 *      init time from `IERC20Metadata(usdc).decimals()` and stored on the proxy so the
 *      queue can run on chains shipping a non-6-decimal USDC variant.
 *
 *      See Constants.sol for terminology legend.
 *
 *      Storage: Uses ERC-7201 namespaced storage pattern for upgrade safety.
 *      Taken from https://eips.ethereum.org/EIPS/eip-7201
 */
contract RedemptionQueue is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    RedemptionQueueEvents
{
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
        // USDC reference + per-deployment decimal multiplier resolved at init from
        // IERC20Metadata(usdc).decimals(). For Circle USDC (6 decimals) the multiplier is 1e12.
        IERC20 usdc;
        uint256 usdcDecimalMultiplier;
    }

    // ERC-7201 storage slot — Taken from https://eips.ethereum.org/EIPS/eip-7201
    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.RedemptionQueue")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REDEMPTIONQUEUE_STORAGE_LOCATION =
        0xa62273ae8f4f9b4de76a6f11e9bbf5ca0a9c42e1f4bbbcb4369e173f90b6e000;

    function _getRedemptionQueueStorage() private pure returns (RedemptionQueueStorage storage $) {
        assembly {
            $.slot := REDEMPTIONQUEUE_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    error ZeroAddress();
    error StartBelowHead();
    error EndAboveTail();
    error InvalidIndex();
    error EntryAlreadyCleared();
    /// @dev `processQueue` was called with a USDC token address that does not match
    ///      the one configured at init. Prevents accidental cross-token settlement.
    error UsdcMismatch(address provided, address expected);
    /// @dev USDC reports more decimals than supported (>18).
    error UsdcDecimalsTooLarge(uint8 reported);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the queue proxy.
     * @param _okuMoney OkuMoney token address
     * @param _usdc USDC token address (must implement IERC20Metadata.decimals()).
     *        Must match the USDC configured on the LitePSM that will operate this queue.
     * @param admin Admin address (receives upgrader/rescuer roles; NOT QUEUE_PSM)
     */
    function initialize(address _okuMoney, address _usdc, address admin) public initializer {
        if (_okuMoney == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();

        __AccessControl_init();

        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.usdc = IERC20(_usdc);

        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));

        // Grant the upgrader / rescuer roles to admin (see OkuMoney.initialize for the
        // unified policy). QUEUE_PSM is intentionally NOT granted here — it must be
        // granted post-deployment to the LitePSM proxy address to avoid a circular
        // deployment dependency. Granting it to admin would let admin bypass the PSM
        // entirely and call enqueue/processQueue directly.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.QUEUE_UPGRADER, admin);
        _grantRole(Roles.QUEUE_RESCUER, admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() public view returns (IOkuMoney) {
        return _getRedemptionQueueStorage().okuMoney;
    }

    function usdc() public view returns (IERC20) {
        return _getRedemptionQueueStorage().usdc;
    }

    function usdcDecimalMultiplier() public view returns (uint256) {
        return _getRedemptionQueueStorage().usdcDecimalMultiplier;
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
    function enqueue(address user, uint256 okuMTokenAmount) external onlyRole(Roles.QUEUE_PSM) {
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
     * @param usdcToken USDC token address (must match the USDC configured at init)
     * @dev Multiplier-aware: USDC output = okuMAmount * okuMMultiplier() / PRECISION (scaled to USDC decimals).
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
        address usdcToken
    )
        external
        onlyRole(Roles.QUEUE_PSM)
    {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (startIndex < $.queueHead) revert StartBelowHead();
        if (endIndex > $.queueTail) revert EndAboveTail();
        if (usdcToken != address($.usdc)) revert UsdcMismatch(usdcToken, address($.usdc));

        IERC20 usdcContract = IERC20(usdcToken);
        uint256 usdcBalance = usdcContract.balanceOf(msg.sender);
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        // Cache multiplier once — consistent within a block, avoids repeated external calls
        uint256 cachedMult = $.okuMoney.okuMMultiplier();

        for (uint256 i = startIndex; i < endIndex; i++) {
            QueueEntry memory entry = $.queue[i];

            if (entry.user == address(0)) {
                // Already processed/deleted or rescued
                emit RedemptionSkipped(i, RedemptionSkipReason.AlreadyCleared);
                continue;
            }

            // Multiplier-aware: dollarValue = okuMAmount * cachedMult / PRECISION
            uint256 dollarValue18 = MathLib.okuMToDollars(entry.okuMAmount, cachedMult);

            // Convert to USDC native decimals
            uint256 usdcAmount = MathLib.dollarsToUsdc(dollarValue18, decimalMultiplier);

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
     *      Operator flow: identify stuck entry -> rescueQueueEntry(index, recipient) -> processQueue
     *
     * @param index Queue index to rescue
     * @param alternateRecipient Address to receive the OkuMoney (can be the original user or another)
     */
    function rescueQueueEntry(
        uint256 index,
        address alternateRecipient
    )
        external
        onlyRole(Roles.QUEUE_RESCUER)
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
        return MathLib.dollarsToUsdc(dollarValue18, $.usdcDecimalMultiplier);
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
        onlyRole(Roles.QUEUE_UPGRADER)
    {}
}
