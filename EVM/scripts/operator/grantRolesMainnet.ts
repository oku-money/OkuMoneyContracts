/**
 * Grant Roles — Mainnet RBAC Topology
 *
 * Implements the documented 3-key mainnet role distribution from README.md §RBAC:
 *
 *   Cold Multisig   → ADMIN, all UPGRADER, all UNPAUSER, all UNBLACKLISTER,
 *                     CAP_MANAGER, ALLOWANCE_MANAGER, ACCRUAL_RESUMER,
 *                     WRAPPER_ADMIN, SUB_FEE_MANAGER, SUB_TREASURY_MANAGER
 *   Warm Multisig   → all PAUSER, all BLACKLISTER, OKU_GUARDIAN, SUB_SWEEPER
 *   Orchestrator    → OKU_RATE_SETTER, REQUEST_FULFILLER
 *
 * OKU_RATE_SETTER and REQUEST_FULFILLER both sit on the orchestrator but are
 * deliberately SEPARATE roles: one can misprice, the other can convert, and a
 * single compromised key must not be able to do both. Use DISTINCT KEYS in
 * production, not merely distinct role constants.
 *
 * OKU_MINTER / OKU_BURNER are intentionally NOT in this list — they must remain
 * on the SubscriptionModule (for OkuM) and USDOkuWrapper (for USDOku) proxy
 * addresses, granted at deploy time via configureRoles. This script verifies
 * those grants exist AND that no human key holds them; either failure is fatal.
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
import { ROLES, CONTRACT_ONLY_ROLES } from "../config/roles";
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
  // COLD: everything that can change the rules, plus every "un-" counterpart.
  // The un-roles are cold precisely so a compromised warm key can stop the
  // protocol but never restart it.
  const coldRoles = new Map<string, RoleName[]>([
    ["OkuM", [
      "DEFAULT_ADMIN_ROLE",
      "OKU_UPGRADER",
      "OKU_UNPAUSER",
      "OKU_UNBLACKLISTER",
      "OKU_CAP_MANAGER",
      "OKU_ALLOWANCE_MANAGER",
      "OKU_ACCRUAL_RESUMER",
    ]],
    ["USDOku", [
      "DEFAULT_ADMIN_ROLE",   // also gates the one-time setWrapper wiring
      "USD_UPGRADER",
      "USD_UNPAUSER",
      "OKU_UNBLACKLISTER",
      "OKU_ACCRUAL_RESUMER",
    ]],
    ["USDOkuWrapper", [
      "DEFAULT_ADMIN_ROLE",
      "WRAPPER_UPGRADER",
      // WRAPPER_ADMIN gates BOTH the sunset toggle and withdrawSurplus, which
      // is the only path other than unwrap by which OkuM leaves the wrapper.
      "WRAPPER_ADMIN",
    ]],
    ["SubscriptionModule", [
      "DEFAULT_ADMIN_ROLE",
      "SUB_UPGRADER",
      "SUB_UNPAUSER",
      "SUB_FEE_MANAGER",
      "SUB_TREASURY_MANAGER",
    ]],
  ]);

  // WARM: stop-only levers. None of these can move value or change a price.
  const warmRoles = new Map<string, RoleName[]>([
    ["OkuM", ["OKU_PAUSER", "OKU_BLACKLISTER", "OKU_GUARDIAN"]],
    ["USDOku", ["USD_PAUSER", "OKU_BLACKLISTER", "OKU_GUARDIAN"]],
    ["USDOkuWrapper", []],
    ["SubscriptionModule", ["SUB_PAUSER", "SUB_SWEEPER"]],
  ]);

  // ORCHESTRATOR: the two value-path capabilities, deliberately SPLIT.
  // OKU_RATE_SETTER can misprice but not convert; REQUEST_FULFILLER can convert
  // but not misprice. Honour this with DISTINCT KEYS in production, not just
  // distinct role constants - the separation is the whole point.
  const orchRoles = new Map<string, RoleName[]>([
    ["OkuM", ["OKU_RATE_SETTER"]],
    ["USDOku", ["OKU_RATE_SETTER"]],
    ["USDOkuWrapper", []],
    ["SubscriptionModule", ["REQUEST_FULFILLER"]],
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
  for (const name of ["OkuM", "USDOku", "USDOkuWrapper", "SubscriptionModule"]) {
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
  // OKU_MINTER / OKU_BURNER are CONTRACT-ONLY and scoped PER TOKEN:
  //   SubscriptionModule holds them on OkuM   (mints on fulfilled subscription,
  //                                            burns escrow on fulfilled redemption)
  //   USDOkuWrapper      holds them on USDOku (mints on wrap, burns on unwrap)
  // They are granted in scripts/deploy/index.ts. Missing grants mean a broken
  // deploy — fail before touching any role state.
  if (contracts.OkuM && contracts.SubscriptionModule) {
    const moduleAddr = await contracts.SubscriptionModule.getAddress();
    for (const [label, role] of [
      ["OKU_MINTER on OkuM -> SubscriptionModule", ROLES.OKU_MINTER],
      ["OKU_BURNER on OkuM -> SubscriptionModule", ROLES.OKU_BURNER],
    ] as Array<[string, string]>) {
      if (!(await contracts.OkuM.hasRole(role, moduleAddr))) {
        throw new Error(
          `Deploy-time proxy grant missing: ${label}. ` +
          `Re-run scripts/deploy/index.ts:configureRoles before continuing.`
        );
      }
      logger.info(`  [verified] ${label}`);
    }
  }
  if (contracts.USDOku && contracts.USDOkuWrapper) {
    const wrapperAddr = await contracts.USDOkuWrapper.getAddress();
    for (const [label, role] of [
      ["OKU_MINTER on USDOku -> USDOkuWrapper", ROLES.OKU_MINTER],
      ["OKU_BURNER on USDOku -> USDOkuWrapper", ROLES.OKU_BURNER],
    ] as Array<[string, string]>) {
      if (!(await contracts.USDOku.hasRole(role, wrapperAddr))) {
        throw new Error(
          `Deploy-time proxy grant missing: ${label}. ` +
          `Re-run scripts/deploy/index.ts:configureRoles before continuing.`
        );
      }
      logger.info(`  [verified] ${label}`);
    }

    // USDOku must be wired to the wrapper or every positive rate reverts.
    const wired = (await contracts.USDOku.wrapper()).toLowerCase();
    if (wired !== wrapperAddr.toLowerCase()) {
      throw new Error(
        `USDOku.wrapper() is ${wired}, expected ${wrapperAddr}. Run setWrapper before continuing.`
      );
    }
    logger.info("  [verified] USDOku wired to USDOkuWrapper");
  }

  // -------- Separation of duties: no human key may hold a contract-only role --
  // This is the check that fails the run rather than warning. A cold, warm or
  // orchestrator key holding mint/burn would collapse the whole authority model.
  {
    const humanKeys: Array<[string, string]> = [["cold", cold], ["warm", warm], ["orchestrator", orch]];
    const tokenTargets: Array<[string, any]> = [];
    if (contracts.OkuM) tokenTargets.push(["OkuM", contracts.OkuM]);
    if (contracts.USDOku) tokenTargets.push(["USDOku", contracts.USDOku]);

    for (const [tokenName, token] of tokenTargets) {
      for (const roleName of CONTRACT_ONLY_ROLES) {
        for (const [keyLabel, keyAddr] of humanKeys) {
          if (await token.hasRole(ROLES[roleName], keyAddr)) {
            throw new Error(
              `SEPARATION OF DUTIES VIOLATION: ${keyLabel} key ${keyAddr} holds ` +
              `${roleName} on ${tokenName}. Revoke it before continuing.`
            );
          }
        }
      }
    }
    logger.success("  [verified] no human key holds OKU_MINTER / OKU_BURNER");
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
