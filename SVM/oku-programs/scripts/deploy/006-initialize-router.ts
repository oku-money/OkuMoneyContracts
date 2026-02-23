#!/usr/bin/env tsx
/**
 * 006-initialize-router.ts
 *
 * Initialize bridge router:
 * - Initialize router config PDA
 * - Set admin authority
 * - Reference PSM and Vault programs
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { detectNetwork, createProvider } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import { deriveRouterConfigPDA } from '../utils/pdaHelpers';
import okuBridgeRouterIDL from '../../target/idl/oku_bridge_router.json';

async function main() {
  logger.header('Initialize Router (006)');

  const network = detectNetwork();
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (
    !deployment?.programs?.okuBridgeRouter ||
    !deployment?.programs?.litePsm ||
    !deployment?.programs?.wokusdVault
  ) {
    logger.error('Missing deployment data. Run scripts 001-005 first.', false);
    process.exit(1);
  }

  const routerProgramId = new PublicKey(deployment.programs.okuBridgeRouter);
  const litePsmProgramId = new PublicKey(deployment.programs.litePsm);
  const vaultProgramId = new PublicKey(deployment.programs.wokusdVault);

  logger.section('Deriving Router PDA');

  const [routerConfig, routerBump] = deriveRouterConfigPDA(routerProgramId);

  logger.success(`Router Config: ${routerConfig.toBase58()}`);

  logger.log('');
  logger.section('Router Configuration');
  logger.table({
    'Router Config PDA': routerConfig.toBase58(),
    'Admin Authority': authorities.psm.roleAdmin.toBase58(),
    'PSM Program': litePsmProgramId.toBase58(),
    'Vault Program': vaultProgramId.toBase58(),
  });

  // Initialize router program
  logger.log('');
  logger.section('Initializing Router Program');

  const routerProgram = new Program(okuBridgeRouterIDL as any, routerProgramId, provider);

  try {
    logger.info('Calling initialize() on router...');

    const tx = await routerProgram.methods
      .initialize()
      .accountsPartial({
        admin: authorities.psm.roleAdmin,
        config: routerConfig,
        psmProgram: litePsmProgramId,
        vaultProgram: vaultProgramId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    logger.success(`Router initialized: ${tx}`);
    logger.info(`Transaction: https://explorer.solana.com/tx/${tx}?cluster=${network}`);
  } catch (error: any) {
    if (error.message?.includes('already in use')) {
      logger.warning('Router already initialized (idempotent)');
    } else {
      logger.error(`Router initialization failed: ${error.message}`);
      throw error;
    }
  }

  updateDeployment(network, 'pdas', {
    routerConfig: routerConfig.toBase58(),
  });

  logger.log('');
  logger.success('Router initialization complete!', false);
  logger.info('Next: Run script 007 to verify deployment', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
