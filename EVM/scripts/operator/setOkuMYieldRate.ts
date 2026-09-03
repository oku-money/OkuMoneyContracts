/**
 * Set OkuMoney's streaming yield rate (OKUM_REBASER role).
 *
 * Replaces the removed `distributeYield.ts`. `distributeYield` divided a dollar
 * amount by LOCAL `totalSupply()`, which produced a different multiplier delta on
 * every chain — incompatible with cross-chain uniformity. Yield is now expressed
 * as a RATE, which is supply-independent by construction.
 *
 * TWO PATHS:
 *
 *   --stage  (PREFERRED)  -> setNextOkuMYieldRate(rate)
 *       Pre-stages the successor rate. It activates off the absolute `okuMRateEnd`
 *       timestamp INSIDE the view function, with NO transaction at the boundary.
 *       Staging txs may therefore land on different chains days apart and the
 *       activation is still simultaneous to the second. This is the primitive that
 *       makes the rear-facing epoch pipeline cross-chain safe.
 *
 *   (default)             -> setOkuMYieldRate(rate, endTimestamp)
 *       Re-anchors the accrual base at `block.timestamp`. Broadcast skew between
 *       chains causes a permanent divergence of (r_old/r_new)^delta — negligible
 *       for routine changes (~1e-10), but material for the initial 0% -> r
 *       activation. Use for activation and corrections; prefer --stage otherwise.
 *
 * Rate is DERIVED from --apy via scripts/utils/yieldRate.ts so every chain gets a
 * byte-identical integer. Passing a raw --rate is supported for corrections but
 * discouraged; nothing on-chain enforces cross-chain rate equality.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setOkuMYieldRate.ts --network base \
 *       --apy 0.03 --endTimestamp 1767225600
 *   NETWORK=base npx hardhat run scripts/operator/setOkuMYieldRate.ts --network base \
 *       --apy 0.0325 --stage
 *   DRY_RUN=true APY=0.03 NETWORK=base npx hardhat run ... --network base
 *
 * Flags / env:
 *   --apy=<fraction>          e.g. 0.03 for 3% (preferred)
 *   --rate=<1e18-scaled>      raw override; mutually exclusive with --apy
 *   --endTimestamp=<unix>     0 = open-ended. Ignored with --stage.
 *   --stage                   use setNextOkuMYieldRate instead
 *   DRY_RUN=true              simulate without submitting
 *   --yes-mainnet             required to broadcast on mainnet
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { apyToRatePerSecond, describeRate, PRECISION, MAX_RATE } from "../utils/yieldRate";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet") || process.env.YES_MAINNET === "true";
const DRY_RUN = process.env.DRY_RUN === "true";
const STAGE = process.argv.includes("--stage") || process.env.STAGE === "true";

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`setOkuMYieldRate (${ctx.networkName})${STAGE ? " [STAGE]" : ""}`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const apyStr = parseArg("apy");
  const rateStr = parseArg("rate");
  if (apyStr && rateStr) throw new Error("Pass --apy or --rate, not both");
  if (!apyStr && !rateStr) throw new Error("Required: --apy=<fraction> (preferred) or --rate=<1e18>");

  const rate = apyStr ? apyToRatePerSecond(Number(apyStr)) : BigInt(rateStr!);
  if (rate < PRECISION) throw new Error(`rate ${rate} < PRECISION; contract reverts InvalidRate`);
  if (rate > MAX_RATE) throw new Error(`rate ${rate} > MAX_RATE; contract reverts RateTooHigh`);
  if (rateStr) logger.warning("Raw --rate supplied; prefer --apy so all chains derive identically");

  const endStr = parseArg("endTimestamp") ?? "0";
  const endTimestamp = BigInt(endStr);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (!STAGE && endTimestamp !== 0n && endTimestamp <= now) {
    throw new Error(`--endTimestamp (${endTimestamp}) must be 0 or > now (${now})`);
  }
  if (!STAGE && endTimestamp === 0n) {
    logger.warning(
      "endTimestamp=0 (open-ended). setNextOkuMYieldRate will revert NoRateEndSet " +
        "until a bounded window is set, forcing every future change through the " +
        "skew-sensitive re-anchor path."
    );
  }

  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer) as any;

  const [curMult, curRate, curEnd, curPending] = await Promise.all([
    okuM.okuMMultiplier(),
    okuM.okuMRatePerSecond(),
    okuM.okuMRateEnd(),
    okuM.okuMPendingRatePerSecond(),
  ]);

  logger.info(`Signer:            ${await signer.getAddress()}`);
  logger.info(`Current multiplier: ${ethers.formatEther(curMult)}`);
  logger.info(`Current rate:       ${describeRate(curRate)}`);
  logger.info(`Current rateEnd:    ${curEnd === 0n ? "open-ended" : new Date(Number(curEnd) * 1000).toISOString()}`);
  logger.info(`Current pending:    ${describeRate(curPending)}`);
  logger.info(`New rate:           ${describeRate(rate)}`);
  if (!STAGE) {
    logger.info(
      `New endTimestamp:   ${endTimestamp === 0n ? "open-ended" : new Date(Number(endTimestamp) * 1000).toISOString()}`
    );
  }

  if (STAGE) {
    if (curEnd === 0n) throw new Error("Cannot stage against an open-ended rate (NoRateEndSet)");
    if (now >= curEnd) throw new Error("Active rate already expired (RateAlreadyExpired); use the re-anchor path");
    logger.info(`Activates at:       ${new Date(Number(curEnd) * 1000).toISOString()} (no tx at boundary)`);
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = STAGE
    ? await okuM.setNextOkuMYieldRate(rate)
    : await okuM.setOkuMYieldRate(rate, endTimestamp);
  const receipt = await tx.wait(1);
  logger.success(`tx: ${receipt.hash}`);

  const confirmed = STAGE ? await okuM.okuMPendingRatePerSecond() : await okuM.okuMRatePerSecond();
  logger.success(`Confirmed: ${describeRate(confirmed)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
