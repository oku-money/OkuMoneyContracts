/**
 * RPC compatibility shims.
 *
 * Some chains' JSON-RPC nodes return responses that violate the strict shape
 * ethers v6 expects. The most painful one we hit is BSC: for a contract-
 * creation tx that's been broadcast but not yet mined, BSC's RPC returns
 * `"to": ""` instead of `"to": null`, which makes hardhat-ethers'
 * `formatTransactionResponse` throw `BAD_DATA: invalid address (value="")`.
 * The exact same RPC returns `to: null` correctly once the tx mines, so it's
 * a transient-window bug in BSC's pending-tx representation.
 *
 * `installRpcCompatFixes(network)` monkey-patches BOTH the legacy `send` API
 * AND the EIP-1193 `request` API on hardhat's network.provider, normalising
 * responses BEFORE they reach the ethers formatter. We have to patch both
 * because hardhat-ethers' `HardhatEthersProvider` calls `send(method, params)`
 * exclusively (verified in node_modules/@nomicfoundation/hardhat-ethers/
 * src/internal/hardhat-ethers-provider.ts), while other code paths (some
 * upgrades-core utilities, custom scripts) use `request({method, params})`.
 *
 * Apply once per process, ideally as the first thing your script does.
 * Subsequent calls are no-ops (idempotency tracked via a sentinel symbol).
 */

const PATCHED = Symbol.for("okumoney.rpcCompatPatched");

const TX_BY_HASH_METHODS = new Set([
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt",
]);

const BLOCK_METHODS = new Set([
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
]);

/**
 * Coerce `to: ""` → `to: null` in a single RPC response object.
 * Returns the same object (mutated) for convenience.
 */
function fixTxResponse(obj: any): any {
  if (obj && typeof obj === "object" && obj.to === "") {
    obj.to = null;
  }
  return obj;
}

/**
 * Apply the BSC `to: ""` shim to whatever shape the RPC returned.
 * Used by both `send` and `request` wrappers.
 */
function patchResult(method: string, result: any): any {
  if (TX_BY_HASH_METHODS.has(method)) {
    return fixTxResponse(result);
  }
  if (BLOCK_METHODS.has(method)) {
    // When `fullTxObjects=true`, the block contains an array of full tx
    // objects each with a `to` field potentially set to "" for pending
    // contract-creation txs.
    if (result && Array.isArray(result.transactions)) {
      for (const tx of result.transactions) fixTxResponse(tx);
    }
  }
  return result;
}

// Counters exposed for one-off diagnostics. Set DEBUG_RPC_PATCH=1 to log each
// fixup. Counts persist across the run so you can sanity-check from the script.
export const rpcCompatStats = { sendCalls: 0, requestCalls: 0, fixedCount: 0 };

const debugRpc = process.env.DEBUG_RPC_PATCH === "1";

export function installRpcCompatFixes(hreNetwork: { provider: any; name: string }): void {
  const provider = hreNetwork.provider;
  if (!provider) return;
  if ((provider as any)[PATCHED]) return; // already patched

  const trackFix = (method: string, result: any): any => {
    const before = result && typeof result === "object" && result.to;
    const out = patchResult(method, result);
    const after = out && typeof out === "object" && out.to;
    if (before === "" && after === null) {
      rpcCompatStats.fixedCount += 1;
      if (debugRpc) {
        console.log(`[rpcCompat] fixed ${method} response: to "" -> null`);
      }
    }
    return out;
  };

  // ---- Patch the legacy `send(method, params)` API ----
  // This is what hardhat-ethers calls (HardhatEthersProvider._hardhatProvider.send).
  if (typeof provider.send === "function") {
    const originalSend = provider.send.bind(provider);
    provider.send = async (method: string, params?: any[]) => {
      const result = await originalSend(method, params);
      rpcCompatStats.sendCalls += 1;
      return trackFix(method, result);
    };
  }

  // ---- Patch the EIP-1193 `request({method, params})` API ----
  // Used by some upgrades-core internals and any consumer that prefers the
  // standard interface.
  if (typeof provider.request === "function") {
    const originalRequest = provider.request.bind(provider);
    provider.request = async (args: { method: string; params?: any[] }) => {
      const result = await originalRequest(args);
      rpcCompatStats.requestCalls += 1;
      return trackFix(args.method, result);
    };
  }

  (provider as any)[PATCHED] = true;
  if (debugRpc) {
    console.log(`[rpcCompat] installed on ${hreNetwork.name} provider (${provider.constructor?.name})`);
  }
}
