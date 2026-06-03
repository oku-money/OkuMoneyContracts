/**
 * Surfpool utilities for deployment and admin scripts.
 *
 * Only the helpers actively consumed by scripts are kept here.
 * For the full Surfpool JSON-RPC cheatcode surface (timeTravel, writeProgram,
 * setProgramAuthority, registerIdl, etc.) see the Surfpool documentation.
 */

import { Connection } from "@solana/web3.js";
import { logger } from "./logger";

/**
 * Check if the connection is to a Surfpool instance with cheatcodes enabled.
 */
async function isSurfpoolEnvironment(connection: Connection): Promise<boolean> {
  try {
    const response = await fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_getSurfnetInfo",
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
 * Log Surfpool environment status.
 * Returns true if connected to a Surfpool instance.
 */
export async function logSurfpoolStatus(connection: Connection): Promise<boolean> {
  const isSurfpool = await isSurfpoolEnvironment(connection);

  if (isSurfpool) {
    logger.info("Running on Surfpool (cheatcodes available)");
    try {
      const response = await fetch(connection.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "surfnet_getSurfnetInfo",
          params: [],
        }),
      });
      const json = await response.json();
      if (json.result?.forkedFrom) {
        logger.info(`Forked from: ${json.result.forkedFrom}`);
      }
    } catch {
      // info fetch failing is non-fatal
    }
  } else {
    logger.info("Running on standard validator (no Surfpool cheatcodes)");
  }

  return isSurfpool;
}
