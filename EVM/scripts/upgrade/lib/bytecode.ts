/**
 * Runtime-bytecode comparison and new-implementation sanity checks.
 */

import { ethers, artifacts } from "hardhat";

// ---------------------------------------------------------------------------
// Metadata stripping
// ---------------------------------------------------------------------------
//
// solc appends a CBOR metadata blob to runtime code, followed by its length as
// a 2-byte big-endian integer. With `bytecodeHash: "none"` (hardhat.config.ts,
// foundry.toml) the blob carries only the compiler version
// (`a1 64 "solc" 43 <version>`, length 0x000a) — no source hash, so comment
// edits do not change the code. The strip below reads the length suffix rather
// than pattern-matching a specific blob shape, so it is correct for either
// setting; it refuses to strip anything that does not look like CBOR.

export function stripMetadata(hexCode: string): string {
  const hex = (hexCode.startsWith("0x") ? hexCode.slice(2) : hexCode).toLowerCase();
  if (hex.length < 4) return hex;
  const cborLen = parseInt(hex.slice(-4), 16);
  const total = (cborLen + 2) * 2;
  if (!Number.isFinite(cborLen) || total > hex.length) return hex;
  const blob = hex.slice(hex.length - total, hex.length - 4);
  // CBOR map header: a1..a5 (1-5 entries). Anything else is not metadata.
  if (!/^a[1-5]/.test(blob)) return hex;
  return hex.slice(0, hex.length - total);
}

interface ByteRange {
  start: number;
  length: number;
}

/**
 * Immutable byte ranges for `contractName` from its build-info. UUPSUpgradeable
 * inlines the implementation's own address (`__self`), so two deployments of
 * identical source differ there.
 */
async function readImmutableRanges(contractName: string): Promise<ByteRange[]> {
  const fqNames = await artifacts.getAllFullyQualifiedNames();
  const fqName = fqNames.find((n) => n.endsWith(`:${contractName}`));
  if (!fqName) throw new Error(`no artifact for ${contractName}`);
  const buildInfo = await artifacts.getBuildInfo(fqName);
  if (!buildInfo) throw new Error(`no build-info for ${fqName}`);
  const [sourcePath, plainName] = fqName.split(":");
  const out = buildInfo.output?.contracts?.[sourcePath]?.[plainName] as any;
  const refs = out?.evm?.deployedBytecode?.immutableReferences as
    | Record<string, ByteRange[]>
    | undefined;
  return refs ? Object.values(refs).flat() : [];
}

function zeroRanges(hex: string, ranges: ByteRange[]): string {
  const chars = hex.split("");
  for (const r of ranges) {
    for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = "0";
  }
  return chars.join("");
}

/**
 * `true` iff the locally compiled runtime code of `contractName` equals the
 * code at `address`, ignoring metadata and immutables. Throws on read errors —
 * callers decide whether "could not tell" means "upgrade" or "stop".
 */
export async function runtimeMatches(contractName: string, address: string): Promise<boolean> {
  const artifact = await artifacts.readArtifact(contractName);
  const ranges = await readImmutableRanges(contractName);
  const onChain = await ethers.provider.getCode(address);
  if (!onChain || onChain === "0x") throw new Error(`no code at ${address}`);
  const local = zeroRanges(stripMetadata(artifact.deployedBytecode), ranges);
  const remote = zeroRanges(stripMetadata(onChain), ranges);
  return local === remote;
}

// ---------------------------------------------------------------------------
// New-implementation checks
// ---------------------------------------------------------------------------

/** OZ v5 `Initializable` ERC-7201 slot; `_initialized` is the low uint64. */
export const INITIALIZABLE_SLOT =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
/** ERC-1967 implementation slot; UUPS `proxiableUUID()` must return it. */
export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const UINT64_MAX = (1n << 64n) - 1n;

/**
 * A freshly deployed implementation must (a) have run `_disableInitializers()`
 * in its constructor, so nobody can initialize the bare implementation and
 * take its roles, and (b) be a UUPS implementation whose `proxiableUUID()` is
 * the ERC-1967 slot, or `upgradeToAndCall` would revert (or worse, brick).
 */
export async function assertImplementationSafe(impl: string): Promise<void> {
  const raw = BigInt(await ethers.provider.getStorage(impl, INITIALIZABLE_SLOT));
  if ((raw & UINT64_MAX) !== UINT64_MAX) {
    throw new Error(
      `New implementation ${impl} is not initializer-locked (_initialized = ${raw & UINT64_MAX}); ` +
        `its constructor must call _disableInitializers()`
    );
  }
  const uups = new ethers.Contract(
    impl,
    ["function proxiableUUID() view returns (bytes32)"],
    ethers.provider
  );
  let uuid: string;
  try {
    uuid = await uups.proxiableUUID();
  } catch (e: any) {
    throw new Error(`New implementation ${impl} has no proxiableUUID(): ${e?.message ?? e}`);
  }
  if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT) {
    throw new Error(`New implementation ${impl} proxiableUUID() = ${uuid}, expected ERC-1967 slot`);
  }
}
