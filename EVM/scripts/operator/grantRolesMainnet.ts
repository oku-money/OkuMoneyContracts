/**
 * Grant Roles — Mainnet RBAC Topology
 *
 * Implements the documented 3-key mainnet role distribution from README.md §RBAC,
 * across all five proxies of the two-token model:
 *
 *   Cold Multisig   → ADMIN, all UNPAUSER, all UNBLACKLISTER, all UPGRADER,
 *                     CAP_MANAGER (both tokens), ALLOWANCE_MANAGER,
 *                     BUFFER_WITHDRAWER, FEE_MANAGER, WRAPPER_ADMIN,
 *                     WRAPPER_RESERVE_MANAGER
 *   Warm Multisig   → all PAUSER, all BLACKLISTER, GUARDIAN (both tokens)
 *   Orchestrator    → OKU_RATE_SETTER (both tokens), PSM_QUEUE_PROCESSOR,
 *                     PSM_BUFFER_DEPOSITOR
 *
 * TWO THINGS ARE NEW IN v0.4 AND WORTH PAUSING ON:
 *
 *   1. `OKU_CAP_MANAGER` on OkuM now gates `resumeAccrual` — the only way to
 *      clear the guardian's sticky halt — as well as `setStepFeeSource` and
 *      `resetStepHighWaterMark`. On USDOku it gates `setSolvencySource`. It was
 *      a supply-cap role; it is now the cold counterweight to the warm
 *      guardian, which is a materially larger responsibility.
 *
 *   2. `PSM_FEE_MANAGER` stopped being a revenue dial. `tin + tout` is the
 *      step-coverage budget, so the cold key that holds this role controls
 *      whether the multiplier can move AT ALL. Cold must be reachable on the
 *      mark cadence, not just for emergencies.
 *
 * CONTRACT-ONLY ROLES ARE NOT IN ANY LIST: OKU_MINTER and OKU_BURNER (on OkuM →
 * SubscriptionModule and RedemptionQueue; on USDOku → USDOkuWrapper) and
 * QUEUE_PSM (→ SubscriptionModule) must remain on proxy addresses, granted at
 * deploy time via configureRoles. This script verifies those grants exist and
 * that no key holds them; either failure is fatal.
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
  // un-blacklist, the supply cap, the mint allowance, buffer withdrawal, the
  // fee schedule, the USDOku sunset, and — new in v0.4 — resuming a halted
  // multiplier.
  const coldRoles = new Map<string, RoleName[]>([
    ["OkuM", [
      "DEFAULT_ADMIN_ROLE",
      "OKU_UPGRADER",
      "OKU_UNPAUSER",
      "OKU_UNBLACKLISTER",
      // Now also: resumeAccrual, setStepFeeSource, resetStepHighWaterMark,
      // setSyncWindowDuration.
      "OKU_CAP_MANAGER",
      "OKU_ALLOWANCE_MANAGER",
    ]],
    ["USDOku", [
      "DEFAULT_ADMIN_ROLE",
      "OKU_UPGRADER",
      "OKU_UNPAUSER",
      "OKU_UNBLACKLISTER",
      // Gates setSolvencySource on this token. OKU_ALLOWANCE_MANAGER is absent:
      // USDOku has no minter-allowance system to manage.
      "OKU_CAP_MANAGER",
    ]],
    ["SubscriptionModule", [
      "DEFAULT_ADMIN_ROLE",
      "PSM_UPGRADER",
      "PSM_UNPAUSER",
      "PSM_BUFFER_WITHDRAWER",
      // The fee schedule IS the step-coverage budget: `tin + tout >= stepBps`
      // must hold for every multiplier step, so this cold key gates whether
      // yield can be marked at all. It stays on cold because it is economic
      // policy of the same class as the supply cap — but note the operational
      // consequence, which is that cold has to be reachable on the mark cadence
      // rather than only for incidents. It is a separate constant from
      // OKU_CAP_MANAGER only because AccessControl mappings are per-contract.
      "PSM_FEE_MANAGER",
    ]],
    ["RedemptionQueue", [
      "DEFAULT_ADMIN_ROLE",
      "QUEUE_UPGRADER",
      "QUEUE_RESCUER",
    ]],
    ["USDOkuWrapper", [
      "DEFAULT_ADMIN_ROLE",
      "WRAPPER_UPGRADER",
      "WRAPPER_UNPAUSER",
      // Sunset step 1 (`setWrapEnabled(false)`). Cold because retiring the
      // dollar leg is a policy decision with a public announcement attached,
      // not an incident response. There is deliberately NO role anywhere that
      // can disable `unwrap`.
      "WRAPPER_ADMIN",
      // Recovers genuinely excess OkuM backing once realized marks overtake
      // declared USDOku liability. Cold: moving capital is a treasury action,
      // not incident response, and the bound (never below full parity) is
      // enforced on-chain regardless of who holds the key.
      "WRAPPER_RESERVE_MANAGER",
    ]],
  ]);

  // WARM: levers that can only ever RESTRICT. Pause, blacklist, and the two
  // accrual halts. `OKU_GUARDIAN` belongs here rather than cold precisely
  // because it is monotone-safe — it withholds future yield but cannot reduce
  // anything already accrued, so the abuse ceiling is "yield pauses until cold
  // overrides". That is strictly better than being unable to stop a compromised
  // rate setter for as long as it takes to convene the cold multisig.
  //
  // Asymmetry worth knowing: the OkuM halt is STICKY (only cold's
  // resumeAccrual clears it) while the USDOku halt is not (the rate setter can
  // write a new rate immediately). So warm's durable lever is on the share
  // token, and halting USDOku is a stopgap that assumes the rate setter is
  // cooperative — if it is not, revoke the role.
  const warmRoles = new Map<string, RoleName[]>([
    ["OkuM", ["OKU_PAUSER", "OKU_BLACKLISTER", "OKU_GUARDIAN"]],
    ["USDOku", ["OKU_PAUSER", "OKU_BLACKLISTER", "OKU_GUARDIAN"]],
    ["SubscriptionModule", ["PSM_PAUSER"]],
    ["RedemptionQueue", []],
    // Pausing the wrapper closes the USER EXIT from USDOku, which is a stronger
    // action than any other warm lever in this table. It is still warm because
    // the alternative — needing cold to stop an active wrapper exploit — is
    // worse. Use wrapperSunset.ts (cold) for a planned wind-down.
    ["USDOkuWrapper", ["WRAPPER_PAUSER"]],
  ]);

  // ORCHESTRATOR (KMS-backed): the routine operational cadence only.
  // `OKU_RATE_SETTER` is the highest-value key in the system — it is an oracle
  // write, on both tokens, and the same constant covers both. On OkuM it is
  // bounded by monotonicity, MAX_STEP_BPS, step coverage and MAX_MULTIPLIER; on
  // USDOku by MAX_IMPLIED_APR, MAX_RATE_DURATION, monotonicity, MAX_MULTIPLIER
  // and the projected-solvency check. Vetoable on both by the warm guardian.
  const orchRoles = new Map<string, RoleName[]>([
    ["OkuM", ["OKU_RATE_SETTER"]],
    ["USDOku", ["OKU_RATE_SETTER"]],
    ["SubscriptionModule", ["PSM_QUEUE_PROCESSOR", "PSM_BUFFER_DEPOSITOR"]],
    ["RedemptionQueue", []],
    // Nothing. The wrapper has no routine operational write — wrap and unwrap
    // are permissionless, and everything else on it is policy.
    ["USDOkuWrapper", []],
  ]);

  return { cold: coldRoles, warm: warmRoles, orch: orchRoles };
}

/**
 * Roles that must be held by CONTRACTS and never by a key. Verified as
 * pre-existing grants rather than granted here.
 *
 * `holder` names another entry in the address book, so the pairing is resolved
 * from deployed addresses rather than from a hardcoded switch — the previous
 * version's `holder === "LitePSM" ? psmAddr : queueAddr` ternary silently
 * mapped every non-PSM holder to the queue, which happened to be correct with
 * two holders and would have been wrong the moment the wrapper was added.
 */
const CONTRACT_ROLE_EXPECTATIONS: Array<{
  contract: string;
  role: RoleName;
  holder: string;
}> = [
  { contract: "OkuM", role: "OKU_MINTER", holder: "SubscriptionModule" },
  { contract: "OkuM", role: "OKU_BURNER", holder: "SubscriptionModule" },
  { contract: "OkuM", role: "OKU_BURNER", holder: "RedemptionQueue" },
  { contract: "RedemptionQueue", role: "QUEUE_PSM", holder: "SubscriptionModule" },
  { contract: "USDOku", role: "OKU_MINTER", holder: "USDOkuWrapper" },
  { contract: "USDOku", role: "OKU_BURNER", holder: "USDOkuWrapper" },
];

/** Every proxy this script touches. Order is load-bearing only for logging. */
const MANAGED_CONTRACTS = [
  "OkuM",
  "USDOku",
  "SubscriptionModule",
  "RedemptionQueue",
  "USDOkuWrapper",
] as const;

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
  for (const name of MANAGED_CONTRACTS) {
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
  // OKU_MINTER / OKU_BURNER / QUEUE_PSM live on the SubscriptionModule,
  // RedemptionQueue and USDOkuWrapper proxies, never on a key. They are granted
  // in scripts/deploy/index.ts and must be present before this script runs.
  // Missing grants mean a fresh deploy is broken — fail loudly before touching
  // any role state.
  //
  // Requiring the FULL set to be present before checking is deliberate: a
  // partial address book means we cannot distinguish "this grant is missing"
  // from "we cannot see the holder", and reporting the former for the latter is
  // how a deploy gets re-run unnecessarily.
  const missingManaged = MANAGED_CONTRACTS.filter((n) => !contracts[n]);
  if (missingManaged.length > 0) {
    logger.warning(
      `  Skipping the contract-grant audit: ${missingManaged.join(", ")} not in the ` +
        `address book for ${bookKey}. Role grants below will still run for whatever ` +
        `IS present.`
    );
  } else {
    for (const expectation of CONTRACT_ROLE_EXPECTATIONS) {
      const target = contracts[expectation.contract];
      const holderContract = contracts[expectation.holder];
      if (!target || !holderContract) continue;
      const holder = await holderContract.getAddress();
      const has = await target.hasRole(ROLES[expectation.role], holder);
      const label = `${expectation.contract}.${expectation.role} on ${expectation.holder}`;
      if (!has) {
        throw new Error(
          `Deploy-time contract grant missing: ${label}. ` +
            `Re-run scripts/deploy/index.ts:configureRoles before continuing.`
        );
      }
      logger.info(`  [verified] ${label}`);
    }

    // And the inverse: no key may hold a contract-only role. Note this checks
    // per (contract, role) pair, so a key holding OKU_MINTER on USDOku is
    // caught independently of OkuM — the shared constant makes that a real and
    // easy mistake.
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

    // The fail-closed wiring is not a role, but a mainnet RBAC handover is the
    // last moment anyone looks at this deployment as a whole — and both of these
    // are silent when wrong (nothing reverts until the orchestrator's first
    // tick, which will be after the deployer key has been revoked).
    const feeSource: string = await (contracts.OkuM as any).stepFeeSource();
    const moduleAddr = await contracts.SubscriptionModule.getAddress();
    if (feeSource.toLowerCase() !== moduleAddr.toLowerCase()) {
      throw new Error(
        `okuM.stepFeeSource is ${feeSource}, expected ${moduleAddr}. Every ` +
          `setOkuMultiplier would revert StepNotCovered. Fix it BEFORE revoking the ` +
          `deployer's DEFAULT_ADMIN_ROLE — afterwards it needs the cold multisig.`
      );
    }
    const solvencySource: string = await (contracts.USDOku as any).solvencySource();
    const wrapperAddr = await contracts.USDOkuWrapper.getAddress();
    if (solvencySource.toLowerCase() !== wrapperAddr.toLowerCase()) {
      throw new Error(
        `usdOku.solvencySource is ${solvencySource}, expected ${wrapperAddr}. ` +
          `setUsdOkuRate would revert SolvencyGapExceeded once any USDOku exists.`
      );
    }
    const tin: bigint = await (contracts.SubscriptionModule as any).tin();
    const tout: bigint = await (contracts.SubscriptionModule as any).tout();
    if (tin + tout === 0n) {
      throw new Error(
        `tin + tout == 0, so no multiplier step of any size is possible ` +
          `(StepNotCovered). Set the fee schedule before handing the keys over — ` +
          `afterwards it requires the cold multisig holding PSM_FEE_MANAGER.`
      );
    }
    logger.info(
      `  [verified] fail-closed wiring: stepFeeSource, solvencySource, ` +
        `tin+tout=${tin + tout}bps`
    );
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
