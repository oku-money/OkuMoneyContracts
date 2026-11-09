/**
 * Deployment verification utilities
 */

import { PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { DeploymentAddresses } from '../../utils/addressBook';
import { PSM_CONFIG_LEN } from '../../lib/account-sizes';

/** Anchor account discriminator for `PsmConfig` — first 8 bytes of
 *  sha256("account:PsmConfig"). Used to distinguish a genuine PsmConfig from
 *  an orphaned/stale account of a different shape at the same address. */
const PSM_CONFIG_DISCRIMINATOR_HEX = '91ddc833e9c956b4';

/** `PsmConfig.usdc_mint` byte offset: discriminator (8) + bump (1) + ten role keys (320).
 *  Pinned against the committed IDL by tests/scripts/deploy-usdc.test.ts. */
export const PSM_CONFIG_USDC_MINT_OFFSET = 329;

/**
 * Verify all deployment addresses exist on-chain.
 *
 * Existence alone is not enough: an orphaned account from a prior program
 * generation (e.g. a 562-byte pre-streaming-accrual PsmConfig against the
 * current 754) EXISTS at some address without being usable by the current
 * program. So this checks owner + size + discriminator for the PSM config.
 *
 * It also checks the stored `usdc_mint` (permanent once initialized, Cyfrin audit
 * finding #4) equals `expectedUsdcMint`: the configured reserve on real-USDC
 * networks, else the mint recorded in the deployment.
 */
export async function verifyDeployment(
  provider: AnchorProvider,
  addresses: DeploymentAddresses,
  expectedProgramId?: PublicKey,
  expectedUsdcMint?: PublicKey
): Promise<boolean> {
  logger.nextStep('Verifying Deployment');

  const accountsToCheck = [
    { name: 'USDC Mint', address: addresses.tokens?.usdc },
    { name: 'OkuM Mint', address: addresses.tokens?.okuM },
    { name: 'PSM USDC Vault', address: addresses.pdas?.psmVaultUsdc },
  ];

  let allPassed = true;
  for (const { name, address } of accountsToCheck) {
    if (!address) {
      logger.error(`${name}: NOT CONFIGURED`);
      allPassed = false;
      continue;
    }
    const accountInfo = await provider.connection.getAccountInfo(new PublicKey(address));
    if (accountInfo) {
      logger.success(`${name}: ${address.slice(0, 8)}...`);
    } else {
      logger.error(`${name}: NOT FOUND`);
      allPassed = false;
    }
  }

  // PSM Config gets the stronger check.
  const expectedMint = expectedUsdcMint ?? (addresses.tokens?.usdc ? new PublicKey(addresses.tokens.usdc) : PublicKey.default);
  const configAddr = addresses.pdas?.psmConfig;
  if (!configAddr) {
    logger.error('PSM Config: NOT CONFIGURED');
    allPassed = false;
  } else {
    const info = await provider.connection.getAccountInfo(new PublicKey(configAddr));
    if (!info) {
      logger.error('PSM Config: NOT FOUND');
      allPassed = false;
    } else if (expectedProgramId && !info.owner.equals(expectedProgramId)) {
      logger.error(`PSM Config: owned by ${info.owner.toBase58()}, expected ${expectedProgramId.toBase58()} — likely a stale/orphaned account`);
      allPassed = false;
    } else if (info.data.length !== PSM_CONFIG_LEN) {
      logger.error(`PSM Config: ${info.data.length} bytes, expected ${PSM_CONFIG_LEN} — wrong layout generation (stale/orphaned account)`);
      allPassed = false;
    } else if (info.data.subarray(0, 8).toString('hex') !== PSM_CONFIG_DISCRIMINATOR_HEX) {
      logger.error('PSM Config: discriminator mismatch — not a PsmConfig account');
      allPassed = false;
    } else if (
      !new PublicKey(
        info.data.subarray(PSM_CONFIG_USDC_MINT_OFFSET, PSM_CONFIG_USDC_MINT_OFFSET + 32)
      ).equals(expectedMint)
    ) {
      logger.error(
        `PSM Config: usdc_mint is not the expected reserve ${expectedMint.toBase58()} ` +
          `(it is permanent: a wrong mint needs a new program ID)`
      );
      allPassed = false;
    } else {
      logger.success(`PSM Config: ${configAddr.slice(0, 8)}... (owner, size, discriminator, usdc_mint all match)`);
    }
  }

  if (allPassed) {
    logger.success('All verification checks passed!');
  } else {
    logger.warning('Some checks failed - review deployment');
  }

  return allPassed;
}
