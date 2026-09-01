/**
 * Manage OkuMoney yield epochs beyond the primary `startYieldEpoch` path
 * (OKUM_REBASER role): schedule a successor, cancel a scheduled successor,
 * halt accrual, resume accrual, or inspect current state.
 *
 * See `startYieldEpoch.ts` for why yield streams rather than steps.
 *
 * ## Actions
 *
 *   status    Print the active epoch, any scheduled successor, and halt state.
 *             Read-only; safe to run anywhere.
 *
 *   schedule  Queue a successor beginning exactly when the active epoch ends,
 *             so accrual is continuous across the boundary with no flat gap.
 *             Requires a live (non-flatlined) active epoch.
 *             Requires --amount and --duration.
 *
 *   cancel    Revoke a scheduled successor before it activates. This is the
 *             ONLY fully clean rollback in the design: the successor never
 *             accrued, so nothing is unwound. Once it activates, monotonicity
 *             makes the yield permanent and `halt` is the only remaining lever.
 *
 *   halt      Freeze the multiplier at its current value and block new epochs.
 *             INDEPENDENT of `pause()` — the two address different incidents:
 *               - bug found, backing intact  -> pause() only; holders keep
 *                 earning yield the protocol genuinely owes them
 *               - backing impaired           -> halt; stop growing obligations
 *                 while transfers continue
 *               - both                       -> do both
 *             Not pause-gated: halting must work during an incident, and it can
 *             only ever reduce yield.
 *
 *   resume    Lift the halt. Does NOT restart accrual — the multiplier stays
 *             flat until a new epoch is started, and the halted interval cannot
 *             be backdated. Making it up is a fresh forward-looking epoch,
 *             subject to the same APR cap.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/manageYieldEpoch.ts --network base \
 *       --action status
 *   NETWORK=base npx hardhat run scripts/operator/manageYieldEpoch.ts --network base \
 *       --action schedule --amount 4110000000000000000000 --duration 2592000 --yes-mainnet
 *   NETWORK=base npx hardhat run scripts/operator/manageYieldEpoch.ts --network base \
 *       --action halt --yes-mainnet
 *
 * Environment:
 *   ACTION         status | schedule | cancel | halt | resume
 *   AMOUNT         18-decimal dollar yield amount (schedule only)
 *   DURATION       Epoch length in seconds (schedule only)
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet") || process.env.YES_MAINNET === "true";
const DRY_RUN = process.env.DRY_RUN === "true";

const ACTIONS = ["status", "schedule", "cancel", "halt", "resume"] as const;
type Action = (typeof ACTIONS)[number];

function fmtTime(ts: bigint): string {
  if (ts === 0n) return "0 (unset)";
  return `${ts} (${new Date(Number(ts) * 1000).toISOString()})`;
}

async function printStatus(okuM: any) {
  const [multiplier, halted, endsAt, current, pending] = await Promise.all([
    okuM.okuMMultiplier(),
    okuM.accrualHalted(),
    okuM.yieldEpochEndsAt(),
    okuM.currentYieldEpoch(),
    okuM.pendingYieldEpoch(),
  ]);

  logger.info(`Multiplier now:   ${ethers.formatUnits(multiplier, 18)}`);
  logger.info(`Accrual halted:   ${halted}`);
  logger.info(`Accrual ends at:  ${fmtTime(endsAt)}`);

  logger.info("Active epoch:");
  logger.info(`  baseMultiplier: ${ethers.formatUnits(current.baseMultiplier, 18)}`);
  logger.info(`  ratePerSecond:  ${current.ratePerSecond}`);
  logger.info(`  startTime:      ${fmtTime(current.startTime)}`);
  logger.info(`  endTime:        ${fmtTime(current.endTime)}`);

  if (pending.endTime === 0n) {
    logger.info("Scheduled successor: none");
  } else {
    logger.info("Scheduled successor:");
    logger.info(`  baseMultiplier: ${ethers.formatUnits(pending.baseMultiplier, 18)}`);
    logger.info(`  ratePerSecond:  ${pending.ratePerSecond}`);
    logger.info(`  startTime:      ${fmtTime(pending.startTime)}`);
    logger.info(`  endTime:        ${fmtTime(pending.endTime)}`);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (!halted && endsAt !== 0n && now >= endsAt) {
    logger.error(
      "ACCRUAL HAS FLATLINED — the active epoch ended and no successor is scheduled. " +
        "Yield has silently stopped. Start a new epoch."
    );
  }
}

async function main() {
  const ctx = await resolveNetworkContext();
  const action = (parseArg("action") ?? parseArg("ACTION") ?? "status") as Action;
  if (!ACTIONS.includes(action)) {
    throw new Error(`--action must be one of: ${ACTIONS.join(", ")} (got "${action}")`);
  }

  logger.header(`manageYieldEpoch:${action} (${ctx.networkName})`);

  // `status` is read-only; everything else can broadcast.
  if (action !== "status") {
    mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });
  }

  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer) as any;

  logger.info(`Signer: ${await signer.getAddress()}`);
  await printStatus(okuM);

  if (action === "status") return;

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  let tx;
  switch (action) {
    case "schedule": {
      const amountStr = parseArg("amount") ?? parseArg("AMOUNT");
      const durationStr = parseArg("duration") ?? parseArg("DURATION");
      if (!amountStr || !durationStr) {
        throw new Error("schedule requires --amount=<18-dec dollars> and --duration=<seconds>");
      }
      tx = await okuM.scheduleYieldEpoch(BigInt(amountStr), BigInt(durationStr));
      break;
    }
    case "cancel":
      tx = await okuM.cancelPendingYieldEpoch();
      break;
    case "halt":
      tx = await okuM.haltAccrual();
      break;
    case "resume":
      tx = await okuM.resumeAccrual();
      break;
  }

  const receipt = await tx.wait(1);
  logger.success(`${action} tx: ${receipt.hash}`);

  logger.info("State after:");
  await printStatus(okuM);

  if (action === "resume") {
    logger.info(
      "Resuming does NOT restart accrual. The multiplier stays flat until a new " +
        "epoch is started via startYieldEpoch.ts."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
