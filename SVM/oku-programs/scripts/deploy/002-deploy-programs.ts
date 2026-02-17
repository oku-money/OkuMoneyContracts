#!/usr/bin/env tsx
/**
 * 002-deploy-programs.ts
 *
 * Build and deploy all Anchor programs:
 * - lite-psm
 * - wokusd-vault
 * - oku-bridge-router
 *
 * On mainnet: Transfers upgrade authority to cold multisig
 */

import { execSync } from 'child_process';
import { PublicKey, Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectNetwork, confirmMainnetDeployment } from '../utils/network';
import { logger } from '../utils/logger';
import { updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';

/**
 * Read program ID from deployed keypair file (source of truth)
 */
function getDeployedProgramId(programName: string): PublicKey {
  const keypairPath = join(process.cwd(), 'target/deploy', `${programName}-keypair.json`);
  const keypairData = JSON.parse(readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  return keypair.publicKey;
}

async function main() {
  logger.header('Deploy Programs (002)');

  const network = detectNetwork();
  const authorities = loadAuthorities(network);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Mainnet confirmation
  if (network === 'mainnet-beta') {
    const confirmed = await confirmMainnetDeployment();
    if (!confirmed) {
      process.exit(1);
    }
  }

  logger.section('Building Programs');

  logger.info('Running: anchor build');
  try {
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built successfully');
  } catch (error) {
    logger.error('Build failed');
    throw error;
  }

  logger.log('');
  logger.section('Deploying Programs');

  logger.info('Running: anchor deploy');
  try {
    execSync(`anchor deploy --provider.cluster ${network}`, { stdio: 'inherit' });
    logger.success('Programs deployed successfully');
  } catch (error) {
    logger.error('Deployment failed');
    throw error;
  }

  // Always read program IDs from keypair files (source of truth)
  const programIds = {
    litePsm: getDeployedProgramId('lite_psm'),
    wokusdVault: getDeployedProgramId('wokusd_vault'),
    okuBridgeRouter: getDeployedProgramId('oku_bridge_router'),
  };

  updateDeployment(network, 'programs', {
    litePsm: programIds.litePsm.toBase58(),
    wokusdVault: programIds.wokusdVault.toBase58(),
    okuBridgeRouter: programIds.okuBridgeRouter.toBase58(),
  });

  logger.log('');
  logger.section('Deployed Program IDs');
  logger.table({
    'lite-psm': programIds.litePsm.toBase58(),
    'wokusd-vault': programIds.wokusdVault.toBase58(),
    'oku-bridge-router': programIds.okuBridgeRouter.toBase58(),
  });

  // Transfer upgrade authority only on mainnet
  if (network === 'mainnet-beta') {
    logger.log('');
    logger.section('Transferring Upgrade Authority');

    const coldMultisig = authorities.psm.roleAdmin;

    logger.warning(
      `Transferring upgrade authority to: ${coldMultisig.toBase58()}`,
      false
    );

    const programs = [
      { name: 'lite-psm', id: programIds.litePsm },
      { name: 'wokusd-vault', id: programIds.wokusdVault },
      { name: 'oku-bridge-router', id: programIds.okuBridgeRouter },
    ];

    for (const program of programs) {
      try {
        logger.info(`Transferring ${program.name}...`);

        execSync(
          `solana program set-upgrade-authority ${program.id.toBase58()} --new-upgrade-authority ${coldMultisig.toBase58()} --url mainnet-beta`,
          { stdio: 'inherit' }
        );

        logger.success(`${program.name} upgrade authority transferred`);
      } catch (error) {
        logger.error(`Failed to transfer ${program.name} upgrade authority`);
        logger.warning('You may need to run this manually', false);
      }
    }

    logger.log('');
    logger.warning('IMPORTANT: Verify upgrade authorities with Squads', false);
  }

  logger.log('');
  logger.success('Program deployment complete!', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
