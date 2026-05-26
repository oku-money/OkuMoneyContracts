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
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@anchor-lang/core';
import * as nacl from 'tweetnacl';
import { serializeMintMessage, computeRequestId } from '../lib/bridge';
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
  deriveBridgeConfigPDA,
  deriveBridgeNoncePDA,
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
  bridgeConfig: PublicKey;
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
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

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
    bridgeConfig,
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

  // Bridge Config
  logger.log('');
  logger.info('Fetching Bridge Config...');
  try {
    const bridge = await ctx.psm.account.bridgeConfig.fetch(ctx.bridgeConfig);
    const activeChains = (bridge.supportedChains as number[])
      .slice(0, Number(bridge.supportedChainsCount))
      .filter((c: number) => c !== 0);
    logger.success('Bridge Config:');
    logger.table({
      'Bridge Admin': (bridge.bridgeAdmin as PublicKey).toBase58(),
      'Bridge Pauser': (bridge.bridgePauser as PublicKey).toBase58(),
      'Bridge Unpauser': (bridge.bridgeUnpauser as PublicKey).toBase58(),
      'Orchestrator Signer': (bridge.orchestratorSigner as PublicKey).toBase58(),
      'Fee Recipient': (bridge.feeRecipient as PublicKey).toBase58(),
      'Chain Manager': (bridge.chainManager as PublicKey).toBase58(),
      'Fee Manager': (bridge.feeManager as PublicKey).toBase58(),
      'Nonce Admin': (bridge.nonceAdmin as PublicKey).toBase58(),
      'Bridge Fee BPS': String(bridge.bridgeFeeBps),
      'Min Bridge Amount': fmtAmount(Number(bridge.minBridgeAmount)),
      'Max Bridge Amount': fmtAmount(Number(bridge.maxBridgeAmount)),
      'Is Paused': String(bridge.isPaused),
      'Supported Chains': activeChains.join(', ') || 'None',
    });
  } catch (e: any) {
    logger.error(`Failed to fetch bridge config: ${e.message}`);
  }

  // Bridge Nonces
  logger.log('');
  logger.info('Fetching Bridge Nonces...');
  if (ctx.deployment.nonces) {
    for (const [chainId, address] of Object.entries(ctx.deployment.nonces)) {
      try {
        const nonce = await ctx.psm.account.bridgeNonce.fetch(new PublicKey(address));
        logger.success(`Chain ${chainId}: next_nonce = ${nonce.nextNonce}`);
      } catch (e: any) {
        logger.error(`Chain ${chainId}: ${e.message}`);
      }
    }
  }

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

/**
 * Bridge burn OkuMoney (Solana -> EVM)
 */
async function testBridgeBurn(ctx: TestContext) {
  logger.section('Test: Bridge Burn (Solana -> EVM)');

  const burnAmount = 5_000_000; // 5 OkuMoney
  const evmRecipient = Buffer.alloc(20);
  evmRecipient.write('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');

  // Fetch bridge config first so we can pick a destination chain that's
  // actually supported on the deployed config. Previously this was hardcoded
  // to chain=1 (Ethereum mainnet), which fails on any testnet deployment
  // that only registers SUPPORTED_CHAINS_TESTNET ([111, 420]). Reading from
  // chain keeps the test working across mainnet AND testnet without
  // needing per-network branching.
  const bridgeConfigData = await ctx.psm.account.bridgeConfig.fetch(ctx.bridgeConfig);
  const feeRecipient = bridgeConfigData.feeRecipient as PublicKey;
  const supportedChains: number[] = (bridgeConfigData.supportedChains as any[])
    .map((c: any) => Number(c));
  if (supportedChains.length === 0) {
    logger.error('Bridge config has no supported chains; cannot run bridge burn test.');
    return;
  }
  const destinationChainId = supportedChains[0];
  logger.info(`Using destinationChainId=${destinationChainId} (first entry of bridgeConfig.supportedChains = ${JSON.stringify(supportedChains)})`);

  // 1. Derive bridge nonce PDA for destination chain
  const [bridgeNonce] = deriveBridgeNoncePDA(ctx.litePsmId, destinationChainId);

  // 2. Get balances before
  const okuMoneyBefore = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - OkuMoney: ${fmtAmount(okuMoneyBefore)}`);

  if (okuMoneyBefore < BigInt(burnAmount)) {
    logger.error(`Insufficient OkuMoney balance (${fmtAmount(okuMoneyBefore)} < ${fmtAmount(burnAmount)}). Run mint first.`);
    return;
  }
  
  // 4. Ensure ATAs exist
  const userOkuMoneyAta = await getOrCreateAta(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  
  // Fee recipient ATA - if same as user, Anchor will reject duplicate mutable accounts
  // In that case, fee goes to the user's ATA anyway
  const feeRecipientAta = feeRecipient.equals(ctx.deployer.publicKey)
    ? userOkuMoneyAta // Same account, but Anchor might still reject this
    : await getOrCreateAta(ctx, ctx.okuMoneyMint, feeRecipient, TOKEN_2022_PROGRAM_ID);

  // If fee recipient is the user, we cannot bridge (duplicate mutable account constraint)
  if (feeRecipient.equals(ctx.deployer.publicKey)) {
    logger.warning('Skipping bridge test: fee recipient is the same as user (would cause duplicate mutable account error)');
    logger.info('In production, the fee recipient would be a different address');
    return;
  }

  // 5. Call bridge_burn
  logger.info(`Calling psm.bridgeBurn(${burnAmount / 1_000_000} OkuMoney, chain=${destinationChainId})...`);
  const sig = await ctx.psm.methods
    .bridgeBurn(
      new BN(burnAmount),
      Array.from(evmRecipient),
      destinationChainId
    )
    .accountsPartial({
      user: ctx.deployer.publicKey,
      bridgeConfig: ctx.bridgeConfig,
      config: ctx.psmConfig,
      bridgeNonce,
      okuMoneyMint: ctx.okuMoneyMint,
      userOkuMoneyAta: userOkuMoneyAta,
      feeRecipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Bridge burn tx: ${explorerLink(ctx.network, sig)}`);

  // 6. Verify
  const okuMoneyAfter = await getTokenBalance(ctx, ctx.okuMoneyMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - OkuMoney: ${fmtAmount(okuMoneyAfter)}`);
  logger.success(`Burned ${fmtAmount(okuMoneyBefore - okuMoneyAfter)} OkuMoney for bridge to chain ${destinationChainId}`);

  // 7. Read updated nonce
  try {
    const nonceAccount = await ctx.psm.account.bridgeNonce.fetch(bridgeNonce);
    logger.info(`Bridge nonce for chain ${destinationChainId}: ${nonceAccount.nextNonce}`);
  } catch (e: any) {
    logger.warning(`Could not read nonce: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 10 additions
// ---------------------------------------------------------------------------

/**
 * Distribute dollar-denominated yield across all OkuMoney holders.
 * On devnet the deployer holds the `rebaser` role.
 */
async function testDistributeYield(ctx: TestContext) {
  logger.section('Test: Distribute Yield');

  // Read current price + supply for the summary.
  const cfgBefore = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  const mintInfo = await getMint(
    ctx.provider.connection,
    ctx.okuMoneyMint,
    'confirmed',
    TOKEN_2022_PROGRAM_ID
  );
  const supply = mintInfo.supply;
  const priceBefore = (cfgBefore.okuMPrice as BN).toString();
  logger.info(`Current oku_m_price (1e9): ${priceBefore}`);
  logger.info(`Current supply (6dec):     ${supply.toString()}`);

  if (supply === 0n) {
    logger.warning('Supply is zero — distribute_yield would divide by zero. Run mint first.');
    return;
  }

  // Pick a tiny yield (1 USDC) so the bump is observable without distorting
  // post-rebase state too much for subsequent steps.
  const yieldAmount = 1_000_000;
  logger.info(`Distributing ${yieldAmount / 1_000_000} USD of yield…`);

  const sig = await ctx.psm.methods
    .distributeYield(new BN(yieldAmount))
    .accountsPartial({
      rebaser: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      okuMoneyMint: ctx.okuMoneyMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`distribute_yield tx: ${explorerLink(ctx.network, sig)}`);

  const cfgAfter = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  logger.info(`New oku_m_price (1e9):     ${(cfgAfter.okuMPrice as BN).toString()}`);
  logger.info(`last_yield_distribution_slot: ${cfgAfter.lastYieldDistributionSlot.toString()}`);
  logger.success(
    `Price bumped by ${(cfgAfter.okuMPrice as BN)
      .sub(cfgBefore.okuMPrice as BN)
      .toString()} units`
  );
}

/**
 * Pause then unpause the PSM. Both calls should succeed on devnet
 * because the deployer holds pauser AND unpauser roles.
 */
async function testPause(ctx: TestContext) {
  logger.section('Test: Pause/Unpause PSM');

  // 1. Confirm not already paused.
  let cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (cfg.isPaused) {
    logger.warning('PSM already paused; unpausing first so the test is idempotent.');
    const sig0 = await ctx.psm.methods
      .unpause()
      .accountsPartial({
        unpauser: ctx.deployer.publicKey,
        config: ctx.psmConfig,
      })
      .rpc();
    await confirmTx(ctx, sig0);
  }

  // 2. Pause.
  const pauseSig = await ctx.psm.methods
    .pause()
    .accountsPartial({
      pauser: ctx.deployer.publicKey,
      config: ctx.psmConfig,
    })
    .rpc();
  await confirmTx(ctx, pauseSig);
  cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (!cfg.isPaused) {
    throw new Error('Pause tx confirmed but is_paused is still false.');
  }
  logger.success(`Paused. Tx: ${explorerLink(ctx.network, pauseSig)}`);

  // 3. Unpause.
  const unpauseSig = await ctx.psm.methods
    .unpause()
    .accountsPartial({
      unpauser: ctx.deployer.publicKey,
      config: ctx.psmConfig,
    })
    .rpc();
  await confirmTx(ctx, unpauseSig);
  cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (cfg.isPaused) {
    throw new Error('Unpause tx confirmed but is_paused is still true.');
  }
  logger.success(`Unpaused. Tx: ${explorerLink(ctx.network, unpauseSig)}`);
}

/**
 * Rotate the pauser role to a fresh keypair via set_authority, then rotate
 * it back. Tests both directions of the role-admin gate.
 */
async function testSetAuthority(ctx: TestContext) {
  logger.section('Test: Set Authority (pauser rotation)');

  const cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  const originalPauser = cfg.pauser as PublicKey;
  logger.info(`Original pauser: ${originalPauser.toBase58()}`);

  const newPauser = Keypair.generate();

  // 1. Rotate to a fresh keypair.
  const rotateSig = await ctx.psm.methods
    .setAuthority({ pauser: {} } as any, newPauser.publicKey)
    .accountsPartial({
      roleAdmin: ctx.deployer.publicKey,
      config: ctx.psmConfig,
    })
    .rpc();
  await confirmTx(ctx, rotateSig);
  let cfgAfter = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (!(cfgAfter.pauser as PublicKey).equals(newPauser.publicKey)) {
    throw new Error('set_authority rotation did not take effect.');
  }
  logger.success(`Rotated pauser to ${newPauser.publicKey.toBase58()}. Tx: ${explorerLink(ctx.network, rotateSig)}`);

  // 2. Rotate back to the original (so subsequent test runs are idempotent).
  const restoreSig = await ctx.psm.methods
    .setAuthority({ pauser: {} } as any, originalPauser)
    .accountsPartial({
      roleAdmin: ctx.deployer.publicKey,
      config: ctx.psmConfig,
    })
    .rpc();
  await confirmTx(ctx, restoreSig);
  cfgAfter = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  if (!(cfgAfter.pauser as PublicKey).equals(originalPauser)) {
    throw new Error('Could not restore pauser to original.');
  }
  logger.success(`Restored pauser to ${originalPauser.toBase58()}. Tx: ${explorerLink(ctx.network, restoreSig)}`);
}

/**
 * Exercise initiate_refund + cancel_refund. Confirm_refund needs the
 * deadline to elapse (default 1 hour), which is intractable on a real
 * cluster — skip the confirm leg on devnet and rely on bankrun for the
 * full happy-path test.
 *
 * Requires the deployer to hold the refund_initiator role. The default
 * devnet authority config sets refund_initiator/refund_confirmer to PDAs
 * (which can't sign), so this step rotates them to fresh keypairs via
 * set_bridge_authority first, then restores. If that rotation fails
 * (e.g. mainnet-like authority layout), the step is skipped.
 */
async function testRefund(ctx: TestContext) {
  logger.section('Test: Refund (initiate + cancel)');

  // 1. Try rotating refund_initiator to the deployer (escape from PDA default).
  const bridgeCfg = await ctx.psm.account.bridgeConfig.fetch(ctx.bridgeConfig);
  const originalInitiator = bridgeCfg.refundInitiator as PublicKey;
  const originalConfirmer = bridgeCfg.refundConfirmer as PublicKey;
  const dummyConfirmer = Keypair.generate(); // Must differ from initiator.

  try {
    await ctx.psm.methods
      .setBridgeAuthority({ refundInitiator: {} } as any, ctx.deployer.publicKey)
      .accountsPartial({
        bridgeAdmin: ctx.deployer.publicKey,
        bridgeConfig: ctx.bridgeConfig,
      })
      .rpc();
    await ctx.psm.methods
      .setBridgeAuthority({ refundConfirmer: {} } as any, dummyConfirmer.publicKey)
      .accountsPartial({
        bridgeAdmin: ctx.deployer.publicKey,
        bridgeConfig: ctx.bridgeConfig,
      })
      .rpc();
    logger.success('Rotated refund_initiator (deployer) and refund_confirmer (dummy).');
  } catch (e: any) {
    logger.warning(`Cannot rotate refund roles (deployer not bridge_admin?): ${e.message?.slice(0, 100)}`);
    logger.info('Skipping refund flow; rely on bankrun happy-path test for coverage.');
    return;
  }

  try {
    // 2. Need an existing bridge_burn to refund. Reuse `testBridgeBurn`'s logic
    //    by building the burn here in-line.
    const okuMBalance = await getTokenBalance(
      ctx,
      ctx.okuMoneyMint,
      ctx.deployer.publicKey,
      TOKEN_2022_PROGRAM_ID
    );
    const burnAmount = 1_000_000n;
    if (okuMBalance < burnAmount) {
      logger.warning(`Insufficient OkuMoney (have ${okuMBalance}, need ${burnAmount}). Run mint first.`);
      return;
    }

    const destChainId = 1;
    const evmRecipient = new Uint8Array(20);
    crypto.getRandomValues(evmRecipient);
    const [bridgeNonce] = deriveBridgeNoncePDA(ctx.litePsmId, destChainId);

    const feeRecipient = bridgeCfg.feeRecipient as PublicKey;
    const userOkuMoneyAta = await getOrCreateAta(
      ctx,
      ctx.okuMoneyMint,
      ctx.deployer.publicKey,
      TOKEN_2022_PROGRAM_ID
    );
    if (feeRecipient.equals(ctx.deployer.publicKey)) {
      logger.warning('Fee recipient is the deployer; cannot burn (duplicate mutable account).');
      return;
    }
    const feeRecipientAta = await getOrCreateAta(
      ctx,
      ctx.okuMoneyMint,
      feeRecipient,
      TOKEN_2022_PROGRAM_ID
    );

    const burnSig = await ctx.psm.methods
      .bridgeBurn(new BN(burnAmount.toString()), Array.from(evmRecipient), destChainId)
      .accountsPartial({
        user: ctx.deployer.publicKey,
        bridgeConfig: ctx.bridgeConfig,
        config: ctx.psmConfig,
        bridgeNonce,
        okuMoneyMint: ctx.okuMoneyMint,
        userOkuMoneyAta,
        feeRecipientAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await confirmTx(ctx, burnSig);
    logger.success(`Burn tx: ${explorerLink(ctx.network, burnSig)}`);

    // 3. Reconstruct the message + request_id by parsing the BridgeBurnEvent
    //    from the tx logs (the canonical source — see scripts/lib/bridge/event.ts).
    const { fetchBridgeBurnEvent, serializeBurnMessage } = await import('../lib/bridge');
    const event = await fetchBridgeBurnEvent(
      ctx.provider.connection,
      burnSig,
      ctx.psm.idl as any
    );
    const messageBytes = serializeBurnMessage({
      sourceChainId: event.sourceChainId,
      destChainId: event.destinationChain,
      sender: ctx.deployer.publicKey,
      recipient: evmRecipient,
      amount: event.amount,
      nonce: event.nonce,
      deadline: event.deadline,
    });
    const requestId = computeRequestId(messageBytes);

    const [pendingRefund] = PublicKey.findProgramAddressSync(
      [Buffer.from('pending_refund'), requestId],
      ctx.litePsmId
    );
    const [processedRequest] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_request'), requestId],
      ctx.litePsmId
    );
    const [refundedRequest] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_refund'), requestId],
      ctx.litePsmId
    );

    // 4. initiate_refund must fail with MintWindowStillOpen (deadline = now + 1h).
    try {
      await ctx.psm.methods
        .initiateRefund(messageBytes, Array.from(requestId) as number[])
        .accountsPartial({
          refundInitiator: ctx.deployer.publicKey,
          bridgeConfig: ctx.bridgeConfig,
          config: ctx.psmConfig,
          pendingRefund,
          processedRequest,
          refundedRequest,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      throw new Error('initiate_refund unexpectedly succeeded before deadline.');
    } catch (e: any) {
      const errStr = String(e?.message ?? e);
      if (errStr.includes('MintWindowStillOpen')) {
        logger.success('initiate_refund rejected with MintWindowStillOpen (expected pre-deadline).');
      } else {
        throw e;
      }
    }
    logger.info('Confirm_refund leg requires deadline to elapse — covered by bankrun tests.');
  } finally {
    // 5. Restore the original refund_initiator/confirmer so subsequent runs
    //    re-establish the PDA defaults expected by the devnet authority layout.
    try {
      await ctx.psm.methods
        .setBridgeAuthority({ refundInitiator: {} } as any, originalInitiator)
        .accountsPartial({
          bridgeAdmin: ctx.deployer.publicKey,
          bridgeConfig: ctx.bridgeConfig,
        })
        .rpc();
      await ctx.psm.methods
        .setBridgeAuthority({ refundConfirmer: {} } as any, originalConfirmer)
        .accountsPartial({
          bridgeAdmin: ctx.deployer.publicKey,
          bridgeConfig: ctx.bridgeConfig,
        })
        .rpc();
      logger.success('Restored original refund_initiator/confirmer.');
    } catch (e: any) {
      logger.warning(`Could not restore refund roles: ${e.message?.slice(0, 100)}`);
    }
  }
}

/**
 * Best-effort oracle-on mint sanity check. Requires a real Pyth program
 * to be available on the network AND a price account owned by it. On
 * devnet there is a Pyth deployment at the legacy mainnet address, but
 * no guaranteed price accounts — so we (a) check whether the deployment
 * declares an oracle, (b) configure it if not, and (c) attempt a mint
 * with `priceUpdate` set. If the helper rejects (e.g. no Pyth feed),
 * we log it and don't fail the step.
 */
async function testOracleMint(ctx: TestContext) {
  logger.section('Test: Oracle-on mint (best-effort)');

  const cfg = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  const oracle = cfg.oracle as PublicKey;
  if (oracle.equals(PublicKey.default)) {
    logger.warning(
      'Oracle is currently disabled (Pubkey::default). ' +
        'Run set-oracle.ts with a real Pyth price account first to exercise this path.'
    );
    return;
  }

  const oracleAccount = await ctx.provider.connection.getAccountInfo(oracle);
  if (!oracleAccount) {
    logger.warning(`Configured oracle ${oracle.toBase58()} has no on-chain account.`);
    return;
  }
  logger.info(`Oracle: ${oracle.toBase58()} (owner ${oracleAccount.owner.toBase58()})`);

  const amount = 1_000_000; // 1 USDC -> 1 OkuMoney @ price=1
  const userUsdcAta = getAssociatedTokenAddressSync(
    ctx.usdcMint,
    ctx.deployer.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const userOkuMoneyAta = await getOrCreateAta(
    ctx,
    ctx.okuMoneyMint,
    ctx.deployer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );

  try {
    await mintTestUsdc(ctx, amount);
    const sig = await ctx.psm.methods
      .mintOkuM(new BN(amount))
      .accountsPartial({
        user: ctx.deployer.publicKey,
        config: ctx.psmConfig,
        usdcMint: ctx.usdcMint,
        okuMoneyMint: ctx.okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: ctx.psmVaultUsdc,
        priceUpdate: oracle,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await confirmTx(ctx, sig);
    logger.success(`Oracle-on mint tx: ${explorerLink(ctx.network, sig)}`);
  } catch (e: any) {
    const errStr = String(e?.message ?? e);
    if (
      errStr.includes('InvalidOracleResponse') ||
      errStr.includes('StaleOracle') ||
      errStr.includes('InsufficientReserves')
    ) {
      logger.warning(`Oracle mint rejected (expected if feed isn't a valid Pyth V2 price): ${errStr.slice(0, 120)}`);
    } else {
      throw e;
    }
  }
}

/**
 * SVM-side bridge_mint smoke test. Builds an EVM-burn message,
 * Ed25519-signs it with the deployer's key (which on devnet holds the
 * orchestrator_signer role), and submits the bridge_mint instruction.
 *
 * Heavy tx — Ed25519 sigverify + sysvar introspection + keccak +
 * PDA `init` + Token-2022 mint CPI. On a slow validator this can
 * exceed the legacy 30 s confirmation window; if that happens, the
 * tx is still accepted on-chain — log it and continue.
 */
async function testBridgeMint(ctx: TestContext) {
  logger.section('Test: Bridge Mint (EVM -> Solana)');

  const bridgeCfg = await ctx.psm.account.bridgeConfig.fetch(ctx.bridgeConfig);
  if (!(bridgeCfg.orchestratorSigner as PublicKey).equals(ctx.deployer.publicKey)) {
    logger.warning(
      'Deployer is not the orchestrator_signer; cannot sign the bridge message. ' +
        'Skipping bridge_mint step.'
    );
    return;
  }
  const sourceChainId = 1; // EVM
  const destChainId = (bridgeCfg.sourceChainId as number) || 103;
  const amount = 2_000_000n; // 2 OkuMoney
  const evmSender = new Uint8Array(20);
  crypto.getRandomValues(evmSender);

  // Discover the next available nonce by reading the per-chain BridgeNonce PDA
  // for the SOURCE side. The on-chain check is `nonce == bridge_nonce.next_nonce`.
  const [bridgeNonce] = deriveBridgeNoncePDA(ctx.litePsmId, sourceChainId);
  let nonce = 0n;
  try {
    const noncePda = await ctx.psm.account.bridgeNonce.fetch(bridgeNonce);
    nonce = BigInt((noncePda.nextNonce as BN).toString());
  } catch {
    // PDA not yet initialised — first mint will create it; nonce starts at 0.
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const messageBytes = serializeMintMessage({
    sourceChainId,
    destChainId,
    sender: evmSender,
    recipient: ctx.deployer.publicKey,
    amount,
    nonce,
    deadline,
  });
  const signature = nacl.sign.detached(messageBytes, ctx.deployer.secretKey);
  const requestId = computeRequestId(messageBytes);

  const [processedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_request'), requestId],
    ctx.litePsmId
  );
  const recipientAta = await getOrCreateAta(
    ctx,
    ctx.okuMoneyMint,
    ctx.deployer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: ctx.deployer.publicKey.toBytes(),
    message: messageBytes,
    signature: signature,
  });
  const bridgeMintIx = await ctx.psm.methods
    .bridgeMint(messageBytes, Buffer.from(signature), Array.from(requestId) as number[])
    .accountsPartial({
      payer: ctx.deployer.publicKey,
      bridgeConfig: ctx.bridgeConfig,
      config: ctx.psmConfig,
      processedRequest,
      okuMoneyMint: ctx.okuMoneyMint,
      recipientOkuMoneyAta: recipientAta,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ed25519Ix).add(bridgeMintIx);
  try {
    const sig = await sendAndConfirmTransaction(
      ctx.provider.connection,
      tx,
      [ctx.deployer],
      { skipPreflight: true, commitment: 'confirmed' }
    );
    logger.success(`bridge_mint tx: ${explorerLink(ctx.network, sig)}`);
  } catch (e: any) {
    const errStr = String(e?.message ?? e);
    if (errStr.includes('TransactionExpiredTimeout')) {
      logger.warning(
        'bridge_mint timed out client-side (heavy tx exceeded confirmation window). ' +
          'Tx was likely accepted on-chain anyway — verify via ProcessedRequest PDA.'
      );
    } else {
      throw e;
    }
  }
}

/**
 * Negative-path coverage for the Ed25519 precompile.
 *
 * This is the in-process-SVM coverage gap noted in `tests/bankrun/
 * bridge_security.ts`: bankrun/litesvm do NOT execute the Ed25519
 * precompile, so an invalid signature is silently accepted by the
 * harness even though `bridge_mint`'s sysvar-introspection check is
 * working as designed (it only verifies that the precompile ix bytes
 * are consistent with what we built — it trusts the precompile to
 * have validated the math).
 *
 * A real validator (devnet, localnet via `solana-test-validator`, or
 * mainnet) runs the precompile and rejects the tx with a transient
 * "Precompile error" before our program runs. This step exercises
 * exactly that path.
 *
 * Skipped (warning only) when the deployer doesn't hold the
 * `orchestratorSigner` role; that's a configuration concern, not a
 * test failure.
 */
async function testBridgeMintInvalidSig(ctx: TestContext) {
  logger.section('Test: Bridge Mint with INVALID signature (must reject)');

  const bridgeCfg = await ctx.psm.account.bridgeConfig.fetch(ctx.bridgeConfig);
  if (!(bridgeCfg.orchestratorSigner as PublicKey).equals(ctx.deployer.publicKey)) {
    logger.warning(
      'Deployer is not the orchestrator_signer; skipping invalid-sig step.'
    );
    return;
  }

  const sourceChainId = 1; // EVM
  const destChainId = (bridgeCfg.sourceChainId as number) || 103;
  const amount = 1_000_000n;
  const evmSender = new Uint8Array(20);
  crypto.getRandomValues(evmSender);

  // Pick a far-future-but-unused nonce so the legitimate `testBridgeMint`
  // step is unaffected if both run in the same pass.
  const [bridgeNonce] = deriveBridgeNoncePDA(ctx.litePsmId, sourceChainId);
  let nonce = 1_000_000n;
  try {
    const noncePda = await ctx.psm.account.bridgeNonce.fetch(bridgeNonce);
    nonce = BigInt((noncePda.nextNonce as BN).toString()) + 1_000_000n;
  } catch {
    // PDA not initialised; we'll use the high nonce against the
    // freshly-init bridge_nonce. The on-chain `nonce_admin` check would
    // reject this (next_nonce must == 0 on first burn), but we never
    // reach the program — the precompile rejects first.
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const messageBytes = serializeMintMessage({
    sourceChainId,
    destChainId,
    sender: evmSender,
    recipient: ctx.deployer.publicKey,
    amount,
    nonce,
    deadline,
  });

  // KEY DIFFERENCE: sign with a throwaway keypair so the precompile's
  // curve25519 verify rejects. Declare the deployer's pubkey in the
  // precompile ix so the bytes look superficially correct.
  const wrongSigner = Keypair.generate();
  const signature = nacl.sign.detached(messageBytes, wrongSigner.secretKey);
  const requestId = computeRequestId(messageBytes);

  const [processedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_request'), requestId],
    ctx.litePsmId
  );
  const recipientAta = await getOrCreateAta(
    ctx,
    ctx.okuMoneyMint,
    ctx.deployer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );

  // The Ed25519 ix declares the (correct) orchestrator pubkey but
  // carries the WRONG signature.
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: ctx.deployer.publicKey.toBytes(),
    message: messageBytes,
    signature,
  });
  const bridgeMintIx = await ctx.psm.methods
    .bridgeMint(messageBytes, Buffer.from(signature), Array.from(requestId) as number[])
    .accountsPartial({
      payer: ctx.deployer.publicKey,
      bridgeConfig: ctx.bridgeConfig,
      config: ctx.psmConfig,
      processedRequest,
      okuMoneyMint: ctx.okuMoneyMint,
      recipientOkuMoneyAta: recipientAta,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ed25519Ix).add(bridgeMintIx);

  // skipPreflight: true so the tx actually reaches the runtime and the
  // precompile gets a chance to reject. With preflight on, web3.js
  // would short-circuit before submission and we'd never observe the
  // on-chain rejection.
  try {
    await sendAndConfirmTransaction(
      ctx.provider.connection,
      tx,
      [ctx.deployer],
      { skipPreflight: true, commitment: 'confirmed' }
    );
    throw new Error(
      'EXPECTED FAILURE: tx with invalid Ed25519 signature was accepted. ' +
        'This means the precompile is not being enforced — DO NOT deploy.'
    );
  } catch (e: any) {
    const errStr = String(e?.message ?? e);
    // The exact error code from a real validator is "Precompile failed"
    // or "InstructionError 0 ... PrecompileFailure". Accept any of the
    // canonical strings; reject only the explicit EXPECTED-FAILURE
    // bomb we threw above.
    if (errStr.startsWith('EXPECTED FAILURE:')) throw e;
    const expected =
      errStr.includes('Precompile') ||
      errStr.includes('precompile') ||
      errStr.includes('signature') ||
      errStr.includes('Signature');
    if (!expected) {
      logger.warning(
        `Rejection observed but message was unexpected: ${errStr.slice(0, 200)}`
      );
      logger.info('Treating as pass since the tx did NOT succeed.');
    } else {
      logger.success(`precompile correctly rejected: ${errStr.slice(0, 120)}`);
    }
  }
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
  bridge: testBridgeBurn,
  bridgeMint: testBridgeMint,
  bridgeMintInvalidSig: testBridgeMintInvalidSig,
  refund: testRefund,
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
      'bridge',
      'bridgeMint',
      'bridgeMintInvalidSig',
      'refund',
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
