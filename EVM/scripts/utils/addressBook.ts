/**
 * Address book utilities for saving and loading deployed contract addresses
 *
 * The on-disk file mixes two shapes under one top-level object:
 *   1. Per-network maps of contract-name -> proxy address (e.g. addresses["base"].LitePSM).
 *      These are managed by the existing save/load/has helpers below.
 *   2. A reserved `upgrades` key whose value is { [bookKey]: UpgradeRecord[] }.
 *      Append-only audit trail of proxy upgrades. Lookups by contract name skip
 *      this key (it's not a chain entry) — see `loadNetworkAddresses`.
 *
 * ---------------------------------------------------------------------------
 * TWO FILES: tracked live state vs. gitignored ephemeral fork state
 * ---------------------------------------------------------------------------
 * Entries are split across two files by key prefix:
 *
 *   addresses.json         TRACKED   — live chains ("base", "sepolia", ...)
 *   addresses.local.json   GITIGNORED — local forks ("fork:base", ...)
 *
 * Every fork run (dryRunForks.sh, `npm run deploy --network localhost`, the
 * hardhat drills) redeploys to a throwaway chain and writes fresh addresses.
 * When both shapes shared one tracked file, those ephemeral addresses showed
 * up as a dirty working tree and were easy to commit by accident — the fork
 * they refer to is discarded seconds later, so the diff is pure noise.
 *
 * The split is handled entirely here: `loadAddressBook()` returns a MERGED
 * view of both files, and `saveAddressBook()` partitions by prefix and writes
 * each file separately. Callers are unaffected and need no knowledge of it —
 * `saveAddress`, `loadAddress`, `hasAddress`, `loadNetworkAddresses`, and
 * `appendUpgradeRecord` all route through those two functions, so fork data
 * structurally cannot reach the tracked file.
 */

import fs from "fs";
import path from "path";

/** Tracked: live-chain deployments. Committed. */
const ADDRESS_BOOK_PATH = path.join(__dirname, "../config/addresses.json");

/** Gitignored: local-fork deployments. Ephemeral, never committed. */
const LOCAL_ADDRESS_BOOK_PATH = path.join(__dirname, "../config/addresses.local.json");

/**
 * Book keys for local-fork runs are namespaced `fork:<chain>` by
 * `resolveNetworkContext()`. That prefix is the sole signal used to decide
 * which file an entry belongs in.
 */
const FORK_KEY_PREFIX = "fork:";

/** `true` if `key` denotes an ephemeral local-fork deployment. */
export function isForkKey(key: string): boolean {
  return key.startsWith(FORK_KEY_PREFIX);
}

/// Reserved top-level key in addresses.json holding the upgrade history.
/// Never used as a chain key; loadNetworkAddresses returns {} for it.
export const UPGRADES_KEY = "upgrades";

/**
 * One entry in the per-network upgrade history. Captures everything needed
 * to forensically reconstruct an upgrade later without touching the chain.
 */
export interface UpgradeRecord {
  /** Contract name as known to hardhat (e.g. "LitePSM"). */
  contract: string;
  /** Proxy address — never changes across an upgrade. */
  proxy: string;
  /** ERC-1967 implementation slot value before the upgrade. */
  oldImpl: string;
  /** ERC-1967 implementation slot value after the upgrade. */
  newImpl: string;
  /** Tx hash of the upgradeToAndCall (or admin.upgradeAndCall for transparent). */
  txHash: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Signer that broadcast the upgrade tx (dev wallet on testnets). */
  deployer: string;
}

/**
 * AddressBook keeps its original narrow shape (network -> contract -> address)
 * for callers like deploy/verify scripts. The reserved `upgrades` key is read
 * and written by `appendUpgradeRecord` / `loadUpgradeHistory` only, going
 * through an unknown-cast at the helper boundary; existing call sites are
 * unaffected because `loadNetworkAddresses` and `hasAddress` skip that key.
 */
export interface AddressBook {
  [network: string]: {
    [contract: string]: string;
  };
}

/** Read+parse one book file, tolerating absence and corruption. */
function readBookFile(filePath: string): AddressBook {
  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.trim().length === 0) return {};
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Warning: Could not parse address book at ${filePath}: ${error}`);
    return {};
  }
}

/**
 * Load the address book from disk.
 *
 * Returns a MERGED view of the tracked (live) and gitignored (fork) files, so
 * callers see one flat book exactly as before the split. The reserved
 * `upgrades` sub-index is merged too.
 */
export function loadAddressBook(): AddressBook {
  const live = readBookFile(ADDRESS_BOOK_PATH);
  const local = readBookFile(LOCAL_ADDRESS_BOOK_PATH);

  const merged: AddressBook = {};
  for (const [key, value] of Object.entries(live)) {
    if (key === UPGRADES_KEY) continue;
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(local)) {
    if (key === UPGRADES_KEY) continue;
    merged[key] = value;
  }

  const mergedUpgrades: UpgradesIndex = {
    ...readUpgradesIndex(live),
    ...readUpgradesIndex(local),
  };
  if (Object.keys(mergedUpgrades).length > 0) {
    writeUpgradesIndex(merged, mergedUpgrades);
  }

  return merged;
}

/** Serialize + write, creating the parent dir if needed. */
function writeBookFile(filePath: string, book: AddressBook): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // No trailing newline — matches the committed file's existing formatting,
  // so an unchanged book rewrites byte-identically and produces no git diff.
  fs.writeFileSync(filePath, JSON.stringify(book, null, 2), "utf8");
}

/**
 * Save the address book to disk, partitioning entries by key prefix:
 * `fork:*` -> gitignored local file, everything else -> tracked file.
 *
 * Callers pass the same merged book they got from `loadAddressBook()`; the
 * split is re-derived here on every write, so a fork entry can never land in
 * tracked state regardless of how the caller assembled the object.
 */
export function saveAddressBook(book: AddressBook): void {
  const live: AddressBook = {};
  const local: AddressBook = {};

  for (const [key, value] of Object.entries(book)) {
    if (key === UPGRADES_KEY) continue; // handled below
    (isForkKey(key) ? local : live)[key] = value;
  }

  // The upgrade audit trail is keyed by bookKey too, so it needs the same
  // partitioning — otherwise a fork upgrade record leaks into the tracked file.
  const upgrades = readUpgradesIndex(book);
  const liveUpgrades: UpgradesIndex = {};
  const localUpgrades: UpgradesIndex = {};
  for (const [bookKey, records] of Object.entries(upgrades)) {
    (isForkKey(bookKey) ? localUpgrades : liveUpgrades)[bookKey] = records;
  }
  if (Object.keys(liveUpgrades).length > 0) writeUpgradesIndex(live, liveUpgrades);
  if (Object.keys(localUpgrades).length > 0) writeUpgradesIndex(local, localUpgrades);

  writeBookFile(ADDRESS_BOOK_PATH, live);

  // Only materialise the local file when there's fork state to record, and
  // remove it once the last fork entry is gone, so a pure-live workflow never
  // leaves a stray file behind.
  if (Object.keys(local).length > 0) {
    writeBookFile(LOCAL_ADDRESS_BOOK_PATH, local);
  } else if (fs.existsSync(LOCAL_ADDRESS_BOOK_PATH)) {
    fs.unlinkSync(LOCAL_ADDRESS_BOOK_PATH);
  }
}

/**
 * Save a contract address for a specific network
 */
export function saveAddress(network: string, contractName: string, address: string): void {
  const book = loadAddressBook();

  if (!book[network]) {
    book[network] = {};
  }

  book[network][contractName] = address;
  saveAddressBook(book);
}

/**
 * Load a contract address for a specific network
 */
export function loadAddress(network: string, contractName: string): string {
  const book = loadAddressBook();

  if (!book[network] || !book[network][contractName]) {
    throw new Error(
      `No address found for contract "${contractName}" on network "${network}"`
    );
  }

  return book[network][contractName];
}

/**
 * Load all addresses for a specific network
 */
export function loadNetworkAddresses(network: string): Record<string, string> {
  // The reserved upgrades key is not a chain; treat as empty for contract lookups.
  if (network === UPGRADES_KEY) return {};
  const book = loadAddressBook();
  return book[network] || {};
}

/**
 * Check if a contract address exists for a network
 */
export function hasAddress(network: string, contractName: string): boolean {
  if (network === UPGRADES_KEY) return false;
  const book = loadAddressBook();
  return !!(book[network] && book[network][contractName]);
}

// ---------------------------------------------------------------------------
// Upgrade audit trail
// ---------------------------------------------------------------------------
//
// We extend the on-disk JSON with a reserved top-level key ("upgrades") whose
// value is keyed by bookKey -> UpgradeRecord[]. To keep the public AddressBook
// type narrow (so deploy/verify scripts that iterate `book[network]` as
// `Record<string,string>` still type-check), we read/write this key through
// an `unknown` cast inside these helpers and never expose the union shape.

type UpgradesIndex = { [bookKey: string]: UpgradeRecord[] };

function readUpgradesIndex(book: AddressBook): UpgradesIndex {
  // Cast: TypeScript narrows the interface to Record<string,string>, but at
  // runtime we know the file may also carry the reserved upgrades key.
  return ((book as unknown) as { [UPGRADES_KEY]?: UpgradesIndex })[UPGRADES_KEY] || {};
}

function writeUpgradesIndex(book: AddressBook, idx: UpgradesIndex): void {
  ((book as unknown) as { [UPGRADES_KEY]?: UpgradesIndex })[UPGRADES_KEY] = idx;
}

/**
 * Append an upgrade record to the per-network audit trail.
 *
 * Layout in addresses.json:
 *   {
 *     "<bookKey>": { ContractName: proxyAddr, ... },   // existing
 *     "upgrades": {
 *       "<bookKey>": [UpgradeRecord, ...]              // appended here
 *     }
 *   }
 *
 * Append-only: prior entries are never mutated or removed. Safe to call from
 * any script — uses the same atomic-write helper as the rest of the book.
 */
export function appendUpgradeRecord(bookKey: string, record: UpgradeRecord): void {
  const book = loadAddressBook();
  const idx = readUpgradesIndex(book);
  const existing: UpgradeRecord[] = idx[bookKey] || [];
  existing.push(record);
  idx[bookKey] = existing;
  writeUpgradesIndex(book, idx);
  saveAddressBook(book);
}

/**
 * Read the upgrade audit trail for a given book key (empty array if none).
 */
export function loadUpgradeHistory(bookKey: string): UpgradeRecord[] {
  const book = loadAddressBook();
  return readUpgradesIndex(book)[bookKey] ?? [];
}
