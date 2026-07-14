/**
 * Program deployment utilities
 */

import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { DEPLOYMENT_CONFIG } from '../../config/networks';

/**
 * Discriminator for the BPFLoaderUpgradeable `Program` variant. The
 * ProgramData account address is stored at offset 4 (after the 4-byte
 * variant tag) for 32 bytes. See agave-program-runtime's
 * UpgradeableLoaderState enum for the canonical layout.
 */
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111'
);

/**
 * Outcome of inspecting a program ID on chain before attempting deploy.
 * 'deploy' means the slot is empty (or doesn't match what we want), proceed
 * with the full deploy. 'skip-already-deployed' means the program is already
 * on chain at the right size with our wallet as upgrade authority -- typical
 * partial-success-recovery case where a prior run finalized one program but
 * died before the next. 'abort-foreign-authority' means the slot is occupied
 * by someone else's program and we must not touch it.
 */
type DeployPrecheckOutcome =
  | { kind: 'deploy' }
  | { kind: 'skip-already-deployed'; reason: string }
  | { kind: 'abort-foreign-authority'; authority: string };

/**
 * Pre-deploy check that decides whether to run `solana program deploy` or
 * short-circuit. Compares on-chain program account state against the
 * local .so we're about to deploy. The local-file size check is the
 * fastest meaningful sanity test ("did the same .so make it on chain?")
 * without re-fetching and byte-comparing the full ProgramData.
 */
async function precheckProgram(
  provider: AnchorProvider,
  programId: PublicKey,
  localSoPath: string
): Promise<DeployPrecheckOutcome> {
  const accountInfo = await provider.connection.getAccountInfo(
    programId,
    'confirmed'
  );

  if (!accountInfo) {
    return { kind: 'deploy' };
  }

  // Program account exists. Confirm it's a BPFLoaderUpgradeable program.
  if (!accountInfo.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    return { kind: 'deploy' };
  }

  if (accountInfo.data.length < 36) {
    return { kind: 'deploy' };
  }
  const programDataAddr = new PublicKey(accountInfo.data.subarray(4, 36));
  const programDataInfo = await provider.connection.getAccountInfo(
    programDataAddr,
    'confirmed'
  );
  if (!programDataInfo) {
    return { kind: 'deploy' };
  }

  const optTag = programDataInfo.data[12];
  if (optTag !== 1) {
    return {
      kind: 'abort-foreign-authority',
      authority: '<none -- program is immutable>',
    };
  }
  const authority = new PublicKey(programDataInfo.data.subarray(13, 45));
  const ourWallet = provider.wallet.publicKey;
  if (!authority.equals(ourWallet)) {
    return {
      kind: 'abort-foreign-authority',
      authority: authority.toBase58(),
    };
  }

  const deployedElfLen = programDataInfo.data.length - 45;
  let localSoLen: number;
  try {
    localSoLen = statSync(localSoPath).size;
  } catch {
    return { kind: 'deploy' };
  }

  if (deployedElfLen !== localSoLen) {
    return { kind: 'deploy' };
  }

  return {
    kind: 'skip-already-deployed',
    reason: `program account exists at ${programId.toBase58()} with our wallet as authority and matching size (${deployedElfLen} bytes)`,
  };
}

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

  const programs = ['lite_psm'];
  const { maxRetries, retryDelayMs, programDelayMs, priorityFee, deployTimeoutMs } = DEPLOYMENT_CONFIG;
  
  logger.info(`Deployment config: priorityFee=${priorityFee}, maxRetries=${maxRetries}, retryDelay=${retryDelayMs/1000}s`);
  
  for (const program of programs) {
    let deployed = false;
    const programSoPath = join(process.cwd(), 'target/deploy', `${program}.so`);
    const keypairPath = join(process.cwd(), keypairDir, `${program}-keypair.json`);
    const programId = getProgramIdFromKeypair(keypairPath);

    const precheck = await precheckProgram(provider, programId, programSoPath);
    if (precheck.kind === 'skip-already-deployed') {
      logger.success(
        `${program}: already deployed at ${programId.toBase58()} — ${precheck.reason}. Skipping.`
      );
      deployed = true;
    } else if (precheck.kind === 'abort-foreign-authority') {
      throw new Error(
        `${program}: program account ${programId.toBase58()} exists on chain ` +
          `but upgrade authority is ${precheck.authority}, not our wallet ` +
          `${provider.wallet.publicKey.toBase58()}. Refusing to proceed. ` +
          `If you intend to redeploy, rotate the keypair via anchor keys sync ` +
          `or check that ANCHOR_WALLET is set correctly.`
      );
    }

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
        const wasKilled = error.killed === true || /ETIMEDOUT/i.test(error.message || '');
        if (wasKilled) {
          logger.warning(
            `${program}: solana CLI killed (timeout or signal) — checking chain for finalization before declaring failure...`
          );
          await new Promise(resolve => setTimeout(resolve, 3000));
          const recheck = await precheckProgram(provider, programId, programSoPath);
          if (recheck.kind === 'skip-already-deployed') {
            logger.success(
              `${program}: post-timeout recheck shows program IS on chain at ${programId.toBase58()} — ${recheck.reason}. Treating the CLI timeout as a false alarm.`
            );
            deployed = true;
            continue;
          }
        }

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
  };

  logger.success(`lite_psm: ${programIds.litePsm.toBase58()}`);

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
