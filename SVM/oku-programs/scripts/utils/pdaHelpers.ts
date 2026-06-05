/**
 * PDA derivation helpers
 *
 * All PDA seeds must be kept in sync with the corresponding Rust `SEED` constants
 * in programs/lite-psm/src/state.rs and programs/oku-dollar/src/state.rs.
 *
 * noBridge migration (2026-06-05): all four seeds rotated to `_v2` to force
 * fresh PDAs after the PsmConfig storage layout shrank from 722 → 658 bytes.
 * The pre-rotation PDAs are orphaned on devnet; see
 * `deployments/DEPRECATED.md` for the orphan-PDA tracking and future
 * rent-recovery plan.
 */

import { PublicKey } from "@solana/web3.js";

/**
 * Centralized seed strings. Update both Rust state.rs constants and this
 * map together — any drift will produce silent PDA-address mismatches.
 */
export const PDA_SEEDS = {
  psmConfig: "psm_config_v2",
  redemptionQueue: "redemption_queue_v2",
  okuDollarConfig: "oku_dollar_config_v2",
  usdOkuMint: "usd_oku_mint_v2",
} as const;

/** Derive PSM config PDA. */
export function derivePsmConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.psmConfig)], programId);
}

/** Derive redemption queue PDA. */
export function deriveRedemptionQueuePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.redemptionQueue)], programId);
}

/** Derive OkuDollar vault config PDA. */
export function deriveVaultConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.okuDollarConfig)], programId);
}

/** Derive usdOku mint PDA. */
export function deriveUsdOkuMintPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.usdOkuMint)], programId);
}

// Bridge / router PDA helpers (deriveBridgeConfigPDA, deriveBridgeNoncePDA,
// deriveProcessedRequestPDA, deriveBridgeFeeTreasuryPDA, deriveRefund*
// helpers, deriveRouterConfigPDA) were removed in the noBridge refactor.
// v1 cross-chain transfers are mediated off-chain by an orchestrator
// calling `mint_oku_m` / `redeem_oku_m` directly; no bridge PDAs are
// derived on-chain or by tooling.
