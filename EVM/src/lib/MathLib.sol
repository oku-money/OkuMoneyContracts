// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math utilities for the Oku Money suite.
 * @dev See Constants.sol for the terminology legend.
 *
 *      ROUNDING POLICY: every conversion uses OpenZeppelin `Math.mulDiv` for
 *      full-precision 512-bit intermediates with explicit `Math.Rounding`. Floor is
 *      the default direction, so truncation always favours the protocol. The only
 *      Ceil site is `USDOku.unwrap`'s `sharesToBurn`, which favours the vault on
 *      withdrawal (ERC-4626 convention) and is what makes liability fall at least as
 *      fast as backing. `rpow` retains MakerDAO's half-up assembly rounding — it has
 *      no direct `mulDiv` equivalent.
 *
 *      NOTE ON NAMING: `toUIAmount`/`fromUIAmount` are the canonical names for the
 *      OkuM <-> dollar conversion. They were previously `okuMToDollars` /
 *      `dollarsToOkuM`. These are the SAME operation: an OkuM amount's dollar value
 *      IS its ERC-8056 UI amount, because `uiMultiplier()` is the redemption price.
 *      Keeping one name for one operation is what stops a display price and a
 *      settlement price drifting apart.
 */
library MathLib {
    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring)
     * @dev Adapted verbatim from MakerDAO's `rpow` — battle-tested since 2017.
     *      Taken from https://github.com/makerdao/dss/blob/master/src/pot.sol
     *      Used by BOTH tokens for continuous accrual: OkuM's `uiMultiplier()`
     *      (rear-facing) and USDOku's `usdOkuIndex()` (forward-looking) are each
     *      `base * rpow(rate, elapsed) / PRECISION`. Determinism matters here beyond
     *      the usual: it is what lets ten chains compute an identical multiplier from
     *      identical segment parameters.
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
     * @notice Raw OkuM -> its dollar (ERC-8056 UI) value. Floors.
     * @param rawAmount Raw OkuM token count (18dp).
     * @param multiplier `M_oku` — dollars per OkuM, PRECISION-scaled.
     * @return Dollar value, 18dp.
     */
    function toUIAmount(uint256 rawAmount, uint256 multiplier) internal pure returns (uint256) {
        return Math.mulDiv(rawAmount, multiplier, Constants.PRECISION, Math.Rounding.Floor);
    }

    /**
     * @notice Dollar (ERC-8056 UI) value -> raw OkuM. Floors.
     * @dev NOT an exact inverse of {toUIAmount}: `fromUIAmount(toUIAmount(x))` is
     *      `x - 1` for most `x`. Never round-trip a max-send through this pair —
     *      compute the transfer from the raw balance. See DISPLAY_CONVENTION.md.
     * @param uiAmount Dollar value, 18dp.
     * @param multiplier `M_oku` — dollars per OkuM, PRECISION-scaled.
     * @return Raw OkuM token count.
     */
    function fromUIAmount(uint256 uiAmount, uint256 multiplier) internal pure returns (uint256) {
        return Math.mulDiv(uiAmount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
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
     * @notice Compound `base` at `ratePerSecond` for `elapsed` seconds.
     * @dev The single accrual primitive. Both indices are defined as
     *      `compound(segment.baseIndex, segment.ratePerSecond, elapsed)`, so any
     *      change to rounding here moves both in lockstep and a display read can
     *      never disagree with a settlement read.
     *
     *      Deterministic integer math, which is what makes cross-chain
     *      synchronisation work: the same arguments produce the same result on every
     *      chain and every client.
     * @param base Index value at the segment anchor.
     * @param ratePerSecond Per-second rate, PRECISION = no accrual.
     * @param elapsed Seconds since the anchor.
     */
    function compound(
        uint256 base,
        uint256 ratePerSecond,
        uint256 elapsed
    )
        internal
        pure
        returns (uint256)
    {
        if (elapsed == 0 || ratePerSecond <= Constants.PRECISION) return base;
        return Math.mulDiv(
            base,
            rpow(ratePerSecond, elapsed, Constants.PRECISION),
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }

    /**
     * @notice Nominal (simple) annualized APR implied by a per-second rate, in bps.
     * @dev Linearized: `(rate - PRECISION) * SECONDS_PER_YEAR / PRECISION` in bps.
     *      Deliberately NOT the compounded APY — it is a bound-check helper for
     *      `MAX_IMPLIED_APR_BPS`, and linearizing keeps the check cheap and
     *      conservative (it under-reports relative to compounding, so the true
     *      delivered APY at the cap is slightly higher and documented as such).
     */
    function impliedAprBps(uint256 ratePerSecond) internal pure returns (uint256) {
        if (ratePerSecond <= Constants.PRECISION) return 0;
        return Math.mulDiv(
            ratePerSecond - Constants.PRECISION,
            Constants.SECONDS_PER_YEAR * Constants.BASIS_POINTS,
            Constants.PRECISION,
            Math.Rounding.Ceil
        );
    }
}
