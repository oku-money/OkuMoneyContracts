/**
 * Deployment configuration types and helpers
 */

import { BN } from '@anchor-lang/core';
import { isSvmMainnet } from '@okumoney/yield-tooling';
import { MAX_SUPPLY, MINTER_ALLOWANCE } from '../../config/constants';

export interface DeploymentConfig {
  maxSupply: BN;
  /** `initialize`'s `minter_allowance`. 0 = PSM minting (`mint_oku_m`) closed. */
  minterAllowance: BN;
}

/**
 * The program initializes halted at a 1.00 multiplier. On a mainnet chain added
 * after the fleet has accrued yield, an open PSM would sell OkuM below its global
 * value (Cyfrin audit finding #2), so mainnet initializes with PSM minting CLOSED:
 * `minter_allowance = 0`, which fails every `mint_oku_m` with `AllowanceExceeded`
 * while `redeem_oku_m`, rate writes and `set_okum_multiplier` keep working (the
 * allowance is independent of `is_paused`). The cold `allowance_manager` opens it
 * with `set_minter_allowance` only once the multiplier has reached the fleet's
 * (README § Opening PSM minting on a chain).
 *
 * `PSM_MINTING_CLOSED=true` rehearses the closed initialize on devnet. There is no
 * way to open minting at initialize on mainnet.
 */
export function getDeploymentConfig(network: string): DeploymentConfig {
  const closed = isSvmMainnet(network) || process.env.PSM_MINTING_CLOSED === 'true';
  return {
    maxSupply: new BN(MAX_SUPPLY),
    minterAllowance: new BN(closed ? 0 : MINTER_ALLOWANCE),
  };
}
