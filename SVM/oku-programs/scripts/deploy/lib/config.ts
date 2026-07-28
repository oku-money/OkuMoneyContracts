/**
 * Deployment configuration types and helpers
 */

import { BN } from '@anchor-lang/core';
import { MAX_SUPPLY, MINTER_ALLOWANCE } from '../../config/constants';

export interface DeploymentConfig {
  maxSupply: BN;
  minterAllowance: BN;
}

export function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: new BN(MAX_SUPPLY),
    minterAllowance: new BN(MINTER_ALLOWANCE),
  };
}
