// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Constants} from "./Constants.sol";

/**
 * @title MathLib
 * @notice Shared math utilities for OkuMoney contracts
 */
library MathLib {
    /**
     * @notice Raise x to the power of n, modulo base b (exponentiation by squaring)
     * @dev Copied from MakerDAO's jug.sol / pot.sol — battle-tested since 2017
     *      Used for continuous yield accrual in OkuMoney and OkuDollar.
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
     * @notice Convert OkuMoney token amount to dollar value
     * @param okuMAmount Amount of OkuMoney tokens
     * @param okuMPrice Current OkuMoney price (scaled by PRECISION)
     * @return Dollar value in 18 decimals
     */
    function okuMToDollars(uint256 okuMAmount, uint256 okuMPrice) internal pure returns (uint256) {
        return (okuMAmount * okuMPrice) / Constants.PRECISION;
    }

    /**
     * @notice Convert dollar value to OkuMoney token amount
     * @param dollarValue Dollar value in 18 decimals
     * @param okuMPrice Current OkuMoney price (scaled by PRECISION)
     * @return Amount of OkuMoney tokens
     */
    function dollarsToOkuM(uint256 dollarValue, uint256 okuMPrice) internal pure returns (uint256) {
        return (dollarValue * Constants.PRECISION) / okuMPrice;
    }

    /**
     * @notice Convert 18-decimal dollar value to 6-decimal USDC amount
     * @param dollarValue18 Dollar value in 18 decimals
     * @return USDC amount in 6 decimals
     */
    function dollarsToUsdc(uint256 dollarValue18) internal pure returns (uint256) {
        return dollarValue18 / Constants.DECIMAL_MULTIPLIER;
    }

    /**
     * @notice Convert 6-decimal USDC amount to 18-decimal dollar value
     * @param usdcAmount USDC amount in 6 decimals
     * @return Dollar value in 18 decimals
     */
    function usdcToDollars(uint256 usdcAmount) internal pure returns (uint256) {
        return usdcAmount * Constants.DECIMAL_MULTIPLIER;
    }
}
