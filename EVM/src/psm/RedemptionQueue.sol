// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ReentrancyGuardUpgradeable} from "../lib/ReentrancyGuardUpgradeable.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {MathLib} from "../lib/MathLib.sol";
import {Roles} from "../lib/Roles.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";

/**
 * @dev The slice of `SubscriptionModule` the queue needs.
 *
 * A minimal local interface rather than importing `SubscriptionModule`: the queue is
 * deployed first and the PSM cross-asserts against it, so a hard dependency
 * back would be circular. `QUEUE_PSM` is granted only to the PSM proxy, so
 * `msg.sender` in `processQueue` is always that contract.
 */
interface IModuleFees {
    function tout() external view returns (uint256);
}

/**
 * @title RedemptionQueue
 * @notice FIFO queue for OkuM redemptions when the PSM's USDC buffer is depleted.
 *
 * @dev Stores **raw** OkuM. Because raw balances are fixed, queued amounts do
 *      not grow in count — but they appreciate in dollar value via the
 *      multiplier, so a user waiting in the queue continues to earn yield. At
 *      processing, `usdcAmount = rawAmount * uiMultiplier() / PRECISION` scaled
 *      to USDC decimals, with the multiplier cached once per batch for gas and
 *      cross-entry consistency.
 *
 *      Deliberately NOT `Pausable`: pause lives at the SubscriptionModule layer. Pausing
 *      here would lock users into the queue.
 *
 *      Storage uses ERC-7201 namespaced storage.
 */
contract RedemptionQueue is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ Types ============

    /// @dev TWO SLOTS, packed. Field order here is load-bearing, not stylistic.
    ///
    ///      slot 0:  user (160) + toutBps (16) + timestamp (48)  = 224 bits
    ///      slot 1:  rawAmount (128)
    ///
    ///      Was three slots (`address` + `uint16` + two full words). Packing
    ///      saves one `SSTORE` per `enqueue`, ~20k gas, on the path a user hits
    ///      precisely when the buffer is empty and they are already having a bad
    ///      day.
    ///
    ///      DONE NOW BECAUSE IT IS FREE NOW. This is a storage-layout change on
    ///      a UUPS proxy with no live state; after the first mainnet deploy it
    ///      stops being a refactor and becomes a migration.
    ///
    ///      WIDTHS, and why each is safe rather than merely plausible:
    ///
    ///      - `rawAmount` at `uint128` caps a single entry at ~3.4e38, against
    ///        `Constants.MAX_TOTAL_SUPPLY` of 1e33. No entry can exceed total
    ///        supply, so the bound is unreachable by construction and needs no
    ///        check in `enqueue` — asserted in `RedemptionQueueTest`. `uint96`
    ///        was the obvious choice and is WRONG: it maxes at ~7.9e28, below
    ///        `MAX_TOTAL_SUPPLY`, so it would have introduced a real ceiling
    ///        requiring a new revert path.
    ///      - `timestamp` at `uint48` overflows in year ~8.9 million.
    ///      - `toutBps` at `uint16` holds 65535 against a `MAX_FEE_BPS` of 100.
    struct QueueEntry {
        address user;
        /// @dev The `tout` (bps) prevailing when this entry was enqueued.
        ///
        ///      Snapshotted rather than read at processing time so a later fee
        ///      change cannot retroactively tax users already waiting — they were
        ///      quoted this rate when they joined.
        uint16 toutBps;
        /// @dev Enqueue time. Packed into slot 0 alongside `user`/`toutBps`.
        uint48 timestamp;
        /// @dev Raw OkuM escrowed. See the width note above.
        uint128 rawAmount;
    }

    /// @notice Why `processQueue` skipped an entry without clearing it.
    enum RedemptionSkipReason {
        AlreadyCleared,
        InsufficientFunds,
        TransferFailed
    }

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.RedemptionQueueV2
    struct RedemptionQueueStorage {
        mapping(uint256 => QueueEntry) queue;
        uint256 queueHead;
        uint256 queueTail;
        uint256 totalQueuedRaw;
        IOkuM okuM;
        IERC20 usdc;
        uint256 usdcDecimalMultiplier;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.RedemptionQueueV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REDEMPTION_QUEUE_STORAGE_LOCATION =
        0x6fb684f02919148f6d51ad47eb3d75c08306ce92047d0ad2154c86329afe9d00;

    function _getRedemptionQueueStorage() private pure returns (RedemptionQueueStorage storage $) {
        assembly {
            $.slot := REDEMPTION_QUEUE_STORAGE_LOCATION
        }
    }

    // ============ Errors ============

    error InvalidIndex();
    error EntryAlreadyCleared();
    error UsdcDecimalsTooLarge(uint8 reported);
    /// @notice The supplied USDC does not match `okuM.asset()`.
    /// @dev Fail-fast on the misconfiguration that would otherwise produce
    ///      silently divergent pricing between the token's value views and this
    ///      contract's payouts.
    error AssetMismatch(address expected, address supplied);
    /// @notice The locally-derived decimal multiplier disagrees with the token's.
    error DecimalMultiplierMismatch(uint256 expected, uint256 derived);
    /// @notice `sweepExcess` was called with no donated surplus to sweep.
    error NoExcessToSweep();
    /// @notice Supplied `toutBps` exceeds `MAX_FEE_BPS`.
    error FeeAboveMaximum(uint256 requested, uint256 maximum);

    // ============ Events ============

    event RedemptionQueued(
        uint256 indexed index, address indexed user, uint256 rawAmount, uint256 uiAmount
    );
    event RedemptionProcessed(
        address indexed user,
        uint256 rawAmount,
        uint256 uiAmount,
        uint256 usdcAmount,
        uint256 waitTime
    );
    event RedemptionSkipped(uint256 indexed index, RedemptionSkipReason reason);
    event RedemptionRescued(
        uint256 indexed index,
        address indexed user,
        address indexed recipient,
        uint256 rawAmount,
        uint256 uiAmount
    );
    event QueueHeadAdvanced(uint256 newHead, uint256 advanced);
    /// @notice Donated (non-escrowed) tokens swept out of the contract.
    event ExcessSwept(address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the queue proxy.
    /// @param _okuM The OkuM token.
    /// @param _usdc USDC address. MUST equal `_okuM.asset()`.
    /// @param _admin Receives the queue role set (minus `QUEUE_PSM`).
    /// @dev `QUEUE_PSM` is deliberately NOT granted here — it is granted
    ///      post-deploy to the SubscriptionModule proxy. That avoids a circular dependency
    ///      and stops the deploy admin from calling `enqueue`/`processQueue`
    ///      directly.
    function initialize(address _okuM, address _usdc, address _admin) public initializer {
        if (_okuM == address(0)) revert Errors.ZeroAddress();
        if (_usdc == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();

        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        $.okuM = IOkuM(_okuM);
        $.usdc = IERC20(_usdc);

        // Single source of truth: cross-assert against the token rather than
        // deriving a second, independently-supplied copy of the same constant.
        address tokenAsset = IOkuM(_okuM).asset();
        if (tokenAsset != _usdc) revert AssetMismatch(tokenAsset, _usdc);

        uint8 usdcDecimals = IERC20Metadata(_usdc).decimals();
        if (usdcDecimals > Constants.MAX_USDC_DECIMALS) revert UsdcDecimalsTooLarge(usdcDecimals);
        uint256 derived = 10 ** (uint256(Constants.MAX_USDC_DECIMALS) - uint256(usdcDecimals));
        uint256 expected = IOkuM(_okuM).usdcDecimalMultiplier();
        if (expected != derived) revert DecimalMultiplierMismatch(expected, derived);
        $.usdcDecimalMultiplier = derived;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.QUEUE_UPGRADER, _admin);
        _grantRole(Roles.QUEUE_RESCUER, _admin);
    }

    // ============ Storage accessors ============

    function okuM() external view returns (IOkuM) {
        return _getRedemptionQueueStorage().okuM;
    }

    function usdc() external view returns (IERC20) {
        return _getRedemptionQueueStorage().usdc;
    }

    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getRedemptionQueueStorage().usdcDecimalMultiplier;
    }

    function queueHead() external view returns (uint256) {
        return _getRedemptionQueueStorage().queueHead;
    }

    function queueTail() external view returns (uint256) {
        return _getRedemptionQueueStorage().queueTail;
    }

    /// @notice Total raw OkuM escrowed across all pending entries.
    /// @dev INVARIANT: `totalQueuedRaw <= okuM.balanceOf(address(this))`.
    ///      Stated as `<=`, never `==`: anyone can transfer tokens to this
    ///      address for free, which would permanently break an equality. Donated
    ///      surplus is recoverable via `sweepExcess`.
    function totalQueuedRaw() external view returns (uint256) {
        return _getRedemptionQueueStorage().totalQueuedRaw;
    }

    // ============ Queue operations ============

    /// @notice Record a queued redemption. Record-only.
    /// @dev The PSM transfers the tokens in before calling this.
    /// @param toutBps The redemption fee prevailing now, snapshotted so a later
    ///        fee change cannot retroactively tax this entry. Bounded by
    ///        `MAX_FEE_BPS` at the PSM's `setFees`, re-asserted here because this
    ///        is an external entrypoint and the cast below must not truncate.
    function enqueue(
        address user,
        uint256 rawAmount,
        uint256 toutBps
    )
        external
        onlyRole(Roles.QUEUE_PSM)
        returns (uint256 index)
    {
        if (user == address(0)) revert Errors.ZeroAddress();
        if (rawAmount == 0) revert Errors.ZeroAmount();
        if (toutBps > Constants.MAX_FEE_BPS) {
            revert FeeAboveMaximum(toutBps, Constants.MAX_FEE_BPS);
        }

        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        index = $.queueTail;
        $.queue[index] = QueueEntry({
            user: user,
            // casting to 'uint16' is safe because the bound check above caps
            // `toutBps` at `MAX_FEE_BPS` (100).
            // forge-lint: disable-next-line(unsafe-typecast)
            toutBps: uint16(toutBps),
            // casting to 'uint48' is safe until year ~8.9 million.
            // forge-lint: disable-next-line(unsafe-typecast)
            timestamp: uint48(block.timestamp),
            // casting to 'uint128' is safe because no single entry can exceed
            // total supply, which `Constants.MAX_TOTAL_SUPPLY` caps at 1e33 —
            // some 3.4e5 times below `type(uint128).max`. The invariant is
            // enforced upstream by the supply cap rather than re-checked here;
            // `RedemptionQueueTest` asserts the headroom explicitly.
            // forge-lint: disable-next-line(unsafe-typecast)
            rawAmount: uint128(rawAmount)
        });
        $.queueTail = index + 1;
        $.totalQueuedRaw += rawAmount;

        emit RedemptionQueued(index, user, rawAmount, $.okuM.toUIAmount(rawAmount));
    }

    /// @notice Process queued redemptions over `[startIndex, endIndex)`.
    /// @dev Burns OkuM, pulls USDC from the PSM, pays users. The multiplier is
    ///      read once for the whole batch so every entry in a batch is priced
    ///      identically.
    ///
    ///      Soft-skips (emit + continue) rather than reverting on a cleared entry
    ///      or a failed USDC transfer, so one stuck recipient cannot block the
    ///      queue. Breaks on insufficient PSM funds.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex
    )
        external
        nonReentrant
        onlyRole(Roles.QUEUE_PSM)
    {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        IOkuM token = $.okuM;
        IERC20 usdcToken = $.usdc;
        uint256 decimalMultiplier = $.usdcDecimalMultiplier;

        // Cached once per batch: gas, and cross-entry pricing consistency.
        uint256 multiplier = token.uiMultiplier();
        // `msg.sender` is the SubscriptionModule (QUEUE_PSM is granted only to it), which
        // is where the fee schedule lives. Read once per batch, same as the
        // multiplier.
        uint256 currentTout = IModuleFees(msg.sender).tout();

        address psm = msg.sender;
        uint256 available = usdcToken.balanceOf(psm);
        uint256 totalRawDecrement;

        for (uint256 i = startIndex; i < endIndex; ++i) {
            QueueEntry memory entry = $.queue[i];

            if (entry.user == address(0)) {
                emit RedemptionSkipped(i, RedemptionSkipReason.AlreadyCleared);
                continue;
            }

            uint256 uiAmount = MathLib.toUiAmount(entry.rawAmount, multiplier);
            // Priced at the multiplier now (so the holder keeps the yield they
            // earned while waiting) and at the BETTER of the fee snapshotted
            // when they joined and the fee prevailing now.
            //
            // The snapshot protects them from an increase. Taking the minimum
            // additionally passes on a decrease, so a queued user is never left
            // paying more than someone redeeming instantly beside them. It
            // creates nothing to game — a user cannot influence which is lower,
            // and cannot choose to be queued.
            uint256 effectiveTout = _effectiveTout(entry.toutBps, currentTout);
            uint256 usdcAmount =
                MathLib.applyFee(MathLib.dollarsToUsdc(uiAmount, decimalMultiplier), effectiveTout);

            if (usdcAmount > available) {
                emit RedemptionSkipped(i, RedemptionSkipReason.InsufficientFunds);
                break;
            }

            // Non-standard ERC-20s that return `false` without reverting are
            // soft-skipped rather than treated as paid.
            (bool ok,) = _trySafeTransferFrom(usdcToken, psm, entry.user, usdcAmount);
            if (!ok) {
                emit RedemptionSkipped(i, RedemptionSkipReason.TransferFailed);
                continue;
            }

            token.burn(entry.rawAmount);
            totalRawDecrement += entry.rawAmount;
            available -= usdcAmount;

            emit RedemptionProcessed(
                entry.user, entry.rawAmount, uiAmount, usdcAmount, block.timestamp - entry.timestamp
            );

            delete $.queue[i];
        }

        $.totalQueuedRaw -= totalRawDecrement;

        // queueHead is NOT auto-advanced here; see `advanceHead`.
    }

    /// @notice Return escrowed tokens for a stuck entry without burning them.
    /// @dev For entries that can never be processed — e.g. a USDC-blacklisted
    ///      recipient. Cannot redirect a *live* entry's payment in the sense that
    ///      matters: the entry is cleared and its escrow released, so no double
    ///      spend is possible.
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

        // CEI: all state updated before the external transfer.
        $.totalQueuedRaw -= entry.rawAmount;
        delete $.queue[index];

        emit RedemptionRescued(
            index,
            entry.user,
            alternateRecipient,
            entry.rawAmount,
            $.okuM.toUIAmount(entry.rawAmount)
        );

        IERC20(address($.okuM)).safeTransfer(alternateRecipient, entry.rawAmount);
    }

    /// @notice Sweep tokens donated to this contract beyond what is escrowed.
    /// @dev Capped at `balanceOf(this) - totalQueuedRaw`, so it provably cannot
    ///      touch user escrow. Exists because `totalQueuedRaw <= balanceOf` is a
    ///      bound rather than an equality — anyone can donate for free, and
    ///      without this the surplus would be stranded forever.
    function sweepExcess(address to) external nonReentrant onlyRole(Roles.QUEUE_RESCUER) {
        if (to == address(0)) revert Errors.ZeroAddress();
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        uint256 balance = IERC20(address($.okuM)).balanceOf(address(this));
        uint256 escrowed = $.totalQueuedRaw;
        if (balance <= escrowed) revert NoExcessToSweep();
        uint256 excess = balance - escrowed;
        emit ExcessSwept(to, excess);
        IERC20(address($.okuM)).safeTransfer(to, excess);
    }

    /// @notice Advance `queueHead` past contiguous cleared entries.
    /// @dev Permissionless by design: it can only move `queueHead` forward, and
    ///      only past slots that are already cleared. The effect on
    ///      `queueLength()` is cosmetic — redemption correctness is independent
    ///      of the cursor. A privileged version would add no security and would
    ///      complicate the runbook.
    function advanceHead(uint256 maxSlots) external returns (uint256 advanced) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        uint256 head = $.queueHead;
        uint256 tail = $.queueTail;
        while (advanced < maxSlots && head < tail && $.queue[head].user == address(0)) {
            unchecked {
                head++;
                advanced++;
            }
        }
        if (advanced != 0) {
            $.queueHead = head;
            emit QueueHeadAdvanced(head, advanced);
        }
    }

    // ============ Views ============

    /// @notice Slots between `queueHead` and `queueTail`.
    /// @dev An UPPER BOUND on live entries: cleared slots at the front are
    ///      counted until `advanceHead` runs.
    function queueLength() external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        return $.queueTail - $.queueHead;
    }

    /// @notice Total USDC owed across all pending entries. O(1), multiplier-aware.
    /// @dev Deliberately fee-FREE, and therefore an upper bound on the true
    ///      obligation once `tout` is nonzero.
    ///
    ///      Per-entry fees are snapshotted, so an exact figure would require
    ///      iterating the queue — this view is O(1) by design and is used to size
    ///      the PSM's approval for `processQueue`. Over-approximating is the safe
    ///      direction there: the approval covers the batch, and the unspent
    ///      remainder is revoked immediately afterwards.
    function totalQueuedUsdc() external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        return MathLib.dollarsToUsdc($.okuM.toUIAmount($.totalQueuedRaw), $.usdcDecimalMultiplier);
    }

    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index >= $.queueTail) revert InvalidIndex();
        return $.queue[index];
    }

    /// @notice Current USDC value of the entry at `index`, net of its
    ///         snapshotted `tout`.
    /// @dev A CONSERVATIVE FLOOR, not necessarily the exact settlement amount.
    ///
    ///      Settlement charges `min(snapshot, live)`, so if the fee has been cut
    ///      since this entry was queued the holder receives MORE than this
    ///      reports. The view cannot see the live fee: it has no `msg.sender` to
    ///      read it from (unlike `processQueue`, which is `QUEUE_PSM`-only and
    ///      therefore always called by the PSM), and storing a pointer back to
    ///      the PSM would create the circular deploy dependency that
    ///      `QUEUE_PSM` being granted post-deploy exists to avoid.
    ///
    ///      Erring low is the right direction for a quote — a holder is never
    ///      told to expect more than they get.
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index >= $.queueTail) revert InvalidIndex();
        QueueEntry storage entry = $.queue[index];
        return MathLib.applyFee(
            MathLib.dollarsToUsdc($.okuM.toUIAmount(entry.rawAmount), $.usdcDecimalMultiplier),
            entry.toutBps
        );
    }

    // ============ Internal ============

    /// @dev The better of the fee snapshotted at enqueue and the fee in force
    ///      now. See the call site for why the minimum rather than the snapshot.
    function _effectiveTout(uint256 snapshotted, uint256 current) private pure returns (uint256) {
        return current < snapshotted ? current : snapshotted;
    }

    /// @dev `transferFrom` that neither reverts nor trusts a missing return value.
    ///      Handles all three non-conforming shapes: revert, `false` return, and
    ///      no return data (treated as success, per `SafeERC20` convention).
    function _trySafeTransferFrom(
        IERC20 token,
        address from,
        address to,
        uint256 value
    )
        private
        returns (bool success, bytes memory returndata)
    {
        (success, returndata) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, value)));
        if (!success) return (false, returndata);
        if (returndata.length == 0) return (true, returndata);
        if (returndata.length < 32) return (false, returndata);
        success = abi.decode(returndata, (bool));
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.QUEUE_UPGRADER) {}
}
