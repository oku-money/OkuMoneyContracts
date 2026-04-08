/**
 * Surfpool Utilities for Scripts
 *
 * Lightweight utilities for detecting and working with Surfpool
 * in deployment and bridge scripts.
 */

import { Connection } from '@solana/web3.js';
import { logger } from './logger';

/**
 * Check if the connection is to a Surfpool instance with cheatcodes enabled.
 */
export async function isSurfpoolEnvironment(connection: Connection): Promise<boolean> {
  try {
    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_getSurfnetInfo',
        params: [],
      }),
    });
    const json = await response.json();
    return !json.error;
  } catch {
    return false;
  }
}

/**
 * Get information about the Surfpool instance.
 */
export async function getSurfpoolInfo(connection: Connection): Promise<any | null> {
  try {
    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_getSurfnetInfo',
        params: [],
      }),
    });
    const json = await response.json();
    if (json.error) return null;
    return json.result;
  } catch {
    return null;
  }
}

/**
 * Log Surfpool environment status.
 */
export async function logSurfpoolStatus(connection: Connection): Promise<boolean> {
  const isSurfpool = await isSurfpoolEnvironment(connection);

  if (isSurfpool) {
    logger.info('Running on Surfpool (cheatcodes available)');
    const info = await getSurfpoolInfo(connection);
    if (info?.forkedFrom) {
      logger.info(`Forked from: ${info.forkedFrom}`);
    }
  } else {
    logger.info('Running on standard validator (no Surfpool cheatcodes)');
  }

  return isSurfpool;
}

/**
 * Check if the network appears to be a fork of devnet.
 * Looks for known devnet accounts to verify.
 */
export async function isDevnetFork(connection: Connection): Promise<boolean> {
  // Pyth devnet USDC/USD feed
  const PYTH_DEVNET_USDC = '5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7';

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const accountInfo = await connection.getAccountInfo(new PublicKey(PYTH_DEVNET_USDC));
    return accountInfo !== null;
  } catch {
    return false;
  }
}

/**
 * Check if the network appears to be a fork of mainnet.
 * Looks for known mainnet accounts to verify.
 */
export async function isMainnetFork(connection: Connection): Promise<boolean> {
  // Circle USDC on mainnet
  const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const accountInfo = await connection.getAccountInfo(new PublicKey(USDC_MAINNET));
    return accountInfo !== null;
  } catch {
    return false;
  }
}

/**
 * Determine the effective network based on connection characteristics.
 * Useful for scripts that need to load the right deployment file.
 */
export async function detectEffectiveNetwork(
  connection: Connection,
  declaredNetwork: string
): Promise<'localnet' | 'devnet' | 'devnet-fork' | 'mainnet-beta' | 'mainnet-fork'> {
  const isSurfpool = await isSurfpoolEnvironment(connection);

  if (!isSurfpool) {
    // Not Surfpool, use declared network
    return declaredNetwork as any;
  }

  // Check what we're forked from
  const isDevnet = await isDevnetFork(connection);
  const isMainnet = await isMainnetFork(connection);

  if (isMainnet) {
    return 'mainnet-fork';
  }
  if (isDevnet) {
    return 'devnet-fork';
  }

  // Default to localnet if we can't determine
  return 'localnet';
}

/**
 * Time travel to a specific timestamp (Surfpool only).
 * Useful for testing deadline expiration in bridge scripts.
 */
export async function timeTravel(
  connection: Connection,
  absoluteTimestampMs: number
): Promise<boolean> {
  try {
    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_timeTravel',
        params: [{ absoluteTimestamp: absoluteTimestampMs }],
      }),
    });
    const json = await response.json();
    return !json.error;
  } catch {
    return false;
  }
}
