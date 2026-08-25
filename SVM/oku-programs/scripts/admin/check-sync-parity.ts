#!/usr/bin/env tsx
/**
 * Cross-chain multiplier sync-parity check.
 *
 * THIS IS THE ARTIFACT THAT MAKES "both sides have updated" VERIFIABLE.
 *
 * Neither chain can observe the other — there is no bridge, no oracle and no
 * message passing between them. So the on-chain contracts cannot themselves
 * assert that a multiplier tick landed everywhere. What they CAN do is record an
 * orchestrator-assigned tick number (`sync_epoch` on SVM, `syncEpoch()` on EVM)
 * that is identical across chains for a given tick. Equality of those numbers,
 * checked from outside, is then a meaningful statement:
 *
 *     epoch_evm == epoch_svm  AND  no window open  =>  no tick in flight
 *
 * Run this before opening a window (to confirm a clean starting state) and after
 * closing one (to confirm the tick completed symmetrically). Wire it into
 * monitoring: a persistent epoch mismatch means an orchestrator died mid-tick
 * and the chains may be pricing differently.
 *
 * NOTE ON MULTIPLIER VALUES. This deliberately does NOT assert that the two
 * multipliers are equal. They never are: EVM accrues continuously while SVM
 * steps, and the two use different precision scales (1e18 vs 1e9). The
 * meaningful cross-chain assertion is about tick *completion*, not value
 * identity. The value skew is reported for information only.
 *
 * Usage:
 *   tsx scripts/admin/check-sync-parity.ts --evm=baseSepolia --svm=devnet
 *   tsx scripts/admin/check-sync-parity.ts --evm=base --svm=mainnet-beta --strict
 *
 * CLI:
 *   --evm=<chain>    EVM chain key in addresses.json::evm
 *   --svm=<network>  SVM network key in addresses.json::svm
 *   --strict         Exit non-zero on ANY divergence (for CI / monitoring)
 *
 * Exit codes:
 *   0  epochs agree and no window is open
 *   1  divergence detected (or a window is open, under --strict)
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

const ROOT = path.resolve(__dirname, '../../../..');
const ADDRESSES = path.join(ROOT, 'addresses.json');
const EVM_ABI = path.join(ROOT, 'artifacts/evm/OkuDollar.json');
const SVM_IDL = path.join(ROOT, 'artifacts/svm/lite_psm.json');

const OKU_DOLLAR_ABI = [
  'function syncEpoch() view returns (uint256)',
  'function syncLockedUntil() view returns (uint256)',
  'function isSyncLocked() view returns (bool)',
  'function syncWindowDuration() view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
];

function fail(msg: string, code = 2): never {
  console.error(`\x1b[31mERROR\x1b[0m ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------

async function readEvm(chain: string) {
  const book = JSON.parse(fs.readFileSync(ADDRESSES, 'utf8'));
  const entry = book.evm?.[chain];
  if (!entry) fail(`unknown EVM chain "${chain}". Known: ${Object.keys(book.evm ?? {}).join(', ')}`);

  const addr = entry.contracts?.okuDollar;
  if (!addr) fail(`no okuDollar address recorded for EVM chain "${chain}"`);

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL ?? entry.rpcUrl);
  const token = new ethers.Contract(addr, OKU_DOLLAR_ABI, provider);

  const [epoch, lockedUntil, locked, duration, multiplier] = await Promise.all([
    token.syncEpoch(),
    token.syncLockedUntil(),
    token.isSyncLocked(),
    token.syncWindowDuration(),
    token.uiMultiplier(),
  ]);

  return {
    address: addr,
    epoch: BigInt(epoch),
    lockedUntil: BigInt(lockedUntil),
    locked: Boolean(locked),
    duration: BigInt(duration),
    // 1e18-scaled on EVM.
    multiplier: Number(ethers.formatUnits(multiplier, 18)),
  };
}

async function readSvm(network: string) {
  const book = JSON.parse(fs.readFileSync(ADDRESSES, 'utf8'));
  const entry = book.svm?.[network];
  if (!entry) fail(`unknown SVM network "${network}". Known: ${Object.keys(book.svm ?? {}).join(', ')}`);

  const programId = entry.programs?.litePsm;
  const configPda = entry.pdas?.psmConfig;
  if (!programId || !configPda) fail(`incomplete SVM entry for "${network}" (need programs.litePsm + pdas.psmConfig)`);

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

  return {
    programId,
    configPda,
    epoch: BigInt(cfg.syncEpoch.toString()),
    lockedUntil: lockUntil,
    // Exclusive upper bound, matching `sync_window_engaged`.
    locked: nowTs < lockUntil,
    duration: BigInt(cfg.syncWindowSecs.toString()),
    toutBps: BigInt(cfg.toutBps.toString()),
    tinBps: BigInt(cfg.tinBps.toString()),
  };
}

async function main() {
  if (!EVM_CHAIN) {
    fail('required: --evm=<chain>  (e.g. --evm=baseSepolia)');
  }

  console.log(`\nCross-chain sync parity:  EVM=${EVM_CHAIN}  SVM=${SVM_NETWORK}\n`);

  const [evm, svm] = await Promise.all([readEvm(EVM_CHAIN), readSvm(SVM_NETWORK)]);

  const row = (k: string, a: unknown, b: unknown) =>
    console.log(`  ${k.padEnd(20)} ${String(a).padEnd(24)} ${String(b)}`);

  console.log(`  ${'FIELD'.padEnd(20)} ${'EVM'.padEnd(24)} SVM`);
  console.log(`  ${'-'.repeat(20)} ${'-'.repeat(24)} ${'-'.repeat(24)}`);
  row('syncEpoch', evm.epoch, svm.epoch);
  row('windowOpen', evm.locked, svm.locked);
  row('lockedUntil', evm.lockedUntil, svm.lockedUntil);
  row('windowDuration', `${evm.duration}s`, `${svm.duration}s`);
  row('tout (bps)', 'n/a (continuous)', svm.toutBps);
  console.log('');

  const problems: string[] = [];

  if (evm.epoch !== svm.epoch) {
    problems.push(
      `EPOCH MISMATCH: EVM=${evm.epoch} SVM=${svm.epoch}. A tick is in flight or one ` +
        `chain's write/close never landed. Until these agree the two chains may be ` +
        `pricing a raw token differently.`
    );
  }

  if (evm.locked || svm.locked) {
    problems.push(
      `WINDOW OPEN (EVM=${evm.locked}, SVM=${svm.locked}). Mint/redeem are gated on ` +
        `at least one chain. Expected mid-tick; investigate if it persists past ` +
        `the configured duration.`
    );
  }

  if (evm.duration !== svm.duration) {
    problems.push(
      `ASYMMETRIC WINDOW DURATION: EVM=${evm.duration}s SVM=${svm.duration}s. Ticks ` +
        `will gate for different lengths on each chain; align them.`
    );
  }

  if (svm.duration === 0n) {
    problems.push(
      'SVM sync window is DISABLED (sync_window_secs = 0) — cross-chain ticks are ' +
        'not gated on that chain.'
    );
  }
  if (evm.duration === 0n) {
    problems.push(
      'EVM sync window is DISABLED (syncWindowDuration = 0) — cross-chain ticks are ' +
        'not gated on that chain.'
    );
  }

  // Informational only: these are never equal by construction.
  console.log(`  EVM uiMultiplier: ${evm.multiplier.toFixed(9)}`);
  console.log(
    '  (SVM multiplier lives on the Token-2022 mint at 1e9 precision and steps\n' +
      '   discretely, so exact equality is not expected or asserted.)\n'
  );

  if (problems.length === 0) {
    console.log('\x1b[32mPARITY OK\x1b[0m — epochs agree, no window open.\n');
    process.exit(0);
  }

  for (const p of problems) console.log(`\x1b[33m!\x1b[0m ${p}\n`);

  const fatal = evm.epoch !== svm.epoch;
  if (STRICT || fatal) {
    console.error('\x1b[31mPARITY FAILED\x1b[0m\n');
    process.exit(1);
  }
  console.log('\x1b[33mPARITY WARNINGS\x1b[0m (non-fatal without --strict)\n');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
