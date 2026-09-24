//! Helpers — auxiliary modules used by lite-psm instructions.
//!
//! Numeric constants live in `crate::constants`. Pure-math helpers
//! (token amount ↔ dollar value) live in `math`. Runtime helpers that
//! interact with on-chain state or sysvars live in their named modules:
//!
//! - `multiplier` — the canonical OkuM multiplier, computed on read from the
//!   rate schedule on `PsmConfig`. Every price in the PSM comes from here.
//! - `display_sync` — the write-only Token-2022 `ScaledUiAmount` display
//!   mirror. Cosmetic; nothing prices against it.
//! - `yield_lock` — the same-slot sandwich fence, which under streaming
//!   accrual fires only on the emergency multiplier override.

pub mod display_sync;
pub mod math;
pub mod multiplier;
pub mod yield_lock;

pub use math::*;
pub use yield_lock::*;
