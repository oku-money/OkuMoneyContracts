/**
 * Start an OkuMoney yield epoch (OKUM_REBASER role).
 *
 * Calls `OkuMoney.startYieldEpoch(yieldAmount, duration)`, which streams
 * `yieldAmount` of realized dollar yield across all holders over `duration`
 * seconds by advancing `okuMMultiplier` linearly.
 *
 * This replaces the former `distributeYield.ts`. Yield is still discovered
 * off-chain in chunks (T-Bills settle periodically) and is still rear-facing —
 * only ever distributing what has already been earned. What changed is
 * DELIVERY: the multiplier now moves continuously instead of stepping.
 *
 * Why: `okuMMultiplier` is the settlement price for instant, two-way
 * convertibility at the PSM. A discrete step in a settlement price is riskless
 * arbitrage — mint immediately before the step, redeem immediately after, and
 * capture the whole increment with no holding period, funded out of the PSM
 * buffer and diluting honest holders. Streaming removes the instant, so a
 * holder earns strictly in proportion to time held. See
 * `EVM/README.md § Continuous yield epochs`.
 *
 * Operationally this is still ONE transaction per distribution window.
 *
 * The epoch begins at the CURRENT multiplier, so publishing never moves the
 * price. Calling mid-epoch REPLACES the active epoch (rebasing from the
 * current value, no jump) and discards any scheduled successor.
 *
 * Bounds enforced on-chain:
 *   - duration in [1 hour, 365 days]
 *   - implied APR <= 20% (`MAX_IMPLIED_APR_BPS`), computed as
 *     (deltaMultiplier / startMultiplier) * (year / duration)
 *
 * If the call reverts with `ImpliedAprTooHigh`, the fix is to stream the same
 * amount over a LONGER duration, not to reduce the amount.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/startYieldEpoch.ts --network base \
 *       --amount 4110000000000000000000 --duration 2592000   # $4110 over 30 days
 *   DRY_RUN=true AMOUNT=4110000000000000000000 DURATION=2592000 NETWORK=base \
 *       npx hardhat run scripts/operator/startYieldEpoch.ts --network base
 *
 * Environment:
 *   AMOUNT         18-decimal dollar yield amount (alternative to --amount)
 *   DURATION       Epoch length in seconds (alternative to --duration)
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

const BASIS_POINTS = 10_000n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const MAX_IMPLIED_APR_BPS = 2000n;
const MIN_EPOCH_DURATION = 3600n;
const MAX_EPOCH_DURATION = 365n * 24n * 60n * 60n;
const PRECISION = 10n ** 18n;

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`startYieldEpoch (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const amountStr = parseArg("amount") ?? parseArg("AMOUNT");
  if (!amountStr) throw new Error("Required: --amount=<18-decimal dollars> or AMOUNT env var");
  const amount = BigInt(amountStr);
  if (amount <= 0n) throw new Error("--amount must be > 0");

  const durationStr = parseArg("duration") ?? parseArg("DURATION");
  if (!durationStr) throw new Error("Required: --duration=<seconds> or DURATION env var");
  const duration = BigInt(durationStr);
  if (duration < MIN_EPOCH_DURATION || duration > MAX_EPOCH_DURATION) {
    throw new Error(
      `--duration must be in [${MIN_EPOCH_DURATION}, ${MAX_EPOCH_DURATION}] seconds ` +
        `(got ${duration})`
    );
  }

  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer);

  const supply = await (okuM as any).totalSupply();
  const multiplierBefore = await (okuM as any).okuMMultiplier();
  const halted = await (okuM as any).accrualHalted();

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`Total supply: ${ethers.formatUnits(supply, 18)} OkuM`);
  logger.info(`Multiplier now: ${ethers.formatUnits(multiplierBefore, 18)}`);
  logger.info(`Yield to stream: $${ethers.formatUnits(amount, 18)}`);
  logger.info(`Duration: ${duration}s (~${Number(duration) / 86400} days)`);

  if (supply === 0n) {
    throw new Error("Total supply is 0; startYieldEpoch would revert with ZeroSupply");
  }
  if (halted) {
    throw new Error("Accrual is halted; call resumeAccrual before starting an epoch");
  }

  // Mirror the contract's derivation so misconfigurations are caught before broadcast.
  const yieldPerToken = (amount * PRECISION) / supply;
  const ratePerSecond = yieldPerToken / duration;
  if (ratePerSecond === 0n) {
    throw new Error(
      "Yield too small: the per-second rate floors to zero. Increase --amount or " +
        "shorten --duration."
    );
  }
  const actualDelta = ratePerSecond * duration;
  const impliedAprBps =
    (actualDelta * BASIS_POINTS * SECONDS_PER_YEAR) / (multiplierBefore * duration);

  logger.info(`Implied APR: ${impliedAprBps} bps (cap ${MAX_IMPLIED_APR_BPS} bps)`);
  logger.info(`Multiplier at epoch end: ${ethers.formatUnits(multiplierBefore + actualDelta, 18)}`);

  if (impliedAprBps > MAX_IMPLIED_APR_BPS) {
    const minDuration =
      (actualDelta * SECONDS_PER_YEAR * BASIS_POINTS) /
        (multiplierBefore * MAX_IMPLIED_APR_BPS) +
      2n;
    throw new Error(
      `Implied APR ${impliedAprBps} bps exceeds the ${MAX_IMPLIED_APR_BPS} bps cap. ` +
        `Stream this amount over at least ${minDuration}s ` +
        `(~${Math.ceil(Number(minDuration) / 86400)} days) instead.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuM as any).startYieldEpoch(amount, duration);
  const receipt = await tx.wait(1);
  logger.success(`startYieldEpoch tx: ${receipt.hash}`);

  const multiplierAfter = await (okuM as any).okuMMultiplier();
  const endsAt = await (okuM as any).yieldEpochEndsAt();

  // The multiplier MUST be unchanged immediately after publication — that is the
  // property that makes it unsandwichable. Surface it as an explicit check.
  if (multiplierAfter !== multiplierBefore) {
    logger.error(
      `UNEXPECTED: multiplier moved on publication ` +
        `(${multiplierBefore} -> ${multiplierAfter}). An epoch must start at the ` +
        `current value.`
    );
  } else {
    logger.success(`Multiplier unchanged at publication: ${ethers.formatUnits(multiplierAfter, 18)}`);
  }

  logger.success(`Epoch ends at: ${endsAt} (${new Date(Number(endsAt) * 1000).toISOString()})`);
  logger.info(
    "Reminder: the multiplier FLATLINES past this timestamp. Schedule the successor " +
      "with scheduleYieldEpoch.ts or start a new epoch before then."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
