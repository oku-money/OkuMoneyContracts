/**
 * RBAC authority mappings
 *
 * For localnet/devnet: uses deployer wallet for all authorities (simplifies signing)
 * For mainnet: requires separate pubkeys via environment variables
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { NetworkName } from './networks';
import {
  deriveBridgeFeeTreasuryPDA,
  deriveRefundConfirmerDefaultPDA,
  deriveRefundInitiatorDefaultPDA,
} from '../utils/pdaHelpers';

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

  // Bridge authorities (12 roles)
  bridge: {
    bridgeAdmin: PublicKey;
    bridgePauser: PublicKey;
    bridgeUnpauser: PublicKey;
    orchestratorSigner: PublicKey; // Ed25519 keypair for signing
    feeRecipient: PublicKey;
    chainManager: PublicKey;
    feeManager: PublicKey;
    nonceAdmin: PublicKey;
    signerManager: PublicKey;
    limitsManager: PublicKey;
    /**
     * Two-step refund initiator. Required by `initialize_bridge` to be distinct
     * from `bridgeAdmin` and `refundConfirmer` (mirrors EVM key-separation).
     */
    refundInitiator: PublicKey;
    /** Two-step refund confirmer. Required to differ from `refundInitiator` and `bridgeAdmin`. */
    refundConfirmer: PublicKey;
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
 * Build an AuthorityConfig where all 22 signer-bearing roles point to the deployer,
 * while `bridge.feeRecipient` is a PDA (the bridge fee treasury) so that fees
 * accumulate in a distinct account from the bridge-burn caller. This avoids the
 * "duplicate mutable account" error that otherwise occurs when the deployer
 * (used as user in smoke tests / `bridge:burn`) is also the fee recipient.
 *
 * For mainnet deployments, `feeRecipient` is a real wallet controlled by
 * treasury operations (see `MAINNET_FEE_RECIPIENT`).
 */
function allRolesToSingleKey(
  deployer: PublicKey,
  litePsmProgramId: PublicKey
): AuthorityConfig {
  const [feeTreasury] = deriveBridgeFeeTreasuryPDA(litePsmProgramId);
  // The on-chain `initialize_bridge` requires refund_initiator / refund_confirmer
  // to be distinct from `bridge_admin` and from each other. For testnet we use
  // deterministic PDAs as placeholders; testnet operators must rotate them via
  // `set_bridge_authority` to real keypairs before exercising the two-step
  // refund flow (PDAs cannot sign top-level instructions).
  const [refundInitiatorDefault] = deriveRefundInitiatorDefaultPDA(litePsmProgramId);
  const [refundConfirmerDefault] = deriveRefundConfirmerDefaultPDA(litePsmProgramId);
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
      feeRecipient: feeTreasury,
      chainManager: deployer,
      feeManager: deployer,
      nonceAdmin: deployer,
      signerManager: deployer,
      limitsManager: deployer,
      refundInitiator: refundInitiatorDefault,
      refundConfirmer: refundConfirmerDefault,
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
 * - localnet/devnet/devnet-fork/mainnet-fork: all signer roles use the deployer
 *   wallet; `bridge.feeRecipient` is the bridge fee treasury PDA derived from
 *   `litePsmProgramId` (avoids the bridge-burn "duplicate mutable account" case).
 * - mainnet-beta: loads separate pubkeys from MAINNET_* env vars.
 */
export function loadAuthorities(
  network: NetworkName,
  deployerPubkey?: PublicKey,
  litePsmProgramId?: PublicKey
): AuthorityConfig {
  // For testnet and fork networks, use deployer wallet for all authorities
  if (isTestnetOrFork(network)) {
    const deployer = deployerPubkey || PublicKey.default;
    if (!litePsmProgramId) {
      throw new Error(
        'litePsmProgramId is required for testnet/fork deployments (used to derive the bridge fee treasury PDA).'
      );
    }
    return allRolesToSingleKey(deployer, litePsmProgramId);
  }

  // For mainnet-beta only, load separate authority pubkeys from environment
  const coldMultisig = getEnvPubkey('MAINNET_COLD_MULTISIG', true);
  const warmMultisig = getEnvPubkey('MAINNET_WARM_MULTISIG', true);
  const orchestrator = getEnvPubkey('MAINNET_ORCHESTRATOR', true);
  const bridgeOrchestrator = getEnvPubkey('MAINNET_BRIDGE_ORCHESTRATOR', true);
  const feeRecipient = getEnvPubkey('MAINNET_FEE_RECIPIENT', true);
  // Two-step refund roles must be distinct from `bridgeAdmin` (= coldMultisig)
  // and from each other. The on-chain init now enforces this.
  const refundInitiator = getEnvPubkey('MAINNET_REFUND_INITIATOR', true);
  const refundConfirmer = getEnvPubkey('MAINNET_REFUND_CONFIRMER', true);

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
      signerManager: coldMultisig,
      limitsManager: coldMultisig,
      refundInitiator,
      refundConfirmer,
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
