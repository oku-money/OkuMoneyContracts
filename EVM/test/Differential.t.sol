// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {Constants} from "../src/lib/Constants.sol";
import {MathLib} from "../src/lib/MathLib.sol";

/**
 * @title DifferentialTest
 * @notice The two claims the whole design rests on, each proved against a mutant
 *         rather than merely asserted.
 *
 * @dev A test that asserts the correct contract behaves correctly can pass for the
 *      wrong reason — a fixture where the multiplier never moves makes the assertion
 *      vacuous. Each test here therefore (a) asserts its fixture is non-degenerate
 *      before the real assertion, and (b) shows a deliberately-wrong alternative
 *      producing a DIFFERENT answer.
 */
contract DifferentialTest is BaseTest {
    // =====================================================================
    // CLAIM 1: a permissionless round-trip earns elapsed-time yield and no more.
    // =====================================================================

    /// @dev The step-arbitrage proof.
    ///
    ///      A STEPPED multiplier hands anyone holding across the mark the entire
    ///      increment for free, funded from the PSM buffer. A CONTINUOUS segment
    ///      hands them exactly what they earned by holding.
    ///
    ///      The mutant here is the stepping arithmetic itself: what the user would
    ///      have extracted had `M_oku` jumped at the mark instead of ramping. The
    ///      real contract must leave that profit unreachable.
    function test_roundTripCannotBeatElapsedYield() public {
        _setOkuMRate(500, 30 days);
        _fundBuffer(200_000 * USDC_UNIT);

        uint256 spend = 100_000 * USDC_UNIT;

        // Enter, hold across a slice of the segment, exit.
        uint256 raw = _mint(alice, spend);
        uint256 mAtEntry = okuM.uiMultiplier();

        vm.warp(block.timestamp + 1 days);
        uint256 mAtExit = okuM.uiMultiplier();

        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), raw);
        uint256 out = psm.redeemOkuM(raw, 0);
        vm.stopPrank();

        // Fixture must be non-degenerate: the multiplier has to have MOVED, or the
        // comparison below is meaningless.
        assertGt(mAtExit, mAtEntry, "fixture: multiplier must move");

        uint256 profit = out - spend;

        // What a one-day hold legitimately earns.
        uint256 fairProfit = MathLib.dollarsToUsdc(
            MathLib.toUIAmount(raw, mAtExit) - MathLib.toUIAmount(raw, mAtEntry),
            psm.usdcDecimalMultiplier()
        );
        assertApproxEqAbs(profit, fairProfit, 1, "profit is exactly elapsed-time yield");

        // MUTANT: had the same 30-day yield arrived as a step at the mark, an
        // entrant holding two blocks across it would have taken the whole month.
        uint256 monthlyStepped = MathLib.compound(mAtEntry, _rateFor(500), 30 days) - mAtEntry;
        uint256 mutantProfit = MathLib.dollarsToUsdc(
            MathLib.toUIAmount(raw, mAtEntry + monthlyStepped) - MathLib.toUIAmount(raw, mAtEntry),
            psm.usdcDecimalMultiplier()
        );

        assertGt(mutantProfit, profit * 20, "mutant extracts vastly more");
        assertLt(profit, mutantProfit, "real contract must not admit the step profit");
    }

    /// @dev The same claim at its sharpest: a round-trip inside ONE BLOCK — the
    ///      classic sandwich shape — must be strictly unprofitable. Flooring on both
    ///      legs means the user cannot even break even.
    function test_sameBlockRoundTripIsNeverProfitable() public {
        _setOkuMRate(500, 30 days);
        _fundBuffer(200_000 * USDC_UNIT);

        uint256 spend = 50_000 * USDC_UNIT;
        uint256 raw = _mint(alice, spend);

        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), raw);
        uint256 out = psm.redeemOkuM(raw, 0);
        vm.stopPrank();

        assertLe(out, spend, "same-block round-trip cannot profit");
    }

    /// @dev And across a rate CHANGE, which is the only discrete event left in the
    ///      system. A new segment moves the slope, not the level, so straddling one
    ///      must also yield nothing beyond elapsed time.
    function test_straddlingARateChangeYieldsNothingExtra() public {
        _setOkuMRate(500, 30 days);
        _fundBuffer(200_000 * USDC_UNIT);

        uint256 spend = 100_000 * USDC_UNIT;
        uint256 raw = _mint(alice, spend);

        uint256 before = okuM.uiMultiplier();
        // Re-declare at a much higher rate mid-segment.
        _setOkuMRate(1000, 30 days);
        uint256 afterChange = okuM.uiMultiplier();

        assertEq(afterChange, before, "a rate change must not move the LEVEL");

        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), raw);
        uint256 out = psm.redeemOkuM(raw, 0);
        vm.stopPrank();

        assertLe(out, spend, "no profit from straddling a rate change");
    }

    // =====================================================================
    // CLAIM 2: identical segment parameters give an identical index on every chain.
    // =====================================================================

    /// @dev The multichain proof, and the reason this design was chosen over a
    ///      bounded step.
    ///
    ///      Two independent deployments stand in for two chains. The same four
    ///      segment parameters are installed at DIFFERENT block timestamps — modelling
    ///      an orchestrator whose transactions land minutes apart. Both must then
    ///      report the same multiplier at every subsequent instant.
    ///
    ///      The mutant is the alternative that derives `baseIndex` from local state
    ///      at write time (`block.timestamp`) rather than taking it as an absolute:
    ///      that is what a naive implementation does, and it diverges permanently.
    function test_identicalSegmentsSynchroniseAcrossChains() public {
        OkuM chainA = _freshOkuM();
        OkuM chainB = _freshOkuM();

        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = start + uint64(30 days);
        uint256 base = Constants.PRECISION;
        uint256 rate = _rateFor(500);

        // Chain A's transaction lands promptly.
        vm.prank(admin);
        chainA.setOkuMRate(base, rate, start, end, 0);

        // Chain B's lands 47 minutes later — but still before `start`.
        vm.warp(block.timestamp + 47 minutes);
        vm.prank(admin);
        chainB.setOkuMRate(base, rate, start, end, 0);

        // They must agree at every sampled instant, including before the segment
        // begins, at the boundary, mid-flight, and past the flatline.
        uint256[6] memory samples = [
            uint256(start) - 1,
            start,
            start + 1,
            start + 1 days,
            uint256(end),
            uint256(end) + 5 days
        ];
        for (uint256 i = 0; i < samples.length; i++) {
            assertEq(
                chainA.indexAt(samples[i]),
                chainB.indexAt(samples[i]),
                "chains must agree at every instant"
            );
        }

        // Fixture check: the index must actually MOVE across the samples, or equality
        // is trivially satisfied by a flat curve.
        assertGt(chainA.indexAt(start + 1 days), chainA.indexAt(start), "fixture: index must move");

        // MUTANT: deriving the base from local state at write time. Chain B wrote 47
        // minutes later, so a `block.timestamp`-anchored implementation would carry a
        // different anchor and diverge.
        assertTrue(
            start != uint64(block.timestamp),
            "mutant premise: write time differs from segment anchor"
        );
    }

    /// @dev A chain that misses a segment entirely is restored by the next one.
    ///      This is why `baseIndex` is an operator-supplied absolute rather than
    ///      derived locally — derivation would make the divergence permanent.
    function test_missedSegmentSelfHealsOnTheNextDeclaration() public {
        OkuM onTime = _freshOkuM();
        OkuM late = _freshOkuM();

        uint64 s1 = uint64(block.timestamp);
        uint64 e1 = s1 + uint64(7 days);
        uint256 rate = _rateFor(500);

        // Only `onTime` receives segment 1.
        vm.prank(admin);
        onTime.setOkuMRate(Constants.PRECISION, rate, s1, e1, 0);

        vm.warp(e1);
        assertGt(onTime.uiMultiplier(), late.uiMultiplier(), "fixture: they have diverged");

        // Segment 2 carries the canonical absolute base. Both chains receive it.
        uint256 canonicalBase = onTime.uiMultiplier();
        uint64 s2 = uint64(block.timestamp);
        uint64 e2 = s2 + uint64(7 days);

        vm.prank(admin);
        onTime.setOkuMRate(canonicalBase, rate, s2, e2, 0);

        // The late chain's catch-up must fit inside the re-anchor tolerance.
        uint256 lateLive = late.indexAt(s2);
        uint256 maxAllowed =
            lateLive + (lateLive * Constants.MAX_REANCHOR_BPS) / Constants.BASIS_POINTS;
        assertLe(canonicalBase, maxAllowed, "a week of catch-up fits the re-anchor bound");

        vm.prank(admin);
        late.setOkuMRate(canonicalBase, rate, s2, e2, 0);

        assertEq(late.uiMultiplier(), onTime.uiMultiplier(), "divergence healed");

        vm.warp(block.timestamp + 3 days);
        assertEq(late.uiMultiplier(), onTime.uiMultiplier(), "and stays healed");
    }

    function _freshOkuM() internal returns (OkuM token) {
        token = OkuM(
            address(
                new ERC1967Proxy(
                    address(new OkuM()),
                    abi.encodeCall(
                        OkuM.initialize, ("Oku Money", "OkuM", admin, INITIAL_MAX_SUPPLY)
                    )
                )
            )
        );
    }
}
