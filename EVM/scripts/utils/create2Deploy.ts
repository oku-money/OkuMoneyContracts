/**
 * Deterministic deploy helpers via the Arachnid CREATE2 factory.
 *
 * The factory's API is: send a tx to `CREATE2_FACTORY` with calldata
 * `salt(32 bytes) ++ initCode`. It executes CREATE2 and (post-Cancun)
 * returns the deployed address as the 20-byte return data. We don't rely
 * on return data — we compute the expected address from
 * `keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]` and
 * confirm via `getCode` after the tx mines.
 *
 * Two public entry points:
 *
 *   - `deployContractDeterministic`: any contract with a constructor.
 *     Used for both impl contracts (no constructor args; OZ initializers
 *     handle setup) AND for ERC1967Proxy (constructor args = impl address
 *     + initCalldata).
 *
 *   - `create2FactoryAvailable`: runtime check that the factory exists on
 *     the connected chain. Callers should gate the CREATE2 path on this
 *     and fall back to standard CREATE if the factory is missing.
 *
 * Resumability: if the predicted address already has bytecode (a prior
 * partial deploy got that far), we skip the broadcast and reuse it.
 */

import { ethers } from "hardhat";
import type { Provider, Signer, ContractFactory } from "ethers";
import { CREATE2_FACTORY } from "../config/deploymentVersion";

/**
 * Return true if the Arachnid CREATE2 factory is deployed on the connected
 * chain. Cheap: one `eth_getCode` call.
 */
export async function create2FactoryAvailable(
  provider: Provider | null | undefined
): Promise<boolean> {
  const p = provider ?? ethers.provider;
  const code = await p.getCode(CREATE2_FACTORY);
  return code !== undefined && code !== "0x" && code.length > 2;
}

/**
 * Compute the CREATE2 address for a given salt + init-code pair, deployed
 * through `CREATE2_FACTORY`.
 *
 * Mirrors the EVM CREATE2 formula:
 *   address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
 */
export function computeCreate2Address(
  salt: string,
  initCode: string
): string {
  const initCodeHash = ethers.keccak256(initCode);
  return ethers.getCreate2Address(CREATE2_FACTORY, salt, initCodeHash);
}

/**
 * Build the init-code for a contract from its factory + (optional) constructor args.
 */
export function buildInitCode(
  factory: ContractFactory,
  constructorArgs: any[] = []
): string {
  const tx = factory.interface.encodeDeploy(constructorArgs);
  // `factory.bytecode` is the creation bytecode; appending the abi-encoded
  // constructor args produces the init-code that CREATE2 hashes.
  const creationBytecode = factory.bytecode;
  // ethers' encodeDeploy returns the 0x-prefixed encoded args; we strip the
  // 0x and append to the creation bytecode (which also has 0x).
  return creationBytecode + tx.slice(2);
}

/**
 * Deploy `factory` via CREATE2 with the given salt and constructor args.
 *
 * @returns the deterministically-computed address. If a contract already
 *          exists at the predicted address (resumed partial deploy), no
 *          tx is broadcast and the existing address is returned.
 */
export async function deployContractDeterministic(
  factory: ContractFactory,
  salt: string,
  constructorArgs: any[],
  signer: Signer,
  label: string
): Promise<{ address: string; reused: boolean }> {
  const initCode = buildInitCode(factory, constructorArgs);
  const predicted = computeCreate2Address(salt, initCode);

  // Resumability: if there's already bytecode at the predicted address,
  // a prior run got this far. Trust on-chain truth and skip.
  const existing = await ethers.provider.getCode(predicted);
  if (existing && existing !== "0x" && existing.length > 2) {
    return { address: predicted, reused: true };
  }

  // CREATE2 factory ABI: `factory.call(salt ++ initCode)`. Calldata is the
  // raw concatenation; no function selector.
  const calldata = salt + initCode.slice(2);
  const tx = await signer.sendTransaction({
    to: CREATE2_FACTORY,
    data: calldata,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `CREATE2 deploy of ${label} failed (tx ${tx.hash}); receipt status ${receipt?.status}`
    );
  }

  // Confirm the deployed bytecode lives where we expect. Poll with backoff
  // because load-balanced public RPCs (Alchemy, etc.) can return stale
  // `getCode` results for several seconds after a tx mines — different
  // request → different node → state not propagated yet. The receipt
  // already told us the tx succeeded, so we just need to give the RPC
  // network a chance to catch up.
  const pollMaxMs = 30_000;
  const pollIntervalMs = 2_000;
  const pollStart = Date.now();
  let lastCode = "0x";
  while (Date.now() - pollStart < pollMaxMs) {
    try {
      lastCode = await ethers.provider.getCode(predicted);
      if (lastCode && lastCode !== "0x" && lastCode.length > 2) {
        return { address: predicted, reused: false };
      }
    } catch {
      // Transient — keep polling within budget.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `CREATE2 deploy of ${label} reported success (tx ${tx.hash}) but no ` +
      `bytecode at predicted address ${predicted} after ${pollMaxMs / 1000}s of polling. ` +
      `Factory at ${CREATE2_FACTORY} may have rejected the deploy (salt collision?), ` +
      `or the RPC node is severely lagged. Last getCode result: ${lastCode.slice(0, 80)}`
  );
}

/**
 * Build the ERC1967Proxy creation bytecode wrapping (impl, initCalldata).
 *
 * We bundle this here so deploy/index.ts doesn't have to know about the
 * proxy ABI directly. Hardhat doesn't compile ERC1967Proxy by default
 * (it's pulled in transitively via @openzeppelin/contracts-upgradeable),
 * so we load it from the OZ upgrades-core artifact that the plugin ships.
 */
export async function buildERC1967ProxyInitCode(
  impl: string,
  initCalldata: string
): Promise<string> {
  // Same artifact the hardhat-upgrades plugin uses internally.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const erc1967ArtifactPath =
    "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts-v5/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json";
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyArtifact = require(erc1967ArtifactPath);
  const proxyBytecode: string = proxyArtifact.bytecode;

  // ERC1967Proxy(address implementation, bytes memory _data) — two ctor args.
  const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [impl, initCalldata]
  );

  return proxyBytecode + encodedArgs.slice(2);
}
