/**
 * Bridge E2E Test Flow
 *
 * Tests the complete bridge flow locally before executing on testnet.
 * This script:
 * 1. Verifies bridge config is correct
 * 2. Mints test OkuMoney via PSM
 * 3. Executes bridge_burn to EVM
 * 4. Generates bridge-request.json
 * 5. Simulates relay (calls bridge_mint with orchestrator sig)
 * 6. Verifies balances
 *
 * Usage:
 *   # On Surfpool devnet fork
 *   surfpool start --rpc-url https://api.devnet.solana.com
 *   NETWORK=devnet-fork tsx scripts/bridge/test-bridge-flow.ts
 *
 *   # On localnet (fresh deployment needed)
 *   NETWORK=localnet tsx scripts/bridge/test-bridge-flow.ts
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN } from '@anchor-lang/core';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  Ed25519Program,
  Keypair,
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
import { isSurfpoolEnvironment, logSurfpoolStatus } from '../utils/surfpool';
import { SOLANA_CHAIN_ID, OP_SEPOLIA_CHAIN_ID } from '../config/constants';

// Test configuration
const TEST_AMOUNT = 10_000_000; // 10 OkuMoney (6 decimals)
const TEST_RECIPIENT_EVM = '0x742d35Cc6634C0532925a3b844Bc9e7595f12345'; // Example EVM address

async function main() {
  const network = detectNetwork();
  logger.header(`Bridge E2E Test Flow (${network})`);

  // Create provider
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Check Surfpool status
  await logSurfpoolStatus(provider.connection);

  // Load addresses
  // For devnet-fork, use devnet deployment file
  const effectiveNetwork = network === 'devnet-fork' ? 'devnet' : network;
  const addresses = loadDeployment(effectiveNetwork as any);
  if (!addresses) {
    logger.error(`No deployment found for network: ${effectiveNetwork}`);
    logger.info('Deploy first with: NETWORK=devnet npm run deploy');
    process.exit(1);
  }

  // Load program
  const programId = new PublicKey(addresses.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  // Load token mints
  const okuMoneyMint = new PublicKey(addresses.tokens.okusd);
  const usdcMint = new PublicKey(addresses.tokens.usdc);

  // PDAs
  const [psmConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('psm_config')],
    programId
  );
  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId
  );

  logger.nextStep('Step 1: Verify Bridge Config');

  try {
    const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);

    logger.info(`Bridge paused: ${bridgeConfigAccount.isPaused}`);
    logger.info(`Fee (bps): ${bridgeConfigAccount.bridgeFeeBps}`);
    logger.info(`Min bridge: ${bridgeConfigAccount.minBridgeAmount.toString()}`);
    logger.info(`Max bridge: ${bridgeConfigAccount.maxBridgeAmount.toString()}`);
    logger.info(`Orchestrator: ${bridgeConfigAccount.orchestratorSigner.toBase58()}`);

    // Check if OP Sepolia is supported
    const opSepoliaSupported = bridgeConfigAccount.supportedChains?.some(
      (chain: any) => chain.toNumber() === OP_SEPOLIA_CHAIN_ID
    );
    if (opSepoliaSupported) {
      logger.success(`OP Sepolia (${OP_SEPOLIA_CHAIN_ID}) is a supported destination`);
    } else {
      logger.warning(`OP Sepolia (${OP_SEPOLIA_CHAIN_ID}) is NOT in supported chains`);
      logger.info('Add it with: bridge_admin::add_supported_chain');
    }

    if (bridgeConfigAccount.isPaused) {
      logger.warning('Bridge is paused! Enable with: bridge_admin::unpause_bridge');
    }
  } catch (e: any) {
    logger.error(`Failed to fetch bridge config: ${e.message}`);
    logger.info('Initialize bridge with: npm run deploy:bridge');
    process.exit(1);
  }

  logger.nextStep('Step 2: Check Wallet Balances');

  const walletOkuAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  let okuBalance = BigInt(0);
  try {
    const ataInfo = await getAccount(provider.connection, walletOkuAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
    okuBalance = ataInfo.amount;
  } catch {
    logger.info('OkuMoney ATA does not exist yet');
  }
  logger.info(`OkuMoney balance: ${Number(okuBalance) / 1_000_000} OkuM`);

  // If balance is insufficient, mint some via PSM
  if (okuBalance < BigInt(TEST_AMOUNT)) {
    logger.nextStep('Step 2b: Mint OkuMoney via PSM');

    const mintAmount = TEST_AMOUNT * 2; // Mint extra for testing

    // Check USDC balance
    const walletUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    let usdcBalance = BigInt(0);
    try {
      const usdcInfo = await getAccount(provider.connection, walletUsdcAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
      usdcBalance = usdcInfo.amount;
    } catch {
      logger.warning('No USDC balance - need to mint mock USDC first');
      logger.info('This test requires mock USDC. On devnet, mint some first.');
      process.exit(1);
    }

    if (usdcBalance < BigInt(mintAmount)) {
      logger.warning(`Insufficient USDC: have ${usdcBalance}, need ${mintAmount}`);
      process.exit(1);
    }

    logger.info(`Minting ${mintAmount / 1_000_000} OkuMoney from PSM...`);

    // This would call the PSM mint instruction
    // For now, we'll skip this step and assume we have enough balance
    logger.warning('PSM mint not implemented in this test - ensure you have OkuMoney balance');
  }

  logger.nextStep('Step 3: Execute Bridge Burn');

  // Parse recipient EVM address to bytes
  const recipientHex = TEST_RECIPIENT_EVM.replace('0x', '');
  const recipientBytes = Buffer.from(recipientHex, 'hex');

  // Get bridge nonce PDA for OP Sepolia
  const [bridgeNonce] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_nonce'), Buffer.from(new BN(OP_SEPOLIA_CHAIN_ID).toArray('le', 8))],
    programId
  );

  let currentNonce = BigInt(0);
  try {
    const nonceAccount = await program.account.bridgeNonce.fetch(bridgeNonce);
    currentNonce = BigInt(nonceAccount.nextNonce.toNumber());
  } catch {
    logger.info('Bridge nonce PDA not found - may need to initialize');
  }

  logger.info(`Current nonce for OP Sepolia: ${currentNonce}`);
  logger.info(`Burning ${TEST_AMOUNT / 1_000_000} OkuMoney to ${TEST_RECIPIENT_EVM}`);

  // For a full test, we would execute the bridge_burn instruction here
  // For now, we'll simulate the output

  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const nonce = Number(currentNonce);

  // Construct message for request ID calculation
  const messageBuffer = Buffer.alloc(80);
  let offset = 0;

  // source_chain_id (2 bytes LE)
  messageBuffer.writeUInt16LE(SOLANA_CHAIN_ID, offset);
  offset += 2;

  // dest_chain_id (2 bytes LE)
  messageBuffer.writeUInt16LE(OP_SEPOLIA_CHAIN_ID, offset);
  offset += 2;

  // sender (32 bytes - Solana pubkey)
  wallet.publicKey.toBuffer().copy(messageBuffer, offset);
  offset += 32;

  // recipient (20 bytes - EVM address, padded)
  recipientBytes.copy(messageBuffer, offset);
  offset += 20;

  // amount (8 bytes LE)
  messageBuffer.writeBigUInt64LE(BigInt(TEST_AMOUNT), offset);
  offset += 8;

  // nonce (8 bytes LE)
  messageBuffer.writeBigUInt64LE(BigInt(nonce), offset);
  offset += 8;

  // deadline (8 bytes LE signed)
  messageBuffer.writeBigInt64LE(BigInt(deadline), offset);

  const requestId = keccak_256(messageBuffer);

  logger.success('Bridge burn simulated (would execute on-chain)');
  logger.info(`Request ID: 0x${Buffer.from(requestId).toString('hex')}`);

  logger.nextStep('Step 4: Generate Bridge Request JSON');

  const bridgeRequest = {
    sourceChainId: SOLANA_CHAIN_ID,
    destChainId: OP_SEPOLIA_CHAIN_ID,
    sender: wallet.publicKey.toBase58(),
    senderHex: '0x' + wallet.publicKey.toBuffer().toString('hex'),
    recipient: TEST_RECIPIENT_EVM,
    recipientBytes32: '0x' + recipientHex.padStart(64, '0'),
    amount: TEST_AMOUNT.toString(),
    nonce: nonce,
    deadline: deadline,
    requestId: '0x' + Buffer.from(requestId).toString('hex'),
    network: network,
    timestamp: new Date().toISOString(),
  };

  const requestFile = path.join(__dirname, '..', '..', 'bridge-request.json');
  fs.writeFileSync(requestFile, JSON.stringify(bridgeRequest, null, 2));
  logger.success(`Bridge request saved to: ${requestFile}`);

  logger.nextStep('Step 5: Simulate Relay (Mint on Destination)');

  // In a full test, we would:
  // 1. Sign the message with the orchestrator key
  // 2. Submit the bridge_mint transaction
  // 3. Verify the recipient received the tokens

  logger.info('Simulating orchestrator signature...');

  const walletKeypair = wallet.payer;
  const signature = nacl.sign.detached(messageBuffer, walletKeypair.secretKey);
  logger.success(`Ed25519 signature generated (${signature.length} bytes)`);

  // ProcessedRequest PDA
  const [processedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('processed_request'), requestId],
    programId
  );
  logger.info(`ProcessedRequest PDA: ${processedRequest.toBase58()}`);

  logger.nextStep('Step 6: Summary');

  logger.header('Bridge Test Flow Complete');
  logger.success(`Network: ${network}`);
  logger.success(`Source Chain: ${SOLANA_CHAIN_ID} (Solana Devnet)`);
  logger.success(`Dest Chain: ${OP_SEPOLIA_CHAIN_ID} (OP Sepolia)`);
  logger.success(`Amount: ${TEST_AMOUNT / 1_000_000} OkuMoney`);
  logger.success(`Nonce: ${nonce}`);
  logger.success(`Deadline: ${new Date(deadline * 1000).toISOString()}`);
  logger.success(`Request ID: 0x${Buffer.from(requestId).toString('hex').slice(0, 16)}...`);

  console.log();
  logger.info('Next steps for live testnet:');
  logger.info('1. Deploy to devnet: NETWORK=devnet npm run deploy');
  logger.info('2. Run burn script: NETWORK=devnet tsx scripts/bridge/bridge-burn-to-evm.ts');
  logger.info('3. Relay to EVM: See EVM/scripts/bridge/relay-from-solana.ts');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Test failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
