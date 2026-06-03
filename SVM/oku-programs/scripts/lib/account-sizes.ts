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
export const PSM_CONFIG_LEN = 690;            // const _: () = assert!(PsmConfig::LEN == 690);
export const REDEMPTION_QUEUE_LEN = 9_640;    // const _: () = assert!(RedemptionQueue::LEN == 9_640);
                                              // Zero-copy ring at MAX_ENTRIES=200 (Phase 13b).
                                              // Was 505 at the old MAX_ENTRIES=10 + u32 head/tail.
                                              // Capped at 200 (not the spec target of 500) by Solana's
                                              // MAX_PERMITTED_DATA_INCREASE = 10_240 single-CPI alloc
                                              // budget; a 500-entry queue (~24 KB) would need a
                                              // multi-step init+realloc deploy flow.
export const BRIDGE_CONFIG_LEN = 487;         // const _: () = assert!(BridgeConfig::LEN == 487);
export const BRIDGE_NONCE_LEN = 20;           // const _: () = assert!(BridgeNonce::LEN == 20);
                                              //   8 disc + 1 bump + 1 is_init + 2 chain_id + 8 next_nonce = 20

// oku_dollar — programs/oku-dollar/src/state.rs
export const OKU_DOLLAR_CONFIG_LEN = 330;    // const _: () = assert!(OkuDollarConfig::LEN == 330);

// PDA replay markers (lite_psm)
export const PROCESSED_REQUEST_LEN = 89;     // 8 + 1 + 32 + 8 + 8 + 32 = 89
export const PENDING_REFUND_LEN = 121;       // 8 + 1 + 32 + 32 + 8 + 8 + 32 = 121
export const REFUNDED_REQUEST_LEN = 89;
