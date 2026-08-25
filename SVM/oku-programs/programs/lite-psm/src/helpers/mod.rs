//! Helpers — auxiliary modules used by lite-psm instructions.
//!
//! Numeric constants live in `crate::constants`. Pure-math helpers
//! (token amount ↔ dollar value, fee math) live in `math`. Runtime helpers
//! that interact with on-chain state or sysvars (the same-slot yield
//! fence, the cross-chain sync window, reading the ScaledUiAmount
//! multiplier) live in their named modules.
//!
//! `yield_lock` and `sync_window` are independent and both apply to the
//! price-sensitive instructions: the former is a same-slot atomicity
//! fence, the latter a wall-clock cross-chain propagation window. See
//! each module's scope note.

pub mod math;
pub mod scaled_ui;
pub mod sync_window;
pub mod yield_lock;

pub use math::*;
pub use scaled_ui::*;
pub use sync_window::*;
pub use yield_lock::*;
