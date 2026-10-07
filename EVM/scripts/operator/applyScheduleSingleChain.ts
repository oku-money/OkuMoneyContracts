/**
 * Apply one epoch-schedule artifact's WAD integers to whichever EVM chain
 * this process is bound to.
 *
 * Separate from `broadcastSchedule.ts` because Hardhat's `network` runtime is
 * bound to the process at `hardhat run --network <chain>` and cannot be
 * redirected mid-process (`resolveNetworkContext()` reads that binding, it
 * does not accept a chain name). Broadcasting to N chains is therefore N
 * subprocess invocations of THIS file, one per `--network`, orchestrated by
 * `broadcastSchedule.ts`.
 *
 * Usage:
 *   NETWORK=base EPOCH_ID=2026-01 PHASE=roll-epoch npx hardhat run \
 *     scripts/operator/applyScheduleSingleChain.ts --network base
 *
 * The work is split into two exported, Hardhat-free functions — `parseApplyArgs`
 * and `applyScheduleToChain` — with the Hardhat-bound wiring confined to the
 * `require.main` block. That split exists so the control flow around the chain
 * write is testable: argument validation, the already-confirmed early return,
 * the dry-run path and the receipt write-back are the parts that have broken
 * before, and none of them need a network to exercise. Same reasoning as
 * `broadcastSchedule.ts`'s injectable `SubprocessRunner`.
 *
 * Pre-submission checks (all refuse rather than submit):
 *   - the artifact is bound (version 2) and this chain is a committed target;
 *   - the bound chain's live `chainId` and the OkuMoney address this process
 *     would call equal the artifact's recorded identity;
 *   - the artifact has not expired (`expiresAtSec`, wall clock);
 *   - the live schedule equals the artifact's expected pre-state (rate,
 *     rateEnd, pendingRate, pendingRateEnd everywhere; plus baseMultiplier and
 *     lastAccrualTime on the reference chain, the only chain whose anchors
 *     were observed) — OR already equals the artifact's TARGET, in which case
 *     a prior run's tx landed without its receipt being persisted, and the
 *     receipt is recovered instead of re-sending (a resend would re-anchor at
 *     a later timestamp).
 * A saved receipt is only honoured if recorded for the same chainId+address.
 */

import { ethers, Signer } from "ethers";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { isYesMainnet, isDryRun, parseArg, runMain } from "../utils/cli";
import { loadAddress } from "../utils/addressBook";
import { runSetOkuMYieldRate } from "./setOkuMYieldRate";
import type { SetOkuMYieldRateResult } from "./setOkuMYieldRate";
import type { NetworkContext } from "../utils/networkContext";
import {
  loadArtifact,
  saveArtifactInPlace,
  assertArtifactBound,
  assertNotExpired,
  isConfirmedReceipt,
  preStateMismatches,
  scheduleMatchesTarget,
  ALREADY_APPLIED,
  EpochPhase,
  EpochScheduleArtifact,
  OnChainSchedule,
} from "../utils/epochArtifact";

export { ALREADY_APPLIED };

/** Live identity + schedule of the chain this process is bound to. */
export interface ChainState {
  chainId: number;
  /** The OkuMoney address this process would submit to (`ctx.bookKey`'s entry). */
  address: string;
  schedule: OnChainSchedule;
}

/** Reads {@link ChainState}; injectable for tests. */
export type ChainStateReader = (ctx: NetworkContext, signer: Signer) => Promise<ChainState>;

/** Best-effort lookup of the tx that set `artifact`'s schedule; injectable for tests. */
export type AppliedTxFinder = (
  ctx: NetworkContext,
  signer: Signer,
  state: ChainState,
  artifact: EpochScheduleArtifact
) => Promise<string | undefined>;

const SCHEDULE_ABI = [
  "function okuMRatePerSecond() view returns (uint256)",
  "function okuMRateEnd() view returns (uint256)",
  "function okuMPendingRatePerSecond() view returns (uint256)",
  "function okuMPendingRateEnd() view returns (uint256)",
  "function okuMBaseMultiplier() view returns (uint256)",
  "function okuMLastAccrualTime() view returns (uint256)",
  "event NextOkuMYieldRateSet(uint256 newRate, uint256 activatesAt, uint256 expiresAt)",
];

/** Default reader: plain `ethers` over the signer's provider (no hardhat import). */
export const readChainState: ChainStateReader = async (ctx, signer) => {
  const provider = signer.provider;
  if (!provider) throw new Error("signer has no provider");
  const address = loadAddress(ctx.bookKey, "OkuMoney");
  if (!address) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);
  const c = new ethers.Contract(address, SCHEDULE_ABI, provider);
  const [net, rate, rateEnd, pendingRate, pendingRateEnd, base, last] = await Promise.all([
    provider.getNetwork(),
    c.okuMRatePerSecond(),
    c.okuMRateEnd(),
    c.okuMPendingRatePerSecond(),
    c.okuMPendingRateEnd(),
    c.okuMBaseMultiplier(),
    c.okuMLastAccrualTime(),
  ]);
  return {
    chainId: Number(net.chainId),
    address,
    schedule: {
      rate: rate.toString(),
      rateEnd: Number(rateEnd),
      pendingRate: pendingRate.toString(),
      pendingRateEnd: Number(pendingRateEnd),
      baseMultiplier: base.toString(),
      lastAccrualTime: Number(last),
    },
  };
};

/** How far back {@link findAppliedTx} scans for the setter's event. */
const RECOVERY_LOOKBACK_BLOCKS = 10_000;

/**
 * Default finder: the latest `NextOkuMYieldRateSet(nextRate, rateEnd,
 * nextRateEnd)` log from this OkuMoney in the last
 * {@link RECOVERY_LOOKBACK_BLOCKS} blocks (`setOkuMYieldRateWithSuccessor`
 * always emits it). Any RPC failure (e.g. a log-range limit) returns
 * `undefined` and the receipt is recorded as {@link ALREADY_APPLIED}.
 */
export const findAppliedTx: AppliedTxFinder = async (_ctx, signer, state, artifact) => {
  try {
    const provider = signer.provider!;
    const iface = new ethers.Interface(SCHEDULE_ABI);
    const latest = await provider.getBlockNumber();
    const logs = await provider.getLogs({
      address: state.address,
      topics: [iface.getEvent("NextOkuMYieldRateSet")!.topicHash],
      fromBlock: Math.max(0, latest - RECOVERY_LOOKBACK_BLOCKS),
      toBlock: latest,
    });
    for (const log of [...logs].reverse()) {
      const [newRate, activatesAt, expiresAt] = iface.parseLog(log)!.args;
      if (
        newRate === BigInt(artifact.schedule.nextRate) &&
        Number(activatesAt) === artifact.schedule.rateEnd &&
        Number(expiresAt) === artifact.schedule.nextRateEnd
      ) {
        return log.transactionHash;
      }
    }
  } catch (e: any) {
    logger.warning(`tx-hash recovery via logs failed (${e.message ?? e}); recording ${ALREADY_APPLIED}`);
  }
  return undefined;
};

export interface ApplyDeps {
  readChain?: ChainStateReader;
  findTx?: AppliedTxFinder;
  /** Wall-clock seconds, for the expiry check. */
  nowSec?: number;
}

/** The one on-chain call this script makes, injectable for tests. */
export type RateApplier = (
  ctx: NetworkContext,
  signer: Signer,
  opts: {
    mode: "withSuccessor";
    rate: bigint;
    endTimestamp: bigint;
    nextRate: bigint;
    pendingEndTimestamp: bigint;
    dryRun: boolean;
  }
) => Promise<SetOkuMYieldRateResult>;

export interface ApplyArgs {
  epochId: string;
  phase: EpochPhase;
  dryRun: boolean;
}

/** What `applyScheduleToChain` did, so callers and tests can assert on it. */
export type ApplyOutcome = "already-confirmed" | "dry-run" | "recorded" | "recovered";

/**
 * Read and validate this invocation's arguments from argv/env.
 *
 * Throws rather than defaulting. `phase` in particular must not fall back to
 * a value: the two phases write different schedules, and silently picking one
 * would broadcast a wrong-but-plausible rate to every chain.
 */
export function parseApplyArgs(): ApplyArgs {
  const epochId = parseArg("epochId");
  const phase = parseArg("phase") as EpochPhase | undefined;
  if (!epochId) throw new Error("Required: --epochId=<id> (env: EPOCH_ID)");
  if (phase !== "stage-settlement" && phase !== "roll-epoch") {
    throw new Error("Required: --phase=stage-settlement|roll-epoch (env: PHASE)");
  }
  return { epochId, phase, dryRun: isDryRun() };
}

/**
 * Apply `artifact`'s schedule to the chain `ctx` is bound to, and record the
 * receipt.
 *
 * Idempotent by design: a chain that already carries a `txHash` receipt
 * (recorded for this chain's chainId+address) is skipped, and a chain whose
 * live schedule already equals the target gets a `recovered` receipt instead
 * of a second transaction. That matters because
 * `setOkuMYieldRateWithSuccessor` re-anchors the multiplier from the current
 * timestamp — applying it twice is not a no-op. See the module doc for the
 * identity / expiry / pre-state checks made before any submission.
 */
export async function applyScheduleToChain(
  artifact: EpochScheduleArtifact,
  ctx: NetworkContext,
  signer: Signer,
  dryRun: boolean,
  applyRate: RateApplier = runSetOkuMYieldRate,
  deps: ApplyDeps = {}
): Promise<ApplyOutcome> {
  const readChain = deps.readChain ?? readChainState;
  const findTx = deps.findTx ?? findAppliedTx;
  const tag = `[${ctx.bookKey}]`;

  assertArtifactBound(artifact);
  const target = artifact.targets[ctx.networkName];
  if (!artifact.targetChains.includes(ctx.networkName) || !target || target.kind !== "evm") {
    throw new Error(
      `${tag} ${ctx.networkName} is not an EVM target committed in artifact ` +
        `${artifact.epochId}/${artifact.phase} (targets: ${artifact.targetChains.join(", ")})`
    );
  }

  const state = await readChain(ctx, signer);
  const sameIdentity = (chainId?: number, address?: string) =>
    chainId === state.chainId && !!address && address.toLowerCase() === state.address.toLowerCase();

  const existing = artifact.receipts[ctx.bookKey];
  if (isConfirmedReceipt(existing)) {
    if (!sameIdentity(existing.chainId, existing.address)) {
      throw new Error(
        `${tag} saved receipt ${existing.txHash} was recorded for chainId=${existing.chainId ?? "?"} ` +
          `address=${existing.address ?? "?"}, but this chain is chainId=${state.chainId} ` +
          `address=${state.address}. Refusing to honour it (or to re-apply over it) — investigate.`
      );
    }
    logger.info(`${tag} already confirmed (${existing.txHash}) — nothing to do`);
    return "already-confirmed";
  }

  if (!sameIdentity(target.chainId, target.okuMoney)) {
    throw new Error(
      `${tag} chain identity mismatch: artifact bound chainId=${target.chainId} OkuMoney=${target.okuMoney}, ` +
        `live chainId=${state.chainId} OkuMoney=${state.address}. Refusing to submit.`
    );
  }
  assertNotExpired(artifact, deps.nowSec);

  logger.header(`Applying epoch ${artifact.epochId} to ${ctx.networkName}`);
  logger.info(`rate=${artifact.schedule.rate} end=${artifact.schedule.rateEnd}`);
  logger.info(`nextRate=${artifact.schedule.nextRate} nextEnd=${artifact.schedule.nextRateEnd}`);

  // Already at the target: a previous run's tx landed but its receipt was
  // never persisted. Record it; do NOT resend (it would re-anchor later).
  if (scheduleMatchesTarget(state.schedule, artifact)) {
    if (dryRun) {
      logger.success(`${tag} DRY_RUN — schedule already at target; would record a recovered receipt`);
      return "dry-run";
    }
    const txHash = (await findTx(ctx, signer, state, artifact)) ?? ALREADY_APPLIED;
    artifact.receipts[ctx.bookKey] = {
      txHash,
      confirmedAtSec: Math.floor(Date.now() / 1000),
      chainId: state.chainId,
      address: state.address,
      recovered: true,
    };
    saveArtifactInPlace(artifact);
    logger.success(`${tag} schedule already at target — recovered receipt recorded (${txHash}), nothing resent`);
    return "recovered";
  }

  const isReference = ctx.bookKey === artifact.referenceChain;
  const mismatches = preStateMismatches(state.schedule, artifact, isReference);
  if (mismatches.length > 0) {
    throw new Error(
      `${tag} on-chain schedule no longer matches the artifact's expected pre-state ` +
        `(nor its target): ${mismatches.join("; ")}. State moved since derivation — re-derive.`
    );
  }

  const result = await applyRate(ctx, signer, {
    mode: "withSuccessor",
    rate: BigInt(artifact.schedule.rate),
    endTimestamp: BigInt(artifact.schedule.rateEnd),
    nextRate: BigInt(artifact.schedule.nextRate),
    pendingEndTimestamp: BigInt(artifact.schedule.nextRateEnd),
    dryRun,
  });

  if (dryRun) {
    logger.success(`${tag} DRY_RUN — not recorded as a receipt`);
    return "dry-run";
  }

  artifact.receipts[ctx.bookKey] = {
    txHash: result.txHash ?? "unknown",
    confirmedAtSec: Math.floor(Date.now() / 1000),
    chainId: state.chainId,
    address: state.address,
  };
  saveArtifactInPlace(artifact);
  logger.success(`${tag} confirmed and recorded`);
  return "recorded";
}

if (require.main === module) {
  runMain(async () => {
    // Imported lazily so the exports above stay loadable outside a Hardhat run.
    const { ethers } = await import("hardhat");
    const { resolveNetworkContext } = await import("../utils/networkContext");

    const { epochId, phase, dryRun } = parseApplyArgs();

    const ctx = await resolveNetworkContext();
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun });
    const [signer] = await ethers.getSigners();

    const artifact = loadArtifact(epochId, phase);
    await applyScheduleToChain(artifact, ctx, signer, dryRun);
  });
}
