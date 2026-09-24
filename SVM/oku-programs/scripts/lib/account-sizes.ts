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
// Includes 128 bytes of tail padding so future fields can be appended without
// resizing the account (the program has no realloc instruction).
export const PSM_CONFIG_LEN = 754;            // const _: () = assert!(PsmConfig::LEN == 754);
