/**
 * Deployment configuration types and helpers
 */

import { BN } from '@anchor-lang/core';
import { MAX_SUPPLY, MINTER_ALLOWANCE } from '../../config/constants';

export interface DeploymentConfig {
  maxSupply: BN;
  minterAllowance: BN;
  oracleEnabled: boolean;
  minCollateralRatio: BN;
}

export function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: new BN(MAX_SUPPLY),
    minterAllowance: new BN(MINTER_ALLOWANCE),
    oracleEnabled: false, // Disabled for fork testing (1:1 ratio)
    minCollateralRatio: new BN('1000000000'), // 100% in 9-decimal precision (1e9)
  };
}
