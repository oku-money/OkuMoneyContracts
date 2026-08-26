//! # oku-shared
//!
//! Protocol-wide constants and pure-math primitives shared by the
//! OkuM SVM workspace (`lite-psm` and any future program that needs
//! to agree on a number with the rest of the protocol).
//!
//! This crate is the SVM-side counterpart to `EVM/src/lib/Constants.sol` +
//! `EVM/src/lib/MathLib.sol`. Anything that has a corresponding EVM constant
//! lives here, with a doc-comment cross-referencing the EVM source so the
//! two stay in sync.
//!
//! ## Design rules
//!
//! 1. **No dependencies.** This crate is pure Rust — no `solana-*`, no
//!    `anchor-lang`. That keeps it cheap to compile, free of cross-version
//!    drift, and usable from arbitrary downstream tooling (e.g. an
//!    integration-test harness, a back-of-envelope simulator).
//! 2. **No `Result` types.** Math primitives return `Option<u64>` (None on
//!    overflow / division-by-zero) so each program can map them to its own
//!    `LitePsmError::Overflow` without coupling the crates to a single
//!    error type.
//! 3. **No state, no I/O.** Just constants and pure functions.

// No unsafe code anywhere in this crate.
#![forbid(unsafe_code)]

pub mod constants;
pub mod math;
pub mod step_coverage;
pub mod sync_window;
pub mod yield_lock;

// Re-export the public surface at crate root so callers can write
// `use oku_shared::{PRECISION, mul_div_floor};` instead of nested paths.
pub use constants::*;
pub use math::*;
pub use step_coverage::step_bps_ceil;
pub use sync_window::{sync_window_end, sync_window_engaged};
pub use yield_lock::yield_lock_engaged;
