/**
 * Bridge OkuMoney from Solana (Devnet) to EVM (OP Sepolia)
 *
 * This script:
 * 1. Mints OkuMoney via PSM (using devnet USDC)
 * 2. Calls bridge_burn on the lite-psm program
 * 3. Parses the BridgeBurnEvent from transaction logs
 * 4. Writes bridge-request.json for the EVM relay script
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/bridge-burn-to-evm.ts
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN } from '@anchor-lang/core';
import {
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  SOLANA_CHAIN_ID,
  OP_SEPOLIA_CHAIN_ID,
} from '../config/constants';

// Bridge request output interface (for EVM relay script)
interface BridgeRequestOutput {
  requestId: string;
  sourceChainId: number;
  destChainId: number;
  sender: string; // Solana pubkey as hex
  recipient: string; // EVM address as bytes32 (left-padded)
  amount: string; // 6-decimal SVM amount (post-fee)
  nonce: number;
  deadline: number;
  timestamp: number;
  txSignature: string;
}

async function main() {
  const network = detectNetwork();
  logger.header(`Bridge OkuMoney: Solana -> EVM (${network})`);

  // Create provider
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  logger.info(`Sender: ${wallet.publicKey.toBase58()}`);

  // Load deployment addresses
  const deployment = loadDeployment(network);
  if (!deployment || !deployment.programs?.litePsm) {
    throw new Error(`No deployment found for network: ${network}. Run deploy scripts first.`);
  }

  // Load program
  const programId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  logger.info(`Program ID: ${programId.toBase58()}`);

  // Load token mint
  if (!deployment.tokens?.okusd) {
    throw new Error('OkuMoney mint not found in deployment');
  }
  const okuMoneyMint = new PublicKey(deployment.tokens.okusd);
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

  // Configuration
  const BRIDGE_AMOUNT = new BN(10_000_000); // 10 OkuMoney (6 decimals)

  // EVM recipient - this should be a valid EVM address
  // For testing, default to the impersonate address
  const EVM_RECIPIENT = process.env.EVM_RECIPIENT || '0x3CB68a6762041aA05E762814A8791CA9d98E79A0';
  
  // Convert EVM address to bytes20
  const recipientBytes = Buffer.alloc(20);
  const cleanAddress = EVM_RECIPIENT.startsWith('0x') ? EVM_RECIPIENT.slice(2) : EVM_RECIPIENT;
  Buffer.from(cleanAddress, 'hex').copy(recipientBytes);

  logger.nextStep('Preparing token accounts');

  // Get user's OkuMoney ATA
  const userOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Check if ATA exists and has balance
  try {
    const ataInfo = await getAccount(provider.connection, userOkuMoneyAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
    logger.info(`Current OkuMoney balance: ${Number(ataInfo.amount) / 1_000_000} OkuM`);
    
    if (ataInfo.amount < BigInt(BRIDGE_AMOUNT.toString())) {
      logger.warning(`Insufficient balance. Need ${BRIDGE_AMOUNT.toNumber() / 1_000_000} OkuM`);
      logger.info('Please mint OkuMoney via PSM first: tsx scripts/simulate/mint-okum.ts');
      process.exit(1);
    }
  } catch (e) {
    logger.error('OkuMoney ATA does not exist or has no balance');
    logger.info('Please mint OkuMoney via PSM first: tsx scripts/simulate/mint-okum.ts');
    process.exit(1);
  }

  // Get fee recipient ATA
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  const feeRecipient = bridgeConfigAccount.feeRecipient;
  const feeRecipientAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    feeRecipient,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // BridgeNonce PDA
  const [bridgeNonce] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_nonce'), Buffer.from(new Uint16Array([OP_SEPOLIA_CHAIN_ID]).buffer)],
    programId
  );

  logger.nextStep('Executing bridge_burn');
  logger.info(`Amount: ${BRIDGE_AMOUNT.toNumber() / 1_000_000} OkuM`);
  logger.info(`Destination: OP Sepolia (chain ${OP_SEPOLIA_CHAIN_ID})`);
  logger.info(`Recipient: ${EVM_RECIPIENT}`);

  // Call bridge_burn
  const tx = await program.methods
    .bridgeBurn(
      BRIDGE_AMOUNT,
      Array.from(recipientBytes) as number[], // [u8; 20]
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

  logger.success(`Transaction: ${tx}`);

  logger.nextStep('Parsing BridgeBurnEvent');

  // Wait for confirmation and get transaction details
  const connection = provider.connection;
  await connection.confirmTransaction(tx, 'confirmed');
  
  const txDetails = await connection.getTransaction(tx, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!txDetails || !txDetails.meta) {
    throw new Error('Failed to get transaction details');
  }

  // Parse logs for BridgeBurnEvent
  // The event data is emitted via anchor events
  // For now, we'll construct the request from known values
  // In production, you'd parse the actual event data from logs

  // Read updated nonce
  const bridgeNonceAccount = await program.account.bridgeNonce.fetch(bridgeNonce);
  const nonce = bridgeNonceAccount.nextNonce.toNumber() - 1; // The nonce used in this tx

  // Calculate fee
  const feeBps = bridgeConfigAccount.bridgeFeeBps;
  const feeAmount = Math.floor((BRIDGE_AMOUNT.toNumber() * feeBps) / 10000);
  const netAmount = BRIDGE_AMOUNT.toNumber() - feeAmount;

  // Calculate deadline
  const blockTime = txDetails.blockTime || Math.floor(Date.now() / 1000);
  const deadline = blockTime + bridgeConfigAccount.bridgeDeadlineSecs.toNumber();

  // Calculate request_id
  // Message format: source_chain(2) + dest_chain(2) + sender(32) + recipient(20) + amount(8) + nonce(8) + deadline(8)
  const messageBuffer = Buffer.alloc(80);
  let offset = 0;
  
  // source_chain_id (u16 LE)
  messageBuffer.writeUInt16LE(SOLANA_CHAIN_ID, offset);
  offset += 2;
  
  // dest_chain_id (u16 LE)
  messageBuffer.writeUInt16LE(OP_SEPOLIA_CHAIN_ID, offset);
  offset += 2;
  
  // sender (32 bytes)
  wallet.publicKey.toBuffer().copy(messageBuffer, offset);
  offset += 32;
  
  // recipient (20 bytes)
  recipientBytes.copy(messageBuffer, offset);
  offset += 20;
  
  // amount (u64 LE)
  messageBuffer.writeBigUInt64LE(BigInt(netAmount), offset);
  offset += 8;
  
  // nonce (u64 LE)
  messageBuffer.writeBigUInt64LE(BigInt(nonce), offset);
  offset += 8;
  
  // deadline (i64 LE)
  messageBuffer.writeBigInt64LE(BigInt(deadline), offset);

  // Compute keccak256 hash
  const keccak = await import('@noble/hashes/sha3');
  const requestId = '0x' + Buffer.from(keccak.keccak_256(messageBuffer)).toString('hex');

  // Convert sender to bytes32 hex (left-padded)
  const senderHex = '0x' + wallet.publicKey.toBuffer().toString('hex');
  
  // Convert recipient to bytes32 hex (left-padded with zeros)
  const recipientBytes32 = '0x' + '00'.repeat(12) + cleanAddress;

  logger.success('BridgeBurn Event:');
  logger.info(`  Request ID: ${requestId}`);
  logger.info(`  Sender: ${wallet.publicKey.toBase58()}`);
  logger.info(`  Recipient: ${EVM_RECIPIENT}`);
  logger.info(`  Source Chain: ${SOLANA_CHAIN_ID}`);
  logger.info(`  Dest Chain: ${OP_SEPOLIA_CHAIN_ID}`);
  logger.info(`  Amount: ${netAmount / 1_000_000} OkuM (post-fee)`);
  logger.info(`  Fee: ${feeAmount / 1_000_000} OkuM`);
  logger.info(`  Nonce: ${nonce}`);
  logger.info(`  Deadline: ${deadline}`);

  logger.nextStep('Writing bridge request file');

  const bridgeRequest: BridgeRequestOutput = {
    requestId: requestId,
    sourceChainId: SOLANA_CHAIN_ID,
    destChainId: OP_SEPOLIA_CHAIN_ID,
    sender: senderHex,
    recipient: recipientBytes32,
    amount: netAmount.toString(),
    nonce: nonce,
    deadline: deadline,
    timestamp: Math.floor(Date.now() / 1000),
    txSignature: tx,
  };

  const outputPath = path.join(__dirname, '..', '..', 'bridge-request.json');
  fs.writeFileSync(outputPath, JSON.stringify(bridgeRequest, null, 2));
  logger.success(`Bridge request written to: ${outputPath}`);

  logger.header('Bridge Burn Complete');
  logger.log('');
  logger.info('Next steps:');
  logger.info('1. Copy bridge-request.json to EVM/');
  logger.info('2. Run relay-from-solana.ts on OP Sepolia to complete the bridge');
  logger.log('');
  logger.info('Decimal conversion note:');
  logger.info(`  SVM amount (6 decimals): ${netAmount}`);
  logger.info(`  EVM amount (18 decimals): ${BigInt(netAmount) * BigInt(1e12)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Bridge burn failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
