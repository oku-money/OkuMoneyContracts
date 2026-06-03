/**
 * RBAC authority mappings
 *
 * For localnet/devnet: uses deployer wallet for all authorities (simplifies signing)
 * For mainnet: requires separate pubkeys via environment variables
 */

import { PublicKey } from '@solana/web3.js';
import { NetworkName } from './networks';

export interface AuthorityConfig {
  // PSM authorities (12 roles)
  psm: {
    roleAdmin: PublicKey;
    pauser: PublicKey;
    unpauser: PublicKey;
    freezer: PublicKey;
    unfreezer: PublicKey;
    queueProcessor: PublicKey;
    bufferDepositor: PublicKey;
    bufferWithdrawer: PublicKey;
    oracleManager: PublicKey;
    capManager: PublicKey;
    allowanceManager: PublicKey;
    rebaser: PublicKey;
  };

  // Vault authorities (5 roles)
  vault: {
    roleAdmin: PublicKey;
    pauser: PublicKey;
    unpauser: PublicKey;
    usdRebaser: PublicKey;
    reserveManager: PublicKey;
  };
}

/**
 * Build an AuthorityConfig where all signer-bearing roles point to the
 * deployer wallet. Used for localnet/devnet so a single wallet can sign
 * every admin call during smoke testing.
 */
function allRolesToSingleKey(deployer: PublicKey): AuthorityConfig {
  return {
    psm: {
      roleAdmin: deployer,
      pauser: deployer,
      unpauser: deployer,
      freezer: deployer,
      unfreezer: deployer,
      queueProcessor: deployer,
      bufferDepositor: deployer,
      bufferWithdrawer: deployer,
      oracleManager: deployer,
      capManager: deployer,
      allowanceManager: deployer,
      rebaser: deployer,
    },
    vault: {
      roleAdmin: deployer,
      pauser: deployer,
      unpauser: deployer,
      usdRebaser: deployer,
      reserveManager: deployer,
    },
  };
}

/**
 * Check if network uses deployer wallet for all authorities (testnet/fork mode)
 */
function isTestnetOrFork(network: NetworkName): boolean {
  return (
    network === 'localnet' ||
    network === 'devnet' ||
    network === 'devnet-fork' ||
    network === 'mainnet-fork'
  );
}

/**
 * Load authorities based on network
 *
 * - localnet/devnet/devnet-fork/mainnet-fork: all signer roles use the
 *   deployer wallet.
 * - mainnet-beta: loads separate pubkeys from MAINNET_* env vars.
 *
 * `litePsmProgramId` is accepted (and currently unused) for forward
 * compatibility with PDA-derived authorities if we reintroduce any.
 */
export function loadAuthorities(
  network: NetworkName,
  deployerPubkey?: PublicKey,
  _litePsmProgramId?: PublicKey
): AuthorityConfig {
  // For testnet and fork networks, use deployer wallet for all authorities
  if (isTestnetOrFork(network)) {
    const deployer = deployerPubkey || PublicKey.default;
    return allRolesToSingleKey(deployer);
  }

  // For mainnet-beta only, load separate authority pubkeys from environment
  const coldMultisig = getEnvPubkey('MAINNET_COLD_MULTISIG', true);
  const warmMultisig = getEnvPubkey('MAINNET_WARM_MULTISIG', true);
  const orchestrator = getEnvPubkey('MAINNET_ORCHESTRATOR', true);

  return {
    psm: {
      roleAdmin: coldMultisig,
      pauser: warmMultisig,
      unpauser: coldMultisig,
      freezer: warmMultisig,
      unfreezer: coldMultisig,
      queueProcessor: orchestrator,
      bufferDepositor: orchestrator,
      bufferWithdrawer: coldMultisig,
      oracleManager: coldMultisig,
      capManager: coldMultisig,
      allowanceManager: coldMultisig,
      rebaser: orchestrator,
    },
    vault: {
      roleAdmin: coldMultisig,
      pauser: warmMultisig,
      unpauser: coldMultisig,
      usdRebaser: orchestrator,
      reserveManager: coldMultisig,
    },
  };
}

function getEnvPubkey(key: string, required: boolean = false): PublicKey {
  const value = process.env[key];

  if (!value) {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return PublicKey.default;
  }

  try {
    return new PublicKey(value);
  } catch (error) {
    throw new Error(`Invalid public key for ${key}: ${value}`);
  }
}
