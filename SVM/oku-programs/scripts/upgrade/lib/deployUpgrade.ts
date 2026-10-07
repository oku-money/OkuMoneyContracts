/**
 * Buffer-based program upgrade through the Solana CLI.
 *
 * The upgrade is split into explicit steps so each can be checked before the
 * next, and so the same buffer serves both modes:
 *
 *   1. write-buffer         upload the ELF into a buffer we hold the key for
 *   2. verify buffer        its bytes must hash to the local ELF
 *   3a. direct:  extend (if the ELF outgrew ProgramData) + `program upgrade`
 *   3b. propose: `set-buffer-authority` to the multisig vault; the vault
 *       executes the upgrade (Squads), and `MODE=verify` checks it afterwards.
 *
 * Every CLI call passes `--keypair` (and `--upgrade-authority` /
 * `--buffer-authority`) explicitly: the CLI otherwise signs with whatever
 * `~/.config/solana/cli/config.yml` names, which need not be the wallet the
 * script verified. The program is addressed by its base58 ID, never by a
 * keypair file, so the target cannot silently become another program.
 *
 * Buffer keypairs live in `.upgrade-buffers/` (gitignored, mode 0600), outside
 * `target/` so `anchor clean` cannot destroy the key to a funded buffer. A
 * re-run with the same keypair resumes a partial upload.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getProgramDataAddress, PROGRAM_DATA_HEADER_SIZE } from './elfCompare';

/** Buffer account header: 4-byte variant tag + Option<Pubkey> (1 + 32). */
export const BUFFER_HEADER_SIZE = 37;

type Log = {
  info: (m: string) => void;
  success: (m: string) => void;
  warning: (m: string) => void;
  error: (m: string) => void;
};

export interface CliContext {
  walletPath: string;
  rpcUrl: string;
  priorityFee: number;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  log: Log;
}

const TRANSIENT = [
  /blockhash not found/i, /block height exceeded/i, /timed? ?out/i, /ETIMEDOUT/i,
  /ECONNRESET/i, /ENOTFOUND/i, /rate.?limit/i, /too many requests/i,
  /service unavailable/i, /\b50[234]\b/, /Unable to complete request/i,
  /max sign attempts/i, /Error: \d+ write transactions failed/i,
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `solana <args>` with retries on transient failures. Returns stdout. */
export async function solana(ctx: CliContext, what: string, args: string[]): Promise<string> {
  let last: any;
  for (let attempt = 1; attempt <= ctx.maxRetries; attempt++) {
    try {
      ctx.log.info(`  $ solana ${args.join(' ')}`);
      const out = execFileSync('solana', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: ctx.timeoutMs,
      });
      return out;
    } catch (err: any) {
      last = err;
      const msg = `${err?.message ?? ''}\n${err?.stderr ?? ''}\n${err?.stdout ?? ''}`;
      if (attempt === ctx.maxRetries || !TRANSIENT.some((re) => re.test(msg))) break;
      ctx.log.warning(`  ${what}: transient failure (attempt ${attempt}/${ctx.maxRetries}); retrying in ${ctx.retryDelayMs / 1000}s`);
      await sleep(ctx.retryDelayMs);
    }
  }
  const detail = `${last?.stderr ?? ''}${last?.stdout ?? ''}`.trim() || String(last?.message ?? last);
  throw new Error(`${what} failed: ${detail}`);
}

const common = (ctx: CliContext) => ['--url', ctx.rpcUrl, '--keypair', ctx.walletPath];

// ---------------------------------------------------------------------------
// Buffer keypairs
// ---------------------------------------------------------------------------

export function bufferKeypairPath(root: string, network: string, programKey: string): string {
  return path.join(root, '.upgrade-buffers', `${network}-${programKey}-buffer-keypair.json`);
}

/** Load the persisted buffer keypair, or create one (0600). */
export function loadOrCreateBufferKeypair(file: string): Keypair {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(file, 'utf-8'))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export function recoveryHint(buffer: string, ctx: Pick<CliContext, 'rpcUrl' | 'walletPath'>): string {
  return (
    `Buffer ${buffer} may still hold rent. Re-running resumes the upload with the same buffer.\n` +
    `To abandon it and recover the lamports:\n` +
    `  solana program close ${buffer} --recipient <YOUR_WALLET> --keypair ${ctx.walletPath} --url ${ctx.rpcUrl}\n` +
    `List every buffer you hold: solana program show --buffers --keypair ${ctx.walletPath} --url ${ctx.rpcUrl}`
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export async function writeBuffer(ctx: CliContext, soPath: string, bufferFile: string): Promise<PublicKey> {
  const kp = loadOrCreateBufferKeypair(bufferFile);
  await solana(ctx, 'write-buffer', [
    'program', 'write-buffer', soPath,
    '--buffer', bufferFile,
    '--buffer-authority', ctx.walletPath,
    '--with-compute-unit-price', String(ctx.priorityFee),
    '--max-sign-attempts', '100',
    '--use-rpc',
    ...common(ctx),
  ]);
  return kp.publicKey;
}

export interface BufferInfo {
  authority: PublicKey | null;
  data: Buffer;
}

export async function readBuffer(connection: Connection, buffer: PublicKey): Promise<BufferInfo> {
  const info = await connection.getAccountInfo(buffer, 'confirmed');
  if (!info) throw new Error(`buffer ${buffer.toBase58()} not found`);
  if (info.data.length < BUFFER_HEADER_SIZE || info.data.readUInt32LE(0) !== 1) {
    throw new Error(`${buffer.toBase58()} is not a BPFLoaderUpgradeable buffer`);
  }
  return {
    authority: info.data[4] === 1 ? new PublicKey(info.data.subarray(5, 37)) : null,
    data: info.data.subarray(BUFFER_HEADER_SIZE),
  };
}

/** The buffer must hold exactly the local ELF (any tail must be zero). */
export async function verifyBuffer(
  connection: Connection,
  buffer: PublicKey,
  elf: Buffer
): Promise<BufferInfo> {
  const b = await readBuffer(connection, buffer);
  if (b.data.length < elf.length) throw new Error(`buffer holds ${b.data.length} bytes, ELF is ${elf.length}`);
  const head = createHash('sha256').update(b.data.subarray(0, elf.length)).digest('hex');
  const want = createHash('sha256').update(elf).digest('hex');
  if (head !== want) throw new Error(`buffer content sha256 ${head} != local ELF ${want}`);
  if (b.data.subarray(elf.length).some((x) => x !== 0)) throw new Error(`buffer has non-zero bytes past the ELF`);
  return b;
}

export interface ProgramDataInfo {
  address: PublicKey;
  /** Bytes available for the ELF (account length minus the 45-byte header). */
  capacity: number;
  lamports: number;
  lastDeploySlot: bigint;
}

export async function programDataInfo(connection: Connection, programId: PublicKey): Promise<ProgramDataInfo> {
  const address = await getProgramDataAddress(connection, programId);
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) throw new Error(`ProgramData ${address.toBase58()} not found`);
  return {
    address,
    capacity: info.data.length - PROGRAM_DATA_HEADER_SIZE,
    lamports: info.lamports,
    lastDeploySlot: info.data.readBigUInt64LE(4),
  };
}

/** Bytes ProgramData must grow by to hold `elfLen`, and the rent that costs. */
export async function extensionNeeded(
  connection: Connection,
  programId: PublicKey,
  elfLen: number
): Promise<{ bytes: number; lamports: number }> {
  const pd = await programDataInfo(connection, programId);
  const bytes = Math.max(0, elfLen - pd.capacity);
  if (bytes === 0) return { bytes: 0, lamports: 0 };
  const total = PROGRAM_DATA_HEADER_SIZE + pd.capacity + bytes;
  const rent = await connection.getMinimumBalanceForRentExemption(total);
  return { bytes, lamports: Math.max(0, rent - pd.lamports) };
}

export async function extendProgram(ctx: CliContext, programId: PublicKey, bytes: number): Promise<void> {
  await solana(ctx, 'extend', ['program', 'extend', programId.toBase58(), String(bytes), ...common(ctx)]);
}

/** Direct upgrade from a verified buffer. Returns the transaction signature. */
export async function upgradeFromBuffer(
  ctx: CliContext,
  buffer: PublicKey,
  programId: PublicKey
): Promise<string> {
  const out = await solana(ctx, 'upgrade', [
    'program', 'upgrade', buffer.toBase58(), programId.toBase58(),
    '--upgrade-authority', ctx.walletPath,
    ...common(ctx),
  ]);
  return out.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{60,90})/)?.[1] ?? '<unknown-signature>';
}

export async function setBufferAuthority(ctx: CliContext, buffer: PublicKey, newAuthority: PublicKey): Promise<void> {
  await solana(ctx, 'set-buffer-authority', [
    'program', 'set-buffer-authority', buffer.toBase58(),
    '--new-buffer-authority', newAuthority.toBase58(),
    '--buffer-authority', ctx.walletPath,
    ...common(ctx),
  ]);
}

/** Most recent signature touching ProgramData at or after `sinceSlot`. */
export async function findUpgradeSignature(
  connection: Connection,
  programData: PublicKey,
  sinceSlot: number
): Promise<string> {
  const sigs = await connection.getSignaturesForAddress(programData, { limit: 20 }, 'confirmed');
  return sigs.find((s) => (s.slot ?? 0) >= sinceSlot && !s.err)?.signature ?? '<unknown-signature>';
}

export const formatSol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
