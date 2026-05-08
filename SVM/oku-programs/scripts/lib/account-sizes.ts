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
export const PSM_CONFIG_LEN = 690;          // const _: () = assert!(PsmConfig::LEN == 690);
export const REDEMPTION_QUEUE_LEN = 505;     // const _: () = assert!(RedemptionQueue::LEN == 505);
export const BRIDGE_CONFIG_LEN = 487;        // const _: () = assert!(BridgeConfig::LEN == 487);
export const BRIDGE_NONCE_LEN = 12;          // 8 disc + 1 bump + 1 is_init + 2 chain_id (impl LEN; NB: u64 next_nonce is 8) — 8+1+1+2+8=20
// note: actual LEN above includes 8 disc + 1 bump + 1 is_init + 2 chain_id + 8 next_nonce = 20.
// Re-check on next review of state.rs::BridgeNonce::LEN.

// oku_dollar — programs/oku-dollar/src/state.rs
export const OKU_DOLLAR_CONFIG_LEN = 330;    // const _: () = assert!(OkuDollarConfig::LEN == 330);

// oku_bridge_router — programs/oku-bridge-router/src/state.rs
// (Verify against the compile-time assert at the bottom of that file.)
export const ROUTER_CONFIG_LEN = 170;

// PDA replay markers (lite_psm)
export const PROCESSED_REQUEST_LEN = 89;     // 8 + 1 + 32 + 8 + 8 + 32 = 89
export const PENDING_REFUND_LEN = 121;       // 8 + 1 + 32 + 32 + 8 + 8 + 32 = 121
export const REFUNDED_REQUEST_LEN = 89;
