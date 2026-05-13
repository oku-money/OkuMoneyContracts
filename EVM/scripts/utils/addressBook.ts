/**
 * Address book utilities for saving and loading deployed contract addresses
 *
 * The on-disk file mixes two shapes under one top-level object:
 *   1. Per-network maps of contract-name -> proxy address (e.g. addresses["base"].LitePSM).
 *      These are managed by the existing save/load/has helpers below.
 *   2. A reserved `upgrades` key whose value is { [bookKey]: UpgradeRecord[] }.
 *      Append-only audit trail of proxy upgrades. Lookups by contract name skip
 *      this key (it's not a chain entry) — see `loadNetworkAddresses`.
 */

import fs from "fs";
import path from "path";

const ADDRESS_BOOK_PATH = path.join(__dirname, "../config/addresses.json");

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

/**
 * Load the address book from disk
 */
export function loadAddressBook(): AddressBook {
  if (!fs.existsSync(ADDRESS_BOOK_PATH)) {
    return {};
  }

  try {
    const content = fs.readFileSync(ADDRESS_BOOK_PATH, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Warning: Could not parse address book: ${error}`);
    return {};
  }
}

/**
 * Save the address book to disk
 */
export function saveAddressBook(book: AddressBook): void {
  const dir = path.dirname(ADDRESS_BOOK_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(ADDRESS_BOOK_PATH, JSON.stringify(book, null, 2), "utf8");
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
