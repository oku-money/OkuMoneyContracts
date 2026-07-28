/**
 * Token deployment utilities
 *
 * Single-token model: only a mock USDC mint is created externally.
 * The OkuM mint (Token-2022 with ScaledUiAmount + MetadataPointer +
 * TokenMetadata) is created on-chain by the `initialize` instruction
 * via CPIs -- see `programs/lite-psm/src/instructions/init.rs`.
 */

import { PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { createSPLTokenMint } from '../../utils/tokenHelpers';
import { USDC_DECIMALS } from '../../config/constants';
import { loadDeployment } from '../../utils/addressBook';
import { NetworkName } from '../../config/networks';

export interface DeployedTokens {
  usdcMint: PublicKey;
}

/**
 * Deploy the mock USDC mint (devnet/localnet only).
 *
 * Reuses any USDC mint already saved in `deployments/<network>.json`.
 * The OkuM mint is NOT created here -- it's created on-chain by the
 * PSM's `initialize` instruction.
 */
export async function deployTokens(
  provider: AnchorProvider,
  _psmConfigPDA: PublicKey,
  network: NetworkName
): Promise<DeployedTokens> {
  const existing = loadDeployment(network);
  const existingUsdc = existing?.tokens?.usdc;

  if (existingUsdc) {
    logger.nextStep('Reusing existing USDC mint (idempotent)');
    logger.info(`USDC mint: ${existingUsdc}`);
    return { usdcMint: new PublicKey(existingUsdc) };
  }

  logger.nextStep('Deploying Mock USDC');

  const usdcMint = await createSPLTokenMint(
    provider.connection,
    provider.wallet.payer,
    USDC_DECIMALS,
    provider.wallet.publicKey, // mint authority = deployer (for testing)
    null
  );

  return { usdcMint };
}
