// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MathLibHarness} from "../mocks/MathLibHarness.sol";
import {Constants} from "../../src/lib/Constants.sol";

/// @title GenerateVectors
/// @notice Emits the cross-language differential corpus for `computeMultiplier`.
///
/// @dev ## Why this exists
///
///      The multiplier is implemented three times:
///
///        - `src/lib/MathLib.sol`                              (Solidity, uint256)
///        - `SVM/.../crates/oku-shared/src/rate.rs`            (Rust, u128 + 256-bit mul_div)
///        - `packages/yield-tooling/src/multiplier.ts`         (TypeScript, bigint)
///
///      All three must agree bit-for-bit, because cross-chain determinism rests
///      on every deployment returning the same integer at the same wall-clock
///      second — and NOTHING on-chain, on either stack, can detect a divergence.
///      Before this harness existed the three were kept in lockstep by hand and
///      by code review, which is not a control.
///
///      Solidity is the reference implementation: it shipped first and it is
///      what the six live EVM deployments run. So vectors are generated FROM it
///      and replayed against the other two.
///
///      ## Reverts are vectors too
///
///      Each case records whether the reference REVERTED. That matters as much
///      as the values: Rust returns `None` and TypeScript throws where Solidity
///      reverts, and a divergence in the revert surface is still a divergence
///      (it was exactly such a case — `withSuccessor` accepting a halt plus a
///      successor — that this work found by hand in the instruction layer).
///
///      ## Domain
///
///      Inputs are confined to what a compliant writer can actually produce:
///      `base <= MAX_MULTIPLIER`, `PRECISION <= rate <= MAX_RATE`, non-negative
///      timestamps, and windows bounded by `MAX_WINDOW`. This is deliberate.
///      Outside it there is a documented, accepted divergence in the far tail
///      (see `oku-shared/src/rate.rs` § reachability): Solidity reverts when an intermediate
///      *product* exceeds `uint256`, whereas the Rust port returns `None` when a
///      *quotient* exceeds `u128`, and the Rust bound binds first. Both sit far
///      beyond any reachable schedule, but generating vectors out there would
///      produce known-failing cases and devalue the whole corpus.
///
///      ## Usage
///
///          forge test --match-contract GenerateVectors -vv
///
///      Writes `test/differential/vectors.json`, which is COMMITTED. Regenerate
///      and re-run the Rust and TypeScript replays whenever any of the three
///      implementations changes.
contract GenerateVectorsTest is Test {
    MathLibHarness internal harness;

    /// Longest window any vector uses (~90 days). See the domain note above.
    uint256 internal constant MAX_WINDOW = 90 days;

    /// JSON Lines, not a JSON array: the corpus is written incrementally with
    /// `vm.writeLine`, because accumulating it into one string is quadratic in
    /// memory and blows the EVM's memory limit at this case count. It is also
    /// the better format for a committed corpus — streamable, and a regenerated
    /// vector shows up as a one-line diff instead of reflowing the file.
    string internal constant OUT_PATH = "test/differential/vectors.jsonl";

    struct Case {
        uint256 base;
        uint256 rate;
        uint256 anchor;
        uint256 rateEnd;
        uint256 pendingRate;
        uint256 pendingRateEnd;
        uint256 nowTs;
    }

    Case[] internal cases;

    function setUp() public {
        harness = new MathLibHarness();
    }

    function _push(
        uint256 base,
        uint256 rate,
        uint256 anchor,
        uint256 rateEnd,
        uint256 pendingRate,
        uint256 pendingRateEnd,
        uint256 nowTs
    )
        internal
    {
        cases.push(Case(base, rate, anchor, rateEnd, pendingRate, pendingRateEnd, nowTs));
    }

    /// A per-second rate that compounds to roughly `apyBps` over 365 days.
    /// Chosen by bisection so the corpus does not depend on a float helper.
    function _rateForApyBps(uint256 apyBps) internal view returns (uint256) {
        uint256 lo = Constants.PRECISION;
        uint256 hi = Constants.MAX_RATE;
        uint256 target = Constants.PRECISION + (Constants.PRECISION * apyBps) / 10_000;
        for (uint256 i = 0; i < 128; i++) {
            uint256 mid = lo + (hi - lo) / 2;
            if (mid == lo) break;
            uint256 grown = harness.rpow(mid, 365 days, Constants.PRECISION);
            if (grown < target) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    /// Emit one schedule sampled at every interesting instant.
    ///
    /// Split out of `_buildStructuredCases` because inlining it blew Solidity's
    /// stack — but it earns its place regardless: the boundary instants are
    /// where a branch-selection off-by-one between the three implementations
    /// would hide, and keeping them in one list makes that explicit.
    function _pushBoundarySamples(
        uint256 base,
        uint256 rate,
        uint256 anchor,
        uint256 rateEnd,
        uint256 pendingRate,
        uint256 pendingEnd,
        uint256 window
    )
        internal
    {
        uint256 pEnd = pendingRate == Constants.PRECISION ? 0 : pendingEnd;
        uint256 far = anchor + window;

        uint256[9] memory times;
        times[0] = anchor;
        times[1] = anchor + 1;
        times[2] = rateEnd == 0 ? far : rateEnd - 1;
        times[3] = rateEnd == 0 ? far : rateEnd;
        times[4] = rateEnd == 0 ? far + 1 : rateEnd + 1;
        times[5] = pEnd == 0 ? far : pEnd - 1;
        times[6] = pEnd == 0 ? far : pEnd;
        times[7] = pEnd == 0 ? far : pEnd + 1;
        times[8] = anchor + MAX_WINDOW * 4;

        for (uint256 t = 0; t < times.length; t++) {
            // `nowTs < anchor` underflows branch 3 in Solidity; no writer can
            // produce it, so it is out of the agreed domain.
            if (times[t] < anchor) continue;
            _push(base, rate, anchor, rateEnd, pendingRate, pEnd, times[t]);
        }
    }

    /// One (base, rate, window) cell of the grid, crossed with every pending rate.
    ///
    /// Extracted purely to stay under Solidity's stack limit; the nesting is
    /// four deep and `viaIR` is not enabled for this repo's test profile.
    function _pushRateGrid(
        uint256 base,
        uint256 rate,
        uint256 anchor,
        uint256 window,
        uint256[4] memory rates
    )
        internal
    {
        bool halted = rate == Constants.PRECISION;
        // Writer invariant: a halted rate carries no window.
        uint256 rateEnd = halted ? 0 : anchor + window;
        uint256 pendingEnd = halted ? 0 : rateEnd + window;

        for (uint256 pr = 0; pr < rates.length; pr++) {
            _pushBoundarySamples(base, rate, anchor, rateEnd, rates[pr], pendingEnd, window);
        }
    }

    /// Build the structured grid: every branch, every boundary, plus the
    /// degenerate states a defensive guard is supposed to absorb.
    function _buildStructuredCases() internal {
        uint256 P = Constants.PRECISION;
        uint256 anchor = 1_700_000_000; // a realistic unix timestamp

        uint256[4] memory rates = [
            P, // halted
            _rateForApyBps(1), // 0.01% APY — smallest meaningful
            _rateForApyBps(500), // 5% APY — the realistic case
            Constants.MAX_RATE // the ceiling
        ];

        uint256[4] memory bases = [P, P + 1, 2 * P, Constants.MAX_MULTIPLIER];

        // `1 days` is the PRODUCTION epoch length (see scripts/config/epoch.ts).
        // It was previously absent — the corpus bracketed it with 1 hours and
        // 7 days but never sampled it — so the three implementations were never
        // cross-validated at the exact window the fleet actually runs on.
        uint256[6] memory windows = [
            uint256(1),
            uint256(1 hours),
            uint256(1 days),
            uint256(7 days),
            uint256(30 days),
            MAX_WINDOW
        ];

        for (uint256 b = 0; b < bases.length; b++) {
            for (uint256 r = 0; r < rates.length; r++) {
                for (uint256 w = 0; w < windows.length; w++) {
                    _pushRateGrid(bases[b], rates[r], anchor, windows[w], rates);
                }
            }
        }

        // Degenerate / defensive states that the writers never produce but the
        // implementations must still agree on.
        // Halted active rate with a window and an armed successor. The writers
        // cannot produce this; branch 1 has no overhang leg, so all three stacks
        // must return the flat base. Kept as a pin on that agreement.
        _push(P, P, anchor, anchor + 7 days, _rateForApyBps(500), 0, anchor + 30 days);
        _push(
            P, P, anchor, anchor + 7 days, _rateForApyBps(500), anchor + 14 days, anchor + 30 days
        );
        // Same, but with `anchor` past `rateEnd` — the input the deleted branch-1
        // fallback double-counted by compounding from `rateEnd`, not `max(anchor, rateEnd)`.
        _push(P, P, anchor + 50 days, anchor + 30 days, _rateForApyBps(500), 0, anchor + 90 days);
        _push(P, _rateForApyBps(500), anchor + 50 days, anchor + 30 days, P, 0, anchor + 90 days); // anchor > rateEnd
        _push(P, _rateForApyBps(500), anchor, anchor + 7 days, P, 0, anchor); // elapsed == 0
        _push(0, _rateForApyBps(500), anchor, anchor + 7 days, P, 0, anchor + 1 days); // zero base
        _push(
            Constants.MAX_MULTIPLIER,
            Constants.MAX_RATE,
            anchor,
            anchor + MAX_WINDOW,
            P,
            0,
            anchor + MAX_WINDOW
        ); // clamp

        // Cases the reference is expected to REVERT on.
        //
        // Without these the corpus would exercise only the value half of the
        // comparison and the revert-parity machinery would be dead code. The
        // divergence this whole harness exists to catch can just as easily be
        // "one implementation accepts what another rejects" as "they return
        // different numbers".
        //
        // `nowTs < anchor` underflows Solidity's checked subtraction in branch 3.
        // The Rust port returns `None` (it rejects negative/backwards timestamps
        // explicitly) and TypeScript throws.
        _push(P, _rateForApyBps(500), anchor, anchor + 7 days, P, 0, anchor - 1);
        _push(P, _rateForApyBps(500), anchor, anchor + 7 days, P, 0, anchor - 1 days);
        _push(2 * P, Constants.MAX_RATE, anchor, anchor + 30 days, P, 0, anchor - 100);
        // Same underflow, reached with a successor armed.
        _push(
            P,
            _rateForApyBps(500),
            anchor,
            anchor + 7 days,
            _rateForApyBps(100),
            anchor + 14 days,
            anchor - 5
        );
    }

    /// Seeded pseudo-random cases inside the same domain, to reach shapes the
    /// structured grid does not enumerate.
    function _buildFuzzCases(uint256 count) internal {
        uint256 seed = uint256(keccak256("okumoney-differential-v1"));
        for (uint256 i = 0; i < count; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));

            uint256 base =
                Constants.PRECISION + (seed % (Constants.MAX_MULTIPLIER - Constants.PRECISION));
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 rate =
                Constants.PRECISION + (seed % (Constants.MAX_RATE - Constants.PRECISION + 1));
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 anchor = 1_600_000_000 + (seed % 200_000_000);
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 window = 1 + (seed % MAX_WINDOW);
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 pWindow = 1 + (seed % MAX_WINDOW);
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 offset = seed % (MAX_WINDOW * 3);

            uint256 rateEnd = anchor + window;
            _push(base, rate, anchor, rateEnd, rate, rateEnd + pWindow, anchor + offset);
        }
    }

    function test_GenerateVectors() public {
        _buildStructuredCases();
        _buildFuzzCases(400);

        // Truncate any previous corpus, then append one object per line.
        vm.writeFile(OUT_PATH, "");

        for (uint256 i = 0; i < cases.length; i++) {
            Case memory c = cases[i];

            bool reverted;
            uint256 value;
            try harness.computeMultiplier(
                c.base, c.rate, c.anchor, c.rateEnd, c.pendingRate, c.pendingRateEnd, c.nowTs
            ) returns (
                uint256 v
            ) {
                value = v;
            } catch {
                reverted = true;
            }

            vm.writeLine(
                OUT_PATH,
                string.concat(
                    '{"base":"',
                    vm.toString(c.base),
                    '","rate":"',
                    vm.toString(c.rate),
                    '","anchor":"',
                    vm.toString(c.anchor),
                    '","rateEnd":"',
                    vm.toString(c.rateEnd),
                    '","pendingRate":"',
                    vm.toString(c.pendingRate),
                    '","pendingRateEnd":"',
                    vm.toString(c.pendingRateEnd),
                    '","nowTs":"',
                    vm.toString(c.nowTs),
                    '","reverted":',
                    reverted ? "true" : "false",
                    ',"expected":"',
                    vm.toString(value),
                    '"}'
                )
            );
        }

        // Surfaced so a regeneration that silently produced nothing is obvious.
        emit log_named_uint("vectors generated", cases.length);
    }
}
