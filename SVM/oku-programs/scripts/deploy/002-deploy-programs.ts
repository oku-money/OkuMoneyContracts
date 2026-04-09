#!/usr/bin/env tsx
/**
 * 002-deploy-programs.ts
 *
 * Build and deploy all Anchor programs:
 * - lite-psm
 * - wokusd-vault (oku-dollar)
 * - oku-bridge-router
 *
 * On mainnet: Transfers upgrade authority to cold multisig
 * On fork networks: Uses separate keypairs to avoid PDA collisions with forked state
 */

import { execSync } from 'child_process';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { detectNetwork, confirmMainnetDeployment, getNetworkConfig, isForkNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { updateDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';
import { isSurfpoolEnvironment, deployProgramViaCheatcode, setProgramAuthority } from '../utils/surfpool';

/**
 * Get the cluster argument for anchor deploy.
 * For fork networks, use the RPC URL since anchor doesn't recognize fork network names.
 * For standard networks, use the network name.
 */
function getAnchorCluster(network: string): string {
  if (isForkNetwork(network as any)) {
    // Use RPC URL for fork networks
    const config = getNetworkConfig(network as any);
    return config.cluster;
  }
  // Standard networks: localnet, devnet, mainnet-beta
  // Note: anchor uses 'mainnet' not 'mainnet-beta'
  if (network === 'mainnet-beta') {
    return 'mainnet';
  }
  return network;
}

/**
 * Get the keypair directory based on network.
 * Fork networks use separate keypairs in target/deploy-fork/ to avoid PDA collisions.
 */
function getKeypairDir(network: string): string {
  if (isForkNetwork(network as any)) {
    return 'target/deploy-fork';
  }
  return 'target/deploy';
}

/**
 * Read program ID from keypair file
 */
function getProgramIdFromKeypair(keypairPath: string): PublicKey {
  const keypairData = JSON.parse(readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  return keypair.publicKey;
}

/**
 * Read program ID from deployed keypair file (source of truth)
 */
function getDeployedProgramId(programName: string, network: string): PublicKey {
  const keypairDir = getKeypairDir(network);
  const keypairPath = join(process.cwd(), keypairDir, `${programName}-keypair.json`);
  return getProgramIdFromKeypair(keypairPath);
}

async function main() {
  logger.header('Deploy Programs (002)');

  const network = detectNetwork();
  const authorities = loadAuthorities(network);
  const isFork = isForkNetwork(network as any);

  logger.info(`Network: ${network}`, false);
  if (isFork) {
    logger.info(`Using fork keypairs from target/deploy-fork/`, false);
  }
  logger.log('');

  // Mainnet confirmation
  if (network === 'mainnet-beta') {
    const confirmed = await confirmMainnetDeployment();
    if (!confirmed) {
      process.exit(1);
    }
  }

  logger.section('Building Programs');

  const cluster = getAnchorCluster(network);
  const keypairDir = getKeypairDir(network);

  if (isFork) {
    // For fork networks, we need to build with fork keypairs so the program IDs match
    // This involves: copy fork keypairs -> sync source -> build -> restore source -> restore keypairs
    logger.info('Preparing fork build (swapping keypairs temporarily)...');
    
    const programs = ['lite_psm', 'oku_dollar', 'oku_bridge_router'];
    const originalKeypairs: Record<string, Buffer> = {};
    
    // Backup original keypairs and copy fork keypairs
    for (const prog of programs) {
      const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
      const forkPath = join(process.cwd(), keypairDir, `${prog}-keypair.json`);
      
      if (existsSync(originalPath)) {
        originalKeypairs[prog] = readFileSync(originalPath);
      }
      
      if (!existsSync(forkPath)) {
        throw new Error(`Fork keypair not found: ${forkPath}. Run 'solana-keygen new -o ${forkPath}'`);
      }
      
      // Copy fork keypair to target/deploy
      execSync(`cp ${forkPath} ${originalPath}`);
    }
    
    // Sync the declare_id! macros in source code to match the fork keypairs
    logger.info('Syncing source code with fork keypairs...');
    try {
      execSync('anchor keys sync', { stdio: 'inherit' });
    } catch (error) {
      // Restore original keypairs before throwing
      for (const prog of programs) {
        const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
        if (originalKeypairs[prog]) {
          writeFileSync(originalPath, originalKeypairs[prog]);
        }
      }
      execSync('anchor keys sync', { stdio: 'pipe' }); // Restore source silently
      logger.error('Keys sync failed');
      throw error;
    }
    
    logger.info('Running: anchor build (with fork program IDs)');
    try {
      execSync('anchor build', { stdio: 'inherit' });
      logger.success('Programs built successfully');
    } catch (error) {
      // Restore original keypairs and source before throwing
      for (const prog of programs) {
        const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
        if (originalKeypairs[prog]) {
          writeFileSync(originalPath, originalKeypairs[prog]);
        }
      }
      execSync('anchor keys sync', { stdio: 'pipe' }); // Restore source silently
      logger.error('Build failed');
      throw error;
    }
    
    // Restore original keypairs and source code declare_id! macros
    // The built .so files have the fork program IDs baked in
    logger.info('Restoring original keypairs and source code...');
    for (const prog of programs) {
      const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
      if (originalKeypairs[prog]) {
        writeFileSync(originalPath, originalKeypairs[prog]);
      }
    }
    execSync('anchor keys sync', { stdio: 'inherit' });
  } else {
    logger.info('Running: anchor build');
    try {
      execSync('anchor build', { stdio: 'inherit' });
      logger.success('Programs built successfully');
    } catch (error) {
      logger.error('Build failed');
      throw error;
    }
  }

  logger.log('');
  logger.section('Deploying Programs');

  if (isFork) {
    // For fork networks, deploy each program with fork keypairs
    // The .so files were built with fork program IDs
    // Use surfnet_writeProgram cheatcode to avoid timeout issues with large programs
    const programs = [
      { name: 'oku_dollar', keypair: 'oku_dollar-keypair.json', so: 'oku_dollar.so' },
      { name: 'lite_psm', keypair: 'lite_psm-keypair.json', so: 'lite_psm.so' },
      { name: 'oku_bridge_router', keypair: 'oku_bridge_router-keypair.json', so: 'oku_bridge_router.so' },
    ];

    // Check if Surfpool cheatcodes are available
    const connection = new Connection(cluster, 'confirmed');
    const hasSurfpool = await isSurfpoolEnvironment(connection);

    if (hasSurfpool) {
      logger.info('Surfpool detected - using surfnet_writeProgram cheatcode for deployment');
    } else {
      logger.info('Standard validator - using solana program deploy');
    }

    for (const prog of programs) {
      const keypairPath = join(process.cwd(), keypairDir, prog.keypair);
      const soPath = join(process.cwd(), 'target/deploy', prog.so);

      if (!existsSync(keypairPath)) {
        throw new Error(`Fork keypair not found: ${keypairPath}. Run 'solana-keygen new -o ${keypairPath}'`);
      }

      const programId = getProgramIdFromKeypair(keypairPath);
      logger.info(`Deploying ${prog.name} to ${programId.toBase58()}...`);

      if (hasSurfpool) {
        // For Surfpool: Use cheatcode to set up program authority, then standard deploy
        // surfnet_writeProgram creates a placeholder - we then upgrade it with real code
        const programData = readFileSync(soPath);
        logger.info(`  Program size: ${(programData.length / 1024).toFixed(1)} KB`);

        // Step 1: Create program account with correct authority via cheatcode
        // This avoids the timeout issues when creating accounts
        const walletPath = process.env.WALLET_PATH || join(process.env.HOME!, '.config/solana/id.json');
        const walletPubkey = getProgramIdFromKeypair(walletPath); // Reuse function to get pubkey
        
        const success = await deployProgramViaCheatcode(
          connection,
          programId.toBase58(),
          Buffer.alloc(0), // Empty data - just create the account structure
          walletPubkey.toBase58() // Use wallet as upgrade authority for subsequent deploy
        );

        if (!success) {
          throw new Error(`Failed to create program account for ${prog.name}`);
        }

        // Step 2: Set program authority to our wallet so we can upgrade it
        await setProgramAuthority(connection, programId.toBase58(), walletPubkey.toBase58());

        // Step 3: Deploy actual program using standard CLI
        logger.info(`  Uploading program code via solana CLI...`);
        try {
          execSync(
            `solana program deploy ${soPath} --program-id ${keypairPath} --url ${cluster}`,
            { stdio: 'inherit' }
          );
          logger.success(`${prog.name} deployed successfully via Surfpool + CLI`);
        } catch (error) {
          logger.error(`Failed to deploy ${prog.name} code`);
          throw error;
        }
      } else {
        // Fallback to standard deployment
        try {
          execSync(
            `solana program deploy ${soPath} --program-id ${keypairPath} --url ${cluster}`,
            { stdio: 'inherit' }
          );
          logger.success(`${prog.name} deployed successfully`);
        } catch (error) {
          logger.error(`Failed to deploy ${prog.name}`);
          throw error;
        }
      }
    }
  } else {
    // Standard deployment using anchor deploy
    logger.info(`Running: anchor deploy --provider.cluster ${cluster}`);
    try {
      execSync(`anchor deploy --provider.cluster ${cluster}`, { stdio: 'inherit' });
      logger.success('Programs deployed successfully');
    } catch (error) {
      logger.error('Deployment failed');
      throw error;
    }
  }

  // Read program IDs from keypair files (source of truth for the network)
  const programIds = {
    litePsm: getDeployedProgramId('lite_psm', network),
    wokusdVault: getDeployedProgramId('oku_dollar', network), // Note: oku_dollar is the vault program
    okuBridgeRouter: getDeployedProgramId('oku_bridge_router', network),
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
