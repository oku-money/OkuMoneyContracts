/**
 * Grant Roles — Mainnet RBAC Topology
 *
 * Implements the documented 3-key mainnet role distribution from README.md §RBAC:
 *
 *   Cold Multisig   → ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER,
 *                     ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER,
 *                     RESERVE_MANAGER
 *   Warm Multisig   → all PAUSER, all BLACKLISTER
 *   Orchestrator    → OKU_RATE_SETTER, PSM_QUEUE_PROCESSOR, PSM_BUFFER_DEPOSITOR
 *
 * QUEUE_PSM is intentionally NOT in this list — it must remain on the LitePSM
 * proxy address (set at deploy time via configureRoles).
 *
 * OKU_MINTER, OKU_BURNER and QUEUE_PSM are likewise intentionally
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
  // COLD: everything irreversible or value-bearing. Upgrades, un-pause,
  // un-blacklist, the supply cap, the mint allowance, buffer withdrawal.
  const coldRoles = new Map<string, RoleName[]>([
    ["OkuDollar", [
      "DEFAULT_ADMIN_ROLE",
      "OKU_UPGRADER",
      "OKU_UNPAUSER",
      "OKU_UNBLACKLISTER",
      "OKU_CAP_MANAGER",
      "OKU_ALLOWANCE_MANAGER",
    ]],
    ["LitePSM", [
      "DEFAULT_ADMIN_ROLE",
      "PSM_UPGRADER",
      "PSM_UNPAUSER",
      "PSM_BUFFER_WITHDRAWER",
    ]],
    ["RedemptionQueue", [
      "DEFAULT_ADMIN_ROLE",
      "QUEUE_UPGRADER",
      "QUEUE_RESCUER",
    ]],
  ]);

  // WARM: levers that can only ever RESTRICT. Pause, blacklist, and
  // haltAccrual. `OKU_GUARDIAN` belongs here rather than cold precisely because
  // it is monotone-safe — it stops the multiplier growing but cannot reduce
  // anything already accrued, so the abuse ceiling is "yield pauses until cold
  // overrides". That is strictly better than being unable to stop a compromised
  // rate setter for as long as it takes to convene the cold multisig.
  const warmRoles = new Map<string, RoleName[]>([
    ["OkuDollar", ["OKU_PAUSER", "OKU_BLACKLISTER", "OKU_GUARDIAN"]],
    ["LitePSM", ["PSM_PAUSER"]],
    ["RedemptionQueue", []],
  ]);

  // ORCHESTRATOR (KMS-backed): the routine operational cadence only.
  // `OKU_RATE_SETTER` is the highest-value key in the system — it is an oracle
  // write. It is bounded on-chain by MAX_IMPLIED_APR, MAX_RATE_DURATION,
  // monotonicity and MAX_MULTIPLIER, and vetoable by the warm guardian.
  const orchRoles = new Map<string, RoleName[]>([
    ["OkuDollar", ["OKU_RATE_SETTER"]],
    ["LitePSM", ["PSM_QUEUE_PROCESSOR", "PSM_BUFFER_DEPOSITOR"]],
    ["RedemptionQueue", []],
  ]);

  return { cold: coldRoles, warm: warmRoles, orch: orchRoles };
}

/**
 * Roles that must be held by CONTRACTS and never by a key. Verified as
 * pre-existing grants rather than granted here:
 *   OKU_MINTER  -> LitePSM
 *   OKU_BURNER  -> LitePSM, RedemptionQueue
 *   QUEUE_PSM   -> LitePSM
 */
const CONTRACT_ROLE_EXPECTATIONS: Array<{
  contract: string;
  role: RoleName;
  holder: string;
}> = [
  { contract: "OkuDollar", role: "OKU_MINTER", holder: "LitePSM" },
  { contract: "OkuDollar", role: "OKU_BURNER", holder: "LitePSM" },
  { contract: "OkuDollar", role: "OKU_BURNER", holder: "RedemptionQueue" },
  { contract: "RedemptionQueue", role: "QUEUE_PSM", holder: "LitePSM" },
];

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
  for (const name of ["OkuDollar", "OkuDollar", "LitePSM", "RedemptionQueue"]) {
    let addr: string;
    try {
      addr = loadAddress(bookKey, name);
    } catch {
      logger.warning(`  Skipping ${name} — not found in address book for ${bookKey}`);
      continue;
    }
    contracts[name] = await getDeployedContract(name, addr);
  }

  // -------- Sanity check: deploy-time contract grants must already exist --------
  // OKU_MINTER / OKU_BURNER / QUEUE_PSM live on the LitePSM and RedemptionQueue
  // proxies, never on a key. They are granted in scripts/deploy/index.ts and must
  // be present before this script runs. Missing grants mean a fresh deploy is
  // broken — fail loudly before touching any role state.
  if (contracts.OkuDollar && contracts.LitePSM && contracts.RedemptionQueue) {
    const psmAddr = await contracts.LitePSM.getAddress();
    const queueAddr = await contracts.RedemptionQueue.getAddress();

    for (const expectation of CONTRACT_ROLE_EXPECTATIONS) {
      const target = contracts[expectation.contract];
      if (!target) continue;
      const holder = expectation.holder === "LitePSM" ? psmAddr : queueAddr;
      const has = await target.hasRole(ROLES[expectation.role], holder);
      const label = `${expectation.role} on ${expectation.holder}`;
      if (!has) {
        throw new Error(
          `Deploy-time contract grant missing: ${label}. ` +
            `Re-run scripts/deploy/index.ts:configureRoles before continuing.`
        );
      }
      logger.info(`  [verified] ${label}`);
    }

    // And the inverse: no key may hold a contract-only role.
    for (const key of [cold, warm, orch]) {
      if (!key) continue;
      for (const expectation of CONTRACT_ROLE_EXPECTATIONS) {
        const target = contracts[expectation.contract];
        if (!target) continue;
        if (await target.hasRole(ROLES[expectation.role], key)) {
          throw new Error(
            `SEPARATION-OF-DUTIES VIOLATION: key ${key} holds ${expectation.role} on ` +
              `${expectation.contract}. Contract-only roles must never be held by a key.`
          );
        }
      }
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
