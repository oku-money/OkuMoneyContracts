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
 * ## Resumable by design
 *
 * Each chain's outcome is written back into the artifact's `receipts` map as
 * it confirms (by the subprocess itself, since it has the artifact-writing
 * helpers available). Re-running this driver re-reads the artifact and SKIPS
 * any chain with a successful receipt already recorded, so a partial failure
 * — one chain down, one RPC timeout — is recoverable by re-running the same
 * command.
 *
 * ## The carry ledger is written HERE, once
 *
 * Not in `deriveEpochSchedule.ts`, and not per chain. It fires exactly once,
 * after every chain (EVM and SVM) has a successful receipt for a `roll-epoch`
 * artifact — one epoch, one ledger entry, rather than one per chain-run.
 */

import { execFileSync } from "child_process";
import * as path from "path";
import { logger } from "../utils/logger";
import { runMain, parseArg, isDryRun, isYesMainnet } from "../utils/cli";
import { loadArtifact, saveArtifactInPlace, EpochScheduleArtifact, EpochPhase } from "../utils/epochArtifact";
import { upsertLedgerEntry, buildLedgerEntry, backfillReconciliation } from "../utils/carryLedger";
import { participatingChains, parseChainsEnv, SVM_CHAIN_KEY } from "../config/epochChains";

// NOTE: intentionally does NOT import anything from `deriveEpochSchedule.ts`
// (which pulls in `ethers` from `"hardhat"`) — this driver must run standalone
// under plain `tsx`, spawning per-chain `hardhat run` subprocesses itself. See
// `epochArtifact.ts`'s module doc for the full rationale.

/**
 * How this driver launches each per-chain subprocess.
 *
 * Injectable ONLY so the subprocess boundary is testable. That boundary is
 * not incidental detail — it is a contract between this file (which sets env
 * vars) and `applyScheduleSingleChain.ts` (which reads them via
 * `cli.ts::parseArg`), and it is impossible to verify by reading either file
 * alone: `parseArg("phase")` derives the env name `PHASE` by a
 * camelCase→SCREAMING_SNAKE transform that is not written down at either end.
 *
 * This driver originally set `EPOCH_PHASE`, which `parseArg("phase")` never
 * reads — so every EVM chain's subprocess aborted with "Required: --phase".
 * It appeared to work only when the operator happened to invoke the broadcaster
 * with `PHASE=` in the environment, which then leaked through `...process.env`
 * below. Nothing caught it because nothing executed this function.
 */
export type SubprocessRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => void;

const defaultRunner: SubprocessRunner = (command, args, opts) => {
  execFileSync(command, args, { ...opts, stdio: "inherit" });
};

export interface BroadcastOpts {
  epochId: string;
  phase: EpochPhase;
  dryRun: boolean;
  /** Explicit chain scope; defaults to `participatingChains()`. */
  chains?: string[];
  /** Second gate on including a mainnet in the epoch SCOPE — see
   *  `config/epochChains.ts`. Defaults to `isYesMainnet()`. */
  yesMainnet?: boolean;
  /** Test seam — see {@link SubprocessRunner}. */
  run?: SubprocessRunner;
  /** Test seam: override the carry-ledger path so tests don't touch the
   *  operator's real local ledger. */
  ledgerPath?: string;
}

function targets(chains: string[] | undefined, yesMainnet: boolean): string[] {
  // Single source of truth shared with the V̄ sampler — see
  // `config/epochChains.ts`'s module doc for why these must never diverge.
  return participatingChains({ requested: chains, yesMainnet });
}

function alreadyConfirmed(artifact: EpochScheduleArtifact, chain: string): boolean {
  const r = artifact.receipts[chain];
  return !!r && "txHash" in r;
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
  // EPOCH_ID and PHASE respectively. See SubprocessRunner's doc for the bug
  // that got this wrong, and `broadcastSchedule.test.ts` for the test that
  // now pins it.
  const env = {
    ...process.env,
    EPOCH_ID: epochId,
    PHASE: phase,
    ...(dryRun ? { DRY_RUN: "true" } : {}),
  };
  logger.info(`[${chainName}] EPOCH_ID=${epochId} PHASE=${phase} npx ${args.join(" ")}`);
  run("npx", [...args], { cwd: path.join(__dirname, "../.."), env });
}

function applyToSvm(epochId: string, phase: EpochPhase, dryRun: boolean, run: SubprocessRunner): void {
  const artifact = loadArtifact(epochId, phase);
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
  // SVM's set-yield-rate.ts parses argv ONLY (its own local parseArg, not
  // cli.ts's) — hence flags above rather than env vars here.
  const env = {
    ...process.env,
    NETWORK: process.env.SVM_NETWORK ?? "devnet",
    ...(dryRun ? { DRY_RUN: "true" } : {}),
  };
  logger.info(`[solana] npx ${args.join(" ")} (cwd=${svmDir})`);
  run("npx", args, { cwd: svmDir, env });

  if (!dryRun) {
    artifact.receipts[SVM_CHAIN_KEY] = { txHash: "see-svm-log-above", confirmedAtSec: Math.floor(Date.now() / 1000) };
    saveArtifactInPlace(artifact);
  }
}

export async function broadcastArtifact(opts: BroadcastOpts): Promise<void> {
  const { epochId, phase, dryRun } = opts;
  const run = opts.run ?? defaultRunner;
  const yesMainnet = opts.yesMainnet ?? isYesMainnet();

  let artifact = loadArtifact(epochId, phase);
  logger.header(`Broadcasting epoch ${epochId} (${artifact.phase})`);
  logger.info(`rate=${artifact.schedule.rate} end=${artifact.schedule.rateEnd}`);
  logger.info(`nextRate=${artifact.schedule.nextRate} nextEnd=${artifact.schedule.nextRateEnd}`);

  const chainList = targets(opts.chains, yesMainnet);
  const failures: string[] = [];
  for (const chain of chainList) {
    artifact = loadArtifact(epochId, phase); // re-read: the subprocess just mutated it
    if (alreadyConfirmed(artifact, chain)) {
      logger.info(`[${chain}] already confirmed — skipping`);
      continue;
    }
    try {
      if (chain === SVM_CHAIN_KEY) applyToSvm(epochId, phase, dryRun, run);
      else applyToEvmChain(chain, epochId, phase, dryRun, run);
      logger.success(`[${chain}] confirmed`);
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

  // Carry ledger: written exactly once, here, only for roll-epoch artifacts —
  // stage-settlement doesn't close an epoch, so it has nothing to record.
  artifact = loadArtifact(epochId, phase);
  if (artifact.phase === "roll-epoch") {
    // Backfill the PRIOR epoch's reconciliation FIRST — deriveRollEpoch
    // computed it (ex-post reconcileActualPayout) and threaded it into THIS
    // artifact's carryInUsd; it belongs on the prior entry, not this one. See
    // carryLedger.ts's module doc for why conflating this with the new
    // entry's own carryForwardUsd was defect #3 in the deploy-readiness audit.
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
