/**
 * PDA derivation helpers.
 *
 * All PDA seeds must be kept in sync with the corresponding Rust `SEED`
 * constants in `programs/lite-psm/src/state.rs`.
 */

import { PublicKey } from "@solana/web3.js";

/**
 * Centralized seed strings. These must match the `PsmConfig::SEED` constant
 * in `programs/lite-psm/src/state.rs` byte-for-byte.
 */
export const PDA_SEEDS = {
  psmConfig: "psm_config",
} as const;

/** Derive PSM config PDA. */
export function derivePsmConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.psmConfig)], programId);
}
