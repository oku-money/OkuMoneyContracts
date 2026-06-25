/**
 * Centralized network resolution for deploy / test / admin scripts.
 *
 * A "network context" cleanly separates three things that scripts repeatedly
 * confused before:
 *
 *   1. `networkName`   — which chain we're targeting (drives chain config,
 *                        chain ID, USDC fallback, etc.). Sourced from the
 *                        NETWORK env var, or auto-detected from the running
 *                        local fork's chainId, or hardhat's runtime network.
 *
 *   2. `bookKey`       — the key in `addresses.json` to read/write. For LIVE
 *                        runs this equals `networkName` ("base"). For FORK
 *                        runs we prefix `"fork:"` ("fork:base") so fork-only
 *                        deployments never pollute the live address book.
 *
 *   3. `isFork`        — whether hardhat is running against a local fork node
 *                        (`localhost` or `hardhat`) vs. a live RPC. Drives
 *                        impersonation, address-book namespacing, skipping
 *                        Etherscan verification, etc.
 *
 * Auto-detection rules (in order):
 *   - If `NETWORK=<chain>` is set explicitly, use it as `networkName`. On a
 *     fork, cross-check that the running node's chainId matches the
 *     declared chain — fail fast on mismatch.
 *   - Otherwise on a fork, query the running node's chainId and find the
 *     matching entry in `CHAIN_METADATA`.
 *   - Otherwise (live deploy without NETWORK), use `network.name` directly.
 */

import { ethers, network } from "hardhat";
import {
  getChainConfig,
  getNetworkNameByChainId,
  ChainConfig,
} from "../config/chains";
import { logger } from "./logger";
import { installRpcCompatFixes } from "./rpcCompat";

export interface NetworkContext {
  /** Target chain name as used in CHAIN_METADATA (e.g. "base", "sepolia"). */
  networkName: string;
  /** Address book key — `fork:<chain>` on a fork, `<chain>` on live. */
  bookKey: string;
  /** True when hardhat runtime network is `localhost` or `hardhat`. */
  isFork: boolean;
  /** Resolved live-chain config (chainId, name, usdc, rpcUrl). */
  chainConfig: ChainConfig;
}

const FORK_RUNTIME_NETWORKS = new Set(["localhost", "hardhat"]);

/**
 * Resolve the full network context for the current hardhat run.
 *
 * Async because it may need to query the running node's chainId for auto-detect.
 *
 * @param opts.silent - if true, suppress info-level logs about auto-detection.
 *                      Useful for quick read-only scripts.
 */
export async function resolveNetworkContext(
  opts: { silent?: boolean } = {}
): Promise<NetworkContext> {
  // Apply RPC response shims (currently: BSC pending-tx `to: ""` → `null`).
  // No-op on chains that already return well-formed responses; idempotent.
  installRpcCompatFixes(network);

  const isFork = FORK_RUNTIME_NETWORKS.has(network.name);
  const explicit = (process.env.NETWORK || "").trim();

  let networkName: string;

  if (explicit) {
    networkName = explicit;
  } else if (isFork) {
    const liveChainId = Number((await ethers.provider.getNetwork()).chainId);
    const detected = getNetworkNameByChainId(liveChainId);
    if (!detected) {
      throw new Error(
        `Local fork node reports chainId ${liveChainId}, but no entry in ` +
        `CHAIN_METADATA matches it. Either add it to scripts/config/chains.ts ` +
        `or set NETWORK=<chain> explicitly.`
      );
    }
    networkName = detected;
    if (!opts.silent) {
      logger.info(
        `Auto-detected target chain "${networkName}" from running fork ` +
        `(chainId ${liveChainId}); set NETWORK=<chain> to override.`
      );
    }
  } else {
    networkName = network.name;
  }

  const chainConfig = getChainConfig(networkName);

  // Cross-check explicit NETWORK= against the running fork's actual chainId.
  // Auto-detect path already guarantees agreement so we skip there.
  if (isFork && explicit) {
    const liveChainId = Number((await ethers.provider.getNetwork()).chainId);
    if (liveChainId !== chainConfig.chainId) {
      throw new Error(
        `Chain ID mismatch: local node reports chainId ${liveChainId}, ` +
        `but NETWORK=${networkName} expects chainId ${chainConfig.chainId}.\n` +
        `  - To deploy to "${networkName}": restart \`hh node\` with ` +
        `\`FORK_NETWORK=${networkName} hh node\`.\n` +
        `  - To use the running fork: unset NETWORK to auto-detect, or set ` +
        `NETWORK to match the fork's chainId.`
      );
    }
  }

  const bookKey = isFork ? `fork:${networkName}` : networkName;

  return { networkName, bookKey, isFork, chainConfig };
}
