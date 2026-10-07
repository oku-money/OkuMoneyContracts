import { expect } from "chai";
import {
    distanceToGrid,
    isGridAligned,
    spreadBps,
    classifyAccrual,
    isExpiringSoon,
} from "../../../scripts/utils/driftChecks";
import {
    EPOCH_ANCHOR_UNIX,
    EPOCH_LENGTH_SECONDS,
    EPOCH_GRID_TOLERANCE_SECONDS,
} from "../../../scripts/config/epoch";

const PRECISION = 10n ** 18n;

/**
 * Covers the decision logic of `operator/checkMultiplierDrift.ts` — the only
 * detector of cross-chain multiplier divergence; the script itself is
 * inherently multi-chain, so its decision logic is tested here.
 */
describe("driftChecks", () => {
    describe("grid alignment", () => {
        it("accepts an exact UTC-midnight boundary", () => {
            const boundary = EPOCH_ANCHOR_UNIX + 300 * EPOCH_LENGTH_SECONDS;
            expect(distanceToGrid(boundary, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS)).to.equal(0);
            expect(
                isGridAligned(boundary, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS, EPOCH_GRID_TOLERANCE_SECONDS)
            ).to.equal(true);
        });

        it("accepts the base-window boundary (epochLength/15 before the grid line)", () => {
            // The base+settlement split legitimately ends a window short of the
            // epoch boundary; both positions must pass.
            const baseEnd =
                EPOCH_ANCHOR_UNIX + 300 * EPOCH_LENGTH_SECONDS - Math.round(EPOCH_LENGTH_SECONDS / 15);
            expect(
                isGridAligned(baseEnd, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS, EPOCH_GRID_TOLERANCE_SECONDS)
            ).to.equal(true);
        });

        it("measures to the NEAREST boundary, not the preceding one", () => {
            // One second past a grid line is 1s off-grid, not epochLength-1.
            const justAfter = EPOCH_ANCHOR_UNIX + 300 * EPOCH_LENGTH_SECONDS + 1;
            expect(distanceToGrid(justAfter, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS)).to.equal(1);
            const justBefore = EPOCH_ANCHOR_UNIX + 300 * EPOCH_LENGTH_SECONDS - 1;
            expect(distanceToGrid(justBefore, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS)).to.equal(1);
        });

        it("rejects a materially drifted boundary", () => {
            // Mid-epoch: maximally far from any grid line.
            const midEpoch = EPOCH_ANCHOR_UNIX + 300 * EPOCH_LENGTH_SECONDS + EPOCH_LENGTH_SECONDS / 2;
            expect(
                isGridAligned(midEpoch, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS, EPOCH_GRID_TOLERANCE_SECONDS)
            ).to.equal(false);
        });

        it("handles boundaries before the anchor without sign error", () => {
            const before = EPOCH_ANCHOR_UNIX - 5 * EPOCH_LENGTH_SECONDS;
            expect(distanceToGrid(before, EPOCH_ANCHOR_UNIX, EPOCH_LENGTH_SECONDS)).to.equal(0);
        });
    });

    describe("spreadBps", () => {
        it("is zero when every chain agrees", () => {
            expect(spreadBps([PRECISION, PRECISION, PRECISION])).to.equal(0n);
        });

        it("measures the min-to-max spread", () => {
            // +1% on one chain => 100 bps.
            expect(spreadBps([PRECISION, (PRECISION * 101n) / 100n])).to.equal(100n);
        });

        it("is order-independent", () => {
            const a = spreadBps([PRECISION, (PRECISION * 101n) / 100n]);
            const b = spreadBps([(PRECISION * 101n) / 100n, PRECISION]);
            expect(a).to.equal(b);
        });
    });

    describe("classifyAccrual", () => {
        const now = 1_000_000n;

        it("reports HALTED only when the effective rate is PRECISION", () => {
            const s = classifyAccrual({
                effectiveRate: PRECISION,
                rateEnd: now - 100n,
                pendingRateEnd: now - 50n,
                now,
                precision: PRECISION,
            });
            expect(s.halted).to.equal(true);
        });

        it("does NOT report halted while a staged successor is accruing", () => {
            // An elapsed active window with a live successor is the normal
            // epoch transition, not a halt.
            const s = classifyAccrual({
                effectiveRate: PRECISION + 1n,
                rateEnd: now - 100n,
                pendingRateEnd: now + 86_400n,
                now,
                precision: PRECISION,
            });
            expect(s.halted).to.equal(false);
            expect(s.handedOver).to.equal(true);
            expect(s.runsOutAt).to.equal(now + 86_400n);
        });

        it("reports the active window's end while it is still live", () => {
            const s = classifyAccrual({
                effectiveRate: PRECISION + 1n,
                rateEnd: now + 3_600n,
                pendingRateEnd: now + 90_000n,
                now,
                precision: PRECISION,
            });
            expect(s.handedOver).to.equal(false);
            expect(s.runsOutAt).to.equal(now + 3_600n);
        });

        it("treats rateEnd == 0 as not-handed-over", () => {
            const s = classifyAccrual({
                effectiveRate: PRECISION + 1n,
                rateEnd: 0n,
                pendingRateEnd: 0n,
                now,
                precision: PRECISION,
            });
            expect(s.handedOver).to.equal(false);
        });
    });

    describe("isExpiringSoon", () => {
        const now = 1_000_000n;
        const warn = 4n * 3600n;

        it("fires inside the warn window", () => {
            expect(isExpiringSoon(now + 3600n, now, warn)).to.equal(true);
        });

        it("does not fire outside it", () => {
            expect(isExpiringSoon(now + 5n * 3600n, now, warn)).to.equal(false);
        });

        it("does not fire for an unbounded window", () => {
            expect(isExpiringSoon(0n, now, warn)).to.equal(false);
        });

        it("does not fire for an already-elapsed boundary (that is a halt, not a warning)", () => {
            expect(isExpiringSoon(now - 1n, now, warn)).to.equal(false);
        });
    });
});
