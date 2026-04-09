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

/**
 * Deploy a program using surfnet_writeProgram cheatcode.
 * This bypasses the standard BPFLoaderUpgradeable deployment which can timeout
 * on large programs (>200KB). The cheatcode writes program data directly in chunks.
 *
 * @param connection - The RPC connection
 * @param programId - The program ID (public key) to deploy to
 * @param programData - The raw .so file data as Buffer
 * @param authority - Optional upgrade authority (defaults to system program)
 * @returns true if deployment succeeded
 */
export async function deployProgramViaCheatcode(
  connection: Connection,
  programId: string,
  programData: Buffer,
  authority?: string
): Promise<boolean> {
  // Surfpool's cheatcode supports up to 5MB per chunk (limited by RPC max size)
  // Use 4MB chunks to leave room for JSON overhead
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const totalSize = programData.length;
  const numChunks = Math.ceil(totalSize / CHUNK_SIZE);

  logger.info(`Deploying ${programId} via surfnet_writeProgram (${totalSize} bytes, ${numChunks} chunk(s))`);

  for (let i = 0; i < numChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = programData.subarray(offset, Math.min(offset + CHUNK_SIZE, totalSize));
    // Note: surfnet_writeProgram expects raw hex without 0x prefix
    const hexData = chunk.toString('hex');

    const params: [string, string, number, string?] = [programId, hexData, offset];
    if (authority) {
      params.push(authority);
    }

    try {
      const response = await fetch(connection.rpcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'surfnet_writeProgram',
          params,
        }),
      });

      const json = await response.json();

      if (json.error) {
        logger.error(`Chunk ${i + 1}/${numChunks} failed: ${JSON.stringify(json.error)}`);
        return false;
      }

      const percent = Math.round(((i + 1) / numChunks) * 100);
      logger.info(`  Chunk ${i + 1}/${numChunks} written (${percent}%)`);
    } catch (err) {
      logger.error(`Chunk ${i + 1}/${numChunks} network error: ${err}`);
      return false;
    }
  }

  logger.success(`Program ${programId} deployed via cheatcode`);
  return true;
}

/**
 * Set upgrade authority for a program (Surfpool only).
 */
export async function setProgramAuthority(
  connection: Connection,
  programId: string,
  newAuthority?: string
): Promise<boolean> {
  try {
    const params: [string, string?] = [programId];
    if (newAuthority) {
      params.push(newAuthority);
    }

    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_setProgramAuthority',
        params,
      }),
    });

    const json = await response.json();
    return !json.error;
  } catch {
    return false;
  }
}

/**
 * Register an IDL with Surfpool for account parsing.
 */
export async function registerIdl(
  connection: Connection,
  idl: any,
  slot?: number
): Promise<boolean> {
  try {
    const params: [any, number?] = [idl];
    if (slot !== undefined) {
      params.push(slot);
    }

    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_registerIdl',
        params,
      }),
    });

    const json = await response.json();
    return !json.error;
  } catch {
    return false;
  }
}
