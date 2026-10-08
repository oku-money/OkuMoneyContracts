/**
 * Fan one epoch-schedule artifact out to every EVM chain and SVM.
 *
 * Reads the artifact `deriveEpochSchedule.ts` wrote — one derivation, one set
 * of WAD integers — and applies it everywhere. Each EVM chain is a subprocess
 * (`applyScheduleSingleChain.ts --network <chain>`), because Hardhat's
 * `network` runtime binds to the process at startup and cannot be redirected
 * mid-run. SVM is a subprocess into its own Anchor workspace, for the same
 * reason but a different toolchain: it needs `anchor.workspace.LitePsm`, its
 * own provider, and a Solana keypair, none of which this Hardhat process has.
 *
 * Resumable by design: each chain's outcome is written back into the
 * artifact's `receipts` map as it confirms (by the subprocess itself). Re-runs
 * re-read the artifact and SKIP any chain with a successful receipt, so a
 * partial failure is recoverable by re-running the same command.
 *
 * The target set is the artifact's COMMITTED `targetChains` (fixed at
 * derivation), never re-resolved here: a `CHAINS` env that differs from it is
 * refused, so a re-run cannot quietly drop a failed chain and finalize.
 *
 * The carry ledger is written HERE, once — not in `deriveEpochSchedule.ts`,
 * and not per chain. It fires only once EVERY committed target (EVM and SVM)
 * has a receipt for a `roll-epoch` artifact: one epoch, one ledger entry.
 */

import { execFileSync } from "child_process";
import * as path from "path";
import { logger } from "../utils/logger";
import { runMain, parseArg, isDryRun, isYesMainnet } from "../utils/cli";
import {
  loadArtifact,
  saveArtifactInPlace,
  assertArtifactBound,
  assertNotExpired,
  isConfirmedReceipt,
  preStateMismatches,
  scheduleMatchesTarget,
  ALREADY_APPLIED,
  EpochScheduleArtifact,
  EpochPhase,
  ScheduleFields,
} from "../utils/epochArtifact";
import { upsertLedgerEntry, buildLedgerEntry, backfillReconciliation } from "../utils/carryLedger";
import {
  participatingChains,
  parseChainsEnv,
  sameChainSet,
  svmReadConfigured,
  SVM_CHAIN_KEY,
} from "../config/epochChains";
import { readSvmSchedule } from "../utils/svmValue";

// NOTE: must NOT import anything from `deriveEpochSchedule.ts` (which pulls in
// `ethers` from `"hardhat"`) — this driver runs standalone under plain `tsx`,
// spawning per-chain `hardhat run` subprocesses itself.

/**
 * How this driver launches each per-chain subprocess.
 *
 * Injectable ONLY so the subprocess boundary is testable. That boundary is a
 * contract between this file (which sets env vars) and
 * `applyScheduleSingleChain.ts` (which reads them via `cli.ts::parseArg`), and
 * cannot be verified by reading either file alone: `parseArg("phase")` derives
 * the env name `PHASE` by a camelCase→SCREAMING_SNAKE transform written down
 * at neither end. Set `PHASE`, not `EPOCH_PHASE`.
 */
export type SubprocessRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => string;

const defaultRunner: SubprocessRunner = (command, args, opts) => {
  // stdout is captured rather than inherited so the SVM signature can be
  // recorded as a real receipt; it is echoed so the operator still sees the
  // subprocess live. stderr stays inherited for prompts and errors.
  const out = execFileSync(command, args, {
    ...opts,
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  process.stdout.write(out);
  return out;
};

/** Reads SVM's current schedule fields, or `null` when it cannot be read
 *  (unconfigured). Injectable for tests. */
export type SvmScheduleReader = () => Promise<ScheduleFields | null>;

/** Default SVM reader: `svmValue.ts::readSvmSchedule` when the SVM read env
 *  (SVM_RPC_URL, SVM_LITE_PSM_PROGRAM_ID, SVM_OKU_M_MINT) is set, else `null`.
 *  A configured-but-failing read throws. */
const defaultSvmReader: SvmScheduleReader = async () => {
  if (!svmReadConfigured()) return null;
  const reading = await readSvmSchedule(
    process.env.SVM_RPC_URL!,
    process.env.SVM_LITE_PSM_PROGRAM_ID!,
    process.env.SVM_OKU_M_MINT!
  );
  if (!reading) throw new Error("SVM schedule read returned nothing (PsmConfig missing or layout changed)");
  const s = reading.schedule;
  return {
    rate: s.ratePerSecond.toString(),
    rateEnd: Number(s.rateEnd),
    pendingRate: s.pendingRatePerSecond.toString(),
    pendingRateEnd: Number(s.pendingRateEnd),
  };
};

export interface BroadcastOpts {
  epochId: string;
  phase: EpochPhase;
  dryRun: boolean;
  /** Optional `CHAINS` scope. Must name exactly the artifact's committed
   *  `targetChains` (any order) or the broadcast is refused; the committed
   *  set is what is actually used. */
  chains?: string[];
  /** Second gate on including a mainnet in the epoch SCOPE — see
   *  `config/epochChains.ts`. Defaults to `isYesMainnet()`. */
  yesMainnet?: boolean;
  /** Test seam — see {@link SubprocessRunner}. */
  run?: SubprocessRunner;
  /** Test seam: override the carry-ledger path so tests don't touch the
   *  operator's real local ledger. */
  ledgerPath?: string;
  /** Test seam — see {@link SvmScheduleReader}. */
  readSvm?: SvmScheduleReader;
  /** Test seam: wall-clock seconds for the expiry check. */
  nowSec?: number;
}

/**
 * The committed target set, re-validated (unknown names, mainnet gate) and
 * cross-checked against an explicit `CHAINS` scope, which must be the same set.
 */
function targets(artifact: EpochScheduleArtifact, chains: string[] | undefined, yesMainnet: boolean): string[] {
  if (chains) {
    participatingChains({ requested: chains, yesMainnet }); // validation only
    if (!sameChainSet(chains, artifact.targetChains)) {
      throw new Error(
        `CHAINS=${chains.join(",")} differs from the artifact's committed target set ` +
          `[${artifact.targetChains.join(", ")}]. The target set is fixed at derivation; ` +
          "unset CHAINS (or pass exactly that set), or re-derive with a different scope."
      );
    }
  }
  return participatingChains({ requested: [...artifact.targetChains], yesMainnet });
}

/**
 * A receipt counts only if it was recorded for the identity the artifact
 * committed for that chain (EVM: chainId + OkuMoney address; SVM: cluster,
 * plus program id when both sides recorded one). An unmatched receipt is not
 * honoured: the chain is re-dispatched, and the EVM child refuses on the
 * identity mismatch rather than re-applying blindly.
 */
function alreadyConfirmed(artifact: EpochScheduleArtifact, chain: string): boolean {
  const r = artifact.receipts[chain];
  if (!isConfirmedReceipt(r)) return false;
  const t = artifact.targets[chain];
  if (!t) return false;
  if (t.kind === "evm") {
    return r.chainId === t.chainId && !!r.address && r.address.toLowerCase() === t.okuMoney.toLowerCase();
  }
  return r.cluster === t.cluster && (!t.programId || !r.address || r.address === t.programId);
}

function applyToEvmChain(
  chainName: string,
  epochId: string,
  phase: EpochPhase,
  dryRun: boolean,
  run: SubprocessRunner
): void {
  const args = [
    "hardhat",
    "run",
    "scripts/operator/applyScheduleSingleChain.ts",
    "--network",
    chainName,
  ];
  // Env, not argv — `hardhat run` rejects unrecognised flags (HH305/HH310);
  // see cli.ts's module doc. The names below MUST be exactly what
  // `parseArg("epochId")` / `parseArg("phase")` resolve to in the child:
  // EPOCH_ID and PHASE respectively.
  const env = {
    ...process.env,
    EPOCH_ID: epochId,
    PHASE: phase,
    ...(dryRun ? { DRY_RUN: "true" } : {}),
  };
  logger.info(`[${chainName}] EPOCH_ID=${epochId} PHASE=${phase} npx ${args.join(" ")}`);
  run("npx", [...args], { cwd: path.join(__dirname, "../.."), env });
}

/**
 * SVM leg. Checks made HERE, before spawning, because the SVM child
 * (`SVM/oku-programs/scripts/admin/set-yield-rate.ts`) takes only the schedule
 * integers and verifies none of: expiry, cluster/program identity, or that
 * the on-chain schedule still equals the artifact's pre-state.
 *
 *   - expiry: always enforced;
 *   - cluster: the cluster we would pass (`SVM_NETWORK`, default devnet) must
 *     equal the committed one; program id: if both the artifact and
 *     `SVM_LITE_PSM_PROGRAM_ID` carry one they must match. NOTE the child
 *     resolves the program from its OWN deployment record, not this env var,
 *     so this is a consistency check on the operator's env, not a binding of
 *     what the child will call;
 *   - pre-state / already-applied: only when the SVM read env is configured
 *     (`readSvm` returns non-null). Then an SVM already at the target gets a
 *     `recovered` receipt and NO resend, and an SVM at neither the pre-state
 *     nor the target is refused. When it is NOT configured, SVM pre-state is
 *     UNVERIFIED (warned) — set SVM_RPC_URL / SVM_LITE_PSM_PROGRAM_ID /
 *     SVM_OKU_M_MINT to close that gap.
 * Anchor fields (base multiplier / last accrual time) are never compared on
 * SVM: it is never the reference chain.
 */
async function applyToSvm(
  epochId: string,
  phase: EpochPhase,
  dryRun: boolean,
  run: SubprocessRunner,
  readSvm: SvmScheduleReader,
  nowSec: number | undefined
): Promise<void> {
  const artifact = loadArtifact(epochId, phase);
  const target = artifact.targets[SVM_CHAIN_KEY];
  if (!target || target.kind !== "svm") throw new Error("artifact has no SVM target identity");
  assertNotExpired(artifact, nowSec);

  const cluster = process.env.SVM_NETWORK ?? "devnet";
  if (cluster !== target.cluster) {
    throw new Error(`SVM cluster mismatch: artifact bound ${target.cluster}, SVM_NETWORK resolves to ${cluster}`);
  }
  const envProgram = process.env.SVM_LITE_PSM_PROGRAM_ID;
  if (target.programId && envProgram && envProgram !== target.programId) {
    throw new Error(
      `SVM program mismatch: artifact bound ${target.programId}, SVM_LITE_PSM_PROGRAM_ID=${envProgram}`
    );
  }

  const live = await readSvm();
  if (live === null) {
    logger.warning(
      "[solana] SVM read env not configured — cannot verify SVM's pre-state or detect an " +
        "already-applied schedule before sending (the SVM child does not verify either)."
    );
  } else if (scheduleMatchesTarget(live, artifact)) {
    if (dryRun) {
      logger.success("[solana] DRY_RUN — schedule already at target; would record a recovered receipt");
      return;
    }
    artifact.receipts[SVM_CHAIN_KEY] = {
      txHash: ALREADY_APPLIED,
      confirmedAtSec: Math.floor(Date.now() / 1000),
      cluster: target.cluster,
      ...(target.programId ? { address: target.programId } : {}),
      recovered: true,
    };
    saveArtifactInPlace(artifact);
    logger.success("[solana] schedule already at target — recovered receipt recorded, nothing resent");
    return;
  } else {
    const mismatches = preStateMismatches(live, artifact, false);
    if (mismatches.length > 0) {
      throw new Error(
        `SVM schedule no longer matches the artifact's expected pre-state (nor its target): ` +
          `${mismatches.join("; ")}. Re-derive.`
      );
    }
  }

  const svmDir = path.join(__dirname, "../../../SVM/oku-programs");
  const args = [
    "tsx",
    "scripts/admin/set-yield-rate.ts",
    "--mode=atomic",
    `--rate=${artifact.schedule.rate}`,
    `--end=${artifact.schedule.rateEnd}`,
    `--next-rate=${artifact.schedule.nextRate}`,
    `--next-end=${artifact.schedule.nextRateEnd}`,
  ];
  // The SVM script's mainnet opt-in is argv-only; forward YES_MAINNET so a
  // confirmed EVM broadcast does not stall on (or abort at) the SVM prompt.
  if (isYesMainnet()) args.push("--yes-i-mean-it-on-mainnet");
  // SVM's set-yield-rate.ts parses argv ONLY (its own local parseArg, not
  // cli.ts's) — hence flags above rather than env vars here.
  const env = {
    ...process.env,
    NETWORK: process.env.SVM_NETWORK ?? "devnet",
    ...(dryRun ? { DRY_RUN: "true" } : {}),
  };
  logger.info(`[solana] npx ${args.join(" ")} (cwd=${svmDir})`);
  const out = run("npx", args, { cwd: svmDir, env });

  if (!dryRun) {
    // Record the REAL signature, never a placeholder: a placeholder makes
    // `alreadyConfirmed` true for any exit-0 run, including one that never
    // submitted, permanently skipping SVM on re-run.
    const sig = /\btx:\s*([1-9A-HJ-NP-Za-km-z]{64,88})\b/.exec(out ?? "")?.[1];
    if (!sig) {
      throw new Error(
        "SVM subprocess exited 0 but printed no transaction signature — refusing " +
          "to record a receipt. Re-run; if it keeps happening, check the SVM log above."
      );
    }
    artifact.receipts[SVM_CHAIN_KEY] = {
      txHash: sig,
      confirmedAtSec: Math.floor(Date.now() / 1000),
      cluster: target.cluster,
      ...(target.programId ? { address: target.programId } : {}),
    };
    saveArtifactInPlace(artifact);
  }
}

/**
 * Apply one derived artifact to every committed target chain (EVM, then SVM),
 * skipping chains that already have a receipt, and finalize the carry ledger
 * only once every target is confirmed.
 */
export async function broadcastArtifact(opts: BroadcastOpts): Promise<void> {
  const { epochId, phase, dryRun } = opts;
  const run = opts.run ?? defaultRunner;
  const yesMainnet = opts.yesMainnet ?? isYesMainnet();

  const readSvm = opts.readSvm ?? defaultSvmReader;

  let artifact = loadArtifact(epochId, phase);
  assertArtifactBound(artifact);
  logger.header(`Broadcasting epoch ${epochId} (${artifact.phase})`);
  logger.info(`rate=${artifact.schedule.rate} end=${artifact.schedule.rateEnd}`);
  logger.info(`nextRate=${artifact.schedule.nextRate} nextEnd=${artifact.schedule.nextRateEnd}`);

  const chainList = targets(artifact, opts.chains, yesMainnet);
  logger.info(`Committed targets: ${chainList.join(", ")}`);
  // Refuse to start SUBMITTING from an expired artifact; finalizing one whose
  // targets have all already confirmed is still allowed.
  if (chainList.some((c) => !alreadyConfirmed(artifact, c))) assertNotExpired(artifact, opts.nowSec);

  const failures: string[] = [];
  for (const chain of chainList) {
    artifact = loadArtifact(epochId, phase); // re-read: the subprocess just mutated it
    if (alreadyConfirmed(artifact, chain)) {
      logger.info(`[${chain}] already confirmed — skipping`);
      continue;
    }
    try {
      if (chain === SVM_CHAIN_KEY) await applyToSvm(epochId, phase, dryRun, run, readSvm, opts.nowSec);
      else applyToEvmChain(chain, epochId, phase, dryRun, run);
      logger.success(`[${chain}] done`);
    } catch (e: any) {
      logger.error(`[${chain}] FAILED: ${e.message ?? e}`);
      failures.push(chain);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Broadcast incomplete: ${failures.join(", ")} failed. Re-run this command — ` +
        `chains that already confirmed will be skipped.`
    );
  }
  if (dryRun) {
    logger.success("DRY_RUN — carry ledger not updated");
    return;
  }

  // Finalize only when EVERY committed target has a receipt (bound to its
  // committed identity). A subprocess exiting 0 is not proof of a receipt.
  artifact = loadArtifact(epochId, phase);
  const missing = artifact.targetChains.filter((c) => !alreadyConfirmed(artifact, c));
  if (missing.length > 0) {
    throw new Error(
      `Broadcast incomplete: no receipt for committed target(s) ${missing.join(", ")}. ` +
        "Not finalizing (carry ledger untouched); re-run this command."
    );
  }

  // Carry ledger: written exactly once, here, only for roll-epoch artifacts —
  // stage-settlement doesn't close an epoch, so it has nothing to record.
  if (artifact.phase === "roll-epoch") {
    // Backfill the PRIOR epoch's reconciliation FIRST — deriveRollEpoch
    // computed it (ex-post reconcileActualPayout) and threaded it into THIS
    // artifact's carryInUsd; it belongs on the prior entry, not this one. Do
    // not conflate it with the new entry's own carryForwardUsd.
    if (artifact.meta.priorEpochId) {
      backfillReconciliation(artifact.meta.priorEpochId, artifact.meta.carryInUsd, opts.ledgerPath);
      logger.success(
        `Backfilled reconciliation for epochId=${artifact.meta.priorEpochId}: $${artifact.meta.carryInUsd.toFixed(2)}`
      );
    }

    const entry = buildLedgerEntry({
      epochId: artifact.epochId,
      realisedYieldUsd: artifact.meta.realisedYieldUsd,
      carryInUsd: artifact.meta.carryInUsd,
      measuredAvgValueUsd: artifact.meta.globalValueUsd,
      conservativeFactor: artifact.meta.conservativeFactor,
      result: { ratePerSecond: BigInt(artifact.schedule.nextRate), carryForwardUsd: artifact.meta.carryForwardUsd },
      epochStartMultiplier: artifact.meta.epochStartMultiplier,
    });
    upsertLedgerEntry(entry, opts.ledgerPath);
    logger.success(`Carry ledger entry written for epochId=${epochId} (reconciliation pending until next roll)`);
  }

  logger.success(`All ${chainList.length} chains confirmed for epoch ${epochId}`);
}

if (require.main === module) {
  runMain(async () => {
    const epochId = parseArg("epochId");
    const phase = parseArg("phase") as EpochPhase | undefined;
    if (!epochId) throw new Error("Required: --epochId=<id> matching a saved artifact (env: EPOCH_ID)");
    if (phase !== "stage-settlement" && phase !== "roll-epoch") {
      throw new Error("Required: --phase=stage-settlement|roll-epoch matching the saved artifact (env: PHASE)");
    }
    await broadcastArtifact({
      epochId,
      phase,
      dryRun: isDryRun(),
      chains: parseChainsEnv(parseArg("chains")),
    });
  });
}
