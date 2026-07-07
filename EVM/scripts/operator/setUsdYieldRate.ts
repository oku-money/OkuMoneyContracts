/**
 * Set the OkuDollar USD multiplier accrual rate (`VAULT_REBASER` role).
 *
 * Calls `OkuDollar.setUsdYieldRate(newRate, endTimestamp)`.
 *   - `newRate`     1e18-scaled per-second multiplier (≥ PRECISION = 1e18).
 *                   PRECISION exactly = 0% APR (no accrual).
 *   - `endTimestamp` Unix seconds when the rate ends; 0 = open-ended (yield
 *                    continues until the next call). Must be > now if non-zero.
 *
 * This setter is intentionally NOT pause-gated — operators may need to ZERO
 * the rate during an incident response. See OkuMoney.setOkuMMultiplier
 * NatSpec for the rate-effect vs rate-config split.
 *
 * Common conversions (PRECISION = 10**18):
 *   5 % APR  →  newRate ≈ 1000000001547125957  (1e18 + 1.547e9 per second)
 *   10% APR  →  newRate ≈ 1000000003022265980
 *   0  APR  →  newRate = 1000000000000000000   (= PRECISION; halts accrual)
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setUsdYieldRate.ts --network base \
 *       --rate 1000000001547125957 --endTimestamp 0
 *   DRY_RUN=true RATE=1000000000000000000 END_TIMESTAMP=0 NETWORK=base \
 *       npx hardhat run scripts/operator/setUsdYieldRate.ts --network base
 *
 * Environment / flags:
 *   --rate=<1e18-scaled> | RATE              required
 *   --endTimestamp=<unix> | END_TIMESTAMP    default 0 (open-ended)
 *   DRY_RUN=true                             simulate without submitting
 *   --yes-mainnet                            bypass mainnet guard
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";
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

const PRECISION = 10n ** 18n;

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`setUsdYieldRate (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const rateStr = parseArg("rate") ?? parseArg("RATE");
  if (!rateStr) throw new Error("Required: --rate=<1e18-scaled> or RATE env var");
  const newRate = BigInt(rateStr);
  if (newRate < PRECISION) {
    throw new Error(`--rate (${newRate}) < PRECISION (${PRECISION}); contract reverts InvalidRate`);
  }

  const endStr = parseArg("endTimestamp") ?? parseArg("END_TIMESTAMP") ?? "0";
  const endTimestamp = BigInt(endStr);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (endTimestamp !== 0n && endTimestamp <= now) {
    throw new Error(`--endTimestamp (${endTimestamp}) must be 0 or > now (${now})`);
  }

  const okuDollarAddr = loadAddress(ctx.bookKey, "OkuDollar");
  if (!okuDollarAddr) throw new Error(`Missing OkuDollar in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const okuDollar = (await getDeployedContract("OkuDollar", okuDollarAddr)).connect(signer) as Contract;

  const currentRate = await (okuDollar as any).usdRatePerSecond();
  const currentEnd = await (okuDollar as any).usdRateEnd();
  const currentMult = await (okuDollar as any).usdMultiplier();

  logger.info(`Signer (vaultRebaser): ${await signer.getAddress()}`);
  logger.info(`Current rate:          ${currentRate}`);
  logger.info(`Current rateEnd:       ${currentEnd === 0n ? "open-ended" : new Date(Number(currentEnd) * 1000).toISOString()}`);
  logger.info(`Current usdMultiplier: ${ethers.formatEther(currentMult)}`);
  logger.info(`New rate:              ${newRate}`);
  logger.info(`New endTimestamp:      ${endTimestamp === 0n ? "open-ended" : new Date(Number(endTimestamp) * 1000).toISOString()}`);

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuDollar as any).setUsdYieldRate(newRate, endTimestamp);
  const receipt = await tx.wait(1);
  logger.success(`setUsdYieldRate tx: ${receipt.hash}`);

  const confirmed = await (okuDollar as any).usdRatePerSecond();
  logger.success(`Confirmed rate: ${confirmed}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
