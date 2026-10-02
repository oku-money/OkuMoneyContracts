// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math utilities for OkuMoney contracts
 * @dev See Constants.sol for terminology legend.
 *
 *      ROUNDING POLICY: conversions use OpenZeppelin `Math.mulDiv` for 512-bit
 *      intermediates and explicit `Math.Rounding`. Floor is the default. `rpow` keeps
 *      MakerDAO's half-up assembly rounding — it has no direct `mulDiv` equivalent.
 *
 *      There are exactly THREE `Math.Rounding.Ceil` sites in the protocol, all in
 *      `OkuDollar` and all rounding against the caller (ERC-4626 convention — round up
 *      whatever the caller must supply):
 *        - `_unwrap`'s `sharesToBurn`   — burns at least as many shares as the dollars
 *                                         withdrawn are worth; favors the vault.
 *        - `previewMint`                — assets the caller must deposit for N shares.
 *        - `previewWithdraw`            — shares the caller must burn for N assets.
 *      The latter two are view-only, so they move no value; they are listed because this
 *      is the file a reviewer consults to reason about protocol-wide rounding direction,
 *      and an incomplete list here is how a future Ceil site gets added unnoticed. (An
 *      earlier version of this comment asserted `sharesToBurn` was the only one.)
 *
 *      NOTE the SVM side has NO equivalent of these: `oku-shared`'s only ceil primitive
 *      is `mul_div_ceil`, which takes `u64` arguments and therefore cannot represent a
 *      WAD-scale multiplier as its divisor. If any of the above is ever ported, it needs
 *      a new primitive — reaching for `dollars_to_raw` (floor) would invert the rounding
 *      direction on a user withdrawal. See `oku-shared/src/math.rs`.
 */
library MathLib {
    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring)
     * @dev Adapted verbatim from MakerDAO's `rpow` (battle-tested since 2017):
     *      https://github.com/makerdao/dss/blob/master/src/pot.sol
     *      Used by {compoundFor} / {computeMultiplier}. `setOkuMMultiplier`, the
     *      discrete emergency override, does NOT use rpow — it writes the base
     *      multiplier directly.
     * @param x Base value (typically ratePerSecond, scaled by PRECISION)
     * @param n Exponent (typically elapsed seconds)
     * @param b Precision base (typically 1e18)
     * @return z Result of x^n / b^(n-1)
     */
    function rpow(uint256 x, uint256 n, uint256 b) internal pure returns (uint256 z) {
        assembly {
            switch x
            case 0 {
                switch n
                case 0 { z := b }
                default { z := 0 }
            }
            default {
                switch mod(n, 2)
                case 0 { z := b }
                default { z := x }
                let half := div(b, 2)
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
     * @dev Identity when `elapsed == 0`. Callers bound `elapsed` via the mandatory
     *      rate-window timestamps on OkuMoney's schedule — every yielding rate carries
     *      a bounded window. That requirement exists so an open-ended rate can never end
     *      at a transaction-dependent, per-chain moment (EVM/README.md § Streaming
     *      Accrual), and it keeps `rpow` in range: the `MAX_MULTIPLIER` cap bounds only
     *      the OUTPUT and cannot stop `rpow` reverting internally on a huge `elapsed`
     *      (at `MAX_RATE`, `rpow` itself overflows past ~15 years).
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
     * @notice Continuous streaming accrual — the protocol's single multiplier function.
     * @dev Shared by {OkuMoney.okuMMultiplier} and (transitively) {OkuDollar.usdMultiplier}
     *      so the two can never diverge. Pure function of the rate schedule and `nowTs`,
     *      with no supply term — which is what makes the multiplier identical across
     *      chains given identical schedule state and timestamp. `pendingRate` activates
     *      with no transaction at the boundary, keeping multi-chain epoch handovers
     *      simultaneous. See the three branch comments in the body.
     *
     *      No leg ever compounds over an interval preceding `anchor`: `base` is by
     *      definition the multiplier AS OF `anchor`, so time before it is already
     *      settled and re-applying yield to it would double-count. Branch 2's
     *      `max(anchor, rateEnd)` overhang start is that rule, not mere symmetry.
     * @param base Snapshot multiplier taken at `anchor`
     * @param rate Active per-second rate (PRECISION = no yield)
     * @param anchor Timestamp `base` was snapshotted at
     * @param rateEnd Timestamp `rate` expires. 0 if and only if `rate == PRECISION` —
     *        OkuMoney's writers enforce both directions, and branch 1 relies on it
     * @param pendingRate Successor rate, active after `rateEnd` (PRECISION = none)
     * @param pendingRateEnd Timestamp `pendingRate` itself expires (0 = none armed) —
     *        bounds the overhang so an unattended successor cannot compound forever
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
        // Branch 1: active rate is the no-yield placeholder, so nothing accrues and the
        // multiplier is the flat base.
        //
        // `rateEnd` is necessarily 0 whenever this branch is taken, so a halted rate can
        // never have a successor armed behind it. OkuMoney's writers are the complete
        // write set for the schedule and each one maintains that: the initializer leaves
        // `okuMRateEnd` at 0; {OkuMoney.setOkuMYieldRate} reverts on a non-zero
        // `endTimestamp` for a halted rate, and on any rate below PRECISION;
        // {OkuMoney.setOkuMMultiplier} clears rate and window together; and
        // {OkuMoney.setNextOkuMYieldRate} can only arm a successor while `rateEnd != 0`.
        //
        // This branch therefore carries NO overhang leg, and must not acquire one. A
        // defensive fallback here would have to compound from `max(anchor, rateEnd)` as
        // branch 2 does; compounding from `rateEnd` — the obvious implementation —
        // applies yield across `[rateEnd, anchor]`, a span that precedes the snapshot and
        // is already baked into `base`, double-counting it in exactly the state the
        // fallback claims to protect.
        if (rate <= Constants.PRECISION) {
            return base;
        }

        // Branch 2: active rate is yielding and its window has closed.
        if (rateEnd != 0 && nowTs > rateEnd) {
            // Defensive: `anchor` is never past `rateEnd` under OkuMoney's writers (every
            // write moving `anchor` clears `rateEnd` or sets a fresh future one); guard
            // the subtraction anyway so a future writer bug cannot brick this view.
            // Unlike branch 1's removed fallback, these guards earn their keep: without
            // the ternary below the checked subtraction would revert, bricking a view
            // that every balance read and every PSM mint/redeem depends on.
            uint256 elapsedInWindow = anchor < rateEnd ? rateEnd - anchor : 0;
            uint256 compounded = compoundFor(base, rate, elapsedInWindow);
            if (pendingRate > Constants.PRECISION) {
                uint256 overhangStart = anchor > rateEnd ? anchor : rateEnd;
                // Bound the overhang at `pendingRateEnd`: an unattended successor
                // compounds only to its own expiry, then accrual halts.
                uint256 overhangEnd =
                    (pendingRateEnd != 0 && nowTs > pendingRateEnd) ? pendingRateEnd : nowTs;
                if (overhangEnd > overhangStart) {
                    compounded = compoundFor(compounded, pendingRate, overhangEnd - overhangStart);
                }
            }
            return compounded;
        }

        // Branch 3: active rate still running. Bounded because nowTs <= rateEnd
        // here and every yielding rate has rateEnd set at write time.
        return compoundFor(base, rate, nowTs - anchor);
    }

    /**
     * @notice Convert OkuMoney token amount to dollar value
     * @param okuMAmount Amount of OkuMoney tokens
     * @param okuMMultiplier Current OkuMoney multiplier (dollar value per token, scaled by PRECISION)
     * @return Dollar value in 18 decimals
     */
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

    /**
     * @notice Convert dollar value to OkuMoney token amount
     * @param dollarValue Dollar value in 18 decimals
     * @param okuMMultiplier Current OkuMoney multiplier (dollar value per token, scaled by PRECISION)
     * @return Amount of OkuMoney tokens
     */
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

    /**
     * @notice Convert 18-decimal dollar value to USDC's native decimal representation
     * @param dollarValue18 Dollar value in 18 decimals
     * @param decimalMultiplier 10**(18 - usdcDecimals); supplied by the caller from
     *        an immutable / storage value resolved at init time via
     *        IERC20Metadata(usdc).decimals(). For Circle USDC this is 1e12.
     * @return USDC amount in its native decimals
     */
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

    /**
     * @notice Convert USDC amount (native decimals) to 18-decimal dollar value
     * @param usdcAmount USDC amount in its native decimals
     * @param decimalMultiplier 10**(18 - usdcDecimals); see {dollarsToUsdc} for sourcing.
     * @return Dollar value in 18 decimals
     */
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
