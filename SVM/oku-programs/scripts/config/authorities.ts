/**
 * RBAC authority mappings
 *
 * For localnet/devnet: uses deployer wallet for all authorities (simplifies signing)
 * For mainnet: requires separate pubkeys via environment variables
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
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

  // Bridge authorities (8 roles)
  bridge: {
    bridgeAdmin: PublicKey;
    bridgePauser: PublicKey;
    bridgeUnpauser: PublicKey;
    orchestratorSigner: PublicKey; // Ed25519 keypair for signing
    feeRecipient: PublicKey;
    chainManager: PublicKey;
    feeManager: PublicKey;
    nonceAdmin: PublicKey;
  };

  // Vault authorities (3 roles)
  vault: {
    roleAdmin: PublicKey;
    pauser: PublicKey;
    unpauser: PublicKey;
  };
}

/**
 * Build an AuthorityConfig where all 23 roles point to a single pubkey
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
    bridge: {
      bridgeAdmin: deployer,
      bridgePauser: deployer,
      bridgeUnpauser: deployer,
      orchestratorSigner: deployer,
      feeRecipient: deployer,
      chainManager: deployer,
      feeManager: deployer,
      nonceAdmin: deployer,
    },
    vault: {
      roleAdmin: deployer,
      pauser: deployer,
      unpauser: deployer,
    },
  };
}

/**
 * Load authorities based on network
 *
 * - localnet/devnet: all roles use deployer wallet (for simplicity)
 * - mainnet: loads separate pubkeys from MAINNET_* env vars
 */
export function loadAuthorities(network: NetworkName, deployerPubkey?: PublicKey): AuthorityConfig {
  // For localnet and devnet, use deployer wallet for all authorities
  if (network === 'localnet' || network === 'devnet') {
    const deployer = deployerPubkey || PublicKey.default;
    return allRolesToSingleKey(deployer);
  }

  // For mainnet, load separate authority pubkeys from environment
  const coldMultisig = getEnvPubkey('MAINNET_COLD_MULTISIG', true);
  const warmMultisig = getEnvPubkey('MAINNET_WARM_MULTISIG', true);
  const orchestrator = getEnvPubkey('MAINNET_ORCHESTRATOR', true);
  const bridgeOrchestrator = getEnvPubkey('MAINNET_BRIDGE_ORCHESTRATOR', true);
  const feeRecipient = getEnvPubkey('MAINNET_FEE_RECIPIENT', true);

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
    bridge: {
      bridgeAdmin: coldMultisig,
      bridgePauser: warmMultisig,
      bridgeUnpauser: coldMultisig,
      orchestratorSigner: bridgeOrchestrator,
      feeRecipient: feeRecipient,
      chainManager: warmMultisig,
      feeManager: coldMultisig,
      nonceAdmin: coldMultisig,
    },
    vault: {
      roleAdmin: coldMultisig,
      pauser: warmMultisig,
      unpauser: coldMultisig,
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
