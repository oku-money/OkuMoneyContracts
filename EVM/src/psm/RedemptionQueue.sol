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
 * @dev Stores OkuM token amounts (not shares — OkuMoney is non-rebasing). Queued balances
 *      do not grow; they appreciate via okuMMultiplier(), so the user receives
 *      `okuMAmount * okuMMultiplier()` at processing time. Yield while queued comes from
 *      multiplier appreciation, not balance growth.
 *
 *      Tokens are transferred into the queue by the PSM before `enqueue` is called;
 *      `enqueue` is record-only and does not pull tokens from the user.
 *
 *      If an entry becomes permanently unprocessable (e.g. USDC-blacklisted recipient),
 *      QUEUE_RESCUER calls `rescueQueueEntry` to return the OkuMoney and clear the slot.
 *      Rescue stuck entries before running `processQueue` over that range.
 *
 *      Like LitePSM, the USDC-side decimal multiplier is computed at init from
 *      `IERC20Metadata(usdc).decimals()` and stored on the proxy. USDC peg monitoring is
 *      off-chain; pausing the PSM gates `processQueue`.
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
    /// @param _okuMoney OkuMoney token address. Must match the OkuMoney configured on the
    ///        LitePSM that will operate this queue — enforced by
    ///        `LitePSM.initialize`'s `QueueOkuMoneyMismatch` check (this contract is
    ///        always deployed and initialized first, so it cannot enforce the reverse
    ///        direction itself).
    /// @param _usdc USDC token address (must implement IERC20Metadata.decimals()).
    ///        Must match the USDC configured on the LitePSM that will operate this
    ///        queue — enforced the same way, via `LitePSM.initialize`'s
    ///        `QueueUsdcMismatch` check.
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
        $.usdcDecimalMultiplier = 10 ** (uint256(Constants.OKU_M_DECIMALS) - uint256(usdcDecimals));

        // QUEUE_PSM is deliberately NOT granted here: it is granted post-deployment to the
        // LitePSM proxy (avoiding a circular deploy dependency), and granting it to admin
        // would let admin bypass the PSM and call enqueue/processQueue directly.
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.QUEUE_UPGRADER, _admin);
        _grantRole(Roles.QUEUE_RESCUER, _admin);
    }

    // ============ Storage Accessor Views ============

    function okuMoney() external view returns (IOkuMoney) {
        return _getRedemptionQueueStorage().okuMoney;
    }

    function usdc() external view returns (IERC20) {
        return _getRedemptionQueueStorage().usdc;
    }

    /// @notice Decimal conversion multiplier for the configured USDC variant.
    function usdcDecimalMultiplier() external view returns (uint256) {
        return _getRedemptionQueueStorage().usdcDecimalMultiplier;
    }

    /// @notice Index of the first potentially-live slot in the queue.
    function queueHead() external view returns (uint256) {
        return _getRedemptionQueueStorage().queueHead;
    }

    /// @notice Index of the next slot to be written (one past the last entry).
    function queueTail() external view returns (uint256) {
        return _getRedemptionQueueStorage().queueTail;
    }

    /// @notice Total OkuMoney tokens escrowed across all pending queue entries.
    function totalQueuedOkuM() external view returns (uint256) {
        return _getRedemptionQueueStorage().totalQueuedOkuM;
    }

    // ============ Queue Management ============

    /// @notice Record a redemption in the queue.
    /// @param user User requesting redemption
    /// @param okuMTokenAmount Amount of OkuMoney tokens to redeem
    /// @dev Tokens must already be in this contract before calling (PSM transfers them first).
    ///      Record-only: stores the raw OkuM amount and pushes an entry.
    function enqueue(address user, uint256 okuMTokenAmount) external onlyRole(Roles.QUEUE_PSM) {
        // `address(0)` is the "slot cleared" sentinel (see `processQueue`'s AlreadyCleared
        // branch, `rescueQueueEntry`, and `advanceHead`), so a zero-user entry would be
        // permanently unprocessable AND unrescuable while still counted in
        // `totalQueuedOkuM` — permanently inflating `totalQueuedUsdc()` and blocking
        // `LitePSM.withdrawUsdc` via WouldStrandQueue. Unreachable via the sole caller,
        // but this is a role-gated external entry point and the sentinel is load-bearing.
        if (user == address(0)) revert Errors.ZeroAddress();

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
    ///
    ///      Pause semantics: callable only by `QUEUE_PSM` (the LitePSM proxy), and
    ///      `LitePSM.processQueue` is `whenNotPaused`, so pausing LitePSM halts queue
    ///      drain. This contract holds no pause state of its own — one gate, at the PSM
    ///      layer. Consequence: `rescueQueueEntry` stays reachable while LitePSM is paused.
    ///
    ///      Stuck entries (USDC-blacklisted/frozen recipients) are soft-skipped with a
    ///      RedemptionSkipped(TransferFailed) event. Use `rescueQueueEntry` to clear them.
    ///
    ///      Funding is bounded by `min(balanceOf(caller), allowance(caller, this))` —
    ///      payouts move via `transferFrom`, so an under-sized approval halts the batch
    ///      with `InsufficientFunds` exactly like an under-sized balance does, rather
    ///      than misreporting as `TransferFailed`. Callers that approve per-batch
    ///      (as `LitePSM.processQueue` does) should size the approval against the
    ///      multiplier at execution time, not at computation time.
    function processQueue(
        uint256 startIndex,
        uint256 endIndex
    )
        external
        nonReentrant
        onlyRole(Roles.QUEUE_PSM)
    {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (startIndex < $.queueHead) revert StartBelowHead();
        if (endIndex > $.queueTail) revert EndAboveTail();

        IERC20 usdcContract = $.usdc;
        // Payouts move via `transferFrom`, so the real ceiling is the LOWER of the
        // caller's balance and the allowance it granted this contract — not the balance
        // alone. `LitePSM.processQueue` approves an operator-supplied `approveAmount`
        // (sized off-chain against a multiplier snapshot) that is routinely far below its
        // buffer balance, so an allowance-bound batch is ordinary, not an edge case.
        //
        // Gating on the balance alone let those batches pass this check and then fail in
        // `trySafeTransferFrom`, surfacing as `TransferFailed` — the recipient-side signal
        // whose documented remedy is `rescueQueueEntry` (see {RedemptionQueueEvents}).
        // An operator following that guidance would have returned OkuM to perfectly
        // healthy users over what is really an approval-sizing mistake, and paid full
        // loop-body gas for every remaining entry in a batch that could no longer settle.
        //
        // Both bounds are expected to shrink monotonically during the loop under a
        // well-behaved (non-callback) collateral token. If the configured token DOES carry
        // a transfer callback, a recipient could use it to top up the caller's balance or
        // allowance mid-batch, making this cached bound stale-LOW relative to the live
        // value. That can only cause a premature `break` below (liveness: a fundable entry
        // gets skipped and must wait for the next batch) — it can never cause an
        // over-payment, since the real `trySafeTransferFrom` call still enforces the ACTUAL
        // on-chain balance/allowance at transfer time regardless of what this cache says.
        // The `break` branch re-validates live before trusting this cache to halt the
        // batch; see the comment there.
        uint256 usdcAvailable = usdcContract.balanceOf(msg.sender);
        uint256 usdcApproved = usdcContract.allowance(msg.sender, address(this));
        if (usdcApproved < usdcAvailable) {
            usdcAvailable = usdcApproved;
        }
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

            if (usdcAvailable < usdcAmount) {
                // Lazy re-validation: the cached `usdcAvailable` is decremented locally
                // and never re-read from chain mid-loop (gas). A transfer-callback token
                // could have topped up the caller's real balance/allowance via an earlier
                // iteration's `entry.user` callback, which this cache cannot see — re-check
                // live, exactly once, only on the path that would otherwise halt the whole
                // batch. Costs 2 extra external calls only when the cache already predicts
                // insufficiency; the common case (sufficient funds throughout, or a
                // non-callback token) pays nothing extra.
                uint256 liveAvailable = usdcContract.balanceOf(msg.sender);
                uint256 liveApproved = usdcContract.allowance(msg.sender, address(this));
                if (liveApproved < liveAvailable) {
                    liveAvailable = liveApproved;
                }
                if (liveAvailable < usdcAmount) {
                    emit RedemptionSkipped(i, RedemptionSkipReason.InsufficientFunds);
                    break;
                }
                // Resync the running bound to the live value before continuing — a
                // callback-driven top-up is reflected from here on, not just this entry.
                usdcAvailable = liveAvailable;
            }

            // `trySafeTransferFrom` (a) swallows reverts (Circle USDC blacklist path),
            // (b) decodes the boolean for tokens that signal failure by returning false,
            // and (c) treats non-reverting with no return data as success. All three
            // failure shapes route into the soft-skip branch, so one uncooperative
            // recipient cannot revert the batch; the OkuM is NOT burned and stays escrowed
            // for `rescueQueueEntry`.
            //
            // CHECKS-EFFECTS-INTERACTIONS: clear the slot BEFORE the external transfer and
            // restore it on failure. Re-entry is already closed by this function's
            // `nonReentrant` (shared with `rescueQueueEntry`), LitePSM's own guard held by
            // the enclosing `LitePSM.processQueue`, and Circle USDC having no transfer
            // callback — but that last one is a property of the token configured at init,
            // not of this code, and ordering state-before-interaction costs nothing.
            delete $.queue[i];

            bool ok = usdcContract.trySafeTransferFrom(msg.sender, entry.user, usdcAmount);
            if (!ok) {
                // Restore from the memory copy taken before the delete: OkuM stays
                // escrowed and the slot remains claimable by `rescueQueueEntry`.
                $.queue[i] = entry;
                emit RedemptionSkipped(i, RedemptionSkipReason.TransferFailed);
                continue;
            }

            // DELIBERATELY UNGUARDED — the one call in this loop allowed to revert the
            // whole batch, and the only one that runs AFTER value has moved.
            //
            // That ordering is the whole reason. `trySafeTransferFrom` above fails BEFORE
            // any USDC moves, so soft-skipping it unwinds cleanly (restore the slot, move
            // on). Here the USDC has already reached `entry.user`; the only way to undo it
            // is to revert the transaction. Swallowing this failure would pay the user and
            // leave their OkuM un-burned — unbacked supply, i.e. a solvency hole, created
            // silently and signalled only by an event.
            //
            // Nor would swallowing it buy anything. Every way `burn` can revert is
            // batch-invariant, not per-entry: `OKUM_BURNER` revoked from this contract,
            // this contract blacklisted on OkuMoney, or a balance shortfall that would
            // itself indicate an accounting bug. None vary between entries, so if it fails
            // for one it fails for all — there are no "other users" a soft-skip could
            // rescue. It would convert an all-or-nothing halt into an all-or-nothing
            // payout with nothing burned.
            //
            // Reverting is therefore fail-closed and fully recoverable: no USDC moves, no
            // state changes, the operator restores the role and re-runs. Meanwhile
            // `rescueQueueEntry` stays available as an escape hatch for users either way,
            // since it returns OkuM rather than burning it. Pinned by
            // `test_ProcessQueue_BurnerRoleRevoked_RevertsWholeBatch`.
            $.okuMoney.burn(entry.okuMAmount);
            totalOkuMDecrement += entry.okuMAmount;

            uint256 waitTime = block.timestamp - entry.timestamp;
            emit RedemptionProcessed(
                entry.user, entry.okuMAmount, dollarValue18, usdcAmount, waitTime
            );

            usdcAvailable -= usdcAmount;
        }

        $.totalQueuedOkuM -= totalOkuMDecrement;
        // queueHead is NOT auto-advanced: anyone may call `advanceHead(maxSlots)` after a
        // batch to amortize the head walk into a separate, gas-bounded call.
        // `queueLength()` is an upper bound until then; redemption correctness is not.
    }

    /// @notice Return OkuMoney for a stuck queue entry without burning it.
    /// @dev Used when an entry is permanently unprocessable because `entry.user` is
    ///      OkuM-blacklisted — NOT USDC-blacklisted. A USDC-blacklisted user can still
    ///      receive OkuM back via `alternateRecipient == entry.user`; it's only when
    ///      `OkuMoney._update` would itself revert `RecipientBlacklisted` on a
    ///      self-return that a genuinely different recipient is required. An earlier
    ///      version of this doc (and the README) named the wrong blacklist.
    ///      Operator flow: identify stuck entry -> rescueQueueEntry(index, recipient) -> processQueue.
    ///
    ///      `alternateRecipient` is intentionally NOT required to equal `entry.user` —
    ///      this is what makes the OkuM-blacklist case rescuable at all. That same
    ///      freedom means `QUEUE_RESCUER` can redirect any queued user's escrowed OkuM
    ///      to an arbitrary address (single signature, irreversible — see
    ///      `AUTHORITY-MATRIX.md` finding E24). Accepted rather than fixed in code
    ///      because `QUEUE_RESCUER` is granted alongside `QUEUE_UPGRADER` on the
    ///      mainnet Cold Multisig (`grantRolesMainnet.ts`), which can replace this
    ///      contract's entire logic outright — a redirect-recipient check would add no
    ///      real constraint against the only key holding the role in that topology.
    ///      That domination argument is NOT self-enforcing: it only holds where the two
    ///      roles are actually co-located. Verify before granting `QUEUE_RESCUER`
    ///      standalone (e.g. to a testnet operator key without `QUEUE_UPGRADER`) that
    ///      you're deliberately accepting bare redirect power, not assuming the
    ///      mainnet pairing follows it there for free.
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
        // queueHead is NOT auto-advanced here; see {advanceHead}.
        IERC20(address($.okuMoney)).safeTransfer(alternateRecipient, entry.okuMAmount);
    }

    /// @notice Advance `queueHead` past contiguous cleared entries at the front.
    /// @dev Gas-bounded maintenance. `processQueue` and `rescueQueueEntry` do not advance
    ///      the head, so a long run of cleared slots can leave `queueHead` behind the live
    ///      front. Permissionless: it can only move `queueHead` forward, and only past
    ///      slots already cleared (`user == address(0)`) — BETWEEN transactions. The
    ///      effect on `queueLength()` is cosmetic; redemption correctness is independent
    ///      of `queueHead`.
    ///
    ///      `nonReentrant`, shared with `processQueue` and `rescueQueueEntry`, is required
    ///      — not merely defensive. `processQueue` clears a slot (`delete $.queue[i]`)
    ///      BEFORE its external `trySafeTransferFrom` call and restores it from memory on
    ///      failure, so for the duration of that external call a live entry transiently
    ///      reads `user == address(0)`. Against a collateral token with a transfer
    ///      callback that returns `false` rather than reverting (state changes from a
    ///      `false` return are NOT unwound, unlike a revert), a reentrant `advanceHead`
    ///      during that window would move `queueHead` past the transiently-cleared slot
    ///      permanently — `processQueue`'s own restore runs after, but the slot is now
    ///      below `queueHead` and therefore unreachable by every bound check in this
    ///      contract (`processQueue`'s `StartBelowHead`, `rescueQueueEntry`'s and
    ///      `getQueueEntry`'s `InvalidIndex`), stranding the user's OkuM and permanently
    ///      inflating `totalQueuedUsdc()` against `LitePSM.withdrawUsdc`'s
    ///      `WouldStrandQueue` check. Not reachable with Circle USDC (no transfer
    ///      callback) or any ERC-20 without one — but the collateral token is a deploy
    ///      parameter (`initialize` validates only `decimals() <= 18`), not a property
    ///      this contract can itself enforce, so the guard is required regardless of
    ///      which token is configured today. See `test_AdvanceHead_ReentrancyGuard_*` in
    ///      `test/psm/Reentrancy.t.sol`.
    /// @param maxSlots Maximum number of cleared slots to skip in this call.
    /// @return advanced Number of slots actually advanced.
    function advanceHead(uint256 maxSlots) external nonReentrant returns (uint256 advanced) {
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

    /// @notice Number of slots between `queueHead` and `queueTail`.
    /// @dev Equal to `queueTail - queueHead`, an UPPER BOUND on live entries: cleared
    ///      slots at the front are counted until {advanceHead} is called. For an exact
    ///      live count, call {advanceHead}(N) first or iterate `getQueueEntry` over the
    ///      range filtering `user == address(0)`.
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
    /// @param index Queue index to look up (must be in [queueHead, queueTail)).
    /// @return The stored QueueEntry (user, okuMAmount, timestamp).
    function getQueueEntry(uint256 index) external view returns (QueueEntry memory) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        return $.queue[index];
    }

    /// @notice Current dollar value (18 decimals) for a queue entry (multiplier-aware).
    /// @param index Queue index to look up (must be in [queueHead, queueTail)).
    /// @return Dollar value of the entry at the current okuMMultiplier (18 decimals).
    function getQueueEntryValue(uint256 index) external view returns (uint256) {
        RedemptionQueueStorage storage $ = _getRedemptionQueueStorage();
        if (index < $.queueHead || index >= $.queueTail) revert InvalidIndex();
        return MathLib.okuMToDollars($.queue[index].okuMAmount, $.okuMoney.okuMMultiplier());
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address) internal override onlyRole(Roles.QUEUE_UPGRADER) {}
}
