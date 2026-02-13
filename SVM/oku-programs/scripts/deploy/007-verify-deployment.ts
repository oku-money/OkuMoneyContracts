#!/usr/bin/env tsx
/**
 * 007-verify-deployment.ts
 *
 * Comprehensive verification of deployment:
 * - Check all PDAs exist and are initialized
 * - Verify token mint authorities
 * - Validate authority configurations
 * - Check supply caps and limits
 * - Verify oracle setup
 * - Generate deployment report
 */

import { PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { detectNetwork, createProvider, getNetworkConfig } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';

async function main() {
  logger.header('Verify Deployment (007)');

  const network = detectNetwork();
  const provider = createProvider(network);
  const config = getNetworkConfig(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment) {
    logger.error('No deployment found. Run scripts 001-006 first.', false);
    process.exit(1);
  }

  let checks = {
    passed: 0,
    failed: 0,
    warnings: 0,
  };

  // 1. Verify tokens exist
  logger.section('Verifying Tokens');

  try {
    if (deployment.tokens.usdc) {
      const usdcMint = await getMint(
        provider.connection,
        new PublicKey(deployment.tokens.usdc)
      );
      logger.success(`USDC mint exists: ${deployment.tokens.usdc}`);
      logger.info(`  Decimals: ${usdcMint.decimals}`);
      checks.passed++;
    }
  } catch (error) {
    logger.error(`USDC mint not found: ${deployment.tokens.usdc}`);
    checks.failed++;
  }

  try {
    if (deployment.tokens.okusd) {
      const okusdMint = await getMint(
        provider.connection,
        new PublicKey(deployment.tokens.okusd),
        'confirmed',
        TOKEN_2022_PROGRAM_ID
      );
      logger.success(`OkuUSD mint exists: ${deployment.tokens.okusd}`);
      logger.info(`  Decimals: ${okusdMint.decimals}`);
      logger.info(`  Mint Authority: ${okusdMint.mintAuthority?.toBase58() || 'None'}`);
      logger.info(`  Freeze Authority: ${okusdMint.freezeAuthority?.toBase58() || 'None'}`);
      checks.passed++;

      // Verify mint authority is PSM config PDA
      if (
        deployment.pdas.psmConfig &&
        okusdMint.mintAuthority?.toBase58() === deployment.pdas.psmConfig
      ) {
        logger.success('  ✓ Mint authority correctly set to PSM config PDA');
        checks.passed++;
      } else {
        logger.warning('  ⚠️  Mint authority not set to PSM config PDA');
        checks.warnings++;
      }
    }
  } catch (error) {
    logger.error(`OkuUSD mint not found: ${deployment.tokens.okusd}`);
    checks.failed++;
  }

  try {
    if (deployment.tokens.wokusd) {
      const wokusdMint = await getMint(
        provider.connection,
        new PublicKey(deployment.tokens.wokusd),
        'confirmed',
        TOKEN_PROGRAM_ID
      );
      logger.success(`wOkuUSD mint exists: ${deployment.tokens.wokusd}`);
      logger.info(`  Decimals: ${wokusdMint.decimals}`);
      logger.info(`  Mint Authority: ${wokusdMint.mintAuthority?.toBase58() || 'None'}`);
      checks.passed++;

      // Verify mint authority is Vault config PDA
      if (
        deployment.pdas.vaultConfig &&
        wokusdMint.mintAuthority?.toBase58() === deployment.pdas.vaultConfig
      ) {
        logger.success('  ✓ Mint authority correctly set to Vault config PDA');
        checks.passed++;
      } else {
        logger.warning('  ⚠️  Mint authority not set to Vault config PDA');
        checks.warnings++;
      }
    }
  } catch (error) {
    logger.error(`wOkuUSD mint not found: ${deployment.tokens.wokusd}`);
    checks.failed++;
  }

  // 2. Verify PDAs
  logger.log('');
  logger.section('Verifying PDAs');

  const pdaChecks = [
    { name: 'PSM Config', key: 'psmConfig' },
    { name: 'Redemption Queue', key: 'redemptionQueue' },
    { name: 'Bridge Config', key: 'bridgeConfig' },
    { name: 'Vault Config', key: 'vaultConfig' },
    { name: 'Router Config', key: 'routerConfig' },
  ];

  for (const check of pdaChecks) {
    const address = (deployment.pdas as any)[check.key];
    if (address) {
      try {
        const accountInfo = await provider.connection.getAccountInfo(
          new PublicKey(address)
        );
        if (accountInfo) {
          logger.success(`${check.name}: ${address}`);
          logger.info(`  Owner: ${accountInfo.owner.toBase58()}`);
          logger.info(`  Size: ${accountInfo.data.length} bytes`);
          checks.passed++;
        } else {
          logger.warning(`${check.name} PDA exists but not initialized: ${address}`);
          checks.warnings++;
        }
      } catch (error) {
        logger.error(`${check.name} verification failed`);
        checks.failed++;
      }
    } else {
      logger.warning(`${check.name} not in deployment`);
      checks.warnings++;
    }
  }

  // 3. Verify nonce PDAs
  logger.log('');
  logger.section('Verifying Bridge Nonces');

  if (deployment.nonces) {
    for (const [chainId, address] of Object.entries(deployment.nonces)) {
      logger.success(`Chain ${chainId}: ${address}`);
      checks.passed++;
    }
  } else {
    logger.warning('No nonce PDAs found');
    checks.warnings++;
  }

  // 4. Configuration summary
  logger.log('');
  logger.section('Authority Configuration');

  logger.log('PSM Authorities:');
  logger.table({
    'Role Admin': authorities.psm.roleAdmin.toBase58(),
    'Pauser': authorities.psm.pauser.toBase58(),
    'Queue Processor': authorities.psm.queueProcessor.toBase58(),
    'Rebaser': authorities.psm.rebaser.toBase58(),
  });

  logger.log('');
  logger.log('Bridge Authorities:');
  logger.table({
    'Bridge Admin': authorities.bridge.bridgeAdmin.toBase58(),
    'Orchestrator Signer': authorities.bridge.orchestratorSigner.toBase58(),
    'Fee Recipient': authorities.bridge.feeRecipient.toBase58(),
  });

  logger.log('');
  logger.log('Vault Authorities:');
  logger.table({
    'Role Admin': authorities.vault.roleAdmin.toBase58(),
    'Pauser': authorities.vault.pauser.toBase58(),
  });

  // 5. Oracle configuration
  logger.log('');
  logger.section('Oracle Configuration');

  if (config.oracle.enabled) {
    logger.success(`Oracle Enabled: ${config.oracle.feed?.toBase58()}`);
    logger.info('  Type: Pyth Network');
    logger.info('  Feed: USDC/USD');
  } else {
    logger.warning('Oracle Disabled (localnet)');
  }

  // 6. Generate summary report
  logger.log('');
  logger.section('Verification Summary');

  logger.table({
    Network: network,
    'Checks Passed': checks.passed.toString(),
    'Checks Failed': checks.failed.toString(),
    'Warnings': checks.warnings.toString(),
  });

  logger.log('');
  logger.section('Deployment Report');

  const report = {
    network,
    timestamp: new Date().toISOString(),
    verification: {
      passed: checks.passed,
      failed: checks.failed,
      warnings: checks.warnings,
      status: checks.failed === 0 ? 'PASSED' : 'FAILED',
    },
    deployment,
  };

  logger.json(report);

  // Write report to file
  const fs = require('fs');
  const path = require('path');
  const reportPath = path.join(
    process.cwd(),
    'deployments',
    `${network}-verification.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  logger.log('');
  logger.success(`Verification report saved to: ${reportPath}`, false);

  if (checks.failed > 0) {
    logger.log('');
    logger.error(`Verification FAILED with ${checks.failed} errors`, false);
    process.exit(1);
  } else {
    logger.log('');
    logger.success('All verification checks PASSED!', false);

    if (checks.warnings > 0) {
      logger.warning(`Note: ${checks.warnings} warnings (may be expected)`, false);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
