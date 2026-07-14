/**
 * Token deployment utilities
 */

import { PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { createSPLTokenMint, createToken2022Mint } from '../../utils/tokenHelpers';
import { loadAuthorities } from '../../config/authorities';
import { USDC_DECIMALS, OKUSD_DECIMALS } from '../../config/constants';
import { loadDeployment } from '../../utils/addressBook';
import { NetworkName } from '../../config/networks';

export interface DeployedTokens {
  usdcMint: PublicKey;
  usdOkuMint: PublicKey;
}

/**
 * Deploy tokens, reusing any mints already saved in `deployments/<network>.json`.
 *
 * Without idempotency, re-running `deploy:init` after a successful run silently
 * mints fresh USDC / usdOku keypairs, then attempts to re-`initialize` the
 * PSM (which fails on `AccountAlreadyInitialized`). The fresh mints become
 * orphan accounts and the deployment file is overwritten with addresses
 * users on the OLD mint can no longer redeem against.
 *
 * Behavior:
 *   - If `deployments/<network>.json` already lists `tokens.usdc` and
 *     `tokens.usdOku`, return those PublicKeys verbatim.
 *   - If only one is present, error loudly -- partial state usually means a
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
  const existingUsdOku = existing?.tokens?.usdOku;

  if (existingUsdc && existingUsdOku) {
    logger.nextStep('Reusing existing tokens (idempotent)');
    logger.info(`USDC mint:   ${existingUsdc}`);
    logger.info(`usdOku mint: ${existingUsdOku}`);

    // Sanity check: the persisted usdOku mint MUST have the current PSM
    // config PDA as its mint authority. Otherwise the upcoming PSM
    // `initialize()` will fail with ConstraintMintMintAuthority (anchor
    // error 2016) -- which is what bit us when re-running deploy:init
    // after a fresh program-keypair rotation: the file pointed at a mint
    // authored by the OLD PSM PDA. Refusing here gives a clear remediation
    // path instead of a cryptic anchor-constraint failure deep in init.
    const usdOkuMintPk = new PublicKey(existingUsdOku);
    try {
      const mintAccount = await getMint(
        provider.connection,
        usdOkuMintPk,
        'confirmed',
        TOKEN_2022_PROGRAM_ID
      );
      const onChainAuthority = mintAccount.mintAuthority;
      if (!onChainAuthority || !onChainAuthority.equals(psmConfigPDA)) {
        throw new Error(
          `Refusing to reuse usdOku mint ${existingUsdOku}: on-chain mint ` +
            `authority is ${onChainAuthority?.toBase58() ?? '<none>'}, but the ` +
            `current PSM config PDA is ${psmConfigPDA.toBase58()}. This usually ` +
            `means the program keypairs were rotated since this mint was created, ` +
            `and the mint is now orphaned. Remediation:\n` +
            `  1. Scrub deployments/${network}.json -- remove the .tokens and .pdas ` +
            `     blocks (back the file up first; consider preserving them under ` +
            `     a _archived key for audit history).\n` +
            `  2. Re-run \`npm run deploy:init\` -- it will mint fresh tokens ` +
            `     wired to the current PSM PDA.\n` +
            `Note: any usdOku already minted on the orphaned mint is stranded ` +
            `(no live program controls its mint authority).`
        );
      }
      logger.success(
        `usdOku mint authority matches current PSM config PDA (${psmConfigPDA.toBase58()})`
      );
    } catch (err: any) {
      // Re-throw our refusal verbatim; otherwise wrap with context.
      if (err.message?.startsWith('Refusing to reuse usdOku mint')) throw err;
      throw new Error(
        `Failed to verify usdOku mint authority for ${existingUsdOku}: ` +
          `${err.message ?? err}. Cannot safely reuse this mint.`
      );
    }

    return {
      usdcMint: new PublicKey(existingUsdc),
      usdOkuMint: usdOkuMintPk,
    };
  }

  if (existingUsdc || existingUsdOku) {
    throw new Error(
      `Partial token state detected for network "${network}" -- usdc=${existingUsdc} ` +
        `usdOku=${existingUsdOku}. Aborting to avoid creating orphans. ` +
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

  // Create usdOku (Token-2022 with ScaledUiAmount extension)
  logger.info('Creating usdOku (Token-2022)...');
  const usdOkuMint = await createToken2022Mint({
    connection: provider.connection,
    payer: provider.wallet.payer,
    decimals: OKUSD_DECIMALS,
    mintAuthority: psmConfigPDA, // PSM controls minting
    freezeAuthority: psmConfigPDA,
    rateAuthority: authorities.psm.rebaser,
    initialRate: 0, // 0% initial rate
  });

  return { usdcMint, usdOkuMint };
}
