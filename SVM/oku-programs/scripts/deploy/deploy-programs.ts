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
 *   npm run deploy:programs
 * 
 *   # Deploy to devnet fork (Surfpool). NOTE: `deploy:programs` hard-sets
 *   # NETWORK=devnet, so a NETWORK= prefix on it is ignored. Use the variant:
 *   npm run deploy:programs:devnet-fork
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { detectNetwork, createProvider,
  createProviderWithClusterCheck, getNetworkConfig, isForkNetwork, getParentNetwork } from '../utils/network';
import { confirmIfMainnet } from '../admin/_lib/confirm';
import { logger } from '../utils/logger';
import * as path from 'path';
import { saveDeployment } from '../utils/addressBook';
import { recordDeployBaseline } from '../upgrade/lib/baseline';
import { NETWORK_CONFIGS, getActiveRpcInfo } from '../config/networks';
import { withProgramsBuilt, deployPrograms, verifyPrograms } from './lib';

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM - Deploy Programs');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const isFork = isForkNetwork(network);

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.info(`Mode: ${isFork ? 'Fork' : 'Live'}`);
  
  // Log RPC source for live networks
  if (!isFork && (network === 'devnet' || network === 'mainnet-beta')) {
    const rpcInfo = getActiveRpcInfo(network === 'devnet' ? 'devnet' : 'mainnet');
    logger.info(`RPC source: ${rpcInfo.source}`);
  }
  logger.log('');

  // Create provider. Cluster-checked: deploying a program is irreversible, and
  // a SOLANA_RPC_URL pointed at the wrong cluster is not otherwise detectable.
  const provider = await createProviderWithClusterCheck(network);
  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);

  await confirmIfMainnet(
    network,
    [
      `network   ${network}`,
      `deployer  ${deployerPubkey.toBase58()}`,
      `balance   ${formatSol(balance)} SOL`,
      `action    deploy lite_psm program (irreversible)`,
    ].join('\n'),
    provider.connection
  );

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

  // Build + deploy. A fork build swaps fork keypairs into the live workspace;
  // withProgramsBuilt restores them on every exit path, including a failed
  // build or `anchor keys sync`.
  const programIds = await withProgramsBuilt(isFork, () => deployPrograms(provider, isFork));
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
    },
  });

  // Upgrade baseline: the IDL of the ELF that is now on-chain, bound by its
  // hash. The upgrade script diffs the next build against this.
  const baseline = await recordDeployBaseline({
    network,
    connection: provider.connection,
    programId: programIds.litePsm,
    deployer: deployerPubkey,
    soPath: path.join(process.cwd(), 'target/deploy/lite_psm.so'),
    idlPath: path.join(process.cwd(), 'target/idl/lite_psm.json'),
  });
  if (baseline.recorded) {
    logger.success(`Upgrade baseline recorded (deployments/idl/${baseline.file})`);
  } else {
    logger.warning(
      'On-chain ELF differs from target/deploy/lite_psm.so (program reused from an earlier build?); ' +
        'no upgrade baseline recorded. The first upgrade will need IDL_BASELINE=<deployed IDL>.'
    );
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Programs Deployed Successfully');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Program IDs saved to: deployments/' + network + '.json');
  logger.info('');

  // Anchor.toml hygiene: post-deploy, the operator should update the
  // network-specific section to the freshly-deployed IDs. We deliberately
  // keep [programs.devnet] and [programs.localnet] as SEPARATE sections
  // (even when they currently coincide) — this preserves the option to
  // rotate one cluster's keypairs without forcing the other to follow.
  if (network === 'devnet' || network === 'mainnet-beta') {
    const tomlSection =
      network === 'mainnet-beta' ? 'mainnet' : network;
    logger.warning('Update Anchor.toml manually:');
    logger.log('');
    logger.log(`[programs.${tomlSection}]`);
    logger.log(`lite_psm   = "${programIds.litePsm.toBase58()}"`);
    logger.log('');
    logger.info(
      'Until Anchor.toml matches, the [addressBook] mismatch warning will'
    );
    logger.info('fire on every admin script invocation.');
    logger.log('');
  }

  logger.info('Next step: Run initialization');
  logger.info(`  npm run deploy:init`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
