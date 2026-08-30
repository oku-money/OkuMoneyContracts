/**
 * Deterministic deployment configuration.
 *
 * Bumping `DEPLOYMENT_VERSION` changes every CREATE2 salt → every contract
 * address. Use sparingly. v0.x is for pre-audit iteration; v1.0+ is reserved
 * for audited deployments.
 *
 * # Addressing scheme
 *
 * Every UUPS proxy + its implementation are deployed via CREATE2 through the
 * Arachnid deterministic deployment proxy at
 * `0x4e59b44847b379578588920cA78FbF26c0B4956C`. The factory exists at the
 * same address on every EVM chain it has been deployed to (gas-funded by
 * a presigned Nick's-method tx; see github.com/Arachnid/deterministic-deployment-proxy).
 *
 * Salt derivation (`saltFor("OkuM.impl")` etc.):
 *   keccak256("okumoney." + DEPLOYMENT_VERSION + "." + contractName)
 *
 * CREATE2 address derivation:
 *   address = keccak256(0xff ++ CREATE2_FACTORY ++ salt ++ keccak256(initCode))[12:]
 *
 * Same source tree compiled with the same solc version produces the same
 * `initCode` → same address on every chain the factory exists on. The
 * proxy's CREATE2 address depends on its impl address (constructor arg),
 * which is itself CREATE2-deterministic, so the chain transitively pins.
 *
 * # Per-chain variance
 *
 * Constructor args that are chain-specific (real USDC on mainnet vs.
 * MockUSDC on testnet, Chainlink feed addresses) cascade into different
 * proxy addresses on those chains. For pre-audit v0.1 testnets we deploy
 * MockUSDC deterministically too, so `LitePSM` ends
 * up with identical addresses across every testnet that has the factory.
 *
 * Chains without the CREATE2 factory fall through to standard
 * nonce-based CREATE deploys (unique addresses per chain). See
 * `scripts/utils/create2Deploy.ts`.
 */

/**
 * Deployment version embedded in every CREATE2 salt. Bumping this is a
 * one-way door (any prior-version deploy keeps its old addresses; future
 * deploys take new addresses). Pre-audit iterate with v0.x; reserve v1.0+
 * for audited deployments.
 */
export const DEPLOYMENT_VERSION = "v0.3";

/**
 * Canonical Arachnid CREATE2 factory. Same address on every supported chain.
 * Source: https://github.com/Arachnid/deterministic-deployment-proxy
 *
 * Verify on any chain with:
 *   curl <RPC> -X POST -H "Content-Type: application/json" \
 *     --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x4e59b44847b379578588920cA78FbF26c0B4956C","latest"],"id":1}'
 *
 * Non-empty bytecode confirms the factory is deployed.
 */
export const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/**
 * Compute the deterministic salt for a named deploy target.
 *
 * The full salt is `keccak256("okumoney." + DEPLOYMENT_VERSION + "." + name)`,
 * where `name` typically includes the contract name + a role suffix
 * (e.g. `OkuM.impl`, `OkuM.proxy`).
 *
 * @param name salt namespace, e.g. "OkuM.impl", "MockUSDC".
 * @returns 32-byte salt as a 0x-prefixed hex string.
 */
export function saltFor(name: string): string {
  // Inline ethers-free keccak so this module stays import-cheap.
  // Caller is in a hardhat process; ethers is already available; we use
  // the runtime ethers from hardhat to avoid a separate keccak dep.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers } = require("hardhat");
  return ethers.keccak256(
    ethers.toUtf8Bytes(`okumoney.${DEPLOYMENT_VERSION}.${name}`)
  );
}
