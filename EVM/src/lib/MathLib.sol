// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math for the OkuDollar contracts. See Constants.sol for the
 *         terminology legend.
 *
 * @dev ROUNDING POLICY — stated once, here, and nowhere contradicted:
 *      **every conversion rounds against the caller and in favour of the
 *      protocol.** All four conversion helpers below floor. The caller absorbs
 *      the truncation.
 *
 *      Consequence: `toUiAmount` and `fromUiAmount` are NOT inverses.
 *      `fromUiAmount(toUiAmount(x))` lies in `[x - 1, x]`. Integrators computing
 *      a max-send MUST derive from raw `balanceOf`; see README "max-send rule".
 *
 *      WHY `Math.mulDiv` RATHER THAN `a * b / c`:
 *        1. Explicit rounding control. The policy above cannot be expressed as
 *           `*` and `/` in one reviewable place; `Math.Rounding.Floor` can.
 *        2. `toUiAmount`/`fromUiAmount` are reachable from public views that
 *           accept an arbitrary `uint256`, which no supply bound constrains.
 *        3. This library is shared with `OkuMultiplierAdapter`, which may read a
 *           third-party ERC-8056 token whose multiplier is unbounded.
 *
 *      NOT because this token's own balances could overflow: `MAX_TOTAL_SUPPLY *
 *      MAX_MULTIPLIER = 1e57` sits ~1e20x below `type(uint256).max`. `mulDiv`
 *      extends the safe input domain by exactly `PRECISION` (1e18x) relative to
 *      a naive multiply — it does not make the domain unbounded. See
 *      `MulDivBoundsTest`.
 */
library MathLib {
    /**
     * @notice Raise `x` to the power `n`, in fixed point base `b`.
     * @dev Adapted verbatim from MakerDAO's `rpow` — battle-tested since 2017.
     *      Taken from https://github.com/makerdao/dss/blob/master/src/pot.sol
     *      Retains MakerDAO's half-up assembly rounding (it has no direct
     *      `mulDiv` equivalent) and its own overflow checks on the squaring path.
     *
     *      Used by `OkuDollar.uiMultiplier()` for continuous accrual.
     * @param x Base — `ratePerSecond`, scaled by `b`.
     * @param n Exponent — elapsed seconds.
     * @param b Fixed-point base, always `Constants.PRECISION` here.
     * @return z `x^n / b^(n-1)`.
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
     * @notice Convert a raw token amount to its UI (dollar) amount. ERC-8056 `toUIAmount`.
     * @param rawAmount Raw token count (18 dp).
     * @param uiMultiplier Current UI multiplier (18 dp).
     * @return UI amount (18 dp), floored.
     */
    function toUiAmount(uint256 rawAmount, uint256 uiMultiplier) internal pure returns (uint256) {
        return Math.mulDiv(rawAmount, uiMultiplier, Constants.PRECISION, Math.Rounding.Floor);
    }

    /**
     * @notice Convert a UI (dollar) amount to a raw token amount. ERC-8056 `fromUIAmount`.
     * @dev Floors. This is the direction that makes a naive max-send leave dust
     *      rather than revert; flipping it to Ceil reintroduces the failure the
     *      max-send rule exists to prevent. Pinned by `MaxSendTest`.
     * @param uiAmount UI amount (18 dp).
     * @param uiMultiplier Current UI multiplier (18 dp, must be non-zero).
     * @return Raw token count (18 dp), floored.
     */
    function fromUiAmount(uint256 uiAmount, uint256 uiMultiplier) internal pure returns (uint256) {
        return Math.mulDiv(uiAmount, Constants.PRECISION, uiMultiplier, Math.Rounding.Floor);
    }

    /**
     * @notice Convert an 18-decimal dollar value to USDC's native decimals.
     * @param dollarValue18 Dollar value (18 dp).
     * @param decimalMultiplier `10 ** (18 - usdcDecimals)`; `1e12` for Circle USDC.
     * @return USDC amount in native decimals, floored.
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
     * @notice Convert a USDC amount (native decimals) to an 18-decimal dollar value.
     * @param usdcAmount USDC amount in native decimals.
     * @param decimalMultiplier `10 ** (18 - usdcDecimals)`; `1e12` for Circle USDC.
     * @return Dollar value (18 dp).
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
