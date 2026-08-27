#!/usr/bin/env tsx
/**
 * Cross-chain multiplier parity check.
 *
 * THIS IS THE ARTIFACT THAT MAKES "both chains agree on the price" VERIFIABLE.
 *
 * Neither chain can observe the other — no bridge, no oracle, no message passing
 * between them for multiplier state. So the on-chain contracts cannot themselves
 * assert that a mark landed everywhere. Checked from outside, though, the
 * assertion is direct and strong:
 *
 *     M_oku(evm) / 1e9 == multiplier(svm)   =>   both chains price a raw token identically
 *
 * WHY THIS REPLACED THE EPOCH CHECK. An earlier design had each chain record an
 * orchestrator-assigned `sync_epoch` per tick and compared those numbers. That
 * only ever proved both chains *wrote something* for tick N — never that they
 * wrote the SAME VALUE, which is the property anyone actually cares about. It
 * also needed a chain of supporting machinery to mean even that much (a
 * write-landed-in-epoch attestation so a window could not be opened and closed
 * empty, an anti-grief gap so windows could not be chained). Comparing values
 * directly subsumes all of it: a wrong-value write is caught, a missing write is
 * caught, and there is nothing on-chain to keep in sync.
 *
 * Run it after every mark, and wire it into monitoring. A persistent mismatch
 * means the two chains are pricing differently and cross-chain flow should stop
 * until it is resolved.
 *
 * PRECISION. EVM carries 18 decimals, SVM 9. Exact parity means
 * `evm_raw == svm_raw * 1e9`. The comparison is done in integer SVM units, so a
 * mark that is genuinely identical compares equal with no floating point
 * anywhere. `--tolerance` is expressed in SVM units (1 unit = 1e-9) and defaults
 * to 0.
 *
 * Usage:
 *   tsx scripts/admin/check-sync-parity.ts --evm=baseSepolia --svm=devnet
 *   tsx scripts/admin/check-sync-parity.ts --evm=base --svm=mainnet-beta --strict
 *
 * CLI:
 *   --evm=<chain>      EVM chain key in addresses.json::evm
 *   --svm=<network>    SVM network key in addresses.json::svm
 *   --tolerance=<n>    Permitted |difference| in SVM units (default 0)
 *   --strict           Exit non-zero on ANY divergence, warnings included
 *
 * Exit codes:
 *   0  multipliers agree within tolerance
 *   1  divergence detected (or any warning, under --strict)
 *   2  configuration / connectivity error
 */

import * as anchor from '@anchor-lang/core';
import { Program, AnchorProvider } from '@anchor-lang/core';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : process.env[name.toUpperCase().replace(/-/g, '_')];
}

const STRICT = process.argv.includes('--strict');
const EVM_CHAIN = arg('evm');
const SVM_NETWORK = arg('svm') ?? 'devnet';
const TOLERANCE = BigInt(arg('tolerance') ?? '0');

const ROOT = path.resolve(__dirname, '../../../..');
const ADDRESSES = path.join(ROOT, 'addresses.json');
const SVM_IDL = path.join(ROOT, 'artifacts/svm/lite_psm.json');

/**
 * Inline ABI fragment rather than the exported artifact, deliberately.
 *
 * A monitoring script must not fail because an artifact was regenerated with a
 * renamed contract or a reordered ABI. These four signatures are stable by
 * design; depending on them directly is the robust choice.
 */
const OKU_M_ABI = [
  'function uiMultiplier() view returns (uint256)',
  'function lastSteppedAt() view returns (uint256)',
  'function nextMarkAllowedAt() view returns (uint256)',
];

/** EVM precision (1e18) over SVM precision (1e9). */
const PRECISION_RATIO = 10n ** 9n;

function fail(msg: string, code = 2): never {
  console.error(`\x1b[31mERROR\x1b[0m ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------

async function readEvm(chain: string) {
  const book = JSON.parse(fs.readFileSync(ADDRESSES, 'utf8'));
  const entry = book.evm?.[chain];
  if (!entry) fail(`unknown EVM chain "${chain}". Known: ${Object.keys(book.evm ?? {}).join(', ')}`);

  // `okuM` is the current key; `okuDollar` is accepted so a registry written by
  // an older deploy still resolves rather than failing opaquely.
  const addr = entry.contracts?.okuM ?? entry.contracts?.okuDollar;
  if (!addr) fail(`no okuM address recorded for EVM chain "${chain}"`);

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL ?? entry.rpcUrl);
  const token = new ethers.Contract(addr, OKU_M_ABI, provider);

  const [multiplier, lastMark, nextMark] = await Promise.all([
    token.uiMultiplier(),
    token.lastSteppedAt(),
    token.nextMarkAllowedAt(),
  ]);

  return {
    address: addr,
    /** Raw 1e18-scaled multiplier. */
    raw: BigInt(multiplier),
    lastMark: BigInt(lastMark),
    nextMark: BigInt(nextMark),
  };
}

async function readSvm(network: string) {
  const book = JSON.parse(fs.readFileSync(ADDRESSES, 'utf8'));
  const entry = book.svm?.[network];
  if (!entry) fail(`unknown SVM network "${network}". Known: ${Object.keys(book.svm ?? {}).join(', ')}`);

  const programId = entry.programs?.litePsm;
  const configPda = entry.pdas?.psmConfig;
  const mint = entry.mints?.okuM;
  if (!programId || !configPda) {
    fail(`incomplete SVM entry for "${network}" (need programs.litePsm + pdas.psmConfig)`);
  }

  const connection = new Connection(process.env.SVM_RPC_URL ?? entry.rpcUrl, 'confirmed');
  // Read-only: a throwaway wallet is sufficient, nothing is signed.
  const provider = new AnchorProvider(connection, new anchor.Wallet(Keypair.generate()), {
    commitment: 'confirmed',
  });
  const idl = JSON.parse(fs.readFileSync(SVM_IDL, 'utf8'));
  const program = new Program(idl, provider);

  const cfg: any = await program.account.psmConfig.fetch(new PublicKey(configPda));
  const nowTs = BigInt(Math.floor(Date.now() / 1000));
  const lockUntil = BigInt(cfg.syncLockUntilTs.toString());

  // THE MULTIPLIER'S SOURCE OF TRUTH IS THE MINT EXTENSION, not the config
  // account. Reading it from the mint is the same read the token program itself
  // performs when it computes a UI amount, so a parity check against it is a
  // check against what wallets actually display.
  const raw = await readMintMultiplier(connection, mint ?? cfg.okuMMint.toString());

  return {
    programId,
    configPda,
    mint: mint ?? cfg.okuMMint.toString(),
    /** Raw 1e9-scaled multiplier. */
    raw,
    // Exclusive upper bound, matching `sync_window_engaged`.
    locked: nowTs < lockUntil,
    lockedUntil: lockUntil,
    duration: BigInt(cfg.syncWindowSecs.toString()),
    tinBps: BigInt(cfg.tinBps.toString()),
    toutBps: BigInt(cfg.toutBps.toString()),
    lastMarkTs: BigInt(cfg.lastMarkTs.toString()),
  };
}

/**
 * Read the `ScaledUiAmountConfig` multiplier off a Token-2022 mint and return
 * it as an integer in SVM units (1e9 scale).
 *
 * The extension stores the multiplier as an f64. Converting through
 * `Math.round(f * 1e9)` is exact for every value the program can write: the
 * program derives the f64 from a `u64 / 1e9`, and doubles represent every such
 * quotient below 2^53 without loss.
 */
async function readMintMultiplier(connection: Connection, mint: string): Promise<bigint> {
  const { getMint, getScaledUiAmountConfig, TOKEN_2022_PROGRAM_ID } = await import(
    '@solana/spl-token'
  );
  const info = await getMint(connection, new PublicKey(mint), 'confirmed', TOKEN_2022_PROGRAM_ID);
  const cfg = getScaledUiAmountConfig(info);
  if (!cfg) fail(`mint ${mint} has no ScaledUiAmountConfig extension`);
  return BigInt(Math.round(Number(cfg.multiplier) * 1e9));
}

function fmt(raw: bigint, decimals: number): string {
  return ethers.formatUnits(raw, decimals);
}

async function main() {
  if (!EVM_CHAIN) {
    fail('required: --evm=<chain>  (e.g. --evm=baseSepolia)');
  }

  console.log(`\nCross-chain multiplier parity:  EVM=${EVM_CHAIN}  SVM=${SVM_NETWORK}\n`);

  const [evm, svm] = await Promise.all([readEvm(EVM_CHAIN), readSvm(SVM_NETWORK)]);

  // Compare in SVM units: floor the EVM value into 1e9 scale. Exact parity is
  // `evm.raw == svm.raw * 1e9`, so any nonzero remainder is itself divergence
  // and is surfaced rather than silently truncated.
  const evmInSvmUnits = evm.raw / PRECISION_RATIO;
  const evmRemainder = evm.raw % PRECISION_RATIO;
  const diff = evmInSvmUnits > svm.raw ? evmInSvmUnits - svm.raw : svm.raw - evmInSvmUnits;

  const row = (k: string, a: unknown, b: unknown) =>
    console.log(`  ${k.padEnd(22)} ${String(a).padEnd(26)} ${String(b)}`);

  console.log(`  ${'FIELD'.padEnd(22)} ${'EVM'.padEnd(26)} SVM`);
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(26)} ${'-'.repeat(26)}`);
  row('multiplier', fmt(evm.raw, 18), fmt(svm.raw, 9));
  row('multiplier (raw)', evm.raw, svm.raw);
  row('lastMark', new Date(Number(evm.lastMark) * 1000).toISOString(), `${svm.lastMarkTs}`);
  row('nextMarkAllowedAt', new Date(Number(evm.nextMark) * 1000).toISOString(), '-');
  row('windowOpen', 'n/a (removed on EVM)', svm.locked);
  row('windowDuration', 'n/a (removed on EVM)', `${svm.duration}s`);
  row('tout', 'see module', `${svm.toutBps} bps`);
  console.log('');
  console.log(`  difference: ${diff} SVM unit(s)   (tolerance ${TOLERANCE})`);
  console.log('');

  const problems: string[] = [];
  let fatal = false;

  if (diff > TOLERANCE) {
    fatal = true;
    problems.push(
      `MULTIPLIER MISMATCH: EVM=${fmt(evm.raw, 18)} SVM=${fmt(svm.raw, 9)} ` +
        `(difference ${diff} SVM units > tolerance ${TOLERANCE}). The two chains are ` +
        `pricing a raw token differently. Stop cross-chain flow and reconcile against ` +
        `the intended mark before continuing.`
    );
  }

  if (evmRemainder !== 0n) {
    problems.push(
      `EVM multiplier is not representable at SVM precision (remainder ${evmRemainder} ` +
        `of 1e9). A mark should be chosen so both chains can carry it exactly; ` +
        `otherwise the chains permanently differ by sub-1e-9 dust.`
    );
  }

  if (evm.locked || svm.locked) {
    problems.push(
      `WINDOW OPEN (EVM=${evm.locked}, SVM=${svm.locked}). Multiplier-priced ` +
        `operations are gated on at least one chain. Expected immediately after a ` +
        `mark; investigate if it persists past the configured duration.`
    );
  }

  if (evm.duration !== svm.duration) {
    problems.push(
      `ASYMMETRIC WINDOW DURATION: EVM=${evm.duration}s SVM=${svm.duration}s. Marks ` +
        `will gate for different lengths on each chain; align them.`
    );
  }

  if (svm.duration === 0n) {
    problems.push(
      'SVM sync window is DISABLED (sync_window_secs = 0) — marks are not gated on ' +
        'that chain.'
    );
  }
  // NOTE: there is no EVM sync window to check. It was removed — EVM has no
  // dedicated bridge instruction for it to gate, and a mechanism that gates
  // nothing is worse than an absent one. SVM keeps its window for the two
  // direct bridge legs, so only that side is checked above.
  //
  // The step high-water-mark comparison went too, along with the ratchet. Its
  // replacement is not a cross-chain comparison at all: `MAX_STEP_BPS` is a
  // compile-time constant on both chains, so divergence would be a BUILD
  // mismatch rather than a runtime state divergence. See TRACKER.md — comparing
  // `tout` and `MAX_STEP_BPS` across builds is a tracked follow-up for this
  // script, and is the check that would actually catch it.

  if (problems.length === 0) {
    console.log('\x1b[32mPARITY OK\x1b[0m — both chains carry the same multiplier.\n');
    process.exit(0);
  }

  for (const p of problems) console.log(`\x1b[33m!\x1b[0m ${p}\n`);

  if (STRICT || fatal) {
    console.error('\x1b[31mPARITY FAILED\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[33mPARITY WARNINGS\x1b[0m (non-fatal without --strict)\n');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
