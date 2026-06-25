//! # oku-shared
//!
//! Protocol-wide constants and pure-math primitives shared by every program
//! in the OkuMoney SVM workspace (`lite-psm`, `oku-dollar`, and any future
//! program that needs to agree on a number with the rest of the protocol).
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
//!    `LitePsmError::Overflow` / `OkuDollarError::Overflow` without
//!    coupling the crates to a single error type.
//! 3. **No state, no I/O.** Just constants and pure functions.

// F-17: Zero unsafe code in this crate (confirmed by cargo-geiger).
#![forbid(unsafe_code)]

pub mod constants;
pub mod math;
pub mod vault_math;
pub mod yield_lock;

// Re-export the public surface at crate root so callers can write
// `use oku_shared::{PRECISION, mul_div_floor};` instead of nested paths.
pub use constants::*;
pub use math::*;
pub use yield_lock::yield_lock_engaged;
// `vault_math` types intentionally NOT glob-re-exported — the function
// names collide with `oku-dollar`'s own helpers wrappers. Callers
// reference them as `oku_shared::vault_math::*`.
