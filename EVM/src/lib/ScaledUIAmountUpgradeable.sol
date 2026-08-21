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
 * @notice ERC-8056 display layer: continuous rate-based UI multiplier plus the
 *         core interface and all three extensions.
 *
 * @dev DESIGN — four storage fields and one setter. There is no second
 *      multiplier, no pending multiplier *value*, and no scheduled step.
 *
 *      ```
 *      uiMultiplier() = baseMultiplier * rpow(ratePerSecond, elapsed, PRECISION) / PRECISION
 *      elapsed        = min(block.timestamp, rateEnd) - lastAccrualTime
 *      ```
 *
 *      Continuous accrual (the Aave liquidity-index / sDAI `chi` pattern) is
 *      chosen over discrete revaluation because a discrete step creates a single
 *      block at which every cached multiplier in every integration is
 *      simultaneously wrong — an arbitrage window against your own integrators.
 *      A rate change moves only the *slope*; the multiplier itself is continuous,
 *      so there is nothing to front-run and no sandwich guard is required.
 *
 *      ACCRUAL HALTS AT `rateEnd`. This is a safety mechanism, not merely
 *      scheduling: if the rate setter stops functioning, the multiplier stops
 *      growing rather than accruing indefinitely against assets that are not
 *      there. `rateEnd` is mandatory — a zero or past value is rejected.
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
        /// @dev Multiplier anchor, snapshotted at the last rate write.
        uint256 baseMultiplier;
        /// @dev Compound per-second rate. `PRECISION` == no yield.
        uint256 ratePerSecond;
        /// @dev Timestamp `baseMultiplier` was snapshotted at.
        uint256 lastAccrualTime;
        /// @dev Accrual halts here. Also ERC-8056's `effectiveAt()`.
        uint256 rateEnd;
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

    /// @notice Annualized rate exceeded `Constants.MAX_IMPLIED_APR`.
    error RateAboveMaximum(uint256 impliedAprBps, uint256 maxAprBps);
    /// @notice `endTimestamp` was zero or not strictly in the future.
    error RateEndNotInFuture();
    /// @notice `endTimestamp - block.timestamp` exceeded `Constants.MAX_RATE_DURATION`.
    error RateDurationTooLong(uint256 requested, uint256 maximum);
    /// @notice The multiplier projected to `rateEnd` would exceed `Constants.MAX_MULTIPLIER`.
    error MultiplierAboveMaximum(uint256 projected, uint256 maximum);

    // ============ Events ============

    /// @notice Emitted on every rate write, alongside ERC-8056's `UIMultiplierUpdated`.
    /// @param oldRate Previous `ratePerSecond`.
    /// @param newRate New `ratePerSecond`.
    /// @param rateEnd New accrual halt boundary.
    /// @param snapshotMultiplier `baseMultiplier` after re-anchoring, so an
    ///        indexer can reconstruct the trajectory from events alone.
    event YieldRateSet(
        uint256 oldRate, uint256 newRate, uint256 rateEnd, uint256 snapshotMultiplier
    );

    /// @notice Emitted when the guardian halts accrual.
    /// @param atMultiplier The multiplier frozen in place.
    event AccrualHalted(uint256 atMultiplier);

    // ============ Initialization ============

    /// @dev Seeds a neutral, self-consistent state:
    ///      `baseMultiplier = ratePerSecond = PRECISION` and
    ///      `rateEnd = lastAccrualTime = block.timestamp`.
    ///
    ///      `rateEnd` MUST equal `lastAccrualTime` rather than being left zero.
    ///      With `rateEnd == 0` and `lastAccrualTime == block.timestamp`, the
    ///      subtraction in `newUIMultiplier()` would underflow and revert,
    ///      bricking every ERC-165-detected integration on day one. With them
    ///      equal, `rpow(x, 0, PRECISION) == PRECISION`, so
    ///      `uiMultiplier() == newUIMultiplier() == PRECISION`.
    // solhint-disable-next-line func-name-mixedcase
    function __ScaledUIAmount_init() internal {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        $.baseMultiplier = Constants.PRECISION;
        $.ratePerSecond = Constants.PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.rateEnd = block.timestamp;
    }

    // ============ ERC-8056 Core ============

    /// @inheritdoc IScaledUIAmount
    function uiMultiplier() public view virtual returns (uint256) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 rateEnd_ = $.rateEnd;
        uint256 until = block.timestamp < rateEnd_ ? block.timestamp : rateEnd_;
        uint256 last = $.lastAccrualTime;
        if (until <= last) return $.baseMultiplier;
        return _compound($.baseMultiplier, $.ratePerSecond, until - last);
    }

    // ============ ERC-8056 Pending Multiplier (REQUIRED extension) ============

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    /// @dev The multiplier the trajectory reaches at `rateEnd` — where growth
    ///      stops absent a renewed rate. See the interface NatSpec for why this
    ///      reading of the extension is safe under continuous accrual.
    ///
    ///      The `rateEnd <= lastAccrualTime` branch is defensive: `setYieldRate`
    ///      always leaves `rateEnd > lastAccrualTime`, and `__ScaledUIAmount_init`
    ///      / `haltAccrual` leave them equal. The guard costs nothing and turns a
    ///      future refactor bug into a correct answer rather than a reverting view.
    function newUIMultiplier() public view virtual returns (uint256) {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 rateEnd_ = $.rateEnd;
        uint256 last = $.lastAccrualTime;
        if (rateEnd_ <= last) return $.baseMultiplier;
        return _compound($.baseMultiplier, $.ratePerSecond, rateEnd_ - last);
    }

    /// @inheritdoc IScaledUIAmountNewUIMultiplier
    function effectiveAt() public view virtual returns (uint256) {
        return _getScaledUIAmountStorage().rateEnd;
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

    /// @notice Multiplier anchor snapshotted at the last rate write.
    function baseMultiplier() external view returns (uint256) {
        return _getScaledUIAmountStorage().baseMultiplier;
    }

    /// @notice Compound per-second accrual rate (`PRECISION` == no yield).
    function ratePerSecond() external view returns (uint256) {
        return _getScaledUIAmountStorage().ratePerSecond;
    }

    /// @notice Timestamp the anchor was snapshotted at.
    function lastAccrualTime() external view returns (uint256) {
        return _getScaledUIAmountStorage().lastAccrualTime;
    }

    /// @notice Accrual halt boundary. Alias of `effectiveAt()`.
    function rateEnd() external view returns (uint256) {
        return _getScaledUIAmountStorage().rateEnd;
    }

    /// @notice Nominal annualized rate currently in force, in basis points.
    /// @dev Simple annualization; see `Constants.MAX_IMPLIED_APR`. Returns 0 when
    ///      accrual is halted or the rate is the no-yield placeholder.
    function impliedAprBps() external view returns (uint256) {
        return _impliedAprBps(_getScaledUIAmountStorage().ratePerSecond);
    }

    // ============ Internal: rate management ============

    /// @dev Re-anchors to the live multiplier, then writes the new rate and end.
    ///      Because it re-anchors from the current value, calling this before
    ///      `rateEnd` extends accrual seamlessly with no gap and no step — which
    ///      is why no separate "pending rate" staging field is needed.
    ///
    ///      Emits both `YieldRateSet` (protocol) and `UIMultiplierUpdated`
    ///      (ERC-8056 required).
    function _setYieldRate(uint256 newRatePerSecond, uint256 endTimestamp) internal {
        // Monotonicity: the multiplier can never decrease. Deliberate narrowing
        // of ERC-8056, which explicitly supports reverse splits.
        if (newRatePerSecond < Constants.PRECISION) revert Errors.MultiplierCannotDecrease();

        uint256 apr = _impliedAprBps(newRatePerSecond);
        if (apr > Constants.MAX_IMPLIED_APR) {
            revert RateAboveMaximum(apr, Constants.MAX_IMPLIED_APR);
        }

        if (endTimestamp <= block.timestamp) revert RateEndNotInFuture();
        uint256 duration = endTimestamp - block.timestamp;
        if (duration > Constants.MAX_RATE_DURATION) {
            revert RateDurationTooLong(duration, Constants.MAX_RATE_DURATION);
        }

        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 oldMultiplier = uiMultiplier();
        uint256 oldRate = $.ratePerSecond;

        // Project to the new rateEnd and bound it before committing, so the
        // ceiling cannot be breached mid-segment.
        uint256 projected = _compound(oldMultiplier, newRatePerSecond, duration);
        if (projected > Constants.MAX_MULTIPLIER) {
            revert MultiplierAboveMaximum(projected, Constants.MAX_MULTIPLIER);
        }

        $.baseMultiplier = oldMultiplier;
        $.lastAccrualTime = block.timestamp;
        $.ratePerSecond = newRatePerSecond;
        $.rateEnd = endTimestamp;

        emit YieldRateSet(oldRate, newRatePerSecond, endTimestamp, oldMultiplier);
        emit UIMultiplierUpdated(oldMultiplier, projected, endTimestamp);
    }

    /// @dev Freezes the multiplier at its current value, immediately, no timelock.
    ///      Monotone-safe: it stops growth without reducing anything accrued.
    ///
    ///      Sets `rateEnd = lastAccrualTime = block.timestamp` as well as zeroing
    ///      the rate. Leaving `rateEnd` in the future would put the token in an
    ///      ambiguous "live rate that yields nothing" state, where `effectiveAt()`
    ///      returns a future timestamp implying something will happen then. With
    ///      all three equal, `uiMultiplier() == newUIMultiplier()` and
    ///      `effectiveAt() == block.timestamp`, which reads unambiguously as
    ///      "halted, nothing pending".
    function _haltAccrual() internal {
        ScaledUIAmountStorage storage $ = _getScaledUIAmountStorage();
        uint256 frozen = uiMultiplier();
        $.baseMultiplier = frozen;
        $.ratePerSecond = Constants.PRECISION;
        $.lastAccrualTime = block.timestamp;
        $.rateEnd = block.timestamp;
        emit AccrualHalted(frozen);
        emit UIMultiplierUpdated(frozen, frozen, block.timestamp);
    }

    // ============ Internal: math ============

    /// @dev `base * rate^elapsed`. Identity at `elapsed == 0` or a no-yield rate.
    ///
    ///      Deliberately does NOT clamp at `MAX_MULTIPLIER`. An earlier revision
    ///      clamped here, which silently made the explicit `MultiplierAboveMaximum`
    ///      check in `_setYieldRate` unreachable dead code — the clamp guaranteed
    ///      the comparison could never be true. Bounding at the authority boundary
    ///      with an informative revert is strictly better than silently flattening
    ///      the trajectory inside a view.
    ///
    ///      `uiMultiplier()` still cannot exceed `MAX_MULTIPLIER` or revert:
    ///      `_setYieldRate` proves the projection to `rateEnd` is both computable
    ///      and within bounds before committing, and accrual is monotone in
    ///      elapsed time clamped at `rateEnd`, so every later evaluation is a
    ///      strictly smaller case of a computation that already succeeded.
    function _compound(uint256 base, uint256 rate, uint256 elapsed) private pure returns (uint256) {
        if (elapsed == 0 || rate <= Constants.PRECISION) return base;
        return Math.mulDiv(
            base,
            MathLib.rpow(rate, elapsed, Constants.PRECISION),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    /// @dev Nominal (simple) annualization of a per-second rate, in bps.
    ///      `apr = (rate - PRECISION) * SECONDS_PER_YEAR * BASIS_POINTS / PRECISION`.
    function _impliedAprBps(uint256 rate) private pure returns (uint256) {
        if (rate <= Constants.PRECISION) return 0;
        uint256 excess = rate - Constants.PRECISION;
        return Math.mulDiv(
            excess * Constants.SECONDS_PER_YEAR,
            Constants.BASIS_POINTS,
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }
}
