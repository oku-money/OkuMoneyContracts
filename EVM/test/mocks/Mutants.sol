// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Constants} from "../../src/lib/Constants.sol";

/**
 * @title Mutants
 * @notice Deliberately-wrong implementations used ONLY as differential targets.
 *
 * The request-block-pricing mutant is expressed inline in `Differential.t.sol`
 * (it is a pure arithmetic alternative, so a whole contract would add nothing).
 *
 * A test that merely asserts the correct contract behaves correctly can pass
 * for the wrong reason — a fixture where the multiplier never moves, or where
 * two indices happen to be equal, makes the assertion vacuous. Each mutant here
 * injects exactly one design violation, and the corresponding test asserts the
 * mutant produces a DIFFERENT answer. If the fixture were vacuous, the mutant
 * would agree and the test would fail.
 *
 * These must never be imported from a production path.
 */

/**
 * @notice Prices wrap/unwrap at `M_usd` instead of `M_oku`.
 * @dev The load-bearing rule of the wrapper. If unwrap priced at `M_usd`,
 *      USDOku holders could extract the smoothing gap directly out of the OkuM
 *      backing pool, converting a bounded accounting gap into an unbounded
 *      drain on senior OkuM holders.
 */
contract UsdIndexPricedWrapperMutant {
    /// @notice What a wrong `unwrap` would pay out: `usdOku * PRECISION / M_usd`.
    function mutantUnwrapAtUsdIndex(
        uint256 usdOkuAmount,
        uint256 usdIndex
    )
        external
        pure
        returns (uint256)
    {
        return Math.mulDiv(usdOkuAmount, Constants.PRECISION, usdIndex, Math.Rounding.Floor);
    }

    /// @notice What a wrong `wrap` would credit: `okuM * M_usd / PRECISION`.
    function mutantWrapAtUsdIndex(
        uint256 okuMAmount,
        uint256 usdIndex
    )
        external
        pure
        returns (uint256)
    {
        return Math.mulDiv(okuMAmount, usdIndex, Constants.PRECISION, Math.Rounding.Floor);
    }
}
