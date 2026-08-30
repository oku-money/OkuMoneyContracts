/**
 * Blacklist or unblacklist an account on BOTH OkuM and USDOku in one
 * shot, since the two contracts maintain INDEPENDENT blacklist mappings
 * despite sharing the OKUM_BLACKLISTER / OKUM_UNBLACKLISTER role hashes.
 * Calling only one leaves a hole (e.g. a user blacklisted on OkuM can
 * still hold/move USDOku). This wrapper closes that operational footgun.
 *
 * The role hash is shared but role grants are per-contract: the signer must
 * already hold the role on EACH contract. See scripts/operator/grantRoles*.ts.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/blacklistBoth.ts --network base \
 *       --account 0xBadActor --action blacklist
 *   NETWORK=base npx hardhat run scripts/operator/blacklistBoth.ts --network base \
 *       --account 0xRehabilitated --action unblacklist
 *   DRY_RUN=true ACCOUNT=0xBadActor ACTION=blacklist NETWORK=base npx hardhat run ...
 *
 * Environment / flags:
 *   --account=0x... | ACCOUNT       address to (un)blacklist (required)
 *   --action=blacklist|unblacklist | ACTION
 *                                   default: blacklist
 *   DRY_RUN=true                    simulate without submitting
 *   --yes-mainnet                   bypass mainnet guard
 */

import { ethers } from "hardhat";
import { isAddress, Contract } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

async function applyOne(
  label: string,
  contract: Contract,
  account: string,
  action: "blacklist" | "unblacklist"
): Promise<void> {
  // Idempotency: the underlying contracts revert with AlreadyBlacklisted /
  // NotBlacklisted on duplicate calls. Skip-with-log instead of letting the
  // tx revert mid-pair (which would leave the other side in a desynced state
  // depending on order).
  const isBlacklisted: boolean = await (contract as any).isBlacklisted(account);
  if (action === "blacklist" && isBlacklisted) {
    logger.info(`  [${label}] already blacklisted — skipping`);
    return;
  }
  if (action === "unblacklist" && !isBlacklisted) {
    logger.info(`  [${label}] not blacklisted — skipping`);
    return;
  }
  if (DRY_RUN) {
    logger.info(`  [${label}] [dry-run] WOULD ${action}`);
    return;
  }
  const tx = action === "blacklist"
    ? await (contract as any).blacklist(account)
    : await (contract as any).unblacklist(account);
  const receipt = await tx.wait(1);
  logger.success(`  [${label}] ${action} tx: ${receipt.hash}`);
}

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`blacklistBoth (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const account = parseArg("account");
  if (!account || !isAddress(account)) {
    throw new Error("Required: --account=<address> or ACCOUNT env var");
  }
  const actionRaw = (parseArg("action") ?? "blacklist").toLowerCase();
  if (actionRaw !== "blacklist" && actionRaw !== "unblacklist") {
    throw new Error("--action must be 'blacklist' or 'unblacklist'");
  }
  const action = actionRaw as "blacklist" | "unblacklist";

  const okuMAddr = loadAddress(ctx.bookKey, "OkuM");
  const usdOkuAddr = loadAddress(ctx.bookKey, "USDOku");
  if (!okuMAddr) throw new Error(`Missing OkuM in address book for ${ctx.bookKey}`);
  if (!usdOkuAddr) throw new Error(`Missing USDOku in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  const okuM = (await getDeployedContract("OkuM", okuMAddr)).connect(signer) as Contract;
  const usdOku = (await getDeployedContract("USDOku", usdOkuAddr)).connect(signer) as Contract;

  logger.info(`Signer:    ${signerAddr}`);
  logger.info(`Account:   ${account}`);
  logger.info(`Action:    ${action} on BOTH contracts`);
  logger.info(`OkuM:  ${okuMAddr}`);
  logger.info(`USDOku: ${usdOkuAddr}`);

  await applyOne("OkuM", okuM, account, action);
  await applyOne("USDOku", usdOku, account, action);

  // Post-state verification — read each side and ensure both match the target.
  const okuMState: boolean = await (okuM as any).isBlacklisted(account);
  const usdOkuState: boolean = await (usdOku as any).isBlacklisted(account);
  const expected = action === "blacklist";
  logger.info(`Post-state OkuM.isBlacklisted:  ${okuMState}`);
  logger.info(`Post-state USDOku.isBlacklisted: ${usdOkuState}`);
  if (!DRY_RUN && (okuMState !== expected || usdOkuState !== expected)) {
    throw new Error(
      `Post-state mismatch: OkuM=${okuMState}, USDOku=${usdOkuState}, expected=${expected}`
    );
  }
  logger.success(`Done — both contracts in sync (isBlacklisted=${expected})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
