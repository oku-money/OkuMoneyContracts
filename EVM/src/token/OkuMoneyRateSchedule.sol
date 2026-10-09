// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {MathLib} from "../lib/MathLib.sol";
import {OkuMoneyEvents} from "../lib/events/OkuMoneyEvents.sol";
import {OkuMoneyErrors} from "../lib/errors/OkuMoneyErrors.sol";
import {SharedErrors} from "../lib/errors/SharedErrors.sol";
import {IOkuMoney} from "../interfaces/IOkuMoney.sol";
import {IScaledUIAmount, IScaledUIAmountNewUIMultiplier} from "../interfaces/IScaledUIAmount.sol";

/**
 * @title OkuMoneyRateSchedule
 * @notice The OkuM multiplier: a streaming rate schedule plus the discrete emergency override.
 * @dev `okuMMultiplier()` is COMPUTED from the schedule via {MathLib.computeMultiplier}, not
 *      stored; see README § Streaming Accrual. Also serves the scheduling half of ERC-8056
 *      (see {IScaledUIAmount} for deviations). Own ERC-7201 namespace, so the schedule
 *      layout is independent of the token's.
 */
abstract contract OkuMoneyRateSchedule is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    OkuMoneyEvents,
    OkuMoneyErrors,
    IOkuMoney,
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OkuMoneyRateSchedule
    struct RateScheduleStorage {
        // The schedule packs into 2 slots (the override stamp takes a third). Widths:
        // MAX_MULTIPLIER (1e24) fits uint96, MAX_RATE (~1e18) fits uint64, timestamps fit
        // uint48. Runtime values are downcast with SafeCast.
        //
        // Slot 1: base | rate | pendingRate (96 + 64 + 64 = 224 bits)
        uint96 okuMBaseMultiplier; // snapshot at `okuMLastAccrualTime`; starts 1e18 = $1.00
        uint64 okuMRatePerSecond; // active per-second rate; PRECISION = no yield
        uint64 okuMPendingRatePerSecond; // successor rate, active after `okuMRateEnd`
        // Slot 2: lastAccrualTime | rateEnd | pendingRateEnd (48 + 48 + 48 = 144 bits)
        uint48 okuMLastAccrualTime; // timestamp `okuMBaseMultiplier` was snapshotted at
        // Active rate expiry. 0 only when `okuMRatePerSecond == PRECISION` (halted sentinel).
        uint48 okuMRateEnd;
        // Successor expiry; bounds unattended compounding past `okuMRateEnd`. 0 = none armed.
        uint48 okuMPendingRateEnd;
        // Block of the last discrete override (read via OverrideBlockGuard). Streaming
        // accrual never stamps it.
        uint256 lastOverrideBlock;
    }

    /// @dev `Constants.PRECISION` at the stored rate width: the halted / none-armed rate.
    uint64 private constant NO_YIELD_RATE = 1e18;

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OkuMoneyRateSchedule")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant RATE_SCHEDULE_STORAGE_LOCATION =
        0xf549d049d5f1892d94a28293517dbae0d59f3eeb1d0d052265836a74d32f3400;

    function _getRateScheduleStorage() private pure returns (RateScheduleStorage storage $) {
        assembly {
            $.slot := RATE_SCHEDULE_STORAGE_LOCATION
        }
    }

    /// @dev Starts halted at $1.00.
    function __OkuMoneyRateSchedule_init() internal onlyInitializing {
        _haltSchedule(_getRateScheduleStorage(), Constants.PRECISION);
    }

    /// @dev Token supply reported in {OkuMMultiplierUpdated}.
    function _supplyForOverrideEvent() internal view virtual returns (uint256);

    // ============ Views ============

    /// @notice Current OkuM multiplier (dollar value per token, 1e18 = $1.00).
    /// @dev COMPUTED, not stored, so there is no discrete step to arbitrage. No supply term:
    ///      identical schedule state gives every chain the identical value at a given timestamp.
    function okuMMultiplier() public view returns (uint256) {
        RateScheduleStorage storage $ = _getRateScheduleStorage();
        return MathLib.computeMultiplier(
            $.okuMBaseMultiplier,
            $.okuMRatePerSecond,
            $.okuMLastAccrualTime,
            $.okuMRateEnd,
            $.okuMPendingRatePerSecond,
            $.okuMPendingRateEnd,
            block.timestamp
        );
    }

    /// @notice The schedule's stored active-window rate (1e18 = no yield).
    /// @dev Raw storage, not rolled forward: after `okuMRateEnd` it can lag the live rate.
    ///      Use {okuMEffectiveRatePerSecond} for the rate accruing now.
    function okuMRatePerSecond() external view returns (uint256) {
        return _getRateScheduleStorage().okuMRatePerSecond;
    }

    /// @notice The per-second rate actually accruing right now.
    /// @dev The pending rate once `okuMRateEnd` has elapsed with a successor armed;
    ///      `PRECISION` once `okuMPendingRateEnd` has also elapsed; else the stored rate.
    ///      Basis for the rate setters' pause gate.
    function okuMEffectiveRatePerSecond() public view returns (uint256) {
        RateScheduleStorage storage $ = _getRateScheduleStorage();
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd != 0 && block.timestamp > rateEnd) {
            uint256 pendingRateEnd = $.okuMPendingRateEnd;
            if (pendingRateEnd != 0 && block.timestamp > pendingRateEnd) {
                return Constants.PRECISION;
            }
            return $.okuMPendingRatePerSecond;
        }
        return $.okuMRatePerSecond;
    }

    /// @notice Snapshot multiplier taken at {okuMLastAccrualTime}.
    function okuMBaseMultiplier() external view returns (uint256) {
        return _getRateScheduleStorage().okuMBaseMultiplier;
    }

    /// @notice Timestamp the base multiplier was snapshotted at.
    function okuMLastAccrualTime() external view returns (uint256) {
        return _getRateScheduleStorage().okuMLastAccrualTime;
    }

    /// @notice Timestamp the active rate expires (0 = accrual halted; open-ended
    ///         yielding rates are rejected — see {setOkuMYieldRate}).
    function okuMRateEnd() external view returns (uint256) {
        return _getRateScheduleStorage().okuMRateEnd;
    }

    /// @notice Successor rate, active after {okuMRateEnd} (1e18 = none armed).
    function okuMPendingRatePerSecond() external view returns (uint256) {
        return _getRateScheduleStorage().okuMPendingRatePerSecond;
    }

    /// @notice Timestamp the pending (successor) rate itself expires (0 = none armed).
    function okuMPendingRateEnd() external view returns (uint256) {
        return _getRateScheduleStorage().okuMPendingRateEnd;
    }

    /// @inheritdoc IOkuMoney
    function paused() public view override(PausableUpgradeable, IOkuMoney) returns (bool) {
        return super.paused();
    }

    /// @notice Block of the last discrete override (0 if none); read by OverrideBlockGuard.
    function lastOverrideBlock() external view returns (uint256) {
        return _getRateScheduleStorage().lastOverrideBlock;
    }

    // ============ Rate Setters ============

    /// @notice Set the active yield rate, re-anchoring the accrual base.
    /// @param newRate Per-second rate in [PRECISION, MAX_RATE]; PRECISION halts accrual.
    /// @param endTimestamp Expiry. Must be 0 when halting; otherwise strictly future and
    ///        within {Constants.MAX_RATE_WINDOW} (README § Streaming Accrual).
    /// @dev Snapshots the current multiplier as the new base, so the curve is continuous
    ///      across the write (no `lastOverrideBlock` stamp). Clears any armed
    ///      successor. Prefer {setOkuMYieldRateWithSuccessor} to two separate transactions.
    function setOkuMYieldRate(
        uint256 newRate,
        uint256 endTimestamp
    )
        external
        onlyRole(Roles.OKUM_RATE_MANAGER)
    {
        _setOkuMYieldRate(newRate, endTimestamp);
    }

    /// @notice Pre-stage the successor rate that activates after {okuMRateEnd}.
    /// @param newRate Per-second rate in [PRECISION, MAX_RATE].
    /// @param pendingEndTimestamp Successor expiry; strictly after `okuMRateEnd`, bounding
    ///        how long it compounds unattended before accrual halts.
    /// @dev Activation keys off the absolute `okuMRateEnd` inside {okuMMultiplier} with no
    ///      transaction at the boundary, so staging on different chains days apart still
    ///      activates simultaneously. Requires a bounded, unexpired active window.
    ///      Pause-gated for increases like {setOkuMYieldRate}.
    function setNextOkuMYieldRate(
        uint256 newRate,
        uint256 pendingEndTimestamp
    )
        external
        onlyRole(Roles.OKUM_RATE_MANAGER)
    {
        _setNextOkuMYieldRate(newRate, pendingEndTimestamp);
    }

    /// @notice Atomically re-anchor the active rate AND stage its successor.
    /// @dev Parameters as in {setOkuMYieldRate} (`newRate`, `endTimestamp`) and
    ///      {setNextOkuMYieldRate} (`nextRate`, `nextEndTimestamp`). As two transactions,
    ///      a failure after the first leaves no successor (it clears any pending rate) and
    ///      accrual silently halts at `endTimestamp`; here both land or neither does.
    ///      Pure composition of the shared bodies: every check, event and gate applies in order.
    /// @param newRate          Active per-second rate, 1e18-scaled (`PRECISION` = no yield).
    /// @param endTimestamp     When the active rate expires (unix seconds, in the future).
    /// @param nextRate         Successor rate that takes over at `endTimestamp`.
    /// @param nextEndTimestamp When the successor expires (after `endTimestamp`).
    function setOkuMYieldRateWithSuccessor(
        uint256 newRate,
        uint256 endTimestamp,
        uint256 nextRate,
        uint256 nextEndTimestamp
    )
        external
        onlyRole(Roles.OKUM_RATE_MANAGER)
    {
        _setOkuMYieldRate(newRate, endTimestamp);
        _setNextOkuMYieldRate(nextRate, nextEndTimestamp);
    }

    /// @notice Emergency discrete override: re-anchors the base and halts the schedule.
    /// @param newMultiplier Must exceed the current multiplier and be <= MAX_MULTIPLIER.
    /// @dev ESCAPE HATCH ONLY; normal yield flows through {setOkuMYieldRate}, which must be
    ///      called afterward to resume accrual. This creates a discontinuity, so it stamps
    ///      `lastOverrideBlock` and `whenNoOverrideThisBlock` paths revert for the
    ///      rest of the block. Rejects `newMultiplier <= current` so a no-op cannot burn that
    ///      stamp. Pause-gated: a discrete value move freezes alongside transfers.
    function setOkuMMultiplier(uint256 newMultiplier)
        external
        onlyRole(Roles.OKUM_RATE_MANAGER)
        whenNotPaused
    {
        RateScheduleStorage storage $ = _getRateScheduleStorage();
        uint256 currentMultiplier = okuMMultiplier();
        if (newMultiplier <= currentMultiplier) revert SharedErrors.MultiplierCannotDecrease();
        if (newMultiplier > Constants.MAX_MULTIPLIER) revert MultiplierTooHigh();

        // Announce the cancelled successor (if any) while it is still in storage.
        _emitPendingRateCancelledIfArmed($);

        // Stamp the block so same-block PSM/vault paths revert, then jump the base to the
        // new value with no accrual until a rate is set again.
        $.lastOverrideBlock = block.number;
        _haltSchedule($, newMultiplier);

        emit OkuMMultiplierUpdated(
            currentMultiplier, newMultiplier, _supplyForOverrideEvent(), block.number
        );
        emit UIMultiplierUpdated(currentMultiplier, newMultiplier, block.timestamp);
    }

    // ============ ERC-8056: Scheduling ============
    // The OkuM multiplier doubles as the ERC-8056 UI multiplier; see IScaledUIAmount.

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() external view returns (uint256) {
        return okuMMultiplier();
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev Schedules a pending *rate*, not a *value*: returns the multiplier projected at
    ///      {effectiveAt}, or the current one when no successor is armed.
    function newUIMultiplier() external view returns (uint256) {
        RateScheduleStorage storage $ = _getRateScheduleStorage();
        return _successorArmed($) ? _projectedAtRateEnd($) : okuMMultiplier();
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev 0 unless a successor is armed and not yet active; same condition as {newUIMultiplier}.
    function effectiveAt() external view returns (uint256) {
        RateScheduleStorage storage $ = _getRateScheduleStorage();
        return _successorArmed($) ? $.okuMRateEnd : 0;
    }

    // ============ Internals ============

    /// @dev Shared body for {setOkuMYieldRate} and {setOkuMYieldRateWithSuccessor}.
    function _setOkuMYieldRate(uint256 newRate, uint256 endTimestamp) private {
        // Validate: a halt (rate == PRECISION) carries no window; a yielding rate needs a
        // future window no longer than MAX_RATE_WINDOW.
        _requireRateInRange(newRate);
        if (newRate == Constants.PRECISION) {
            if (endTimestamp != 0) revert EndTimestampNotAllowed();
        } else {
            if (endTimestamp <= block.timestamp) revert EndTimestampInPast();
            if (endTimestamp - block.timestamp > Constants.MAX_RATE_WINDOW) {
                revert RateWindowTooLong();
            }
        }

        RateScheduleStorage storage $ = _getRateScheduleStorage();
        uint256 oldRate = $.okuMRatePerSecond;
        _requireNoIncreaseWhilePaused(newRate);
        // Read the multiplier under the OLD schedule, before any write: it becomes the new
        // base, so the curve is continuous at this instant (no yield gained or lost).
        uint256 snapshot = okuMMultiplier();

        // Announce the successor being discarded while it is still in storage.
        _emitPendingRateCancelledIfArmed($);

        // Re-anchor at now with the new rate and window; any staged successor is cleared.
        $.okuMBaseMultiplier = SafeCast.toUint96(snapshot);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        $.okuMRatePerSecond = SafeCast.toUint64(newRate);
        $.okuMRateEnd = SafeCast.toUint48(endTimestamp);
        $.okuMPendingRatePerSecond = NO_YIELD_RATE;
        $.okuMPendingRateEnd = 0;

        emit OkuMYieldRateUpdated(oldRate, newRate, endTimestamp, snapshot);
        // ERC-8056: old == new on purpose; the value is continuous at the write, only the
        // rate going forward changed.
        emit UIMultiplierUpdated(snapshot, snapshot, block.timestamp);
    }

    /// @dev Shared body for {setNextOkuMYieldRate} and {setOkuMYieldRateWithSuccessor}.
    function _setNextOkuMYieldRate(uint256 newRate, uint256 pendingEndTimestamp) private {
        _requireRateInRange(newRate);

        RateScheduleStorage storage $ = _getRateScheduleStorage();
        // A successor needs a live active window to follow, and must end after it.
        uint256 rateEnd = $.okuMRateEnd;
        if (rateEnd == 0) revert NoRateEndSet();
        if (block.timestamp >= rateEnd) revert RateAlreadyExpired();
        if (pendingEndTimestamp <= rateEnd) revert PendingEndNotAfterRateEnd();
        // The successor's own window feeds one `rpow`, so it is bounded independently.
        if (pendingEndTimestamp - rateEnd > Constants.MAX_RATE_WINDOW) {
            revert RateWindowTooLong();
        }
        _requireNoIncreaseWhilePaused(newRate);

        // Replacing an armed successor counts as cancelling it.
        _emitPendingRateCancelledIfArmed($);

        // Only the successor is written; the active rate and base are untouched.
        $.okuMPendingRatePerSecond = SafeCast.toUint64(newRate);
        $.okuMPendingRateEnd = SafeCast.toUint48(pendingEndTimestamp);

        emit NextOkuMYieldRateSet(newRate, rateEnd, pendingEndTimestamp);
    }

    /// @dev `PRECISION <= newRate <= MAX_RATE`: no negative yield, and a bounded rpow input.
    function _requireRateInRange(uint256 newRate) private pure {
        if (newRate < Constants.PRECISION) revert InvalidRate();
        if (newRate > Constants.MAX_RATE) revert RateTooHigh();
    }

    /// @dev While paused only decreases (vs the EFFECTIVE rate) are allowed: incident
    ///      response must be able to zero accrual, and an increase would hand the inflated
    ///      multiplier to whoever redeems first after unpause.
    function _requireNoIncreaseWhilePaused(uint256 newRate) private view {
        if (newRate > okuMEffectiveRatePerSecond() && paused()) {
            revert PausableUpgradeable.EnforcedPause();
        }
    }

    /// @dev A successor is staged and the active window has not yet closed. After
    ///      `okuMRateEnd` the successor is already live ({MathLib.computeMultiplier}
    ///      branch 2), so re-anchoring is not a cancellation.
    function _successorArmed(RateScheduleStorage storage $) private view returns (bool) {
        uint256 rateEnd = $.okuMRateEnd;
        return rateEnd != 0 && block.timestamp < rateEnd
            && $.okuMPendingRatePerSecond > Constants.PRECISION;
    }

    /// @dev Multiplier projected at `okuMRateEnd`, including the armed successor.
    function _projectedAtRateEnd(RateScheduleStorage storage $) private view returns (uint256) {
        uint256 rateEnd = $.okuMRateEnd;
        return MathLib.computeMultiplier(
            $.okuMBaseMultiplier,
            $.okuMRatePerSecond,
            $.okuMLastAccrualTime,
            rateEnd,
            $.okuMPendingRatePerSecond,
            $.okuMPendingRateEnd,
            rateEnd
        );
    }

    /// @dev Emits {IScaledUIAmount-UIMultiplierUpdateCancelled} for a staged, not yet active
    ///      successor. Call BEFORE the caller mutates the schedule.
    function _emitPendingRateCancelledIfArmed(RateScheduleStorage storage $) private {
        if (!_successorArmed($)) return;
        emit UIMultiplierUpdateCancelled(_projectedAtRateEnd($), $.okuMRateEnd);
    }

    /// @dev Collapse to a flat, halted schedule anchored at `base` and now.
    function _haltSchedule(RateScheduleStorage storage $, uint256 base) private {
        $.okuMBaseMultiplier = SafeCast.toUint96(base);
        $.okuMLastAccrualTime = SafeCast.toUint48(block.timestamp);
        $.okuMRatePerSecond = NO_YIELD_RATE;
        $.okuMRateEnd = 0;
        $.okuMPendingRatePerSecond = NO_YIELD_RATE;
        $.okuMPendingRateEnd = 0;
    }
}
