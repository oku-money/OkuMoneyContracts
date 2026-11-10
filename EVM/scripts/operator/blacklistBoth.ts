/**
 * Blacklist or unblacklist an account on BOTH OkuMoney and OkuDollar in one
 * shot, since the two contracts maintain INDEPENDENT blacklist mappings
 * despite sharing the OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role hashes.
 * Calling only one leaves a hole (e.g. a user blacklisted on OkuMoney can
 * still hold/move OkuDollar). This wrapper closes that operational footgun.
 *
 * Each leg is decided from that contract's OWN entry (`OkuMoney.isBlacklisted`,
 * `OkuDollar.isLocallyBlacklisted`), never from `OkuDollar.isBlacklisted`, which is a
 * composite that is already true once OkuMoney lists the account.
 *
 * The role hash is shared but role grants are per-contract: the signer must
 * already hold the role on EACH contract. See scripts/operator/grantRoles*.ts.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base ACCOUNT=0xBadActor ACTION=blacklist \
 *       npx hardhat run scripts/operator/blacklistBoth.ts --network base
 *   NETWORK=base ACCOUNT=0xRehabilitated ACTION=unblacklist \
 *       npx hardhat run scripts/operator/blacklistBoth.ts --network base
 *
 * Environment:
 *   ACCOUNT=0x...                  address to (un)blacklist (required)
 *   ACTION=blacklist|unblacklist   default: blacklist
 *   DRY_RUN=true                   simulate without submitting
 *   YES_MAINNET=true               bypass mainnet guard
 *
 * Also exported as `runBlacklistBoth()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { isAddress, Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";
import type { OkuMoney, OkuDollar } from "../../typechain-types";

export type BlacklistAction = "blacklist" | "unblacklist";

export interface BlacklistBothResult {
  /** `OkuMoney.isBlacklisted`. */
  okuMoneyState: boolean;
  /**
   * `OkuDollar.isBlacklisted`: the COMPOSITE (OkuDollar's own list OR OkuMoney's), the view
   * the contract enforces. Not evidence that OkuDollar's own entry is set.
   */
  okuDollarState: boolean;
  /** `OkuDollar.isLocallyBlacklisted`: OkuDollar's own list only. */
  okuDollarLocalState: boolean;
}

async function applyOne(
  label: string,
  contract: OkuMoney | OkuDollar,
  /** The entry THIS contract's `blacklist` / `unblacklist` writes, not a composite view. */
  isListed: boolean,
  account: string,
  action: BlacklistAction,
  dryRun: boolean
): Promise<void> {
  // Idempotency: the underlying contracts revert with AlreadyBlacklisted /
  // NotBlacklisted on duplicate calls. Skip-with-log instead of letting the
  // tx revert mid-pair (which would leave the other side in a desynced state
  // depending on order).
  //
  // `isListed` must be the contract's OWN entry. OkuDollar.isBlacklisted() is a composite
  // that turns true as soon as OkuMoney lists the account, so reading it here skipped
  // OkuDollar's own entry and reported success without installing it (cyfrin #20).
  const isBlacklisted = isListed;
  if (action === "blacklist" && isBlacklisted) {
    logger.info(`  [${label}] already blacklisted — skipping`);
    return;
  }
  if (action === "unblacklist" && !isBlacklisted) {
    logger.info(`  [${label}] not blacklisted — skipping`);
    return;
  }
  if (dryRun) {
    logger.info(`  [${label}] [dry-run] WOULD ${action}`);
    return;
  }
  const tx = action === "blacklist"
    ? await contract.blacklist(account)
    : await contract.unblacklist(account);
  const receipt = await waitMined(tx);
  logger.success(`  [${label}] ${action} tx: ${receipt.hash}`);
}

/** Blacklist (or unblacklist) `account` on OkuMoney and OkuDollar together; skips a side already in the target state. */
export async function runBlacklistBoth(
  ctx: NetworkContext,
  signer: Signer,
  account: string,
  action: BlacklistAction,
  dryRun = false
): Promise<BlacklistBothResult> {
  if (!isAddress(account)) throw new Error(`Invalid account: ${account}`);

  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  const okuDollarAddr = loadAddress(ctx.bookKey, "OkuDollar");
  if (!okuMoneyAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);
  if (!okuDollarAddr) throw new Error(`Missing OkuDollar in address book for ${ctx.bookKey}`);

  const signerAddr = await signer.getAddress();
  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);
  const okuDollar = (await getDeployedContract("OkuDollar", okuDollarAddr)).connect(signer);

  logger.info(`Signer:    ${signerAddr}`);
  logger.info(`Account:   ${account}`);
  logger.info(`Action:    ${action} on BOTH contracts`);
  logger.info(`OkuMoney:  ${okuMoneyAddr}`);
  logger.info(`OkuDollar: ${okuDollarAddr}`);

  // OkuMoney first, then OkuDollar's OWN entry. The order is not load-bearing any more:
  // each leg reads its own list, not the composite.
  await applyOne("OkuMoney", okuMoney, await okuMoney.isBlacklisted(account), account, action, dryRun);
  await applyOne(
    "OkuDollar",
    okuDollar,
    await okuDollar.isLocallyBlacklisted(account),
    account,
    action,
    dryRun
  );

  const okuMoneyState: boolean = await okuMoney.isBlacklisted(account);
  const okuDollarState: boolean = await okuDollar.isBlacklisted(account);
  const okuDollarLocalState: boolean = await okuDollar.isLocallyBlacklisted(account);
  const expected = action === "blacklist";
  logger.info(`Post-state OkuMoney.isBlacklisted:            ${okuMoneyState}`);
  logger.info(`Post-state OkuDollar.isLocallyBlacklisted:    ${okuDollarLocalState}`);
  logger.info(`Post-state OkuDollar.isBlacklisted (composite): ${okuDollarState}`);
  if (!dryRun && (okuMoneyState !== expected || okuDollarLocalState !== expected)) {
    throw new Error(
      `Post-state mismatch: OkuMoney=${okuMoneyState}, OkuDollar local=${okuDollarLocalState}, ` +
        `expected=${expected}`
    );
  }
  logger.success(`Done — both lists in the target state (blacklisted=${expected})`);
  return { okuMoneyState, okuDollarState, okuDollarLocalState };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`blacklistBoth (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const account = parseArg("account");
    if (!account || !isAddress(account)) {
      throw new Error("Required: --account=<address> or ACCOUNT env var");
    }
    const actionRaw = (parseArg("action") ?? "blacklist").toLowerCase();
    if (actionRaw !== "blacklist" && actionRaw !== "unblacklist") {
      throw new Error("--action must be 'blacklist' or 'unblacklist'");
    }

    const [signer] = await ethers.getSigners();
    await runBlacklistBoth(ctx, signer, account, actionRaw as BlacklistAction, isDryRun());
  });
}
