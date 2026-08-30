/**
 * Grant Roles — Mainnet RBAC Topology
 *
 * Implements the documented 3-key mainnet role distribution from README.md §RBAC:
 *
 *   Cold Multisig   → ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER,
 *                     ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER,
 *                     RESERVE_MANAGER
 *   Warm Multisig   → all PAUSER, all BLACKLISTER
 *   Orchestrator    → OKUM_RATE_SETTER, VAULT_RATE_SETTER, PSM_GATEKEEPER, BUFFER_DEPOSITOR
 *
 * Contract-to-contract grants (OKUM_MINTER/OKUM_BURNER on the PSM) are NOT in this
 * list — they are set at deploy time and must remain on the LitePSM
 * proxy address (set at deploy time via configureRoles).
 *
 * OKUM_MINTER and OKUM_BURNER (cycle 4 / EVM-15) are likewise intentionally
 * NOT in this list — they must remain on the LitePSM and RedemptionQueue
 * proxy addresses (granted at deploy time via configureRoles). This script
 * verifies those grants exist before proceeding; missing grants are fatal.
 *
 * Final step: revokes DEFAULT_ADMIN_ROLE from the deployer key, making the
 * Cold Multisig the sole meta-role holder.
 *
 * REQUIRES the following environment variables:
 *   MAINNET_COLD_MULTISIG   — Cold multisig address (timelock / hardware wallet)
 *   MAINNET_WARM_MULTISIG   — Warm multisig address (day-to-day ops)
 *   MAINNET_ORCHESTRATOR    — Orchestrator KMS signer address
 *
 * The signer executing this script must hold DEFAULT_ADMIN_ROLE on all
 * contracts (i.e. the original deployer key).
 *
 * Usage:
 *   MAINNET_COLD_MULTISIG=0x... MAINNET_WARM_MULTISIG=0x... MAINNET_ORCHESTRATOR=0x... \
 *     npx hardhat run scripts/operator/grantRolesMainnet.ts --network base
 *
 *   # Dry-run (prints planned grants without broadcasting):
 *   DRY_RUN=true MAINNET_COLD_MULTISIG=0x... ... \
 *     npx hardhat run scripts/operator/grantRolesMainnet.ts --network localhost
 *
 * Safety: requires explicit opt-in on mainnet-beta networks (base, bsc).
 * Set YES_MAINNET=1 in the environment to bypass the gate (preferred; works
 * under `hardhat run`). The legacy --yes-mainnet CLI flag also works when the
 * script is invoked directly via `ts-node`, but Hardhat v2 rejects unknown
 * CLI flags so it can't be used with `hardhat run`.
 */

import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";

// ============================================================================
// Configuration — from environment (REQUIRED on mainnet)
// ============================================================================

const MAINNET_NETWORKS = new Set(["base", "bsc", "mainnet", "ethereum"]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) {
    throw new Error(
      `Missing or invalid env var ${name}. Set it to a valid Ethereum address.\n` +
      `  Example: export ${name}=0xYourAddress`
    );
  }
  return v;
}

const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
// Mainnet opt-in: env var (preferred — works under `hardhat run`) or CLI flag
// (only honored when invoked directly, since Hardhat v2 rejects unknown CLI flags).
const YES_MAINNET =
  process.argv.includes("--yes-mainnet") ||
  process.env.YES_MAINNET === "1" ||
  process.env.YES_MAINNET === "true";

// ============================================================================
// Mainnet RBAC topology (mirrors README.md §RBAC table)
// ============================================================================

type RoleName = keyof typeof ROLES;

/** Roles granted to each key. Contract name → (key → roles) */
function buildRoleMap(_cold: string, _warm: string, _orch: string): {
  cold: Map<string, RoleName[]>;
  warm: Map<string, RoleName[]>;
  orch: Map<string, RoleName[]>;
} {
  // COLD: everything that can change the shape of the system, plus every
  // "un-" action. A compromised warm key can stop the protocol but cannot restart
  // it, and cannot widen a cap or an allowance.
  const coldRoles = new Map<string, RoleName[]>([
    ["OkuM", [
      "DEFAULT_ADMIN_ROLE",
      "OKUM_UPGRADER",
      "OKUM_UNPAUSER",
      "OKUM_UNBLACKLISTER",
      "OKUM_CAP_MANAGER",
      "OKUM_ALLOWANCE_MANAGER",
    ]],
    ["USDOku", [
      "DEFAULT_ADMIN_ROLE",
      "VAULT_UPGRADER",
      "VAULT_UNPAUSER",
      "VAULT_RESERVE_MANAGER",
      "OKUM_UNBLACKLISTER",
    ]],
    ["LitePSM", [
      "DEFAULT_ADMIN_ROLE",
      "PSM_UPGRADER",
      "PSM_UNPAUSER",
      "PSM_BUFFER_WITHDRAWER",
    ]],
  ]);

  // WARM: halt-only. Fast to reach under time pressure, useless for extraction.
  const warmRoles = new Map<string, RoleName[]>([
    ["OkuM", ["OKUM_PAUSER", "OKUM_BLACKLISTER"]],
    ["USDOku", ["VAULT_PAUSER", "OKUM_BLACKLISTER"]],
    ["LitePSM", ["PSM_PAUSER"]],
  ]);

  // ORCHESTRATOR (KMS back-end): the routine loop — close the window, publish the
  // segment, reopen. Plus buffer top-ups.
  //
  // NOTE the deliberate separation: the orchestrator holds OKUM_RATE_SETTER (it can
  // misprice) and PSM_GATEKEEPER (it can open the window), but NOT
  // PSM_BUFFER_WITHDRAWER (it cannot remove the funds) and NOT OKUM_MINTER outside
  // the PSM's own grant. Mispricing and extraction stay in different key custodies.
  const orchRoles = new Map<string, RoleName[]>([
    ["OkuM", ["OKUM_RATE_SETTER"]],
    ["USDOku", ["VAULT_RATE_SETTER"]],
    ["LitePSM", ["PSM_GATEKEEPER", "PSM_BUFFER_DEPOSITOR"]],
  ]);

  return { cold: coldRoles, warm: warmRoles, orch: orchRoles };
}

// ============================================================================
// Helpers
// ============================================================================

async function confirmIfMainnet(networkName: string): Promise<void> {
  if (!MAINNET_NETWORKS.has(networkName)) return;
  if (YES_MAINNET) {
    logger.warning(`YES_MAINNET set; skipping confirmation for ${networkName}`);
    return;
  }
  if (DRY_RUN) {
    logger.info("DRY_RUN=true; skipping mainnet confirmation");
    return;
  }
  // In a real CLI prompt we'd read stdin. For the CI-unfriendly interactive case,
  // require the caller to set YES_MAINNET=1 explicitly. (The CLI flag
  // `--yes-mainnet` is also honored when invoked directly, but Hardhat v2's
  // `hardhat run` rejects unknown CLI flags before the script sees them.)
  throw new Error(
    `Refusing to broadcast on ${networkName} without explicit YES_MAINNET opt-in.\n` +
    `Re-run with: YES_MAINNET=1 npx hardhat run ... --network ${networkName}`
  );
}

async function grantIfNeeded(
  label: string,
  contract: Contract,
  role: string,
  account: string,
  dryRun: boolean
): Promise<void> {
  const has = await contract.hasRole(role, account);
  if (has) {
    logger.info(`  [already] ${label}`);
    return;
  }
  if (dryRun) {
    logger.info(`  [dry-run] WOULD grant ${label}`);
    return;
  }
  const tx = await contract.grantRole(role, account);
  await tx.wait(2);
  logger.success(`  [granted] ${label}`);
}

async function revokeIfNeeded(
  label: string,
  contract: Contract,
  role: string,
  account: string,
  dryRun: boolean
): Promise<void> {
  const has = await contract.hasRole(role, account);
  if (!has) {
    logger.info(`  [already gone] ${label}`);
    return;
  }
  if (dryRun) {
    logger.info(`  [dry-run] WOULD revoke ${label}`);
    return;
  }
  const tx = await contract.revokeRole(role, account);
  await tx.wait(2);
  logger.warning(`  [revoked] ${label}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const ctx = await resolveNetworkContext();
  const networkName = ctx.networkName ?? network.name;
  const bookKey = ctx.bookKey;

  logger.info(`Network: ${networkName} (bookKey: ${bookKey})`);

  // Require mainnet addresses from env
  const cold = requireEnv("MAINNET_COLD_MULTISIG");
  const warm = requireEnv("MAINNET_WARM_MULTISIG");
  const orch = requireEnv("MAINNET_ORCHESTRATOR");

  logger.info(`  Cold Multisig : ${cold}`);
  logger.info(`  Warm Multisig : ${warm}`);
  logger.info(`  Orchestrator  : ${orch}`);
  logger.info(`  Dry-run       : ${DRY_RUN}`);

  await confirmIfMainnet(networkName);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  logger.info(`  Deployer (signer): ${deployerAddress}`);

  const { cold: coldMap, warm: warmMap, orch: orchMap } = buildRoleMap(cold, warm, orch);

  const contracts: Record<string, Contract> = {};
  for (const name of ["OkuM", "USDOku", "LitePSM", "RedemptionQueue"]) {
    let addr: string;
    try {
      addr = loadAddress(bookKey, name);
    } catch {
      logger.warning(`  Skipping ${name} — not found in address book for ${bookKey}`);
      continue;
    }
    contracts[name] = await getDeployedContract(name, addr);
  }

  // -------- Sanity check: deploy-time proxy grants must already exist --------
  // EVM-A1: OKUM_MINTER and OKUM_BURNER live on the LitePSM/RedemptionQueue
  // proxies, not on EOAs. They are granted in scripts/deploy/index.ts and must
  // be present before this script runs. Missing grants here mean a fresh
  // deploy is broken — fail loudly before we touch any role state.
  if (contracts.OkuM && contracts.LitePSM && contracts.RedemptionQueue) {
    const okuM = contracts.OkuM;
    const psmAddr = await contracts.LitePSM.getAddress();
    const queueAddr = await contracts.RedemptionQueue.getAddress();
    const checks: Array<[string, string, string]> = [
      ["OKUM_MINTER on LitePSM", ROLES.OKUM_MINTER, psmAddr],
      ["OKUM_MINTER on RedemptionQueue", ROLES.OKUM_MINTER, queueAddr],
      ["OKUM_BURNER on LitePSM", ROLES.OKUM_BURNER, psmAddr],
      ["OKUM_BURNER on RedemptionQueue", ROLES.OKUM_BURNER, queueAddr],
    ];
    for (const [label, role, account] of checks) {
      const has = await okuM.hasRole(role, account);
      if (!has) {
        throw new Error(
          `Deploy-time proxy grant missing: ${label}. ` +
          `Re-run scripts/deploy/index.ts:configureRoles or grant manually before continuing.`
        );
      }
      logger.info(`  [verified] ${label}`);
    }
  }

  // -------- Grant Cold Multisig roles --------
  logger.step(1, `Granting Cold Multisig (${cold}) roles`);
  for (const [name, roles] of coldMap) {
    const c = contracts[name];
    if (!c) continue;
    for (const role of roles) {
      await grantIfNeeded(`${name}.${role} → cold`, c, ROLES[role], cold, DRY_RUN);
    }
  }

  // -------- Grant Warm Multisig roles --------
  logger.step(2, `Granting Warm Multisig (${warm}) roles`);
  for (const [name, roles] of warmMap) {
    const c = contracts[name];
    if (!c) continue;
    for (const role of roles) {
      await grantIfNeeded(`${name}.${role} → warm`, c, ROLES[role], warm, DRY_RUN);
    }
  }

  // -------- Grant Orchestrator roles --------
  logger.step(3, `Granting Orchestrator (${orch}) roles`);
  for (const [name, roles] of orchMap) {
    const c = contracts[name];
    if (!c) continue;
    for (const role of roles) {
      await grantIfNeeded(`${name}.${role} → orch`, c, ROLES[role], orch, DRY_RUN);
    }
  }

  // -------- Revoke DEFAULT_ADMIN_ROLE from deployer --------
  logger.step(4, `Revoking deployer (${deployerAddress}) DEFAULT_ADMIN_ROLE`);
  logger.warning("  This step makes the Cold Multisig the sole meta-role holder.");
  logger.warning("  Verify ALL prior role grants succeeded before proceeding.");
  for (const [name, c] of Object.entries(contracts)) {
    await revokeIfNeeded(
      `${name}.DEFAULT_ADMIN_ROLE from deployer`,
      c, ROLES.DEFAULT_ADMIN_ROLE, deployerAddress, DRY_RUN
    );
  }

  logger.success("Done. Review the output above before declaring mainnet RBAC complete.");
  if (DRY_RUN) {
    logger.info("DRY_RUN=true — no transactions were broadcast.");
  }
}

main().catch(err => {
  logger.error(String(err));
  process.exit(1);
});
