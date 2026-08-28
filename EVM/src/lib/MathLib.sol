// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math utilities for the reviewed-conversion contract suite.
 * @dev ROUNDING POLICY: every conversion here uses OpenZeppelin `Math.mulDiv` for
 *      full-precision 512-bit intermediates with explicit `Math.Rounding`. Floor
 *      is the default — every conversion rounds against the caller, in favour of
 *      the protocol. `rpow` keeps MakerDAO's half-up assembly rounding; it has no
 *      direct `mulDiv` equivalent.
 *
 *      `toUIAmount` / `fromUIAmount` are the single source of truth for the
 *      raw <-> UI conversion — `USDOkuWrapper.wrap`/`unwrap` and
 *      `ScaledUIAmountUpgradeable`'s own views both call through here, so a wrap
 *      and a display read can never disagree about rounding.
 */
library MathLib {
    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring).
     * @dev Adapted verbatim from MakerDAO's `rpow` — battle-tested since 2017.
     *      Taken from https://github.com/makerdao/dss/blob/master/src/pot.sol
     *      Used by USDOku for continuous yield accrual via usdOkuIndex(). OkuM
     *      updates `M_oku` discretely via `setOkuMultiplier` and does NOT use rpow.
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
     * @notice Convert a raw OkuM amount to its dollar (UI) value at `multiplier`.
     * @dev raw -> UI: `ui = raw * multiplier / PRECISION`, floored. Single source
     *      of truth for `toUIAmount`, `balanceOfUI`, and `USDOkuWrapper.wrap`.
     */
    function toUIAmount(uint256 rawAmount, uint256 multiplier) internal pure returns (uint256) {
        return Math.mulDiv(rawAmount, multiplier, Constants.PRECISION, Math.Rounding.Floor);
    }

    /**
     * @notice Convert a dollar (UI) value back to a raw OkuM amount at `multiplier`.
     * @dev UI -> raw: `raw = ui * PRECISION / multiplier`, floored. Single source
     *      of truth for `fromUIAmount` and `USDOkuWrapper.unwrap`.
     *      `fromUIAmount(toUIAmount(x))` is `x - 1` for most `x` — see the
     *      max-send rule in `EVM/README.md`; callers computing a max-send MUST
     *      derive from raw `balanceOf`, never round-trip through this pair.
     */
    function fromUIAmount(uint256 uiAmount, uint256 multiplier) internal pure returns (uint256) {
        return Math.mulDiv(uiAmount, Constants.PRECISION, multiplier, Math.Rounding.Floor);
    }

    /**
     * @notice Convert a USDC amount (native decimals) to an 18-decimal dollar value.
     * @param usdcAmount USDC amount in its native decimals.
     * @param decimalMultiplier `10**(18 - usdcDecimals)`, resolved once at init from
     *        `IERC20Metadata(usdc).decimals()`. For Circle USDC (6dp) this is 1e12.
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
     * @notice Convert an 18-decimal dollar value to USDC's native decimal representation.
     * @dev Floors — sub-USDC-unit dust is dropped in the protocol's favour.
     * @param dollarValue18 Dollar value in 18 decimals.
     * @param decimalMultiplier See {usdcToDollars}.
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
     * @notice Apply a basis-point fee, rounding the fee up (against the payer).
     * @dev Matches `dss-lite-psm`'s ceil-fee / floor-payout convention: fees round
     *      up, payouts round down, so the protocol never under-collects.
     * @param amount Gross amount the fee is charged against.
     * @param feeBps Fee in basis points (0-10_000).
     * @return net `amount - fee`.
     * @return fee The fee withheld (rounds up).
     */
    function applyFeeCeil(
        uint256 amount,
        uint256 feeBps
    )
        internal
        pure
        returns (uint256 net, uint256 fee)
    {
        fee = Math.mulDiv(amount, feeBps, Constants.BASIS_POINTS, Math.Rounding.Ceil);
        net = amount - fee;
    }

    /**
     * @notice Nominal (simple) annualized rate implied by a per-second compounding rate.
     * @dev `aprBps = (ratePerSecond - PRECISION) * SECONDS_PER_YEAR * BASIS_POINTS / PRECISION`.
     *      Deliberately the *nominal* rate, not compounded APY — a monotone-in-rate
     *      check against a nominal cap is cheaper to audit than an `rpow` round trip
     *      inside the setter. Reverts on underflow if `ratePerSecond < PRECISION`;
     *      callers must check `ratePerSecond >= PRECISION` first.
     */
    function impliedAprBps(uint256 ratePerSecond) internal pure returns (uint256) {
        return Math.mulDiv(
            ratePerSecond - Constants.PRECISION,
            Constants.SECONDS_PER_YEAR * Constants.BASIS_POINTS,
            Constants.PRECISION,
            Math.Rounding.Floor
        );
    }
}
