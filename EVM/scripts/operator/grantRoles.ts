/**
 * Grant Operational Roles to Master EOA ("operate, don't own")
 *
 * Idempotently grants MASTER_EOA the operational roles listed in ROLE_MAP
 * (mint/burn OkuM, rebase, pause, blacklist, caps/allowances, PSM buffer) and
 * sets its OkuM minter allowance so the mint grant is usable. It never grants
 * `DEFAULT_ADMIN_ROLE` or any `*_UPGRADER` role; those stay on the deployer
 * key, whose admin role is also the backstop for revoking everything here.
 * EVM mirror of SVM's `scripts/admin/grant-roles.ts --delegate=<pubkey>`; role
 * mapping in `../../../README.md § RBAC`.
 *
 * TESTNET ONLY. OKUM_MINTER + OKUM_ALLOWANCE_MANAGER + OKUM_CAP_MANAGER on one
 * key leaves its minting unbounded (`configureMinterAllowance` and
 * `setMaxSupply` are both role-gated, so it can raise its own allowance and
 * the global cap), and PSM_BUFFER_WITHDRAWER can drain the PSM USDC buffer.
 * That contradicts the mainnet model (see `../../README.md`), where the
 * orchestrator has no mint authority; `assertNotMainnet` refuses mainnet with
 * no override. Mainnet uses the split topology in `grantRolesMainnet.ts`.
 *
 * Usage:
 *   npx hardhat run scripts/operator/grantRoles.ts \
 *     --network <baseSepolia|sepolia|arbSepolia|bscTestnet>
 *
 *   # Preview without broadcasting (works on any chain, no PRIVATE_KEY needed):
 *   DRY_RUN=1 npx hardhat run scripts/operator/grantRoles.ts --network arbSepolia
 *
 *   # Fork (auto-detects target chain from the running node, or pass NETWORK=…):
 *   NETWORK=base npx hardhat run scripts/operator/grantRoles.ts --network localhost
 *
 *   # Mainnet is refused outright — use grantRolesMainnet.ts instead.
 *
 * Environment knobs (live networks only; forks are unaffected):
 *   MASTER_EOA        override the delegate address (default: the shared
 *                      testnet operator EOA below)
 *   MINTER_ALLOWANCE  override the 18-decimal OkuM allowance granted to
 *                      MASTER_EOA (default: 1,000,000 OkuM)
 *   CONFIRMATIONS=N   confirmations to wait per tx (default 2)
 *   SETTLE_MS=N       extra ms to sleep after each mined tx before the next
 *                      hasRole read (default 1500; set 0 to disable)
 *   DRY_RUN=1         print planned grants without broadcasting (safe on any
 *                      chain, no PRIVATE_KEY required — uses a read-only
 *                      VoidSigner)
 */

import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { hasAddress, loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";
import { DEV_WALLET_ADDRESS, MASTER_OPERATOR_EOA } from "../config/chains";
import { isMainnetNetwork } from "../utils/mainnetGuard";
import { runConfigureMinterAllowance } from "./configureMinterAllowance";
import { recordRoleGrant, roleGrantsPath } from "../utils/roleRegistry";
import { isDryRun } from "../utils/cli";

// ============================================================================
// Configuration
// ============================================================================

/**
 * EOA that receives the bounded operational role set. Override via the
 * MASTER_EOA env var. Default is the shared testnet operator EOA, controlled
 * by the backend engineer operating this deployment — NOT by this
 * repo/deployer. On mainnet use grantRolesMainnet.ts with
 * MAINNET_COLD_MULTISIG / MAINNET_WARM_MULTISIG / MAINNET_ORCHESTRATOR.
 */
const MASTER_EOA = MASTER_OPERATOR_EOA;

/** EOA that holds DEFAULT_ADMIN_ROLE today (the deployer / dev wallet). */
const ADMIN_EOA = DEV_WALLET_ADDRESS;

/**
 * Minter allowance granted to MASTER_EOA (18-decimal OkuM). Mirrors SVM's
 * `DIRECT_MINTER_ALLOWANCE` (1,000,000 OkuM): bounds the blast radius of a
 * direct-mint role between resets by OKUM_ALLOWANCE_MANAGER.
 */
const MINTER_ALLOWANCE = process.env.MINTER_ALLOWANCE
  ? BigInt(process.env.MINTER_ALLOWANCE)
  : ethers.parseEther("1000000");

/**
 * Number of confirmations to wait per tx on live networks. ≥1 suffices for
 * nonce correctness; higher values stabilise the post-tx `hasRole` reads on
 * chains with longer reorg windows (e.g. BSC). Forks always use 1.
 */
const LIVE_CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 2);

/**
 * Settle delay (ms) inserted AFTER each tx is mined on live networks, before
 * the next iteration's `hasRole` read. Helps against load-balanced RPCs that
 * briefly serve stale state from a follower node. Defaults to 1500ms; set
 * SETTLE_MS=0 to disable. No-op on forks.
 */
const LIVE_SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500);

/** DRY_RUN=true prints planned grants without broadcasting. */
const DRY_RUN = isDryRun();

/**
 * Mainnet gate: testnet-only by design (see module doc), with no opt-in
 * override unlike `grantRolesMainnet.ts`.
 */
function assertNotMainnet(networkName: string) {
  if (!isMainnetNetwork(networkName)) return;
  if (DRY_RUN) return; // dry-run is always safe
  throw new Error(
    `Refusing to broadcast on ${networkName}. This script grants direct ` +
    `OKUM_MINTER/OKUM_BURNER to an EOA (MASTER_EOA), which is a testnet-only ` +
    `parity shortcut that contradicts the documented mainnet threat model ` +
    `("orchestrator key has no special minting authority on EVM" — see ` +
    `../../README.md § RBAC). Use grantRolesMainnet.ts for any network ` +
    `carrying real funds.`
  );
}

type RoleName = keyof typeof ROLES;

/**
 * Map of contract name (as it appears in addresses.json) → operational roles
 * to grant to MASTER_EOA. Contracts with nothing to grant are simply absent;
 * the grant loop below only visits contracts listed here. DEFAULT_ADMIN_ROLE
 * is deliberately not in any entry.
 */
const ROLE_MAP: Record<string, readonly RoleName[]> = {
  OkuMoney: [
    "OKUM_RATE_MANAGER",
    // Testnet-only parity with SVM's direct_minter/direct_burner.
    "OKUM_MINTER",
    "OKUM_BURNER",
    // Circuit breakers, so an operator can respond to an incident without
    // waking the admin key.
    "OKUM_PAUSER",
    "OKUM_UNPAUSER",
    // Compliance actions.
    "OKUM_BLACKLISTER",
    "OKUM_UNBLACKLISTER",
    // Supply/allowance administration. With OKUM_MINTER this removes every
    // on-chain ceiling on this key's minting (see module doc).
    "OKUM_CAP_MANAGER",
    "OKUM_ALLOWANCE_MANAGER",
  ],
  OkuDollar: [
    "VAULT_PAUSER",
    "VAULT_UNPAUSER",
    // Withdraws OkuM donated directly to the vault.
    "VAULT_RESCUER",
    // Roles are per-contract: OkuMoney's blacklist grants do not cover OkuDollar.
    "OKUM_BLACKLISTER",
    "OKUM_UNBLACKLISTER",
  ],
  LitePSM: [
    "PSM_BUFFER_DEPOSITOR",
    "PSM_PAUSER",
    "PSM_UNPAUSER",
    // Lets the operator pull USDC out of the PSM buffer.
    "PSM_BUFFER_WITHDRAWER",
  ],
};

// ============================================================================
// Types
// ============================================================================

type GrantStatus = "granted" | "already" | "would_grant" | "skipped" | "error";

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

  if (primary && primary.address.toLowerCase() === ADMIN_EOA.toLowerCase()) {
    return primary;
  }

  if (!isFork) {
    // DRY_RUN on live: no broadcast happens, so the live signer doesn't need
    // to match ADMIN_EOA. We still need *a* signer for `contract.connect()`
    // and the per-contract `hasRole(ADMIN_EOA, ...)` read, and `primary` may
    // be undefined when PRIVATE_KEY isn't configured.
    if (DRY_RUN) {
      // VoidSigner so any accidental write call fails loudly instead of
      // silently sending.
      const voidSigner = new ethers.VoidSigner(ADMIN_EOA, ethers.provider);
      logger.warning(
        `DRY_RUN: no live admin private key required; using read-only VoidSigner for ${ADMIN_EOA}`
      );
      return voidSigner;
    }
    throw new Error(
      `Active hardhat signer is ${primary?.address ?? "<none>"} but DEFAULT_ADMIN_ROLE is held by ${ADMIN_EOA}.\n` +
        `  Set the PRIVATE_KEY env (or the network's accounts entry in hardhat.config.ts) ` +
        `to the admin EOA's key and re-run, or pass DRY_RUN=1 for a non-broadcasting preview.`
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
 * Not `waitForTx` from utils/deploy.ts: that waits 1 confirmation, but on
 * chains with longer reorg windows (BSC in particular) we want a deeper buffer
 * before trusting the post-tx `hasRole` read on the next iteration. Forks
 * confirm instantly so 1 conf is always enough there.
 *
 * The caller's sequential `await` prevents nonce collisions — safe only as
 * long as no other process sends txs from the same EOA concurrently.
 */
async function sendAndConfirm(
  txPromise: Promise<any>,
  description: string,
  isFork: boolean
): Promise<string> {
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
  return receipt.hash;
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
  isFork: boolean,
  bookKey: string
): Promise<GrantResult[]> {
  const results: GrantResult[] = [];

  // Sanity-check the signer holds DEFAULT_ADMIN_ROLE on this contract before
  // attempting any grant — fail early with a clear message. Note we are not
  // GRANTING DEFAULT_ADMIN_ROLE to MASTER_EOA; the signer needs to hold it
  // itself in order to call grantRole() on OZ AccessControl at all.
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

      if (DRY_RUN) {
        // DRY_RUN: do NOT broadcast, just record what would have been sent.
        // The `hasRole` read above already confirmed the grant is needed, so
        // the would_grant count accurately previews the live run's tx count.
        // No gas probe: estimateGas needs a signer holding DEFAULT_ADMIN_ROLE
        // on every contract, which a non-fork dry run typically lacks.
        results.push({ contract: contractName, role: roleName, status: "would_grant" });
        logger.info(`  [${contractName}] ${roleName}: would grant (DRY_RUN)`);
        continue;
      }

      const txHash = await sendAndConfirm(
        contract.grantRole(roleHash, MASTER_EOA),
        `[${contractName}] grantRole(${roleName})`,
        isFork
      );
      results.push({ contract: contractName, role: roleName, status: "granted" });

      // Record the grantee DURABLY: `AccessControlUpgradeable` keeps no
      // queryable member list to recover it from — see utils/roleRegistry.ts.
      // Forks are excluded; their state is thrown away, so recording it would
      // pollute the ledger with grants that never existed on a real chain.
      if (!isFork) {
        const rec = recordRoleGrant({
          at: new Date().toISOString(),
          chain: bookKey,
          contract: contractName,
          contractAddress: await contract.getAddress(),
          role: roleName,
          roleHash,
          grantee: MASTER_EOA,
          granteeLabel: "MASTER_EOA (testnet operator)",
          action: "grant",
          granter: signerAddress,
          txHash,
          script: "operator/grantRoles.ts",
        });
        if (!rec.ok) {
          // Never abort: the grant is already on-chain. Losing the audit row
          // is bad, but leaving a half-provisioned contract behind is worse.
          logger.warning(`  [${contractName}] ${roleName}: granted, but LEDGER WRITE FAILED: ${rec.error}`);
        }
      }
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
  const wouldGrant = results.filter((r) => r.status === "would_grant").length;
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
          : r.status === "would_grant"
            ? "\x1b[33mWOULD GRANT\x1b[0m"
            : r.status === "error"
              ? "\x1b[31mERROR\x1b[0m"
              : "skipped";
    console.log(`  ${pad(r.contract, colC)}  ${pad(r.role, colR)}  ${statusStr}`);
  }

  console.log();
  logger.info(`Granted:           ${granted}`);
  logger.info(`Already held:      ${already}`);
  if (wouldGrant > 0) logger.info(`Would grant (dry): ${wouldGrant}`);
  if (errors > 0) logger.error(`Errors:            ${errors}`);
  if (skippedContracts.length > 0) {
    logger.warning(
      `Skipped contracts: ${skippedContracts.join(", ")} (no entry in address book)`
    );
  }

  logger.info(
    "Retained on admin/deployer: DEFAULT_ADMIN_ROLE on all three contracts " +
      "(literal ownership — it is the role-admin for every role granted here, " +
      "so the deployer can revoke this operator's entire set at any time) and " +
      "OKUM_/VAULT_/PSM_UPGRADER (implementation-swap power)."
  );
  logger.warning(
    "This operator holds OKUM_MINTER + OKUM_ALLOWANCE_MANAGER + " +
      "OKUM_CAP_MANAGER together, so it can raise its own allowance AND the " +
      "global cap: there is NO on-chain ceiling on what it can mint " +
      `(the ${ethers.formatEther(MINTER_ALLOWANCE)} OkuM allowance is a ` +
      "starting value it can change itself). It can also drain the PSM USDC " +
      "buffer. The only backstop is the deployer's DEFAULT_ADMIN_ROLE. " +
      "Testnet-only by design — this script hard-refuses mainnet."
  );

  // State the grantee last, where it can't be missed — it is the single
  // security-relevant fact of the whole run.
  if (granted > 0 || wouldGrant > 0) {
    logger.warning(
      `PRIVILEGE RECIPIENT: ${MASTER_EOA}` +
        (process.env.MASTER_EOA ? " (from MASTER_EOA env)" : " (config/chains.ts default)")
    );
    logger.info(`Recorded in: ${roleGrantsPath()}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const ctx: NetworkContext = await resolveNetworkContext();
  const { networkName, bookKey, isFork } = ctx;
  assertNotMainnet(networkName);

  // On a fork run, read `fork:<chain>` first but fall through to the live
  // `<chain>` entries: forking a live chain without re-deploying onto the fork
  // leaves the fork-namespaced entries empty or stale. Each contract is
  // checked for actual bytecode at the candidate address before it is used.
  const candidateKeys: string[] = isFork ? [bookKey, networkName] : [bookKey];

  logger.header(
    `Grant Operational Roles → ${MASTER_EOA} (${networkName}${isFork ? " fork" : ""}${DRY_RUN ? " — DRY_RUN" : ""})`
  );
  logger.info(`Address book key: ${bookKey}`);
  if (DRY_RUN) {
    logger.warning(
      `DRY_RUN=1 set — no transactions will be broadcast. Re-run without DRY_RUN to execute.`
    );
  }
  if (isFork) {
    logger.info(`Fallback key:     ${networkName} (used if fork entries missing)`);
  }
  logger.info(`Master EOA:       ${MASTER_EOA}`);
  logger.info(`Admin EOA:        ${ADMIN_EOA}`);
  logger.info(`Minter allowance: ${ethers.formatEther(MINTER_ALLOWANCE)} OkuM (only takes effect if OKUM_MINTER is granted)`);
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
  let okuMoneyContract: Contract | undefined;

  try {
    for (const [contractName, roles] of Object.entries(ROLE_MAP)) {
      logger.section(`${contractName}`);

      // First candidate key whose recorded address has bytecode on the
      // running chain. Avoids the "0x" decode error from a stale entry.
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

      if (contractName === "OkuMoney") okuMoneyContract = contract;

      const results = await grantRolesOnContract(
        contractName,
        contract,
        roles,
        adminSigner.address,
        isFork,
        resolvedKey
      );
      allResults.push(...results);
    }

    // ---- Minter allowance ----
    // Without this, a freshly-granted OKUM_MINTER is inert: `mint()` checks
    // `minterAllowance[msg.sender]`, which defaults to 0 and is NOT set by
    // `grantRole` itself, so every mint would revert ExceedsAllowance. Only
    // runs if OkuMoney resolved above, so the script stays usable against
    // partial deployments.
    if (okuMoneyContract) {
      logger.section("OkuMoney minter allowance");
      // Idempotency check BEFORE delegating to runConfigureMinterAllowance:
      // that helper always submits (correct for its standalone use as a
      // deliberate rotation tool), which would make every re-run of THIS
      // script send a redundant tx even when nothing changed.
      const currentAllowance: bigint = await okuMoneyContract.minterAllowance(MASTER_EOA);
      if (currentAllowance === MINTER_ALLOWANCE) {
        logger.info(
          `  minter_allowance already ${ethers.formatEther(MINTER_ALLOWANCE)} OkuM — skipping`
        );
      } else {
        await runConfigureMinterAllowance(
          ctx,
          adminSigner as any,
          MASTER_EOA,
          MINTER_ALLOWANCE,
          DRY_RUN
        );
      }
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

  if (DRY_RUN) {
    const wouldGrant = allResults.filter((r) => r.status === "would_grant").length;
    logger.success(
      `DRY_RUN complete — ${wouldGrant} role(s) would be granted to ${MASTER_EOA}. ` +
        `No transactions broadcast. Re-run without DRY_RUN=1 to execute.`
    );
  } else {
    logger.success(`All applicable operational roles granted to ${MASTER_EOA}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`grantRoles failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
