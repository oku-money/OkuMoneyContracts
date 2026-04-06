/**
 * Relay a bridge request from EVM to Solana (Orchestrator Simulation)
 *
 * This script acts as the orchestrator for testnet:
 * 1. Reads EVM burn event data from bridge-request.json
 * 2. Converts 18-decimal EVM amount to 6-decimal SVM amount (floor division)
 * 3. Constructs 80-byte message
 * 4. Signs with Ed25519 (deployer keypair)
 * 5. Builds tx: Ed25519 instruction + bridge_mint
 * 6. Submits on Devnet
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/relay-from-evm.ts
 *   NETWORK=devnet tsx scripts/bridge/relay-from-evm.ts --request=../../EVM/bridge-request.json
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN } from '@anchor-lang/core';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { SOLANA_CHAIN_ID, OP_SEPOLIA_CHAIN_ID } from '../config/constants';

// Bridge request from EVM (BridgeBurn event data)
interface EVMBridgeRequest {
  requestId: string;
  sourceChainId: number;
  destChainId: number;
  sender: string; // EVM address
  recipient: string; // bytes32 (Solana pubkey, left-padded)
  amount: string; // 18-decimal EVM amount (post-fee)
  nonce: number;
  deadline: number;
  txHash?: string;
}

async function main() {
  const network = detectNetwork();
  logger.header(`Relay Bridge Request: EVM -> Solana (${network})`);
  logger.info('Acting as orchestrator (testnet mode)');

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

  // Verify orchestrator
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  if (!bridgeConfigAccount.orchestratorSigner.equals(wallet.publicKey)) {
    logger.warning(`Warning: Wallet is not the orchestrator signer`);
    logger.warning(`Expected: ${bridgeConfigAccount.orchestratorSigner.toBase58()}`);
    logger.warning(`Got: ${wallet.publicKey.toBase58()}`);
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

  // Validate destination is Solana
  if (evmRequest.destChainId !== SOLANA_CHAIN_ID) {
    logger.warning(`Destination chain is ${evmRequest.destChainId}, expected ${SOLANA_CHAIN_ID}`);
  }

  logger.nextStep('EVM Bridge Request');
  logger.info(`Source Chain: ${evmRequest.sourceChainId}`);
  logger.info(`Dest Chain: ${evmRequest.destChainId}`);
  logger.info(`Sender: ${evmRequest.sender}`);
  logger.info(`Recipient: ${evmRequest.recipient}`);
  logger.info(`Amount (18 dec): ${evmRequest.amount}`);
  logger.info(`Nonce: ${evmRequest.nonce}`);
  logger.info(`Deadline: ${evmRequest.deadline}`);

  // Decimal conversion: 18 -> 6 decimals (floor division)
  const evmAmount = BigInt(evmRequest.amount);
  const svmAmount = evmAmount / BigInt(1e12);
  const dustLost = evmAmount - (svmAmount * BigInt(1e12));

  logger.nextStep('Decimal Conversion');
  logger.info(`EVM amount (18 decimals): ${evmAmount.toString()}`);
  logger.info(`SVM amount (6 decimals): ${svmAmount.toString()}`);
  logger.info(`Dust lost: ${dustLost.toString()} wei`);
  logger.info(`Human readable: ${Number(svmAmount) / 1_000_000} OkuM`);

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > evmRequest.deadline) {
    throw new Error(`Bridge request expired. Deadline: ${evmRequest.deadline}, Now: ${now}`);
  }
  logger.info(`Time until deadline: ${evmRequest.deadline - now} seconds`);

  // Parse recipient (Solana pubkey from bytes32)
  const recipientHex = evmRequest.recipient.startsWith('0x')
    ? evmRequest.recipient.slice(2)
    : evmRequest.recipient;
  const recipientBytes = Buffer.from(recipientHex, 'hex');
  const recipientPubkey = new PublicKey(recipientBytes.slice(0, 32));
  logger.info(`Recipient Solana address: ${recipientPubkey.toBase58()}`);

  // Parse sender (EVM address, 20 bytes)
  const senderHex = evmRequest.sender.startsWith('0x')
    ? evmRequest.sender.slice(2)
    : evmRequest.sender;
  const senderBytes = Buffer.from(senderHex.padStart(40, '0'), 'hex');

  // Get recipient ATA
  const recipientAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    recipientPubkey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Check if ATA exists
  let needsAta = false;
  let balanceBefore = BigInt(0);
  try {
    const ataInfo = await getAccount(provider.connection, recipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
    balanceBefore = ataInfo.amount;
  } catch (e) {
    needsAta = true;
  }
  logger.info(`Recipient balance before: ${Number(balanceBefore) / 1_000_000} OkuM`);

  logger.nextStep('Constructing 80-byte message');

  // Message format: source_chain(2) + dest_chain(2) + sender(20) + recipient(32) + amount(8) + nonce(8) + deadline(8)
  const messageBuffer = Buffer.alloc(80);
  let offset = 0;

  messageBuffer.writeUInt16LE(evmRequest.sourceChainId, offset);
  offset += 2;

  messageBuffer.writeUInt16LE(evmRequest.destChainId, offset);
  offset += 2;

  senderBytes.copy(messageBuffer, offset);
  offset += 20;

  recipientPubkey.toBuffer().copy(messageBuffer, offset);
  offset += 32;

  messageBuffer.writeBigUInt64LE(svmAmount, offset);
  offset += 8;

  messageBuffer.writeBigUInt64LE(BigInt(evmRequest.nonce), offset);
  offset += 8;

  messageBuffer.writeBigInt64LE(BigInt(evmRequest.deadline), offset);

  const requestId = keccak_256(messageBuffer);
  logger.info(`Request ID: 0x${Buffer.from(requestId).toString('hex')}`);

  logger.nextStep('Signing with Ed25519');

  const walletKeypair = wallet.payer;
  const signature = nacl.sign.detached(messageBuffer, walletKeypair.secretKey);
  logger.success(`Signature generated`);

  logger.nextStep('Building transaction');

  // ProcessedRequest PDA
  const [processedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('processed_request'), requestId],
    programId
  );

  // Ed25519 instruction
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: walletKeypair.secretKey.slice(0, 32),
    message: messageBuffer,
  });

  const tx = new Transaction();
  tx.add(ed25519Ix);

  if (needsAta) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        recipientAta,
        recipientPubkey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

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

  // Verify balance
  const ataInfo = await getAccount(provider.connection, recipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const balanceAfter = ataInfo.amount;
  const minted = balanceAfter - balanceBefore;

  logger.header('Relay Complete');
  logger.success(`Recipient: ${recipientPubkey.toBase58()}`);
  logger.success(`Balance before: ${Number(balanceBefore) / 1_000_000} OkuM`);
  logger.success(`Balance after: ${Number(balanceAfter) / 1_000_000} OkuM`);
  logger.success(`Minted: ${Number(minted) / 1_000_000} OkuM`);
  logger.info(`TX: ${txSig}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Relay failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
