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
export const PSM_CONFIG_LEN = 658;            // const _: () = assert!(PsmConfig::LEN == 658);
                                              // Was 722 before noBridge phase C (which removed
                                              // the two `blacklist_exempt_*` Pubkey slots,
                                              // -64 bytes).
export const REDEMPTION_QUEUE_LEN = 9_640;    // const _: () = assert!(RedemptionQueue::LEN == 9_640);
                                              // Zero-copy ring at MAX_ENTRIES=200 (Phase 13b).
                                              // Capped at 200 (not the spec target of 500) by Solana's
                                              // MAX_PERMITTED_DATA_INCREASE = 10_240 single-CPI alloc
                                              // budget; a 500-entry queue (~24 KB) would need a
                                              // multi-step `realloc` upgrade.

// oku_dollar — programs/oku-dollar/src/state.rs
export const OKU_DOLLAR_CONFIG_LEN = 330;    // const _: () = assert!(OkuDollarConfig::LEN == 330);

// Bridge-related size constants (BRIDGE_CONFIG_LEN, BRIDGE_NONCE_LEN,
// PROCESSED_REQUEST_LEN, PENDING_REFUND_LEN, REFUNDED_REQUEST_LEN) were
// removed in the noBridge refactor (phase B) — no on-chain bridge state
// remains.
