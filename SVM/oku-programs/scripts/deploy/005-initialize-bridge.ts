#!/usr/bin/env tsx
/**
 * 005-initialize-bridge.ts
 *
 * Note: Bridge config is part of lite-psm program and was initialized in script 003.
 * This script initializes bridge nonce PDAs for all supported chains.
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, BN } from '@anchor-lang/core';
import { detectNetwork, createProvider } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import { deriveBridgeNoncePDA } from '../utils/pdaHelpers';
import { SUPPORTED_CHAINS } from '../config/constants';
import litePsmIDL from '../../target/idl/lite_psm.json';

async function main() {
  logger.header('Initialize Bridge Nonces (005)');

  const network = detectNetwork();
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment?.pdas?.bridgeConfig) {
    logger.error('Missing deployment data. Run scripts 001-003 first.', false);
    process.exit(1);
  }

  const litePsmProgramId = new PublicKey(deployment.programs.litePsm);
  const bridgeConfig = new PublicKey(deployment.pdas.bridgeConfig);

  logger.section('Bridge Configuration');
  logger.success(`Bridge Config PDA: ${bridgeConfig.toBase58()}`);

  logger.log('');
  logger.section('Initializing Nonce PDAs');

  // Load program
  const litePsmProgram = new Program(litePsmIDL as any, litePsmProgramId, provider);

  for (const chainId of SUPPORTED_CHAINS) {
    const [noncePDA, bump] = deriveBridgeNoncePDA(litePsmProgramId, chainId);

    try {
      logger.info(`Initializing nonce for chain ${chainId}...`);

      // Use skip_nonce(chainId, 0) to pre-create nonce PDA
      // This is better than waiting for first burn to auto-initialize
      const tx = await litePsmProgram.methods
        .skipNonce(chainId, new BN(0))
        .accountsPartial({
          nonceAdmin: authorities.bridge.nonceAdmin,
          bridgeConfig: bridgeConfig,
          bridgeNonce: noncePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      logger.success(`Chain ${chainId}: ${noncePDA.toBase58()}`);
      logger.info(`  Transaction: ${tx}`);
    } catch (error: any) {
      if (error.message?.includes('already in use')) {
        logger.warning(`Chain ${chainId}: Already initialized (idempotent)`);
        logger.success(`  PDA: ${noncePDA.toBase58()}`);
      } else {
        logger.error(`Chain ${chainId} initialization failed: ${error.message}`);
        throw error;
      }
    }
  }

  logger.log('');
  logger.success('Bridge nonce initialization complete!', false);
  logger.info('Next: Run script 006 to initialize router', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
