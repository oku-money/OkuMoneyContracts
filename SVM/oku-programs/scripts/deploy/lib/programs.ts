/**
 * Program deployment utilities
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { DEPLOYMENT_CONFIG } from '../../config/networks';

/**
 * Get program ID from keypair file
 */
export function getProgramIdFromKeypair(keypairPath: string): PublicKey {
  const keypairData = JSON.parse(readFileSync(keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  return keypair.publicKey;
}

/**
 * Load IDL with program address set
 */
export function loadIdlWithAddress(idl: any, programId: PublicKey): any {
  return { ...idl, address: programId.toBase58() };
}

export interface ProgramIds {
  litePsm: PublicKey;
  okuDollar: PublicKey;
  okuBridgeRouter: PublicKey;
}

/**
 * Deploy all programs to the network
 */
export async function deployPrograms(
  provider: AnchorProvider,
  isFork: boolean
): Promise<ProgramIds> {
  logger.nextStep('Deploying Programs');

  const keypairDir = isFork ? 'target/deploy-fork' : 'target/deploy';
  const cluster = provider.connection.rpcEndpoint;

  // Deploy programs one at a time using solana CLI with priority fees
  // Order: smallest to largest to fail fast if there's an issue
  const programs = ['oku_bridge_router', 'oku_dollar', 'lite_psm'];
  const { maxRetries, retryDelayMs, programDelayMs, priorityFee, deployTimeoutMs } = DEPLOYMENT_CONFIG;
  
  logger.info(`Deployment config: priorityFee=${priorityFee}, maxRetries=${maxRetries}, retryDelay=${retryDelayMs/1000}s`);
  
  for (const program of programs) {
    let deployed = false;
    const programSoPath = join(process.cwd(), 'target/deploy', `${program}.so`);
    const keypairPath = join(process.cwd(), keypairDir, `${program}-keypair.json`);
    
    for (let attempt = 1; attempt <= maxRetries && !deployed; attempt++) {
      if (attempt > 1) {
        logger.warning(`Retry ${attempt}/${maxRetries} for ${program} in ${retryDelayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
      
      logger.info(`Deploying ${program} to ${cluster}... (attempt ${attempt}/${maxRetries})`);
      
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
            timeout: deployTimeoutMs,
          }
        );
        logger.success(`${program} deployed successfully`);
        deployed = true;
      } catch (error: any) {
        if (attempt === maxRetries) {
          if (error.killed) {
            throw new Error(`Deployment of ${program} timed out after ${maxRetries} attempts.`);
          }
          throw new Error(`Failed to deploy ${program} after ${maxRetries} attempts: ${error.message || error}`);
        }
        logger.warning(`Attempt ${attempt} failed for ${program}`);
      }
    }
    
    // Delay between programs to let the network settle
    if (program !== programs[programs.length - 1]) {
      logger.info(`Waiting ${programDelayMs / 1000}s before next program...`);
      await new Promise(resolve => setTimeout(resolve, programDelayMs));
    }
  }

  // Read deployed program IDs from keypair files
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

/**
 * Verify deployed programs are on-chain and executable
 */
export async function verifyPrograms(
  provider: AnchorProvider,
  programIds: ProgramIds
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
