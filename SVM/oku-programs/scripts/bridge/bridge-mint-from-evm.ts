/**
 * Mint OkuMoney on Solana from an EVM bridge request
 *
 * This script:
 * 1. Reads bridge request params from bridge-request.json
 * 2. Constructs the 80-byte bridge message
 * 3. Signs with Ed25519 (deployer keypair acting as orchestrator)
 * 4. Builds transaction with Ed25519 instruction + bridge_mint
 * 5. Verifies recipient ATA balance increased
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/bridge-mint-from-evm.ts
 *   NETWORK=devnet tsx scripts/bridge/bridge-mint-from-evm.ts --request=./custom-request.json
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import * as nacl from 'tweetnacl';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork, loadKeypair } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { SOLANA_CHAIN_ID } from '../config/constants';

// Bridge request from EVM (post-burn event data)
interface EVMBridgeRequest {
  requestId: string;
  sourceChainId: number; // EVM chain (e.g., 11155420 for OP Sepolia)
  destChainId: number; // Should be 103 (Solana Devnet)
  sender: string; // EVM address as hex
  recipient: string; // Solana pubkey as bytes32 hex (right-padded)
  amount: string; // 18-decimal EVM amount
  nonce: number;
  deadline: number;
}

async function main() {
  const network = detectNetwork();
  logger.header(`Bridge Mint: EVM -> Solana (${network})`);

  // Create provider
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  logger.info(`Orchestrator: ${wallet.publicKey.toBase58()}`);

  // Load addresses
  const addresses = loadDeployment(network);
  if (!addresses) {
    throw new Error(`No addresses found for network: ${network}`);
  }

  // Load program
  const programId = new PublicKey(addresses.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  // Load token mints
  const okuMoneyMint = new PublicKey(addresses.tokens.okusd);

  // PDAs
  const [psmConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('psm_config')],
    programId
  );
  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId
  );

  // Verify orchestrator is the authorized signer
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  if (!bridgeConfigAccount.orchestratorSigner.equals(wallet.publicKey)) {
    logger.warning(`Warning: Wallet is not the orchestrator signer`);
    logger.warning(`Orchestrator: ${bridgeConfigAccount.orchestratorSigner.toBase58()}`);
    logger.warning(`Wallet: ${wallet.publicKey.toBase58()}`);
    logger.warning(`The transaction will fail unless you are the orchestrator`);
  }

  // Load bridge request
  const requestArg = process.argv.find(arg => arg.startsWith('--request='));
  const requestFile = requestArg
    ? requestArg.split('=')[1]
    : path.join(__dirname, '..', '..', 'bridge-request.json');

  if (!fs.existsSync(requestFile)) {
    throw new Error(`Bridge request file not found: ${requestFile}`);
  }

  logger.info(`Loading bridge request from: ${requestFile}`);
  const evmRequest: EVMBridgeRequest = JSON.parse(fs.readFileSync(requestFile, 'utf-8'));

  // Convert 18-decimal EVM amount to 6-decimal SVM amount
  const evmAmount = BigInt(evmRequest.amount);
  const svmAmount = evmAmount / BigInt(1e12);

  logger.nextStep('Bridge Request Details');
  logger.info(`Source Chain: ${evmRequest.sourceChainId} (EVM)`);
  logger.info(`Dest Chain: ${evmRequest.destChainId} (Solana)`);
  logger.info(`Sender: ${evmRequest.sender}`);
  logger.info(`Recipient: ${evmRequest.recipient}`);
  logger.info(`EVM Amount (18 dec): ${evmRequest.amount}`);
  logger.info(`SVM Amount (6 dec): ${svmAmount.toString()}`);
  logger.info(`Nonce: ${evmRequest.nonce}`);
  logger.info(`Deadline: ${evmRequest.deadline}`);

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > evmRequest.deadline) {
    throw new Error(`Bridge request has expired. Deadline: ${evmRequest.deadline}, Now: ${now}`);
  }
  logger.info(`Time until deadline: ${evmRequest.deadline - now} seconds`);

  // Parse recipient Solana pubkey from bytes32
  // EVM packs EVM address in last 20 bytes, but for SVM->EVM, we have full pubkey in first 32 bytes
  // For EVM->SVM, recipient is Solana pubkey stored as bytes32
  const recipientHex = evmRequest.recipient.startsWith('0x')
    ? evmRequest.recipient.slice(2)
    : evmRequest.recipient;
  const recipientBytes = Buffer.from(recipientHex, 'hex');
  const recipientPubkey = new PublicKey(recipientBytes.slice(0, 32));
  logger.info(`Recipient Solana address: ${recipientPubkey.toBase58()}`);

  // Parse sender EVM address
  const senderHex = evmRequest.sender.startsWith('0x')
    ? evmRequest.sender.slice(2)
    : evmRequest.sender;
  const senderBytes = Buffer.from(senderHex.padStart(40, '0'), 'hex'); // 20 bytes

  // Get recipient ATA
  const recipientAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    recipientPubkey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Check if ATA exists
  let needsAta = false;
  try {
    await getAccount(provider.connection, recipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch (e) {
    needsAta = true;
    logger.info('Recipient ATA does not exist, will create');
  }

  // Check balance before
  let balanceBefore = BigInt(0);
  try {
    const ataInfo = await getAccount(provider.connection, recipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
    balanceBefore = ataInfo.amount;
  } catch (e) {
    // ATA doesn't exist, balance is 0
  }
  logger.info(`Recipient balance before: ${Number(balanceBefore) / 1_000_000} OkuM`);

  logger.nextStep('Constructing bridge message');

  // Construct 80-byte message (matching SVM BridgeRequest format)
  // Format: source_chain(2) + dest_chain(2) + sender(20) + recipient(32) + amount(8) + nonce(8) + deadline(8) = 80 bytes
  const messageBuffer = Buffer.alloc(80);
  let offset = 0;

  // source_chain_id (u16 LE)
  messageBuffer.writeUInt16LE(evmRequest.sourceChainId, offset);
  offset += 2;

  // destination_chain_id (u16 LE)
  messageBuffer.writeUInt16LE(evmRequest.destChainId, offset);
  offset += 2;

  // sender (20 bytes - EVM address)
  senderBytes.copy(messageBuffer, offset);
  offset += 20;

  // recipient (32 bytes - Solana pubkey)
  recipientPubkey.toBuffer().copy(messageBuffer, offset);
  offset += 32;

  // amount (u64 LE - 6 decimals)
  messageBuffer.writeBigUInt64LE(svmAmount, offset);
  offset += 8;

  // nonce (u64 LE)
  messageBuffer.writeBigUInt64LE(BigInt(evmRequest.nonce), offset);
  offset += 8;

  // deadline (i64 LE)
  messageBuffer.writeBigInt64LE(BigInt(evmRequest.deadline), offset);

  // Compute request_id = keccak256(message)
  const requestId = keccak_256(messageBuffer);
  logger.info(`Computed request_id: 0x${Buffer.from(requestId).toString('hex')}`);

  logger.nextStep('Signing message with Ed25519');

  // Sign the message using the wallet's keypair
  // Note: In production, this would be the orchestrator's dedicated keypair
  const walletKeypair = wallet.payer;
  const signature = nacl.sign.detached(messageBuffer, walletKeypair.secretKey);
  logger.success(`Signature generated (${signature.length} bytes)`);

  logger.nextStep('Building transaction');

  // ProcessedRequest PDA
  const [processedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('processed_request'), requestId],
    programId
  );

  // Build Ed25519 signature verification instruction
  const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: walletKeypair.secretKey.slice(0, 32),
    message: messageBuffer,
  });

  // Build transaction
  const tx = new Transaction();

  // Add Ed25519 instruction first (must be instruction 0)
  tx.add(ed25519Instruction);

  // Create ATA if needed
  if (needsAta) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, // payer
        recipientAta, // ata
        recipientPubkey, // owner
        okuMoneyMint, // mint
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // Add bridge_mint instruction
  const bridgeMintIx = await program.methods
    .bridgeMint(
      messageBuffer, // message_bytes (Buffer)
      Buffer.from(signature), // signature (Buffer)
      Array.from(requestId) as number[] // request_id [u8; 32]
    )
    .accountsPartial({
      payer: wallet.publicKey,
      bridgeConfig: bridgeConfig,
      config: psmConfig,
      processedRequest: processedRequest,
      okuMoneyMint: okuMoneyMint,
      recipientOkuMoneyAta: recipientAta,
      instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(bridgeMintIx);

  logger.nextStep('Submitting transaction');

  const txSig = await provider.sendAndConfirm(tx, [], { commitment: 'confirmed' });
  logger.success(`Transaction confirmed: ${txSig}`);

  // Verify balance increased
  const ataInfo = await getAccount(provider.connection, recipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const balanceAfter = ataInfo.amount;
  const balanceIncrease = balanceAfter - balanceBefore;

  logger.header('Bridge Mint Complete');
  logger.success(`Recipient: ${recipientPubkey.toBase58()}`);
  logger.success(`Balance before: ${Number(balanceBefore) / 1_000_000} OkuM`);
  logger.success(`Balance after: ${Number(balanceAfter) / 1_000_000} OkuM`);
  logger.success(`Minted: ${Number(balanceIncrease) / 1_000_000} OkuM`);
  logger.info(`TX: ${txSig}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Bridge mint failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
