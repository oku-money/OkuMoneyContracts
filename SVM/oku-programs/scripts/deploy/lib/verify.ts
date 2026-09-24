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

/**
 * Verify all deployment addresses exist on-chain.
 *
 * Existence alone is not enough: an orphaned account from a prior program
 * generation (e.g. a 562-byte pre-streaming-accrual PsmConfig against the
 * current 754) EXISTS at some address without being usable by the current
 * program. So this checks owner + size + discriminator for the PSM config.
 */
export async function verifyDeployment(
  provider: AnchorProvider,
  addresses: DeploymentAddresses,
  expectedProgramId?: PublicKey
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
    } else {
      logger.success(`PSM Config: ${configAddr.slice(0, 8)}... (owner, size, discriminator all match)`);
    }
  }

  if (allPassed) {
    logger.success('All verification checks passed!');
  } else {
    logger.warning('Some checks failed - review deployment');
  }

  return allPassed;
}
