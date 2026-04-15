#!/usr/bin/env tsx
/**
 * Phase 1: Deploy Programs Only
 * 
 * Builds and deploys the Solana programs without initialization.
 * This is the flaky part that may need retries due to network congestion.
 * 
 * Programs are idempotent - can be retried safely until all succeed.
 * 
 * Usage:
 *   # Deploy to devnet
 *   pnpm run deploy:programs
 * 
 *   # Deploy to devnet fork (Surfpool)
 *   NETWORK=devnet-fork pnpm run deploy:programs
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PublicKey, Keypair, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';

import { detectNetwork, createProvider, getNetworkConfig, isForkNetwork, getParentNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { saveDeployment, loadDeployment } from '../utils/addressBook';
import { NETWORK_CONFIGS } from '../config/networks';

// ============================================================================
// Helper Functions
// ============================================================================

function getProgramIdFromKeypair(keypairPath: string): PublicKey {
  const keypairData = JSON.parse(readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  return keypair.publicKey;
}

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

// ============================================================================
// Build Programs
// ============================================================================

async function buildPrograms(isFork: boolean): Promise<{ originalKeypairs: Record<string, Buffer> }> {
  logger.nextStep('Building Programs');

  const keypairDir = isFork ? 'target/deploy-fork' : 'target/deploy';
  const programs = ['lite_psm', 'oku_dollar', 'oku_bridge_router'];
  const originalKeypairs: Record<string, Buffer> = {};

  if (isFork) {
    // For fork: swap keypairs, sync, build
    logger.info('Preparing fork build...');

    for (const prog of programs) {
      const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
      const forkPath = join(process.cwd(), keypairDir, `${prog}-keypair.json`);

      if (!existsSync(forkPath)) {
        throw new Error(`Fork keypair not found: ${forkPath}. Run: solana-keygen new -o ${forkPath}`);
      }

      if (existsSync(originalPath)) {
        originalKeypairs[prog] = readFileSync(originalPath);
      }

      execSync(`cp ${forkPath} ${originalPath}`);
    }

    logger.info('Syncing program IDs...');
    execSync('anchor keys sync', { stdio: 'pipe' });

    logger.info('Running anchor build...');
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built');
  } else {
    logger.info('Running anchor build...');
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built');
  }

  return { originalKeypairs };
}

function restoreOriginalKeypairs(originalKeypairs: Record<string, Buffer>): void {
  if (Object.keys(originalKeypairs).length === 0) return;
  
  logger.info('Restoring original keypairs...');
  for (const [prog, data] of Object.entries(originalKeypairs)) {
    const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
    writeFileSync(originalPath, data);
  }
  execSync('anchor keys sync', { stdio: 'pipe' });
}

// ============================================================================
// Deploy Programs
// ============================================================================

async function deployPrograms(
  provider: AnchorProvider,
  isFork: boolean
): Promise<{ litePsm: PublicKey; okuDollar: PublicKey; okuBridgeRouter: PublicKey }> {
  logger.nextStep('Deploying Programs');

  const keypairDir = isFork ? 'target/deploy-fork' : 'target/deploy';
  const cluster = provider.connection.rpcEndpoint;

  // Deploy programs one at a time using solana CLI with priority fees
  const programs = ['oku_bridge_router', 'oku_dollar', 'lite_psm'];
  const maxRetries = 5;
  const delayBetweenPrograms = 10000;
  const delayBetweenRetries = 60000;
  const priorityFee = 50000;
  
  for (const program of programs) {
    let deployed = false;
    const programSoPath = join(process.cwd(), 'target/deploy', `${program}.so`);
    const keypairPath = join(process.cwd(), keypairDir, `${program}-keypair.json`);
    
    for (let attempt = 1; attempt <= maxRetries && !deployed; attempt++) {
      if (attempt > 1) {
        logger.warning(`Retry ${attempt}/${maxRetries} for ${program} in ${delayBetweenRetries / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenRetries));
      }
      
      logger.info(`Deploying ${program}... (attempt ${attempt}/${maxRetries})`);
      
      try {
        execSync(
          `solana program deploy ${programSoPath} \
            --program-id ${keypairPath} \
            --url "${cluster}" \
            --with-compute-unit-price ${priorityFee} \
            --max-sign-attempts 100 \
            --use-rpc`,
          {
            stdio: 'inherit',
            timeout: 900000,
          }
        );
        logger.success(`${program} deployed successfully`);
        deployed = true;
      } catch (error: any) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to deploy ${program} after ${maxRetries} attempts`);
        }
        logger.warning(`Attempt ${attempt} failed for ${program}`);
      }
    }
    
    if (program !== programs[programs.length - 1]) {
      logger.info(`Waiting ${delayBetweenPrograms / 1000}s before next program...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenPrograms));
    }
  }

  // Read deployed program IDs
  const programIds = {
    litePsm: getProgramIdFromKeypair(join(process.cwd(), keypairDir, 'lite_psm-keypair.json')),
    okuDollar: getProgramIdFromKeypair(join(process.cwd(), keypairDir, 'oku_dollar-keypair.json')),
    okuBridgeRouter: getProgramIdFromKeypair(join(process.cwd(), keypairDir, 'oku_bridge_router-keypair.json')),
  };

  logger.success(`lite_psm: ${programIds.litePsm.toBase58()}`);
  logger.success(`oku_dollar: ${programIds.okuDollar.toBase58()}`);
  logger.success(`oku_bridge_router: ${programIds.okuBridgeRouter.toBase58()}`);

  return programIds;
}

// ============================================================================
// Verify Programs
// ============================================================================

async function verifyPrograms(
  provider: AnchorProvider,
  programIds: { litePsm: PublicKey; okuDollar: PublicKey; okuBridgeRouter: PublicKey }
): Promise<boolean> {
  logger.nextStep('Verifying Programs');
  
  let allVerified = true;
  
  for (const [name, pubkey] of Object.entries(programIds)) {
    const accountInfo = await provider.connection.getAccountInfo(pubkey);
    if (accountInfo && accountInfo.executable) {
      logger.success(`${name}: ${pubkey.toBase58()} (verified)`);
    } else {
      logger.error(`${name}: ${pubkey.toBase58()} (NOT FOUND or not executable)`);
      allVerified = false;
    }
  }
  
  return allVerified;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM - Deploy Programs');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const isFork = isForkNetwork(network);

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.info(`Mode: ${isFork ? 'Fork' : 'Live'}`);
  logger.log('');

  // Create provider
  const provider = createProvider(network);
  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);
  
  if (isFork) {
    const parentNetwork = getParentNetwork(network);
    const parentConfig = NETWORK_CONFIGS[parentNetwork];
    const parentConnection = new Connection(parentConfig.cluster, 'confirmed');
    try {
      const realBalance = await parentConnection.getBalance(deployerPubkey);
      logger.info(`Balance on ${parentNetwork}: ${formatSol(realBalance)} SOL (real)`);
    } catch (e) {
      logger.warning(`Could not fetch ${parentNetwork} balance`);
    }
  }
  logger.log('');

  // Build programs
  const { originalKeypairs } = await buildPrograms(isFork);
  logger.log('');

  // Deploy programs
  let programIds: { litePsm: PublicKey; okuDollar: PublicKey; okuBridgeRouter: PublicKey };
  try {
    programIds = await deployPrograms(provider, isFork);
  } finally {
    if (isFork) {
      restoreOriginalKeypairs(originalKeypairs);
    }
  }
  logger.log('');

  // Verify programs are on-chain
  const verified = await verifyPrograms(provider, programIds);
  if (!verified) {
    throw new Error('Program verification failed');
  }
  logger.log('');

  // Save program IDs to deployment file
  saveDeployment(network, {
    programs: {
      litePsm: programIds.litePsm.toBase58(),
      wokusdVault: programIds.okuDollar.toBase58(),
      okuBridgeRouter: programIds.okuBridgeRouter.toBase58(),
    },
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Programs Deployed Successfully');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Program IDs saved to: deployments/' + network + '.json');
  logger.info('');
  logger.info('Next step: Run initialization');
  logger.info(`  pnpm run deploy:init`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
