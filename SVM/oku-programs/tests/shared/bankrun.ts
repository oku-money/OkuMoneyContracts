/**
 * Bankrun harness for the SVM unit tests. This module is the test-runner
 * harness for the bankrun suite; all unit tests under `tests/bankrun/`
 * consume the helpers below.
 *
 * Why bankrun? `solana-test-validator` has a 30s confirmation polling
 * window in `@solana/web3.js@1.x` that times out on heavyweight
 * transactions (multi-CPI mint + Token-2022 hop + PDA init in one
 * call). Bankrun runs the BPF programs in-process via `solana-bankrun`
 * (which wraps `litesvm`), eliminating the validator's confirmation
 * loop entirely.
 *
 * `anchor-bankrun`'s `BankrunProvider` is structurally compatible with
 * `@anchor-lang/core`'s `Provider` interface — both sides have the same
 * `connection`, `wallet`, `publicKey`, `sendAndConfirm`, etc. shape. The
 * only nominal-vs-structural mismatch is the package name; we cast through
 * `unknown` once at provider-registration time and the rest of the
 * codebase uses `@anchor-lang/core` normally.
 *
 * Heads-up: `BankrunConnectionProxy` (the `Connection` exposed by
 * `BankrunProvider.connection`) only implements `getAccountInfo`,
 * `getAccountInfoAndContext`, and `getMinimumBalanceForRentExemption`.
 * Anything else (`requestAirdrop`, `getLatestBlockhash`,
 * `confirmTransaction`, `sendRawTransaction`, `getTransaction`,
 * `getBalance`) must go through `harness.context.banksClient` or one of
 * the helpers in this module.
 */
import { startAnchor, BankrunProvider } from 'anchor-bankrun';
import * as anchor from '@anchor-lang/core';
import { Program, Idl, BN } from '@anchor-lang/core';
// The canonical multiplier is computed, not stored, so tests need the same
// math the program uses. This is the shared TS mirror, not a test-local copy.
import { computeMultiplier, scheduleFromConfig } from "@okumoney/yield-tooling";
import * as fs from 'fs';
import * as path from 'path';
import {
  ProgramTestContext,
  Clock,
  AddedAccount,
  AddedProgram,
  AccountInfoBytes,
} from 'solana-bankrun';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Signer,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BankrunHarness {
  context: ProgramTestContext;
  provider: BankrunProvider;
  payer: Keypair;
  /** The lite-psm program. */
  program: Program<LitePsm>;
}

export interface StartBankrunOptions {
  /** Extra .so programs to deploy beyond the workspace defaults. */
  extraPrograms?: AddedProgram[];
  /** Extra account snapshots to seed (e.g., a captured mainnet account). */
  extraAccounts?: AddedAccount[];
  /** Override compute budget if a single tx needs more than the default. */
  computeMaxUnits?: bigint;
  /**
   * Auto-advance the bankrun slot by 1 before every
   * `provider.sendAndConfirm`. Defaults to `true`.
   *
   * Why this exists: a real validator advances slots ~2.5x per second on
   * its own; bankrun's slot is sticky until something explicitly warps
   * it. Several program-side checks (e.g. `check_yield_lock` rejects
   * any op in the same slot as the last `distribute_yield`) become
   * impossible to satisfy without manual slot bumps between tests.
   * Tests that need full control over slot timing can pass
   * `{ autoBumpSlot: false }` and call `warpSlots(h, ...)` explicitly.
   */
  autoBumpSlot?: boolean;
}



// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Boot an in-process bankrun cluster, register a BankrunProvider, and
 * return a typed harness. Callers should `await` this in a `before` hook.
 *
 * The `extraAccounts` / `extraPrograms` knobs let tests pre-seed
 * arbitrary pre-existing on-chain state without having to fork a
 * remote cluster.
 */
export async function startBankrun(
  opts: StartBankrunOptions = {}
): Promise<BankrunHarness> {
  // Override the built-in Token-2022 binary with a mainnet dump that
  // supports the ScaledUiAmount extension. The version bundled with
  // solana-bankrun 0.4.0 (solana-program-test 1.18.x) predates
  // ScaledUiAmount (instruction index 43) and returns InvalidInstruction.
  //
  // The binary lives at `target/deploy/spl_token_2022.so` and is
  // regenerated via `make fetch-token-2022`. Once solana-bankrun ships
  // a version with ScaledUiAmount support, this override can be removed.
  const token2022Program: AddedProgram = {
    name: "spl_token_2022",
    programId: TOKEN_2022_PROGRAM_ID,
  };
  const programs = [token2022Program, ...(opts.extraPrograms ?? [])];

  const context = await startAnchor(
    '.',
    programs,
    opts.extraAccounts ?? [],
    opts.computeMaxUnits
  );
  const provider = new BankrunProvider(context);

  // Auto-bump slot wrapper. Replaces `provider.sendAndConfirm` with a
  // version that advances the bankrun slot by 1 before delegating.
  // Default-on; tests that need to inspect slot semantics directly can
  // opt out with `autoBumpSlot: false`.
  if (opts.autoBumpSlot !== false) {
    const original = provider.sendAndConfirm!.bind(provider);
    provider.sendAndConfirm = async (tx, signers, confirmOpts) => {
      const cur = await context.banksClient.getSlot();
      context.warpToSlot(cur + 1n);
      return original(tx, signers, confirmOpts);
    };
  }

  // BankrunProvider implements `Provider` from @coral-xyz/anchor; that
  // interface is structurally identical to @anchor-lang/core's `Provider`.
  // The cast is the only place where the package-name divergence surfaces.
  anchor.setProvider(provider as unknown as anchor.Provider);

  // ProgramTestContext.payer is already a @solana/web3.js Keypair on
  // solana-bankrun >=0.4.
  const payer = context.payer;
  // IMPORTANT: do NOT use `anchor.workspace.LitePsm` — its Proxy caches the
  // Program (with its bound provider/connection) across test files. When
  // multiple bankrun-flavoured test files run sequentially in one mocha
  // process, the second file's `setProvider` is ignored by the cached
  // Program, so reads route through the FIRST file's BanksClient. We
  // construct a fresh Program from the IDL every boot to avoid this.
  const program = loadProgramFromIdl<LitePsm>('lite_psm', provider);
  return { context, provider, payer, program };
}

/**
 * Construct an `anchor.Program<T>` from `target/idl/<name>.json`, bound
 * to the supplied provider. Bypasses `anchor.workspace`'s process-level
 * Program cache.
 */
export function loadProgramFromIdl<T extends Idl>(
  idlName: string,
  provider: BankrunProvider
): Program<T> {
  const idlPath = path.join('target', 'idl', `${idlName}.json`);
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8')) as Idl;
  return new Program(idl as any, provider as unknown as anchor.Provider) as Program<T>;
}

/**
 * Resolve another workspace program from the same harness. Loads the IDL
 * from `target/idl/<name>.json` and binds it to the harness's provider.
 * Bypasses `anchor.workspace`'s process-level cache (which would
 * otherwise leak provider bindings across sequential bankrun-flavoured
 * test files).
 */
export function getProgram<I extends Idl>(
  h: BankrunHarness,
  idlName: string
): Program<I> {
  return loadProgramFromIdl<I>(idlName, h.provider);
}

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

/** Read the current bankrun clock. Cheap; useful for absolute-time tests. */
export async function getClock(h: BankrunHarness): Promise<Clock> {
  return h.context.banksClient.getClock();
}

/**
 * Advance bankrun's clock by `secs` seconds. Bankrun does not advance its
 * clock automatically, so tests that depend on elapsed time call this
 * explicitly. Uses the `Clock` constructor directly (no `as any`).
 */
export async function warpBy(h: BankrunHarness, secs: number | bigint): Promise<void> {
  const delta = typeof secs === 'bigint' ? secs : BigInt(secs);
  const c = await h.context.banksClient.getClock();
  const next = new Clock(
    c.slot,
    c.epochStartTimestamp,
    c.epoch,
    c.leaderScheduleEpoch,
    c.unixTimestamp + delta
  );
  h.context.setClock(next);
}

/** Set bankrun's clock to an absolute unix timestamp. */
export async function warpTo(h: BankrunHarness, unixTs: number | bigint): Promise<void> {
  const ts = typeof unixTs === 'bigint' ? unixTs : BigInt(unixTs);
  const c = await h.context.banksClient.getClock();
  const next = new Clock(
    c.slot,
    c.epochStartTimestamp,
    c.epoch,
    c.leaderScheduleEpoch,
    ts
  );
  h.context.setClock(next);
}

/**
 * Advance bankrun's slot clock by `slots`. Replaces same-slot sandwich
 * mitigations (e.g. `await sleep(500)` after a yield op) that relied on
 * wall-clock slot rollover on the validator.
 */
export async function warpSlots(h: BankrunHarness, slots: number | bigint): Promise<void> {
  const cur = await h.context.banksClient.getSlot();
  const delta = typeof slots === 'bigint' ? slots : BigInt(slots);
  h.context.warpToSlot(cur + delta);
}

// ---------------------------------------------------------------------------
// Account / balance helpers
// ---------------------------------------------------------------------------

/** Lamport balance of `address`, or 0n if the account doesn't exist. */
export async function getLamports(
  h: BankrunHarness,
  address: PublicKey
): Promise<bigint> {
  const info = await h.context.banksClient.getAccount(address);
  if (!info) return 0n;
  return BigInt(info.lamports);
}

/**
 * Force-fund an account with lamports by overwriting its `lamports` field
 * via `setAccount`. If the account doesn't exist, creates a fresh
 * System-Program-owned slot.
 *
 * Bankrun has no `requestAirdrop` because there's no validator to issue
 * it. This is the equivalent.
 *
 * `AccountInfoBytes.lamports` is typed as `number` upstream (it's
 * `web3.js::AccountInfo<Uint8Array>`), so we coerce a `bigint` input
 * down with `Number(...)`. Bankrun internally promotes back to `bigint`
 * before handing to litesvm.
 */
export async function setLamports(
  h: BankrunHarness,
  address: PublicKey,
  lamports: number | bigint
): Promise<void> {
  const lam = typeof lamports === 'bigint' ? Number(lamports) : lamports;
  const existing = await h.context.banksClient.getAccount(address);
  const next: AccountInfoBytes = existing
    ? { ...existing, lamports: lam }
    : {
        lamports: lam,
        data: new Uint8Array(0),
        owner: SystemProgram.programId,
        executable: false,
        rentEpoch: 0,
      };
  h.context.setAccount(address, next);
}

/** Bulk-fund a list of keypairs via `setLamports` (bankrun has no
 *  `requestAirdrop`). Used by every test `before()` hook and by
 *  `initializePsm` to credit the shared authority keypairs. */
export async function fundKeypairs(
  h: BankrunHarness,
  kps: Keypair[],
  lamports: number | bigint
): Promise<void> {
  for (const kp of kps) {
    await setLamports(h, kp.publicKey, lamports);
  }
}

// ---------------------------------------------------------------------------
// Token-mint helpers (replacements for @solana/spl-token convenience fns
// that internally call provider.connection.sendTransaction, which the
// BankrunConnectionProxy doesn't implement)
// ---------------------------------------------------------------------------

/**
 * Create and initialize a fresh standard SPL Token mint.
 *
 * Returns the mint pubkey. Mirrors `@solana/spl-token::createMint` but
 * routes the System-Program create + InitializeMint instructions through
 * `BankrunProvider.sendAndConfirm` instead of
 * `Connection.sendTransaction` (which the proxy doesn't expose).
 */
export async function createMintViaBankrun(
  h: BankrunHarness,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  keypair: Keypair = Keypair.generate(),
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const rent = await h.context.banksClient.getRent();
  const lamports = rent.minimumBalance(BigInt(MINT_SIZE));
  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: h.payer.publicKey,
      newAccountPubkey: keypair.publicKey,
      lamports: Number(lamports),
      space: MINT_SIZE,
      programId: tokenProgramId,
    }),
    createInitializeMintInstruction(
      keypair.publicKey,
      decimals,
      mintAuthority,
      freezeAuthority,
      tokenProgramId
    )
  );
  await h.provider.sendAndConfirm!(tx, [keypair] as Signer[]);
  return keypair.publicKey;
}

/**
 * Mint `amount` tokens to `destination` ATA, signing as `authority`.
 * Replaces `@solana/spl-token::mintTo`, which is `Connection`-bound.
 */
export async function mintToViaBankrun(
  h: BankrunHarness,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: number | bigint,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): Promise<void> {
  const tx = new Transaction().add(
    createMintToInstruction(
      mint,
      destination,
      authority.publicKey,
      amount,
      [],
      tokenProgramId
    )
  );
  await h.provider.sendAndConfirm!(tx, [authority] as Signer[]);
}

/**
 * Create an Associated Token Account for `owner` on `mint`. Idempotent:
 * if the ATA already exists, this is a no-op (caught at submission time
 * by inspecting the existing account).
 */
export async function ensureAtaViaBankrun(
  h: BankrunHarness,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);
  const existing = await h.context.banksClient.getAccount(ata);
  if (existing) return ata;
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      h.payer.publicKey,
      ata,
      owner,
      mint,
      tokenProgramId
    )
  );
  await h.provider.sendAndConfirm!(tx);
  return ata;
}

// ---------------------------------------------------------------------------
// Tx helpers
// ---------------------------------------------------------------------------

/**
 * Submit a raw `Transaction` (already built by the caller) with the
 * given signers. Returns the `BanksTransactionMeta` from bankrun so the
 * caller can inspect `logMessages` / `computeUnitsConsumed`.
 *
 * Use this for negative tests where you need the log output even when
 * the tx fails — bankrun's `tryProcessTransaction` returns the meta
 * alongside the error string rather than throwing.
 */
export async function tryProcess(
  h: BankrunHarness,
  ixs: TransactionInstruction[],
  signers: Signer[] = []
) {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  const blockhashRes = await h.context.banksClient.getLatestBlockhash();
  if (!blockhashRes) throw new Error('bankrun returned null blockhash');
  tx.recentBlockhash = blockhashRes[0];
  tx.feePayer = h.payer.publicKey;
  if (signers.length > 0) {
    tx.partialSign(...signers);
  }
  tx.partialSign(h.payer);
  return h.context.banksClient.tryProcessTransaction(tx);
}

/** Raw contents of a mint's `ScaledUiAmountConfig` extension. */
export interface DisplayMultiplierState {
  /** Standing multiplier, as the f64 ratio the extension actually stores. */
  multiplier: number;
  /** Pre-armed successor value (0 when never written). */
  newMultiplier: number;
  /** When `newMultiplier` becomes effective. */
  effectiveTs: number;
  /** What a wallet renders right now, per `current_multiplier(unix_timestamp)`. */
  effective: number;
}

/**
 * Read the DISPLAY multiplier from a OkuM mint's ScaledUiAmountConfig.
 *
 * ## This is not the canonical multiplier
 *
 * Since the streaming-accrual port the extension is a **write-only display
 * mirror**: the program pushes values into it for wallets and never reads them
 * back. It lags the canonical multiplier by up to one `DISPLAY_SYNC_INTERVAL`
 * and is only guaranteed to satisfy `display <= canonical`.
 *
 * Use {@link computeCanonicalMultiplier} for anything that asserts on price.
 * Use this only to assert properties OF THE MIRROR (staleness, monotonicity,
 * the `<=` invariant).
 *
 * Returns the f64 values verbatim rather than a WAD-scaled BN: a WAD-scaled
 * multiplier can exceed 2^53, so round-tripping through `number` would lose
 * precision and manufacture spurious test failures.
 *
 * The extension (ExtensionType 25) stores:
 *   authority (32) | multiplier f64 (8) | effective_ts i64 (8) | new_multiplier f64 (8)
 */
export async function readDisplayMultiplier(
  h: BankrunHarness,
  mintPubkey: PublicKey,
): Promise<DisplayMultiplierState> {
  const SCALED_UI_AMOUNT_TYPE = 25; // ExtensionType::ScaledUiAmount

  const acct = await h.provider.connection.getAccountInfo(mintPubkey);
  if (!acct) throw new Error("Mint account not found");

  const data = acct.data;
  // TLV area starts at byte 166 (82 mint + 83 padding + 1 account type)
  for (let i = 166; i < data.length - 4; i++) {
    const extType = data[i] | (data[i + 1] << 8);
    if (extType === SCALED_UI_AMOUNT_TYPE) {
      const len = data[i + 2] | (data[i + 3] << 8);
      const extData = data.slice(i + 4, i + 4 + len);
      if (extData.length < 56) throw new Error("ScaledUiAmountConfig too short");

      const multiplier = Buffer.from(extData.slice(32, 40)).readDoubleLE(0);
      const effectiveTs = Number(Buffer.from(extData.slice(40, 48)).readBigInt64LE(0));
      const newMultiplier = Buffer.from(extData.slice(48, 56)).readDoubleLE(0);

      const clock = await h.context.banksClient.getClock();
      const unixTimestamp = Number(clock.unixTimestamp);

      // Exactly `ScaledUiAmountConfig::current_multiplier` — this is what a
      // wallet renders. Note it does NOT have the zero-init guard the old
      // on-chain `read_multiplier` carried; that helper is gone, and the
      // program now initialises the extension to 1.0 at init.
      const effective = unixTimestamp >= effectiveTs ? newMultiplier : multiplier;

      return { multiplier, newMultiplier, effectiveTs, effective };
    }
  }
  throw new Error("ScaledUiAmountConfig extension not found on mint");
}

/**
 * The CANONICAL multiplier — computed from the on-chain rate schedule exactly
 * the way the program does, via the shared TS mirror.
 *
 * This is what every price in the PSM is derived from, so it is what
 * assertions about mint/redeem amounts must use.
 *
 * @param atTs Optional evaluation timestamp. Defaults to the cluster clock.
 */
export async function computeCanonicalMultiplier(
  h: BankrunHarness,
  program: { account: { psmConfig: { fetch(a: PublicKey): Promise<unknown> } } },
  psmConfig: PublicKey,
  atTs?: bigint,
): Promise<bigint> {
  const cfg = (await program.account.psmConfig.fetch(psmConfig)) as Parameters<
    typeof scheduleFromConfig
  >[0];
  const ts = atTs ?? (await h.context.banksClient.getClock()).unixTimestamp;
  return computeMultiplier(scheduleFromConfig(cfg), BigInt(ts));
}

/**
 * Bankrun-aware `expectError`: bankrun wraps program failures in
 * `SendTransactionError` with the program logs already attached. We
 * search both the error message and the attached log array for the
 * expected error code (Anchor-style `MyError` identifier or a raw log
 * substring).
 */
export async function expectBankrunError(
  fn: () => Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await fn();
  } catch (err: unknown) {
    const e = err as { message?: string; logs?: string[]; transactionMessage?: string };
    const haystack = [
      e.message ?? '',
      e.transactionMessage ?? '',
      ...(e.logs ?? []),
    ].join(' ');
    if (!haystack.includes(expectedCode)) {
      throw new Error(
        `Expected bankrun error matching "${expectedCode}" but got:\n` +
          `  message: ${e.message}\n` +
          `  logs:\n    ${(e.logs ?? []).join('\n    ')}`
      );
    }
    return;
  }
  throw new Error(`Expected error matching "${expectedCode}" but call succeeded`);
}

// ---------------------------------------------------------------------------
// Simulation: log capture + compute-unit measurement
// ---------------------------------------------------------------------------

/** Result of simulating a built transaction against the bankrun VM. */
export interface SimulationResult {
  /** Raw program logs, including `Program data:` lines carrying Anchor events. */
  logs: string[];
  /** Compute units the transaction consumed. */
  computeUnits: number;
  /** Non-null if the transaction would have failed. */
  error: unknown | null;
}

/**
 * Simulate an Anchor-built transaction and return its logs and CU cost.
 *
 * `banksClient.getTransaction` does not exist in solana-bankrun 0.4.0, so this
 * is the route to both event logs and compute-unit measurement. Simulation runs
 * against current VM state without committing, so it is safe to call before or
 * instead of the real send.
 */
export async function simulateTx(
  h: BankrunHarness,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Keypair[] = [],
): Promise<SimulationResult> {
  const [blockhash] = await h.context.banksClient.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = h.payer.publicKey;
  tx.sign(h.payer, ...signers);

  const res = await h.context.banksClient.simulateTransaction(tx);
  return {
    logs: res.meta?.logMessages ?? [],
    computeUnits: Number(res.meta?.computeUnitsConsumed ?? 0n),
    error: res.result ?? null,
  };
}

/**
 * Decode every Anchor event emitted in a set of program logs.
 *
 * Anchor writes events as base64 on `Program data:` lines; `program.coder`
 * turns those back into typed objects. Returns `{ name, data }` pairs in
 * emission order.
 */
export function decodeEvents(
  program: { coder: { events: { decode(log: string): { name: string; data: unknown } | null } } },
  logs: string[],
): Array<{ name: string; data: unknown }> {
  const out: Array<{ name: string; data: unknown }> = [];
  for (const line of logs) {
    const marker = 'Program data: ';
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    try {
      const decoded = program.coder.events.decode(line.slice(idx + marker.length));
      if (decoded) out.push({ name: decoded.name, data: decoded.data });
    } catch {
      // Not one of ours (or a log line that merely looks like one) — skip.
    }
  }
  return out;
}
