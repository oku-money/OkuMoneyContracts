/**
 * On-chain account sizes for cost / rent calculations.
 *
 * Single source of truth for the `LEN` constants compile-time-asserted in
 * each program's `state.rs`. **Keep in sync** when the Rust constants change
 * — the `assert!(T::LEN == N)` post-conditions in state.rs guard the Rust
 * side; this file is the TS-side mirror.
 *
 * Rationale: Anchor 1.0's generated IDL JSON does NOT carry account size
 * metadata, only the discriminator. We can't read the size at script runtime
 * without parsing the .rs files or fetching an existing on-chain account.
 * Hardcoding here, with a comment pointing at the asserts, is the simplest
 * keep-in-sync arrangement.
 */

// lite_psm — programs/lite-psm/src/state.rs
// Grew from 562 to 626 bytes with the streaming-accrual rate schedule
// (six new fields on PsmConfig) — see SVM/DECISIONS.md D-19.
export const PSM_CONFIG_LEN = 626;            // const _: () = assert!(PsmConfig::LEN == 626);
