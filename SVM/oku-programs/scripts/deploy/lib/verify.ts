/**
 * Deployment verification utilities
 */

import { PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import { DeploymentAddresses } from '../../utils/addressBook';

/**
 * Verify all deployment addresses exist on-chain
 */
export async function verifyDeployment(
  provider: AnchorProvider,
  addresses: DeploymentAddresses
): Promise<boolean> {
  logger.nextStep('Verifying Deployment');

  const accountsToCheck = [
    { name: 'USDC Mint', address: addresses.tokens?.usdc },
    { name: 'OkuMoney Mint', address: addresses.tokens?.okusd },
    { name: 'PSM Config', address: addresses.pdas?.psmConfig },
    { name: 'Redemption Queue', address: addresses.pdas?.redemptionQueue },
    { name: 'Bridge Config', address: addresses.pdas?.bridgeConfig },
    { name: 'Vault Config', address: addresses.pdas?.vaultConfig },
    { name: 'usdOku Mint', address: addresses.tokens?.usdOku },
    { name: 'Router Config', address: addresses.pdas?.routerConfig },
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

  if (allPassed) {
    logger.success('All verification checks passed!');
  } else {
    logger.warning('Some checks failed - review deployment');
  }

  return allPassed;
}
