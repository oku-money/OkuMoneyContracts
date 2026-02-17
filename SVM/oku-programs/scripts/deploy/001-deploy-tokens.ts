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
import { loadDeployment, updateDeployment } from '../utils/addressBook';
import { createToken2022Mint, createSPLTokenMint } from '../utils/tokenHelpers';
import { loadAuthorities } from '../config/authorities';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import {
  USDC_DECIMALS,
  OKUSD_DECIMALS,
  INITIAL_INTEREST_RATE_BPS,
  PROGRAM_IDS,
} from '../config/constants';

async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(address);
  return accountInfo !== null;
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
    // Localnet: Create mock USDC (or reuse existing)
    const existing = deployment.tokens.usdc ? new PublicKey(deployment.tokens.usdc) : null;

    if (existing && await accountExists(provider.connection, existing)) {
      logger.info(`Using existing USDC: ${existing.toBase58()}`);
      usdcMint = existing;
    } else {
      if (existing) logger.warning('Stale USDC address in manifest, creating new one...');
      logger.info('Creating mock USDC (SPL Token)...');
      usdcMint = await createSPLTokenMint(
        provider.connection,
        provider.wallet.payer,
        USDC_DECIMALS,
        provider.wallet.publicKey,
        null
      );
      updateDeployment(network, 'tokens', { usdc: usdcMint.toBase58() });
    }
  } else {
    // Devnet/Mainnet: Use existing USDC
    usdcMint = config.usdc.mint;
    logger.success(`Using existing USDC: ${usdcMint.toBase58()}`);
    updateDeployment(network, 'tokens', { usdc: usdcMint.toBase58() });
  }

  // 2. Create OkuUSD (Token-2022) or reuse existing
  let okusdMint: PublicKey;
  const existingOkusd = deployment.tokens.okusd ? new PublicKey(deployment.tokens.okusd) : null;

  if (existingOkusd && await accountExists(provider.connection, existingOkusd)) {
    logger.info(`Using existing OkuUSD: ${existingOkusd.toBase58()}`);
    okusdMint = existingOkusd;
  } else {
    if (existingOkusd) logger.warning('Stale OkuUSD address in manifest, creating new one...');
    logger.info('Creating OkuUSD (Token-2022 with Interest-Bearing)...');
    okusdMint = await createToken2022Mint({
      connection: provider.connection,
      payer: provider.wallet.payer,
      decimals: OKUSD_DECIMALS,
      mintAuthority: psmConfigPDA,
      freezeAuthority: psmConfigPDA,
      rateAuthority: authorities.psm.rebaser,
      initialRate: INITIAL_INTEREST_RATE_BPS,
    });
    updateDeployment(network, 'tokens', { okusd: okusdMint.toBase58() });

    logger.log('');
    logger.warning('IMPORTANT: Mint/freeze authorities are set to PSM config PDA', false);
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
