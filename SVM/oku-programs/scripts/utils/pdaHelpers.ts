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

/** Canonical BPF upgradeable loader program ID. */
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

/**
 * Derive a program's ProgramData PDA — `[program_id]` under the BPF
 * upgradeable loader.
 *
 * `initialize` requires its signer to be the program's upgrade authority and
 * pins this address on-chain via `get_program_data_address(&crate::ID)` (see
 * `contexts/init.rs`), so this must derive identically.
 */
export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID
  )[0];
}
