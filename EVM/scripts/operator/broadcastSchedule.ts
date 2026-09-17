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
import { runMain, parseArg, isDryRun } from "../utils/cli";
import { CHAIN_METADATA } from "../config/chains";
import { loadArtifact, saveArtifactInPlace, EpochScheduleArtifact } from "./deriveEpochSchedule";
import { upsertLedgerEntry, buildLedgerEntry } from "../utils/carryLedger";

const SVM_CHAIN_KEY = "solana";

function targets(): string[] {
  return [...Object.keys(CHAIN_METADATA), SVM_CHAIN_KEY];
}

function alreadyConfirmed(artifact: EpochScheduleArtifact, chain: string): boolean {
  const r = artifact.receipts[chain];
  return !!r && "txHash" in r;
}

function applyToEvmChain(chainName: string, epochId: string, dryRun: boolean): void {
  const args = [
    "hardhat",
    "run",
    "scripts/operator/applyScheduleSingleChain.ts",
    "--network",
    chainName,
  ];
  const env = { ...process.env, EPOCH_ID: epochId, ...(dryRun ? { DRY_RUN: "true" } : {}) };
  logger.info(`[${chainName}] npx ${args.join(" ")} --epochId=${epochId}`);
  execFileSync("npx", [...args], {
    cwd: path.join(__dirname, "../.."),
    env,
    stdio: "inherit",
    // parseArg reads process.argv OR env; applyScheduleSingleChain reads
    // EPOCH_ID via the env var above (cli.ts's parseArg checks both forms).
  });
}

function applyToSvm(epochId: string, dryRun: boolean): void {
  const artifact = loadArtifact(epochId);
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
  const env = {
    ...process.env,
    NETWORK: process.env.SVM_NETWORK ?? "devnet",
    ...(dryRun ? { DRY_RUN: "true" } : {}),
  };
  logger.info(`[solana] npx ${args.join(" ")} (cwd=${svmDir})`);
  execFileSync("npx", args, { cwd: svmDir, env, stdio: "inherit" });

  if (!dryRun) {
    artifact.receipts[SVM_CHAIN_KEY] = { txHash: "see-svm-log-above", confirmedAtSec: Math.floor(Date.now() / 1000) };
    saveArtifactInPlace(artifact);
  }
}

export async function broadcastArtifact(epochId: string, dryRun: boolean): Promise<void> {
  let artifact = loadArtifact(epochId);
  logger.header(`Broadcasting epoch ${epochId} (${artifact.phase})`);
  logger.info(`rate=${artifact.schedule.rate} end=${artifact.schedule.rateEnd}`);
  logger.info(`nextRate=${artifact.schedule.nextRate} nextEnd=${artifact.schedule.nextRateEnd}`);

  const failures: string[] = [];
  for (const chain of targets()) {
    artifact = loadArtifact(epochId); // re-read: the subprocess just mutated it
    if (alreadyConfirmed(artifact, chain)) {
      logger.info(`[${chain}] already confirmed — skipping`);
      continue;
    }
    try {
      if (chain === SVM_CHAIN_KEY) applyToSvm(epochId, dryRun);
      else applyToEvmChain(chain, epochId, dryRun);
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
  artifact = loadArtifact(epochId);
  if (artifact.phase === "roll-epoch") {
    const entry = buildLedgerEntry({
      epochId: artifact.epochId,
      realisedYieldUsd: artifact.meta.realisedYieldUsd,
      carryInUsd: artifact.meta.carryInUsd,
      measuredAvgValueUsd: artifact.meta.globalValueUsd,
      conservativeFactor: artifact.meta.conservativeFactor,
      result: { ratePerSecond: BigInt(artifact.schedule.nextRate), carryForwardUsd: artifact.meta.carryForwardUsd },
    });
    upsertLedgerEntry(entry);
    logger.success(`Carry ledger updated for epochId=${epochId} (once, keyed by epochId)`);
  }

  logger.success(`All ${targets().length} chains confirmed for epoch ${epochId}`);
}

if (require.main === module) {
  runMain(async () => {
    const epochId = parseArg("epochId");
    if (!epochId) throw new Error("Required: --epochId=<id> matching a saved artifact");
    await broadcastArtifact(epochId, isDryRun());
  });
}
