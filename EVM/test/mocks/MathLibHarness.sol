// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MathLib} from "../../src/lib/MathLib.sol";

/**
 * @title MathLibHarness
 * @notice Exposes MathLib's internal functions so the assembly branches in
 *         `rpow` — which no production call path can reach — are testable.
 * @dev Test-only. `rpow` is MakerDAO's, retained verbatim; the `x == 0` and
 *      `n == 0` cases and the overflow reverts are unreachable from `USDOku`
 *      because the setter bounds the rate, but they still need coverage.
 */
contract MathLibHarness {
    function rpow(uint256 x, uint256 n, uint256 b) external pure returns (uint256) {
        return MathLib.rpow(x, n, b);
    }

    function toUIAmount(uint256 raw, uint256 m) external pure returns (uint256) {
        return MathLib.toUIAmount(raw, m);
    }

    function fromUIAmount(uint256 ui, uint256 m) external pure returns (uint256) {
        return MathLib.fromUIAmount(ui, m);
    }

    function usdcToDollars(uint256 a, uint256 dm) external pure returns (uint256) {
        return MathLib.usdcToDollars(a, dm);
    }

    function dollarsToUsdc(uint256 a, uint256 dm) external pure returns (uint256) {
        return MathLib.dollarsToUsdc(a, dm);
    }

    function applyFeeCeil(
        uint256 amount,
        uint256 bps
    )
        external
        pure
        returns (uint256 net, uint256 fee)
    {
        return MathLib.applyFeeCeil(amount, bps);
    }

    function impliedAprBps(uint256 ratePerSecond) external pure returns (uint256) {
        return MathLib.impliedAprBps(ratePerSecond);
    }
}
