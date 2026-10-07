/**
 * Executes the REAL `applyScheduleToChain()` / `parseApplyArgs()` with the
 * single on-chain call stubbed, so the control flow around the chain write is
 * asserted rather than assumed. The operator drill calls `runSetOkuMYieldRate`
 * directly, re-implementing this driver's sequence rather than exercising it.
 *
 * Under test: argument validation, the already-confirmed early return, the
 * dry-run path, the receipt write-back, and the pre-submission binding checks
 * (chain identity, expiry, expected pre-state, already-applied recovery).
 */

import { expect } from "chai";
import fs from "fs";
import {
  applyScheduleToChain,
  parseApplyArgs,
  RateApplier,
  ChainState,
  ApplyDeps,
  ALREADY_APPLIED,
} from "../../../scripts/operator/applyScheduleSingleChain";
import {
  saveArtifact,
  artifactPath,
  EpochScheduleArtifact,
} from "../../../scripts/utils/epochArtifact";
import type { NetworkContext } from "../../../scripts/utils/networkContext";

const BOOK_KEY = "sepolia";
const CHAIN_ID = 11155111;
const ADDR = "0x00000000000000000000000000000000000000Aa";
const NOW = 10_000;

const PRE_STATE = {
  rate: "1000000000100000000",
  rateEnd: 1500,
  pendingRate: "1000000000300000000",
  pendingRateEnd: 1800,
  baseMultiplier: "1010000000000000000",
  lastAccrualTime: 900,
};

function makeArtifact(overrides: Partial<EpochScheduleArtifact> = {}): EpochScheduleArtifact {
  return {
    artifactVersion: 2,
    epochId: `apply-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    phase: "roll-epoch",
    derivedAtSec: 1000,
    expiresAtSec: NOW + 3600,
    referenceChain: BOOK_KEY,
    targetChains: [BOOK_KEY, "solana"],
    targets: {
      [BOOK_KEY]: { kind: "evm", chainId: CHAIN_ID, okuMoney: ADDR },
      solana: { kind: "svm", cluster: "devnet" },
    },
    expectedPreState: PRE_STATE,
    schedule: {
      rate: "1000000000158549",
      rateEnd: 2000,
      nextRate: "1000000000200000",
      nextRateEnd: 3000,
    },
    meta: {
      realisedYieldUsd: 40_000,
      conservativeFactor: 1,
      carryInUsd: 0,
      carryForwardUsd: 0,
      globalValueUsd: 10_000_000,
    },
    receipts: {},
    ...overrides,
  };
}

const ctx: NetworkContext = {
  networkName: BOOK_KEY,
  bookKey: BOOK_KEY,
  isFork: false,
  chainConfig: {} as any,
};

describe("scripts/operator/applyScheduleSingleChain", () => {
  const written: string[] = [];
  let calls: Array<Record<string, unknown>>;
  let applier: RateApplier;
  let envBackup: NodeJS.ProcessEnv;
  let argvBackup: string[];
  /** What the stubbed chain reports; tests mutate it. */
  let live: ChainState;
  let deps: ApplyDeps;

  beforeEach(() => {
    live = { chainId: CHAIN_ID, address: ADDR, schedule: { ...PRE_STATE } };
    deps = { readChain: async () => live, findTx: async () => "0xfound", nowSec: NOW };
    calls = [];
    applier = async (_c, _s, opts) => {
      calls.push({ ...opts });
      return {
        txHash: "0xdeadbeef",
        confirmedRate: opts.rate,
        confirmedPendingRate: opts.nextRate,
      };
    };
    envBackup = { ...process.env };
    argvBackup = [...process.argv];
  });

  afterEach(() => {
    for (const p of written) if (fs.existsSync(p)) fs.unlinkSync(p);
    written.length = 0;
    process.env = envBackup;
    process.argv = argvBackup;
  });

  function save(a: EpochScheduleArtifact): EpochScheduleArtifact {
    written.push(artifactPath(a.epochId, a.phase));
    saveArtifact(a);
    return a;
  }

  // ---------------------------------------------------------------- args

  describe("parseApplyArgs", () => {
    function setEnv(env: Record<string, string | undefined>) {
      // argv must be cleared too: parseArg checks `--flag=value` first, and
      // the mocha runner's own argv would otherwise leak into the lookup.
      process.argv = ["node", "test"];
      delete process.env.EPOCH_ID;
      delete process.env.PHASE;
      delete process.env.DRY_RUN;
      for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    }

    it("reads epochId, phase and dryRun from env", () => {
      setEnv({ EPOCH_ID: "2026-01", PHASE: "roll-epoch", DRY_RUN: "true" });
      expect(parseApplyArgs()).to.deep.equal({
        epochId: "2026-01",
        phase: "roll-epoch",
        dryRun: true,
      });
    });

    it("defaults dryRun to false when DRY_RUN is unset", () => {
      setEnv({ EPOCH_ID: "2026-01", PHASE: "stage-settlement" });
      expect(parseApplyArgs().dryRun).to.equal(false);
    });

    it("throws when epochId is missing", () => {
      setEnv({ PHASE: "roll-epoch" });
      expect(() => parseApplyArgs()).to.throw(/epochId/);
    });

    /**
     * The important one. `phase` must never default: the two phases carry
     * different schedules, so silently picking one would broadcast a
     * wrong-but-plausible rate to every chain rather than failing.
     */
    it("throws when phase is missing", () => {
      setEnv({ EPOCH_ID: "2026-01" });
      expect(() => parseApplyArgs()).to.throw(/phase/);
    });

    it("throws on an unrecognised phase rather than coercing it", () => {
      setEnv({ EPOCH_ID: "2026-01", PHASE: "settle" });
      expect(() => parseApplyArgs()).to.throw(/phase/);
    });

    /** Pins the camelCase -> SCREAMING_SNAKE contract the broadcaster relies on. */
    it("reads PHASE, not EPOCH_PHASE", () => {
      setEnv({ EPOCH_ID: "2026-01" });
      process.env.EPOCH_PHASE = "roll-epoch";
      expect(() => parseApplyArgs()).to.throw(/phase/);
    });
  });

  // ------------------------------------------------------------ dispatch

  it("applies the artifact's WAD integers verbatim and records the receipt", async () => {
    const a = save(makeArtifact());

    const outcome = await applyScheduleToChain(a, ctx, {} as any, false, applier, deps);

    expect(outcome).to.equal("recorded");
    expect(calls).to.have.lengthOf(1);
    expect(calls[0]).to.include({
      mode: "withSuccessor",
      rate: BigInt(a.schedule.rate),
      endTimestamp: BigInt(a.schedule.rateEnd),
      nextRate: BigInt(a.schedule.nextRate),
      pendingEndTimestamp: BigInt(a.schedule.nextRateEnd),
      dryRun: false,
    });

    const onDisk = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8"));
    expect(onDisk.receipts[BOOK_KEY].txHash).to.equal("0xdeadbeef");
    expect(onDisk.receipts[BOOK_KEY].confirmedAtSec).to.be.a("number");
    // Bound to the identity it was recorded against.
    expect(onDisk.receipts[BOOK_KEY].chainId).to.equal(CHAIN_ID);
    expect(onDisk.receipts[BOOK_KEY].address).to.equal(ADDR);
  });

  /**
   * Idempotency is load-bearing, not a nicety. `setOkuMYieldRateWithSuccessor`
   * re-anchors the multiplier from the current timestamp, so re-running a
   * partially-failed broadcast must not re-apply to chains that already
   * landed — applying twice is not a no-op.
   */
  it("skips a chain that already has a confirmed receipt, without calling the chain", async () => {
    const a = save(
      makeArtifact({
        receipts: { [BOOK_KEY]: { txHash: "0xalready", confirmedAtSec: 123, chainId: CHAIN_ID, address: ADDR } },
      })
    );

    const outcome = await applyScheduleToChain(a, ctx, {} as any, false, applier, deps);

    expect(outcome).to.equal("already-confirmed");
    expect(calls).to.have.lengthOf(0);

    const onDisk = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8"));
    expect(onDisk.receipts[BOOK_KEY].txHash).to.equal("0xalready");
    expect(onDisk.receipts[BOOK_KEY].confirmedAtSec).to.equal(123);
  });

  /**
   * A dry run must propagate the flag AND leave no receipt. Recording one
   * would make the next real broadcast skip the chain as already-applied —
   * a silent no-op on the chain that most needs the write.
   */
  it("propagates dryRun and writes no receipt", async () => {
    const a = save(makeArtifact());

    const outcome = await applyScheduleToChain(a, ctx, {} as any, true, applier, deps);

    expect(outcome).to.equal("dry-run");
    expect(calls[0].dryRun).to.equal(true);

    const onDisk = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8"));
    expect(onDisk.receipts).to.deep.equal({});
  });

  it("records 'unknown' rather than dropping the receipt when no txHash comes back", async () => {
    const a = save(makeArtifact());
    const noHash: RateApplier = async (_c, _s, opts) => ({
      confirmedRate: opts.rate,
      confirmedPendingRate: opts.nextRate,
    });

    await applyScheduleToChain(a, ctx, {} as any, false, noHash, deps);

    const onDisk = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8"));
    expect(onDisk.receipts[BOOK_KEY].txHash).to.equal("unknown");
  });

  /** Receipts are keyed by `bookKey`, not `networkName` — they differ on a fork. */
  it("keys the receipt by bookKey, so a fork run cannot mark the live chain applied", async () => {
    const a = save(makeArtifact());
    const forkCtx: NetworkContext = {
      networkName: BOOK_KEY,
      bookKey: `fork:${BOOK_KEY}`,
      isFork: true,
      chainConfig: {} as any,
    };

    await applyScheduleToChain(a, forkCtx, {} as any, false, applier, deps);

    const onDisk = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8"));
    expect(onDisk.receipts).to.have.property(`fork:${BOOK_KEY}`);
    expect(onDisk.receipts).to.not.have.property(BOOK_KEY);
  });

  // ------------------------------------------------- binding / recovery

  /** Explicit rejection capture (no chai-as-promised in this package). */
  async function rejection(p: Promise<unknown>): Promise<Error> {
    try {
      await p;
    } catch (e: any) {
      return e;
    }
    throw new Error("expected the promise to reject, but it resolved");
  }

  it("refuses a saved receipt recorded for a different chainId/address (and does not re-apply)", async () => {
    const a = save(
      makeArtifact({ receipts: { [BOOK_KEY]: { txHash: "0xother", confirmedAtSec: 1, chainId: 1, address: ADDR } } })
    );
    const err = await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps));
    expect(err.message).to.match(/Refusing to honour/);
    expect(calls).to.have.lengthOf(0);
  });

  it("refuses a legacy receipt with no recorded identity", async () => {
    const a = save(makeArtifact({ receipts: { [BOOK_KEY]: { txHash: "0xlegacy", confirmedAtSec: 1 } } }));
    expect((await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps))).message).to.match(
      /Refusing to honour/
    );
  });

  it("refuses on a chainId mismatch", async () => {
    live.chainId = 1;
    const a = save(makeArtifact());
    expect((await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps))).message).to.match(
      /identity mismatch/
    );
    expect(calls).to.have.lengthOf(0);
  });

  it("refuses on an OkuMoney address mismatch (address book changed since derivation)", async () => {
    live.address = "0x00000000000000000000000000000000000000Bb";
    const a = save(makeArtifact());
    expect((await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps))).message).to.match(
      /identity mismatch/
    );
    expect(calls).to.have.lengthOf(0);
  });

  it("accepts an address that differs only in checksum case", async () => {
    live.address = ADDR.toLowerCase();
    const a = save(makeArtifact());
    expect(await applyScheduleToChain(a, ctx, {} as any, false, applier, deps)).to.equal("recorded");
  });

  it("refuses an expired artifact", async () => {
    const a = save(makeArtifact({ expiresAtSec: NOW - 1 }));
    expect((await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps))).message).to.match(
      /EXPIRED/
    );
    expect(calls).to.have.lengthOf(0);
  });

  it("refuses a chain that is not a committed target", async () => {
    const a = save(makeArtifact({ targetChains: ["solana"], targets: { solana: { kind: "svm", cluster: "devnet" } } }));
    expect((await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps))).message).to.match(
      /not an EVM target committed/
    );
  });

  it("refuses a version-1 (unbound) artifact", async () => {
    const legacy = { ...makeArtifact(), artifactVersion: 1 } as any;
    delete legacy.targetChains;
    expect((await rejection(applyScheduleToChain(legacy, ctx, {} as any, false, applier, deps))).message).to.match(
      /Re-derive/
    );
  });

  it("refuses when the on-chain schedule moved since derivation", async () => {
    live.schedule.pendingRate = "1000000000999999999";
    const a = save(makeArtifact());
    const err = await rejection(applyScheduleToChain(a, ctx, {} as any, false, applier, deps));
    expect(err.message).to.match(/expected pre-state/);
    expect(err.message).to.match(/pendingRate/);
    expect(calls).to.have.lengthOf(0);
  });

  it("compares anchor fields on the reference chain only", async () => {
    live.schedule.lastAccrualTime = 901; // a re-anchor happened since derivation
    const ref = save(makeArtifact());
    expect((await rejection(applyScheduleToChain(ref, ctx, {} as any, false, applier, deps))).message).to.match(
      /lastAccrualTime/
    );
    // On a non-reference chain the anchor legitimately differs (own block.timestamp).
    const other = save(makeArtifact({ referenceChain: "baseSepolia" }));
    expect(await applyScheduleToChain(other, ctx, {} as any, false, applier, deps)).to.equal("recorded");
  });

  it("recovers (records, does not resend) when the chain already carries the target schedule", async () => {
    const a = save(makeArtifact());
    live.schedule = {
      ...live.schedule,
      rate: a.schedule.rate,
      rateEnd: a.schedule.rateEnd,
      pendingRate: a.schedule.nextRate,
      pendingRateEnd: a.schedule.nextRateEnd,
    };
    const outcome = await applyScheduleToChain(a, ctx, {} as any, false, applier, deps);
    expect(outcome).to.equal("recovered");
    expect(calls, "must not resend — a resend re-anchors at a later timestamp").to.have.lengthOf(0);
    const r = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8")).receipts[BOOK_KEY];
    expect(r).to.include({ txHash: "0xfound", recovered: true, chainId: CHAIN_ID, address: ADDR });
  });

  it("marks a recovered receipt <already-applied> when the tx cannot be located", async () => {
    const a = save(makeArtifact());
    live.schedule = { ...live.schedule, rate: a.schedule.rate, rateEnd: a.schedule.rateEnd, pendingRate: a.schedule.nextRate, pendingRateEnd: a.schedule.nextRateEnd };
    await applyScheduleToChain(a, ctx, {} as any, false, applier, { ...deps, findTx: async () => undefined });
    const r = JSON.parse(fs.readFileSync(artifactPath(a.epochId, a.phase), "utf-8")).receipts[BOOK_KEY];
    expect(r.txHash).to.equal(ALREADY_APPLIED);
  });
});
