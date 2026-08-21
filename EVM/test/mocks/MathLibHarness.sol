// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MathLib} from "../../src/lib/MathLib.sol";

/// @title MathLibHarness
/// @notice Test-only harness exposing MathLib's `internal` functions externally.
/// @dev NOT FOR PRODUCTION DEPLOYMENT. Exists to drive every branch of `rpow`
///      (zero base, zero exponent, the `mul` overflow reverts) which production
///      callers operating in safe input ranges cannot reach, and to compare
///      `mulDiv` against a naive multiply outside the token's supply envelope.
contract MathLibHarness {
    function rpow(uint256 x, uint256 n, uint256 b) external pure returns (uint256) {
        return MathLib.rpow(x, n, b);
    }

    function toUiAmount(uint256 rawAmount, uint256 uiMultiplier) external pure returns (uint256) {
        return MathLib.toUiAmount(rawAmount, uiMultiplier);
    }

    function fromUiAmount(uint256 uiAmount, uint256 uiMultiplier) external pure returns (uint256) {
        return MathLib.fromUiAmount(uiAmount, uiMultiplier);
    }

    function dollarsToUsdc(
        uint256 dollarValue18,
        uint256 decimalMultiplier
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.dollarsToUsdc(dollarValue18, decimalMultiplier);
    }

    function usdcToDollars(
        uint256 usdcAmount,
        uint256 decimalMultiplier
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.usdcToDollars(usdcAmount, decimalMultiplier);
    }

    /// @notice Naive `a * b / c`, for differential comparison against `mulDiv`.
    /// @dev Reverts on intermediate overflow where `mulDiv` does not. This is the
    ///      whole point of `MulDivBoundsTest`.
    function naiveToUiAmount(
        uint256 rawAmount,
        uint256 uiMultiplier
    )
        external
        pure
        returns (uint256)
    {
        return (rawAmount * uiMultiplier) / 1e18;
    }
}
