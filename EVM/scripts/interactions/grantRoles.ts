/**
 * Grant All Roles to Master EOA
 *
 * Idempotently grants every AccessControl role on every deployed contract
 * (for the active network) to a single hard-coded "master" EOA so that one
 * dev wallet can do everything during testing — including grant/revoke other
 * roles via DEFAULT_ADMIN_ROLE.
 *
 * Decisions baked in:
 *   - QUEUE_PSM is intentionally NOT granted to an EOA (must remain on the
 *     LitePSM proxy, otherwise an EOA could bypass LitePSM accounting).
 *   - Both BRIDGE_REFUND_INITIATOR and BRIDGE_REFUND_CONFIRMER are granted.
 *     Note: OkuBridge.confirmRefund() still reverts when initiator == confirmer
 *     (OkuBridge.sol:471), so a single EOA cannot complete a refund. That's a
 *     contract-layer guarantee we don't try to defeat here.
 *   - authorizedSigner is not modified — at deploy time it is already set to
 *     the dev wallet (scripts/deploy/index.ts:455).
 *   - NttAdapter (NTT_*) roles are out of scope for this script.
 *
 * The signer used to send the grants must hold DEFAULT_ADMIN_ROLE on every
 * contract being touched. On testnet deployments that is the deployer / dev
 * wallet (DEV_WALLET_ADDRESS in scripts/config/chains.ts).
 *
 * Usage:
 *   npx hardhat run scripts/interactions/grantRoles.ts --network base
 *   npx hardhat run scripts/interactions/grantRoles.ts --network sepolia
 *   npx hardhat run scripts/interactions/grantRoles.ts --network bsc
 *
 *   # Fork (auto-detects target chain from the running node, or pass NETWORK=…):
 *   NETWORK=base npx hardhat run scripts/interactions/grantRoles.ts --network localhost
 *
 * Environment knobs (live networks only; forks are unaffected):
 *   CONFIRMATIONS=N   confirmations to wait per tx (default 2)
 *   SETTLE_MS=N       extra ms to sleep after each mined tx before the next
 *                     hasRole read (default 1500; set 0 to disable)
 */

import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { hasAddress, loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";
import { DEV_WALLET_ADDRESS } from "../config/chains";

// ============================================================================
// Configuration
// ============================================================================

/** EOA that will receive every role on every deployed contract. */
const MASTER_EOA = "0x971A3e2b0031dE23715Fa1ce53843B5B045dae00";

/** EOA that holds DEFAULT_ADMIN_ROLE today (the deployer / dev wallet). */
const ADMIN_EOA = DEV_WALLET_ADDRESS;

/**
 * Number of confirmations to wait per tx on live networks. Anything ≥1 is
 * sufficient for nonce correctness (the nonce is committed when the tx is
 * mined), but bumping this on chains with longer reorg windows (e.g. BSC)
 * also stabilises the post-tx `hasRole` reads we use to detect duplicate
 * grants. Forks confirm instantly so we always use 1 there.
 */
const LIVE_CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 2);

/**
 * Settle delay (ms) inserted AFTER each tx is mined on live networks, before
 * the next iteration's `hasRole` read. Helps against load-balanced RPCs that
 * briefly serve stale state from a follower node. Defaults to 1500ms; set
 * SETTLE_MS=0 to disable. No-op on forks.
 */
const LIVE_SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500);

type RoleName = keyof typeof ROLES;

/**
 * Map of contract name (as it appears in addresses.json) → roles to grant.
 *
 * NOTE: every list begins with DEFAULT_ADMIN_ROLE so the master EOA can
 * subsequently grant/revoke any role itself.
 */
const ROLE_MAP: Record<string, readonly RoleName[]> = {
  OkuMoney: [
    "DEFAULT_ADMIN_ROLE",
    "OKUM_UPGRADER",
    "OKUM_PAUSER",
    "OKUM_UNPAUSER",
    "OKUM_MINTER",
    "OKUM_REBASER",
    "OKUM_BLACKLISTER",
    "OKUM_UNBLACKLISTER",
    "OKUM_CAP_MANAGER",
    "OKUM_ALLOWANCE_MANAGER",
  ],
  OkuDollar: [
    "DEFAULT_ADMIN_ROLE",
    "VAULT_UPGRADER",
    "VAULT_REBASER",
    "VAULT_RESERVE_MANAGER",
    "VAULT_PAUSER",
    "VAULT_UNPAUSER",
  ],
  LitePSM: [
    "DEFAULT_ADMIN_ROLE",
    "PSM_UPGRADER",
    "PSM_PAUSER",
    "PSM_UNPAUSER",
    "PSM_QUEUE_PROCESSOR",
    "PSM_BUFFER_DEPOSITOR",
    "PSM_BUFFER_WITHDRAWER",
    "PSM_ORACLE_MANAGER",
  ],
  // NOTE: QUEUE_PSM intentionally excluded — must stay on the LitePSM proxy.
  RedemptionQueue: ["DEFAULT_ADMIN_ROLE", "QUEUE_UPGRADER", "QUEUE_RESCUER"],
  OkuBridge: [
    "DEFAULT_ADMIN_ROLE",
    "BRIDGE_SIGNER_MANAGER",
    "BRIDGE_PAUSER",
    "BRIDGE_UNPAUSER",
    "BRIDGE_FEE_MANAGER",
    "BRIDGE_NONCE_ADMIN",
    "BRIDGE_CHAIN_MANAGER",
    "BRIDGE_LIMITS_MANAGER",
    "BRIDGE_UPGRADER",
    "BRIDGE_REFUND_INITIATOR",
    "BRIDGE_REFUND_CONFIRMER",
  ],
  OkuBridgeRouter: [
    "DEFAULT_ADMIN_ROLE",
    "ROUTER_UPGRADER",
    "ROUTER_PAUSER",
    "ROUTER_UNPAUSER",
    "ROUTER_ADAPTER_MANAGER",
    "ROUTER_BRIDGE_MANAGER",
  ],
};

// ============================================================================
// Types
// ============================================================================

type GrantStatus = "granted" | "already" | "skipped" | "error";

interface GrantResult {
  contract: string;
  role: string;
  status: GrantStatus;
  detail?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the signer that will send grantRole txs. On a fork we impersonate the
 * admin EOA if the active hardhat signer doesn't already match it.
 */
async function resolveAdminSigner(isFork: boolean) {
  const [primary] = await ethers.getSigners();

  if (primary.address.toLowerCase() === ADMIN_EOA.toLowerCase()) {
    return primary;
  }

  if (!isFork) {
    throw new Error(
      `Active hardhat signer is ${primary.address} but DEFAULT_ADMIN_ROLE is held by ${ADMIN_EOA}.\n` +
        `  Set the PRIVATE_KEY env (or the network's accounts entry in hardhat.config.ts) ` +
        `to the admin EOA's key and re-run.`
    );
  }

  // Fork path — impersonate the admin EOA and top up its ETH for gas.
  logger.info(`Impersonating admin EOA ${ADMIN_EOA} on fork...`);
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [ADMIN_EOA],
  });

  const adminBalance = await ethers.provider.getBalance(ADMIN_EOA);
  if (adminBalance < ethers.parseEther("0.5")) {
    await primary.sendTransaction({
      to: ADMIN_EOA,
      value: ethers.parseEther("1"),
    });
    logger.info(`Funded ${ADMIN_EOA} with 1 ETH for gas`);
  }

  return ethers.getSigner(ADMIN_EOA);
}

/**
 * Send a tx and wait for the configured number of confirmations.
 *
 * Why we don't reuse `waitForTx` from utils/deploy.ts here: that helper waits
 * for the default 1 confirmation, which is fine for nonce correctness (nonce
 * is committed once mined) but on chains with longer reorg windows (BSC in
 * particular) we want a deeper buffer before we trust the post-tx
 * `hasRole` read on the next iteration. Forks confirm instantly so 1 conf
 * is always enough there.
 *
 * The sequential `await` pattern in the caller already prevents nonce
 * collisions: each grantRole returns only after the previous tx is mined, so
 * ethers fetches the next nonce from a state that already reflects it. No
 * separate nonce manager is needed as long as no other process is sending
 * txs from the same EOA concurrently.
 */
async function sendAndConfirm(
  txPromise: Promise<any>,
  description: string,
  isFork: boolean
): Promise<void> {
  logger.info(`${description}...`);
  const tx = await txPromise;
  const confirmations = isFork ? 1 : LIVE_CONFIRMATIONS;
  const receipt = await tx.wait(confirmations);
  logger.success(
    `${description} — block ${receipt.blockNumber} (${confirmations} conf)`
  );

  if (!isFork && LIVE_SETTLE_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_SETTLE_MS));
  }
}

/**
 * Grant every role in `roles` on `contract` to MASTER_EOA, skipping any that
 * are already held. Returns one GrantResult per role.
 */
async function grantRolesOnContract(
  contractName: string,
  contract: Contract,
  roles: readonly RoleName[],
  signerAddress: string,
  isFork: boolean
): Promise<GrantResult[]> {
  const results: GrantResult[] = [];

  // Sanity-check the signer holds DEFAULT_ADMIN_ROLE on this contract before
  // attempting any grant — fail early with a clear message.
  const signerHasAdmin: boolean = await contract.hasRole(
    ROLES.DEFAULT_ADMIN_ROLE,
    signerAddress
  );
  if (!signerHasAdmin) {
    const addr = await contract.getAddress();
    throw new Error(
      `${contractName} at ${addr} does not recognize ${signerAddress} as DEFAULT_ADMIN_ROLE.\n` +
        `  Cannot grant roles. Check that ADMIN_EOA matches the contract's actual admin.`
    );
  }

  for (const roleName of roles) {
    const roleHash = ROLES[roleName];
    try {
      const already: boolean = await contract.hasRole(roleHash, MASTER_EOA);
      if (already) {
        results.push({ contract: contractName, role: roleName, status: "already" });
        logger.info(`  [${contractName}] ${roleName}: already granted`);
        continue;
      }

      await sendAndConfirm(
        contract.grantRole(roleHash, MASTER_EOA),
        `[${contractName}] grantRole(${roleName})`,
        isFork
      );
      results.push({ contract: contractName, role: roleName, status: "granted" });
    } catch (err: any) {
      results.push({
        contract: contractName,
        role: roleName,
        status: "error",
        detail: err?.message ?? String(err),
      });
      logger.error(`  [${contractName}] ${roleName}: ${err?.message ?? err}`);
    }
  }

  return results;
}

function printSummary(results: GrantResult[], skippedContracts: string[]) {
  logger.section("Summary");

  const granted = results.filter((r) => r.status === "granted").length;
  const already = results.filter((r) => r.status === "already").length;
  const errors = results.filter((r) => r.status === "error").length;

  // Pretty per-role table.
  const pad = (s: string, n: number) => s.padEnd(n, " ");
  const colC = Math.max(8, ...results.map((r) => r.contract.length));
  const colR = Math.max(8, ...results.map((r) => r.role.length));

  console.log(`  ${pad("Contract", colC)}  ${pad("Role", colR)}  Status`);
  console.log(`  ${"-".repeat(colC)}  ${"-".repeat(colR)}  ------`);
  for (const r of results) {
    const statusStr =
      r.status === "granted"
        ? "\x1b[32mGRANTED\x1b[0m"
        : r.status === "already"
          ? "\x1b[36malready\x1b[0m"
          : r.status === "error"
            ? "\x1b[31mERROR\x1b[0m"
            : "skipped";
    console.log(`  ${pad(r.contract, colC)}  ${pad(r.role, colR)}  ${statusStr}`);
  }

  console.log();
  logger.info(`Granted:           ${granted}`);
  logger.info(`Already held:      ${already}`);
  if (errors > 0) logger.error(`Errors:            ${errors}`);
  if (skippedContracts.length > 0) {
    logger.warning(
      `Skipped contracts: ${skippedContracts.join(", ")} (no entry in address book)`
    );
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { networkName, bookKey, isFork } = await resolveNetworkContext();

  // On a fork run we read addresses from `fork:<chain>` first, but if the
  // user is forking a live chain WITHOUT having re-deployed onto the fork
  // (the common case for "fork bsc, mess with the live contracts at their
  // real addresses"), the fork-namespaced entries are either empty or stale
  // (left over from a previous fork-local deploy that no longer exists on a
  // freshly started fork node). For each contract we therefore check that
  // there's actually contract bytecode at the candidate address on the
  // running chain, and fall through to the live `<chain>` entries otherwise.
  const candidateKeys: string[] = isFork ? [bookKey, networkName] : [bookKey];

  logger.header(
    `Grant Roles → ${MASTER_EOA} (${networkName}${isFork ? " fork" : ""})`
  );
  logger.info(`Address book key: ${bookKey}`);
  if (isFork) {
    logger.info(`Fallback key:     ${networkName} (used if fork entries missing)`);
  }
  logger.info(`Master EOA:       ${MASTER_EOA}`);
  logger.info(`Admin EOA:        ${ADMIN_EOA}`);
  if (!isFork) {
    logger.info(
      `Confirmations:    ${LIVE_CONFIRMATIONS} per tx (override with CONFIRMATIONS=N)`
    );
    logger.info(
      `Settle delay:     ${LIVE_SETTLE_MS}ms after each tx (override with SETTLE_MS=N)`
    );
  }

  const adminSigner = await resolveAdminSigner(isFork);
  logger.info(`Admin signer:     ${adminSigner.address}`);

  const allResults: GrantResult[] = [];
  const skippedContracts: string[] = [];

  try {
    for (const [contractName, roles] of Object.entries(ROLE_MAP)) {
      logger.section(`${contractName}`);

      // Walk candidate keys, picking the first one whose recorded address
      // actually has bytecode on the running chain. This avoids the "0x"
      // decode error you get when the address book points at a stale
      // fork-local deploy that no longer exists on a freshly started fork.
      let resolvedKey: string | undefined;
      let addr: string | undefined;
      const triedKeys: { key: string; addr: string; reason: string }[] = [];

      for (const k of candidateKeys) {
        if (!hasAddress(k, contractName)) {
          triedKeys.push({ key: k, addr: "", reason: "no entry" });
          continue;
        }
        const candidate = loadAddress(k, contractName);
        const code = await ethers.provider.getCode(candidate);
        if (code === "0x" || code === "0x0") {
          triedKeys.push({ key: k, addr: candidate, reason: "no bytecode" });
          continue;
        }
        resolvedKey = k;
        addr = candidate;
        break;
      }

      if (!resolvedKey || !addr) {
        const detail = triedKeys
          .map((t) =>
            t.addr ? `"${t.key}" → ${t.addr} (${t.reason})` : `"${t.key}" (${t.reason})`
          )
          .join(", ");
        logger.warning(
          `No live deployment found for ${contractName} — skipping. Tried: ${detail}`
        );
        skippedContracts.push(contractName);
        continue;
      }

      logger.info(`Address: ${addr} (from "${resolvedKey}")`);

      const contract = (await getDeployedContract(contractName, addr)).connect(
        adminSigner
      ) as Contract;

      const results = await grantRolesOnContract(
        contractName,
        contract,
        roles,
        adminSigner.address,
        isFork
      );
      allResults.push(...results);
    }
  } finally {
    if (
      isFork &&
      adminSigner.address.toLowerCase() === ADMIN_EOA.toLowerCase() &&
      (await ethers.getSigners())[0].address.toLowerCase() !==
        ADMIN_EOA.toLowerCase()
    ) {
      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [ADMIN_EOA],
      });
    }
  }

  printSummary(allResults, skippedContracts);

  const errorCount = allResults.filter((r) => r.status === "error").length;
  if (errorCount > 0) {
    throw new Error(`${errorCount} role grant(s) failed — see log above`);
  }

  logger.success(`All applicable roles granted to ${MASTER_EOA}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`grantRoles failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
