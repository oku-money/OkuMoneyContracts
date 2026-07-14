/**
 * PDA derivation helpers
 *
 * All PDA seeds must be kept in sync with the corresponding Rust `SEED` constants
 * in programs/lite-psm/src/state.rs.
 *
 * Seed history:
 * - noBridge migration (2026-06-05): all four seeds rotated to `_v2` after
 *   the PsmConfig storage layout shrank from 722 → 658 bytes.
 * - Audit-prep migration (2026-06-12): `psmConfig` rotated to `_v3` after
 *   the Proof-of-Reserves fields were removed and replaced with the
 *   USDC peg circuit-breaker fields (`oracle_relay_*`).
 * - Oracle removal (2026-07): `psmConfig` rotated to `_v4` after
 *   oracle fields were removed from `PsmConfig`. The other three seeds
 *   were not touched.
 * - Single-token refactor (2026-07): oku-dollar program removed entirely.
 *   `psmConfig` rotated to `_v5` (OkuMoney mint replaced by usdOku mint
 *   created by the program's `initialize` with ScaledUiAmount extension).
 *   `redemptionQueue` rotated to `_v3`.
 *
 * All pre-rotation PDAs are orphaned on devnet; see
 * `SVM/README.md` § "PDA seed history" for the orphan-PDA inventory
 * and future rent-recovery plan.
 */

import { PublicKey } from "@solana/web3.js";

/**
 * Centralized seed strings. Update both Rust state.rs constants and this
 * map together — any drift will produce silent PDA-address mismatches.
 */
export const PDA_SEEDS = {
  psmConfig: "psm_config_v5",
  redemptionQueue: "redemption_queue_v3",
} as const;

/** Derive PSM config PDA. */
export function derivePsmConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.psmConfig)], programId);
}

/** Derive redemption queue PDA. */
export function deriveRedemptionQueuePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.redemptionQueue)], programId);
}

// Bridge / router PDA helpers (deriveBridgeConfigPDA, deriveBridgeNoncePDA,
// deriveProcessedRequestPDA, deriveBridgeFeeTreasuryPDA, deriveRefund*
// helpers, deriveRouterConfigPDA) were removed in the noBridge refactor.
// v1 cross-chain transfers are mediated off-chain by an orchestrator
// calling `mint_usd_oku` / `redeem_usd_oku` directly; no bridge PDAs are
// derived on-chain or by tooling.
