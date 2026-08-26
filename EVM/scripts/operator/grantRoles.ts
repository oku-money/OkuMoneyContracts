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
 *     SubscriptionModule proxy, otherwise an EOA could bypass module accounting).
 *   - USDOku's OKU_MINTER / OKU_BURNER ARE granted to the master EOA on testnet,
 *     mirroring the OkuM treatment: it is a no-op safety net (the EOA never
 *     wraps directly — the wrapper does) that keeps the role surface complete
 *     for emergency operator action. On MAINNET these are contract-only and
 *     grantRolesMainnet.ts asserts no key holds them.
 *
 * The signer used to send the grants must hold DEFAULT_ADMIN_ROLE on every
 * contract being touched. On testnet deployments that is the deployer / dev
 * wallet (DEV_WALLET_ADDRESS in scripts/config/chains.ts).
 *
 * Usage:
 *   npx hardhat run scripts/operator/grantRoles.ts --network sepolia
 *   npx hardhat run scripts/operator/grantRoles.ts --network baseSepolia
 *   npx hardhat run scripts/operator/grantRoles.ts --network arbSepolia
 *   npx hardhat run scripts/operator/grantRoles.ts --network bscTestnet
 *
 *   # Preview without broadcasting (works on any chain, no PRIVATE_KEY needed):
 *   DRY_RUN=1 npx hardhat run scripts/operator/grantRoles.ts --network arbSepolia
 *
 *   # Fork (auto-detects target chain from the running node, or pass NETWORK=…):
 *   NETWORK=base npx hardhat run scripts/operator/grantRoles.ts --network localhost
 *
 *   # Mainnet (requires explicit opt-in; prefer grantRolesMainnet.ts for production):
 *   YES_MAINNET=1 NETWORK=base npx hardhat run scripts/operator/grantRoles.ts --network base
 *
 * Environment knobs (live networks only; forks are unaffected):
 *   CONFIRMATIONS=N   confirmations to wait per tx (default 2)
 *   SETTLE_MS=N       extra ms to sleep after each mined tx before the next
 *                     hasRole read (default 1500; set 0 to disable)
 *   DRY_RUN=1         print planned grants without broadcasting (safe on any chain,
 *                     no PRIVATE_KEY required — uses a read-only VoidSigner)
 *   YES_MAINNET=1     bypass the mainnet safety gate (see notes above)
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

/**
 * EOA that will receive every role on every deployed contract.
 * Override via MASTER_EOA env var. Hardcoded default is the original testnet
 * master EOA; on mainnet use grantRolesMainnet.ts with MAINNET_COLD_MULTISIG
 * / MAINNET_WARM_MULTISIG / MAINNET_ORCHESTRATOR instead of this script.
 */
const MASTER_EOA = process.env.MASTER_EOA ?? "0x971A3e2b0031dE23715Fa1ce53843B5B045dae00";

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

/** DRY_RUN=true prints planned grants without broadcasting. */
const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";

/**
 * Mainnet safety gate — mirrors SVM's `confirmIfMainnet`.
 * On known mainnet-beta chains, require explicit opt-in or throw.
 *
 * Opt-in mechanisms (any of):
 *   - YES_MAINNET=1 / YES_MAINNET=true env var (preferred)
 *   - --yes-mainnet CLI flag (only works when the script is invoked directly,
 *     e.g. `npx ts-node scripts/operator/grantRoles.ts ...`; Hardhat v2's
 *     `hardhat run` rejects unknown CLI flags before the script sees them, so
 *     use the env var when running under `npx hardhat run`).
 */
const YES_MAINNET =
  process.argv.includes("--yes-mainnet") ||
  process.env.YES_MAINNET === "1" ||
  process.env.YES_MAINNET === "true";
const MAINNET_NETWORKS = new Set(["base", "bsc", "mainnet", "ethereum"]);
function assertNotMainnet(networkName: string) {
  if (!MAINNET_NETWORKS.has(networkName)) return;
  if (YES_MAINNET) {
    logger.warning(`YES_MAINNET set; proceeding on ${networkName}`);
    return;
  }
  if (DRY_RUN) return; // dry-run is always safe
  throw new Error(
    `Refusing to broadcast on ${networkName}.\n` +
    `  grantRoles.ts routes EVERYTHING to MASTER_EOA — use grantRolesMainnet.ts instead.\n` +
    `  If you truly want to proceed with this script on ${networkName}, set YES_MAINNET=1.\n` +
    `  Example: YES_MAINNET=1 NETWORK=${networkName} npx hardhat run scripts/operator/grantRoles.ts --network ${networkName}`
  );
}

type RoleName = keyof typeof ROLES;

/**
 * Map of contract name (as it appears in addresses.json) → roles to grant.
 *
 * NOTE: every list begins with DEFAULT_ADMIN_ROLE so the master EOA can
 * subsequently grant/revoke any role itself.
 *
 * The `OKU_*` constants appear TWICE — once under OkuM and once under USDOku —
 * and that is not a copy-paste error. AccessControl mappings are per contract,
 * so the same 32-byte role identifier has to be granted separately on each
 * token. Mirrors deploy/index.ts and grantRolesMainnet.ts.
 */
const ROLE_MAP: Record<string, readonly RoleName[]> = {
  OkuM: [
    "DEFAULT_ADMIN_ROLE",
    "OKU_UPGRADER",
    "OKU_PAUSER",
    "OKU_UNPAUSER",
    // Granting MINTER/BURNER to the master EOA is a no-op safety net on testnet
    // (the EOA never calls mint/burn directly — the module and queue do) but
    // keeps the role surface complete for emergency operator action. On MAINNET
    // these are contract-only; grantRolesMainnet.ts asserts no key holds them.
    "OKU_MINTER",
    "OKU_BURNER",
    // `setOkuMultiplier` — the stepwise realized mark.
    "OKU_RATE_SETTER",
    // `haltAccrual` (sticky flag) — cleared only by OKU_CAP_MANAGER.
    "OKU_GUARDIAN",
    "OKU_BLACKLISTER",
    "OKU_UNBLACKLISTER",
    // Also gates resumeAccrual.
    "OKU_CAP_MANAGER",
    "OKU_ALLOWANCE_MANAGER",
  ],
  USDOku: [
    "DEFAULT_ADMIN_ROLE",
    "OKU_UPGRADER",
    "OKU_PAUSER",
    "OKU_UNPAUSER",
    "OKU_MINTER",
    "OKU_BURNER",
    // `setUsdOkuRate` — the continuous declared rate. Same constant as on OkuM,
    // entirely separate grant.
    "OKU_RATE_SETTER",
    // `haltUsdOkuAccrual` — freezes the index; NOT sticky (the rate setter can
    // resume immediately), which is why the OkuM halt is the durable one.
    "OKU_GUARDIAN",
    "OKU_BLACKLISTER",
    "OKU_UNBLACKLISTER",
    // Gates `setSolvencySource` here.
    "OKU_CAP_MANAGER",
    // OKU_ALLOWANCE_MANAGER deliberately absent: USDOku has no minter-allowance
    // system, so the role gates nothing on this contract.
  ],
  SubscriptionModule: [
    "DEFAULT_ADMIN_ROLE",
    "PSM_UPGRADER",
    "PSM_PAUSER",
    "PSM_UNPAUSER",
    "PSM_QUEUE_PROCESSOR",
    "PSM_BUFFER_DEPOSITOR",
    "PSM_BUFFER_WITHDRAWER",
    // Load-bearing in the two-token model: tin+tout is the step-coverage budget,
    // so without this role the master EOA cannot enable stepping at all.
    "PSM_FEE_MANAGER",
  ],
  // NOTE: QUEUE_PSM intentionally excluded — must stay on the
  // SubscriptionModule proxy, or an EOA could enqueue/process directly.
  RedemptionQueue: [
    "DEFAULT_ADMIN_ROLE",
    "QUEUE_UPGRADER",
    "QUEUE_RESCUER",
  ],
  USDOkuWrapper: [
    "DEFAULT_ADMIN_ROLE",
    "WRAPPER_UPGRADER",
    "WRAPPER_PAUSER",
    "WRAPPER_UNPAUSER",
    // The USDOku sunset lever (`setWrapEnabled`). There is no counterpart for
    // `unwrap` — no key can close the exit.
    "WRAPPER_ADMIN",
    // Recovers genuinely excess OkuM backing (`withdrawSurplus`) once realized
    // marks overtake declared USDOku liability. Bounded to full parity, never
    // below — see the constant's doc in `roles.ts`.
    "WRAPPER_RESERVE_MANAGER",
  ],
  // Retired names (OkuMoney, OkuDollar, LitePSM, OkuBridge, OkuBridgeRouter) are
  // deliberately absent. Live pre-v0.4 deployments may still have those proxies
  // on-chain; the address-book lookup loop below silently skips any contract
  // name not in ROLE_MAP, so they are simply not touched by this script until
  // they are formally retired.
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
    // and the per-contract `hasRole(ADMIN_EOA, ...)` sanity check. If
    // PRIVATE_KEY isn't set, hardhat returns an empty signers list — fall
    // back to a JsonRpcProvider read-only signer wrapper by impersonating
    // through ethers (read-only ops don't need a private key).
    if (DRY_RUN) {
      // primary may be undefined if PRIVATE_KEY isn't configured. The
      // grant-loop's sanity check only calls hasRole (read-only), so any
      // address that's "labeled as" ADMIN_EOA works. Use a VoidSigner so
      // any accidental write call fails loudly instead of silently sending.
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

      if (DRY_RUN) {
        // DRY_RUN: do NOT broadcast. Just record what we would have sent. The
        // `hasRole` read above already confirmed the grant is needed, so the
        // would_grant count in the summary accurately previews the live run's
        // tx count. Note: we cannot estimateGas here without a signer that
        // holds DEFAULT_ADMIN_ROLE on every contract, and on a non-fork dry
        // run the active signer typically isn't admin — so we skip gas probe
        // and rely on the static role inventory instead.
        results.push({ contract: contractName, role: roleName, status: "would_grant" });
        logger.info(`  [${contractName}] ${roleName}: would grant (DRY_RUN)`);
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
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { networkName, bookKey, isFork } = await resolveNetworkContext();
  assertNotMainnet(networkName);

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
    `Grant Roles → ${MASTER_EOA} (${networkName}${isFork ? " fork" : ""}${DRY_RUN ? " — DRY_RUN" : ""})`
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

  if (DRY_RUN) {
    const wouldGrant = allResults.filter((r) => r.status === "would_grant").length;
    logger.success(
      `DRY_RUN complete — ${wouldGrant} role(s) would be granted to ${MASTER_EOA}. ` +
        `No transactions broadcast. Re-run without DRY_RUN=1 to execute.`
    );
  } else {
    logger.success(`All applicable roles granted to ${MASTER_EOA}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`grantRoles failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
