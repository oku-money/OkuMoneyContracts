//! Helpers: `multiplier` (canonical price from the rate schedule), `display_sync`
//! (write-only `ScaledUiAmount` mirror), `yield_lock` (same-slot fence for the
//! emergency override), `math` (error-mapped conversions), `limits` (supply cap
//! and allowance checks).

pub mod display_sync;
pub mod limits;
pub mod math;
pub mod multiplier;
pub mod yield_lock;

pub use limits::*;
pub use math::*;
pub use yield_lock::*;
