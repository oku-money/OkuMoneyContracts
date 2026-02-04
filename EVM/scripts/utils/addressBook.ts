/**
 * Address book utilities for saving and loading deployed contract addresses
 */

import fs from "fs";
import path from "path";

const ADDRESS_BOOK_PATH = path.join(__dirname, "../config/addresses.json");

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
  const book = loadAddressBook();
  return book[network] || {};
}

/**
 * Check if a contract address exists for a network
 */
export function hasAddress(network: string, contractName: string): boolean {
  const book = loadAddressBook();
  return !!(book[network] && book[network][contractName]);
}
