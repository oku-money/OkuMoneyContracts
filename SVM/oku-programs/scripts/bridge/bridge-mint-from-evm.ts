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
 *   NETWORK=devnet-fork tsx scripts/bridge/bridge-mint-from-evm.ts  # On Surfpool fork
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nacl from 'tweetnacl';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { eip155ToInternalChainId } from '../config/constants';
import { logSurfpoolStatus } from '../utils/surfpool';
import { derivePsmConfigPDA, deriveBridgeConfigPDA, deriveProcessedRequestPDA } from '../utils/pdaHelpers';
import { serializeMintMessage, computeRequestId } from '../lib/bridge';

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

  // Check if running on Surfpool
  await logSurfpoolStatus(provider.connection);

  // Load addresses
  // For devnet-fork, load from devnet deployment file
  const effectiveNetwork = network === 'devnet-fork' ? 'devnet' : network;
  const addresses = loadDeployment(effectiveNetwork as any);
  if (!addresses) {
    throw new Error(`No addresses found for network: ${effectiveNetwork}`);
  }

  // Load program
  const programId = new PublicKey(addresses.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  // Load token mints
  const okuMoneyMint = new PublicKey(addresses.tokens.okuMoney);

  // PDAs
  const [psmConfig] = derivePsmConfigPDA(programId);
  const [bridgeConfig] = deriveBridgeConfigPDA(programId);

  // Resolve the orchestrator keypair. In dev/devnet the wallet typically IS
  // the orchestrator; in mainnet it must be a separate KMS-backed key. We
  // honour ORCHESTRATOR_KEYPAIR_PATH if set; otherwise fall back to the
  // wallet keypair, but ALWAYS verify against the on-chain orchestrator
  // pubkey before continuing — signing with the wrong key just wastes SOL on
  // a guaranteed-to-fail tx.
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  const orchestratorKeypairPath = process.env.ORCHESTRATOR_KEYPAIR_PATH;
  let orchestratorKeypair: Keypair;
  if (orchestratorKeypairPath) {
    const expanded = orchestratorKeypairPath.startsWith('~')
      ? path.join(os.homedir(), orchestratorKeypairPath.slice(1))
      : orchestratorKeypairPath;
    if (!fs.existsSync(expanded)) {
      throw new Error(`ORCHESTRATOR_KEYPAIR_PATH does not exist: ${expanded}`);
    }
    const secret = JSON.parse(fs.readFileSync(expanded, 'utf-8'));
    orchestratorKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    logger.info(`Orchestrator keypair: ${orchestratorKeypair.publicKey.toBase58()} (from ${expanded})`);
  } else {
    orchestratorKeypair = wallet.payer;
    logger.info(`Orchestrator keypair: wallet (set ORCHESTRATOR_KEYPAIR_PATH to override)`);
  }
  if (!bridgeConfigAccount.orchestratorSigner.equals(orchestratorKeypair.publicKey)) {
    throw new Error(
      `Orchestrator-signer mismatch — supplied key ${orchestratorKeypair.publicKey.toBase58()} ` +
        `does not match on-chain orchestratorSigner ${bridgeConfigAccount.orchestratorSigner.toBase58()}. ` +
        `The Ed25519 instruction would be rejected; aborting.`
    );
  }

  // Load bridge request from scripts/bridge/ directory
  const requestArg = process.argv.find(arg => arg.startsWith('--request='));
  const requestFile = requestArg
    ? requestArg.split('=')[1]
    : path.join(__dirname, 'bridge-request.json');

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

  // Note: the on-chain handler checks the deadline against `Clock::sysvar`
  // which can drift from wall-clock time on devnet/Surfpool. We deliberately
  // omit a wall-clock pre-flight here — let the program decide. If the
  // request has truly expired, `bridge_mint` returns `SignatureExpired` and
  // the only cost is RPC bandwidth.

  // Parse recipient Solana pubkey from bytes32.
  //
  // For EVM-burn → SVM-mint, the EVM side encodes the recipient as a
  // bytes32 holding the FULL 32-byte Solana pubkey. (Contrast with
  // SVM-burn → EVM-mint, where the recipient is a 20-byte EVM address
  // left-padded to bytes32.) We require exactly 32 bytes here and refuse to
  // truncate or pad — anything else means the EVM side serialized the wrong
  // half of the address.
  const recipientHex = evmRequest.recipient.startsWith('0x')
    ? evmRequest.recipient.slice(2)
    : evmRequest.recipient;
  const recipientBytes = Buffer.from(recipientHex, 'hex');
  if (recipientBytes.length !== 32) {
    throw new Error(
      `recipient must be a 32-byte Solana pubkey (got ${recipientBytes.length} bytes). ` +
        `For EVM->SVM bridges the EVM relayer must pack the full 32-byte pubkey, not a 20-byte EVM address.`
    );
  }
  const recipientPubkey = new PublicKey(recipientBytes);
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

  // Convert EIP-155 chain IDs to internal u16 protocol IDs
  // EVM emits EIP-155 IDs (e.g., 11155111 for Sepolia) but SVM uses u16 internal IDs (e.g., 111)
  const sourceChainInternal = eip155ToInternalChainId(evmRequest.sourceChainId);
  logger.info(`Source chain: ${evmRequest.sourceChainId} (EIP-155) -> ${sourceChainInternal} (internal)`);
  
  // destChainId should already be internal (103 for Solana Devnet); validate
  // against the on-chain config so we fail fast instead of paying for an
  // Ed25519-precompile-passes-but-bridge_mint-rejects round trip.
  const destChainInternal = evmRequest.destChainId;
  if (destChainInternal > 65535) {
    throw new Error(`Destination chain ID ${destChainInternal} exceeds u16 max`);
  }
  const expectedDest = bridgeConfigAccount.sourceChainId;
  if (destChainInternal !== expectedDest) {
    throw new Error(
      `destChainId mismatch — request says ${destChainInternal} but this bridge's ` +
        `source_chain_id is ${expectedDest}. The on-chain handler would reject ` +
        `this with WrongDestinationChain.`
    );
  }

  // Construct 80-byte message via the canonical encoder. This is the only
  // place TS code should ever build a bridge message — see scripts/lib/bridge/.
  const messageBuffer = serializeMintMessage({
    sourceChainId: sourceChainInternal,
    destChainId: destChainInternal,
    sender: senderBytes,
    recipient: recipientPubkey,
    amount: svmAmount,
    nonce: evmRequest.nonce,
    deadline: evmRequest.deadline,
  });

  // Compute request_id = keccak256(message)
  const requestId = computeRequestId(messageBuffer);
  logger.info(`Computed request_id: 0x${requestId.toString('hex')}`);

  logger.nextStep('Signing message with Ed25519');

  const signature = nacl.sign.detached(messageBuffer, orchestratorKeypair.secretKey);
  logger.success(`Signature generated (${signature.length} bytes)`);

  logger.nextStep('Building transaction');

  // ProcessedRequest PDA — replay prevention marker
  const [processedRequest] = deriveProcessedRequestPDA(programId, requestId);
  logger.info(`ProcessedRequest PDA: ${processedRequest.toBase58()}`);

  // Build Ed25519 signature verification instruction.
  // `createInstructionWithPrivateKey` expects the full 64-byte expanded
  // secret key (32-byte seed + 32-byte public key) — exactly what
  // `Keypair.secretKey` returns.
  const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: orchestratorKeypair.secretKey,
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
