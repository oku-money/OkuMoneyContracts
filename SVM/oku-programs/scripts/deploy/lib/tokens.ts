/**
 * Token deployment utilities
 */

import { PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { createSPLTokenMint, createToken2022Mint } from '../../utils/tokenHelpers';
import { loadAuthorities } from '../../config/authorities';
import { USDC_DECIMALS, OKUSD_DECIMALS } from '../../config/constants';

export interface DeployedTokens {
  usdcMint: PublicKey;
  okuMoneyMint: PublicKey;
}

/**
 * Deploy fresh tokens for testing
 */
export async function deployTokens(
  provider: AnchorProvider,
  psmConfigPDA: PublicKey,
  authorities: ReturnType<typeof loadAuthorities>
): Promise<DeployedTokens> {
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
