// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MathLib} from "../../src/lib/MathLib.sol";

/// @title MathLibHarness
/// @notice Test-only harness that exposes MathLib's `internal` functions as
///         external callable surface. Used by `test/lib/MathLib.t.sol` to drive
///         every branch of `rpow` (zero-base, overflow) which is otherwise
///         unreachable from production callers operating in safe input ranges.
/// @dev NOT FOR PRODUCTION DEPLOYMENT.
contract MathLibHarness {
    function rpow(uint256 x, uint256 n, uint256 b) external pure returns (uint256) {
        return MathLib.rpow(x, n, b);
    }

    function okuMToDollars(
        uint256 okuMAmount,
        uint256 okuMMultiplier
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.okuMToDollars(okuMAmount, okuMMultiplier);
    }

    function dollarsToOkuM(
        uint256 dollarValue,
        uint256 okuMMultiplier
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.dollarsToOkuM(dollarValue, okuMMultiplier);
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

    function wrappedSharesFromOkuM(
        uint256 okuMAmount,
        uint256 okuMMult,
        uint256 usdMult
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.wrappedSharesFromOkuM(okuMAmount, okuMMult, usdMult);
    }

    function okuMToWrappedUsd(
        uint256 okuMAmount,
        uint256 okuMMult,
        uint256 usdMult
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.okuMToWrappedUsd(okuMAmount, okuMMult, usdMult);
    }
}
