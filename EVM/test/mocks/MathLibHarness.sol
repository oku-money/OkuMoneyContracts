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

    function compoundFor(
        uint256 base,
        uint256 rate,
        uint256 elapsed
    )
        external
        pure
        returns (uint256)
    {
        return MathLib.compoundFor(base, rate, elapsed);
    }

    function computeMultiplier(
        uint256 base,
        uint256 rate,
        uint256 anchor,
        uint256 rateEnd,
        uint256 pendingRate,
        uint256 pendingRateEnd,
        uint256 nowTs
    )
        external
        pure
        returns (uint256)
    {
        return
            MathLib.computeMultiplier(
                base, rate, anchor, rateEnd, pendingRate, pendingRateEnd, nowTs
            );
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
    // REMOVED (single-multiplier collapse): wrappedSharesFromOkuM / okuMToWrappedUsd
    // harness entries — MathLib no longer carries these two-multiplier helpers.
    // `okuMToDollars` above covers the single-multiplier equivalent.
}
