/**
 * PDA derivation helpers
 *
 * All PDA seeds must be kept in sync with the corresponding Rust `SEED` constants
 * in programs/lite-psm/src/state.rs and programs/oku-dollar/src/state.rs.
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

// Bridge / router PDA helpers (deriveBridgeConfigPDA, deriveBridgeNoncePDA,
// deriveProcessedRequestPDA, deriveBridgeFeeTreasuryPDA, deriveRefund*
// helpers, deriveRouterConfigPDA) were removed in the noBridge refactor.
// v1 cross-chain transfers are mediated off-chain by an orchestrator
// calling `mint_oku_m` / `redeem_oku_m` directly; no bridge PDAs are
// derived on-chain or by tooling.
