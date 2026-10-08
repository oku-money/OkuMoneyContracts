// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math utilities for OkuMoney contracts
 * @dev See Constants.sol for the terminology legend.
 *
 *      ROUNDING: conversions use `Math.mulDiv`, floor by default. `rpow` keeps MakerDAO's
 *      half-up assembly rounding.
 *
 *      Exactly THREE `Math.Rounding.Ceil` sites exist, all in `OkuDollar` and all rounding
 *      against the caller (ERC-4626 convention):
 *        - `_unwrap`'s `sharesToBurn` (favors the vault)
 *        - `previewMint`     (assets the caller must deposit)
 *        - `previewWithdraw` (shares the caller must burn)
 *      SVM has no equivalent ceil primitive; see `oku-shared/src/math.rs` before porting.
 */
library MathLib {
    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring)
     * @dev Adapted verbatim from MakerDAO's `rpow`:
     *      https://github.com/makerdao/dss/blob/master/src/pot.sol
     * @param x Base value (typically ratePerSecond, scaled by PRECISION)
     * @param n Exponent (typically elapsed seconds)
     * @param b Precision base (typically 1e18)
     * @return z Result of x^n / b^(n-1)
     */
    // forge-lint: disable-next-item(require-revert-in-loop)
    // Reason: overflow reverts inside the squaring loop are the verbatim MakerDAO rpow; the
    // loop is O(log n) and the revert aborts the whole call, so there is no partial state.
    function rpow(uint256 x, uint256 n, uint256 b) internal pure returns (uint256 z) {
        assembly {
            switch x
            case 0 {
                switch n
                case 0 { z := b }
                default { z := 0 }
            }
            default {
                // Start the result at x^(lowest bit of n): 1.0 (b) or x.
                switch mod(n, 2)
                case 0 { z := b }
                default { z := x }
                let half := div(b, 2) // added before each divide: half-up rounding
                // For each remaining bit of n: square x, and multiply it into z when the bit
                // is set. Every multiply checks for overflow and reverts on it.
                for { n := div(n, 2) } n { n := div(n, 2) } {
                    let xx := mul(x, x)
                    if iszero(eq(div(xx, x), x)) { revert(0, 0) }
                    let xxRound := add(xx, half)
                    if lt(xxRound, xx) { revert(0, 0) }
                    x := div(xxRound, b)
                    if mod(n, 2) {
                        let zx := mul(z, x)
                        if and(iszero(iszero(x)), iszero(eq(div(zx, x), z))) {
                            revert(0, 0)
                        }
                        let zxRound := add(zx, half)
                        if lt(zxRound, zx) { revert(0, 0) }
                        z := div(zxRound, b)
                    }
                }
            }
        }
    }

    /**
     * @notice Compound `base` by `rate^elapsed`, capped at {Constants.MAX_MULTIPLIER}.
     * @dev Identity when `elapsed == 0`. The cap bounds only the OUTPUT; callers must bound
     *      `elapsed` (see {Constants.MAX_RATE_WINDOW}) so `rpow` cannot overflow.
     * @param base Starting multiplier (PRECISION-scaled)
     * @param rate Per-second rate (PRECISION = no yield)
     * @param elapsed Seconds to compound over
     * @return Compounded multiplier, clamped to `MAX_MULTIPLIER`
     */
    function compoundFor(
        uint256 base,
        uint256 rate,
        uint256 elapsed
    )
        internal
        pure
        returns (uint256)
    {
        if (elapsed == 0) return base;
        uint256 result = Math.mulDiv(
            base, rpow(rate, elapsed, Constants.PRECISION), Constants.PRECISION, Math.Rounding.Floor
        );
        return result > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : result;
    }

    /**
     * @notice Continuous streaming accrual, the protocol's single multiplier function.
     * @dev Pure function of the schedule and `nowTs` (no supply term), so every chain agrees
     *      given the same state. `pendingRate` activates at `rateEnd` with no transaction.
     *
     *      No leg ever compounds over an interval before `anchor`: `base` is already the
     *      multiplier AS OF `anchor`, so re-applying yield there would double-count.
     * @param base Snapshot multiplier taken at `anchor`
     * @param rate Active per-second rate (PRECISION = no yield)
     * @param anchor Timestamp `base` was snapshotted at
     * @param rateEnd Timestamp `rate` expires; 0 if and only if `rate == PRECISION`
     *        (OkuMoney's writers enforce both directions; branch 1 relies on it)
     * @param pendingRate Successor rate, active after `rateEnd` (PRECISION = none)
     * @param pendingRateEnd Timestamp `pendingRate` expires (0 = none armed); bounds the overhang
     * @param nowTs Evaluation timestamp (`block.timestamp`)
     * @return Current multiplier, PRECISION-scaled
     */
    function computeMultiplier(
        uint256 base,
        uint256 rate,
        uint256 anchor,
        uint256 rateEnd,
        uint256 pendingRate,
        uint256 pendingRateEnd,
        uint256 nowTs
    )
        internal
        pure
        returns (uint256)
    {
        // Branch 1: no-yield placeholder; flat base. `rateEnd == 0` here by writer invariant,
        // so this branch must not gain an overhang leg (it would double-count [rateEnd, anchor]).
        if (rate <= Constants.PRECISION) {
            return base;
        }

        // Branch 2: yielding rate whose window has closed.
        if (rateEnd != 0 && nowTs > rateEnd) {
            // `anchor` never exceeds `rateEnd` under OkuMoney's writers; the ternary keeps a
            // writer bug from reverting this view, which every balance read depends on.
            uint256 elapsedInWindow = anchor < rateEnd ? rateEnd - anchor : 0;
            uint256 compounded = compoundFor(base, rate, elapsedInWindow);
            if (pendingRate > Constants.PRECISION) {
                compounded =
                    _overhang(compounded, pendingRate, anchor, rateEnd, pendingRateEnd, nowTs);
            }
            return compounded;
        }

        // Branch 3: active rate still running (nowTs <= rateEnd, which is always set here).
        return compoundFor(base, rate, nowTs - anchor);
    }

    /// @dev Compounds the successor from `max(anchor, rateEnd)` to `min(nowTs, pendingRateEnd)`.
    function _overhang(
        uint256 compounded,
        uint256 pendingRate,
        uint256 anchor,
        uint256 rateEnd,
        uint256 pendingRateEnd,
        uint256 nowTs
    )
        private
        pure
        returns (uint256)
    {
        uint256 start = anchor > rateEnd ? anchor : rateEnd;
        uint256 end = (pendingRateEnd != 0 && nowTs > pendingRateEnd) ? pendingRateEnd : nowTs;
        return end > start ? compoundFor(compounded, pendingRate, end - start) : compounded;
    }

    /// @notice OkuM amount to dollar value (18 decimals), rounded down.
    function okuMToDollars(
        uint256 okuMAmount,
        uint256 okuMMultiplier
    )
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(okuMAmount, okuMMultiplier, Constants.PRECISION, Math.Rounding.Floor);
    }

    /// @notice Dollar value (18 decimals) to OkuM amount, rounded down.
    function dollarsToOkuM(
        uint256 dollarValue,
        uint256 okuMMultiplier
    )
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(dollarValue, Constants.PRECISION, okuMMultiplier, Math.Rounding.Floor);
    }

    /// @notice 18-decimal dollar value to USDC native decimals, rounded down.
    /// @param decimalMultiplier `10 ** (18 - usdcDecimals)`, resolved at init (1e12 for USDC).
    function dollarsToUsdc(
        uint256 dollarValue18,
        uint256 decimalMultiplier
    )
        internal
        pure
        returns (uint256)
    {
        return dollarValue18 / decimalMultiplier;
    }

    /// @notice USDC native decimals to 18-decimal dollar value.
    /// @param decimalMultiplier See {dollarsToUsdc}.
    function usdcToDollars(
        uint256 usdcAmount,
        uint256 decimalMultiplier
    )
        internal
        pure
        returns (uint256)
    {
        return usdcAmount * decimalMultiplier;
    }
}
