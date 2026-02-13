#!/usr/bin/env tsx
/**
 * 001-deploy-tokens.ts
 *
 * Creates token mints:
 * - Localnet: Mock USDC + OkuUSD (Token-2022)
 * - Devnet/Mainnet: OkuUSD only (USDC already exists)
 */

import { PublicKey, Connection } from '@solana/web3.js';
import {
  detectNetwork,
  createProvider,
  getNetworkConfig,
} from '../utils/network';
import { logger } from '../utils/logger';
import {
  saveDeployment,
  loadDeployment,
  updateDeployment,
} from '../utils/addressBook';
import { createToken2022Mint, createSPLTokenMint } from '../utils/tokenHelpers';
import { loadAuthorities } from '../config/authorities';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import {
  USDC_DECIMALS,
  OKUSD_DECIMALS,
  INITIAL_INTEREST_RATE_BPS,
  PROGRAM_IDS,
} from '../config/constants';

/**
 * Check if an account exists on-chain
 */
async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  try {
    const accountInfo = await connection.getAccountInfo(address);
    return accountInfo !== null;
  } catch {
    return false;
  }
}

async function main() {
  logger.header('Deploy Tokens (001)');

  const network = detectNetwork();
  const config = getNetworkConfig(network);
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.info(`Cluster: ${config.cluster}`, false);
  logger.log('');

  const deployment = loadDeployment(network) || {
    network,
    timestamp: new Date().toISOString(),
    tokens: {},
    programs: {},
    pdas: {},
  };

  // Derive PSM config PDA (needed for mint authority)
  const litePsmProgramId = PROGRAM_IDS[network].litePsm;
  const [psmConfigPDA] = derivePsmConfigPDA(litePsmProgramId);

  logger.section('Token Deployment');

  // 1. Handle USDC
  let usdcMint: PublicKey;

  if (config.usdc.isNative) {
    // Localnet: Create mock USDC
    if (deployment.tokens.usdc) {
      const existingUsdcMint = new PublicKey(deployment.tokens.usdc);
      // Verify it actually exists on-chain (could be stale after validator reset)
      if (await accountExists(provider.connection, existingUsdcMint)) {
        logger.info(`Using existing USDC: ${deployment.tokens.usdc}`);
        usdcMint = existingUsdcMint;
      } else {
        logger.warning('Deployment manifest has stale USDC address, creating new one...');
        logger.info('Creating mock USDC (SPL Token)...');
        usdcMint = await createSPLTokenMint(
          provider.connection,
          provider.wallet.payer,
          USDC_DECIMALS,
          provider.wallet.publicKey, // Mint authority (for testing)
          null // No freeze authority
        );

        updateDeployment(network, 'tokens', { usdc: usdcMint.toBase58() });
      }
    } else {
      logger.info('Creating mock USDC (SPL Token)...');
      usdcMint = await createSPLTokenMint(
        provider.connection,
        provider.wallet.payer,
        USDC_DECIMALS,
        provider.wallet.publicKey, // Mint authority (for testing)
        null // No freeze authority
      );

      updateDeployment(network, 'tokens', { usdc: usdcMint.toBase58() });
    }
  } else {
    // Devnet/Mainnet: Use existing USDC
    usdcMint = config.usdc.mint;
    logger.success(`Using existing USDC: ${usdcMint.toBase58()}`);

    updateDeployment(network, 'tokens', { usdc: usdcMint.toBase58() });
  }

  // 2. Create OkuUSD (Token-2022)
  let okusdMint: PublicKey;

  if (deployment.tokens.okusd) {
    const existingOkusdMint = new PublicKey(deployment.tokens.okusd);
    // Verify it actually exists on-chain (could be stale after validator reset)
    if (await accountExists(provider.connection, existingOkusdMint)) {
      logger.info(`Using existing OkuUSD: ${deployment.tokens.okusd}`);
      okusdMint = existingOkusdMint;
    } else {
      logger.warning('Deployment manifest has stale OkuUSD address, creating new one...');
      logger.info('Creating OkuUSD (Token-2022 with Interest-Bearing)...');
      okusdMint = await createToken2022Mint({
        connection: provider.connection,
        payer: provider.wallet.payer,
        decimals: OKUSD_DECIMALS,
        mintAuthority: psmConfigPDA, // PSM will mint
        freezeAuthority: psmConfigPDA, // PSM will freeze (compliance)
        rateAuthority: authorities.psm.rebaser, // Orchestrator updates rate
        initialRate: INITIAL_INTEREST_RATE_BPS,
      });

      updateDeployment(network, 'tokens', { okusd: okusdMint.toBase58() });
    }
  } else {
    logger.info('Creating OkuUSD (Token-2022 with Interest-Bearing)...');

    okusdMint = await createToken2022Mint({
      connection: provider.connection,
      payer: provider.wallet.payer,
      decimals: OKUSD_DECIMALS,
      mintAuthority: psmConfigPDA, // PSM will mint
      freezeAuthority: psmConfigPDA, // PSM will freeze (compliance)
      rateAuthority: authorities.psm.rebaser, // Orchestrator updates rate
      initialRate: INITIAL_INTEREST_RATE_BPS,
    });

    updateDeployment(network, 'tokens', { okusd: okusdMint.toBase58() });

    logger.log('');
    logger.warning(
      'IMPORTANT: Mint/freeze authorities are set to PSM config PDA',
      false
    );
    logger.warning('PSM config must be initialized before minting', false);
  }

  // Summary
  logger.log('');
  logger.section('Deployment Summary');
  logger.table({
    Network: network,
    'USDC Mint': usdcMint.toBase58(),
    'OkuUSD Mint (Token-2022)': okusdMint.toBase58(),
    'PSM Config PDA (Mint Auth)': psmConfigPDA.toBase58(),
    'Rate Authority': authorities.psm.rebaser.toBase58(),
  });

  logger.log('');
  logger.success('Token deployment complete!', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
