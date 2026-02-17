/**
 * Validator health check utilities
 * Ensures the validator is running and healthy before deployment
 */

import { Connection } from '@solana/web3.js';
import { execSync } from 'child_process';
import { NetworkName } from '../config/networks';
import { logger } from './logger';

/**
 * Check if validator is responding and producing blocks
 */
export async function checkValidatorHealth(
  connection: Connection,
  network: NetworkName
): Promise<boolean> {
  if (network !== 'localnet') {
    return true; // Only check localnet
  }

  try {
    // Test 1: Check if validator is responding
    logger.info('Checking validator connection...', false);
    const version = await connection.getVersion();

    // Test 2: Check if validator is producing blocks
    logger.info('Checking validator is producing blocks...', false);

    // Give validator time to start producing blocks (especially if just started)
    let isProducingBlocks = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const slot1 = await connection.getSlot();
      await new Promise(resolve => setTimeout(resolve, 2000));
      const slot2 = await connection.getSlot();

      if (slot2 > slot1) {
        isProducingBlocks = true;
        break;
      }

      // If first attempt failed, wait a bit longer before retrying
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!isProducingBlocks) {
      logger.error('Validator is stuck (not producing blocks after 3 attempts)', false);
      return false;
    }

    // Test 3: Check for multiple validator instances
    try {
      const processes = execSync(
        'ps aux | grep solana-test-validator | grep -v grep | wc -l',
        { encoding: 'utf-8' }
      ).trim();

      const count = parseInt(processes);
      if (count > 2) { // 2 = validator + sh wrapper
        logger.warning(`Found ${count} validator processes (expected 1-2)`, false);
        logger.warning('Multiple validators may cause conflicts', false);
        logger.info('Run: npm run localnet:stop && npm run localnet:start', false);
        return false;
      }
    } catch {
      // Ignore - process check failed but validator might still work
    }

    logger.success('Validator health check passed', false);
    return true;
  } catch (error: any) {
    logger.error('Cannot connect to validator', false);
    logger.info('Make sure validator is running:', false);
    logger.info('  npm run localnet:start', false);
    return false;
  }
}

/**
 * Reset validator (if AUTO_RESET=true)
 * Only use this if you're sure you want to kill existing validators
 */
export async function resetValidatorIfRequested(network: NetworkName): Promise<void> {
  if (network !== 'localnet') return;

  const autoReset = process.env.AUTO_RESET === 'true';
  if (!autoReset) return;

  logger.warning('AUTO_RESET enabled - resetting validator...', false);

  try {
    // Kill existing validators
    execSync('pkill -9 solana-test-validator 2>/dev/null || true');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Clean ledger
    execSync('rm -rf test-ledger');

    // Start fresh validator in background
    logger.info('Starting fresh validator...', false);
    execSync('solana-test-validator --reset > validator.log 2>&1 &');

    // Wait for it to start and stabilize
    logger.info('Waiting for validator to stabilize...', false);
    await new Promise(resolve => setTimeout(resolve, 8000));

    logger.success('Fresh validator started', false);
  } catch (error: any) {
    logger.error(`Failed to reset validator: ${error.message}`, false);
    throw error;
  }
}

/**
 * Get helpful error message when validator health check fails
 */
export function getValidatorHelpMessage(network: NetworkName): string {
  if (network !== 'localnet') return '';

  return `
Validator Issues Detected!

Quick Fix Options:

1. Fresh Start (Recommended):
   npm run localnet:deploy:fresh

2. Manual Control:
   npm run localnet:stop
   npm run localnet:start
   npm run deploy

3. Auto-Reset (use with caution):
   AUTO_RESET=true npm run deploy

Troubleshooting:
- Check if multiple validators are running: ps aux | grep solana-test-validator
- Kill stuck validators: npm run localnet:stop
- Clean all data: npm run clean:all
`;
}
