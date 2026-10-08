/**
 * Set OkuMoney's streaming yield rate (OKUM_RATE_MANAGER role).
 *
 * Yield is expressed as a RATE, which is supply-independent by construction and
 * therefore produces the same multiplier delta on every chain.
 *
 * THREE PATHS:
 *
 *   --with-successor (PREFERRED — what the epoch pipeline uses)
 *                       -> setOkuMYieldRateWithSuccessor(rate, endTimestamp, nextRate, pendingEndTimestamp)
 *       Atomically re-anchors the active rate AND stages its successor in ONE
 *       transaction. Closes the two-transaction race the separate STAGE=true path
 *       has: if the re-anchor lands but a second, separate staging tx fails or
 *       is delayed, the schedule is left with NO successor armed and accrual
 *       silently halts at `endTimestamp`. `applyScheduleSingleChain.ts` uses this
 *       path for both epoch phase transitions.
 *
 *   STAGE=true          -> setNextOkuMYieldRate(rate, pendingEndTimestamp)
 *       Pre-stages the successor rate only, without re-anchoring. It activates
 *       off the absolute `okuMRateEnd` timestamp INSIDE the view function, with
 *       NO transaction at the boundary.
 *
 *   (default)             -> setOkuMYieldRate(rate, endTimestamp)
 *       Re-anchors the accrual base at `block.timestamp` with NO successor
 *       staged. Broadcast skew between chains causes a permanent divergence of
 *       (r_old/r_new)^delta — negligible for routine changes, but material for
 *       the initial 0% -> r activation.
 *
 * Rate is DERIVED from APY= via scripts/utils/yieldRate.ts so every chain gets a
 * byte-identical integer. Passing a raw RATE= is supported for corrections but
 * discouraged; nothing on-chain enforces cross-chain rate equality.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base APY=0.03 END_TIMESTAMP=1767225600 \
 *       npx hardhat run scripts/operator/setOkuMYieldRate.ts --network base
 *   NETWORK=base APY=0.0325 STAGE=true PENDING_END_TIMESTAMP=1769904000 \
 *       npx hardhat run scripts/operator/setOkuMYieldRate.ts --network base
 *   NETWORK=base APY=0.032 END_TIMESTAMP=1767225600 WITH_SUCCESSOR=true \
 *       NEXT_APY=0.028 PENDING_END_TIMESTAMP=1769904000 \
 *       npx hardhat run scripts/operator/setOkuMYieldRate.ts --network base
 *
 * Environment:
 *   APY=<fraction>                e.g. 0.03 for 3% (preferred)
 *   RATE=<1e18-scaled>            raw override; mutually exclusive with APY
 *   END_TIMESTAMP=<unix>          required (> now) unless rate == PRECISION
 *   STAGE=true                    use setNextOkuMYieldRate instead
 *   WITH_SUCCESSOR=true           use setOkuMYieldRateWithSuccessor (needs
 *                                  NEXT_APY/NEXT_RATE + PENDING_END_TIMESTAMP)
 *   NEXT_APY=<fraction>           successor rate for WITH_SUCCESSOR
 *   NEXT_RATE=<1e18-scaled>       raw override for NEXT_APY
 *   PENDING_END_TIMESTAMP=<unix>  required with STAGE / WITH_SUCCESSOR;
 *                                 must be > the (current, for STAGE; new,
 *                                 for WITH_SUCCESSOR) okuMRateEnd
 *   DRY_RUN=true                  simulate without submitting
 *   YES_MAINNET=true              required to broadcast on mainnet
 *
 * Also exported as `runSetOkuMYieldRate()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { apyToRatePerSecond, describeRate, PRECISION, MAX_RATE } from "../utils/yieldRate";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export type SetYieldRateMode = "direct" | "stage" | "withSuccessor";

export interface SetOkuMYieldRateOpts {
  mode: SetYieldRateMode;
  rate: bigint;
  endTimestamp?: bigint; // required for "direct" / "withSuccessor"
  pendingEndTimestamp?: bigint; // required for "stage" / "withSuccessor"
  nextRate?: bigint; // required for "withSuccessor"
  dryRun?: boolean;
}

export interface SetOkuMYieldRateResult {
  txHash?: string;
  confirmedRate: bigint;
  confirmedPendingRate: bigint;
}

/** Write the rate schedule: `direct` (active rate), `stage` (successor only) or `withSuccessor` (both, atomically). */
export async function runSetOkuMYieldRate(
  ctx: NetworkContext,
  signer: Signer,
  opts: SetOkuMYieldRateOpts
): Promise<SetOkuMYieldRateResult> {
  const { mode, rate, endTimestamp, pendingEndTimestamp, nextRate, dryRun = false } = opts;
  if (rate < PRECISION) throw new Error(`rate ${rate} < PRECISION; contract reverts InvalidRate`);
  if (rate > MAX_RATE) throw new Error(`rate ${rate} > MAX_RATE; contract reverts RateTooHigh`);

  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);
  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer);

  const [curMult, curRate, curEnd, curPending] = await Promise.all([
    okuM.okuMMultiplier(),
    okuM.okuMRatePerSecond(),
    okuM.okuMRateEnd(),
    okuM.okuMPendingRatePerSecond(),
  ]);

  logger.info(`Signer:            ${await signer.getAddress()}`);
  logger.info(`Mode:               ${mode}`);
  logger.info(`Current multiplier: ${ethers.formatEther(curMult)}`);
  logger.info(`Current rate:       ${describeRate(curRate)}`);
  logger.info(`Current rateEnd:    ${curEnd === 0n ? "halted (no yield accruing)" : new Date(Number(curEnd) * 1000).toISOString()}`);
  logger.info(`Current pending:    ${describeRate(curPending)}`);
  logger.info(`New rate:           ${describeRate(rate)}`);

  if (mode === "stage" && curEnd === 0n) {
    throw new Error("Cannot stage a successor while accrual is halted (NoRateEndSet)");
  }

  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { confirmedRate: curRate, confirmedPendingRate: curPending };
  }

  let tx;
  if (mode === "stage") {
    if (pendingEndTimestamp === undefined) throw new Error("mode=stage requires pendingEndTimestamp");
    tx = await okuM.setNextOkuMYieldRate(rate, pendingEndTimestamp);
  } else if (mode === "withSuccessor") {
    if (endTimestamp === undefined) throw new Error("mode=withSuccessor requires endTimestamp");
    if (nextRate === undefined) throw new Error("mode=withSuccessor requires nextRate");
    if (pendingEndTimestamp === undefined) throw new Error("mode=withSuccessor requires pendingEndTimestamp");
    tx = await okuM.setOkuMYieldRateWithSuccessor(rate, endTimestamp, nextRate, pendingEndTimestamp);
  } else {
    if (endTimestamp === undefined) throw new Error("mode=direct requires endTimestamp");
    tx = await okuM.setOkuMYieldRate(rate, endTimestamp);
  }
  const receipt = await waitMined(tx);
  logger.success(`tx: ${receipt.hash}`);

  const confirmedRate = await okuM.okuMRatePerSecond();
  const confirmedPendingRate = await okuM.okuMPendingRatePerSecond();
  logger.success(`Confirmed rate: ${describeRate(confirmedRate)}, pending: ${describeRate(confirmedPendingRate)}`);
  return { txHash: receipt.hash, confirmedRate, confirmedPendingRate };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    const STAGE = process.argv.includes("--stage") || process.env.STAGE === "true";
    const WITH_SUCCESSOR = process.argv.includes("--with-successor") || process.env.WITH_SUCCESSOR === "true";
    if (STAGE && WITH_SUCCESSOR) throw new Error("Pass --stage or --with-successor, not both");
    const mode: SetYieldRateMode = WITH_SUCCESSOR ? "withSuccessor" : STAGE ? "stage" : "direct";

    logger.header(`setOkuMYieldRate (${ctx.networkName}) [${mode}]`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const apyStr = parseArg("apy");
    const rateStr = parseArg("rate");
    if (apyStr && rateStr) throw new Error("Pass --apy or --rate, not both");
    if (!apyStr && !rateStr) throw new Error("Required: --apy=<fraction> (preferred) or --rate=<1e18>");
    const rate = apyStr ? apyToRatePerSecond(Number(apyStr)) : BigInt(rateStr!);
    if (rateStr) logger.warning("Raw --rate supplied; prefer --apy so all chains derive identically");

    const endStr = parseArg("endTimestamp");
    const endTimestamp = endStr ? BigInt(endStr) : undefined;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (mode !== "stage") {
      if (rate === PRECISION) {
        if (endTimestamp !== undefined && endTimestamp !== 0n) {
          throw new Error("Halting (--rate == PRECISION) requires endTimestamp == 0 or omitted");
        }
      } else if (endTimestamp === undefined || endTimestamp <= now) {
        throw new Error(
          `--endTimestamp (${endTimestamp}) must be > now (${now}) for any yielding rate — ` +
            "open-ended yielding rates are no longer supported (every window is bounded)"
        );
      }
    }

    const pendingEndStr = parseArg("pendingEndTimestamp");
    const pendingEndTimestamp = pendingEndStr ? BigInt(pendingEndStr) : undefined;
    if ((mode === "stage" || mode === "withSuccessor") && pendingEndTimestamp === undefined) {
      throw new Error(`--${mode} requires --pendingEndTimestamp=<unix>`);
    }

    let nextRate: bigint | undefined;
    if (mode === "withSuccessor") {
      const nextApyStr = parseArg("nextApy");
      const nextRateStr = parseArg("nextRate");
      if (nextApyStr && nextRateStr) throw new Error("Pass --nextApy or --nextRate, not both");
      if (!nextApyStr && !nextRateStr) throw new Error("--with-successor requires --nextApy or --nextRate");
      nextRate = nextApyStr ? apyToRatePerSecond(Number(nextApyStr)) : BigInt(nextRateStr!);
    }

    const [signer] = await ethers.getSigners();
    await runSetOkuMYieldRate(ctx, signer, {
      mode,
      rate,
      endTimestamp: endTimestamp ?? 0n,
      pendingEndTimestamp,
      nextRate,
      dryRun: isDryRun(),
    });
  });
}
