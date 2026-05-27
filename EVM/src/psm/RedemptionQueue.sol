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
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {RedemptionQueueEvents} from "../lib/events/RedemptionQueueEvents.sol";
import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuMoney redemptions when the PSM buffer is depleted.
 * @dev Stores OkuM token amounts (not shares — OkuMoney is non-rebasing).
 *      Queued OkuM tokens do not grow in balance, but appreciate via okuMMultiplier().
 *      When the queue processes, the user receives USDC based on
 *      okuMAmount * okuMMultiplier() at processing time. Users earn yield while queued
 *      via multiplier appreciation rather than balance growth.
 *
 *      Tokens are transferred into the queue by the PSM before `enqueue` is called;
 *      `enqueue` is record-only and does not pull tokens from the user.
 *
 *      If a queue entry becomes permanently unprocessable (e.g., USDC-blacklisted recipient),
 *      QUEUE_RESCUER can call `rescueQueueEntry` to return the OkuMoney to the original
 *      user or an alternate address and clear the slot. Operators should rescue any stuck
 *      entries before running `processQueue` over that range.
 *
 *      Decimal flexibility: like LitePSM, the USDC-side decimal multiplier is computed at
 *      init from `IERC20Metadata(usdc).decimals()` and stored on the proxy.
 *
 *      See Constants.sol for terminology legend.
 *      See {OkuMoney.initialize} for the unified role-grant policy.
 */
contract RedemptionQueue is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
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

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.RedemptionQueue")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REDEMPTIONQUEUE_STORAGE_LOCATION =
        0xa62273ae8f4f9b4de76a6f11e9bbf5ca0a9c42e1f4bbbcb4369e173f90b6e000;

    function _getRedemptionQueueStorage() private pure returns (RedemptionQueueStorage storage $) {
        assembly {
            $.slot := REDEMPTIONQUEUE_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress) live in lib/Errors.sol.
    error StartBelowHead();
    error EndAboveTail();
    error InvalidIndex();
    error EntryAlreadyCleared();
    /// @dev USDC reports more decimals than supported (>18).
    error UsdcDecimalsTooLarge(uint8 reported);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the queue proxy.
    /// @param _okuMoney OkuMoney token address
    /// @param _usdc USDC token address (must implement IERC20Metadata.decimals()).
    ///        Must match the USDC configured on the LitePSM that will operate this queue.
    /// @param _admin Admin address (receives upgrader/rescuer roles; NOT QUEUE_PSM)
    function initialize(address _okuMoney, address _usdc, address _admin) public initializer {
        if (_okuMoney == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();

        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        $.okuMoney = IOkuMoney(_okuMoney);
        $.usdc = IERC20(_usdc);

        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        $.usdcDecimalMultiplier =
            10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));

        // QUEUE_PSM is intentionally NOT granted here — it must be granted post-deployment
        // to the LitePSM proxy address to avoid a circular deployment dependency. Granting
        // it to admin would let admin bypass the PSM and call enqueue/processQueue directly.
        // See {OkuMoney.initialize} for the broader role-grant policy.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.QUEUE_UPGRADER, _admin);
        _grantRole(Roles.QUEUE_RESCUER, _admin);
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

    // ============ Queue Management ============

    /// @notice Record a redemption in the queue.
    /// @param user User requesting redemption
    /// @param okuMTokenAmount Amount of OkuMoney tokens to redeem
    /// @dev Tokens must already be in this contract before calling (PSM transfers them first).
    ///      Record-only: stores the raw OkuM amount and pushes an entry.
    function enqueue(address user, uint256 okuMTokenAmount) external onlyRole(Roles.QUEUE_PSM) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        uint256 position = $.queueTail;
        $.queue[position] =
            QueueEntry({user: user, okuMAmount: okuMTokenAmount, timestamp: block.timestamp});
        $.queueTail = position + 1;
        $.totalQueuedOkuM += okuMTokenAmount;

        uint256 dollarValue = MathLib.okuMToDollars(okuMTokenAmount, $.okuMoney.okuMMultiplier());
        uint256 currentQueueLength = $.queueTail - $.queueHead;
        emit RedemptionQueued(user, okuMTokenAmount, dollarValue, position, currentQueueLength);
    }

    /// @notice Process queued redemptions within an index range.
    /// @param startIndex First queue index to process (inclusive)
    /// @param endIndex Last queue index to process (exclusive)
    /// @dev Multiplier-aware: USDC output = okuMAmount * okuMMultiplier / PRECISION (USDC decimals).
    ///      okuMMultiplier is cached once before the loop so all entries in a batch convert at
    ///      the same rate (consistent within a single block; saves gas).
    ///      Stuck entries (e.g., USDC-blacklisted users) should be cleared with
    ///      `rescueQueueEntry` before processing the surrounding range.
    function processQueue(uint256 startIndex, uint256 endIndex)
        external
        nonReentrant
        onlyRole(Roles.QUEUE_PSM)
    {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (startIndex < $.queueHead) revert StartBelowHead();
        if (endIndex > $.queueTail) revert EndAboveTail();

        IERC20 usdcContract = $.usdc;
        uint256 usdcBalance = usdcContract.balanceOf(msg.sender);
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;
        uint256 cachedMult = $.okuMoney.okuMMultiplier();
        // Accumulate decrements in memory; write once after the loop (saves ~2100 gas per
        // additional processed entry vs. an SSTORE on every iteration).
        uint256 totalOkuMDecrement = 0;

        for (uint256 i = startIndex; i < endIndex; i++) {
            QueueEntry memory entry = $.queue[i];

            if (entry.user == address(0)) {
                // Slot was processed in an earlier batch or rescued out.
                emit RedemptionSkipped(i, RedemptionSkipReason.AlreadyCleared);
                continue;
            }

            uint256 dollarValue18 = MathLib.okuMToDollars(entry.okuMAmount, cachedMult);
            uint256 usdcAmount = MathLib.dollarsToUsdc(dollarValue18, decimalMultiplier);

            if (usdcBalance < usdcAmount) {
                emit RedemptionSkipped(i, RedemptionSkipReason.InsufficientFunds);
                break;
            }

            $.okuMoney.burn(entry.okuMAmount);
            usdcContract.safeTransferFrom(msg.sender, entry.user, usdcAmount);
            totalOkuMDecrement += entry.okuMAmount;

            uint256 waitTime = block.timestamp - entry.timestamp;
            emit RedemptionProcessed(
                entry.user, entry.okuMAmount, dollarValue18, usdcAmount, waitTime
            );

            delete $.queue[i];
            usdcBalance -= usdcAmount;
        }

        $.totalQueuedOkuM -= totalOkuMDecrement;
        _advanceHead($);
    }

    /// @notice Return OkuMoney for a stuck queue entry without burning it.
    /// @dev Used when an entry is permanently unprocessable (e.g., recipient is USDC-blacklisted).
    ///      Operator flow: identify stuck entry -> rescueQueueEntry(index, recipient) -> processQueue.
    /// @param index Queue index to rescue
    /// @param alternateRecipient Address to receive the OkuMoney (original user or other)
    function rescueQueueEntry(
        uint256 index,
        address alternateRecipient
    )
        external
        nonReentrant
        onlyRole(Roles.QUEUE_RESCUER)
    {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        if (alternateRecipient == address(0)) revert Errors.ZeroAddress();

        QueueEntry memory entry = $.queue[index];
        if (entry.user == address(0)) revert EntryAlreadyCleared();

        // CEI: update all state before the external transfer.
        $.totalQueuedOkuM -= entry.okuMAmount;
        delete $.queue[index];

        uint256 dollarValue = MathLib.okuMToDollars(entry.okuMAmount, $.okuMoney.okuMMultiplier());
        emit RedemptionRescued(index, entry.user, alternateRecipient, entry.okuMAmount, dollarValue);

        // Transfer OkuMoney back without burning — the user is reclaiming their tokens.
        IERC20(address($.okuMoney)).safeTransfer(alternateRecipient, entry.okuMAmount);
        _advanceHead($);
    }

    /// @dev Advance `queueHead` past any contiguous cleared entries at the front.
    function _advanceHead(RedemptionQueueStorage storage $) private {
        while ($.queueHead < $.queueTail && $.queue[$.queueHead].user == address(0)) {
            $.queueHead++;
        }
    }

    // ============ Views ============

    /// @notice Number of live entries in the queue.
    /// @dev Equal to `queueTail - queueHead`. Because both `processQueue` and
    ///      `rescueQueueEntry` advance `queueHead` past contiguous cleared slots, the
    ///      result is exact (not an upper bound).
    function queueLength() external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        return $.queueTail - $.queueHead;
    }

    /// @notice Total USDC owed across all pending queue entries (multiplier-aware).
    /// @dev O(1) calculation via running totalQueuedOkuM counter and okuMMultiplier().
    function totalQueuedUsdc() external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        uint256 dollarValue18 =
            MathLib.okuMToDollars($.totalQueuedOkuM, $.okuMoney.okuMMultiplier());
        return MathLib.dollarsToUsdc(dollarValue18, $.usdcDecimalMultiplier);
    }

    /// @notice Queue entry at `index` (bounds-checked).
    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        return $.queue[index];
    }

    /// @notice Current dollar value (18 decimals) for a queue entry (multiplier-aware).
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
