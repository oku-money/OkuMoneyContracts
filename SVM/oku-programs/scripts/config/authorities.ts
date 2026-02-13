/**
 * RBAC authority mappings
 *
 * Environment variables required:
 * - COLD_MULTISIG (required for devnet/mainnet)
 * - WARM_MULTISIG (required for devnet/mainnet)
 * - ORCHESTRATOR (required for devnet/mainnet)
 * - BRIDGE_ORCHESTRATOR (required for devnet/mainnet)
 * - FEE_RECIPIENT (required for devnet/mainnet)
 */

import { Keypair, PublicKey } from '@solana/web3.js';
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
 * Load authorities from environment variables
 * For localnet, optionally pass deployerPubkey to use deployer as all authorities
 */
export function loadAuthorities(network: NetworkName, deployerPubkey?: PublicKey): AuthorityConfig {
  const prefix = network === 'localnet' ? '' : network.toUpperCase() + '_';

  // For localnet, use deployer wallet as all authorities (simplifies signing)
  if (network === 'localnet') {
    // If no deployer pubkey provided, try to get from environment or use a placeholder
    const deployer = deployerPubkey || getEnvPubkey('DEPLOYER_PUBKEY', false);

    // Use deployer for all authorities on localnet (they can sign)
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

  // For devnet/mainnet, load from environment
  const coldMultisig = getEnvPubkey(`${prefix}COLD_MULTISIG`, true);
  const warmMultisig = getEnvPubkey(`${prefix}WARM_MULTISIG`, true);
  const orchestrator = getEnvPubkey(`${prefix}ORCHESTRATOR`, true);
  const bridgeOrchestrator = getEnvPubkey(`${prefix}BRIDGE_ORCHESTRATOR`, true);
  const feeRecipient = getEnvPubkey(`${prefix}FEE_RECIPIENT`, true);

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
