/**
 * Token deployment utilities
 *
 * Single-token model: the only mint created externally is a mock USDC, and only
 * on networks with no real USDC (`NETWORK_CONFIGS[n].usdc.isNative`). Networks with
 * a real USDC use the configured mint and never reach the mock creation (Cyfrin
 * audit finding #4: `PsmConfig.usdc_mint` is stored once and can never change).
 * The OkuM mint (Token-2022 with ScaledUiAmount + MetadataPointer +
 * TokenMetadata) is created on-chain by the `initialize` instruction
 * via CPIs -- see `programs/lite-psm/src/instructions/init.rs`.
 */

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { createSPLTokenMint } from '../../utils/tokenHelpers';
import { USDC_DECIMALS } from '../../config/constants';
import { loadDeployment } from '../../utils/addressBook';
import { NetworkName, NETWORK_CONFIGS } from '../../config/networks';

export interface DeployedTokens {
  usdcMint: PublicKey;
}

/** SPL Token `Mint` layout: `decimals` at byte 44, `is_initialized` at byte 45, 82 bytes. */
const SPL_MINT_LEN = 82;
const SPL_MINT_DECIMALS_OFFSET = 44;
const SPL_MINT_IS_INITIALIZED_OFFSET = 45;

/**
 * Refuse a configured reserve that is not a live 6-decimal classic SPL Token mint
 * on the connected cluster. `initialize` checks decimals but not that the mint is
 * the right one, and the choice is permanent.
 */
export async function assertConfiguredUsdcMint(
  provider: Pick<AnchorProvider, 'connection'>,
  mint: PublicKey
): Promise<void> {
  const info = await provider.connection.getAccountInfo(mint);
  if (!info) {
    throw new Error(`Configured USDC mint ${mint.toBase58()} does not exist on this cluster`);
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== SPL_MINT_LEN) {
    throw new Error(
      `Configured USDC mint ${mint.toBase58()} is not a classic SPL Token mint ` +
        `(owner ${info.owner.toBase58()}, ${info.data.length} bytes)`
    );
  }
  if (info.data[SPL_MINT_IS_INITIALIZED_OFFSET] !== 1) {
    throw new Error(`Configured USDC mint ${mint.toBase58()} is not initialized`);
  }
  if (info.data[SPL_MINT_DECIMALS_OFFSET] !== USDC_DECIMALS) {
    throw new Error(
      `Configured USDC mint ${mint.toBase58()} has ${info.data[SPL_MINT_DECIMALS_OFFSET]} decimals, expected ${USDC_DECIMALS}`
    );
  }
}

/**
 * Resolve the reserve (USDC) mint.
 *
 * - Real-USDC networks (`isNative` false, i.e. mainnet-beta and mainnet-fork):
 *   always the configured Circle mint. Any `tokens.usdc` in
 *   `deployments/<network>.json` is ignored and no mock is ever created.
 * - Mock networks (devnet, localnet): reuses any USDC mint already saved in
 *   `deployments/<network>.json`, else creates a mock with the deployer as mint
 *   authority.
 *
 * The OkuM mint is NOT created here -- it's created on-chain by the
 * PSM's `initialize` instruction.
 */
export async function deployTokens(
  provider: AnchorProvider,
  _psmConfigPDA: PublicKey,
  network: NetworkName
): Promise<DeployedTokens> {
  const usdcCfg = NETWORK_CONFIGS[network].usdc;
  if (!usdcCfg.isNative) {
    logger.nextStep('Using configured USDC mint');
    logger.info(`USDC mint: ${usdcCfg.mint.toBase58()}`);
    await assertConfiguredUsdcMint(provider, usdcCfg.mint);
    return { usdcMint: usdcCfg.mint };
  }

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
