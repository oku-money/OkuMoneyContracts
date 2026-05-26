/**
 * Low-level program upgrade via `solana program deploy`.
 *
 * Key design decisions vs. the initial deploy in deploy/lib/programs.ts:
 *
 *   Buffer keypair persistence (auto-resume):
 *     A pre-generated keypair is saved to `target/upgrade-buffers/<prog>-buffer-keypair.json`
 *     and passed as `--buffer <keypair>` on every invocation. If the process
 *     dies mid-upload the CLI left a partially-written buffer at that address.
 *     On the next run the same `--buffer` argument causes the CLI to resume
 *     from where it stopped, saving the full upload cost (~5 SOL on mainnet
 *     for a 800 KB program). On success the BPF loader spills the buffer
 *     lamports back to the wallet automatically — no cleanup needed.
 *
 *   Post-timeout recheck:
 *     On devnet under congestion, `solana program deploy` sometimes finalizes
 *     the upgrade on-chain but takes longer to poll/confirm than our timeout
 *     window. The subprocess is killed, surfacing a misleading ETIMEDOUT. We
 *     do a brief re-read after any kill and treat a matching on-chain ELF as
 *     success (same logic as deploy/lib/programs.ts::precheckProgram).
 *
 *   Signature retrieval:
 *     We can't capture the CLI's stdout without losing live progress output.
 *     Instead, we record the slot just before deployment starts and then call
 *     `getSignaturesForAddress` on the ProgramData account post-deploy. The
 *     most recent signature at or after the pre-deploy slot is the upgrade tx.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getProgramDataAddress, PROGRAM_DATA_HEADER_SIZE, readOnChainElf } from './elfCompare';

// ============================================================================
// Transient-error patterns
// ============================================================================
// Mirrors deploy/lib/programs.ts and EVM/scripts/upgrade/index.ts.

const TRANSIENT_PATTERNS = [
  /blockhash not found/i,
  /block height exceeded/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /rate.?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /503/,
  /502/,
  /504/,
  /Unable to complete request at this time/i,
];

function isTransientError(err: any): boolean {
  const msg = ((err?.message ?? '') + (err?.stderr ?? '')).toString();
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Buffer-keypair management
// ============================================================================

/**
 * Load or create a persistent buffer keypair for a program.
 * Stored at `target/upgrade-buffers/<programKey>-buffer-keypair.json`.
 * This enables automatic resume from a partial upload on subsequent runs.
 */
export function getOrCreateBufferKeypairPath(programKey: string): string {
  const dir = join(process.cwd(), 'target', 'upgrade-buffers');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const keypairPath = join(dir, `${programKey}-buffer-keypair.json`);
  if (!existsSync(keypairPath)) {
    // Generate a fresh keypair and save it for reuse.
    const kp = Keypair.generate();
    writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)));
  }
  return keypairPath;
}

// ============================================================================
// Post-timeout recheck (mirrors deploy/lib/programs.ts)
// ============================================================================

/**
 * After the CLI exits (possibly killed by timeout), re-read the on-chain ELF
 * and compare its SHA-256 to the local .so. Returns true if the upgrade
 * landed, false if the chain still shows the old program.
 */
async function didUpgradeLand(
  connection: Connection,
  programId: PublicKey,
  expectedSha256: string
): Promise<boolean> {
  try {
    const onChain = await readOnChainElf(connection, programId);
    return onChain.sha256 === expectedSha256;
  } catch {
    return false;
  }
}

// ============================================================================
// Post-deploy signature retrieval
// ============================================================================

/**
 * Retrieve the most recent transaction signature that touched the program's
 * ProgramData account at or after `sinceSlot`. This is the upgrade tx.
 *
 * Returns '<unknown-signature>' if the RPC call fails or finds nothing in the
 * expected window — the upgrade is still considered successful, but the audit
 * record won't have a usable tx hash.
 */
export async function getUpgradeSignature(
  connection: Connection,
  programDataAddress: PublicKey,
  sinceSlot: number,
  logger: { info: (msg: string) => void; warning: (msg: string) => void }
): Promise<string> {
  try {
    // Fetch up to 10 recent signatures on the ProgramData account (ascending
    // slot order is NOT guaranteed by the RPC; results are newest-first).
    const sigs = await connection.getSignaturesForAddress(
      programDataAddress,
      { limit: 10 },
      'confirmed'
    );
    // Filter to signatures from the upgrade window. The Upgrade instruction
    // is the LAST touch on ProgramData (after the buffer upload), so the
    // most recent entry >= sinceSlot is our tx.
    const candidate = sigs.find((s) => (s.slot ?? 0) >= sinceSlot);
    if (candidate?.signature) {
      logger.info(`  Upgrade tx: ${candidate.signature} (slot ${candidate.slot})`);
      return candidate.signature;
    }
    logger.warning(
      `  No ProgramData signature found for slots >= ${sinceSlot}; ` +
        `recording <unknown-signature> in audit trail.`
    );
    return '<unknown-signature>';
  } catch (err: any) {
    logger.warning(
      `  getSignaturesForAddress failed: ${err.message?.slice(0, 80) ?? err}. ` +
        `Recording <unknown-signature>.`
    );
    return '<unknown-signature>';
  }
}

// ============================================================================
// Main deploy function
// ============================================================================

export interface DeployUpgradeOptions {
  /** Internal program name, used only for log messages. */
  programName: string;
  /** Filesystem key name (e.g. 'lite_psm'), used to build keypair/so paths. */
  programKey: string;
  programId: PublicKey;
  /** Path to program ID keypair (used as `--program-id`). */
  keypairPath: string;
  /** Path to the compiled .so. */
  soPath: string;
  walletPubkey: PublicKey;
  /** SHA-256 of the local .so (for post-timeout recheck). */
  localElfSha256: string;
  connection: Connection;
  /** RPC endpoint URL passed directly to the solana CLI (`--url`). */
  rpcUrl: string;
  priorityFee: number;
  maxRetries: number;
  retryDelayMs: number;
  deployTimeoutMs: number;
  logger: {
    info: (msg: string) => void;
    success: (msg: string) => void;
    warning: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface DeployUpgradeResult {
  txSignature: string;
}

/**
 * Execute `solana program deploy` as an upgrade with buffer-keypair persistence
 * (for automatic mid-upload resume), retry logic, post-timeout recheck, and
 * post-success signature retrieval.
 */
export async function deployUpgrade(
  opts: DeployUpgradeOptions
): Promise<DeployUpgradeResult> {
  const {
    programName, programKey, programId, keypairPath, soPath,
    walletPubkey, localElfSha256, connection, rpcUrl,
    priorityFee, maxRetries, retryDelayMs, deployTimeoutMs, logger,
  } = opts;

  // Persist a buffer keypair for this program so partial uploads can resume.
  const bufferKeypairPath = getOrCreateBufferKeypairPath(programKey);
  logger.info(
    `  Buffer keypair: ${bufferKeypairPath} ` +
      `(reused across retries for auto-resume on partial upload)`
  );

  // Record the pre-deploy slot so signature retrieval has a lower bound.
  let preDeploySlot = 0;
  try {
    preDeploySlot = await connection.getSlot('confirmed');
  } catch { /* non-fatal */ }

  let deployed = false;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries && !deployed; attempt++) {
    if (attempt > 1) {
      logger.warning(
        `  Retry ${attempt}/${maxRetries} for ${programName} in ${retryDelayMs / 1000}s...`
      );
      await sleep(retryDelayMs);
    }

    logger.info(`  solana program deploy (attempt ${attempt}/${maxRetries})...`);

    try {
      execSync(
        [
          `solana program deploy ${soPath}`,
          `--program-id ${keypairPath}`,
          `--buffer ${bufferKeypairPath}`,
          `--url "${rpcUrl}"`,
          `--with-compute-unit-price ${priorityFee}`,
          `--max-sign-attempts 100`,
          `--use-rpc`,
        ].join(' '),
        { stdio: 'inherit', timeout: deployTimeoutMs }
      );
      deployed = true;
    } catch (error: any) {
      lastError = error;

      // Post-execSync recheck: the CLI may have been killed by our Node timeout
      // AFTER the Upgrade instruction already finalized on-chain. Check the chain
      // before deciding whether to retry.
      const wasKilled =
        error.killed === true || /ETIMEDOUT/i.test(error.message ?? '');
      if (wasKilled) {
        logger.warning(
          `  ${programName}: solana CLI killed (timeout/signal) — ` +
            `checking chain for finalization before declaring failure...`
        );
        // Brief pause for the RPC to see any tx that mined in the last few seconds.
        await sleep(3_000);
        if (await didUpgradeLand(connection, programId, localElfSha256)) {
          logger.success(
            `  ${programName}: post-timeout recheck shows upgrade IS on-chain ` +
              `— treating CLI timeout as a false alarm.`
          );
          deployed = true;
          continue;
        }
      }

      if (!isTransientError(error) || attempt === maxRetries) {
        break;
      }
      logger.warning(
        `  Attempt ${attempt} failed (transient): ` +
          `${(error.message ?? '').toString().slice(0, 120)}`
      );
    }
  }

  if (!deployed) {
    const msg = lastError?.killed
      ? `${programName} upgrade timed out after ${maxRetries} attempts.`
      : `${programName} upgrade failed after ${maxRetries} attempts: ` +
        `${lastError?.message ?? String(lastError)}`;
    throw new Error(msg);
  }

  // Retrieve the upgrade tx signature from chain.
  const programDataAddr = await getProgramDataAddress(connection, programId);
  const txSignature = await getUpgradeSignature(
    connection,
    programDataAddr,
    preDeploySlot,
    logger
  );

  return { txSignature };
}
