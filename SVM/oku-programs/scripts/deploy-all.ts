#!/usr/bin/env tsx
/**
 * deploy-all.ts
 *
 * Master deployment orchestration script
 * Runs all deployment scripts in sequence: 001-007
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { logger } from './utils/logger';
import { detectNetwork, confirmMainnetDeployment, isForkNetwork, getParentNetwork } from './utils/network';

interface DeploymentStep {
  name: string;
  script: string;
}

// All steps run for all networks - fork networks deploy fresh just like live networks
const DEPLOYMENT_SCRIPTS: DeploymentStep[] = [
  { name: 'Deploy Tokens', script: 'scripts/deploy/001-deploy-tokens.ts' },
  { name: 'Deploy Programs', script: 'scripts/deploy/002-deploy-programs.ts' },
  { name: 'Initialize PSM', script: 'scripts/deploy/003-initialize-psm.ts' },
  { name: 'Initialize Vault', script: 'scripts/deploy/004-initialize-vault.ts' },
  { name: 'Initialize Bridge', script: 'scripts/deploy/005-initialize-bridge.ts' },
  { name: 'Initialize Router', script: 'scripts/deploy/006-initialize-router.ts' },
  { name: 'Verify Deployment', script: 'scripts/deploy/007-verify-deployment.ts' },
];

async function main() {
  logger.header('OkuUSD SVM Deployment');

  const network = detectNetwork();
  const isForked = isForkNetwork(network);

  logger.info(`Network: ${network}`, false);
  if (isForked) {
    logger.info(`Mode: Fork (inherits network state like oracles, deploys fresh contracts)`, false);
  }
  logger.info(`Total steps: ${DEPLOYMENT_SCRIPTS.length}`, false);
  logger.log('');

  // Mainnet confirmation (also for mainnet-fork to be safe)
  if (network === 'mainnet-beta' || network === 'mainnet-fork') {
    const confirmed = await confirmMainnetDeployment();
    if (!confirmed) {
      logger.error('Mainnet deployment cancelled', false);
      process.exit(1);
    }
  }

  logger.warning('Starting deployment sequence...', false);
  logger.log('');

  const startTime = Date.now();
  const results: Array<{ step: number; name: string; status: string; duration: number }> =
    [];

  // Execute each script in sequence
  for (let i = 0; i < DEPLOYMENT_SCRIPTS.length; i++) {
    const { name, script } = DEPLOYMENT_SCRIPTS[i];
    const stepNum = i + 1;

    logger.section(`[${stepNum}/${DEPLOYMENT_SCRIPTS.length}] ${name}`);

    const stepStart = Date.now();

    try {
      execSync(`tsx ${script}`, {
        stdio: 'inherit',
        env: process.env,
      });

      const duration = Date.now() - stepStart;
      results.push({
        step: stepNum,
        name,
        status: 'SUCCESS',
        duration,
      });

      logger.success(`Step ${stepNum} completed in ${(duration / 1000).toFixed(2)}s`, false);
      logger.log('');
    } catch (error) {
      const duration = Date.now() - stepStart;
      results.push({
        step: stepNum,
        name,
        status: 'FAILED',
        duration,
      });

      logger.error(`Step ${stepNum} failed after ${(duration / 1000).toFixed(2)}s`, false);
      logger.log('');

      // Print summary up to failure
      printSummary(results, startTime, false);

      logger.error('Deployment failed. Fix errors and re-run.', false);
      process.exit(1);
    }
  }

  // All steps completed successfully
  printSummary(results, startTime, true);

  logger.log('');
  logger.success('🎉 Deployment complete!', false);
  logger.log('');
  logger.info('Next steps:', false);
  logger.info('1. Run: npm run simulate:verify -- to verify state', false);
  logger.info('2. Run: npm run simulate:full -- to test full user flow', false);
  logger.log('');
}

function printSummary(
  results: Array<{ step: number; name: string; status: string; duration: number }>,
  startTime: number,
  success: boolean
) {
  const totalDuration = Date.now() - startTime;

  logger.section('Deployment Summary');

  for (const result of results) {
    const icon = result.status === 'SUCCESS' ? '✓' : '✗';
    const color = result.status === 'SUCCESS' ? '\x1b[32m' : '\x1b[31m';
    console.log(
      `${color}${icon}\x1b[0m Step ${result.step}: ${result.name} (${(result.duration / 1000).toFixed(2)}s)`
    );
  }

  logger.log('');
  logger.table({
    'Total Steps': results.length.toString(),
    'Successful': results.filter((r) => r.status === 'SUCCESS').length.toString(),
    'Failed': results.filter((r) => r.status === 'FAILED').length.toString(),
    'Total Duration': `${(totalDuration / 1000).toFixed(2)}s`,
    Status: success ? 'SUCCESS' : 'FAILED',
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Deployment orchestration failed', false);
    console.error(error);
    process.exit(1);
  });
