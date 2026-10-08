#!/usr/bin/env tsx
/**
 * scripts/test/test-devnet.ts
 *
 * Real on-chain interaction tests (works on localnet, devnet, and devnet-fork).
 * Each step sends actual transactions and verifies results.
 *
 * Usage:
 *   NETWORK=localnet tsx scripts/test/test-devnet.ts              # Localnet (fast iteration)
 *   NETWORK=devnet   tsx scripts/test/test-devnet.ts              # Devnet (real chain)
 *   NETWORK=devnet   tsx scripts/test/test-devnet.ts --step=mint  # Single step
 *
 * Or via npm: `npm run test:onchain` / `npm run test:onchain:fork`
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@anchor-lang/core';
import type { LitePsm } from '../../target/types/lite_psm';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getMint,
  getScaledUiAmountConfig,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

import { detectNetwork, createProvider, isForkNetwork, getParentNetwork } from '../utils/network';
import { NetworkName } from '../config/networks';
import { loadDevnetAuthority } from '../config/authorities';
import { logger } from '../utils/logger';
import {
  PRECISION,
  MAX_RATE,
  computeMultiplier,
  scheduleFromConfig,
  ratePerSecondForApy,
} from "@okumoney/yield-tooling";
import { loadDeployment, loadDeploymentForFork, DeploymentAddresses } from '../utils/addressBook';
import {
  derivePsmConfigPDA,
} from '../utils/pdaHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestContext {
  network: NetworkName;
  provider: AnchorProvider;
  deployer: Keypair;
  /**
   * Devnet operator key: holds the 9 granular authorities (not role_admin; see
   * `scripts/config/authorities.ts::allRolesToOperatorKey`). The deployer
   * stays fee payer; the operator is an extra signer via `.signers([operator])`.
   */
  operator: Keypair;
  deployment: DeploymentAddresses;
  psm: Program<LitePsm>;
  // Mints — single-token model: only OkuM (Token-2022, ScaledUiAmount)
  usdcMint: PublicKey;
  okuMMint: PublicKey;
  // PDAs
  psmConfig: PublicKey;
  psmVaultUsdc: PublicKey;
  // Program IDs
  litePsmId: PublicKey;
}

/**
 * The CANONICAL multiplier (WAD), computed from the `PsmConfig` rate schedule as
 * the program does. NOT read from the mint's ScaledUiAmountConfig, which is a
 * lagging display mirror that pricing never touches.
 */
async function readMultiplier(ctx: TestContext): Promise<bigint> {
  const cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  return computeMultiplier(scheduleFromConfig(cfg), BigInt(Math.floor(Date.now() / 1000)));
}

/** What wallets currently render — the lagging display mirror. */
async function readDisplayMultiplier(ctx: TestContext): Promise<number> {
  const mint = await getMint(
    ctx.provider.connection,
    ctx.okuMMint,
    'confirmed',
    TOKEN_2022_PROGRAM_ID
  );
  const cfg = getScaledUiAmountConfig(mint);
  if (!cfg) throw new Error('OkuM mint has no ScaledUiAmountConfig extension');
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= Number(cfg.newMultiplierEffectiveTimestamp) ? cfg.newMultiplier : cfg.multiplier;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function explorerLink(network: NetworkName, sig: string): string {
  if (network === 'devnet') {
    return `https://solscan.io/tx/${sig}?cluster=devnet`;
  }
  // localnet has no explorer — just return the sig
  return sig;
}

async function confirmTx(ctx: TestContext, sig: string): Promise<string> {
  await ctx.provider.connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/** Mint mock USDC to an arbitrary owner. Deployer is the mint authority. */
async function mintTestUsdcTo(
  ctx: TestContext,
  owner: PublicKey,
  amount: number
): Promise<string> {
  const ata = await getOrCreateAta(ctx, ctx.usdcMint, owner, TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    createMintToInstruction(
      ctx.usdcMint,
      ata,
      ctx.deployer.publicKey, // mint authority
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  const sig = await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.deployer]);
  const label = owner.equals(ctx.deployer.publicKey)
    ? 'deployer'
    : owner.equals(ctx.operator.publicKey)
      ? 'operator'
      : owner.toBase58().slice(0, 8);
  logger.success(`Minted ${amount / 1_000_000} USDC to ${label}`);
  logger.info(`Tx: ${explorerLink(ctx.network, sig)}`);
  return sig;
}

async function mintTestUsdc(ctx: TestContext, amount: number): Promise<string> {
  return mintTestUsdcTo(ctx, ctx.deployer.publicKey, amount);
}

async function getOrCreateAta(
  ctx: TestContext,
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
  const info = await ctx.provider.connection.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        ctx.deployer.publicKey,
        ata,
        owner,
        mint,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.deployer]);
    logger.info(`Created ATA ${ata.toBase58()} for ${owner.toBase58().slice(0, 8)}...`);
  }
  return ata;
}

async function getTokenBalance(
  ctx: TestContext,
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
  try {
    const account = await getAccount(ctx.provider.connection, ata, 'confirmed', programId);
    return account.amount;
  } catch {
    return 0n;
  }
}

function fmtAmount(raw: bigint | number, decimals: number = 6): string {
  const n = typeof raw === 'bigint' ? Number(raw) : raw;
  return (n / 10 ** decimals).toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function buildContext(): Promise<TestContext> {
  const network = detectNetwork();
  if (network === 'mainnet-beta' || network === 'mainnet-fork') {
    throw new Error('This test script is not intended for mainnet. Use localnet, devnet, or devnet-fork.');
  }

  const provider = createProvider(network);
  const deployer = provider.wallet.payer as unknown as Keypair;
  const operator = loadDevnetAuthority();

  if (operator.publicKey.equals(deployer.publicKey)) {
    throw new Error(
      `Devnet operator key equals the deployer wallet. The PSM's granular ` +
        `roles cannot be held by role_admin — regenerate keys/devnet-authority.json.`
    );
  }

  const deployment = loadDeploymentForFork(network);
  const effectiveNetwork = isForkNetwork(network) ? getParentNetwork(network) : network;
  if (!deployment) {
    throw new Error(`No deployment found. Run \`npm run deploy:${effectiveNetwork}\` first.`);
  }

  // Load IDLs
  const psmIdlPath = path.join(process.cwd(), 'target/idl/lite_psm.json');

  if (!fs.existsSync(psmIdlPath)) {
    throw new Error(`IDL file not found. Run \`anchor build\` first. Looking for: ${psmIdlPath}`);
  }

  const psmIdl = JSON.parse(fs.readFileSync(psmIdlPath, 'utf-8'));

  const litePsmId = new PublicKey(deployment.programs.litePsm!);

  // Set the address in the IDL for 2-arg Program constructor (Anchor 1.0 compatibility)
  psmIdl.address = litePsmId.toBase58();

  // IDL is loaded from disk, so the cast asserts it matches LitePsm's shape.
  const psm = new Program(psmIdl, provider) as unknown as Program<LitePsm>;

  // Mints — single token: OkuM (Token-2022, ScaledUiAmount)
  const usdcMint = new PublicKey(deployment.tokens.usdc!);
  const okuMMint = new PublicKey(deployment.tokens.okuM!);

  // PDAs
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const psmVaultUsdc = deployment.pdas.psmVaultUsdc
    ? new PublicKey(deployment.pdas.psmVaultUsdc)
    : getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  return {
    network,
    provider,
    deployer,
    operator,
    deployment,
    psm,
    usdcMint,
    okuMMint,
    psmConfig,
    psmVaultUsdc,
    litePsmId,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Read and display all on-chain state
 */
async function readState(ctx: TestContext) {
  logger.section('Read On-Chain State');

  // PSM Config
  // Note: Anchor 1.0 IDL uses snake_case, client converts to camelCase
  logger.info('Fetching PSM Config...');
  try {
    const config = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
    const multiplier = await readMultiplier(ctx);
    logger.success('PSM Config:');
    logger.table({
      'Role Admin': (config.roleAdmin as PublicKey).toBase58(),
      'Pauser': (config.pauser as PublicKey).toBase58(),
      'Unpauser': (config.unpauser as PublicKey).toBase58(),
      'Freezer': (config.freezer as PublicKey).toBase58(),
      'Unfreezer': (config.unfreezer as PublicKey).toBase58(),
      'Buffer Depositor': (config.bufferDepositor as PublicKey).toBase58(),
      'Buffer Withdrawer': (config.bufferWithdrawer as PublicKey).toBase58(),
      'Cap Manager': (config.capManager as PublicKey).toBase58(),
      'Allowance Manager': (config.allowanceManager as PublicKey).toBase58(),
      'RateManager': (config.rateManager as PublicKey).toBase58(),
      'Direct Minter': ((config as any).directMinter as PublicKey).toBase58(),
      'Direct Burner': ((config as any).directBurner as PublicKey).toBase58(),
      'USDC Mint': (config.usdcMint as PublicKey).toBase58(),
      'OkuM Mint': (config.okuMMint as PublicKey).toBase58(),
      'Vault USDC': (config.vaultUsdc as PublicKey).toBase58(),
      'Max Supply': fmtAmount(Number(config.maxSupply)),
      'Minter Allowance': fmtAmount(Number(config.minterAllowance)),
      'Direct Minter Allowance': fmtAmount(Number((config as any).directMinterAllowance)),
      'Direct Burner Allowance': fmtAmount(Number((config as any).directBurnerAllowance)),
      'Is Paused': String(config.isPaused),
      'Multiplier (wad, canonical)': multiplier.toString(),
    });
  } catch (e: any) {
    logger.error(`Failed to fetch PSM config: ${e.message}`);
  }

  // Token balances
  logger.log('');
  logger.info('Deployer token balances:');
  const usdcBal = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMBal = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const solBal = await ctx.provider.connection.getBalance(ctx.deployer.publicKey);
  logger.table({
    'SOL': (solBal / LAMPORTS_PER_SOL).toFixed(4),
    'USDC': fmtAmount(usdcBal),
    'okuM': fmtAmount(okuMBal),
  });
}

/**
 * Mint USDC -> okuM via PSM
 */
async function testMint(ctx: TestContext) {
  logger.section('Test: Mint OkuM');

  const amount = 100_000_000; // 100 USDC

  // 1. Mint test USDC to deployer
  logger.info(`Minting ${amount / 1_000_000} USDC to deployer...`);
  await mintTestUsdc(ctx, amount);

  // 2. Get balances before
  const usdcBefore = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMBefore = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - USDC: ${fmtAmount(usdcBefore)}, okuM: ${fmtAmount(okuMBefore)}`);

  // 3. Ensure ATAs exist (pre-create OkuM ATA to avoid init_if_needed CPI corruption)
  const userUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.deployer.publicKey, false, TOKEN_PROGRAM_ID);
  const userOkuMAta = await getOrCreateAta(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);

  // 4. Call PSM mintOkuM (mint_oku_m in the IDL)
  logger.info(`Calling psm.mintOkuM(${amount / 1_000_000} USDC)...`);
  const sig = await ctx.psm.methods
    .mintOkuM(new BN(amount))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      usdcMint: ctx.usdcMint,
      okuMMint: ctx.okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdc: ctx.psmVaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Mint tx: ${explorerLink(ctx.network, sig)}`);

  // 5. Verify
  const usdcAfter = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMAfter = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - USDC: ${fmtAmount(usdcAfter)}, okuM: ${fmtAmount(okuMAfter)}`);
  const minted = okuMAfter - okuMBefore;
  logger.success(`Minted ${fmtAmount(minted)} okuM`);

  // Assert amounts, not just that `.rpc()` did not throw. Both tokens are
  // 6-decimal on SVM, so only the multiplier scales.
  const usdcSpent = usdcBefore - usdcAfter;
  if (usdcSpent !== BigInt(amount)) {
    throw new Error(`mint spent ${usdcSpent} USDC-units, expected exactly ${amount}`);
  }
  const multForMint = await readMultiplier(ctx);
  const expectedOkuM = (BigInt(amount) * PRECISION) / multForMint;
  const mintDrift = minted > expectedOkuM ? minted - expectedOkuM : expectedOkuM - minted;
  const mintTolerance = expectedOkuM / 1_000_000n + 1n; // 1 ppm + integer-division rounding
  if (mintDrift > mintTolerance) {
    throw new Error(
      `mint produced ${minted} okuM but ${amount} USDC-units at multiplier ${multForMint} ` +
        `implies ${expectedOkuM} (drift=${mintDrift}, tolerance=${mintTolerance}). PSM mint pricing is wrong.`
    );
  }
  logger.success(`Mint amount matches multiplier-implied value (drift ${mintDrift} units)`);
}

/**
 * Transfer okuM to a new recipient
 */
async function testTransfer(ctx: TestContext) {
  logger.section('Test: Transfer OkuM');

  const transferAmount = 10_000_000; // 10 okuM

  // 1. Generate recipient
  const recipient = Keypair.generate();
  logger.info(`Recipient: ${recipient.publicKey.toBase58()}`);

  // 2. Airdrop SOL to recipient (for ATA creation rent)
  logger.info('Airdropping SOL to recipient...');
  try {
    const airdropSig = await ctx.provider.connection.requestAirdrop(
      recipient.publicKey,
      0.05 * LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(airdropSig, 'confirmed');
    logger.success('Airdropped 0.05 SOL');
  } catch {
    logger.warning('Airdrop failed - funding from deployer');
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ctx.deployer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.deployer]);
  }

  // 3. Create recipient okuM ATA (deployer pays)
  const recipientAta = await getOrCreateAta(ctx, ctx.okuMMint, recipient.publicKey, TOKEN_2022_PROGRAM_ID);

  // 4. Transfer via Token-2022
  const senderAta = getAssociatedTokenAddressSync(
    ctx.okuMMint,
    ctx.deployer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const senderBalBefore = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);

  logger.info(`Transferring ${transferAmount / 1_000_000} okuM...`);
  const tx = new Transaction().add(
    createTransferInstruction(
      senderAta,
      recipientAta,
      ctx.deployer.publicKey,
      transferAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
  const sig = await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.deployer]);
  await confirmTx(ctx, sig);
  logger.success(`Transfer tx: ${explorerLink(ctx.network, sig)}`);

  // 5. Verify
  const senderBal = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const recipientBal = await getTokenBalance(ctx, ctx.okuMMint, recipient.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Sender okuM: ${fmtAmount(senderBal)}`);
  logger.info(`Recipient okuM: ${fmtAmount(recipientBal)}`);

  // EXACT equality: ScaledUiAmount only affects the display, never raw transfer amounts.
  if (recipientBal !== BigInt(transferAmount)) {
    throw new Error(
      `recipient received ${recipientBal} raw units, expected exactly ${transferAmount}`
    );
  }
  const senderDelta = senderBalBefore - senderBal;
  if (senderDelta !== BigInt(transferAmount)) {
    throw new Error(
      `sender debited ${senderDelta} raw units, expected exactly ${transferAmount} ` +
        `(before=${senderBalBefore}, after=${senderBal})`
    );
  }
  logger.success('Transfer moved the exact raw amount on both sides (verified, not just printed)');
}

/**
 * Redeem okuM -> USDC (deposit buffer first, then redeem)
 */
async function testRedeem(ctx: TestContext) {
  logger.section('Test: Redeem okuM -> USDC');

  const redeemAmount = 10_000_000; // 10 okuM
  const bufferAmount = 20_000_000; // 20 USDC buffer (covers the redemption)

  // 1. Deposit USDC buffer (redeem reverts InsufficientBuffer otherwise).
  //    buffer_depositor is the operator key: its ATA funds the deposit and it co-signs.
  logger.info(`Depositing ${bufferAmount / 1_000_000} USDC buffer...`);

  const bufferDepositorUsdcAta = await getOrCreateAta(
    ctx,
    ctx.usdcMint,
    ctx.operator.publicKey,
    TOKEN_PROGRAM_ID
  );

  // Mint the buffer USDC directly to the operator (deployer is mint authority).
  await mintTestUsdcTo(ctx, ctx.operator.publicKey, bufferAmount);

  const depositSig = await ctx.psm.methods
    .depositBuffer(new BN(bufferAmount))
    .accountsPartial({
      bufferDepositor: ctx.operator.publicKey,
      config: ctx.psmConfig,
      bufferDepositorUsdcAta,
      vaultUsdc: ctx.psmVaultUsdc,
      usdcMint: ctx.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([ctx.operator])
    .rpc();
  await confirmTx(ctx, depositSig);
  logger.success(`Buffer deposit tx: ${explorerLink(ctx.network, depositSig)}`);

  // 2. Get balances before
  const usdcBefore = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMBefore = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - USDC: ${fmtAmount(usdcBefore)}, okuM: ${fmtAmount(okuMBefore)}`);

  if (okuMBefore < BigInt(redeemAmount)) {
    logger.error(`Insufficient okuM balance (${fmtAmount(okuMBefore)} < ${fmtAmount(redeemAmount)}). Run mint first.`);
    return;
  }

  // 3. Ensure ATAs
  const userUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.deployer.publicKey, true, TOKEN_PROGRAM_ID);
  const userOkuMAta = getAssociatedTokenAddressSync(ctx.okuMMint, ctx.deployer.publicKey, true, TOKEN_2022_PROGRAM_ID);

  // 4. Call PSM redeemOkuM. The second arg is min_usdc_out, deliberately NOT 0:
  // flooring it at the TS-mirror price makes the redeem a live Rust-vs-TS
  // multiplier differential (it reverts on-chain on divergence). Every other
  // multiplier check here is client-side and cannot catch a broken Rust accrual.
  const multForRedeem = await readMultiplier(ctx);
  const expectedUsdcOut = (BigInt(redeemAmount) * multForRedeem) / PRECISION;
  // Floor at 99.9% of expected: absorbs the few seconds of accrual between
  // this read and the tx landing, plus integer flooring, while still failing
  // loudly on any real pricing divergence.
  const minUsdcOut = (expectedUsdcOut * 999n) / 1000n;
  logger.info(
    `Calling psm.redeemOkuM(${redeemAmount / 1_000_000} okuM), ` +
      `expecting ~${fmtAmount(expectedUsdcOut)} USDC, min_usdc_out=${fmtAmount(minUsdcOut)} ` +
      `(live Rust-vs-TS multiplier differential)...`
  );

  const sig = await ctx.psm.methods
    .redeemOkuM(new BN(redeemAmount), new BN(minUsdcOut.toString()))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      usdcMint: ctx.usdcMint,
      okuMMint: ctx.okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdc: ctx.psmVaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Redeem tx: ${explorerLink(ctx.network, sig)}`);

  // 5. Verify
  const usdcAfter = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMAfter = await getTokenBalance(ctx, ctx.okuMMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - USDC: ${fmtAmount(usdcAfter)}, okuM: ${fmtAmount(okuMAfter)}`);
  logger.success(`Redeemed ${fmtAmount(okuMBefore - okuMAfter)} okuM -> ${fmtAmount(usdcAfter - usdcBefore)} USDC`);

  // Assert the deltas, not just that `.rpc()` did not throw.
  const okuMSpent = okuMBefore - okuMAfter;
  const usdcReceived = usdcAfter - usdcBefore;
  if (okuMSpent !== BigInt(redeemAmount)) {
    throw new Error(
      `redeem burned ${okuMSpent} okuM, expected exactly ${redeemAmount}`
    );
  }
  if (usdcReceived < minUsdcOut) {
    throw new Error(
      `redeem paid ${usdcReceived} USDC-units, below the ${minUsdcOut} floor ` +
        `implied by the multiplier — on-chain Rust pricing disagrees with the TS reference.`
    );
  }
  const redeemDrift =
    usdcReceived > expectedUsdcOut ? usdcReceived - expectedUsdcOut : expectedUsdcOut - usdcReceived;
  logger.success(
    `Redeem priced correctly: ${fmtAmount(usdcReceived)} USDC vs expected ` +
      `${fmtAmount(expectedUsdcOut)} (drift ${redeemDrift} units)`
  );
}

// ---------------------------------------------------------------------------
// Step: streamingAccrual
// ---------------------------------------------------------------------------

/**
 * Exercise the streaming rate schedule against a live cluster: publish a rate,
 * wait with no transactions, and check the multiplier advances.
 *
 * `readMultiplier()` is a CLIENT-SIDE projection (TS mirror vs `Date.now()`), so
 * "before < after" does not prove the validator accrued anything. The real
 * teeth are the exact read-back of the schedule fields and `testRedeem`'s
 * multiplier-derived `min_usdc_out` (the Rust-vs-TS differential). Also asserts
 * `display <= canonical`, which is one-sided: it catches an over-reporting
 * mirror, never under-accrual.
 */
async function testStreamingAccrual(ctx: TestContext) {
  logger.section('Test: Streaming Accrual');

  // Publish a fast rate so measurable yield accrues in seconds. Must stay below
  // MAX_RATE: `ratePerSecondForApy` silently clamps, so assert no clamping occurred.
  const requestedApy = 5.0; // 500% APY — fast enough to move in seconds, inside MAX_RATE
  const rate = ratePerSecondForApy(requestedApy);
  if (rate >= MAX_RATE) {
    throw new Error(
      `rate ${rate} for ${requestedApy * 100}% APY hit MAX_RATE (${MAX_RATE}) and was clamped — ` +
        `pick a smaller APY so the test publishes the rate it thinks it publishes.`
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // Short window: the multiplier is monotonic, so elevated accrual is unrecoverable.
  const endTs = nowSec + 300;

  const before = await readMultiplier(ctx);
  logger.info(`canonical multiplier before: ${before}`);

  const sig = await ctx.psm.methods
    .setOkumYieldRate(new BN(rate.toString()), new BN(endTs))
    .accountsPartial({ rateManager: ctx.operator.publicKey, config: ctx.psmConfig })
    .signers([ctx.operator])
    .rpc();
  logger.success(`set_okum_yield_rate: ${sig}`);

  // Confirm the schedule landed byte-for-byte.
  const cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  const schedule = scheduleFromConfig(cfg);
  if (schedule.ratePerSecond !== rate) {
    throw new Error(`rate mismatch: wrote ${rate}, read ${schedule.ratePerSecond}`);
  }
  if (schedule.rateEnd !== BigInt(endTs)) {
    throw new Error(`rateEnd mismatch: wrote ${endTs}, read ${schedule.rateEnd}`);
  }

  // try/finally: the elevated rate must ALWAYS be halted, since the runner
  // continues past failed steps and the multiplier cannot be corrected downward.
  try {
    // Wait on the cluster's real clock. NO transaction is sent in this window --
    // that is the property under test.
    const WAIT_SECONDS = 15;
    logger.info(`waiting ${WAIT_SECONDS}s with NO transactions to observe accrual...`);
    await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));

    const after = await readMultiplier(ctx);
    logger.info(`canonical multiplier after:  ${after}`);

    // Sanity check on the TS mirror; the Rust-vs-TS check is `min_usdc_out` in testRedeem.
    if (after <= before) {
      throw new Error(
        `multiplier did not stream: ${before} -> ${after}. Accrual should advance ` +
          'from elapsed time alone, with no transaction.'
      );
    }
    logger.success(`multiplier advanced by ${after - before} with zero transactions`);

    // Display mirror: crank it, then assert it never reads above canonical.
    const syncSig = await ctx.psm.methods
      .syncDisplayMultiplier()
      .accountsPartial({
        cranker: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        okuMMint: ctx.okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    logger.success(`sync_display_multiplier: ${syncSig}`);

    const display = await readDisplayMultiplier(ctx);
    const canonical = await readMultiplier(ctx);
    const displayWad = BigInt(Math.floor(display * 1e18));
    logger.info(`display ${display} vs canonical ${canonical}`);
    if (displayWad > canonical) {
      throw new Error(
        `INVARIANT VIOLATION: display ${displayWad} exceeds canonical ${canonical}. ` +
          'Wallets would promise more than the PSM will pay.'
      );
    }
    // Log lag: a stuck mirror (dead crank) passes the one-sided check above.
    const mirrorLag = canonical - displayWad;
    const mirrorLagBps = (mirrorLag * 10_000n) / PRECISION;
    logger.info(`display lag behind canonical: ${mirrorLag} wad (${mirrorLagBps} bps)`);
    logger.success('display <= canonical holds');
  } finally {
    // Leave the deployment halted rather than streaming at an elevated rate.
    try {
      const haltSig = await ctx.psm.methods
        .setOkumYieldRate(new BN(PRECISION.toString()), new BN(0))
        .accountsPartial({ rateManager: ctx.operator.publicKey, config: ctx.psmConfig })
        .signers([ctx.operator])
        .rpc();
      logger.success(`halted accrual after test: ${haltSig}`);
    } catch (e: any) {
      logger.error(
        `CRITICAL: failed to halt the elevated test rate (${e?.message ?? e}). ` +
          `Devnet is still accruing until ${new Date(endTs * 1000).toISOString()}. ` +
          `Run: npm run admin:set-yield-rate -- --rate=${PRECISION} --end=0`
      );
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Step: pause / unpause
// ---------------------------------------------------------------------------

/**
 * Pause the PSM, assert that a mint reverts with a paused error, then unpause
 * and verify a subsequent mint succeeds.  The pauser and unpauser are both the
 * OPERATOR key in testnet/localnet deployments (they cannot be the deployer,
 * which holds role_admin).
 */
async function testPause(ctx: TestContext) {
  logger.section('Test: Pause / Unpause PSM');

  // 1. Pause the PSM.
  logger.info('Pausing PSM...');
  const pauseSig = await ctx.psm.methods
    .pause()
    .accountsPartial({ pauser: ctx.operator.publicKey, config: ctx.psmConfig })
    .signers([ctx.operator])
    .rpc();
  await confirmTx(ctx, pauseSig);
  logger.success(`pause tx: ${explorerLink(ctx.network, pauseSig)}`);

  const cfgPaused = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (!cfgPaused.isPaused) {
    throw new Error('Expected PSM to be paused but isPaused=false.');
  }

  // 2. Attempt a mint — must fail with Paused error.
  logger.info('Attempting mint_oku_m while paused — expect revert...');
  const mintAmount = new BN(1_000_000); // 1 USDC
  const userUsdcAta = getAssociatedTokenAddressSync(
    ctx.usdcMint, ctx.deployer.publicKey, false, TOKEN_PROGRAM_ID
  );
  const userOkuMAta = getAssociatedTokenAddressSync(
    ctx.okuMMint, ctx.deployer.publicKey, true, TOKEN_2022_PROGRAM_ID
  );

  let mintReverted = false;
  try {
    await ctx.psm.methods
      .mintOkuM(mintAmount)
      .accountsPartial({
        user: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        usdcMint: ctx.usdcMint,
        okuMMint: ctx.okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: ctx.psmVaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } catch (e: any) {
    const errStr = String(e?.message ?? '');
    if (errStr.includes('Paused') || errStr.includes('paused') || e?.error?.errorCode?.code === 'Paused') {
      mintReverted = true;
    } else {
      // Re-throw unexpected errors.
      throw new Error(`Mint while paused threw unexpected error: ${errStr}`);
    }
  }
  if (!mintReverted) {
    throw new Error('mint_oku_m should have failed while PSM is paused, but it succeeded.');
  }
  logger.success('mint_oku_m correctly reverted with Paused error.');

  // 3. Unpause.
  logger.info('Unpausing PSM...');
  const unpauseSig = await ctx.psm.methods
    .unpause()
    .accountsPartial({ unpauser: ctx.operator.publicKey, config: ctx.psmConfig })
    .signers([ctx.operator])
    .rpc();
  await confirmTx(ctx, unpauseSig);
  logger.success(`unpause tx: ${explorerLink(ctx.network, unpauseSig)}`);

  const cfgUnpaused = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (cfgUnpaused.isPaused) {
    throw new Error('Expected PSM to be unpaused but isPaused=true.');
  }
  logger.success('PSM pause / unpause round-trip verified.');
}

// ---------------------------------------------------------------------------
// Step: setAuthority
// ---------------------------------------------------------------------------

/**
 * Rotate the pauser to a fresh keypair via `set_authority` (role_admin =
 * deployer), verify the old holder (operator) can no longer pause and the new
 * one can, then restore the role to the operator so the PSM ends unchanged.
 */
async function testSetAuthority(ctx: TestContext) {
  logger.section('Test: Set Authority (role rotation)');

  // 1. Generate a temporary replacement key.
  const tempPauser = Keypair.generate();
  logger.info(`Temporary pauser: ${tempPauser.publicKey.toBase58()}`);

  // Fund the temp key with a little SOL so it can pay transaction fees.
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: ctx.deployer.publicKey,
      toPubkey: tempPauser.publicKey,
      lamports: 0.01 * LAMPORTS_PER_SOL,
    })
  );
  await sendAndConfirmTransaction(ctx.provider.connection, fundTx, [ctx.deployer]);

  // 2. Rotate pauser role to temp key via set_authority (role_admin = deployer).
  logger.info('Rotating pauser role to temp key...');
  const setAuthSig = await ctx.psm.methods
    .setAuthority({ pauser: {} }, tempPauser.publicKey)
    .accountsPartial({
      roleAdmin: ctx.deployer.publicKey,
      config: ctx.psmConfig,
    })
    .rpc();
  await confirmTx(ctx, setAuthSig);
  logger.success(`set_authority tx: ${explorerLink(ctx.network, setAuthSig)}`);

  // 3. Verify the operator's pause now fails (it is no longer pauser).
  logger.info('Verifying old pauser (operator) cannot pause...');
  let operatorPauseFailed = false;
  try {
    await ctx.psm.methods
      .pause()
      .accountsPartial({ pauser: ctx.operator.publicKey, config: ctx.psmConfig })
      .signers([ctx.operator])
      .rpc();
  } catch (e: any) {
    operatorPauseFailed = true;
    logger.info(`Expected: operator pause rejected (${String(e?.message ?? '').slice(0, 60)}...)`);
  }
  if (!operatorPauseFailed) {
    throw new Error('Operator was still able to pause after role was transferred — set_authority failed.');
  }

  // 4. Verify new holder (tempPauser) CAN pause.
  logger.info('Verifying new pauser (tempPauser) can pause...');
  // Build and sign the transaction manually so tempPauser signs.
  const pauseIx = await ctx.psm.methods
    .pause()
    .accountsPartial({ pauser: tempPauser.publicKey, config: ctx.psmConfig })
    .instruction();
  const pauseTx = new Transaction().add(pauseIx);
  pauseTx.feePayer = ctx.deployer.publicKey;
  const { blockhash } = await ctx.provider.connection.getLatestBlockhash();
  pauseTx.recentBlockhash = blockhash;
  await sendAndConfirmTransaction(ctx.provider.connection, pauseTx, [ctx.deployer, tempPauser]);
  logger.success('New pauser successfully paused PSM.');

  // 5. Unpause (the operator is still unpauser).
  await ctx.psm.methods
    .unpause()
    .accountsPartial({ unpauser: ctx.operator.publicKey, config: ctx.psmConfig })
    .signers([ctx.operator])
    .rpc();

  // 6. Restore the pauser role to the operator key.
  logger.info(`Restoring pauser to operator: ${ctx.operator.publicKey.toBase58()}`);
  const restoreSig = await ctx.psm.methods
    .setAuthority({ pauser: {} }, ctx.operator.publicKey)
    .accountsPartial({
      roleAdmin: ctx.deployer.publicKey,
      config: ctx.psmConfig,
    })
    .rpc();
  await confirmTx(ctx, restoreSig);

  const cfgFinal = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (!(cfgFinal.pauser as PublicKey).equals(ctx.operator.publicKey)) {
    throw new Error('Pauser was not restored to the operator key.');
  }
  if (cfgFinal.isPaused) {
    throw new Error('PSM left paused at end of setAuthority step.');
  }

  logger.success(
    'Role rotation verified (pauser rotated out, guard enforced, restored to operator).'
  );
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

const STEPS: Record<string, (ctx: TestContext) => Promise<void>> = {
  state: readState,
  mint: testMint,
  transfer: testTransfer,
  redeem: testRedeem,
  streamingAccrual: testStreamingAccrual,
  pause: testPause,
  setAuthority: testSetAuthority,
};

async function main() {
  const network = detectNetwork();
  logger.header(`On-Chain Interaction Tests (${network})`);

  // Parse --step argument
  const stepArg = process.argv.find((a) => a.startsWith('--step='));
  const stepName = stepArg ? stepArg.split('=')[1] : null;

  if (stepName && !STEPS[stepName]) {
    logger.error(`Unknown step: ${stepName}`, false);
    logger.info(`Available steps: ${Object.keys(STEPS).join(', ')}`, false);
    process.exit(1);
  }

  // Build context
  logger.info('Loading deployment and building context...', false);
  const ctx = await buildContext();

  logger.success(`Deployer: ${ctx.deployer.publicKey.toBase58()}`, false);
  logger.success(`PSM Program: ${ctx.litePsmId.toBase58()}`, false);
  logger.log('');

  if (stepName) {
    // Run single step
    logger.info(`Running step: ${stepName}`, false);
    try {
      await STEPS[stepName](ctx);
      logger.log('');
      logger.success(`Step "${stepName}" completed!`, false);
    } catch (e: any) {
      logger.log('');
      logger.error(`Step "${stepName}" failed: ${e.message}`, false);
      if (e.logs) {
        logger.log('Program logs:');
        for (const log of e.logs) {
          logger.log(`  ${log}`);
        }
      }
      process.exit(1);
    }
  } else {
    // Run all steps in order. The compliance/yield steps run after the
    // mint/transfer/redeem flow so balances are already populated.
    const stepOrder = [
      'state',
      'mint',
      'transfer',
      'redeem',
      'streamingAccrual',
      'pause',
      'setAuthority',
    ];
    let passed = 0;
    let failed = 0;

    for (const name of stepOrder) {
      try {
        await STEPS[name](ctx);
        passed++;
      } catch (e: any) {
        logger.log('');
        logger.error(`Step "${name}" failed: ${e.message}`, false);
        if (e.logs) {
          logger.log('Program logs:');
          for (const log of e.logs) {
            logger.log(`  ${log}`);
          }
        }
        failed++;
      }
    }

    logger.log('');
    logger.section('Summary');
    logger.table({
      'Passed': String(passed),
      'Failed': String(failed),
      'Total': String(passed + failed),
    });

    if (failed > 0) {
      process.exit(1);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
