/**
 * PDA derivation helpers
 *
 * All PDA seeds must be kept in sync with the corresponding Rust `SEED` constants
 * in programs/lite-psm/src/state.rs, programs/oku-dollar/src/state.rs, and
 * programs/oku-bridge-router/src/state.rs.
 */

import { PublicKey } from "@solana/web3.js";

/** Derive PSM config PDA. Seeds: ["psm_config"] */
export function derivePsmConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("psm_config")], programId);
}

/** Derive redemption queue PDA. Seeds: ["redemption_queue"] */
export function deriveRedemptionQueuePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("redemption_queue")], programId);
}

/** Derive OkuDollar vault config PDA. Seeds: ["oku_dollar_config"] */
export function deriveVaultConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("oku_dollar_config")], programId);
}

/** Derive usdOku mint PDA. Seeds: ["usd_oku_mint"] */
export function deriveUsdOkuMintPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("usd_oku_mint")], programId);
}

/** Derive bridge config PDA. Seeds: ["bridge_config"] */
export function deriveBridgeConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], programId);
}

/**
 * Derive bridge nonce PDA for a specific destination chain.
 * Seeds: ["bridge_nonce", chain_id_u16_le]
 */
export function deriveBridgeNoncePDA(
  programId: PublicKey,
  chainId: number
): [PublicKey, number] {
  const chainIdBuffer = Buffer.allocUnsafe(2);
  chainIdBuffer.writeUInt16LE(chainId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_nonce"), chainIdBuffer],
    programId
  );
}

/** Derive router config PDA. Seeds: ["router_config"] */
export function deriveRouterConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("router_config")], programId);
}

/**
 * Derive processed request PDA (replay-prevention marker).
 * Seeds: ["bridge_request", request_id_bytes32]
 */
export function deriveProcessedRequestPDA(
  programId: PublicKey,
  requestId: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_request"), requestId],
    programId
  );
}

/**
 * Derive bridge fee treasury PDA.
 * Seeds: ["bridge_fee_treasury"]
 *
 * Used as the bridge fee recipient on non-mainnet deployments (see
 * `scripts/config/authorities.ts::allRolesToSingleKey`) so bridge fees
 * accumulate in a distinct account from the deployer wallet. The PDA owns an
 * OkuMoney (Token-2022) ATA created during `deploy:init`. Mainnet uses a real
 * wallet pubkey from `MAINNET_FEE_RECIPIENT` instead.
 */
export function deriveBridgeFeeTreasuryPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_fee_treasury")],
    programId
  );
}
