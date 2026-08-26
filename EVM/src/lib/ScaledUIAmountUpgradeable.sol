// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";
import {Errors} from "./Errors.sol";
import {MathLib} from "./MathLib.sol";
import {IScaledUIAmount} from "../interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title ScaledUIAmountUpgradeable
 * @notice ERC-8056 display layer: stepwise UI multiplier (`M_oku`) plus the
 *         core interface and all three extensions.
 *
 * @dev DESIGN — a stored, stepwise, monotone multiplier. `M_oku` is the
 *      *realized* index: dollars per raw token, written when off-chain RWA
 *      performance is marked. T-Bill performance is a discrete mark, not a
 *      rate-per-second — publishing it continuously would make it
 *      forward-looking, which is USDOku's job, not OkuM's. This also matches
 *      Token-2022's `ScaledUiAmount` on SVM, which is stepwise by construction,
 *      so both chains share the same value at the same cadence.
 *
 *      STEPS ARE IMMEDIATE. The ERC-8056 pending-multiplier extension is
 *      implemented degenerately: `newUIMultiplier()` reports the value of the
 *      last step and `effectiveAt()` the timestamp it took effect, so
 *      `uiMultiplier() == newUIMultiplier()` holds from the moment of every
 *      write. Future-dated steps are deliberately NOT supported: a scheduled
 *      step matures with no transaction, which would recreate the
 *      unfenceable-revaluation problem the sync window exists to close (nothing
 *      can auto-arm at maturity). This also sidesteps the reference
 *      implementation's documented `>=`/`>` boundary defect — there is never a
 *      matured-but-uncrystallized pending value.
 *
 *      STEP COVERAGE. Every step records `stepBps` and ratchets
 *      `stepHighWaterMark`, the floor under the module's `tin + tout` fee
 *      schedule. The inheriting token enforces `tin + tout >= stepBps` at write
 *      time; the module enforces `tin + tout >= stepHighWaterMark` at fee-set
 *      time. Together they close local step arbitrage
 *      (mint-at-M0 / redeem-at-M1 across a step).
 *
 *      This contract deliberately does NOT hold raw balances, allowances, or
 *      total supply. Those stay in OZ's `ERC20Upgradeable` namespace, untouched.
 *
 *      Storage uses ERC-7201 namespaced storage. See https://eips.ethereum.org/EIPS/eip-7201
 */
abstract contract ScaledUIAmountUpgradeable is
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.ScaledUIAmount
    struct ScaledUIAmountStorage {
        /// @dev `M_oku`. Current, live value. Starts at `PRECISION` ($1.00).
        uint256 multiplier;
        /// @dev Timestamp of the last step. ERC-8056's `effectiveAt()`.
        uint256 lastSteppedAt;
        /// @dev Largest `stepBps` ever taken. Floors the module's `tin + tout`
        ///      so fees cannot later drop below a step already taken. Cleared
        ///      only by the cold-gated `resetStepHighWaterMark`.
        uint256 stepHighWaterMark;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.ScaledUIAmount")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SCALED_UI_AMOUNT_STORAGE_LOCATION =
        0x3cb9c1d6aa88f069eb5ba8341839db9b5d23817fee13933ec1221e36b8fe7800;

    function _getScaledUIAmountStorage() private pure returns (ScaledUIAmountStorage storage $) {
        assembly {
            $.slot := SCALED_UI_AMOUNT_STORAGE_LOCATION
        }
    }

    // ============ Errors ============

    /// @notice A single step exceeded `Constants.MAX_STEP_BPS`.
    error StepAboveMaximum(uint256 stepBps, uint256 maxStepBps);
    /// @notice The new multiplier would exceed `Constants.MAX_MULTIPLIER`.
    error MultiplierAboveMaximum(uint256 requested, uint256 maximum);

    // ============ Events ============

    /// @notice Emitted on every step, alongside ERC-8056's `UIMultiplierUpdated`.
    /// @param oldMultiplier `M_oku` before the step.
    /// @param newMultiplier `M_oku` after the step.
    /// @param stepBps Step size in basis points of the old value, rounded up.
    event OkuMultiplierStepped(uint256 oldMultiplier, uint256 newMultiplier, uint256 stepBps);

    /// @notice The cold-gated step-coverage escape hatch fired.
    /// @dev Clears the fee floor and reopens historical step exposure. Should be
    ///      rare and deliberate — ALARM ON THIS EVENT.
    event StepHighWaterMarkReset(uint256 oldMark);

    // ============ Initialization ============

    /// @dev Seeds `multiplier = PRECISION` ($1.00) and stamps `lastSteppedAt` so
    ///      `effectiveAt()` never returns 0 and staleness math never underflows.
    // solhint-disable-next-line func-name-mixedcase
    function __ScaledUIAmount_init() internal {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        $.multiplier = Constants.PRECISION;
        $.lastSteppedAt = block.timestamp;
    }

    // ============ ERC-8056 Core ============

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() public view virtual returns (uint256) {
        return _getScaledUIAmountStorage().multiplier;
    }

    // ============ ERC-8056 Pending Multiplier (REQUIRED extension) ============

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev Steps are immediate, so the "pending" value is always the live one.
    ///      `uiMultiplier() == newUIMultiplier()` is an invariant of this token,
    ///      asserted in the conformance suite.
    function newUIMultiplier() public view virtual returns (uint256) {
        return _getScaledUIAmountStorage().multiplier;
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev Timestamp of the last step. Doubles as the staleness anchor for
    ///      `OkuMultiplierAdapter` — a lapsed mark leaves the multiplier flat
    ///      and truthful, but a consumer should not price off it indefinitely.
    function effectiveAt() public view virtual returns (uint256) {
        return _getScaledUIAmountStorage().lastSteppedAt;
    }

    // ============ ERC-8056 Conversion (OPTIONAL extension) ============

    /// @inheritdoc IScaledUIAmountConversion
    function toUIAmount(uint256 rawAmount) public view virtual returns (uint256) {
        return MathLib.toUiAmount(rawAmount, uiMultiplier());
    }

    /// @inheritdoc IScaledUIAmountConversion
    function fromUIAmount(uint256 uiAmount) public view virtual returns (uint256) {
        return MathLib.fromUiAmount(uiAmount, uiMultiplier());
    }

    // ============ ERC-8056 Balances (OPTIONAL extension) ============
    // `balanceOfUI` / `totalSupplyUI` are implemented by the inheriting token,
    // which owns the raw ledger.

    // ============ Storage accessors ============

    /// @notice Timestamp of the last multiplier step. Alias of `effectiveAt()`.
    function lastSteppedAt() external view returns (uint256) {
        return _getScaledUIAmountStorage().lastSteppedAt;
    }

    /// @notice Largest single step ever taken, in basis points.
    /// @dev Floors the module's `tin + tout`. See step coverage in the README.
    function stepHighWaterMark() public view virtual returns (uint256) {
        return _getScaledUIAmountStorage().stepHighWaterMark;
    }

    // ============ Internal: step management ============

    /// @dev Applies an immediate, bounded, monotone step and ratchets the
    ///      high-water mark. The inheriting token layers policy on top (role
    ///      gate, halt flag, step-coverage fee check, sync-window arming).
    ///
    ///      `stepBps` rounds UP: the coverage comparison `tin + tout >= stepBps`
    ///      must be conservative, and rounding the step down would let a
    ///      fractionally-larger-than-covered step through.
    ///
    ///      Emits both `OkuMultiplierStepped` (protocol) and
    ///      `UIMultiplierUpdated` (ERC-8056 required).
    function _stepMultiplier(uint256 newMultiplier_) internal returns (uint256 stepBps) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 old = $.multiplier;

        // Monotonicity: the multiplier can never decrease. Strict, so a no-op
        // write cannot be used to re-arm the sync window for free. Deliberate
        // narrowing of ERC-8056, which explicitly supports reverse splits.
        if (newMultiplier_ <= old) revert Errors.MultiplierCannotDecrease();
        if (newMultiplier_ > Constants.MAX_MULTIPLIER) {
            revert MultiplierAboveMaximum(newMultiplier_, Constants.MAX_MULTIPLIER);
        }

        stepBps = Math.ceilDiv((newMultiplier_ - old) * Constants.BASIS_POINTS, old);
        if (stepBps > Constants.MAX_STEP_BPS) {
            revert StepAboveMaximum(stepBps, Constants.MAX_STEP_BPS);
        }

        $.multiplier = newMultiplier_;
        $.lastSteppedAt = block.timestamp;
        if (stepBps > $.stepHighWaterMark) $.stepHighWaterMark = stepBps;

        emit OkuMultiplierStepped(old, newMultiplier_, stepBps);
        emit UIMultiplierUpdated(old, newMultiplier_, block.timestamp);
    }

    /// @dev Clears the step high-water mark. Cold-only escape hatch, gated by
    ///      the inheriting token. Its honest precondition — that supply
    ///      outstanding at the time of the large step has substantially turned
    ///      over — is not verifiable on-chain, which is why the event should be
    ///      alarmed on.
    function _resetStepHighWaterMark() internal {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 oldMark = $.stepHighWaterMark;
        $.stepHighWaterMark = 0;
        emit StepHighWaterMarkReset(oldMark);
    }
}
