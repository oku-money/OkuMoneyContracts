#!/usr/bin/env tsx
/**
 * mint-and-bridge.ts
 *
 * Complete test flow on devnet-fork:
 * 1. Mint mock USDC to user
 * 2. Mint OkuMoney via PSM (USDC -> OkuM)
 * 3. Execute bridge_burn to EVM
 * 4. Output bridge request for relay
 *
 * Usage:
 *   NETWORK=devnet-fork npx tsx scripts/test/mint-and-bridge.ts
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN, Wallet } from '@anchor-lang/core';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  getMint,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  SOLANA_CHAIN_ID,
  OP_SEPOLIA_CHAIN_ID,
  PROGRAM_IDS,
} from '../config/constants';
import litePsmIdlRaw from '../../target/idl/lite_psm.json';

// Test configuration
const USDC_AMOUNT = 100_000_000; // 100 USDC (6 decimals)
const BRIDGE_AMOUNT = 50_000_000; // 50 OkuM to bridge

// Target EVM recipient
const EVM_RECIPIENT = process.env.EVM_RECIPIENT || '0x3CB68a6762041aA05E762814A8791CA9d98E79A0';

/**
 * Load IDL with correct program ID for the current network.
 */
function loadIdlForNetwork(idl: any, network: string, programKey: keyof typeof PROGRAM_IDS['localnet']): any {
  const programId = PROGRAM_IDS[network as keyof typeof PROGRAM_IDS]?.[programKey];
  if (!programId) {
    throw new Error(`No program ID found for ${programKey} on ${network}`);
  }
  return {
    ...idl,
    address: programId.toBase58(),
  };
}

async function main() {
  const network = detectNetwork();
  logger.header(`Mint & Bridge Test (${network})`);

  // Create provider (admin wallet for minting USDC)
  const adminProvider = createProvider(network);
  anchor.setProvider(adminProvider);

  const adminWallet = adminProvider.wallet as anchor.Wallet;
  logger.info(`Admin Wallet: ${adminWallet.publicKey.toBase58()}`);

  // Create a test user keypair (different from fee recipient to avoid constraint violation)
  const testUser = Keypair.generate();
  logger.info(`Test User: ${testUser.publicKey.toBase58()}`);

  // Fund test user with SOL
  logger.info('Funding test user with SOL...');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: adminWallet.publicKey,
      toPubkey: testUser.publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    })
  );
  await adminProvider.sendAndConfirm(fundTx, [], { commitment: 'confirmed' });
  logger.success('Funded test user with 0.1 SOL');

  // Create a user provider with the test keypair
  const userWallet = new Wallet(testUser);
  const userProvider = new anchor.AnchorProvider(
    adminProvider.connection,
    userWallet,
    { commitment: 'confirmed' }
  );

  // Use userWallet for subsequent operations
  const wallet = userWallet;

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment) {
    throw new Error(`No deployment found for network: ${network}`);
  }

  // Load program with correct ID - use userProvider for user actions
  const litePsmIdl = loadIdlForNetwork(litePsmIdlRaw, network, 'litePsm');
  const program = new Program(litePsmIdl as any, userProvider) as Program<LitePsm>;
  const programId = new PublicKey(deployment.programs.litePsm);

  // Token mints
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMoneyMint = new PublicKey(deployment.tokens.okusd);

  logger.info(`USDC Mint: ${usdcMint.toBase58()}`);
  logger.info(`OkuMoney Mint: ${okuMoneyMint.toBase58()}`);

  // PDAs
  const [psmConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('psm_config')],
    programId
  );
  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId
  );

  // ===========================================================================
  // Step 1: Mint mock USDC to user
  // ===========================================================================
  logger.nextStep('Step 1: Mint Mock USDC');

  // Get or create USDC ATA
  const userUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  const tx1 = new Transaction();

  // Create USDC ATA for test user (admin pays)
  logger.info(`Creating USDC ATA: ${userUsdcAta.toBase58()}`);
  tx1.add(
    createAssociatedTokenAccountInstruction(
      adminWallet.publicKey, // payer
      userUsdcAta,
      wallet.publicKey, // owner
      usdcMint,
      TOKEN_PROGRAM_ID
    )
  );

  // Mint USDC to test user (admin is mint authority)
  tx1.add(
    createMintToInstruction(
      usdcMint,
      userUsdcAta,
      adminWallet.publicKey, // mint authority
      BigInt(USDC_AMOUNT),
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const sig1 = await adminProvider.sendAndConfirm(tx1, [], { commitment: 'confirmed' });
  logger.success(`Minted ${USDC_AMOUNT / 1_000_000} USDC: ${sig1}`);

  // Verify balance
  const usdcInfo = await getAccount(userProvider.connection, userUsdcAta, 'confirmed', TOKEN_PROGRAM_ID);
  logger.info(`USDC balance: ${Number(usdcInfo.amount) / 1_000_000}`);

  // ===========================================================================
  // Step 2: Mint OkuMoney via PSM
  // ===========================================================================
  logger.nextStep('Step 2: Mint OkuMoney via PSM');

  // Get or create OkuMoney ATA
  const userOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Vault USDC account
  const vaultUsdc = getAssociatedTokenAddressSync(
    usdcMint,
    psmConfig,
    true, // PDA allowOwnerOffCurve
    TOKEN_PROGRAM_ID
  );

  // OkuMoney ATA will be created by mint instruction via init_if_needed

  logger.info(`Minting ${USDC_AMOUNT / 1_000_000} OkuMoney...`);

  // Call mint_oku_m
  const mintTx = await program.methods
    .mintOkuM(new BN(USDC_AMOUNT))
    .accountsPartial({
      user: wallet.publicKey,
      config: psmConfig,
      usdcMint: usdcMint,
      okuMoneyMint: okuMoneyMint,
      userUsdcAta: userUsdcAta,
      userOkuMoneyAta: userOkuMoneyAta,
      vaultUsdc: vaultUsdc,
      priceUpdate: null, // Oracle optional on devnet
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  logger.success(`Minted OkuMoney: ${mintTx}`);

  // Verify balance
  const okuInfo = await getAccount(userProvider.connection, userOkuMoneyAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  logger.info(`OkuMoney balance: ${Number(okuInfo.amount) / 1_000_000}`);

  // ===========================================================================
  // Step 3: Bridge burn to EVM
  // ===========================================================================
  logger.nextStep('Step 3: Bridge Burn to EVM');

  // Parse EVM recipient
  const recipientHex = EVM_RECIPIENT.replace('0x', '');
  const recipientBytes = Buffer.from(recipientHex, 'hex');

  // Bridge nonce PDA
  const [bridgeNonce] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_nonce'), Buffer.from(new Uint16Array([OP_SEPOLIA_CHAIN_ID]).buffer)],
    programId
  );

  // Fee recipient ATA
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  const feeRecipient = bridgeConfigAccount.feeRecipient;
  const feeRecipientAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    feeRecipient,
    true, // allowOwnerOffCurve for PDAs
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(`Bridging ${BRIDGE_AMOUNT / 1_000_000} OkuM to ${EVM_RECIPIENT}`);
  logger.info(`Destination: OP Sepolia (chain ${OP_SEPOLIA_CHAIN_ID})`);

  const bridgeTx = await program.methods
    .bridgeBurn(
      new BN(BRIDGE_AMOUNT),
      Array.from(recipientBytes) as number[],
      OP_SEPOLIA_CHAIN_ID
    )
    .accountsPartial({
      user: wallet.publicKey,
      bridgeConfig: bridgeConfig,
      config: psmConfig,
      bridgeNonce: bridgeNonce,
      okuMoneyMint: okuMoneyMint,
      userOkuMoneyAta: userOkuMoneyAta,
      feeRecipientAta: feeRecipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  logger.success(`Bridge burn: ${bridgeTx}`);

  // ===========================================================================
  // Step 4: Generate bridge request
  // ===========================================================================
  logger.nextStep('Step 4: Generate Bridge Request');

  // Wait for confirmation
  await userProvider.connection.confirmTransaction(bridgeTx, 'confirmed');
  
  const txDetails = await userProvider.connection.getTransaction(bridgeTx, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  // Read nonce
  const bridgeNonceAccount = await program.account.bridgeNonce.fetch(bridgeNonce);
  const nonce = bridgeNonceAccount.nextNonce.toNumber() - 1;

  // Calculate fee
  const feeBps = bridgeConfigAccount.bridgeFeeBps;
  const feeAmount = Math.floor((BRIDGE_AMOUNT * feeBps) / 10000);
  const netAmount = BRIDGE_AMOUNT - feeAmount;

  // Calculate deadline
  const blockTime = txDetails?.blockTime || Math.floor(Date.now() / 1000);
  const deadline = blockTime + bridgeConfigAccount.bridgeDeadlineSecs.toNumber();

  // Calculate request_id
  const messageBuffer = Buffer.alloc(80);
  let offset = 0;

  messageBuffer.writeUInt16LE(SOLANA_CHAIN_ID, offset);
  offset += 2;
  messageBuffer.writeUInt16LE(OP_SEPOLIA_CHAIN_ID, offset);
  offset += 2;
  wallet.publicKey.toBuffer().copy(messageBuffer, offset);
  offset += 32;
  recipientBytes.copy(messageBuffer, offset);
  offset += 20;
  messageBuffer.writeBigUInt64LE(BigInt(netAmount), offset);
  offset += 8;
  messageBuffer.writeBigUInt64LE(BigInt(nonce), offset);
  offset += 8;
  messageBuffer.writeBigInt64LE(BigInt(deadline), offset);

  const requestId = '0x' + Buffer.from(keccak_256(messageBuffer)).toString('hex');

  logger.success('Bridge Request:');
  logger.info(`  Request ID: ${requestId}`);
  logger.info(`  Sender: ${wallet.publicKey.toBase58()}`);
  logger.info(`  Recipient: ${EVM_RECIPIENT}`);
  logger.info(`  Amount: ${netAmount / 1_000_000} OkuM (post-fee)`);
  logger.info(`  Fee: ${feeAmount / 1_000_000} OkuM`);
  logger.info(`  Nonce: ${nonce}`);
  logger.info(`  Deadline: ${deadline}`);

  // Write bridge request file
  const bridgeRequest = {
    requestId,
    sourceChainId: SOLANA_CHAIN_ID,
    destChainId: OP_SEPOLIA_CHAIN_ID,
    sender: '0x' + wallet.publicKey.toBuffer().toString('hex'),
    recipient: '0x' + '00'.repeat(12) + recipientHex,
    amount: netAmount.toString(),
    nonce,
    deadline,
    timestamp: Math.floor(Date.now() / 1000),
    txSignature: bridgeTx,
  };

  const outputPath = path.join(__dirname, '..', '..', 'bridge-request.json');
  fs.writeFileSync(outputPath, JSON.stringify(bridgeRequest, null, 2));
  logger.success(`Bridge request saved: ${outputPath}`);

  // Final balances
  logger.nextStep('Final Balances');
  
  const finalUsdc = await getAccount(userProvider.connection, userUsdcAta, 'confirmed', TOKEN_PROGRAM_ID);
  const finalOku = await getAccount(userProvider.connection, userOkuMoneyAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  
  logger.info(`USDC: ${Number(finalUsdc.amount) / 1_000_000}`);
  logger.info(`OkuMoney: ${Number(finalOku.amount) / 1_000_000}`);

  logger.header('Test Complete');
  logger.info('Next: Copy bridge-request.json to EVM and run relay script');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Test failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
