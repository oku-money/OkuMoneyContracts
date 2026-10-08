/**
 * Grant Roles — Mainnet RBAC Topology
 *
 * Implements the documented 3-key mainnet role distribution from README.md §RBAC:
 *
 *   Cold Multisig   → ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER,
 *                     ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER,
 *                     VAULT_RESCUER
 *   Warm Multisig   → all PAUSER, all BLACKLISTER
 *   Orchestrator    → OKUM_REBASER, BUFFER_DEPOSITOR
 *
 * OKUM_MINTER and OKUM_BURNER are intentionally NOT in this list — they must
 * remain on the LitePSM proxy address, granted at deploy time via
 * configureRoles. This script verifies both on LitePSM before proceeding;
 * missing grants are fatal.
 *
 * Final steps: the deployer renounces every granular role `initialize` gave it
 * (minter, burner, upgraders, buffer withdrawer, ...), then its
 * DEFAULT_ADMIN_ROLE is revoked, making the Cold Multisig the sole meta-role
 * holder. The script ends by asserting with `hasRole` that the deployer holds
 * none of the roles in `expectedRoleGrants()` — a mainnet deployer key that
 * keeps OKUM_MINTER + OKUM_ALLOWANCE_MANAGER can mint without bound.
 *
 * REQUIRES the following environment variables:
 *   MAINNET_COLD_MULTISIG   — Cold multisig address (timelock / hardware wallet)
 *   MAINNET_WARM_MULTISIG   — Warm multisig address (day-to-day ops)
 *   MAINNET_ORCHESTRATOR    — Orchestrator KMS signer address
 *
 * Optional: CONFIRMATIONS=N (default 2) confirmations to wait per tx.
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
 * Safety: requires explicit opt-in on mainnet-beta networks (base, bsc). Set
 * YES_MAINNET=1 in the environment — the legacy --yes-mainnet CLI flag only
 * works via direct `ts-node` invocation, since Hardhat v2 rejects unknown CLI
 * flags under `hardhat run`.
 */

import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";
import { recordRoleGrant } from "../utils/roleRegistry";
import { isMainnetNetwork } from "../utils/mainnetGuard";
import { isDryRun } from "../utils/cli";
import { expectedRoleGrants } from "../deploy/index";

// ============================================================================
// Configuration — from environment (REQUIRED on mainnet)
// ============================================================================

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

// Re-read at the start of every run so in-process callers (the drill) can set it.
let DRY_RUN = isDryRun();
// Confirmations per tx: 2 on live chains (CONFIRMATIONS=N overrides), 1 on forks
// and the in-process network, which only mine on demand — waiting for 2 there
// never returns.
let CONFIRMATIONS = 2;
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
  const coldRoles = new Map<string, RoleName[]>([
    ["OkuMoney", [
      "DEFAULT_ADMIN_ROLE",
      "OKUM_UPGRADER",
      "OKUM_UNPAUSER",
      "OKUM_UNBLACKLISTER",
      "OKUM_CAP_MANAGER",
      "OKUM_ALLOWANCE_MANAGER",
    ]],
    ["OkuDollar", [
      "DEFAULT_ADMIN_ROLE",
      "VAULT_UPGRADER",
      "VAULT_UNPAUSER",
      // VAULT_RESCUER lives on the cold key: it moves donated OkuM out of the
      // vault, so it belongs with the other asset-withdrawing roles.
      "VAULT_RESCUER",
      "OKUM_UNBLACKLISTER",
    ]],
    ["LitePSM", [
      "DEFAULT_ADMIN_ROLE",
      "PSM_UPGRADER",
      "PSM_UNPAUSER",
      "PSM_BUFFER_WITHDRAWER",
    ]],
  ]);

  const warmRoles = new Map<string, RoleName[]>([
    ["OkuMoney", ["OKUM_PAUSER", "OKUM_BLACKLISTER"]],
    ["OkuDollar", ["VAULT_PAUSER", "OKUM_BLACKLISTER"]],
    ["LitePSM", ["PSM_PAUSER"]],
  ]);

  const orchRoles = new Map<string, RoleName[]>([
    // OKUM_REBASER is now the ONLY rate-setting role in the system: OkuDollar
    // derives its multiplier from OkuMoney, so there is no vault-side rebaser.
    ["OkuMoney", ["OKUM_REBASER"]],
    ["OkuDollar", []],
    ["LitePSM", ["PSM_BUFFER_DEPOSITOR"]],
  ]);

  return { cold: coldRoles, warm: warmRoles, orch: orchRoles };
}

// ============================================================================
// Helpers
// ============================================================================

async function confirmIfMainnet(networkName: string): Promise<void> {
  if (!isMainnetNetwork(networkName)) return;
  if (YES_MAINNET) {
    logger.warning(`YES_MAINNET set; skipping confirmation for ${networkName}`);
    return;
  }
  if (DRY_RUN) {
    logger.info("DRY_RUN=true; skipping mainnet confirmation");
    return;
  }
  // No stdin prompt: YES_MAINNET=1 is the only opt-in that survives
  // `hardhat run`, which rejects unknown CLI flags before the script runs.
  throw new Error(
    `Refusing to broadcast on ${networkName} without explicit YES_MAINNET opt-in.\n` +
    `Re-run with: YES_MAINNET=1 npx hardhat run ... --network ${networkName}`
  );
}

/**
 * Identity of a privilege mutation, carried so it can be written to the
 * durable grant ledger — see `utils/roleRegistry.ts`. The display `label`
 * alone is not enough: the grantee address must survive the terminal.
 */
interface GrantMeta {
  chain: string;
  contractName: string;
  roleName: string;
  granteeLabel: string;
  granter: string;
}

async function grantIfNeeded(
  label: string,
  contract: Contract,
  role: string,
  account: string,
  dryRun: boolean,
  meta: GrantMeta
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
  const receipt = await tx.wait(CONFIRMATIONS);
  logger.success(`  [granted] ${label}`);

  const rec = recordRoleGrant({
    at: new Date().toISOString(),
    chain: meta.chain,
    contract: meta.contractName,
    contractAddress: await contract.getAddress(),
    role: meta.roleName,
    roleHash: role,
    grantee: account,
    granteeLabel: meta.granteeLabel,
    action: "grant",
    granter: meta.granter,
    txHash: receipt.hash,
    script: "operator/grantRolesMainnet.ts",
  });
  if (!rec.ok) logger.warning(`  granted, but LEDGER WRITE FAILED: ${rec.error}`);
}

async function revokeIfNeeded(
  label: string,
  contract: Contract,
  role: string,
  account: string,
  dryRun: boolean,
  meta: GrantMeta
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
  const receipt = await tx.wait(CONFIRMATIONS);
  logger.warning(`  [revoked] ${label}`);

  // Revocations are recorded too — the ledger is append-only, and "who used
  // to hold DEFAULT_ADMIN_ROLE, and when did they stop" is exactly the
  // question an incident review asks. `deriveLedgerHolders` replays these in
  // order, so the revoke correctly removes the holder from the derived set.
  const rec = recordRoleGrant({
    at: new Date().toISOString(),
    chain: meta.chain,
    contract: meta.contractName,
    contractAddress: await contract.getAddress(),
    role: meta.roleName,
    roleHash: role,
    grantee: account,
    granteeLabel: meta.granteeLabel,
    action: "revoke",
    granter: meta.granter,
    txHash: receipt.hash,
    script: "operator/grantRolesMainnet.ts",
  });
  if (!rec.ok) logger.warning(`  revoked, but LEDGER WRITE FAILED: ${rec.error}`);
}

/** `expectedRoleGrants()` contract key -> address-book name. */
const MATRIX_CONTRACT: Record<string, string> = {
  okuMoney: "OkuMoney",
  okuDollar: "OkuDollar",
  litePSM: "LitePSM",
};

/**
 * Every (contract, role) `initialize` gave the deployer, from the deploy
 * script's own matrix — not a hand-copied list that can drift.
 */
export function deployerInitRoles(): Array<{ contractName: string; roleName: RoleName }> {
  return expectedRoleGrants()
    .filter((g) => g.via === "initialize")
    .map((g) => {
      const roleName = (Object.keys(ROLES) as RoleName[]).find((k) => ROLES[k] === g.role);
      if (!roleName) throw new Error(`unknown role hash in expectedRoleGrants(): ${g.role}`);
      return { contractName: MATRIX_CONTRACT[g.contract], roleName };
    });
}

// ============================================================================
// Main
// ============================================================================

/** Distribute roles to the cold/warm/orchestrator keys, then strip every role from the deployer. */
export async function runGrantRolesMainnet(): Promise<void> {
  DRY_RUN = isDryRun();
  const ctx = await resolveNetworkContext();
  CONFIRMATIONS =
    ctx.isFork || network.name === "hardhat" ? 1 : Number(process.env.CONFIRMATIONS ?? 2);
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

  // Forks are throwaway rehearsals of the chain (same exemption as deploy).
  if (!ctx.isFork) await confirmIfMainnet(networkName);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  logger.info(`  Deployer (signer): ${deployerAddress}`);

  // The deployer renounces everything below; if it is also a target key it
  // would strip the roles it was just granted.
  for (const [label, addr] of [["cold", cold], ["warm", warm], ["orchestrator", orch]]) {
    if (addr.toLowerCase() === deployerAddress.toLowerCase()) {
      throw new Error(`The ${label} key must not be the deployer (${deployerAddress})`);
    }
  }

  const { cold: coldMap, warm: warmMap, orch: orchMap } = buildRoleMap(cold, warm, orch);

  const contracts: Record<string, Contract> = {};
  for (const name of ["OkuMoney", "OkuDollar", "LitePSM"]) {
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
  // EVM-A1: OKUM_MINTER and OKUM_BURNER live on the LitePSM proxy (not EOAs),
  // granted in scripts/deploy/index.ts. Missing grants here mean a fresh
  // deploy is broken — fail loudly before we touch any role state.
  if (contracts.OkuMoney && contracts.LitePSM) {
    const okuMoney = contracts.OkuMoney;
    const psmAddr = await contracts.LitePSM.getAddress();
    const checks: Array<[string, Contract, string, string]> = [
      ["OKUM_MINTER on LitePSM", okuMoney, ROLES.OKUM_MINTER, psmAddr],
      ["OKUM_BURNER on LitePSM", okuMoney, ROLES.OKUM_BURNER, psmAddr],
    ];
    for (const [label, contract, role, account] of checks) {
      const has = await contract.hasRole(role, account);
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
      await grantIfNeeded(`${name}.${role} → cold`, c, ROLES[role], cold, DRY_RUN, {
        chain: bookKey, contractName: name, roleName: role,
        granteeLabel: "MAINNET_COLD_MULTISIG", granter: deployerAddress,
      });
    }
  }

  // -------- Grant Warm Multisig roles --------
  logger.step(2, `Granting Warm Multisig (${warm}) roles`);
  for (const [name, roles] of warmMap) {
    const c = contracts[name];
    if (!c) continue;
    for (const role of roles) {
      await grantIfNeeded(`${name}.${role} → warm`, c, ROLES[role], warm, DRY_RUN, {
        chain: bookKey, contractName: name, roleName: role,
        granteeLabel: "MAINNET_WARM_MULTISIG", granter: deployerAddress,
      });
    }
  }

  // -------- Grant Orchestrator roles --------
  logger.step(3, `Granting Orchestrator (${orch}) roles`);
  for (const [name, roles] of orchMap) {
    const c = contracts[name];
    if (!c) continue;
    for (const role of roles) {
      await grantIfNeeded(`${name}.${role} → orch`, c, ROLES[role], orch, DRY_RUN, {
        chain: bookKey, contractName: name, roleName: role,
        granteeLabel: "MAINNET_ORCHESTRATOR", granter: deployerAddress,
      });
    }
  }

  // -------- Revoke DEFAULT_ADMIN_ROLE from deployer --------
  logger.step(4, `Revoking deployer (${deployerAddress}) roles`);
  logger.warning("  This step makes the Cold Multisig the sole meta-role holder.");

  // Verified, not merely warned about: this is the one irreversible step in the
  // script. If the cold multisig does not already hold DEFAULT_ADMIN_ROLE on a
  // contract, revoking the deployer's leaves that contract with NO admin and no
  // way to grant one. A contract missing from the address book is skipped by the
  // grant loops above but would still be revoked here, so check every one.
  const adminless: string[] = [];
  for (const [name, c] of Object.entries(contracts)) {
    if (!(await c.hasRole(ROLES.DEFAULT_ADMIN_ROLE, cold))) adminless.push(name);
  }
  if (adminless.length > 0 && DRY_RUN) {
    // Expected in a dry run: step 1 only printed the grants.
    logger.info(`  [dry-run] cold multisig not yet admin on ${adminless.join(", ")} (step 1 not broadcast)`);
  } else if (adminless.length > 0) {
    throw new Error(
      `Refusing to revoke deployer admin: cold multisig ${cold} does NOT hold ` +
        `DEFAULT_ADMIN_ROLE on ${adminless.join(", ")}. Revoking now would leave ` +
        `${adminless.length === 1 ? "that contract" : "those contracts"} permanently ` +
        `without an admin. Re-run step 1 and confirm it succeeded.`
    );
  } else {
    logger.success(`  Verified cold multisig holds DEFAULT_ADMIN_ROLE on all ${Object.keys(contracts).length} contracts`);
  }

  // Granular roles first, then DEFAULT_ADMIN_ROLE last.
  // Done while the deployer is still admin, so a partial failure leaves it
  // able to finish. renounceRole needs no admin rights (msg.sender == account).
  for (const { contractName, roleName } of deployerInitRoles()) {
    if (roleName === "DEFAULT_ADMIN_ROLE") continue; // revoked below
    const c = contracts[contractName];
    if (!c) continue;
    const role = ROLES[roleName];
    const label = `${contractName}.${roleName} renounced by deployer`;
    if (!(await c.hasRole(role, deployerAddress))) {
      logger.info(`  [already gone] ${label}`);
      continue;
    }
    if (DRY_RUN) {
      logger.info(`  [dry-run] WOULD renounce ${label}`);
      continue;
    }
    const receipt = await (await c.renounceRole(role, deployerAddress)).wait(CONFIRMATIONS);
    logger.warning(`  [renounced] ${label}`);
    const rec = recordRoleGrant({
      at: new Date().toISOString(),
      chain: bookKey,
      contract: contractName,
      contractAddress: await c.getAddress(),
      role: roleName,
      roleHash: role,
      grantee: deployerAddress,
      granteeLabel: "DEV_WALLET / deployer-admin",
      action: "revoke",
      granter: deployerAddress,
      txHash: receipt.hash,
      script: "operator/grantRolesMainnet.ts",
    });
    if (!rec.ok) logger.warning(`  renounced, but LEDGER WRITE FAILED: ${rec.error}`);
  }

  for (const [name, c] of Object.entries(contracts)) {
    await revokeIfNeeded(
      `${name}.DEFAULT_ADMIN_ROLE from deployer`,
      c, ROLES.DEFAULT_ADMIN_ROLE, deployerAddress, DRY_RUN,
      {
        chain: bookKey, contractName: name, roleName: "DEFAULT_ADMIN_ROLE",
        granteeLabel: "DEV_WALLET / deployer-admin", granter: deployerAddress,
      }
    );
  }

  if (DRY_RUN) {
    logger.info("DRY_RUN=true — no transactions were broadcast.");
    return;
  }

  // -------- Assert: the deployer holds nothing --------
  logger.step(5, "Verifying the deployer holds no role on any contract");
  const leftover: string[] = [];
  for (const { contractName, roleName } of deployerInitRoles()) {
    const c = contracts[contractName];
    if (c && (await c.hasRole(ROLES[roleName], deployerAddress))) {
      leftover.push(`${contractName}.${roleName}`);
    }
  }
  if (leftover.length > 0) {
    throw new Error(`Deployer still holds: ${leftover.join(", ")}`);
  }
  logger.success("  Deployer holds no roles. Review the output above before declaring mainnet RBAC complete.");
}

if (require.main === module) {
  runGrantRolesMainnet().then(
    () => process.exit(0),
    (err) => {
      logger.error(String(err));
      process.exit(1);
    }
  );
}
