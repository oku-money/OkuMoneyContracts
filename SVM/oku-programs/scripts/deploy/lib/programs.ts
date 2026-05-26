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
 * on chain at the right size with our wallet as upgrade authority — typical
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
 *
 * Rationale: the deploy script orphaned a buffer + timed out in the last
 * run, but `oku_bridge_router` actually finalized on chain. Re-running
 * without this check would re-attempt a fresh deploy of the same .so,
 * which `solana program deploy` rejects with "Program already exists"
 * (after eating gas) — or worse, on a hash-collision shape, would
 * unnecessarily upgrade. Skipping cleanly is the right behavior.
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

  // Program account exists. Confirm it's a BPFLoaderUpgradeable program
  // (not somehow a regular account at the same pubkey, which would be
  // odd but possible if the keypair got recycled).
  if (!accountInfo.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    return { kind: 'deploy' }; // weird, but defer to actual deploy to surface a clear error
  }

  // Parse the Program account: 4-byte variant tag + 32-byte ProgramData
  // address. Reach into ProgramData to read the authority. We have to
  // fetch the ProgramData account separately.
  if (accountInfo.data.length < 36) {
    // Malformed Program account — let the deploy tool surface a real error
    return { kind: 'deploy' };
  }
  const programDataAddr = new PublicKey(accountInfo.data.subarray(4, 36));
  const programDataInfo = await provider.connection.getAccountInfo(
    programDataAddr,
    'confirmed'
  );
  if (!programDataInfo) {
    // Program exists but ProgramData doesn't — pathological state. Defer
    // to deploy tool, which will print a useful error.
    return { kind: 'deploy' };
  }

  // ProgramData layout (UpgradeableLoaderState::ProgramData):
  //   - 4-byte variant tag (3)
  //   - 8-byte slot
  //   - 1-byte option tag (1 = Some authority; 0 = None / final)
  //   - 32-byte authority (if Some)
  //   - <ELF bytes>
  // Total prefix when authority is Some: 4 + 8 + 1 + 32 = 45 bytes.
  // We need:
  //   - the authority pubkey (to confirm WE own it)
  //   - the data length excluding the prefix (to compare to .so size)
  const optTag = programDataInfo.data[12];
  if (optTag !== 1) {
    // No authority (finalized / immutable). We cannot upgrade. Abort.
    return {
      kind: 'abort-foreign-authority',
      authority: '<none — program is immutable>',
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

  // Authority matches. Compare deployed ELF size to local .so size as a
  // quick "looks like the same program" check. If they differ, the user
  // probably rebuilt and wants an upgrade — let the deploy tool handle it.
  const deployedElfLen = programDataInfo.data.length - 45;
  let localSoLen: number;
  try {
    localSoLen = statSync(localSoPath).size;
  } catch {
    return { kind: 'deploy' };
  }

  if (deployedElfLen !== localSoLen) {
    return {
      kind: 'deploy', // sizes differ — proceed (will be an upgrade, not initial deploy)
    };
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
    const programId = getProgramIdFromKeypair(keypairPath);

    // Pre-deploy resumability check. A previous run may have finalized
    // this program on chain but died before moving to the next; without
    // this skip, we'd re-attempt deploy (eating gas + orphaning buffers)
    // for a program that's already exactly what we want on chain.
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
        // Post-execSync recheck: empirically, on devnet under congestion the
        // `solana program deploy` subprocess often DOES finalize the program
        // on chain but takes a few minutes longer than `deployTimeoutMs` to
        // exit cleanly (it polls for tx confirmation past the actual
        // finalization). Node's `execSync` timeout kills the subprocess
        // mid-cleanup-poll AFTER on-chain success, surfacing a misleading
        // "ETIMEDOUT" / "killed" error.
        //
        // Before raising, re-query the chain. If the program is now in the
        // exact shape we'd accept on a fresh resumability check, treat the
        // exec failure as a false alarm.
        const wasKilled = error.killed === true || /ETIMEDOUT/i.test(error.message || '');
        if (wasKilled) {
          logger.warning(
            `${program}: solana CLI killed (timeout or signal) — checking chain for finalization before declaring failure...`
          );
          // Brief wait for the next RPC round-trip to see any tx that was
          // mined in the last few seconds.
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
