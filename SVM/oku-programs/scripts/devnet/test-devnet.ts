#!/usr/bin/env tsx
/**
 * scripts/devnet/test-devnet.ts
 *
 * Real on-chain interaction tests (works on both localnet and devnet).
 * Each step sends actual transactions and verifies results.
 *
 * Usage:
 *   NETWORK=localnet tsx scripts/devnet/test-devnet.ts              # Localnet (fast iteration)
 *   NETWORK=devnet   tsx scripts/devnet/test-devnet.ts              # Devnet (real chain)
 *   NETWORK=devnet   tsx scripts/devnet/test-devnet.ts --step=mint  # Single step
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

import { detectNetwork, createProvider } from '../utils/network';
import { NetworkName } from '../config/networks';
import { logger } from '../utils/logger';
import { loadDeployment, DeploymentAddresses } from '../utils/addressBook';
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
  okusdMint: PublicKey;
  wokusdMint: PublicKey;
  // PDAs
  psmConfig: PublicKey;
  redemptionQueue: PublicKey;
  vaultConfig: PublicKey;
  bridgeConfig: PublicKey;
  psmVaultUsdc: PublicKey;
  psmOkusdEscrow: PublicKey;
  vaultOkusd: PublicKey;
  // Program IDs
  litePsmId: PublicKey;
  wokusdVaultId: PublicKey;
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
  if (network === 'mainnet-beta') {
    throw new Error('This test script is not intended for mainnet. Use localnet or devnet.');
  }

  const provider = createProvider(network);
  const deployer = provider.wallet.payer as unknown as Keypair;

  const deployment = loadDeployment(network);
  if (!deployment) {
    throw new Error(`No deployment found. Run \`npm run deploy:${network}\` first.`);
  }

  // Load IDLs
  const psmIdlPath = path.join(process.cwd(), 'target/idl/lite_psm.json');
  const vaultIdlPath = path.join(process.cwd(), 'target/idl/wokusd_vault.json');

  if (!fs.existsSync(psmIdlPath) || !fs.existsSync(vaultIdlPath)) {
    throw new Error('IDL files not found. Run `anchor build` first.');
  }

  const psmIdl = JSON.parse(fs.readFileSync(psmIdlPath, 'utf-8'));
  const vaultIdl = JSON.parse(fs.readFileSync(vaultIdlPath, 'utf-8'));

  const litePsmId = new PublicKey(deployment.programs.litePsm!);
  const wokusdVaultId = new PublicKey(deployment.programs.wokusdVault!);

  const psm = new Program(psmIdl, litePsmId, provider);
  const vault = new Program(vaultIdl, wokusdVaultId, provider);

  // Mints
  const usdcMint = new PublicKey(deployment.tokens.usdc!);
  const okusdMint = new PublicKey(deployment.tokens.okusd!);
  const wokusdMint = new PublicKey(deployment.tokens.wokusd!);

  // PDAs
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);
  const [vaultConfig] = deriveVaultConfigPDA(wokusdVaultId);
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const psmVaultUsdc = deployment.pdas.psmVaultUsdc
    ? new PublicKey(deployment.pdas.psmVaultUsdc)
    : getAssociatedTokenAddressSync(usdcMint, psmConfig, true, TOKEN_PROGRAM_ID);

  const psmOkusdEscrow = deployment.pdas.psmOkusdEscrow
    ? new PublicKey(deployment.pdas.psmOkusdEscrow)
    : getAssociatedTokenAddressSync(okusdMint, psmConfig, true, TOKEN_2022_PROGRAM_ID);

  const vaultOkusd = deployment.pdas.vaultOkusd
    ? new PublicKey(deployment.pdas.vaultOkusd)
    : getAssociatedTokenAddressSync(okusdMint, vaultConfig, true, TOKEN_2022_PROGRAM_ID);

  return {
    network,
    provider,
    deployer,
    deployment,
    psm,
    vault,
    usdcMint,
    okusdMint,
    wokusdMint,
    psmConfig,
    redemptionQueue,
    vaultConfig,
    bridgeConfig,
    psmVaultUsdc,
    psmOkusdEscrow,
    vaultOkusd,
    litePsmId,
    wokusdVaultId,
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
      'OkuUSD Mint': (config.okusdMint as PublicKey).toBase58(),
      'Vault USDC': (config.vaultUsdc as PublicKey).toBase58(),
      'Vault OkuUSD': (config.vaultOkusd as PublicKey).toBase58(),
      'Max Supply': fmtAmount(Number(config.maxSupply)),
      'Minter Allowance': fmtAmount(Number(config.minterAllowance)),
      'Is Paused': String(config.isPaused),
      'Oracle': (config.oracle as PublicKey).toBase58(),
      'Staleness Threshold': `${config.stalenessThreshold}s`,
      'Current Rate BPS': String(config.currentRateBps),
    });
  } catch (e: any) {
    logger.error(`Failed to fetch PSM config: ${e.message}`);
  }

  // Redemption Queue
  logger.log('');
  logger.info('Fetching Redemption Queue...');
  try {
    const queue = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueue);
    logger.success('Redemption Queue:');
    logger.table({
      'Head': String(queue.head),
      'Tail': String(queue.tail),
      'Pending': String(Number(queue.tail) - Number(queue.head)),
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

  // Vault Config
  logger.log('');
  logger.info('Fetching Vault Config...');
  try {
    const vc = await ctx.vault.account.vaultConfig.fetch(ctx.vaultConfig);
    logger.success('Vault Config:');
    logger.table({
      'Role Admin': (vc.roleAdmin as PublicKey).toBase58(),
      'Pauser': (vc.pauser as PublicKey).toBase58(),
      'Unpauser': (vc.unpauser as PublicKey).toBase58(),
      'OkuUSD Mint': (vc.okusdMint as PublicKey).toBase58(),
      'wOkuUSD Mint': (vc.wokusdMint as PublicKey).toBase58(),
      'Vault OkuUSD': (vc.vaultOkusd as PublicKey).toBase58(),
      'Total Shares': fmtAmount(Number(vc.totalShares)),
      'Is Paused': String(vc.isPaused),
    });
  } catch (e: any) {
    logger.error(`Failed to fetch vault config: ${e.message}`);
  }

  // Token balances
  logger.log('');
  logger.info('Deployer token balances:');
  const usdcBal = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okusdBal = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const wokusdBal = await getTokenBalance(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const solBal = await ctx.provider.connection.getBalance(ctx.deployer.publicKey);
  logger.table({
    'SOL': (solBal / LAMPORTS_PER_SOL).toFixed(4),
    'USDC': fmtAmount(usdcBal),
    'OkuUSD': fmtAmount(okusdBal),
    'wOkuUSD': fmtAmount(wokusdBal),
  });
}

/**
 * Mint USDC -> OkuUSD via PSM
 */
async function testMint(ctx: TestContext) {
  logger.section('Test: Mint OkuUSD');

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
  const okusdBefore = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - USDC: ${fmtAmount(usdcBefore)}, OkuUSD: ${fmtAmount(okusdBefore)}`);

  // 4. Ensure ATAs exist (pre-create OkuUSD ATA to avoid init_if_needed CPI corruption)
  const userUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.deployer.publicKey, false, TOKEN_PROGRAM_ID);
  const userOkusdAta = await getOrCreateAta(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);

  // 5. Call PSM mint
  logger.info(`Calling psm.mint(${amount / 1_000_000} USDC)...`);
  const sig = await ctx.psm.methods
    .mint(new BN(amount))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      usdcMint: ctx.usdcMint,
      okusdMint: ctx.okusdMint,
      userUsdcAta,
      userOkusdAta,
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
  const okusdAfter = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - USDC: ${fmtAmount(usdcAfter)}, OkuUSD: ${fmtAmount(okusdAfter)}`);
  logger.success(`Minted ${fmtAmount(okusdAfter - okusdBefore)} OkuUSD`);
}

/**
 * Transfer OkuUSD to a new recipient
 */
async function testTransfer(ctx: TestContext) {
  logger.section('Test: Transfer OkuUSD');

  const transferAmount = 10_000_000; // 10 OkuUSD

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

  // 3. Create recipient OkuUSD ATA (deployer pays)
  const recipientAta = await getOrCreateAta(ctx, ctx.okusdMint, recipient.publicKey, TOKEN_2022_PROGRAM_ID);

  // 4. Transfer via Token-2022
  const senderAta = getAssociatedTokenAddressSync(
    ctx.okusdMint,
    ctx.deployer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(`Transferring ${transferAmount / 1_000_000} OkuUSD...`);
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
  const senderBal = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const recipientBal = await getTokenBalance(ctx, ctx.okusdMint, recipient.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Sender OkuUSD: ${fmtAmount(senderBal)}`);
  logger.info(`Recipient OkuUSD: ${fmtAmount(recipientBal)}`);
  logger.success('Transfer verified');
}

/**
 * Update interest rate (rebase)
 */
async function testRebase(ctx: TestContext) {
  logger.section('Test: Update Interest Rate (Rebase)');

  const newRate = 450; // 4.5% APY

  // 1. Read current rate
  const configBefore = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  logger.info(`Current rate: ${configBefore.currentRateBps} bps`);

  // 2. Update rate
  logger.info(`Setting interest rate to ${newRate} bps (${newRate / 100}% APY)...`);
  const sig = await ctx.psm.methods
    .updateInterestRate(newRate)
    .accountsPartial({
      rebaser: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      okusdMint: ctx.okusdMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Rate update tx: ${explorerLink(ctx.network, sig)}`);

  // 3. Verify config
  const configAfter = await ctx.psm.account.psmConfig.fetch(ctx.psmConfig);
  logger.info(`New config rate: ${configAfter.currentRateBps} bps`);

  // 4. Read mint interest rate extension
  try {
    const mintInfo = await getMint(
      ctx.provider.connection,
      ctx.okusdMint,
      'confirmed',
      TOKEN_2022_PROGRAM_ID
    );
    logger.info(`Mint supply: ${fmtAmount(Number(mintInfo.supply))}`);
    logger.success(`Interest rate updated to ${newRate} bps`);
  } catch (e: any) {
    logger.warning(`Could not read mint extensions: ${e.message}`);
  }
}

/**
 * Wrap OkuUSD -> wOkuUSD
 */
async function testWrap(ctx: TestContext) {
  logger.section('Test: Wrap OkuUSD -> wOkuUSD');

  const wrapAmount = 50_000_000; // 50 OkuUSD

  // 1. Ensure ATAs exist
  const userOkusdAta = await getOrCreateAta(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const userWokusdAta = await getOrCreateAta(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);

  // 2. Get balances before
  const okusdBefore = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const wokusdBefore = await getTokenBalance(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  logger.info(`Before - OkuUSD: ${fmtAmount(okusdBefore)}, wOkuUSD: ${fmtAmount(wokusdBefore)}`);

  if (okusdBefore < BigInt(wrapAmount)) {
    logger.error(`Insufficient OkuUSD balance (${fmtAmount(okusdBefore)} < ${fmtAmount(wrapAmount)}). Run mint first.`);
    return;
  }

  // 3. Call vault.wrap
  logger.info(`Calling vault.wrap(${wrapAmount / 1_000_000} OkuUSD)...`);
  const sig = await ctx.vault.methods
    .wrap(new BN(wrapAmount))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.vaultConfig,
      okusdMint: ctx.okusdMint,
      wokusdMint: ctx.wokusdMint,
      userOkusdAta,
      userWokusdAta,
      vaultOkusd: ctx.vaultOkusd,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Wrap tx: ${explorerLink(ctx.network, sig)}`);

  // 4. Verify
  const okusdAfter = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const wokusdAfter = await getTokenBalance(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  logger.info(`After - OkuUSD: ${fmtAmount(okusdAfter)}, wOkuUSD: ${fmtAmount(wokusdAfter)}`);
  logger.success(`Wrapped ${fmtAmount(okusdBefore - okusdAfter)} OkuUSD -> ${fmtAmount(wokusdAfter - wokusdBefore)} wOkuUSD`);
}

/**
 * Unwrap wOkuUSD -> OkuUSD
 */
async function testUnwrap(ctx: TestContext) {
  logger.section('Test: Unwrap wOkuUSD -> OkuUSD');

  const unwrapShares = 25_000_000; // 25 wOkuUSD shares

  // 1. Ensure ATAs exist
  const userOkusdAta = await getOrCreateAta(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const userWokusdAta = await getOrCreateAta(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);

  // 2. Get balances before
  const okusdBefore = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const wokusdBefore = await getTokenBalance(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  logger.info(`Before - OkuUSD: ${fmtAmount(okusdBefore)}, wOkuUSD: ${fmtAmount(wokusdBefore)}`);

  if (wokusdBefore < BigInt(unwrapShares)) {
    logger.error(`Insufficient wOkuUSD balance (${fmtAmount(wokusdBefore)} < ${fmtAmount(unwrapShares)}). Run wrap first.`);
    return;
  }

  // 3. Call vault.unwrap
  logger.info(`Calling vault.unwrap(${unwrapShares / 1_000_000} shares)...`);
  const sig = await ctx.vault.methods
    .unwrap(new BN(unwrapShares))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.vaultConfig,
      okusdMint: ctx.okusdMint,
      wokusdMint: ctx.wokusdMint,
      userOkusdAta,
      userWokusdAta,
      vaultOkusd: ctx.vaultOkusd,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Unwrap tx: ${explorerLink(ctx.network, sig)}`);

  // 4. Verify
  const okusdAfter = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  const wokusdAfter = await getTokenBalance(ctx, ctx.wokusdMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  logger.info(`After - OkuUSD: ${fmtAmount(okusdAfter)}, wOkuUSD: ${fmtAmount(wokusdAfter)}`);
  logger.success(`Unwrapped ${fmtAmount(wokusdBefore - wokusdAfter)} wOkuUSD -> ${fmtAmount(okusdAfter - okusdBefore)} OkuUSD`);
}

/**
 * Redeem OkuUSD -> USDC (deposit buffer first, then redeem)
 */
async function testRedeem(ctx: TestContext) {
  logger.section('Test: Redeem OkuUSD -> USDC');

  const redeemAmount = 10_000_000; // 10 OkuUSD
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
  const okusdBefore = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - USDC: ${fmtAmount(usdcBefore)}, OkuUSD: ${fmtAmount(okusdBefore)}`);

  if (okusdBefore < BigInt(redeemAmount)) {
    logger.error(`Insufficient OkuUSD balance (${fmtAmount(okusdBefore)} < ${fmtAmount(redeemAmount)}). Run mint first.`);
    return;
  }

  // 3. Ensure ATAs
  const userUsdcAta = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.deployer.publicKey, true, TOKEN_PROGRAM_ID);
  const userOkusdAta = getAssociatedTokenAddressSync(ctx.okusdMint, ctx.deployer.publicKey, true, TOKEN_2022_PROGRAM_ID);

  // 4. Call PSM redeem
  logger.info(`Calling psm.redeem(${redeemAmount / 1_000_000} OkuUSD)...`);
  const sig = await ctx.psm.methods
    .redeem(new BN(redeemAmount))
    .accountsPartial({
      user: ctx.deployer.publicKey,
      config: ctx.psmConfig,
      redemptionQueue: ctx.redemptionQueue,
      usdcMint: ctx.usdcMint,
      okusdMint: ctx.okusdMint,
      userUsdcAta,
      userOkusdAta,
      vaultUsdc: ctx.psmVaultUsdc,
      vaultOkusd: ctx.psmOkusdEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Redeem tx: ${explorerLink(ctx.network, sig)}`);

  // 5. Verify
  const usdcAfter = await getTokenBalance(ctx, ctx.usdcMint, ctx.deployer.publicKey, TOKEN_PROGRAM_ID);
  const okusdAfter = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - USDC: ${fmtAmount(usdcAfter)}, OkuUSD: ${fmtAmount(okusdAfter)}`);
  logger.success(`Redeemed ${fmtAmount(okusdBefore - okusdAfter)} OkuUSD -> ${fmtAmount(usdcAfter - usdcBefore)} USDC`);
}

/**
 * Bridge burn OkuUSD (Solana -> EVM)
 */
async function testBridgeBurn(ctx: TestContext) {
  logger.section('Test: Bridge Burn (Solana -> EVM)');

  const burnAmount = 5_000_000; // 5 OkuUSD
  const destinationChainId = 1; // Ethereum mainnet
  const evmRecipient = Buffer.alloc(20);
  evmRecipient.write('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');

  // 1. Derive bridge nonce PDA for destination chain
  const [bridgeNonce] = deriveBridgeNoncePDA(ctx.litePsmId, destinationChainId);

  // 2. Get balances before
  const okusdBefore = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`Before - OkuUSD: ${fmtAmount(okusdBefore)}`);

  if (okusdBefore < BigInt(burnAmount)) {
    logger.error(`Insufficient OkuUSD balance (${fmtAmount(okusdBefore)} < ${fmtAmount(burnAmount)}). Run mint first.`);
    return;
  }

  // 3. Ensure fee recipient ATA exists
  const feeRecipient = ctx.deployer.publicKey; // On devnet, deployer is fee recipient
  const feeRecipientAta = await getOrCreateAta(ctx, ctx.okusdMint, feeRecipient, TOKEN_2022_PROGRAM_ID);

  // 4. Ensure user OkuUSD ATA
  const userOkusdAta = getAssociatedTokenAddressSync(
    ctx.okusdMint,
    ctx.deployer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // 5. Call bridge_burn
  logger.info(`Calling psm.bridgeBurn(${burnAmount / 1_000_000} OkuUSD, chain=${destinationChainId})...`);
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
      okusdMint: ctx.okusdMint,
      userOkusdAta,
      feeRecipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();
  await confirmTx(ctx, sig);
  logger.success(`Bridge burn tx: ${explorerLink(ctx.network, sig)}`);

  // 6. Verify
  const okusdAfter = await getTokenBalance(ctx, ctx.okusdMint, ctx.deployer.publicKey, TOKEN_2022_PROGRAM_ID);
  logger.info(`After - OkuUSD: ${fmtAmount(okusdAfter)}`);
  logger.success(`Burned ${fmtAmount(okusdBefore - okusdAfter)} OkuUSD for bridge to chain ${destinationChainId}`);

  // 7. Read updated nonce
  try {
    const nonceAccount = await ctx.psm.account.bridgeNonce.fetch(bridgeNonce);
    logger.info(`Bridge nonce for chain ${destinationChainId}: ${nonceAccount.nextNonce}`);
  } catch (e: any) {
    logger.warning(`Could not read nonce: ${e.message}`);
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
  bridge: testBridgeBurn,
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
  logger.success(`Vault Program: ${ctx.wokusdVaultId.toBase58()}`, false);
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
    // Run all steps in order
    const stepOrder = ['state', 'mint', 'transfer', 'rebase', 'wrap', 'unwrap', 'redeem', 'bridge'];
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
