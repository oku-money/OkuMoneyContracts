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
 *   NETWORK=devnet-fork tsx scripts/bridge/bridge-burn-to-evm.ts  # On Surfpool fork
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
  SEPOLIA_CHAIN_ID,
  OP_SEPOLIA_CHAIN_ID,
} from '../config/constants';
import { logSurfpoolStatus } from '../utils/surfpool';
import { derivePsmConfigPDA, deriveBridgeConfigPDA, deriveBridgeNoncePDA } from '../utils/pdaHelpers';
import { fetchBridgeBurnEvent, serializeBurnMessage, computeRequestId } from '../lib/bridge';

// Destination chain ID - can be overridden via EVM_DEST_CHAIN_ID env var
// Default to SEPOLIA_CHAIN_ID (111) since that's where EVM contracts are deployed
const DEST_CHAIN_ID = process.env.EVM_DEST_CHAIN_ID
  ? parseInt(process.env.EVM_DEST_CHAIN_ID)
  : SEPOLIA_CHAIN_ID;

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

  // Check if running on Surfpool
  await logSurfpoolStatus(provider.connection);

  // Load deployment addresses for current network
  const deployment = loadDeployment(network);
  if (!deployment || !deployment.programs?.litePsm) {
    throw new Error(`No deployment found for network: ${network}. Run deploy scripts first.`);
  }

  // Load program
  const programId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  logger.info(`Program ID: ${programId.toBase58()}`);

  // Load token mint
  if (!deployment.tokens?.okuMoney) {
    throw new Error('OkuMoney mint not found in deployment');
  }
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney);
  logger.info(`OkuMoney Mint: ${okuMoneyMint.toBase58()}`);

  // PDAs
  const [psmConfig] = derivePsmConfigPDA(programId);
  const [bridgeConfig] = deriveBridgeConfigPDA(programId);

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
      logger.info('Mint OkuMoney via PSM first by running the smoke tests:');
      logger.info('  npm run test:onchain -- --step=mint');
      process.exit(1);
    }
  } catch (e) {
    logger.error('OkuMoney ATA does not exist or has no balance');
    logger.info('Mint OkuMoney via PSM first by running the smoke tests:');
    logger.info('  npm run test:onchain -- --step=mint');
    process.exit(1);
  }

  // Get fee recipient ATA
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  const feeRecipient = bridgeConfigAccount.feeRecipient;
  
  // Check if user is the fee recipient (causes duplicate mutable account error on devnet)
  const userIsFeeRecipient = feeRecipient.equals(wallet.publicKey);
  if (userIsFeeRecipient) {
    logger.warning('User wallet is the fee recipient - this may fail with duplicate mutable account error');
    logger.warning('This is a devnet configuration issue where deployer == feeRecipient');
  }
  
  const feeRecipientAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    feeRecipient,
    true, // allowOwnerOffCurve - fee recipient may be a PDA
    TOKEN_2022_PROGRAM_ID
  );

  // Create fee recipient ATA if it doesn't exist
  try {
    await getAccount(provider.connection, feeRecipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
    logger.info('Fee recipient ATA exists');
  } catch {
    logger.info('Creating fee recipient ATA...');
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    const createAtaIx = createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      feeRecipientAta,
      feeRecipient,
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID
    );
    const tx = new anchor.web3.Transaction().add(createAtaIx);
    await provider.sendAndConfirm(tx);
    logger.success('Fee recipient ATA created');
  }

  // BridgeNonce PDA
  const [bridgeNonce] = deriveBridgeNoncePDA(programId, DEST_CHAIN_ID);

  logger.nextStep('Executing bridge_burn');
  logger.info(`Amount: ${BRIDGE_AMOUNT.toNumber() / 1_000_000} OkuM`);
  logger.info(`Destination: chain ${DEST_CHAIN_ID}`);
  logger.info(`Recipient: ${EVM_RECIPIENT}`);

  // Call bridge_burn
  // If user == feeRecipient, pass null for feeRecipientAta to avoid duplicate mutable account error
  const tx = await program.methods
    .bridgeBurn(
      BRIDGE_AMOUNT,
      Array.from(recipientBytes) as number[], // [u8; 20]
      DEST_CHAIN_ID
    )
    .accountsPartial({
      user: wallet.publicKey,
      bridgeConfig: bridgeConfig,
      config: psmConfig,
      bridgeNonce: bridgeNonce,
      okuMoneyMint: okuMoneyMint,
      userOkuMoneyAta: userOkuMoneyAta,
      feeRecipientAta: userIsFeeRecipient ? null : feeRecipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  logger.success(`Transaction: ${tx}`);

  logger.nextStep('Parsing BridgeBurnEvent from transaction logs');

  // Pull the canonical values from the on-chain emitted event. Recomputing
  // them locally (Date.now() for deadline, nextNonce-1 for nonce) was racy
  // on devnet and produced request_ids the chain never emitted.
  const burnEvent = await fetchBridgeBurnEvent(
    provider.connection,
    tx,
    program.idl as any
  );

  // Sanity-check the locally-computed request_id matches the one the program
  // emitted (i.e. our message-encoding helper agrees with the on-chain
  // serializer byte-for-byte).
  const messageBuffer = serializeBurnMessage({
    sourceChainId: burnEvent.sourceChainId,
    destChainId: burnEvent.destinationChain,
    sender: wallet.publicKey,
    recipient: recipientBytes,
    amount: burnEvent.amount,
    nonce: burnEvent.nonce,
    deadline: burnEvent.deadline,
  });
  const computedRequestId = computeRequestId(messageBuffer);
  const onChainRequestId = Buffer.from(burnEvent.requestId);
  if (!computedRequestId.equals(onChainRequestId)) {
    throw new Error(
      `request_id mismatch — local helper disagrees with on-chain BridgeBurnEvent. ` +
        `local=0x${computedRequestId.toString('hex')} chain=0x${onChainRequestId.toString('hex')}`
    );
  }

  const requestId = '0x' + onChainRequestId.toString('hex');
  const senderHex = '0x' + wallet.publicKey.toBuffer().toString('hex');
  // EVM-side ABI expects bytes32 left-padded with 12 zero bytes.
  const recipientBytes32 = '0x' + '00'.repeat(12) + cleanAddress;
  const netAmount = Number(burnEvent.amount);
  const feeAmount = Number(burnEvent.feeAmount);

  logger.success('BridgeBurn Event:');
  logger.info(`  Request ID: ${requestId}`);
  logger.info(`  Sender: ${wallet.publicKey.toBase58()}`);
  logger.info(`  Recipient: ${EVM_RECIPIENT}`);
  logger.info(`  Source Chain: ${burnEvent.sourceChainId}`);
  logger.info(`  Dest Chain: ${burnEvent.destinationChain}`);
  logger.info(`  Amount: ${netAmount / 1_000_000} OkuM (post-fee)`);
  logger.info(`  Fee: ${feeAmount / 1_000_000} OkuM`);
  logger.info(`  Nonce: ${burnEvent.nonce}`);
  logger.info(`  Deadline: ${burnEvent.deadline}`);

  logger.nextStep('Writing bridge request file');

  const bridgeRequest: BridgeRequestOutput = {
    requestId: requestId,
    sourceChainId: burnEvent.sourceChainId,
    destChainId: burnEvent.destinationChain,
    sender: senderHex,
    recipient: recipientBytes32,
    amount: netAmount.toString(),
    nonce: Number(burnEvent.nonce),
    deadline: Number(burnEvent.deadline),
    timestamp: Math.floor(Date.now() / 1000),
    txSignature: tx,
  };

  // Write to scripts/bridge/ directory (gitignored)
  const outputPath = path.join(__dirname, 'bridge-request.json');
  fs.writeFileSync(outputPath, JSON.stringify(bridgeRequest, null, 2));
  logger.success(`Bridge request written to: ${outputPath}`);

  // Also copy to EVM/scripts/bridge/ for the corresponding mint script.
  // Resolve relative to the repo root (../../../../ from this file) and verify
  // the destination directory exists before writing — silently writing into a
  // missing directory or into the wrong tree (if SVM is symlinked elsewhere)
  // is a recurring footgun.
  const evmOutputDir = path.resolve(__dirname, '..', '..', '..', '..', 'EVM', 'scripts', 'bridge');
  if (!fs.existsSync(evmOutputDir)) {
    logger.warning(`EVM bridge scripts dir not found at ${evmOutputDir}; skipping copy`);
  } else {
    const evmOutputPath = path.join(evmOutputDir, 'bridge-request.json');
    fs.writeFileSync(evmOutputPath, JSON.stringify(bridgeRequest, null, 2));
    logger.success(`Bridge request also copied to: ${evmOutputPath}`);
  }

  logger.header('Bridge Burn Complete');
  logger.log('');
  logger.info('Next step:');
  logger.info('  cd ../../EVM && npm run bridge:mint:sepolia');
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
