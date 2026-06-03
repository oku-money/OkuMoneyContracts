#!/usr/bin/env tsx
/**
 * Calculate deployment costs for SVM programs.
 *
 * Reads the actual `target/deploy/*.so` sizes off disk for the program
 * rent. PDA sizes come from the centralised `scripts/lib/account-sizes.ts`
 * TS shim (which mirrors the Rust `state.rs::T::LEN` compile-time
 * asserts). Rent-exempt minimum is fetched live via
 * `connection.getMinimumBalanceForRentExemption(size)` rather than the
 * legacy linear `RENT_PER_BYTE` constant — Solana's rent buffering and
 * fee adjustments make the legacy approximation off by ~2x.
 *
 * Usage:
 *   tsx scripts/utils/calculateDeploymentCost.ts                # mainnet RPC
 *   NETWORK=devnet tsx scripts/utils/calculateDeploymentCost.ts # devnet RPC
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { detectNetwork, getNetworkConfig } from './network';
import {
  BRIDGE_CONFIG_LEN,
  BRIDGE_NONCE_LEN,
  OKU_DOLLAR_CONFIG_LEN,
  PENDING_REFUND_LEN,
  PROCESSED_REQUEST_LEN,
  PSM_CONFIG_LEN,
  REDEMPTION_QUEUE_LEN,
  REFUNDED_REQUEST_LEN,
} from '../lib/account-sizes';

interface SizedItem {
  name: string;
  size: number;
}

async function rentForSize(connection: Connection, size: number): Promise<number> {
  return await connection.getMinimumBalanceForRentExemption(size);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

function formatSOL(lamports: number): string {
  return `${lamportsToSol(lamports).toFixed(4)} SOL`;
}

async function main() {
  const network = detectNetwork();
  const cfg = getNetworkConfig(network);
  const connection = new Connection(cfg.cluster, 'confirmed');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  SVM DEPLOYMENT COST CALCULATOR (${network})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ===== Programs (sizes from on-disk .so files) =====
  const deployDir = path.join(process.cwd(), 'target', 'deploy');
  const programs: SizedItem[] = [];
  if (fs.existsSync(deployDir)) {
    const files = fs.readdirSync(deployDir).filter((f) => f.endsWith('.so'));
    for (const file of files) {
      const stats = fs.statSync(path.join(deployDir, file));
      programs.push({ name: file.replace('.so', ''), size: stats.size });
    }
  } else {
    console.log('  (target/deploy/ not found — run `anchor build` first to size programs)');
  }

  console.log('PROGRAMS:\n');
  let programTotal = 0;
  for (const p of programs) {
    const rent = await rentForSize(connection, p.size);
    programTotal += rent;
    console.log(`  ${p.name.padEnd(24)} ${formatBytes(p.size).padEnd(15)} ${formatSOL(rent)}`);
  }
  console.log(`  ${'SUBTOTAL'.padEnd(40)} ${formatSOL(programTotal)}\n`);

  // ===== PDA accounts =====
  const pdas: SizedItem[] = [
    { name: 'PsmConfig', size: PSM_CONFIG_LEN },
    { name: 'RedemptionQueue', size: REDEMPTION_QUEUE_LEN },
    { name: 'BridgeConfig', size: BRIDGE_CONFIG_LEN },
    { name: 'BridgeNonce (per chain)', size: BRIDGE_NONCE_LEN },
    { name: 'OkuDollarConfig', size: OKU_DOLLAR_CONFIG_LEN },
    { name: 'ProcessedRequest (per request)', size: PROCESSED_REQUEST_LEN },
    { name: 'PendingRefund (per request)', size: PENDING_REFUND_LEN },
    { name: 'RefundedRequest (per request)', size: REFUNDED_REQUEST_LEN },
  ];

  console.log('PDAs (one-time + per-instance):\n');
  let pdaTotal = 0;
  for (const p of pdas) {
    const rent = await rentForSize(connection, p.size);
    pdaTotal += rent;
    console.log(`  ${p.name.padEnd(34)} ${formatBytes(p.size).padEnd(11)} ${formatSOL(rent)}`);
  }
  console.log(`  ${'SUBTOTAL'.padEnd(46)} ${formatSOL(pdaTotal)}\n`);

  // ===== Token mints / ATAs =====
  // Mint sizes: legacy SPL = 82, Token-2022 base = 82 + extension TLV
  // (~165 bytes for InterestBearingConfig). The deploy script picks the
  // exact extensions; we approximate.
  const tokenAccounts: SizedItem[] = [
    { name: 'OkuMoney mint (Token-2022 + IBC ext)', size: 175 },
    { name: 'usdOku mint (Token-2022)', size: 165 },
    { name: 'Mock USDC mint (legacy SPL)', size: 82 },
    { name: 'PSM USDC vault ATA (legacy)', size: 165 },
    { name: 'PSM OkuMoney escrow ATA (T22)', size: 175 },
    { name: 'OkuDollar reserve vault ATA (T22)', size: 175 },
    { name: 'usdOku dead-shares ATA (T22)', size: 175 },
  ];

  console.log('TOKEN ACCOUNTS:\n');
  let tokenTotal = 0;
  for (const t of tokenAccounts) {
    const rent = await rentForSize(connection, t.size);
    tokenTotal += rent;
    console.log(`  ${t.name.padEnd(40)} ${formatBytes(t.size).padEnd(11)} ${formatSOL(rent)}`);
  }
  console.log(`  ${'SUBTOTAL'.padEnd(52)} ${formatSOL(tokenTotal)}\n`);

  // ===== Transaction fees (rough estimate) =====
  // Solana base fee is 5000 lamports per signature; a typical Anchor init
  // tx has 1 signature + a priority-fee tip. We approximate ~10 init txs
  // at ~50000 lamports each.
  const txFees = 10 * 50_000;

  console.log('TRANSACTION FEES (approx ~10 init txs):\n');
  console.log(`  ${'init txs'.padEnd(52)} ${formatSOL(txFees)}\n`);

  const total = programTotal + pdaTotal + tokenTotal + txFees;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`TOTAL DEPLOYMENT COST: ${formatSOL(total)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(
    `Deployer wallet should have at least ${formatSOL(total + 2 * LAMPORTS_PER_SOL)} ` +
      '(deployment + 2 SOL safety buffer).'
  );
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
