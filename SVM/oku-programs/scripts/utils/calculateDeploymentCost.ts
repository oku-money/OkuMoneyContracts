#!/usr/bin/env tsx
/**
 * Calculate deployment costs for SVM programs
 */

import * as fs from 'fs';
import * as path from 'path';

const RENT_PER_BYTE = 0.00000696; // SOL per byte (Solana rent-exempt rate)

interface ProgramCost {
  name: string;
  size: number;
  cost: number;
}

interface DeploymentCost {
  programs: ProgramCost[];
  pdas: { name: string; size: number; cost: number }[];
  tokens: { name: string; cost: number }[];
  transactions: { name: string; cost: number }[];
  total: number;
}

function calculateCosts(): DeploymentCost {
  const deployDir = path.join(process.cwd(), 'target', 'deploy');

  const programs: ProgramCost[] = [];

  // Calculate program costs
  if (fs.existsSync(deployDir)) {
    const files = fs.readdirSync(deployDir).filter((f) => f.endsWith('.so'));

    for (const file of files) {
      const filePath = path.join(deployDir, file);
      const stats = fs.statSync(filePath);
      const size = stats.size;
      const cost = size * RENT_PER_BYTE;

      programs.push({
        name: file.replace('.so', ''),
        size,
        cost,
      });
    }
  }

  // PDA costs
  const pdas = [
    { name: 'PSM Config', size: 349, cost: 349 * RENT_PER_BYTE },
    { name: 'Redemption Queue', size: 24 * 1024, cost: 24 * 1024 * RENT_PER_BYTE },
    { name: 'Bridge Config', size: 349, cost: 349 * RENT_PER_BYTE },
    { name: 'Bridge Nonces (4 chains)', size: 4 * 19, cost: 4 * 19 * RENT_PER_BYTE },
    { name: 'Vault Config', size: 200, cost: 200 * RENT_PER_BYTE },
    { name: 'Router Config', size: 150, cost: 150 * RENT_PER_BYTE },
  ];

  // Token account costs
  const tokens = [
    { name: 'OkuMoney Mint (Token-2022)', cost: 0.0023 },
    { name: 'usdOku Mint (SPL Token)', cost: 0.0014 },
    { name: 'PSM USDC Vault ATA', cost: 0.002 },
    { name: 'PSM OkuMoney Escrow ATA', cost: 0.002 },
    { name: 'Vault OkuMoney ATA', cost: 0.002 },
  ];

  // Transaction costs
  const transactions = [
    { name: 'Program deployments (3)', cost: 0.0015 },
    { name: 'Initialize instructions (~10)', cost: 0.005 },
  ];

  const programTotal = programs.reduce((sum, p) => sum + p.cost, 0);
  const pdaTotal = pdas.reduce((sum, p) => sum + p.cost, 0);
  const tokenTotal = tokens.reduce((sum, t) => sum + t.cost, 0);
  const txTotal = transactions.reduce((sum, t) => sum + t.cost, 0);

  return {
    programs,
    pdas,
    tokens,
    transactions,
    total: programTotal + pdaTotal + tokenTotal + txTotal,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSOL(sol: number): string {
  return `${sol.toFixed(4)} SOL`;
}

function formatUSD(sol: number, solPrice: number): string {
  return `$${(sol * solPrice).toFixed(2)}`;
}

function main() {
  const costs = calculateCosts();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SVM DEPLOYMENT COST CALCULATOR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Programs
  console.log('📦 PROGRAMS:\n');
  let programTotal = 0;
  for (const program of costs.programs) {
    console.log(
      `  ${program.name.padEnd(20)} ${formatBytes(program.size).padEnd(15)} ${formatSOL(program.cost)}`
    );
    programTotal += program.cost;
  }
  console.log(`  ${''.padEnd(20)} ${''.padEnd(15)} ─────────────`);
  console.log(`  ${'SUBTOTAL'.padEnd(36)} ${formatSOL(programTotal)}\n`);

  // PDAs
  console.log('🗂️  PDAS:\n');
  let pdaTotal = 0;
  for (const pda of costs.pdas) {
    console.log(
      `  ${pda.name.padEnd(30)} ${formatBytes(pda.size).padEnd(10)} ${formatSOL(pda.cost)}`
    );
    pdaTotal += pda.cost;
  }
  console.log(`  ${''.padEnd(30)} ${''.padEnd(10)} ─────────────`);
  console.log(`  ${'SUBTOTAL'.padEnd(41)} ${formatSOL(pdaTotal)}\n`);

  // Tokens
  console.log('🪙  TOKEN ACCOUNTS:\n');
  let tokenTotal = 0;
  for (const token of costs.tokens) {
    console.log(`  ${token.name.padEnd(35)} ${formatSOL(token.cost)}`);
    tokenTotal += token.cost;
  }
  console.log(`  ${''.padEnd(35)} ─────────────`);
  console.log(`  ${'SUBTOTAL'.padEnd(35)} ${formatSOL(tokenTotal)}\n`);

  // Transactions
  console.log('💸 TRANSACTION FEES:\n');
  let txTotal = 0;
  for (const tx of costs.transactions) {
    console.log(`  ${tx.name.padEnd(35)} ${formatSOL(tx.cost)}`);
    txTotal += tx.cost;
  }
  console.log(`  ${''.padEnd(35)} ─────────────`);
  console.log(`  ${'SUBTOTAL'.padEnd(35)} ${formatSOL(txTotal)}\n`);

  // Total
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 TOTAL DEPLOYMENT COST:\n');
  console.log(`  ${formatSOL(costs.total)}\n`);

  // USD equivalents
  const solPrices = [100, 150, 200];
  console.log('💵 USD EQUIVALENTS:\n');
  for (const price of solPrices) {
    console.log(`  At $${price}/SOL: ${formatUSD(costs.total, price)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 RECOMMENDATIONS:\n');
  console.log(`  Deployer wallet should have: ~${formatSOL(costs.total + 2)}`);
  console.log(`  (${formatSOL(costs.total)} deployment + ${formatSOL(2)} buffer)\n`);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main();
