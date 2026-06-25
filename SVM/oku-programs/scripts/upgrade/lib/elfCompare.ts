/**
 * ELF-level comparison between locally-compiled .so and on-chain ProgramData.
 *
 * Unlike EVM where Solidity bytecode has metadata footers and immutable-reference
 * slots requiring normalization, SVM ELF binaries are stored verbatim in the
 * ProgramData account after a 45-byte BPFLoaderUpgradeable header. A plain
 * byte-for-byte comparison suffices — `declare_id!()` is baked in at build time
 * from the program keypair, so two builds of the same source + same keypair
 * produce identical ELFs.
 *
 * The only thing we strip before comparing is the 45-byte ProgramData prefix:
 *   4  bytes  variant tag (= 3 for ProgramData)
 *   8  bytes  last-deploy slot (u64 LE)
 *   1  byte   authority Option tag (1 = Some)
 *   32 bytes  upgrade authority pubkey
 * ─────────────────────────────────────────────────────────────
 *   45 bytes  total header
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';

/** Byte length of the BPFLoaderUpgradeable ProgramData account prefix. */
export const PROGRAM_DATA_HEADER_SIZE = 45;

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111'
);

export interface ElfInfo {
  /** Raw ELF size in bytes (header stripped). */
  size: number;
  /** SHA-256 hex digest of the ELF bytes (for audit trail). */
  sha256: string;
}

// ============================================================================
// Low-level account readers
// ============================================================================

/**
 * Derive the ProgramData account address for a BPFLoaderUpgradeable program.
 * The Program account stores the ProgramData pubkey at bytes [4, 36).
 */
export async function getProgramDataAddress(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(programId, 'confirmed');
  if (!info) {
    throw new Error(`Program ${programId.toBase58()} not found on chain.`);
  }
  if (!info.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    throw new Error(
      `Account ${programId.toBase58()} is not owned by BPFLoaderUpgradeable ` +
        `(owner: ${info.owner.toBase58()}).`
    );
  }
  if (info.data.length < 36) {
    throw new Error(
      `Program account ${programId.toBase58()} has malformed data ` +
        `(length ${info.data.length} < 36).`
    );
  }
  return new PublicKey(info.data.subarray(4, 36));
}

/**
 * Read the upgrade authority from a ProgramData account.
 * Returns null if the program has no authority (finalized / immutable).
 */
export async function getUpgradeAuthority(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey | null> {
  const programDataAddr = await getProgramDataAddress(connection, programId);
  const pdInfo = await connection.getAccountInfo(programDataAddr, 'confirmed');
  if (!pdInfo || pdInfo.data.length < PROGRAM_DATA_HEADER_SIZE) return null;
  // Byte 12: Option tag for upgrade authority (1 = Some, 0 = None)
  if (pdInfo.data[12] !== 1) return null;
  return new PublicKey(pdInfo.data.subarray(13, 45));
}

// ============================================================================
// ELF readers
// ============================================================================

/**
 * Read and fingerprint the on-chain ELF for a deployed program.
 * Strips the 45-byte ProgramData header before returning.
 *
 * IMPORTANT: BPFLoaderUpgradeable does NOT shrink the ProgramData account
 * when a smaller ELF is deployed over a larger one — the trailing bytes of
 * the previous ELF remain in place (zeroed by the upgrade machinery but
 * still allocated). To get a meaningful fingerprint of the *current*
 * program, pass `expectedSize` set to the size of the local ELF that was
 * just deployed (or expected to be on chain); we then hash only the first
 * `expectedSize` bytes after the header.
 *
 * Without `expectedSize` we hash the full account tail, which is correct
 * for pre-upgrade comparison (we want to detect ANY difference, including
 * size shrinkage) but produces a false-positive mismatch in the post-
 * upgrade verification path when the new ELF is smaller than the old.
 */
export async function readOnChainElf(
  connection: Connection,
  programId: PublicKey,
  expectedSize?: number,
): Promise<ElfInfo> {
  const programDataAddr = await getProgramDataAddress(connection, programId);
  const pdInfo = await connection.getAccountInfo(programDataAddr, 'confirmed');
  if (!pdInfo) {
    throw new Error(
      `ProgramData for ${programId.toBase58()} ` +
        `(at ${programDataAddr.toBase58()}) not found on chain.`
    );
  }
  if (pdInfo.data.length < PROGRAM_DATA_HEADER_SIZE) {
    throw new Error(
      `ProgramData for ${programId.toBase58()} is shorter than the minimum ` +
        `header size (${pdInfo.data.length} < ${PROGRAM_DATA_HEADER_SIZE}).`
    );
  }
  let elfBytes = pdInfo.data.subarray(PROGRAM_DATA_HEADER_SIZE);
  if (expectedSize !== undefined) {
    if (elfBytes.length < expectedSize) {
      throw new Error(
        `On-chain ELF tail length ${elfBytes.length} < expectedSize ${expectedSize}; ` +
          `cannot fingerprint truncated payload.`
      );
    }
    elfBytes = elfBytes.subarray(0, expectedSize);
  }
  return {
    size: elfBytes.length,
    sha256: createHash('sha256').update(elfBytes).digest('hex'),
  };
}

/**
 * Fingerprint the local .so file.
 */
export function readLocalElf(soPath: string): ElfInfo {
  let bytes: Buffer;
  try {
    bytes = readFileSync(soPath);
  } catch (err: any) {
    throw new Error(
      `Cannot read local .so at ${soPath}: ${err.message ?? String(err)}`
    );
  }
  return {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// ============================================================================
// High-level comparison
// ============================================================================

export interface ElfCompareResult {
  /** True iff local and on-chain ELF are byte-identical (same SHA-256). */
  unchanged: boolean;
  local: ElfInfo;
  onChain: ElfInfo | null;
}

/**
 * Compare the locally-compiled .so against the on-chain ProgramData ELF.
 *
 * Returns `{ unchanged: true }` when the SHA-256 hashes match — meaning the
 * upgrade would be a no-op (same program already deployed). Returns
 * `{ unchanged: false }` on any comparison error so we fall through to the
 * real upgrade path rather than silently skipping.
 */
export async function compareElf(
  connection: Connection,
  programId: PublicKey,
  soPath: string,
  logger: { warning: (msg: string) => void }
): Promise<ElfCompareResult> {
  let onChain: ElfInfo | null = null;
  let local: ElfInfo;

  try {
    local = readLocalElf(soPath);
  } catch (err: any) {
    logger.warning(
      `Cannot read local .so (${err.message?.slice(0, 80) ?? err}); ` +
        `falling through to upgrade path.`
    );
    return { unchanged: false, local: { size: 0, sha256: '' }, onChain: null };
  }

  // Fingerprint the on-chain ELF using `local.size` so the hash covers
  // exactly the prefix the local ELF occupies on chain. BPFLoaderUpgradeable
  // does NOT shrink the ProgramData account on a smaller-ELF upgrade — the
  // trailing bytes from the previous (larger) ELF are zeroed but still
  // allocated, so a full-tail hash spuriously differs whenever the new ELF
  // is smaller than the historical maximum. The "size matches but content
  // matches the local prefix" case is the correct "already deployed" signal.
  //
  // Edge case: if the on-chain ELF tail is shorter than `local.size`, the
  // helper throws — that case is genuinely "different" (the account has
  // never held an ELF this large), so we fall through to the upgrade path.
  try {
    onChain = await readOnChainElf(connection, programId, local.size);
  } catch (err: any) {
    logger.warning(
      `Cannot read on-chain ELF (${err.message?.slice(0, 100) ?? err}); ` +
        `falling through to upgrade path.`
    );
    return { unchanged: false, local, onChain: null };
  }

  return {
    unchanged: local.sha256 === onChain.sha256,
    local,
    onChain,
  };
}
