/**
 * Check SVM Bridge state and configuration (Read-only diagnostics)
 *
 * Queries and logs:
 * - BridgeConfig PDA: fee, min/max, orchestrator, supported chains, paused
 * - BridgeNonce PDAs for each supported chain
 * - PSM config state
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/check-bridge-state.ts
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  SOLANA_CHAIN_ID,
  OP_SEPOLIA_CHAIN_ID,
  OPTIMISM_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
  BASE_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
} from '../config/constants';

async function main() {
  const network = detectNetwork();
  logger.header(`SVM Bridge State Check (${network})`);

  // Create provider
  const provider = createProvider(network);
  anchor.setProvider(provider);

  // Load addresses
  const addresses = loadDeployment(network);
  if (!addresses) {
    throw new Error(`No addresses found for network: ${network}. Run deploy scripts first.`);
  }

  // Load program
  const programId = new PublicKey(addresses.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  logger.info(`Program ID: ${programId.toBase58()}`);

  // Load token mint
  const okuMoneyMint = new PublicKey(addresses.tokens.okusd);
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

  // ============ PSM Config ============
  logger.nextStep('PSM Configuration');

  try {
    const psmConfigAccount = await program.account.psmConfig.fetch(psmConfig);
    logger.info(`PSM Paused: ${psmConfigAccount.isPaused ? 'YES' : 'NO'}`);
    logger.info(`Max Supply: ${psmConfigAccount.maxSupply.toNumber() / 1_000_000} OkuM`);
    logger.info(`Minter Allowance: ${psmConfigAccount.minterAllowance.toNumber() / 1_000_000} OkuM`);
  } catch (e) {
    logger.error(`PSM Config not found. Deploy first.`);
    process.exit(1);
  }

  // ============ Bridge Config ============
  logger.nextStep('Bridge Configuration');

  try {
    const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
    
    logger.info(`Source Chain ID: ${bridgeConfigAccount.sourceChainId}`);
    logger.info(`Bridge Paused: ${bridgeConfigAccount.isPaused ? 'YES' : 'NO'}`);
    logger.info(`Bridge Fee: ${bridgeConfigAccount.bridgeFeeBps} bps (${bridgeConfigAccount.bridgeFeeBps / 100}%)`);
    logger.info(`Min Bridge: ${bridgeConfigAccount.minBridgeAmount.toNumber() / 1_000_000} OkuM`);
    logger.info(`Max Bridge: ${bridgeConfigAccount.maxBridgeAmount.toNumber() / 1_000_000} OkuM`);
    logger.info(`Deadline: ${bridgeConfigAccount.bridgeDeadlineSecs.toNumber()} seconds`);
    logger.info(`Orchestrator: ${bridgeConfigAccount.orchestratorSigner.toBase58()}`);
    logger.info(`Fee Recipient: ${bridgeConfigAccount.feeRecipient.toBase58()}`);

    // Supported chains
    logger.log('');
    logger.info('Supported Chains:');
    const supportedChains = bridgeConfigAccount.supportedChains;
    for (let i = 0; i < supportedChains.length; i++) {
      if (supportedChains[i]) {
        let chainName = `Unknown (${i})`;
        switch (i) {
          case ETHEREUM_CHAIN_ID: chainName = 'Ethereum Mainnet'; break;
          case OPTIMISM_CHAIN_ID: chainName = 'Optimism'; break;
          case ARBITRUM_CHAIN_ID: chainName = 'Arbitrum One'; break;
          case BASE_CHAIN_ID: chainName = 'Base'; break;
          case OP_SEPOLIA_CHAIN_ID: chainName = 'OP Sepolia'; break;
        }
        // Check for lower chain IDs
        if (i < 1000) {
          switch (i) {
            case 1: chainName = 'Ethereum Mainnet'; break;
            case 10: chainName = 'Optimism'; break;
            case 56: chainName = 'BSC'; break;
            case 137: chainName = 'Polygon'; break;
          }
        }
        logger.info(`  Chain ${i}: ${chainName} - SUPPORTED`);
      }
    }
  } catch (e) {
    logger.error(`Bridge Config not found. Run initialize scripts.`);
    process.exit(1);
  }

  // ============ Bridge Nonces ============
  logger.nextStep('Bridge Nonces');

  const chainsToCheck = [
    { id: ETHEREUM_CHAIN_ID, name: 'Ethereum Mainnet' },
    { id: OPTIMISM_CHAIN_ID, name: 'Optimism' },
    { id: ARBITRUM_CHAIN_ID, name: 'Arbitrum One' },
    { id: BASE_CHAIN_ID, name: 'Base' },
    { id: OP_SEPOLIA_CHAIN_ID, name: 'OP Sepolia' },
  ];

  for (const chain of chainsToCheck) {
    const [bridgeNonce] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_nonce'), Buffer.from(new Uint16Array([chain.id]).buffer)],
      programId
    );

    try {
      const nonceAccount = await program.account.bridgeNonce.fetch(bridgeNonce);
      logger.info(`${chain.name} (${chain.id}): nonce = ${nonceAccount.nextNonce.toNumber()}`);
    } catch (e) {
      // Nonce not initialized for this chain
      logger.info(`${chain.name} (${chain.id}): not initialized`);
    }
  }

  // ============ Token Supply ============
  logger.nextStep('Token Supply');

  try {
    const mintInfo = await getMint(provider.connection, okuMoneyMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    logger.info(`OkuMoney Supply: ${Number(mintInfo.supply) / 1_000_000} OkuM`);
    logger.info(`Decimals: ${mintInfo.decimals}`);
    logger.info(`Mint Authority: ${mintInfo.mintAuthority?.toBase58() || 'None'}`);
    logger.info(`Freeze Authority: ${mintInfo.freezeAuthority?.toBase58() || 'None'}`);
  } catch (e) {
    logger.error(`Failed to fetch mint info: ${e}`);
  }

  // ============ Fee Recipient Balance ============
  logger.nextStep('Fee Recipient');

  try {
    const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
    const feeRecipient = bridgeConfigAccount.feeRecipient;
    
    const feeRecipientAta = anchor.utils.token.associatedAddress({
      mint: okuMoneyMint,
      owner: feeRecipient,
    });

    try {
      const ataInfo = await getAccount(provider.connection, feeRecipientAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
      logger.info(`Fee Recipient: ${feeRecipient.toBase58()}`);
      logger.info(`Collected Fees: ${Number(ataInfo.amount) / 1_000_000} OkuM`);
    } catch (e) {
      logger.info(`Fee Recipient ATA not found (no fees collected yet)`);
    }
  } catch (e) {
    // Already handled above
  }

  logger.header('State Check Complete');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`State check failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
