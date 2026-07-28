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
 *   `psmConfig` rotated to `_v5` then `_v6` (queue removed, OkuMoney mint
 *   replaced by OkuM mint created by the program's `initialize` with
 *   ScaledUiAmount extension). Redemption queue removed entirely.
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
  psmConfig: "psm_config_v6",
} as const;

/** Derive PSM config PDA. */
export function derivePsmConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.psmConfig)], programId);
}
