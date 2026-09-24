/**
 * Durable, append-only record of every privilege this repo's scripts have
 * granted or revoked on an EVM chain — plus the address-labelling used to
 * make an audit of live chain state readable.
 *
 * `OkuMoney`, `OkuDollar`, `LitePSM` and `RedemptionQueue` all extend
 * OpenZeppelin's `AccessControlUpgradeable`, **not** `AccessControlEnumerable`:
 * `hasRole(role, account)` answers "does THIS address hold it?", but there is
 * no `getRoleMemberCount` / `getRoleMember`. The chain therefore cannot be
 * asked "who holds OKUM_MINTER?" — the grantee address exists only in
 * `RoleGranted` event logs, subject to RPC log retention. At least one chain
 * we deploy to has pruned those logs (free bscTestnet endpoints answer
 * `eth_getLogs` over the deployment range with "History has been pruned for
 * this block"), making this ledger the ONLY record of those grants. That is
 * why `config/roleGrants.json` is tracked in git rather than gitignored like
 * the other generated stores.
 *
 * Append-only, deliberately: revocations append a `revoke` entry rather than
 * deleting the `grant`, because the history of who *used* to hold a privilege
 * is what an incident review needs. Current holders are derived by replaying
 * the ledger in timestamp order (`deriveLedgerHolders`), never by mutating
 * rows in place.
 *
 * Hardhat-free on purpose (pure `fs` + `ethers` string helpers) so both
 * Hardhat-bound scripts and standalone `tsx` scripts can import it.
 */

import * as fs from "fs";
import * as path from "path";
import { getAddress } from "ethers";
import { loadNetworkAddresses } from "./addressBook";
import { DEV_WALLET_ADDRESS, MASTER_OPERATOR_EOA } from "../config/chains";

export type RoleAction = "grant" | "revoke";

export interface RoleGrantRecord {
  /** ISO-8601, when this script observed the mutation confirm. */
  at: string;
  /** Address-book key the mutation was applied under (e.g. "sepolia"). */
  chain: string;
  /** Contract name as it appears in addresses.json (e.g. "OkuMoney"). */
  contract: string;
  /** Contract address the role lives on. */
  contractAddress: string;
  /** Symbolic role name from `config/roles.ts` (e.g. "OKUM_MINTER"). */
  role: string;
  /** keccak256 role id actually passed on-chain. */
  roleHash: string;
  /** The address RECEIVING (or losing) the privilege — the field this whole file exists for. */
  grantee: string;
  /** Best-effort human label for `grantee` at write time. */
  granteeLabel: string;
  action: RoleAction;
  /** Address that sent the tx (must hold DEFAULT_ADMIN_ROLE). */
  granter: string;
  /** Absent for dry runs, which are recorded with `dryRun: true` and no hash. */
  txHash?: string;
  dryRun?: boolean;
  /** Which script performed it, for provenance. */
  script: string;
}

const LEDGER_PATH = path.join(__dirname, "../config/roleGrants.json");

export function roleGrantsPath(): string {
  return LEDGER_PATH;
}

export function loadRoleGrants(ledgerPath = LEDGER_PATH): RoleGrantRecord[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const raw = fs.readFileSync(ledgerPath, "utf-8").trim();
  if (!raw) return [];
  return JSON.parse(raw) as RoleGrantRecord[];
}

/**
 * Append one privilege mutation.
 *
 * Deduplicates on the full identity of the mutation INCLUDING `txHash`, so
 * re-running an idempotent grant script does not pile up duplicate rows for
 * grants it skipped, while two genuinely separate grants of the same role to
 * the same address (grant -> revoke -> grant) both survive.
 *
 * Never throws on write failure: this is an audit side-effect of a privilege
 * change that has ALREADY landed on-chain. Losing the record is bad, but
 * aborting the script mid-sequence — leaving a partially-granted contract and
 * a non-zero exit — is worse. Failures are reported to the caller instead.
 */
export function recordRoleGrant(
  entry: RoleGrantRecord,
  ledgerPath = LEDGER_PATH
): { ok: true } | { ok: false; error: string } {
  try {
    const existing = loadRoleGrants(ledgerPath);
    const dup = existing.some(
      (e) =>
        e.chain === entry.chain &&
        e.contract === entry.contract &&
        e.role === entry.role &&
        eqAddr(e.grantee, entry.grantee) &&
        e.action === entry.action &&
        e.txHash === entry.txHash &&
        Boolean(e.dryRun) === Boolean(entry.dryRun)
    );
    if (!dup) {
      existing.push(entry);
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, JSON.stringify(existing, null, 2) + "\n");
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function eqAddr(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function normalise(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

/**
 * Human labels for every address we can identify on a given chain.
 *
 * Sources, in priority order:
 *   1. the address book (protocol contracts — a role held by LitePSM is
 *      expected and uninteresting; a role held by an EOA is not)
 *   2. the well-known operator EOAs from env/config
 *
 * Used to stamp a human-readable `granteeLabel` onto each ledger row at write
 * time, so the record stays meaningful even if the address later drops out of
 * config. An address absent from this map resolves to "UNKNOWN".
 */
export function buildAddressLabels(
  chain: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const labels: Record<string, string> = {};

  let book: Record<string, string> = {};
  try {
    book = loadNetworkAddresses(chain);
  } catch {
    book = {};
  }
  for (const [name, addr] of Object.entries(book)) {
    if (typeof addr === "string" && addr.startsWith("0x")) {
      labels[normalise(addr).toLowerCase()] = `${name} (contract)`;
    }
  }

  // Resolved CONSTANTS, not raw env reads: both of these have hardcoded
  // defaults in `config/chains.ts` that apply when the env var is unset, and
  // reading the env directly made the deployer itself report as UNKNOWN on
  // every chain — the single most common holder in the whole audit.
  const envEoas: Array<[string | undefined, string]> = [
    [DEV_WALLET_ADDRESS, "DEV_WALLET / deployer-admin"],
    [MASTER_OPERATOR_EOA, "MASTER_EOA (testnet operator)"],
    [process.env.MAINNET_COLD_MULTISIG, "MAINNET_COLD_MULTISIG"],
    [process.env.MAINNET_WARM_MULTISIG, "MAINNET_WARM_MULTISIG"],
    [process.env.MAINNET_ORCHESTRATOR, "MAINNET_ORCHESTRATOR"],
  ];
  for (const [addr, label] of envEoas) {
    if (addr && addr.startsWith("0x")) labels[normalise(addr).toLowerCase()] = label;
  }

  for (const [addr, label] of Object.entries(extra)) {
    if (addr && addr.startsWith("0x")) labels[normalise(addr).toLowerCase()] = label;
  }

  return labels;
}

export function labelFor(
  address: string,
  labels: Record<string, string>
): string {
  return labels[address.toLowerCase()] ?? "UNKNOWN";
}

/**
 * Replay the ledger into the set of (chain, contract, role) -> holders it
 * implies. Dry-run rows are ignored: they record intent, not privilege.
 */
export function deriveLedgerHolders(
  records: RoleGrantRecord[]
): Map<string, Set<string>> {
  const key = (r: RoleGrantRecord) => `${r.chain}|${r.contract}|${r.role}`;
  const out = new Map<string, Set<string>>();
  // Chronological replay so a later revoke beats an earlier grant.
  const sorted = [...records]
    .filter((r) => !r.dryRun)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const r of sorted) {
    const k = key(r);
    if (!out.has(k)) out.set(k, new Set());
    const set = out.get(k)!;
    const addr = r.grantee.toLowerCase();
    if (r.action === "grant") set.add(addr);
    else set.delete(addr);
  }
  return out;
}
