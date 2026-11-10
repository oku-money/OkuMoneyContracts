// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLibHarness} from "../mocks/MathLibHarness.sol";
import {Deploy} from "../shared/Deploy.sol";

/// @title GenerateVectorsRearmTest
/// @notice Emits the cross-language differential corpus for the re-arm anchor rule
///         (Cyfrin audit #13): which `(base, anchor)` an active-rate write stores.
///
/// @dev The rule is implemented three times and must agree bit for bit, or two stacks
///      receiving the same broadcast store different schedules:
///
///        - `OkuMoneyRateSchedule._rearmAnchor`                (Solidity, the reference)
///        - `oku_shared::rate::Schedule::rearm_anchor`         (Rust, the SVM program)
///        - `rearmAnchor` in `packages/yield-tooling`          (TypeScript)
///
///      Unlike `GenerateVectors`, this drives the REAL contract: each case builds a
///      schedule through the public setters, warps, sends `setOkuMYieldRate(newRate,
///      newEnd)` and records the stored `okuMBaseMultiplier` / `okuMLastAccrualTime`. So
///      the corpus pins the whole write path, not a harness of the helper. Writes the
///      contract rejects (end in the past, window too long) are not emitted: the rule
///      only applies to admitted writes, and validation parity is covered elsewhere.
///
///      Every schedule is sampled at the instants where the three cases switch (inside
///      the active window, at `okuMRateEnd`, in the successor's overhang, at and past its
///      end) and written with re-arms of the active segment, of the successor, near
///      misses of both (one wei of rate or one second of end off), and a halt. Starting
///      states cover a fresh anchor and one carried over from an earlier segment (a base
///      above 1e18 and an anchor before the current window), with and without a
///      successor, and an active rate equal to its successor's.
///
///      Deterministic (fixed warps, no fuzz inputs, a keccak chain for the seeded half),
///      so CI regenerates it and fails on any byte difference, as for `vectors.jsonl`.
///
///      Usage: `forge test --match-contract GenerateVectors -vv` (both corpora), or
///      `npm run test:differential` from the repo root to regenerate and replay.
contract GenerateVectorsRearmTest is Test {
    string internal constant OUT_PATH = "test/differential/rearm-vectors.jsonl";

    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant P = Constants.PRECISION;

    MathLibHarness internal harness;
    OkuMoney internal okuM;
    address internal admin = makeAddr("rearm-admin");

    struct Start {
        bool carried; // an earlier segment ran first: base > 1e18, anchor before this window
        bool armed; // a successor is armed
        uint256 r1;
        uint256 window1;
        uint256 r2;
        uint256 window2;
    }

    struct Pre {
        uint256 base;
        uint256 rate;
        uint256 anchor;
        uint256 rateEnd;
        uint256 pendingRate;
        uint256 pendingRateEnd;
    }

    uint256 internal carriedRate;

    function setUp() public {
        harness = new MathLibHarness();
        (okuM,) = Deploy.deployOkuMoney(admin);
        carriedRate = _rateForApyBps(800);
    }

    function _rateForApyBps(uint256 apyBps) internal view returns (uint256) {
        uint256 lo = P;
        uint256 hi = Constants.MAX_RATE;
        uint256 target = P + (P * apyBps) / 10_000;
        for (uint256 i = 0; i < 128; i++) {
            uint256 mid = lo + (hi - lo) / 2;
            if (mid == lo) break;
            if (harness.rpow(mid, 365 days, P) < target) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function _pre() internal view returns (Pre memory p) {
        p.base = okuM.okuMBaseMultiplier();
        p.rate = okuM.okuMRatePerSecond();
        p.anchor = okuM.okuMLastAccrualTime();
        p.rateEnd = okuM.okuMRateEnd();
        p.pendingRate = okuM.okuMPendingRatePerSecond();
        p.pendingRateEnd = okuM.okuMPendingRateEnd();
    }

    /// Build the starting schedule through the public setters; returns its anchor.
    function _build(Start memory s) internal returns (uint256 e1, uint256 e2) {
        uint256 start = T0;
        vm.warp(T0);
        if (s.carried) {
            // An earlier segment accrues for 5 days, then the window under test is set.
            // (Rate computed before the prank: the prank applies to the next call.)
            uint256 earlier = carriedRate;
            vm.prank(admin);
            okuM.setOkuMYieldRate(earlier, T0 + 10 days);
            start = T0 + 5 days + 17;
            vm.warp(start);
        }
        e1 = start + s.window1;
        if (s.armed) {
            e2 = e1 + s.window2;
            vm.prank(admin);
            okuM.setOkuMYieldRateWithSuccessor(s.r1, e1, s.r2, e2);
        } else {
            vm.prank(admin);
            okuM.setOkuMYieldRate(s.r1, e1);
        }
    }

    function _emit(Pre memory p, uint256 nowTs, uint256 newRate, uint256 newEnd) internal {
        vm.writeLine(
            OUT_PATH,
            string.concat(
                string.concat(
                    '{"base":"',
                    vm.toString(p.base),
                    '","rate":"',
                    vm.toString(p.rate),
                    '","anchor":"',
                    vm.toString(p.anchor),
                    '","rateEnd":"',
                    vm.toString(p.rateEnd),
                    '","pendingRate":"',
                    vm.toString(p.pendingRate),
                    '","pendingRateEnd":"',
                    vm.toString(p.pendingRateEnd)
                ),
                string.concat(
                    '","nowTs":"',
                    vm.toString(nowTs),
                    '","newRate":"',
                    vm.toString(newRate),
                    '","newEnd":"',
                    vm.toString(newEnd),
                    '","expectedBase":"',
                    vm.toString(okuM.okuMBaseMultiplier()),
                    '","expectedAnchor":"',
                    vm.toString(okuM.okuMLastAccrualTime()),
                    '"}'
                )
            )
        );
    }

    /// Send one write from the current state and, if admitted, record it.
    function _try(uint256 nowTs, uint256 newRate, uint256 newEnd) internal {
        uint256 snap = vm.snapshotState();
        vm.warp(nowTs);
        Pre memory p = _pre();
        vm.prank(admin);
        try okuM.setOkuMYieldRate(newRate, newEnd) {
            _emit(p, nowTs, newRate, newEnd);
        } catch {}
        vm.revertToState(snap);
    }

    function _writesAt(uint256 nowTs, Start memory s, uint256 e1, uint256 e2) internal {
        _try(nowTs, s.r1, e1); // re-arm the active segment
        _try(nowTs, s.r1, e1 + 1);
        if (e1 > nowTs + 1) _try(nowTs, s.r1, e1 - 1);
        _try(nowTs, s.r1 + 1, e1);
        _try(nowTs, s.r1 - 1, e1);
        _try(nowTs, P, 0); // halt
        if (s.armed) {
            _try(nowTs, s.r2, e2); // re-arm the successor
            _try(nowTs, s.r2, e2 + 1);
            if (e2 > nowTs + 1) _try(nowTs, s.r2, e2 - 1);
            _try(nowTs, s.r2 + 1, e2);
            _try(nowTs, s.r2 - 1, e2);
            _try(nowTs, s.r1, e2);
            _try(nowTs, s.r2, e1);
        }
    }

    function _scenario(Start memory s) internal {
        uint256 snap = vm.snapshotState();
        (uint256 e1, uint256 e2) = _build(s);
        uint256 a = okuM.okuMLastAccrualTime();

        uint256[10] memory times;
        times[0] = a;
        times[1] = a + 1;
        times[2] = e1 - 1;
        times[3] = e1;
        times[4] = e1 + 1;
        times[5] = s.armed ? e1 + s.window2 / 2 : e1 + 2;
        times[6] = s.armed ? e2 - 1 : e1 + 3;
        times[7] = s.armed ? e2 : e1 + 4;
        times[8] = s.armed ? e2 + 1 : e1 + 5;
        times[9] = a + (e1 - a) / 3;

        for (uint256 i = 0; i < times.length; i++) {
            if (times[i] < a) continue;
            _writesAt(times[i], s, e1, e2);
        }
        vm.revertToState(snap);
    }

    function _buildStructured() internal {
        uint256[4] memory rates =
            [_rateForApyBps(1), _rateForApyBps(500), _rateForApyBps(800), Constants.MAX_RATE];
        uint256[3] memory windows = [uint256(1 hours), uint256(80_640), uint256(30 days)];

        for (uint256 c = 0; c < 2; c++) {
            for (uint256 arm = 0; arm < 2; arm++) {
                for (uint256 i = 0; i < rates.length; i++) {
                    // successor: a different rate, and the same rate as the active one
                    uint256[2] memory succ = [rates[(i + 1) % rates.length], rates[i]];
                    for (uint256 j = 0; j < (arm == 1 ? 2 : 1); j++) {
                        for (uint256 w = 0; w < windows.length; w++) {
                            _scenario(
                                Start({
                                    carried: c == 1,
                                    armed: arm == 1,
                                    r1: rates[i],
                                    window1: windows[w],
                                    r2: succ[j],
                                    window2: 5760
                                })
                            );
                        }
                    }
                }
            }
        }
    }

    function _buildSeeded(uint256 count) internal {
        uint256 seed = uint256(keccak256("okumoney-rearm-differential-v1"));
        for (uint256 i = 0; i < count; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 r1 = P + 1 + (seed % (Constants.MAX_RATE - P));
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 r2 = P + 1 + (seed % (Constants.MAX_RATE - P));
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 w1 = 2 + (seed % (30 days));
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 w2 = 2 + (seed % (30 days));
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 at = seed % (w1 + w2 + 10);

            Start memory s = Start({
                carried: seed % 2 == 0, armed: true, r1: r1, window1: w1, r2: r2, window2: w2
            });
            uint256 snap = vm.snapshotState();
            (uint256 e1, uint256 e2) = _build(s);
            uint256 nowTs = okuM.okuMLastAccrualTime() + at;
            _try(nowTs, r1, e1);
            _try(nowTs, r2, e2);
            _try(nowTs, r1, e2);
            vm.revertToState(snap);
        }
    }

    function test_GenerateRearmVectors() public {
        // About 1e9 gas of schedule writes, at the edge of the default per-test gas limit
        // (and over it on some Foundry versions). Gas is irrelevant to a generator.
        vm.pauseGasMetering();
        vm.writeFile(OUT_PATH, "");
        _buildStructured();
        _buildSeeded(300);
        // No count here: every case runs inside a state snapshot that is reverted, which
        // would reset a counter too. The Rust and TypeScript replays check the size.
    }
}
