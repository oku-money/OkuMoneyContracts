/**
 * Grant Operational Roles to Master EOA ("operate, don't own")
 *
 * Idempotently grants MASTER_EOA the bounded set of OPERATIONAL roles it
 * needs to run day-to-day protocol operations on a testnet deployment —
 * mint/burn OkuM, set the yield rate, deposit the PSM buffer, process the
 * redemption queue — and sets its OkuM minter allowance so the mint grant is
 * actually usable. It does NOT grant `DEFAULT_ADMIN_ROLE`, any `*_UPGRADER`
 * role, or any pause/blacklist/cap/allowance-manager/buffer-withdrawer role.
 * Those stay on the admin/deployer key. This is the EVM mirror of SVM's
 * `scripts/admin/grant-roles.ts --delegate=<pubkey>`; see its NatSpec for the
 * shared "operate, don't own" rationale and the SVM/EVM role-mapping table
 * in `../../../README.md § RBAC`.
 *
 * ============================================================================
 * WHY THIS DIVERGES FROM THE DOCUMENTED PRODUCTION THREAT MODEL — read first
 * ============================================================================
 * `../../README.md` states twice, deliberately, that the EVM orchestrator
 * role holds NO minting authority ("Orchestrator key compromise grants no
 * special mint privilege beyond the orchestrator's USDC custody" —
 * `mintOkuM` is permissioned only by USDC collateral, not by an EOA role).
 * That is the production design: EVM bridging is PSM/USDC-mediated, so an
 * orchestrator EOA never needs `OKUM_MINTER`/`OKUM_BURNER` directly.
 *
 * This script grants `OKUM_MINTER`/`OKUM_BURNER` to MASTER_EOA anyway. That
 * is a DELIBERATE, TESTNET-ONLY parity choice with SVM's `direct_minter`/
 * `direct_burner` roles (which exist there because SVM has no redemption
 * queue and must mint/burn directly) — not a silent contradiction of the
 * doc. Never point this script at a mainnet network with real funds without
 * revisiting that decision; `assertNotMainnet` below blocks it by default.
 *
 * Both grants remain individually bounded even so: `mint()` is capped by
 * `minterAllowance[msg.sender]` (set below, well under `maxSupply`) and the
 * global supply cap; `burn()` only ever burns the caller's own balance.
 *
 * ----------------------------------------------------------------------------
 * WHAT'S GRANTED vs. RETAINED
 * ----------------------------------------------------------------------------
 * ----------------------------------------------------------------------------
 * THE POLICY, STATED ONCE
 * ----------------------------------------------------------------------------
 * MASTER_EOA gets everything needed to OPERATE the protocol.
 * The deployer/admin key keeps exactly two things: the ability to UPGRADE, and
 * literal OWNERSHIP (which is what lets it revoke all of the above).
 *
 * Granted — the full operational surface (20 roles):
 *   OkuMoney:        OKUM_MINTER, OKUM_BURNER, OKUM_REBASER,
 *                    OKUM_PAUSER, OKUM_UNPAUSER,
 *                    OKUM_BLACKLISTER, OKUM_UNBLACKLISTER,
 *                    OKUM_CAP_MANAGER, OKUM_ALLOWANCE_MANAGER
 *                    (+ an initial minter allowance)
 *   OkuDollar:       VAULT_PAUSER, VAULT_UNPAUSER, VAULT_RESCUER,
 *                    OKUM_BLACKLISTER, OKUM_UNBLACKLISTER
 *   LitePSM:         PSM_PAUSER, PSM_UNPAUSER, PSM_QUEUE_PROCESSOR,
 *                    PSM_BUFFER_DEPOSITOR, PSM_BUFFER_WITHDRAWER
 *   RedemptionQueue: QUEUE_RESCUER
 *
 * Retained on the admin/deployer key (4 roles + ownership):
 *   DEFAULT_ADMIN_ROLE (all four contracts) — literal ownership. It is the
 *     role-admin for every role above, so the deployer can revoke MASTER_EOA's
 *     entire role set unilaterally at any time. This is the ONLY backstop, and
 *     it is deliberately the whole backstop.
 *   OKUM_UPGRADER / VAULT_UPGRADER / PSM_UPGRADER / QUEUE_UPGRADER —
 *     implementation-swap power (UUPS `_authorizeUpgrade`).
 *
 * Also NOT granted, for a reason unrelated to trust:
 *   QUEUE_PSM — an identity role, not an operator capability. It asserts
 *     "the caller IS the LitePSM proxy", and RedemptionQueue relies on that to
 *     keep its accounting consistent with the PSM's. Handing it to an EOA
 *     would let that EOA drive queue state directly, out of band from the
 *     accounting LitePSM performs around the same calls. It stays on the
 *     proxy, and would stay there even for a fully trusted operator.
 *
 * ----------------------------------------------------------------------------
 * WHAT THIS ACTUALLY MEANS — do not skim
 * ----------------------------------------------------------------------------
 * Granting OKUM_MINTER + OKUM_ALLOWANCE_MANAGER + OKUM_CAP_MANAGER together
 * makes MASTER_EOA's mint capability EFFECTIVELY UNBOUNDED:
 *
 *   - `configureMinterAllowance` (`src/token/OkuMoney.sol:820`) is
 *     `onlyRole(OKUM_ALLOWANCE_MANAGER)` and takes an arbitrary `minter_`, so
 *     the holder can raise its OWN allowance past MINTER_ALLOWANCE.
 *   - `setMaxSupply` (`OkuMoney.sol:838`) is `onlyRole(OKUM_CAP_MANAGER)`, so
 *     the holder can then raise the global cap that would otherwise bound it.
 *
 * There is consequently NO on-chain ceiling on what this key can mint. An
 * earlier revision of this file claimed OKUM_CAP_MANAGER still bounded it;
 * that is no longer true now that both are granted. PSM_BUFFER_WITHDRAWER
 * likewise lets it drain the PSM's USDC buffer.
 *
 * This is acceptable ONLY because:
 *   (a) this script is testnet-only and hard-refuses mainnet
 *       (`assertNotMainnet` below — there is deliberately no override), and
 *   (b) testnet OkuM is backed by MockUSDC and has no value.
 *
 * The mainnet topology in `grantRolesMainnet.ts` splits these across a
 * cold/warm/orchestrator trio precisely so that no single key holds
 * mint + allowance + cap at once. It MUST NOT be changed to mirror this file.
 *
 * Usage:
 *   npx hardhat run scripts/operator/grantRoles.ts --network baseSepolia
 *   npx hardhat run scripts/operator/grantRoles.ts --network sepolia
 *   npx hardhat run scripts/operator/grantRoles.ts --network arbSepolia
 *   npx hardhat run scripts/operator/grantRoles.ts --network bscTestnet
 *
 *   # Preview without broadcasting (works on any chain, no PRIVATE_KEY needed):
 *   DRY_RUN=1 npx hardhat run scripts/operator/grantRoles.ts --network arbSepolia
 *
 *   # Fork (auto-detects target chain from the running node, or pass NETWORK=…):
 *   NETWORK=base npx hardhat run scripts/operator/grantRoles.ts --network localhost
 *
 *   # Mainnet — refuses by default; there is deliberately no override here.
 *   # A mainnet deployment carrying real funds needs grantRolesMainnet.ts's
 *   # 3-key topology, not this script's testnet parity shortcut.
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
import { runConfigureMinterAllowance } from "./configureMinterAllowance";
import { recordRoleGrant, roleGrantsPath } from "../utils/roleRegistry";

// ============================================================================
// Configuration
// ============================================================================

/**
 * EOA that receives the bounded operational role set. Override via
 * MASTER_EOA env var. Hardcoded default is the shared testnet operator EOA
 * (currently controlled by the backend engineer operating this deployment —
 * NOT held by this repo/deployer). On mainnet use grantRolesMainnet.ts with
 * MAINNET_COLD_MULTISIG / MAINNET_WARM_MULTISIG / MAINNET_ORCHESTRATOR
 * instead of this script — this one is refused on mainnet networks entirely.
 */
const MASTER_EOA = MASTER_OPERATOR_EOA;

/** EOA that holds DEFAULT_ADMIN_ROLE today (the deployer / dev wallet). */
const ADMIN_EOA = DEV_WALLET_ADDRESS;

/**
 * Minter allowance granted to MASTER_EOA (18-decimal OkuM). Mirrors SVM's
 * `DIRECT_MINTER_ALLOWANCE` (1,000,000 OkuM) — same magnitude, same rationale:
 * bounds the blast radius of a permissioned direct-mint role between resets
 * by whoever holds OKUM_ALLOWANCE_MANAGER (the admin/deployer key, not
 * MASTER_EOA itself — see the retained-roles list above).
 */
const MINTER_ALLOWANCE = process.env.MINTER_ALLOWANCE
  ? BigInt(process.env.MINTER_ALLOWANCE)
  : ethers.parseEther("1000000");

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
 * Mainnet gate — this script is testnet-only by design (see the module doc's
 * "WHY THIS DIVERGES" section: it grants direct mint/burn to an EOA, which
 * the documented production threat model explicitly forbids). Unlike
 * `grantRolesMainnet.ts` there is no opt-in override; a mainnet deployment
 * carrying real funds needs the 3-key topology, not this shortcut.
 */
const MAINNET_NETWORKS = new Set(["base", "bsc", "mainnet", "ethereum"]);
function assertNotMainnet(networkName: string) {
  if (!MAINNET_NETWORKS.has(networkName)) return;
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
 * to grant to MASTER_EOA. Contracts with nothing to grant (OkuDollar,
 * RedemptionQueue — see the module doc's SVM/EVM role table) are simply
 * absent; the grant loop below only visits contracts listed here.
 *
 * Deliberately does NOT lead with DEFAULT_ADMIN_ROLE the way the old
 * "grant everything" version of this script did — see the module doc.
 */
const ROLE_MAP: Record<string, readonly RoleName[]> = {
  OkuMoney: [
    "OKUM_REBASER",
    // Testnet-only parity with SVM's direct_minter/direct_burner — see the
    // module doc's "WHY THIS DIVERGES" section before granting on any
    // network carrying real funds.
    "OKUM_MINTER",
    "OKUM_BURNER",
    // Circuit breakers. An operator that cannot pause cannot respond to an
    // incident without waking the admin key, which defeats the point of
    // having an operator.
    "OKUM_PAUSER",
    "OKUM_UNPAUSER",
    // Compliance actions.
    "OKUM_BLACKLISTER",
    "OKUM_UNBLACKLISTER",
    // Supply/allowance administration. Together with OKUM_MINTER these remove
    // every on-chain ceiling on this key's minting — see the module doc's
    // "WHAT THIS ACTUALLY MEANS" section. Deliberate, testnet-only.
    "OKUM_CAP_MANAGER",
    "OKUM_ALLOWANCE_MANAGER",
  ],
  OkuDollar: [
    "VAULT_PAUSER",
    "VAULT_UNPAUSER",
    // Withdraws OkuM donated directly to the vault. Under the single-multiplier
    // design donations accrue to nobody, so without this they are stuck.
    "VAULT_RESCUER",
    // OkuDollar carries its OWN copy of the shared-prefix blacklist roles —
    // granting them on OkuMoney does not cover the vault. Both are needed for
    // a blacklist action to apply across the pair.
    "OKUM_BLACKLISTER",
    "OKUM_UNBLACKLISTER",
  ],
  LitePSM: [
    "PSM_BUFFER_DEPOSITOR",
    "PSM_QUEUE_PROCESSOR",
    "PSM_PAUSER",
    "PSM_UNPAUSER",
    // Lets the operator pull USDC out of the PSM buffer.
    "PSM_BUFFER_WITHDRAWER",
  ],
  RedemptionQueue: [
    "QUEUE_RESCUER",
    // QUEUE_PSM deliberately absent — it is an identity role meaning "the
    // caller IS the LitePSM proxy", not an operator capability. See the module
    // doc; it stays on the proxy even for a fully trusted operator.
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

      const txHash = await sendAndConfirm(
        contract.grantRole(roleHash, MASTER_EOA),
        `[${contractName}] grantRole(${roleName})`,
        isFork
      );
      results.push({ contract: contractName, role: roleName, status: "granted" });

      // Record the grantee DURABLY. Printing it to stdout (which is all this
      // script used to do) loses it the moment the terminal scrolls, and
      // `AccessControlUpgradeable` keeps no queryable member list to recover
      // it from — see utils/roleRegistry.ts. Forks are excluded: their state
      // is thrown away, so recording it would pollute the ledger with grants
      // that never existed on a real chain.
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
    "Retained on admin/deployer: DEFAULT_ADMIN_ROLE on all four contracts " +
      "(literal ownership — it is the role-admin for every role granted here, " +
      "so the deployer can revoke this operator's entire set at any time) and " +
      "OKUM_/VAULT_/PSM_/QUEUE_UPGRADER (implementation-swap power). " +
      "QUEUE_PSM stays on the LitePSM proxy — an identity role, not an " +
      "operator capability."
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

  // State the grantee last, where it can't be missed. This is the single
  // security-relevant fact of the whole run, and it used to appear only in
  // the header — above dozens of lines of per-role output.
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
    // `grantRole` itself. This is the gap the old version of this script had
    // — it granted OKUM_MINTER but never called configureMinterAllowance,
    // so the grant looked complete but every mint would have reverted
    // ExceedsAllowance. Only run this if OkuMoney was actually resolved above
    // (keeps the script usable against partial/incomplete deployments).
    if (okuMoneyContract) {
      logger.section("OkuMoney minter allowance");
      // Idempotency check BEFORE delegating to runConfigureMinterAllowance:
      // that helper always submits (no skip-if-unchanged of its own — that's
      // correct for its standalone use as a deliberate rotation tool, see its
      // own header, but would make every re-run of THIS script send a
      // redundant on-chain tx even when nothing changed, contradicting the
      // "already held" idempotency the role grants above already have).
      const currentAllowance: bigint = await (okuMoneyContract as any).minterAllowance(MASTER_EOA);
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
