/**
 * PDA derivation helpers
 */

import { PublicKey } from '@solana/web3.js';

/**
 * Derive PSM config PDA
 */
export function derivePsmConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('psm_config')], programId);
}

/**
 * Derive redemption queue PDA
 */
export function deriveRedemptionQueuePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('redemption_queue')],
    programId
  );
}

/**
 * Derive vault config PDA
 */
export function deriveVaultConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('vault_config')], programId);
}

/**
 * Derive bridge config PDA
 */
export function deriveBridgeConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], programId);
}

/**
 * Derive bridge nonce PDA for a specific chain
 */
export function deriveBridgeNoncePDA(
  programId: PublicKey,
  chainId: number
): [PublicKey, number] {
  const chainIdBuffer = Buffer.allocUnsafe(2);
  chainIdBuffer.writeUInt16LE(chainId);

  return PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_nonce'), chainIdBuffer],
    programId
  );
}

/**
 * Derive router config PDA
 */
export function deriveRouterConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('router_config')], programId);
}

/**
 * Derive processed request PDA
 */
export function deriveProcessedRequestPDA(
  programId: PublicKey,
  requestId: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_request'), requestId],
    programId
  );
}

/**
 * Get all standard PDAs for deployment
 */
export interface DeploymentPDAs {
  psm: {
    config: PublicKey;
    redemptionQueue: PublicKey;
  };
  vault: {
    config: PublicKey;
  };
  bridge: {
    config: PublicKey;
  };
  router: {
    config: PublicKey;
  };
}

export function deriveAllPDAs(programIds: {
  litePsm: PublicKey;
  wokusdVault: PublicKey;
  okuBridgeRouter: PublicKey;
}): DeploymentPDAs {
  const [psmConfig] = derivePsmConfigPDA(programIds.litePsm);
  const [redemptionQueue] = deriveRedemptionQueuePDA(programIds.litePsm);
  const [vaultConfig] = deriveVaultConfigPDA(programIds.wokusdVault);
  const [bridgeConfig] = deriveBridgeConfigPDA(programIds.litePsm);
  const [routerConfig] = deriveRouterConfigPDA(programIds.okuBridgeRouter);

  return {
    psm: {
      config: psmConfig,
      redemptionQueue,
    },
    vault: {
      config: vaultConfig,
    },
    bridge: {
      config: bridgeConfig,
    },
    router: {
      config: routerConfig,
    },
  };
}
