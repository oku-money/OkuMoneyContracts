/**
 * Deterministic deployment configuration.
 *
 * Every UUPS proxy + its implementation deploy via CREATE2 through the
 * Arachnid deterministic deployment proxy, which exists at the same address on
 * every EVM chain it has been deployed to
 * (github.com/Arachnid/deterministic-deployment-proxy).
 *
 *   salt    = keccak256("okumoney." + DEPLOYMENT_VERSION + "." + contractName)
 *   address = keccak256(0xff ++ CREATE2_FACTORY ++ salt ++ keccak256(initCode))[12:]
 *
 * Same source tree + same solc version → same `initCode` → same address on
 * every chain the factory exists on. A proxy's CREATE2 address depends on its
 * impl address (constructor arg), which is itself CREATE2-deterministic, so
 * the chain transitively pins.
 *
 * Per-chain variance: chain-specific constructor args (real USDC on mainnet
 * vs. MockUSDC on testnet, Chainlink feed addresses) cascade into different
 * proxy addresses on those chains. Testnets deploy MockUSDC deterministically
 * too, so `LitePSM` matches across every testnet that has
 * the factory. Chains without the factory fall through to nonce-based CREATE
 * deploys (unique addresses per chain) — see `scripts/utils/create2Deploy.ts`.
 */

/**
 * Deployment version embedded in every CREATE2 salt. Bumping it changes every
 * salt → every contract address, and is a one-way door (any prior-version
 * deploy keeps its old addresses). Use sparingly: iterate pre-audit with v0.x,
 * reserve v1.0+ for audited deployments.
 *
 * See `scripts/config/addresses.README.md` for the address-book split and
 * `scripts/config/epochChains.ts` for the MVP chain set.
 */
export const DEPLOYMENT_VERSION = "v0.4";

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
 * Compute the deterministic salt for a named deploy target:
 * `keccak256("okumoney." + DEPLOYMENT_VERSION + "." + name)`, where `name`
 * typically includes the contract name + a role suffix.
 *
 * @param name salt namespace, e.g. "OkuMoney.impl", "MockUSDC".
 * @returns 32-byte salt as a 0x-prefixed hex string.
 */
export function saltFor(name: string): string {
  // Require hardhat's runtime ethers lazily so this module stays import-cheap.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers } = require("hardhat");
  return ethers.keccak256(
    ethers.toUtf8Bytes(`okumoney.${DEPLOYMENT_VERSION}.${name}`)
  );
}
