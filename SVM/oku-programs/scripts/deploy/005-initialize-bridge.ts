#!/usr/bin/env tsx
/**
 * 005-initialize-bridge.ts
 *
 * Note: Bridge config is part of lite-psm program and was initialized in script 003.
 * Bridge nonce PDAs are created lazily via init_if_needed when the first bridge burn
 * happens for each chain, so no explicit initialization is needed here.
 *
 * This script now just verifies the bridge configuration is correct.
 */

import { PublicKey } from '@solana/web3.js';
import { Program } from '@anchor-lang/core';
import { detectNetwork, createProvider } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment } from '../utils/addressBook';
import { deriveBridgeNoncePDA } from '../utils/pdaHelpers';
import { SUPPORTED_CHAINS, PROGRAM_IDS } from '../config/constants';
import litePsmIDLRaw from '../../target/idl/lite_psm.json';

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
  logger.header('Verify Bridge Configuration (005)');

  const network = detectNetwork();
  const provider = createProvider(network);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment from current network
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment?.pdas?.bridgeConfig) {
    logger.error('Missing deployment data. Run scripts 001-003 first.', false);
    process.exit(1);
  }

  const litePsmProgramId = new PublicKey(deployment.programs.litePsm);
  const bridgeConfigPDA = new PublicKey(deployment.pdas.bridgeConfig);

  // Load program
  const litePsmIDL = loadIdlForNetwork(litePsmIDLRaw, network, 'litePsm');
  const litePsmProgram = new Program(litePsmIDL as any, provider);

  logger.section('Bridge Configuration');

  // Fetch and display bridge config
  try {
    const bridgeConfig = await litePsmProgram.account.bridgeConfig.fetch(bridgeConfigPDA);
    
    logger.table({
      'Bridge Config PDA': bridgeConfigPDA.toBase58(),
      'Bridge Admin': (bridgeConfig as any).bridgeAdmin.toBase58(),
      'Bridge Pauser': (bridgeConfig as any).bridgePauser.toBase58(),
      'Bridge Fee (bps)': (bridgeConfig as any).bridgeFeeBps.toString(),
      'Min Amount': (bridgeConfig as any).minBridgeAmount.toString(),
      'Max Amount': (bridgeConfig as any).maxBridgeAmount.toString(),
      'Deadline (secs)': (bridgeConfig as any).bridgeDeadlineSecs.toString(),
      'Is Paused': (bridgeConfig as any).isPaused.toString(),
    });

    // Display supported chains
    const supportedChainsCount = (bridgeConfig as any).supportedChainsCount;
    const supportedChains = (bridgeConfig as any).supportedChains.slice(0, supportedChainsCount);
    
    logger.log('');
    logger.section('Supported Chains');
    if (supportedChains.length === 0) {
      logger.warning('No chains configured');
    } else {
      for (const chainId of supportedChains) {
        const [noncePDA] = deriveBridgeNoncePDA(litePsmProgramId, chainId);
        logger.success(`Chain ${chainId}: Nonce PDA = ${noncePDA.toBase58()}`);
        logger.info(`  (Nonce PDA created lazily on first bridge burn)`);
      }
    }

    // Verify expected chains are configured
    logger.log('');
    logger.section('Chain Verification');
    for (const expectedChain of SUPPORTED_CHAINS) {
      if (supportedChains.includes(expectedChain)) {
        logger.success(`Chain ${expectedChain}: Configured`);
      } else {
        logger.error(`Chain ${expectedChain}: NOT configured (expected)`);
      }
    }

  } catch (error: any) {
    logger.error(`Failed to fetch bridge config: ${error.message}`);
    throw error;
  }

  logger.log('');
  logger.success('Bridge verification complete!', false);
  logger.info('Next: Run script 006 to initialize router', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
