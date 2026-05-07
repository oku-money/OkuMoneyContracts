/**
 * Token deployment utilities
 */

import { PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { createSPLTokenMint, createToken2022Mint } from '../../utils/tokenHelpers';
import { loadAuthorities } from '../../config/authorities';
import { USDC_DECIMALS, OKUSD_DECIMALS } from '../../config/constants';
import { loadDeployment } from '../../utils/addressBook';
import { NetworkName } from '../../config/networks';

export interface DeployedTokens {
  usdcMint: PublicKey;
  okuMoneyMint: PublicKey;
}

/**
 * Deploy tokens, reusing any mints already saved in `deployments/<network>.json`.
 *
 * Without idempotency, re-running `deploy:init` after a successful run silently
 * mints fresh USDC / OkuMoney keypairs, then attempts to re-`initialize` the
 * PSM (which fails on `AccountAlreadyInitialized`). The fresh mints become
 * orphan accounts and the deployment file is overwritten with addresses
 * users on the OLD mint can no longer redeem against.
 *
 * Behavior:
 *   - If `deployments/<network>.json` already lists `tokens.usdc` and
 *     `tokens.okuMoney`, return those PublicKeys verbatim.
 *   - If only one is present, error loudly — partial state usually means a
 *     half-completed previous run that needs manual cleanup.
 *   - Otherwise, mint fresh keypairs.
 */
export async function deployTokens(
  provider: AnchorProvider,
  psmConfigPDA: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>,
  network: NetworkName
): Promise<DeployedTokens> {
  const existing = loadDeployment(network);
  const existingUsdc = existing?.tokens?.usdc;
  const existingOkuMoney = existing?.tokens?.okuMoney;

  if (existingUsdc && existingOkuMoney) {
    logger.nextStep('Reusing existing tokens (idempotent)');
    logger.info(`USDC mint:     ${existingUsdc}`);
    logger.info(`OkuMoney mint: ${existingOkuMoney}`);
    return {
      usdcMint: new PublicKey(existingUsdc),
      okuMoneyMint: new PublicKey(existingOkuMoney),
    };
  }

  if (existingUsdc || existingOkuMoney) {
    throw new Error(
      `Partial token state detected for network "${network}" — usdc=${existingUsdc} ` +
        `okuMoney=${existingOkuMoney}. Aborting to avoid creating orphans. ` +
        `Either restore the missing field manually or run \`npm run clean\` ` +
        `to start over.`
    );
  }

  logger.nextStep('Deploying Tokens (Fresh)');

  // Create Mock USDC (standard SPL token)
  logger.info('Creating Mock USDC...');
  const usdcMint = await createSPLTokenMint(
    provider.connection,
    provider.wallet.payer,
    USDC_DECIMALS,
    provider.wallet.publicKey, // mint authority = deployer (for testing)
    null
  );

  // Create OkuMoney (Token-2022 with interest-bearing extension)
  logger.info('Creating OkuMoney (Token-2022)...');
  const okuMoneyMint = await createToken2022Mint({
    connection: provider.connection,
    payer: provider.wallet.payer,
    decimals: OKUSD_DECIMALS,
    mintAuthority: psmConfigPDA, // PSM controls minting
    freezeAuthority: psmConfigPDA,
    rateAuthority: authorities.psm.rebaser,
    initialRate: 0, // 0% initial rate
  });

  return { usdcMint, okuMoneyMint };
}
