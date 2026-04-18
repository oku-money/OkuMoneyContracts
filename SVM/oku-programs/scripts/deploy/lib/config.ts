/**
 * Deployment configuration types and helpers
 */

import { BN } from '@anchor-lang/core';
import {
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  BRIDGE_FEE_BPS,
  MIN_BRIDGE_AMOUNT,
  MAX_BRIDGE_AMOUNT,
  SUPPORTED_CHAINS,
} from '../../config/constants';

export interface DeploymentConfig {
  maxSupply: BN;
  minterAllowance: BN;
  bridgeFeeBps: number;
  minBridgeAmount: BN;
  maxBridgeAmount: BN;
  bridgeDeadlineSecs: BN;
  supportedChains: number[];
  oracleEnabled: boolean;
  minCollateralRatio: BN;
}

export function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: new BN(MAX_SUPPLY),
    minterAllowance: new BN(MINTER_ALLOWANCE),
    bridgeFeeBps: BRIDGE_FEE_BPS,
    minBridgeAmount: new BN(MIN_BRIDGE_AMOUNT),
    maxBridgeAmount: new BN(MAX_BRIDGE_AMOUNT),
    bridgeDeadlineSecs: new BN(3600), // 1 hour
    supportedChains: SUPPORTED_CHAINS,
    oracleEnabled: false, // Disabled for fork testing (1:1 ratio)
    minCollateralRatio: new BN('1000000000'), // 100% in 9-decimal precision (1e9)
  };
}
