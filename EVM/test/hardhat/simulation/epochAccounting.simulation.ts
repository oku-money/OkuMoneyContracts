/**
 * Base + settlement (B3) epoch-distribution accuracy simulations, run against
 * a REAL deployed OkuMoney contract (not just pure TS math) so the actual
 * on-chain `rpow`/`computeMultiplier` behavior is exercised, not just our
 * off-chain model of it.
 *
 * See EVM/docs/epoch-accounting.md for the design this
 * validates, and `scripts/utils/{epochDistribution,epochSchedule}.ts` for the
 * math under test.
 *
 * METHODOLOGY, per scenario:
 *   1. Deploy OkuMoney, mint an initial supply (proxy for "1M global supply").
 *   2. Derive `rBase` from a target Y* and a `measuredAvgValueUsd` standing in
 *      for the PRIOR (closed) measurement epoch's time-weighted average —
 *      assumed flat/equal to the initial supply, isolating THIS epoch's
 *      volatility as the variable under test.
 *   3. Run the epoch on-chain: apply scripted mint/burn events, and take
 *      PERIODIC samples of totalSupply()*okuMMultiplier() — exactly what an
 *      operator's `sampleGlobalValueUsd` would observe. This is the
 *      REALISTIC, imperfect information available to derive `rSettle`.
 *   4. At the staging instant, derive and submit `rSettle` via
 *      `setOkuMYieldRateWithSuccessor` (one atomic on-chain call).
 *   5. At epoch end, compute the EXACT ground-truth distributed amount from
 *      the (test-scripted, therefore fully known) event history and the
 *      TRUE rate segments — independent of the periodic-sampling
 *      approximation used to derive `rSettle` in step 3. This is what
 *      "accuracy" is scored against.
 *
 * SCOPE NOTE: this is a curated matrix, not an exhaustive cross-product of
 * every parameter combination (which would be hundreds of on-chain
 * deployments and prohibitively slow). Each axis (yield level, buffer/split
 * settings, epoch length, supply scenario) is varied independently against a
 * fixed realistic baseline for the others.
 *
 * PER USER DIRECTIVE: 7-day and 30-day epochs are the fully-tested candidates
 * (most likely to be adopted). 1 hour / 1 day / 90 days are included for
 * characterization only and explicitly labeled as such — do not read their
 * numbers as recommendations.
 *
 * INTEGRITY NOTES (added after an audit pass found real problems with the
 * first version of this suite — see TRACKER.md "Simulation suite integrity
 * fixes" for the full history):
 *   - A REAL BUG existed in the underlying mechanism: `deriveSettlementRate`
 *     failed to account for the base window's own remaining tail after
 *     staging, and `distributedUsdOverWindow` silently dropped the gap
 *     between the last sample and the window end. Together these produced a
 *     ~3.5% systematic OVER-distribution that happened to nearly cancel the
 *     deliberate 3% conservativeFactor buffer — masking the bug as "the
 *     mechanism is accurate" in the test summary. Both are now fixed (see
 *     `epochDistribution.ts`); `test/hardhat/unit/epochDistribution.test.ts`'s
 *     "CORE VALIDATION" test proves flat supply + NO buffer lands within
 *     0.1% of Y*.
 *   - Assertions now compare against the correct baseline: tests that
 *     deliberately exercise `conservativeFactor < 1` compare against the
 *     ADJUSTED (buffered) target, not raw Y* — a permanent, intentional gap
 *     vs. raw Y* is the buffer working correctly, not error.
 *   - The "no split" control now uses `noSettlement: true` (a genuine single
 *     rate for the whole epoch), not `baseWindowFraction: 1.0` (which still
 *     runs a same-rate settlement window and understates how much worse a
 *     true no-B3 baseline is).
 *   - "Epoch length" scenarios now use ABSOLUTE staging lead time and sample
 *     cadence (not fractions of the epoch) — the previous version used
 *     identical FRACTIONAL geometry across every epoch length, making
 *     "accuracy is flat across 5 orders of magnitude" a tautology of the test
 *     setup rather than a finding.
 *   - Vacuous assertions (`.to.not.be.NaN`, `.to.be.greaterThan(0)` on
 *     obviously-positive quantities) replaced with concrete, checked bounds
 *     throughout.
 *   - On-chain/model parity threshold tightened from `< 0.01%` to `< 1e-5%`
 *     (measured parity is consistently ~1e-7%; the old threshold had 5+
 *     orders of magnitude of slack and would not have caught a real regression).
 */

import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { OkuMoney, OkuMoney__factory } from "../../../typechain-types";
import {
    RateSegment,
    multiplierAt,
    distributedUsdOverWindow,
} from "../../../scripts/utils/epochDistribution";
import {
    EpochGrid,
    deriveBaseRate,
    deriveSettlementRateForEpoch,
    floatRateToBigint,
    baseEndSec,
    epochEndSec,
} from "../../../scripts/utils/epochSchedule";
import { valueAt } from "../../../scripts/utils/globalValue";
import { reconcileActualPayout } from "../../../scripts/utils/yieldRate";

const YEAR_SEC = 365 * 86400;

function apyToEpochGrowth(apy: number, epochLengthSec: number): number {
    return Math.pow(1 + apy, epochLengthSec / YEAR_SEC) - 1;
}

interface SupplyEvent {
    /** Fraction of the epoch [0, 1) at which this event fires. */
    atFraction: number;
    /** Raw token delta (positive = mint, negative = burn). */
    rawDelta: bigint;
}

interface ScenarioConfig {
    name: string;
    epochLengthSec: number;
    settlementFraction: number; // fraction of epoch reserved for settlement
    realizedApy: number; // e.g. 0.032 = 3.2% realized on-chain (after off-chain spread)
    initialSupplyTokens: number; // e.g. 1_000_000
    baseWindowFraction: number; // within-epoch split (B3)
    conservativeFactor: number; // cross-epoch buffer (D2), applied to targetUsd directly
    carryInUsd: number;
    supplyEvents: SupplyEvent[];
    sampleCount: number; // periodic samples across the FULL epoch
    stagingFraction: number; // fraction of epoch at which settlement is staged (must be < 1 - settlementFraction)
    /** TRUE feed-forward control: rBase runs the WHOLE epoch, no settlement
     *  window at all (not even a same-rate one). Use this as the honest
     *  no-B3 baseline — `baseWindowFraction: 1.0` alone still runs a
     *  (degenerate but present) settlement window and is NOT a true control. */
    noSettlement?: boolean;
}

interface ScenarioResult {
    name: string;
    rawTargetUsd: number; // Y* before any buffer
    adjustedTargetUsd: number; // after conservativeFactor + carryInUsd
    exactDistributedUsd: number;
    errorVsRawTarget: number;
    errorPctVsRawTarget: number;
    rBaseFloat: number;
    rSettleFloat: number;
    onChainMultiplierParityDiffPct: number; // sanity check: our float model vs actual on-chain rpow
    /** TRUE ex-post residual (targetUsd - exactDistributedUsd) via
     *  reconcileActualPayout — what should thread into the NEXT epoch's
     *  carryInUsd for real cumulative conservation, distinct from any
     *  internal-bookkeeping carryForward a rate-derivation step alone would produce. */
    carryForwardUsd: number;
}

async function deployOkuMoney(admin: string): Promise<OkuMoney> {
    const MAX_SUPPLY = ethers.parseEther("100000000000"); // 100B, well above any scenario
    const factory = new OkuMoney__factory((await ethers.getSigners())[0]);
    const okuMoney = (await upgrades.deployProxy(factory, ["OkuMoney", "OkuM", admin, MAX_SUPPLY], {
        kind: "uups",
    })) as unknown as OkuMoney;
    await okuMoney.waitForDeployment();
    return okuMoney;
}

async function runScenario(cfg: ScenarioConfig): Promise<ScenarioResult> {
    const [signer] = await ethers.getSigners();
    const adminAddr = await signer.getAddress();
    const okuMoney = await deployOkuMoney(adminAddr);

    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"));
    const OKUM_BURNER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BURNER"));
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"));
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"));
    await okuMoney.grantRole(OKUM_MINTER, adminAddr);
    await okuMoney.grantRole(OKUM_BURNER, adminAddr);
    await okuMoney.grantRole(OKUM_ALLOWANCE_MANAGER, adminAddr);
    await okuMoney.grantRole(OKUM_REBASER, adminAddr);
    await okuMoney.configureMinterAllowance(adminAddr, ethers.parseEther("100000000000"));

    const initialSupplyRaw = ethers.parseEther(cfg.initialSupplyTokens.toString());
    await okuMoney.mint(adminAddr, initialSupplyRaw);
    const initialSupplyUsd = cfg.initialSupplyTokens; // multiplier starts at 1.0

    // --- Derive schedule ---
    const rawTargetUsd = initialSupplyUsd * apyToEpochGrowth(cfg.realizedApy, cfg.epochLengthSec);
    const adjustedTargetUsd = rawTargetUsd * cfg.conservativeFactor + cfg.carryInUsd;

    // epochStart is set to the EXACT timestamp of the first on-chain
    // setOkuMYieldRate tx, so our off-chain model's anchor (multiplier=1.0 @
    // epochStart) matches the contract's own okuMLastAccrualTime exactly —
    // otherwise the on-chain/model parity check below would show spurious
    // drift from a few seconds of setup-tx anchor mismatch, not from rpow.
    const epochStart = (await time.latest()) + 2;
    const grid: EpochGrid = {
        epochStartSec: epochStart,
        epochLengthSec: cfg.epochLengthSec,
        settlementFraction: cfg.settlementFraction,
    };

    const { ratePerSecond: rBaseFloatRaw } = deriveBaseRate({
        targetUsd: adjustedTargetUsd,
        baseWindowFraction: cfg.baseWindowFraction,
        measuredAvgValueUsd: initialSupplyUsd,
        grid,
    });
    // CRITICAL: re-derive the float rate from the CLAMPED on-chain bigint, not
    // the raw theoretical derivation. Without this, an extreme scenario whose
    // derived rate exceeds MAX_RATE produces a ground-truth model using a rate
    // the chain never actually runs at — a real bug this harness had (~25.6%
    // model/chain divergence on a MAX_RATE-clamping scenario before this fix).
    // Every non-extreme scenario is unaffected (floatRateToBigint is a no-op
    // clamp-wise when the rate is already in range).
    const rBaseFloat = Number(floatRateToBigint(rBaseFloatRaw)) / 1e18;

    const baseEnd = Math.floor(baseEndSec(grid));
    const epochEnd = Math.floor(epochEndSec(grid));

    // Initial on-chain write: base rate only (no successor yet — it's derived later from live data).
    // Under noSettlement (true feed-forward control), the base rate simply
    // runs the WHOLE epoch — its own "endTimestamp" is epochEnd, not baseEnd.
    await time.increaseTo(epochStart);
    await okuMoney.setOkuMYieldRate(floatRateToBigint(rBaseFloat), cfg.noSettlement ? epochEnd : baseEnd);

    // --- Run the epoch: apply scripted supply events + collect periodic samples ---
    const trueSegments: RateSegment[] = [
        { startSec: epochStart, endSec: cfg.noSettlement ? epochEnd : baseEnd, ratePerSecond: rBaseFloat, anchorMultiplier: 1.0 },
    ];
    // rSettle appended once derived, below.

    const stagingTime = Math.floor(epochStart + cfg.epochLengthSec * cfg.stagingFraction);
    if (!cfg.noSettlement && stagingTime >= baseEnd) {
        throw new Error(`${cfg.name}: stagingFraction puts staging AT/AFTER baseEnd — invalid scenario config`);
    }

    // Exact event log for ground-truth computation (test-scripted, so fully known).
    const exactEvents: { t: number; supplyAfter: number }[] = [{ t: epochStart, supplyAfter: cfg.initialSupplyTokens }];
    let runningSupplyTokens = cfg.initialSupplyTokens;

    // Periodic sample times (the REALISTIC, imperfect measurement the settlement derivation uses).
    const sampleTimes: number[] = [];
    for (let i = 0; i <= cfg.sampleCount; i++) {
        sampleTimes.push(Math.floor(epochStart + (cfg.epochLengthSec * i) / cfg.sampleCount));
    }

    // Merge scripted-event times and sample times into one chronological timeline of on-chain actions.
    // Multiple actions can legitimately share a timestamp (e.g. a sample lands
    // on the same second as the staging instant) — group by timestamp so we
    // only ever advance the chain's clock ONCE per distinct second.
    type Action = { t: number; kind: "event" | "sample" | "stage"; event?: SupplyEvent };
    const rawActions: Action[] = [
        ...cfg.supplyEvents.map((e) => ({ t: Math.floor(epochStart + cfg.epochLengthSec * e.atFraction), kind: "event" as const, event: e })),
        ...sampleTimes.map((t) => ({ t, kind: "sample" as const })),
        ...(cfg.noSettlement ? [] : [{ t: stagingTime, kind: "stage" as const }]),
    ].sort((a, b) => a.t - b.t);

    const groupedByTime = new Map<number, Action[]>();
    for (const a of rawActions) {
        const bucket = groupedByTime.get(a.t) ?? [];
        bucket.push(a);
        groupedByTime.set(a.t, bucket);
    }
    // Within a timestamp group, order events before samples before staging, so
    // a sample taken at the same second as a mint reflects the post-mint state
    // and staging sees the freshest possible data.
    const kindOrder = { event: 0, sample: 1, stage: 2 } as const;
    const orderedTimes = [...groupedByTime.keys()].sort((a, b) => a - b);

    const samples: { timestampSec: number; valueUsd: number }[] = [];
    let rSettleFloat = 1;

    for (const t of orderedTimes) {
        const currentLatest = await time.latest();
        if (t > currentLatest) {
            await time.increaseTo(t);
        }
        // If t <= currentLatest (e.g. epochStart - 1 already consumed by setup),
        // proceed without warping — actions execute in the current block.

        const actionsAtT = groupedByTime.get(t)!.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
        for (const action of actionsAtT) {
        if (action.kind === "event" && action.event) {
            if (action.event.rawDelta > 0n) {
                await okuMoney.mint(adminAddr, action.event.rawDelta);
            } else if (action.event.rawDelta < 0n) {
                await okuMoney.burn(-action.event.rawDelta);
            }
            runningSupplyTokens += Number(ethers.formatEther(action.event.rawDelta));
            exactEvents.push({ t: action.t, supplyAfter: runningSupplyTokens });
        } else if (action.kind === "sample") {
            const supply = await okuMoney.totalSupply();
            const mult = await okuMoney.okuMMultiplier();
            const valueUsd = Number(ethers.formatEther(supply)) * (Number(mult) / 1e18);
            samples.push({ timestampSec: action.t, valueUsd });
        } else if (action.kind === "stage") {
            const samplesSoFar = samples.filter((s) => s.timestampSec <= action.t);
            if (samplesSoFar.length < 2) {
                // Not enough data yet — fall back to the anchor value (degenerate but safe).
                samplesSoFar.push({ timestampSec: epochStart, valueUsd: initialSupplyUsd });
            }
            const distributedSoFarUsd = distributedUsdOverWindow(trueSegments, samplesSoFar, epochStart, action.t);
            const forecastValueUsd = valueAt(samplesSoFar, action.t);

            const rSettleFloatRaw = deriveSettlementRateForEpoch({
                targetUsd: adjustedTargetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd: forecastValueUsd,
                grid,
                stagingSec: action.t,
                baseRatePerSecond: rBaseFloat,
            });
            // Same clamp-and-reconvert as rBaseFloat above — the model must
            // reflect what's ACTUALLY on-chain, not the unclamped derivation.
            rSettleFloat = Number(floatRateToBigint(rSettleFloatRaw)) / 1e18;
            trueSegments.push({
                startSec: baseEnd,
                endSec: epochEnd,
                ratePerSecond: rSettleFloat,
                anchorMultiplier: multiplierAt(trueSegments, baseEnd),
            });

            await okuMoney.setOkuMYieldRateWithSuccessor(
                floatRateToBigint(rBaseFloat),
                baseEnd,
                floatRateToBigint(rSettleFloat),
                epochEnd
            );
        }
        }
    }

    // --- Ground truth (exact, event-based — independent of the sampling approximation above) ---
    exactEvents.push({ t: epochEnd, supplyAfter: runningSupplyTokens });
    let exactDistributedUsd = 0;
    for (let i = 0; i < exactEvents.length - 1; i++) {
        const supply = exactEvents[i].supplyAfter;
        const mStart = multiplierAt(trueSegments, exactEvents[i].t);
        const mEnd = multiplierAt(trueSegments, exactEvents[i + 1].t);
        exactDistributedUsd += supply * (mEnd - mStart);
    }

    // --- On-chain parity check: does the REAL contract's rpow match our float model? ---
    if (epochEnd > (await time.latest())) {
        await time.increaseTo(epochEnd);
    }
    const onChainMultiplier = Number(await okuMoney.okuMMultiplier()) / 1e18;
    const modelMultiplier = multiplierAt(trueSegments, epochEnd);
    const onChainMultiplierParityDiffPct = (Math.abs(onChainMultiplier - modelMultiplier) / modelMultiplier) * 100;

    return {
        name: cfg.name,
        rawTargetUsd,
        adjustedTargetUsd,
        exactDistributedUsd,
        errorVsRawTarget: exactDistributedUsd - rawTargetUsd,
        errorPctVsRawTarget: ((exactDistributedUsd - rawTargetUsd) / rawTargetUsd) * 100,
        rBaseFloat,
        rSettleFloat,
        onChainMultiplierParityDiffPct,
        carryForwardUsd: reconcileActualPayout(adjustedTargetUsd, exactDistributedUsd),
    };
}

// Baseline defaults shared across scenarios — "1M global supply, ~3.2% realized
// on-chain yield (after off-chain spread from a ~3.5% RWA return), 24-hour
// epoch, recommended base/settlement split and a small cross-epoch buffer."
const BASELINE: Omit<ScenarioConfig, "name" | "supplyEvents"> = {
    epochLengthSec: 24 * 3600, // 24h production epoch (scripts/config/epoch.ts)
    settlementFraction: 1 / 15, // 1.6h of 24h
    realizedApy: 0.032,
    initialSupplyTokens: 1_000_000,
    baseWindowFraction: 0.9,
    conservativeFactor: 0.97,
    carryInUsd: 0,
    sampleCount: 48, // every 30 min across a 24h epoch (see per-scenario overrides)
    stagingFraction: (1 / 15) * 0.85, // stage settlement ~85% of the way through... see below, corrected per-scenario
};

const allResults: ScenarioResult[] = [];
const recordedRunScenario = async (cfg: ScenarioConfig): Promise<ScenarioResult> => {
    const result = await runScenario(cfg);
    allResults.push(result);
    return result;
};

describe("Simulation: base+settlement epoch distribution accuracy", function () {
    this.timeout(600_000); // many time-warped on-chain txs per scenario

    after(() => {
        // Human-readable summary — the numbers backing the accuracy tables in
        // EVM/docs/epoch-accounting.md. Run
        // `npx hardhat test test/hardhat/simulation/epochAccounting.simulation.ts`
        // to regenerate after changing any scenario parameters.
        console.log("\n=== Simulation summary (name | error% vs raw target | on-chain parity diff%) ===");
        for (const r of allResults) {
            console.log(
                `${r.name.padEnd(55)} ${r.errorPctVsRawTarget.toFixed(2).padStart(8)}%   parity ${r.onChainMultiplierParityDiffPct.toExponential(2)}%`
            );
        }
    });

    before(async () => {
        // Disable forking for these sims — they only touch our own contracts and
        // run many time.increaseTo() calls; forking adds RPC overhead with no
        // benefit. `hardhat_reset` with EMPTY params (an earlier version of this
        // file) does NOT disable forking — it resets to the network config's
        // OWN defaults, which per hardhat.config.ts has `forking.enabled: true`
        // for the default network. Must pass an explicit override to actually
        // turn forking off.
        await network.provider.request({
            method: "hardhat_reset",
            params: [{}],
        });
    });

    after(async () => {
        // Restore the config-default (forked) network state so later test
        // files in the same `npx hardhat test` run aren't silently left on a
        // plain in-memory chain by this suite — an ordering hazard that
        // previously existed only because `simulation/` happens to sort after
        // the fork-dependent test directories alphabetically. Making this
        // order-independent is cheap insurance against a later directory
        // rename or new test folder breaking fork tests non-obviously.
        await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 1: yield level extremes (fixed 30-day epoch, recommended buffer/split)
    // ═══════════════════════════════════════════════════════════════════════
    describe("Yield level extremes", () => {
        const cases: { name: string; realizedApy: number }[] = [
            { name: "very low yield (0.05% APY)", realizedApy: 0.0005 },
            { name: "realistic realized yield (3.2% APY, vs 3.5% RWA headline)", realizedApy: 0.032 },
            { name: "high yield (15% APY)", realizedApy: 0.15 },
            { name: "very high yield (60% APY)", realizedApy: 0.6 },
        ];

        for (const c of cases) {
            it(`${c.name}: base+settlement stays within 3% of ADJUSTED target under moderate volatility`, async () => {
                const result = await recordedRunScenario({
                    ...BASELINE,
                    name: c.name,
                    realizedApy: c.realizedApy,
                    stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                    supplyEvents: [{ atFraction: 0.4, rawDelta: ethers.parseEther("200000") }], // +20% mid-epoch
                });
                // NOTE: compares against the ADJUSTED (post-buffer) target, not
                // raw Y* — with conservativeFactor=0.97 a ~-3% gap vs raw Y* is
                // the CORRECT, deliberate outcome, not error. See the "buffer
                // extremes" section below for a test that isolates the buffer's
                // own effect explicitly.
                const errorVsAdjustedPct =
                    ((result.exactDistributedUsd - result.adjustedTargetUsd) / result.adjustedTargetUsd) * 100;
                // 3%, and the title says 3%. It previously said "~1%" while
                // asserting 3 -- someone measured ~2.3, raised the bound and left
                // the claim, so the suite summary advertised an accuracy figure
                // the suite does not check.
                expect(Math.abs(errorVsAdjustedPct)).to.be.lessThan(3);
                expect(result.onChainMultiplierParityDiffPct).to.be.lessThan(1e-5);
            });
        }

        it("near-MAX_RATE (2000% APY, ~89% of the way to MAX_RATE's 2242%): mechanism doesn't break, rate is NOT clamped yet", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "near-MAX_RATE (2000% APY)",
                realizedApy: 20.0,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: [{ atFraction: 0.4, rawDelta: ethers.parseEther("200000") }],
            });
            expect(result.onChainMultiplierParityDiffPct).to.be.lessThan(1e-5);
            const errorVsAdjustedPct =
                ((result.exactDistributedUsd - result.adjustedTargetUsd) / result.adjustedTargetUsd) * 100;
            expect(Math.abs(errorVsAdjustedPct)).to.be.lessThan(3);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 1b: MAX_RATE clamp — a target genuinely large enough to REQUIRE clamping
    // ═══════════════════════════════════════════════════════════════════════
    describe("MAX_RATE clamp", () => {
        it("a target implying a rate ABOVE MAX_RATE clamps rather than reverting or silently mis-deriving", async () => {
            // MAX_RATE ~= 2242% APY. Ask for far more than that against a SMALL
            // supply base window, forcing the required rate past the ceiling.
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "MAX_RATE clamp",
                realizedApy: 500.0, // 50,000% APY — deliberately absurd, forces clamping
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: [],
            });
            // floatRateToBigint clamps to MAX_RATE rather than the tx reverting —
            // confirm the on-chain rate actually IS the clamp ceiling, not the
            // (unrepresentable) derived float. Asserting the ceiling DIRECTLY is
            // the real invariant here; the error-magnitude check below is a
            // weaker, epoch-length-dependent consequence of it.
            const MAX_RATE_FLOAT = 1 + 1e-7; // Constants.sol: PRECISION + 1e11, in float terms
            expect(result.rBaseFloat).to.be.closeTo(MAX_RATE_FLOAT, 1e-12);
            // Distribution still happens, bounded by the clamp. `isFinite` and
            // `> 0` were vacuous on a monotone multiplier; the clamped rate makes
            // the payout computable, so assert that instead.
            //
            // At the ceiling, 1M tokens held for the 90% base window of a 24h
            // epoch distribute `S x (MAX_RATE^baseLen - 1)`. Derived from the
            // scenario's own inputs, so it moves with them rather than being a
            // transcribed constant.
            const baseWindowSec = BASELINE.epochLengthSec * BASELINE.baseWindowFraction;
            const clampedBaseFloor =
                BASELINE.initialSupplyTokens * (Math.pow(MAX_RATE_FLOAT, baseWindowSec) - 1);
            expect(result.exactDistributedUsd, "clamped distribution still pays the ceiling rate")
                .to.be.greaterThan(clampedBaseFloor * 0.5);
            // With such an extreme target, actual distribution is necessarily
            // far below it (clamped) — this is the EXPECTED failure mode: the
            // config is unreachable at this AUM, and the mechanism reports a
            // large negative "achieved vs target" gap rather than doing
            // something silently wrong.
            //
            // NOTE the threshold is -40, not -50: the size of this gap depends
            // on the epoch length, because MAX_RATE compounds over the window
            // while the APY-derived target does not scale the same way. At the
            // same absurd 50,000% APY the shortfall is ~-55.6% over 30 days but
            // ~-49.5% over 24 hours. A tighter bound here would be asserting the
            // epoch length, not the clamp.
            expect(result.errorPctVsRawTarget).to.be.lessThan(-40);
            // Model/chain parity: this test caught a REAL harness bug (the
            // ground-truth model previously used the UNCLAMPED float rate while
            // the chain runs the clamped one, producing ~25.6% spurious
            // "divergence"). Threshold is looser than the 1e-5% used elsewhere
            // because MAX_RATE itself is large enough that float rounding in
            // the clamp-and-reconvert step is proportionally larger.
            expect(result.onChainMultiplierParityDiffPct).to.be.lessThan(1e-4);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 2: cross-epoch buffer (conservativeFactor) extremes
    // ═══════════════════════════════════════════════════════════════════════
    describe("Cross-epoch buffer (conservativeFactor) extremes", () => {
        it("buffer too LOW (conservativeFactor=1, none): a bad settlement forecast over-distributes with nothing absorbing it", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "no buffer",
                conservativeFactor: 1.0,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                // Large LATE supply swing AFTER staging — the settlement forecast
                // (persistence) cannot see this coming.
                supplyEvents: [{ atFraction: 0.97, rawDelta: ethers.parseEther("400000") }],
            });
            // With NO buffer, an unforecastable late swing must show up as a
            // REAL, measurable over-distribution vs Y* — a concrete, checked
            // bound, not just "not NaN".
            expect(result.errorPctVsRawTarget).to.be.greaterThan(0.5);
        });

        it("buffer too HIGH (conservativeFactor=0.5): permanently withholds half of every epoch's yield as carry, even with zero volatility", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "excessive buffer",
                conservativeFactor: 0.5,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: [], // flat — isolates the buffer's OWN cost from volatility
            });
            // With zero volatility, distributed should track the ADJUSTED
            // (buffered) target almost exactly — proving the -50%-vs-Y* outcome
            // below is the buffer working AS DESIGNED, not mechanism error.
            const errorVsAdjustedPct =
                ((result.exactDistributedUsd - result.adjustedTargetUsd) / result.adjustedTargetUsd) * 100;
            expect(Math.abs(errorVsAdjustedPct)).to.be.lessThan(1);
            // The finding: an oversized buffer costs accuracy-vs-Y* even with
            // no volatility to justify it — ~half of every epoch's yield sits
            // as permanent carry, never paid to current holders.
            expect(result.errorPctVsRawTarget).to.be.lessThan(-40);
        });

        it("recommended buffer (conservativeFactor=0.97) tracks the ADJUSTED target closely under zero volatility", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "recommended buffer, flat supply",
                supplyEvents: [],
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
            });
            const errorVsAdjustedPct =
                ((result.exactDistributedUsd - result.adjustedTargetUsd) / result.adjustedTargetUsd) * 100;
            expect(Math.abs(errorVsAdjustedPct)).to.be.lessThan(1);
            // And vs raw Y*, should sit close to -(1 - conservativeFactor) = -3%,
            // confirming the buffer's cost is exactly what was intended, no more.
            expect(result.errorPctVsRawTarget).to.be.closeTo(-3, 1);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 3: within-epoch split (baseWindowFraction) extremes, incl. a TRUE
    // feed-forward control (noSettlement) — NOT baseWindowFraction=1, which
    // still runs a (degenerate) settlement window and understates how much
    // worse a genuine no-B3 baseline is.
    // ═══════════════════════════════════════════════════════════════════════
    describe("Within-epoch split (baseWindowFraction) extremes", () => {
        const volatileSupplyEvents: SupplyEvent[] = [{ atFraction: 0.5, rawDelta: ethers.parseEther("500000") }]; // +50% mid-epoch

        it("TRUE feed-forward control (noSettlement=true, single rate for the whole epoch): the honest no-B3 baseline", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "true feed-forward (no B3 at all)",
                noSettlement: true,
                stagingFraction: 0.5, // unused when noSettlement
                supplyEvents: volatileSupplyEvents,
            });
            // A +50% mid-epoch supply jump with a single committed rate for the
            // WHOLE epoch and no correction mechanism at all should produce a
            // LARGE error — this is the honest control B3 is compared against.
            expect(Math.abs(result.errorPctVsRawTarget)).to.be.greaterThan(10);
        });

        it("split too LOW (baseWindowFraction=0.3): most of the target rides on the short, forecast-dependent settlement window", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "excessive settlement reliance",
                baseWindowFraction: 0.3,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: volatileSupplyEvents,
            });
            // Concrete, checked bound instead of "not NaN": with only 30% of the
            // target committed to the (measurement-anchored) base rate, the
            // settlement window is doing most of the work off a SHORT persistence
            // forecast — this should still land closer to target than the
            // feed-forward control, but the mechanism's accuracy is now
            // concentrated in one short window's forecast quality.
            expect(Math.abs(result.errorPctVsRawTarget)).to.be.lessThan(10);
        });

        it("recommended split (baseWindowFraction=0.9) materially beats the TRUE feed-forward control under the SAME volatility", async () => {
            const withSplit = await recordedRunScenario({
                ...BASELINE,
                name: "recommended split",
                baseWindowFraction: 0.9,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: volatileSupplyEvents,
            });
            const noSplit = await recordedRunScenario({
                ...BASELINE,
                name: "no split control (true feed-forward)",
                noSettlement: true,
                stagingFraction: 0.5,
                supplyEvents: volatileSupplyEvents,
            });
            expect(Math.abs(withSplit.errorPctVsRawTarget)).to.be.lessThan(Math.abs(noSplit.errorPctVsRawTarget));
        });

        // EXPERIMENT (added after an audit found the recommendation was
        // UNSUBSTANTIATED by the existing scenarios): the mid-epoch (40-50%
        // through) shock used above lands in the BASE window, before staging —
        // in that case a SMALLER base commitment (0.3) means LESS exposure to
        // the disruption, so 0.3 can look better than 0.9 there. That is not
        // the risk the README claimed 0.3 carries ("concentrates risk in a
        // short, forecast-dependent window"). This test constructs the
        // scenario that actually tests that specific claim: a shock landing
        // DURING the settlement window itself, AFTER staging has already
        // fixed the settlement rate against a forecast that could not see it
        // coming. At baseWindowFraction=0.3, 70% of the target's exposure sits
        // in that disrupted window; at 0.9, only 10% does.
        it("EXPERIMENT: a shock DURING the settlement window (after staging) tests the claimed 0.3-vs-0.9 risk difference directly", async () => {
            const settlementFraction = BASELINE.settlementFraction;
            const stagingFraction = 1 - settlementFraction - 0.02; // ~0.9133
            const baseEndFraction = 1 - settlementFraction; // ~0.9333
            // Shock lands strictly between staging and baseEnd's activation of
            // the settlement rate is already locked in) and epoch end — i.e.
            // inside the settlement window itself, invisible to its forecast.
            const shockDuringSettlement: SupplyEvent[] = [
                { atFraction: (baseEndFraction + 1) / 2, rawDelta: ethers.parseEther("500000") }, // +50%, mid-settlement-window
            ];

            const low = await recordedRunScenario({
                ...BASELINE,
                name: "baseWindowFraction=0.3, shock IN settlement window",
                baseWindowFraction: 0.3,
                stagingFraction,
                supplyEvents: shockDuringSettlement,
            });
            const high = await recordedRunScenario({
                ...BASELINE,
                name: "baseWindowFraction=0.9, shock IN settlement window",
                baseWindowFraction: 0.9,
                stagingFraction,
                supplyEvents: shockDuringSettlement,
            });

            console.log(
                `  EXPERIMENT RESULT: bWF=0.3 error=${low.errorPctVsRawTarget.toFixed(2)}%  ` +
                    `bWF=0.9 error=${high.errorPctVsRawTarget.toFixed(2)}%  ` +
                    `(0.9 better: ${Math.abs(high.errorPctVsRawTarget) < Math.abs(low.errorPctVsRawTarget)})`
            );

            // This assertion is the actual finding, not an assumption: it will
            // FAIL (loudly, not silently) if 0.3 turns out to be equal-or-better
            // even for a shock specifically constructed to expose the claimed
            // settlement-window concentration risk. Whichever way this goes,
            // the recommendation in EVM/README.md is updated to match — see
            // that file for which one won and by how much.
            expect(Math.abs(high.errorPctVsRawTarget)).to.be.lessThan(Math.abs(low.errorPctVsRawTarget));
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 4: epoch length — user directive: fully test 7-day and 30-day
    // epochs (most likely candidates for adoption). 1h/1d/90d are included as
    // characterization only, clearly labeled as such, and — critically — use
    // ABSOLUTE (not fractional) staging lead + sample cadence, so the
    // comparison isn't a tautology of self-similar geometry (a bug in the
    // PREVIOUS version of this suite: all 5 "epoch length" scenarios used the
    // exact same fractional staging lead and sample count, so the discretized
    // gap was IDENTICAL in fractional terms across every length, making
    // "accuracy is flat across 5 orders of magnitude" a foregone conclusion
    // rather than a finding).
    //
    // HONEST LIMITATION (found while fixing the above, not fully chased down
    // per the "don't over-troubleshoot" directive): despite the absolute lead
    // time fix, measured error is STILL nearly identical across all 5 lengths
    // (~2.27-2.29%). The remaining self-similarity is very likely because the
    // mid-epoch supply SHOCK's position is still specified as a FRACTION
    // (`atFraction: 0.4`) of the epoch, not an absolute time — so the shock's
    // relationship to the (now-absolute) staging lead still scales with epoch
    // length. A fully decoupled test would fix the shock at an absolute time
    // too. Flagged in TRACKER.md rather than chased further here.
    // ═══════════════════════════════════════════════════════════════════════
    describe("Epoch length", () => {
        // Fixed ABSOLUTE staging lead and sample interval, clamped down for
        // very short epochs so the scenario stays valid (staging must land
        // before baseEnd).
        function absoluteStagingConfig(epochLengthSec: number, settlementFraction: number) {
            const baseWindowLenSec = epochLengthSec * (1 - settlementFraction);
            const desiredLeadSec = 6 * 3600; // 6 hours, absolute
            const leadSec = Math.min(desiredLeadSec, baseWindowLenSec * 0.3);
            const stagingFraction = (baseWindowLenSec - leadSec) / epochLengthSec;
            const desiredSampleIntervalSec = 30 * 60; // 30 minutes, absolute
            const sampleCount = Math.max(4, Math.floor(epochLengthSec / Math.min(desiredSampleIntervalSec, epochLengthSec / 8)));
            return { stagingFraction, sampleCount };
        }

        // `fullyTested` marks a length as an operationally supported candidate
        // rather than a characterization data point. "1 day" was promoted when
        // the production grid moved to 24h (scripts/config/epoch.ts): its
        // settlement window is 1.6h, comfortably above the sub-hour threshold
        // flagged below, and the accuracy result is in line with the longer
        // lengths. "1 hour" stays characterization-only — a 4-minute settlement
        // window is not an operational window.
        const lengths: { name: string; epochLengthSec: number; fullyTested: boolean }[] = [
            { name: "1 hour", epochLengthSec: 3600, fullyTested: false },
            { name: "1 day (baseline — production grid)", epochLengthSec: 86400, fullyTested: true },
            { name: "7 days", epochLengthSec: 7 * 86400, fullyTested: true },
            { name: "30 days", epochLengthSec: 30 * 86400, fullyTested: true },
            { name: "90 days", epochLengthSec: 90 * 86400, fullyTested: false },
        ];

        for (const l of lengths) {
            const tag = l.fullyTested ? "[fully tested — candidate]" : "[characterization only]";
            it(`${l.name} ${tag}: schedule derives and settles with a mid-epoch supply swing`, async () => {
                const settlementFraction = 1 / 15;
                const { stagingFraction, sampleCount } = absoluteStagingConfig(l.epochLengthSec, settlementFraction);
                const result = await recordedRunScenario({
                    ...BASELINE,
                    name: `${l.name}${l.fullyTested ? "" : " (characterization only)"}`,
                    epochLengthSec: l.epochLengthSec,
                    settlementFraction,
                    sampleCount,
                    stagingFraction,
                    supplyEvents: [{ atFraction: 0.4, rawDelta: ethers.parseEther("300000") }], // +30% mid-epoch
                });
                // Measured error is ~2.27-2.29% at EVERY length tested -- see the
                // HONEST LIMITATION note above, which explains why
                // (`atFraction` still scales the shock's position with epoch
                // length, so the scenario is not actually decoupled).
                //
                // The bound is therefore stated as what is observed, two-sided,
                // not as `< 20`. That bound was ~9x looser than any measurement
                // and sat under an inline comment claiming "error now varies
                // genuinely with epoch length" -- which the note 50 lines above
                // directly contradicts. A 5x regression would have passed.
                expect(
                    Math.abs(result.errorPctVsRawTarget),
                    "epoch-length error is self-similar at ~2.28% until atFraction is decoupled"
                ).to.be.closeTo(2.28, 0.5);
                expect(result.onChainMultiplierParityDiffPct).to.be.lessThan(1e-5);
                if (!l.fullyTested) {
                    // Sub-day epochs: ASSERT the operational infeasibility rather
                    // than only logging it. The previous version's guarded branch
                    // contained a `console.log` and no assertion at all, so a
                    // length silently becoming operationally viable -- or a
                    // `fullyTested` flag going stale -- would not surface.
                    // A length is characterization-only for one of two reasons,
                    // and they are opposites: the settlement window is too short
                    // to operate (1 hour -> 4 minutes), or the epoch itself
                    // exceeds `MAX_RATE_WINDOW` so a single window cannot span it
                    // (90 days). Assert it fails at least one bound, so a length
                    // that quietly becomes viable -- or a stale `fullyTested`
                    // flag -- surfaces instead of passing silently.
                    const settlementWindowSec = l.epochLengthSec * settlementFraction;
                    const MAX_RATE_WINDOW_SEC = 90 * 86400;
                    expect(
                        settlementWindowSec < 3600 || l.epochLengthSec >= MAX_RATE_WINDOW_SEC,
                        `${l.name} is marked characterization-only but is operationally viable: ` +
                            `settlement window ${(settlementWindowSec / 60).toFixed(1)} min, ` +
                            `epoch ${(l.epochLengthSec / 86400).toFixed(1)} days`
                    ).to.be.true;
                    console.log(
                        `  NOTE: ${l.name} settlement window is only ${(settlementWindowSec / 60).toFixed(1)} minutes — ` +
                            "not recommended operationally regardless of measured accuracy."
                    );
                }
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 5: supply-path scenarios (fixed realistic yield/buffer/split/epoch)
    // ═══════════════════════════════════════════════════════════════════════
    describe("Supply-path scenarios", () => {
        const stagingFraction = 1 - BASELINE.settlementFraction - 0.02;

        it("flat supply: tracks the ADJUSTED target closely (baseline sanity check)", async () => {
            const result = await recordedRunScenario({ ...BASELINE, name: "flat", supplyEvents: [], stagingFraction });
            const errorVsAdjustedPct =
                ((result.exactDistributedUsd - result.adjustedTargetUsd) / result.adjustedTargetUsd) * 100;
            expect(Math.abs(errorVsAdjustedPct)).to.be.lessThan(1);
        });

        it("linear-equivalent ramp UP (+50% via early+mid mints): moderate, EXPECTED error — see monotonicity finding below", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "ramp up",
                stagingFraction,
                supplyEvents: [
                    { atFraction: 0.2, rawDelta: ethers.parseEther("200000") },
                    { atFraction: 0.5, rawDelta: ethers.parseEther("200000") },
                    { atFraction: 0.8, rawDelta: ethers.parseEther("100000") },
                ],
            });
            // ~10-11%, not a bug — see the "monotonicity means overshoot cannot be
            // clawed back" finding in the test below. Early-and-sustained extra
            // capital earns at rBase (sized for the SMALLER pre-shock supply) for
            // most of the base window, pushing distributedSoFarUsd past the target
            // before settlement staging even runs; settlement can only halt
            // (rSettle=1) from that point, never reverse the overshoot.
            expect(Math.abs(result.errorPctVsRawTarget)).to.be.lessThan(15);
        });

        it("ramp DOWN (-40% via early+mid burns): small error", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "ramp down",
                stagingFraction,
                supplyEvents: [
                    { atFraction: 0.2, rawDelta: ethers.parseEther("-200000") },
                    { atFraction: 0.5, rawDelta: ethers.parseEther("-200000") },
                ],
            });
            expect(Math.abs(result.errorPctVsRawTarget)).to.be.lessThan(5);
        });

        it("FINDING: monotonicity means an EARLY sustained shock is WORSE than an equal-size LATE shock, not better", async () => {
            // Naive intuition: a shock AFTER settlement is staged is "invisible"
            // to the correction, so it should be the worst case. This is WRONG,
            // and the simulation demonstrates why: because the multiplier can
            // only hold or grow, settlement can HALT further over-distribution
            // (rSettle -> PRECISION) but can NEVER claw back what the base window
            // already distributed. An early shock earns at rBase (sized for the
            // smaller PRE-shock supply) for nearly the whole base window,
            // pushing actual distribution past the target BEFORE settlement ever
            // runs — by staging time there is nothing left to correct. A late
            // shock, despite being genuinely invisible to the correction, simply
            // doesn't have TIME to distribute much regardless of rate. Total
            // capital-time exposure dominates over correctability.
            const lateResult = await recordedRunScenario({
                ...BASELINE,
                name: "late shock",
                stagingFraction,
                supplyEvents: [{ atFraction: 0.97, rawDelta: ethers.parseEther("500000") }],
            });
            const earlyResult = await recordedRunScenario({
                ...BASELINE,
                name: "early shock",
                stagingFraction,
                supplyEvents: [{ atFraction: 0.05, rawDelta: ethers.parseEther("500000") }],
            });
            expect(Math.abs(earlyResult.errorPctVsRawTarget)).to.be.greaterThan(
                Math.abs(lateResult.errorPctVsRawTarget)
            );
            // OPERATIONAL IMPLICATION (see EVM/docs/epoch-accounting.md):
            // monitoring should not wait for the fixed staging
            // instant — if distributedSoFarUsd is observed to exceed the target
            // WELL BEFORE the scheduled staging time, the operator should
            // re-anchor to PRECISION (halt) immediately via the same atomic
            // setOkuMYieldRateWithSuccessor, rather than waiting. This bounds
            // the early-shock failure mode to "detection latency", not "epoch length".
        });

        it("mint then redeem (round trip, net supply unchanged): distributed reflects TIME-weighted presence, not just net change", async () => {
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "round trip",
                stagingFraction,
                supplyEvents: [
                    { atFraction: 0.1, rawDelta: ethers.parseEther("500000") },
                    { atFraction: 0.6, rawDelta: ethers.parseEther("-500000") },
                ],
            });
            // Net supply at epoch end equals the initial supply, but the extra
            // capital was present (and earning at rBase, sized for the smaller
            // pre-shock supply) for 50% of the epoch before being redeemed —
            // same irreversible-overshoot mechanism as the finding above.
            expect(Math.abs(result.errorPctVsRawTarget)).to.be.lessThan(15);
        });

        it("doubling (extreme stress, +100% mid-epoch): error grows but the mechanism doesn't break", async () => {
            const flat = await recordedRunScenario({
                ...BASELINE,
                name: "doubling control (flat supply)",
                stagingFraction,
                supplyEvents: [],
            });
            const result = await recordedRunScenario({
                ...BASELINE,
                name: "doubling",
                stagingFraction,
                supplyEvents: [{ atFraction: 0.4, rawDelta: ethers.parseEther("1000000") }],
            });
            // "Error grows" is the test's own claim, so assert it against a flat
            // control rather than only checking the run produced a number.
            // `greaterThan(0)` was vacuous on a monotone multiplier.
            expect(
                Math.abs(result.errorPctVsRawTarget),
                "a +100% mid-epoch shock must degrade accuracy vs flat supply"
            ).to.be.greaterThan(Math.abs(flat.errorPctVsRawTarget));
            // ...and "doesn't break" means the on-chain mirror still agrees.
            expect(result.onChainMultiplierParityDiffPct).to.be.lessThan(1e-5);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AXIS 6 (NEW): multi-epoch carry threading — the previously-MISSING test.
    // Validates the headline "cumulative conservation" claim end-to-end
    // against a REAL deployed contract, not just hand-fed numbers.
    // ═══════════════════════════════════════════════════════════════════════
    describe("Multi-epoch carry threading (cumulative conservation)", () => {
        it("5 consecutive epochs, including a deliberate uncorrectable LATE shock: carry threading actually deceleration-tested, not just non-exploding", async function () {
            this.timeout(600_000);
            const EPOCHS = 5;
            const stagingFraction = 1 - BASELINE.settlementFraction - 0.02;
            let carryInUsd = 0;
            let cumulativeAdjustedTarget = 0;
            let cumulativeDistributed = 0;
            const carryHistory: number[] = [];
            const distributedHistory: number[] = [];

            const perEpochSupplyEvents: SupplyEvent[][] = [
                [], // epoch 1: flat baseline
                // epoch 2: a LARGE shock landing AFTER staging (0.97 > stagingFraction
                // ~0.9133) — genuinely uncorrectable within the epoch, unlike the
                // earlier version's mid-epoch shocks which mostly land before
                // staging and get largely absorbed by settlement. This is what
                // actually stresses the carry mechanism: it must produce a real,
                // large carryForward, not a token one.
                [{ atFraction: 0.97, rawDelta: ethers.parseEther("400000") }], // +40%, uncorrectable
                [], // epoch 3: flat — should show DECELERATION from epoch 2's carry-in
                [], // epoch 4: flat — carry should be converging back toward baseline
                [], // epoch 5: flat — confirms convergence, not divergence
            ];

            for (let epoch = 0; epoch < EPOCHS; epoch++) {
                const result = await recordedRunScenario({
                    ...BASELINE,
                    name: `multi-epoch #${epoch + 1} (carryIn=${carryInUsd.toFixed(2)})`,
                    carryInUsd,
                    stagingFraction,
                    supplyEvents: perEpochSupplyEvents[epoch],
                });
                cumulativeAdjustedTarget += result.adjustedTargetUsd;
                cumulativeDistributed += result.exactDistributedUsd;
                carryHistory.push(result.carryForwardUsd);
                distributedHistory.push(result.exactDistributedUsd);
                carryInUsd = result.carryForwardUsd;
            }

            const singleEpochTargetUsd =
                BASELINE.initialSupplyTokens *
                apyToEpochGrowth(BASELINE.realizedApy, BASELINE.epochLengthSec) *
                BASELINE.conservativeFactor;

            // The late shock in epoch 2 MUST produce a real, measurable NEGATIVE
            // carry (over-distributed relative to target) — not a token amount
            // like the ~-0.02 baseline seen in every flat epoch here. This is
            // what makes the rest of this test meaningful: if this assertion is
            // weak, everything downstream is testing near-zero carry again.
            // (Measured: ~-45, i.e. ~1.8% of a single epoch's target — real and
            // >1000x the flat-epoch baseline, but the shock's own brief window —
            // last ~3% of the epoch — bounds how large it gets. This calibrates
            // the threshold; an earlier version of this test assumed ~20% of a
            // single epoch's target with no measurement behind that number, and
            // failed against the ACTUAL result.)
            expect(carryHistory[1]).to.be.lessThan(-singleEpochTargetUsd * 0.01);

            // Epoch 3 (flat supply, large negative carry-in) must distribute
            // LESS than epoch 1 (flat supply, zero carry-in) — the deceleration
            // must be real and measurable, not just "doesn't crash".
            expect(distributedHistory[2]).to.be.lessThan(distributedHistory[0]);

            // Carry must be CONVERGING (shrinking in magnitude) by epoch 5, not
            // diverging or oscillating — each flat epoch after the shock should
            // claw back part of the deficit via the reduced (but still
            // buffer-discounted) target, same steady-state argument as
            // yieldRate.ts's "steady state" test, now proven end-to-end against
            // a real contract instead of just the isolated rate-derivation math.
            // (Measured: convergence is essentially complete by epoch 4 already
            // — one epoch of deceleration claws back nearly all of the shock's
            // carry — so epoch 4 and 5 are both compared against epoch 2's peak.)
            expect(Math.abs(carryHistory[3])).to.be.lessThan(Math.abs(carryHistory[1]));
            expect(Math.abs(carryHistory[4])).to.be.lessThan(Math.abs(carryHistory[1]));

            // Cumulative conservation identity still holds across the whole
            // sequence, including the shock — the mechanism absorbs a real
            // shock without breaking the aggregate accounting.
            const cumulativeErrorPct =
                ((cumulativeDistributed - cumulativeAdjustedTarget) / cumulativeAdjustedTarget) * 100;
            expect(Math.abs(cumulativeErrorPct)).to.be.lessThan(5);
        });

        it("a large NEGATIVE carry-in (simulating a prior over-payment) DECELERATES the base rate without breaking the mechanism", async () => {
            // Construct a carryInUsd large enough to meaningfully reduce the
            // effective target, but not so large it drives the base window's
            // target negative (which deriveBaseRate correctly rejects — see
            // epochSchedule.test.ts).
            const rawTargetUsd =
                BASELINE.initialSupplyTokens * apyToEpochGrowth(BASELINE.realizedApy, BASELINE.epochLengthSec);
            const largeNegativeCarry = -rawTargetUsd * 0.5;

            const withCarry = await recordedRunScenario({
                ...BASELINE,
                name: "large negative carry-in",
                carryInUsd: largeNegativeCarry,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: [],
            });
            const withoutCarry = await recordedRunScenario({
                ...BASELINE,
                name: "zero carry-in (control)",
                carryInUsd: 0,
                stagingFraction: 1 - BASELINE.settlementFraction - 0.02,
                supplyEvents: [],
            });

            // Decelerates: distributes LESS than the zero-carry control.
            expect(withCarry.exactDistributedUsd).to.be.lessThan(withoutCarry.exactDistributedUsd);
            // Never breaks monotonicity. `>= 1` was true by construction --
            // `floatRateToBigint` returns PRECISION for any input <= 1, so
            // `rBaseFloat` cannot be below 1 whatever the carry does. The real
            // content is that carry only DECELERATES: it must stay strictly
            // between the no-yield floor and the control rate.
            expect(withCarry.rBaseFloat, "carry decelerates but never halts accrual")
                .to.be.greaterThan(1);
            expect(withCarry.rBaseFloat, "carry must not accelerate past the control")
                .to.be.lessThan(withoutCarry.rBaseFloat);
            expect(withCarry.onChainMultiplierParityDiffPct).to.be.lessThan(1e-5);
        });
    });
});
