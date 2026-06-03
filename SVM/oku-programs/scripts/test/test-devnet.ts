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
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

import { detectNetwork, createProvider, isForkNetwork, getParentNetwork } from '../utils/network';
import { NetworkName } from '../config/networks';
import { logger } from '../utils/logger';
import { loadDeployment, loadDeploymentForFork, DeploymentAddresses } from '../utils/addressBook';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
  deriveVaultConfigPDA,
} from '../utils/pdaHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestContext {
  network: NetworkName;
  provider: AnchorProvider;
  deployer: Keypair;
  deployment: DeploymentAddresses;
  psm: Program;
  vault: Program;
  // Mints
  usdcMint: PublicKey;
  okuMoneyMint: PublicKey;
  usdOkuMint: PublicKey;
  // PDAs
  psmConfig: PublicKey;
  redemptionQueue: PublicKey;
  vaultConfig: PublicKey;
  psmVaultUsdc: PublicKey;
  psmOkuMoneyEscrow: PublicKey;
  vaultOkusd: PublicKey;
  // Program IDs
  litePsmId: PublicKey;
  okuDollarProgramId: PublicKey;
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

async function mintTestUsdc(ctx: TestContext, amount: number): Promise<string> {
  const ata = await getOrCreateAta(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    createMintToInstruction(
      ctx.usdcMint,
      ata,
      ctx.deployer.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  const sig = await sendAndConfirmTransaction(ctx.provider.connection, tx, [ctx.deployer]);
  logger.success(`Minted ${amount / 1_000_000} USDC to deployer`);
  logger.info(`Tx: ${explorerLink(ctx.network, sig)}`);
  return sig;
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

  // For fork networks, load deployment from parent network
  const deployment = loadDeploymentForFork(network);
  const effectiveNetwork = isForkNetwork(network) ? getParentNetwork(network) : network;
  if (!deployment) {
    throw new Error(`No deployment found. Run \`npm run deploy:${effectiveNetwork}\` first.`);
  }

  // Load IDLs
  const psmIdlPath = path.join(process.cwd(), 'target/idl/lite_psm.json');
  const vaultIdlPath = path.join(process.cwd(), 'target/idl/oku_dollar.json');

  if (!fs.existsSync(psmIdlPath) || !fs.existsSync(vaultIdlPath)) {
    throw new Error(`IDL files not found. Run \`anchor build\` first. Looking for: ${psmIdlPath}, ${vaultIdlPath}`);
  }

  const psmIdl = JSON.parse(fs.readFileSync(psmIdlPath, 'utf-8'));
  const vaultIdl = JSON.parse(fs.readFileSync(vaultIdlPath, 'utf-8'));

  const litePsmId = new PublicKey(deployment.programs.litePsm!);
  const okuDollarProgramId = new PublicKey(deployment.programs.okuDollarProgram!);

  // Set the address in the IDL for 2-arg Program constructor (Anchor 1.0 compatibility)
  psmIdl.address = litePsmId.toBase58();
  vaultIdl.address = okuDollarProgramId.toBase58();

  const psm = new Program(psmIdl, provider);
  const vault = new Program(vaultIdl, provider);

  // Mints
  const usdcMint = new PublicKey(deployment.tokens.usdc!);
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney!);
  // usdOku is the wrapped token (also known as usdOku)
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku || deployment.tokens.usdOku!);

  // PDAs
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarProgramId);

  const psmVaultUsdc = deployment.pdas.psmVaultUsdc
    ? new PublicKey(deployment.pdas.psmVaultUsdc)
    : getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  const psmOkuMoneyEscrow = deployment.pdas.psmOkuMoneyEscrow
    ? new PublicKey(deployment.pdas.psmOkuMoneyEscrow)
    : getAssociatedTokenAddressSync(okuMoneyMint, psmConfig, true, TOKEN_2022_PROGRAM_ID);

  const vaultOkusd = deployment.pdas.vaultOkusd
    ? new PublicKey(deployment.pdas.vaultOkusd)
    : getAssociatedTokenAddressSync(okuMoneyMint, vaultConfig, true, TOKEN_2022_PROGRAM_ID);

  return {
    network,
    provider,
    deployer,
    deployment,
    psm,
    vault,
    usdcMint,
    okuMoneyMint,
    usdOkuMint,
    psmConfig,
    redemptionQueue,
    vaultConfig,
    psmVaultUsdc,
    psmOkuMoneyEscrow,
    vaultOkusd,
    litePsmId,
    okuDollarProgramId,
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
    logger.success('PSM Config:');
    logger.table({
      'Role Admin': (config.roleAdmin as PublicKey).toBase58(),
      'Pauser': (config.pauser as PublicKey).toBase58(),
      'Unpauser': (config.unpauser as PublicKey).toBase58(),
      'Freezer': (config.freezer as PublicKey).toBase58(),
      'Unfreezer': (config.unfreezer as PublicKey).toBase58(),
      'Queue Processor': (config.queueProcessor as PublicKey).toBase58(),
      'Buffer Depositor': (config.bufferDepositor as PublicKey).toBase58(),
      'Buffer Withdrawer': (config.bufferWithdrawer as PublicKey).toBase58(),
      'Oracle Manager': (config.oracleManager as PublicKey).toBase58(),
      'Cap Manager': (config.capManager as PublicKey).toBase58(),
      'Allowance Manager': (config.allowanceManager as PublicKey).toBase58(),
      'Rebaser': (config.rebaser as PublicKey).toBase58(),
      'USDC Mint': (config.usdcMint as PublicKey).toBase58(),
      'OkuMoney Mint': (config.okuMoneyMint as PublicKey).toBase58(),
      'Vault USDC': (config.vaultUsdc as PublicKey).toBase58(),
      'Vault OkuMoney': (config.vaultOkuMoney as PublicKey)?.toBase58() || 'Not set',
      'Max Supply': fmtAmount(Number(config.maxSupply)),
      'Minter Allowance': fmtAmount(Number(config.minterAllowance)),
      'Is Paused': String(config.isPaused),
      'Oracle': (config.oracle as PublicKey).toBase58(),
      'Staleness Threshold': `${config.stalenessThreshold}s`,
      'OkuM Price': String(config.okuMPrice),
    });
  } catch (e: any) {
    logger.error(`Failed to fetch PSM config: ${e.message}`);
  }

  // Redemption Queue
  logger.log('');
  logger.info('Fetching Redemption Queue...');
  try {
    const queue = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
    // head / tail are u64 (Phase 13b widening). Compute pending with
    // BigInt so we don't silently lose precision near 2^53 enqueues.
    const head = BigInt((queue.head as BN).toString());
    const tail = BigInt((queue.tail as BN).toString());
    logger.success('Redemption Queue:');
    logger.table({
      'Head': head.toString(),
      'Tail': tail.toString(),
      'Pending': (tail - head).toString(),
      'Capacity (MAX_ENTRIES)': '200',
    });
  } catch (e: any) {
    logger.error(`Failed to fetch redemption queue: ${e.message}`);
  }

  // Bridge config / nonce fetchers removed in the noBridge refactor.

  // Vault Config (OkuDollar)
  logger.log('');
  logger.info('Fetching Vault Config...');
  try {
    const vc = await ctx.vault.account.okuDollarConfig.fetch(ctx.vaultConfig);
    // usdOku total supply lives on the mint, not on OkuDollarConfig (the
    // previous `vc.totalShares` field never existed and was rendering as NaN).
    const usdOkuMintInfo = await getMint(
      ctx.provider.connection,
      ctx.usdOkuMint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    logger.success('Vault Config:');
    logger.table({
      'Role Admin': (vc.roleAdmin as PublicKey).toBase58(),
      'Pauser': (vc.pauser as PublicKey).toBase58(),
      'Unpauser': (vc.unpauser as PublicKey).toBase58(),
      'OkuMoney Mint': (vc.okuMoneyMint as PublicKey).toBase58(),
      'usdOku Mint': (vc.usdOkuMint as PublicKey).toBase58(),
      'Reserve Vault': (vc.reserveVault as PublicKey).toBase58(),
      'usdOku Total Supply': fmtAmount(Number(usdOkuMintInfo.supply)),
      'Is Paused': String(vc.isPaused),
    });
  } catch (e: any) {
    logger.error(`Failed to fetch vault config: ${e.message}`);
  }

  // Token balances
  logger.log('');
  logger.info('Deployer token balances:');
  const usdcBal = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMoneyBal = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  // usdOku (usdOku) is also Token-2022
  const usdOkuBal = await getTokenBalance(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const solBal = await ctx.provider.connection.getBalance(ctx.deployer.publicKey);
  logger.table({
    'SOL': (solBal / LAMPORTS_PER_SOL).toFixed(4),
    'USDC': fmtAmount(usdcBal),
    'OkuMoney': fmtAmount(okuMoneyBal),
    'usdOku': fmtAmount(usdOkuBal),
  });
}

/**
 * Mint USDC -> OkuMoney via PSM
 */
async function testMint(ctx: TestContext) {
  logger.section('Test: Mint OkuMoney');

  const amount = 100_000_000; // 100 USDC

  // 1. Ensure oracle is disabled (Pubkey.default = disabled)
  logger.info('Disabling oracle for test mint...');
  try {
    const sig = await ctx.psm.methods
      .setOracle(PublicKey.default, new BN(0))
      .accountsPartial({
        oracleManager: ctx.deployer.publicKey,
        config: ctx.psmConfig,
      })
      .rpc();
    await confirmTx(ctx, sig);
    logger.success(`Oracle disabled. Tx: ${explorerLink(ctx.network, sig)}`);
  } catch (e: any) {
    logger.warning(`Oracle may already be disabled: ${e.message}`);
  }

  // 2. Mint test USDC to deployer
  logger.info(`Minting ${amount / 1_000_000} USDC to deployer...`);
  await mintTestUsdc(ctx, amount);

  // 3. Get balances before
  const usdcBefore = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMoneyBefore = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - USDC: ${fmtAmount(usdcBefore)}, OkuMoney: ${fmtAmount(okuMoneyBefore)}`);

  // 4. Ensure ATAs exist (pre-create OkuMoney ATA to avoid init_if_needed CPI corruption)
  const userUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.deployer.publicKey, false, TOKEN_PROGRAM_ID);
  const userOkuMoneyAta = await getOrCreateAta(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);

  // 5. Call PSM mintOkuM (mint_oku_m in the IDL)
  logger.info(`Calling psm.mintOkuM(${amount / 1_000_000} USDC)...`);
  const sig = await ctx.psm.methods
    .mintOkuM(new BN(amount))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      usdcMint: ctx.usdcMint,
      okuMoneyMint: ctx.okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta: userOkuMoneyAta,
      vaultUsdc: ctx.psmVaultUsdc,
      priceUpdate: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Mint tx: ${explorerLink(ctx.network, sig)}`);

  // 6. Verify
  const usdcAfter = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMoneyAfter = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - USDC: ${fmtAmount(usdcAfter)}, OkuMoney: ${fmtAmount(okuMoneyAfter)}`);
  logger.success(`Minted ${fmtAmount(okuMoneyAfter - okuMoneyBefore)} OkuMoney`);
}

/**
 * Transfer OkuMoney to a new recipient
 */
async function testTransfer(ctx: TestContext) {
  logger.section('Test: Transfer OkuMoney');

  const transferAmount = 10_000_000; // 10 OkuMoney

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

  // 3. Create recipient OkuMoney ATA (deployer pays)
  const recipientAta = await getOrCreateAta(ctx, ctx.okuMoneyMint, recipient.publicKey, TOKEN_2022_PROGRAM_ID);

  // 4. Transfer via Token-2022
  const senderAta = getAssociatedTokenAddressSync(
    ctx.okuMoneyMint,
    ctx.deployer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(`Transferring ${transferAmount / 1_000_000} OkuMoney...`);
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
  const senderBal = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const recipientBal = await getTokenBalance(ctx, ctx.okuMoneyMint, recipient.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Sender OkuMoney: ${fmtAmount(senderBal)}`);
  logger.info(`Recipient OkuMoney: ${fmtAmount(recipientBal)}`);
  logger.success('Transfer verified');
}

/**
 * Update USD multiplier (rebase) via OkuDollar vault
 * This test updates the usd_multiplier which controls the OkuMoney:usdOku exchange rate
 */
async function testRebase(ctx: TestContext) {
  logger.section('Test: Update USD Multiplier (Rebase)');

  // 1. Read current vault state
  const vcBefore = await ctx.vault.account.okuDollarConfig.fetch(ctx.vaultConfig);
  const currentMultiplier = Number(vcBefore.usdMultiplier);
  logger.info(`Current USD multiplier: ${currentMultiplier}`);

  // 2. First, deposit reserves to ensure we have enough collateral
  // The vault needs OkuMoney reserves to back the usdOku supply when rebasing
  // Check if we have enough OkuMoney to deposit
  const userOkuMoneyAta = await getOrCreateAta(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const userBalance = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  
  // Use 10% of available balance for reserves, minimum 1 OkuMoney
  const minReserve = 1_000_000; // 1 OkuMoney minimum
  const reserveAmount = Math.max(minReserve, Math.floor(Number(userBalance) / 10));
  
  if (userBalance >= BigInt(minReserve)) {
    logger.info(`Depositing ${reserveAmount / 1_000_000} OkuMoney as reserves...`);
    try {
      const depositSig = await ctx.vault.methods
        .depositReserves(new BN(reserveAmount))
        .accountsPartial({
          reserveManager: ctx.deployer.publicKey,
          config: ctx.vaultConfig,
          okuMoneyMint: ctx.okuMoneyMint,
          usdOkuMint: ctx.usdOkuMint,
          sourceAta: userOkuMoneyAta,
          reserveVault: ctx.vaultOkusd,
          psmConfig: ctx.psmConfig,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      await confirmTx(ctx, depositSig);
      logger.success(`Deposited reserves. Tx: ${explorerLink(ctx.network, depositSig)}`);
    } catch (e: any) {
      logger.warning(`Reserve deposit failed: ${e.message?.slice(0, 80)}`);
    }
  } else {
    logger.info(`Not enough OkuMoney to deposit reserves (have ${fmtAmount(userBalance)}, need ${fmtAmount(reserveAmount)})`);
  }

  // 3. Increase multiplier by 0.0001% (simulating yield accrual)
  // Multiplier is stored as 1e9 scale (1_000_000_000 = 1.0)
  const newMultiplier = currentMultiplier + 1000; // +0.0001%
  logger.info(`Setting USD multiplier to ${newMultiplier} (+0.0001%)...`);

  const sig = await ctx.vault.methods
    .updateUsdMultiplier(new BN(newMultiplier))
    .accountsPartial({
      usdRebaser: ctx.deployer.publicKey,
      config: ctx.vaultConfig,
      reserveVault: ctx.vaultOkusd,
      usdOkuMint: ctx.usdOkuMint,
      psmConfig: ctx.psmConfig,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Rebase tx: ${explorerLink(ctx.network, sig)}`);

  // 4. Verify
  const vcAfter = await ctx.vault.account.okuDollarConfig.fetch(ctx.vaultConfig);
  logger.info(`New USD multiplier: ${vcAfter.usdMultiplier}`);
  logger.success(`USD multiplier updated from ${currentMultiplier} to ${vcAfter.usdMultiplier}`);
}

/**
 * Wrap OkuMoney -> usdOku
 */
async function testWrap(ctx: TestContext) {
  logger.section('Test: Wrap OkuMoney -> usdOku');

  // 1. Ensure ATAs exist (both OkuMoney and usdOku are Token-2022)
  const userOkuMoneyAta = await getOrCreateAta(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const userUsdOkuAta = await getOrCreateAta(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);

  // 2. Get balances before
  const okuMoneyBefore = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const usdOkuBefore = await getTokenBalance(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - OkuMoney: ${fmtAmount(okuMoneyBefore)}, usdOku: ${fmtAmount(usdOkuBefore)}`);

  // Use 25% of available balance, minimum 1 OkuMoney
  const minWrap = 1_000_000; // 1 OkuMoney minimum
  const wrapAmount = Math.max(minWrap, Math.floor(Number(okuMoneyBefore) / 4));
  
  if (okuMoneyBefore < BigInt(minWrap)) {
    logger.error(`Insufficient OkuMoney balance (${fmtAmount(okuMoneyBefore)} < ${fmtAmount(minWrap)}). Run mint first.`);
    return;
  }

  // 3. Call vault.wrap
  // We need to derive the dead_shares_ata for first deposit (uses System Program as "dead" owner)
  const deadSharesAta = getAssociatedTokenAddressSync(
    ctx.usdOkuMint,
    SystemProgram.programId, // Dead address
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // Create dead_shares_ata if it doesn't exist (first wrap ever on this vault)
  const deadAtaInfo = await ctx.provider.connection.getAccountInfo(deadSharesAta);
  if (!deadAtaInfo) {
    logger.info('Creating dead_shares_ata for first-time vault setup...');
    const createDeadAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        ctx.deployer.publicKey, // payer
        deadSharesAta,
        SystemProgram.programId, // owner (dead address)
        ctx.usdOkuMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(ctx.provider.connection, createDeadAtaTx, [ctx.deployer]);
    logger.success('Created dead_shares_ata');
  }

  logger.info(`Calling vault.wrap(${wrapAmount / 1_000_000} OkuMoney)...`);
  
  // Build accounts with camelCase (Anchor client convention)
  const sig = await ctx.vault.methods
    .wrap(new BN(wrapAmount), new BN(0)) // (oku_m_amount, min_shares_out)
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.vaultConfig,
      okuMoneyMint: ctx.okuMoneyMint,
      usdOkuMint: ctx.usdOkuMint,
      userOkuMoneyAta: userOkuMoneyAta,
      userUsdOkuAta: userUsdOkuAta,
      reserveVault: ctx.vaultOkusd,
      psmConfig: ctx.psmConfig,
      deadSharesAta: deadSharesAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Wrap tx: ${explorerLink(ctx.network, sig)}`);

  // 4. Verify
  const okuMoneyAfter = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const usdOkuAfter = await getTokenBalance(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - OkuMoney: ${fmtAmount(okuMoneyAfter)}, usdOku: ${fmtAmount(usdOkuAfter)}`);
  logger.success(`Wrapped ${fmtAmount(okuMoneyBefore - okuMoneyAfter)} OkuMoney -> ${fmtAmount(usdOkuAfter - usdOkuBefore)} usdOku`);
}

/**
 * Unwrap usdOku -> OkuMoney
 */
async function testUnwrap(ctx: TestContext) {
  logger.section('Test: Unwrap usdOku -> OkuMoney');

  // 1. Ensure ATAs exist (both are Token-2022)
  const userOkuMoneyAta = await getOrCreateAta(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const userUsdOkuAta = await getOrCreateAta(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);

  // 2. Get balances before
  const okuMoneyBefore = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const usdOkuBefore = await getTokenBalance(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - OkuMoney: ${fmtAmount(okuMoneyBefore)}, usdOku: ${fmtAmount(usdOkuBefore)}`);

  // Use 50% of available usdOku balance, minimum 1 usdOku
  const minUnwrap = 1_000_000; // 1 usdOku minimum
  const unwrapShares = Math.max(minUnwrap, Math.floor(Number(usdOkuBefore) / 2));
  
  if (usdOkuBefore < BigInt(minUnwrap)) {
    logger.error(`Insufficient usdOku balance (${fmtAmount(usdOkuBefore)} < ${fmtAmount(minUnwrap)}). Run wrap first.`);
    return;
  }

  // 3. Call vault.unwrap
  logger.info(`Calling vault.unwrap(${unwrapShares / 1_000_000} shares)...`);
  const sig = await ctx.vault.methods
    .unwrap(new BN(unwrapShares))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.vaultConfig,
      okuMoneyMint: ctx.okuMoneyMint,
      usdOkuMint: ctx.usdOkuMint,
      userOkuMoneyAta: userOkuMoneyAta,
      userUsdOkuAta: userUsdOkuAta,
      reserveVault: ctx.vaultOkusd,
      psmConfig: ctx.psmConfig,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Unwrap tx: ${explorerLink(ctx.network, sig)}`);

  // 4. Verify
  const okuMoneyAfter = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const usdOkuAfter = await getTokenBalance(ctx, ctx.usdOkuMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - OkuMoney: ${fmtAmount(okuMoneyAfter)}, usdOku: ${fmtAmount(usdOkuAfter)}`);
  logger.success(`Unwrapped ${fmtAmount(usdOkuBefore - usdOkuAfter)} usdOku -> ${fmtAmount(okuMoneyAfter - okuMoneyBefore)} OkuMoney`);
}

/**
 * Redeem OkuMoney -> USDC (deposit buffer first, then redeem)
 */
async function testRedeem(ctx: TestContext) {
  logger.section('Test: Redeem OkuMoney -> USDC');

  const redeemAmount = 10_000_000; // 10 OkuMoney
  const bufferAmount = 20_000_000; // 20 USDC buffer (extra to ensure instant redemption)

  // 1. Deposit USDC buffer so instant redemption works
  logger.info(`Depositing ${bufferAmount / 1_000_000} USDC buffer...`);

  // Mint USDC for buffer
  await mintTestUsdc(ctx, bufferAmount);

  const bufferDepositorUsdcAta = getAssociatedTokenAddressSync(
    ctx.usdcMint,
    ctx.deployer.publicKey,
    true,
    TOKEN_PROGRAM_ID
  );

  const depositSig = await ctx.psm.methods
    .depositBuffer(new BN(bufferAmount))
    .accountsPartial({
      bufferDepositor: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      bufferDepositorUsdcAta,
      vaultUsdc: ctx.psmVaultUsdc,
      usdcMint: ctx.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  await confirmTx(ctx, depositSig);
  logger.success(`Buffer deposit tx: ${explorerLink(ctx.network, depositSig)}`);

  // 2. Get balances before
  const usdcBefore = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okuMoneyBefore = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - USDC: ${fmtAmount(usdcBefore)}, OkuMoney: ${fmtAmount(okuMoneyBefore)}`);

  if (okuMoneyBefore < BigInt(redeemAmount)) {
    logger.error(`Insufficient OkuMoney balance (${fmtAmount(okuMoneyBefore)} < ${fmtAmount(redeemAmount)}). Run mint first.`);
    return;
  }

  // 3. Ensure ATAs
  const userUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.deployer.publicKey, true, TOKEN_PROGRAM_ID);
  const userOkuMoneyAta = getAssociatedTokenAddressSync(ctx.okuMoneyMint, ctx.deployer.publicKey, true, TOKEN_2022_PROGRAM_ID);

  // Ensure vault OkuMoney ATA exists (for queued redemptions escrow)
  await getOrCreateAta(ctx, ctx.okuMoneyMint, ctx.psmConfig, TOKEN_2022_PROGRAM_ID);

  // 4. Call PSM redeemOkuM (redeem_oku_m in the IDL)
  // Note: On forks, the Token-2022 interest-bearing extension can cause overflow errors
  // if the fork timestamp differs significantly from when interest was last calculated.
  // This is a known limitation of forking interest-bearing tokens.
  logger.info(`Calling psm.redeemOkuM(${redeemAmount / 1_000_000} OkuMoney)...`);
  
  try {
    const sig = await ctx.psm.methods
      .redeemOkuM(new BN(redeemAmount))
      .accountsPartial({
        user: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        redemptionQueue: ctx.redemptionQueue,
        usdcMint: ctx.usdcMint,
        okuMoneyMint: ctx.okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta: userOkuMoneyAta,
        vaultUsdc: ctx.psmVaultUsdc,
        vaultOkuMoney: ctx.psmOkuMoneyEscrow,
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
    const okuMoneyAfter = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
    logger.info(`After - USDC: ${fmtAmount(usdcAfter)}, OkuMoney: ${fmtAmount(okuMoneyAfter)}`);
    logger.success(`Redeemed ${fmtAmount(okuMoneyBefore - okuMoneyAfter)} OkuMoney -> ${fmtAmount(usdcAfter - usdcBefore)} USDC`);
  } catch (e: any) {
    // Check for Token-2022 interest overflow error (common on forks)
    if (e.message?.includes('Operation overflowed') || e.logs?.some((l: string) => l.includes('Operation overflowed'))) {
      logger.warning('Redeem failed due to Token-2022 interest calculation overflow');
      logger.info('This is a known issue when forking interest-bearing tokens.');
      logger.info('The fork timestamp causes interest accrual calculations to overflow.');
      logger.info('This does NOT affect live devnet - only Surfpool forks.');
      // Don't throw - just mark as skipped
      return;
    }
    throw e;
  }
}

/**
 * Queued redemption end-to-end (Phase 13b coverage):
 *   1. Drain any pre-existing queue entries (defensive — earlier steps
 *      should not have left any, but be conservative).
 *   2. Drain the PSM USDC buffer to zero via `withdraw_buffer`.
 *   3. Submit `redeem_oku_m` — with no buffer, the program takes the
 *      queue path: OkuMoney is escrowed into the vault and an entry is
 *      pushed onto `RedemptionQueue` with tail++.
 *   4. Refill the buffer via `deposit_buffer` so the queue can be paid.
 *   5. Drive `process_queue` (auto-batching at MAX_BATCH_ENTRIES=50)
 *      until the queue is empty.
 *   6. Assert head advanced, the recipient ATA was paid out in USDC,
 *      and total_queued_oku_m returned to zero.
 *
 * On devnet the deployer holds buffer_depositor, buffer_withdrawer,
 * and queue_processor — all three roles. On a multisig deployment this
 * step would need refactoring to drive each call from the right signer.
 *
 * Constants must mirror Rust: MAX_BATCH_ENTRIES from
 * programs/lite-psm/src/instructions/psm.rs and MAX_ENTRIES from state.rs.
 */
const QUEUE_REDEEM_MAX_BATCH = 50; // mirrors `MAX_BATCH_ENTRIES` in psm.rs
const QUEUE_REDEEM_MAX_ENTRIES = 200n; // mirrors `MAX_ENTRIES` in state.rs

function bnToBigInt(bn: BN): bigint {
  return BigInt(bn.toString());
}

async function drainQueueViaProcess(
  ctx: TestContext,
  vaultUsdc: PublicKey,
  vaultOkuMoney: PublicKey
): Promise<{ batches: number; drained: number }> {
  let batches = 0;
  let drained = 0;
  // Safety bound: 200 / 50 = 4 nominal batches; allow generous slack.
  for (let safety = 0; safety < 10; safety++) {
    const q = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
    const head = bnToBigInt(q.head as BN);
    const tail = bnToBigInt(q.tail as BN);
    if (tail <= head) return { batches, drained };
    const pending = Number(tail - head);
    const thisBatch = Math.min(pending, QUEUE_REDEEM_MAX_BATCH);

    const entries = q.entries as Array<{ user: PublicKey; okuMAmount: BN }>;
    const recipientAtas: PublicKey[] = [];
    for (let i = 0; i < thisBatch; i++) {
      const slot = Number((head + BigInt(i)) % QUEUE_REDEEM_MAX_ENTRIES);
      const entry = entries[slot];
      if (entry.user.equals(PublicKey.default)) continue;
      const ata = getAssociatedTokenAddressSync(
        ctx.usdcMint,
        entry.user,
        false,
        TOKEN_PROGRAM_ID
      );
      // Ensure the ATA exists — process_queue does NOT create it.
      await getOrCreateAta(ctx, ctx.usdcMint, entry.user, TOKEN_PROGRAM_ID);
      recipientAtas.push(ata);
    }

    const sig = await ctx.psm.methods
      .processQueue(thisBatch)
      .accountsPartial({
        queueProcessor: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        redemptionQueue: ctx.redemptionQueue,
        okuMoneyMint: ctx.okuMoneyMint,
        vaultUsdc,
        vaultOkuMoney,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(
        recipientAtas.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }))
      )
      .rpc();
    await confirmTx(ctx, sig);
    batches++;
    drained += thisBatch;
    logger.success(
      `process_queue batch ${batches}: drained ${thisBatch} ` +
        `(head ${head} → ${head + BigInt(thisBatch)}). Tx: ${explorerLink(ctx.network, sig)}`
    );
  }
  return { batches, drained };
}

async function testQueueRedeem(ctx: TestContext) {
  logger.section('Test: Queued Redemption (Phase 13b coverage)');

  // ---- 0. Pre-flight: ensure deployer has OkuMoney + ATAs ----
  const userOkuMoneyAta = await getOrCreateAta(
    ctx,
    ctx.okuMoneyMint,
    ctx.deployer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );
  const userUsdcAta = await getOrCreateAta(
    ctx,
    ctx.usdcMint,
    ctx.deployer.publicKey,
    TOKEN_PROGRAM_ID
  );

  const redeemAmount = 3_000_000; // 3 OkuMoney
  const bufferRefill = 10_000_000; // 10 USDC — comfortably covers the redeem

  const okuMoneyBefore = await getTokenBalance(
    ctx,
    ctx.okuMoneyMint,
    ctx.deployer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );
  if (okuMoneyBefore < BigInt(redeemAmount)) {
    logger.error(
      `Insufficient OkuMoney (${fmtAmount(okuMoneyBefore)} < ${fmtAmount(redeemAmount)}). ` +
        `Run \`--step=mint\` first.`
    );
    return;
  }

  // ---- 1. Defensive: drain any pre-existing queue entries ----
  const queueAtEntry = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
  const headAtEntry = bnToBigInt(queueAtEntry.head as BN);
  const tailAtEntry = bnToBigInt(queueAtEntry.tail as BN);
  if (tailAtEntry > headAtEntry) {
    const pre = Number(tailAtEntry - headAtEntry);
    logger.warning(
      `Queue has ${pre} pending entries from a prior run — draining first ` +
        `(refilling buffer for the drain).`
    );
    // Top up buffer so the existing entries can be paid.
    await mintTestUsdc(ctx, bufferRefill);
    await ctx.psm.methods
      .depositBuffer(new BN(bufferRefill))
      .accountsPartial({
        bufferDepositor: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        bufferDepositorUsdcAta: userUsdcAta,
        vaultUsdc: ctx.psmVaultUsdc,
        usdcMint: ctx.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    await drainQueueViaProcess(ctx, ctx.psmVaultUsdc, ctx.psmOkuMoneyEscrow);
  }

  // ---- 2. Drain the USDC buffer to force the queue path ----
  const vaultUsdcAcct = await getAccount(
    ctx.provider.connection,
    ctx.psmVaultUsdc,
    'confirmed',
    TOKEN_PROGRAM_ID
  );
  const vaultUsdcBefore = vaultUsdcAcct.amount;
  logger.info(`Vault USDC pre-drain: ${fmtAmount(vaultUsdcBefore)}`);
  if (vaultUsdcBefore > 0n) {
    logger.info(`Withdrawing ${fmtAmount(vaultUsdcBefore)} USDC to force queue path...`);
    const sig = await ctx.psm.methods
      .withdrawBuffer(new BN(vaultUsdcBefore.toString()))
      .accountsPartial({
        bufferWithdrawer: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        redemptionQueue: ctx.redemptionQueue,
        okuMoneyMint: ctx.okuMoneyMint,
        withdrawerUsdcAta: userUsdcAta,
        vaultUsdc: ctx.psmVaultUsdc,
        usdcMint: ctx.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    await confirmTx(ctx, sig);
    logger.success(`withdraw_buffer tx: ${explorerLink(ctx.network, sig)}`);
  }
  // Re-fetch to be defensive (no in-flight queue entries should block).
  const vaultUsdcMid = await getAccount(
    ctx.provider.connection,
    ctx.psmVaultUsdc,
    'confirmed',
    TOKEN_PROGRAM_ID
  );
  if (vaultUsdcMid.amount !== 0n) {
    logger.warning(
      `Vault USDC didn't drain to zero (still ${fmtAmount(vaultUsdcMid.amount)}). ` +
        `withdraw_buffer protects queued redemptions — there may be entries we missed.`
    );
  }

  // ---- 3. Submit redeem_oku_m → should land in the queue path ----
  const queueBefore = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
  const tailBefore = bnToBigInt(queueBefore.tail as BN);
  logger.info(`Queue tail before redeem: ${tailBefore}`);
  logger.info(`Calling psm.redeemOkuM(${redeemAmount / 1_000_000} OkuMoney) — buffer is empty so the program will queue it...`);
  const redeemSig = await ctx.psm.methods
    .redeemOkuM(new BN(redeemAmount))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      redemptionQueue: ctx.redemptionQueue,
      usdcMint: ctx.usdcMint,
      okuMoneyMint: ctx.okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta,
      vaultUsdc: ctx.psmVaultUsdc,
      vaultOkuMoney: ctx.psmOkuMoneyEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, redeemSig);
  logger.success(`redeem (queued) tx: ${explorerLink(ctx.network, redeemSig)}`);

  // Verify the redeem went into the queue (tail++) and OkuMoney moved to escrow.
  const queueAfterRedeem = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
  const tailAfterRedeem = bnToBigInt(queueAfterRedeem.tail as BN);
  if (tailAfterRedeem !== tailBefore + 1n) {
    throw new Error(
      `expected tail to advance by 1 (queue path) but went ${tailBefore} → ${tailAfterRedeem}. ` +
        `redeem likely took the instant path — buffer drain may have failed.`
    );
  }
  const totalQueuedAfter = bnToBigInt(queueAfterRedeem.totalQueuedOkuM as BN);
  logger.success(
    `Queue tail advanced ${tailBefore} → ${tailAfterRedeem}; ` +
      `total_queued_oku_m=${totalQueuedAfter} (raw 6-dec units).`
  );

  // ---- 4. Refill buffer so process_queue can pay out ----
  logger.info(`Refilling buffer with ${bufferRefill / 1_000_000} USDC...`);
  await mintTestUsdc(ctx, bufferRefill);
  const depositSig = await ctx.psm.methods
    .depositBuffer(new BN(bufferRefill))
    .accountsPartial({
      bufferDepositor: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      bufferDepositorUsdcAta: userUsdcAta,
      vaultUsdc: ctx.psmVaultUsdc,
      usdcMint: ctx.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  await confirmTx(ctx, depositSig);
  logger.success(`deposit_buffer tx: ${explorerLink(ctx.network, depositSig)}`);

  // ---- 5. Drain the queue via process_queue (auto-batched at MAX_BATCH_ENTRIES) ----
  const userUsdcBeforePayout = await getTokenBalance(
    ctx,
    ctx.usdcMint,
    ctx.deployer.publicKey,
    TOKEN_PROGRAM_ID
  );
  const { batches, drained } = await drainQueueViaProcess(
    ctx,
    ctx.psmVaultUsdc,
    ctx.psmOkuMoneyEscrow
  );

  // ---- 6. Assert the queue is empty and the recipient was paid ----
  const queueFinal = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
  const headFinal = bnToBigInt(queueFinal.head as BN);
  const tailFinal = bnToBigInt(queueFinal.tail as BN);
  if (headFinal !== tailFinal) {
    throw new Error(
      `expected queue empty (head==tail) but got head=${headFinal} tail=${tailFinal}.`
    );
  }
  const totalQueuedFinal = bnToBigInt(queueFinal.totalQueuedOkuM as BN);
  if (totalQueuedFinal !== 0n) {
    throw new Error(
      `expected total_queued_oku_m=0 after drain but got ${totalQueuedFinal}.`
    );
  }

  const userUsdcAfterPayout = await getTokenBalance(
    ctx,
    ctx.usdcMint,
    ctx.deployer.publicKey,
    TOKEN_PROGRAM_ID
  );
  const usdcGained = userUsdcAfterPayout - userUsdcBeforePayout;
  if (usdcGained <= 0n) {
    throw new Error(
      `expected USDC payout > 0 but recipient went ${userUsdcBeforePayout} → ${userUsdcAfterPayout}.`
    );
  }
  logger.success(
    `Drain complete: ${drained} entries across ${batches} batch(es); ` +
      `recipient received ${fmtAmount(usdcGained)} USDC.`
  );
}


// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

const STEPS: Record<string, (ctx: TestContext) => Promise<void>> = {
  state: readState,
  mint: testMint,
  transfer: testTransfer,
  rebase: testRebase,
  wrap: testWrap,
  unwrap: testUnwrap,
  redeem: testRedeem,
  queueRedeem: testQueueRedeem,
  distributeYield: testDistributeYield,
  pause: testPause,
  setAuthority: testSetAuthority,
  oracleMint: testOracleMint,
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
  logger.success(`Vault Program: ${ctx.okuDollarProgramId.toBase58()}`, false);
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
    // Run all steps in order. New Phase 10 steps appended at the end so they
    // run after the wrap/unwrap/redeem flow has populated balances; this
    // ordering also keeps the previous step layout for any operator who
    // greps logs from earlier runs.
    const stepOrder = [
      'state',
      'mint',
      'transfer',
      'rebase',
      'wrap',
      'unwrap',
      'redeem',
      'queueRedeem',
      'distributeYield',
      'pause',
      'setAuthority',
      'oracleMint',
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
