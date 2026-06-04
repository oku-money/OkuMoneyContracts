/**
 * Deployment configuration types and helpers
 */

import { BN } from '@anchor-lang/core';
import { MAX_SUPPLY, MINTER_ALLOWANCE } from '../../config/constants';

export interface DeploymentConfig {
  maxSupply: BN;
  minterAllowance: BN;
  // oracleEnabled removed (WS5.7) — oracle is implied by whether pythProgramOwner is
  // Pubkey::default(). Use initialize(pythProgramOwner) to enable oracle at init time.
  minCollateralRatio: BN;
}

export function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: new BN(MAX_SUPPLY),
    minterAllowance: new BN(MINTER_ALLOWANCE),
    minCollateralRatio: new BN('1000000000'), // 100% in 9-decimal precision (1e9)
  };
}
