/**
 * Emergency discrete multiplier override (OKUM_REBASER role required).
 *
 * Calls `OkuMoney.setOkuMMultiplier(newMultiplier)` — the ESCAPE HATCH ONLY
 * path (see contract NatSpec). Unlike `setOkuMYieldRate`, this is a discrete
 * jump: it collapses the entire rate schedule to halted (active + pending
 * rate reset to PRECISION, both windows zeroed) and stamps
 * `lastYieldDistributionBlock`, which engages `YieldSandwichGuard` on every
 * PSM/vault path for the rest of the block. An operator must call
 * `setOkuMYieldRate` afterward to resume streaming accrual.
 *
 * The multiplier is monotonic: `newMultiplier` must be strictly greater than
 * the current value (`MultiplierCannotDecrease` otherwise) and at most
 * `MAX_MULTIPLIER` (`MultiplierTooHigh` otherwise).
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base NEW_MULTIPLIER=1050000000000000000 \
 *       npx hardhat run scripts/operator/setOkuMMultiplier.ts --network base   # $1.05
 *
 * Environment:
 *   NEW_MULTIPLIER=<1e18-scaled>    (required)
 *   DRY_RUN=true                    simulate without submitting
 *   YES_MAINNET=true                bypass mainnet guard (standard guard only —
 *                                    no extra confirmation flag; this is an
 *                                    ordinary role-gated admin action like any
 *                                    other setter, not a uniquely dangerous one)
 *
 * Also exported as `runSetOkuMMultiplier()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface SetOkuMMultiplierResult {
  previousMultiplier: bigint;
  newMultiplier: bigint;
  txHash?: string;
}

export async function runSetOkuMMultiplier(
  ctx: NetworkContext,
  signer: Signer,
  newMultiplier: bigint,
  dryRun = false
): Promise<SetOkuMMultiplierResult> {
  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMoneyAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);
  const currentMultiplier = await (okuMoney as any).okuMMultiplier();

  logger.info(`Signer (rebaser):    ${await signer.getAddress()}`);
  logger.info(`Current multiplier:  ${ethers.formatEther(currentMultiplier)}`);
  logger.info(`New multiplier:      ${ethers.formatEther(newMultiplier)}`);
  logger.warning(
    "This COLLAPSES the rate schedule to halted (active + pending rate -> PRECISION, " +
      "both windows zeroed) and engages the yield-sandwich guard for the rest of this " +
      "block. Call setOkuMYieldRate afterward to resume streaming accrual."
  );

  if (newMultiplier <= currentMultiplier) {
    throw new Error(
      `newMultiplier (${ethers.formatEther(newMultiplier)}) must be > current (${ethers.formatEther(currentMultiplier)}) — contract reverts MultiplierCannotDecrease`
    );
  }
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { previousMultiplier: currentMultiplier, newMultiplier: currentMultiplier };
  }

  const tx = await (okuMoney as any).setOkuMMultiplier(newMultiplier);
  const receipt = await tx.wait(1);
  logger.success(`setOkuMMultiplier tx: ${receipt.hash}`);

  const confirmed = await (okuMoney as any).okuMMultiplier();
  logger.success(`Confirmed multiplier: ${ethers.formatEther(confirmed)}`);
  return { previousMultiplier: currentMultiplier, newMultiplier: confirmed, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`setOkuMMultiplier (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const newMultiplierStr = parseArg("newMultiplier");
    if (!newMultiplierStr) throw new Error("Required: --newMultiplier=<1e18-scaled>");

    const [signer] = await ethers.getSigners();
    await runSetOkuMMultiplier(ctx, signer, BigInt(newMultiplierStr), isDryRun());
  });
}
