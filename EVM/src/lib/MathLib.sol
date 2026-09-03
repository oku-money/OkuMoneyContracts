// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math utilities for OkuMoney contracts
 * @dev See Constants.sol for terminology legend.
 *
 *      ROUNDING POLICY: All conversion functions use OpenZeppelin
 *      `Math.mulDiv` for full-precision 512-bit intermediate computation and
 *      explicit `Math.Rounding` semantics. Floor is the default direction;
 *      the only Ceil site in the protocol is `OkuDollar.unwrap`'s
 *      `sharesToBurn` computation, which favors the vault on user
 *      withdrawals (ERC-4626 convention). `rpow` retains MakerDAO's
 *      half-up assembly rounding because it has no direct `mulDiv`
 *      equivalent.
 */
library MathLib {
    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring)
     * @dev Adapted verbatim from MakerDAO's `rpow` — battle-tested since 2017.
     *      Taken from https://github.com/makerdao/dss/blob/master/src/pot.sol
     *      Used by OkuDollar for continuous yield accrual via usdMultiplier().
     *      OkuMoney updates its multiplier discretely (setOkuMMultiplier /
     *      distributeYield) and does NOT use rpow.
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
     * @dev Identity when `elapsed == 0`. The cap keeps a long-running rate at
     *      `MAX_RATE` from pushing the multiplier beyond the overflow-safe region.
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
        uint256 result =
            Math.mulDiv(base, rpow(rate, elapsed, Constants.PRECISION), Constants.PRECISION, Math.Rounding.Floor);
        return result > Constants.MAX_MULTIPLIER ? Constants.MAX_MULTIPLIER : result;
    }

    /**
     * @notice Continuous streaming accrual — the protocol's single multiplier function.
     * @dev Shared by {OkuMoney.okuMMultiplier} and (transitively) {OkuDollar.usdMultiplier}
     *      so the two can never diverge. Pure function of the rate schedule and
     *      `nowTs`; contains no supply term, which is what makes the multiplier
     *      identical across chains given identical schedule state and timestamp.
     *
     *      Branches:
     *        1. Active rate is the no-yield placeholder (`<= PRECISION`): return
     *           `base`, unless the window has closed and a pending rate is armed —
     *           then compound the pending rate over the overhang.
     *        2. Active rate is yielding and the window has closed: compound to
     *           `rateEnd`, then compound the pending rate over the overhang.
     *        3. Otherwise: compound the active rate from `anchor` to `nowTs`.
     *
     *      `rateEnd == 0` is the open-ended sentinel (accrue until the next
     *      schedule write). A `pendingRate` activates with no transaction at the
     *      boundary, which is what keeps multi-chain epoch handovers simultaneous.
     * @param base Snapshot multiplier taken at `anchor`
     * @param rate Active per-second rate (PRECISION = no yield)
     * @param anchor Timestamp `base` was snapshotted at
     * @param rateEnd Timestamp `rate` expires (0 = open-ended)
     * @param pendingRate Successor rate, active after `rateEnd` (PRECISION = none)
     * @param nowTs Evaluation timestamp (`block.timestamp`)
     * @return Current multiplier, PRECISION-scaled
     */
    function computeMultiplier(
        uint256 base,
        uint256 rate,
        uint256 anchor,
        uint256 rateEnd,
        uint256 pendingRate,
        uint256 nowTs
    )
        internal
        pure
        returns (uint256)
    {
        // Branch 1: active rate is the no-yield placeholder.
        if (rate <= Constants.PRECISION) {
            if (rateEnd != 0 && nowTs > rateEnd && pendingRate > Constants.PRECISION) {
                return compoundFor(base, pendingRate, nowTs - rateEnd);
            }
            return base;
        }

        // Branch 2: active rate is yielding and its window has closed.
        if (rateEnd != 0 && nowTs > rateEnd) {
            uint256 compounded = compoundFor(base, rate, rateEnd - anchor);
            if (pendingRate > Constants.PRECISION) {
                compounded = compoundFor(compounded, pendingRate, nowTs - rateEnd);
            }
            return compounded;
        }

        // Branch 3: active rate still running.
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

    /**
     * @notice Compute the OkuDollar share count produced by wrapping `okuMAmount`.
     * @dev Single source of truth for `OkuDollar.wrap`'s share formula.
     *      shares = mulDiv(okuMAmount, okuMMultiplier, usdMultiplier, Floor)
     * @param okuMAmount OkuMoney token amount being wrapped
     * @param okuMMult Current okuMMultiplier
     * @param usdMult Current usdMultiplier (must be non-zero)
     * @return shares Internal OkuDollar share count credited to the receiver
     */
    function wrappedSharesFromOkuM(
        uint256 okuMAmount,
        uint256 okuMMult,
        uint256 usdMult
    )
        internal
        pure
        returns (uint256 shares)
    {
        return Math.mulDiv(okuMAmount, okuMMult, usdMult, Math.Rounding.Floor);
    }

    /**
     * @notice Compute the dollar-denominated UsdOku amount minted when wrapping `okuMAmount`.
     * @dev Replicates `OkuDollar.wrap`'s two-step truncation exactly:
     *        shares    = mulDiv(okuMAmount, okuMMultiplier, usdMultiplier, Floor)
     *        usdMinted = mulDiv(shares,     usdMultiplier,  PRECISION,     Floor)
     *      Used by both `OkuDollar.wrap` and `LitePSM.mintUsdOku` so the slippage
     *      floor passed to `wrap` matches what `wrap` actually produces — eliminating
     *      reverts driven solely by integer-division rounding at non-even multipliers.
     * @param okuMAmount OkuMoney token amount being wrapped
     * @param okuMMult Current okuMMultiplier
     * @param usdMult Current usdMultiplier (must be non-zero)
     * @return usdMinted Dollar value (18 decimals) the wrap would credit
     */
    function okuMToWrappedUsd(
        uint256 okuMAmount,
        uint256 okuMMult,
        uint256 usdMult
    )
        internal
        pure
        returns (uint256 usdMinted)
    {
        uint256 shares = Math.mulDiv(okuMAmount, okuMMult, usdMult, Math.Rounding.Floor);
        return Math.mulDiv(shares, usdMult, Constants.PRECISION, Math.Rounding.Floor);
    }
}
