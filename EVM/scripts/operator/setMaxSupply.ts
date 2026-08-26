/**
 * Set the OkuM global supply cap (`OKU_CAP_MANAGER` role required).
 *
 * Calls `OkuM.setMaxSupply(newMaxSupply)`. Bounded on both sides: below by
 * `totalSupply()` (`BelowCurrentSupply`) and above by the compile-time
 * `MAX_TOTAL_SUPPLY` of 1e33 raw (`AboveMaxTotalSupply`). The upper bound is
 * enforced here and not only at `initialize` on purpose — the cap is mutable by
 * this role, so an init-only assertion would evaporate the first time it moved,
 * and with it the overflow invariant `MAX_TOTAL_SUPPLY * MAX_MULTIPLIER = 1e57`
 * that keeps UI conversion arithmetic provably safe.
 *
 * OkuM ONLY. USDOku has no supply cap: its supply is `totalShares * M_usd`, and
 * shares only exist against OkuM already sitting in the wrapper — so OkuM's cap
 * is transitively the cap on both legs.
 *
 * Cap raises are the typical operation. A lower is only safe when totalSupply
 * has room, and note it does NOT reduce anything already minted — it just stops
 * further issuance.
 *
 * See ../../README.md § Authority model.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setMaxSupply.ts --network base \
 *       --maxSupply 1000000000000000000000000000      # 1B OkuM (18-dec)
 *   DRY_RUN=true MAX_SUPPLY=1000000000000000000000000000 NETWORK=base \
 *       npx hardhat run scripts/operator/setMaxSupply.ts --network base
 *
 * Environment / flags:
 *   --maxSupply=<wei> | MAX_SUPPLY    18-decimal OkuM amount (required)
 *   DRY_RUN=true                      simulate without submitting
 *   --yes-mainnet                     bypass mainnet guard
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { resolveOperatorSigner } from "./_shared";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

/** Mirrors `Constants.MAX_TOTAL_SUPPLY` — 1e15 whole tokens at 18 dp. */
const MAX_TOTAL_SUPPLY = 10n ** 33n;

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`setMaxSupply (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const newMaxStr = parseArg("maxSupply") ?? parseArg("MAX_SUPPLY");
  if (!newMaxStr) throw new Error("Required: --maxSupply=<18-dec OkuM> or MAX_SUPPLY env var");
  const newMaxSupply = BigInt(newMaxStr);
  if (newMaxSupply <= 0n) throw new Error("--maxSupply must be > 0");

  const okuMAddr = loadAddress(ctx.bookKey, "OkuM");
  if (!okuMAddr) throw new Error(`Missing OkuM in address book for ${ctx.bookKey}`);

  // Signer resolution goes through the shared helper rather than
  // `getSigners()[0]`: on a fork the mnemonic accounts hold no roles, so every
  // privileged call here would revert AccessControlUnauthorizedAccount against
  // a correctly-wired deployment. On a live network the helper returns the same
  // PRIVATE_KEY signer, so behaviour there is unchanged.
  const signer = await resolveOperatorSigner(ctx.isFork);
  const okuM = (await getDeployedContract("OkuM", okuMAddr)).connect(signer) as Contract;

  const currentMax = await (okuM as any).maxSupply();
  const currentSupply = await (okuM as any).totalSupply();
  const multiplier = await (okuM as any).uiMultiplier();

  logger.info(`Signer (capManager): ${await signer.getAddress()}`);
  logger.info(`Current maxSupply:   ${ethers.formatEther(currentMax)} raw OkuM`);
  logger.info(`Current totalSupply: ${ethers.formatEther(currentSupply)} raw OkuM`);
  logger.info(`New maxSupply:       ${ethers.formatEther(newMaxSupply)} raw OkuM`);
  logger.info(
    `  at M_oku ${ethers.formatEther(multiplier)}, the new cap is worth ` +
      `$${ethers.formatEther((newMaxSupply * multiplier) / 10n ** 18n)}`
  );

  // The cap is denominated in RAW units, which is the whole reason this note
  // exists: because M_oku only rises, a fixed raw cap represents a
  // MONOTONICALLY INCREASING dollar ceiling. It does not need periodic raising
  // to keep pace with yield — only with genuine new subscription.
  if (newMaxSupply < currentSupply) {
    throw new Error(
      `New maxSupply (${ethers.formatEther(newMaxSupply)}) < totalSupply ` +
        `(${ethers.formatEther(currentSupply)}); the contract reverts ` +
        `BelowCurrentSupply. Note the cap is in RAW units, not dollars — raw ` +
        `balances do not grow with yield, so a cap that fitted last month still fits.`
    );
  }
  if (newMaxSupply > MAX_TOTAL_SUPPLY) {
    throw new Error(
      `New maxSupply (${newMaxSupply}) exceeds MAX_TOTAL_SUPPLY (${MAX_TOTAL_SUPPLY}); ` +
        `the contract reverts AboveMaxTotalSupply. This bound is a compile-time ` +
        `constant that makes the UI-conversion overflow invariant a theorem; no key ` +
        `can raise it.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuM as any).setMaxSupply(newMaxSupply);
  const receipt = await tx.wait(1);
  logger.success(`setMaxSupply tx: ${receipt.hash}`);

  const confirmed = await (okuM as any).maxSupply();
  logger.success(`Confirmed maxSupply: ${ethers.formatEther(confirmed)} raw OkuM`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
