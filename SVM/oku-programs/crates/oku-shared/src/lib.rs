//! Dependency-free constants and pure math shared by the SVM programs; the
//! counterpart to `EVM/src/lib/Constants.sol` and `MathLib.sol`. Primitives
//! return `Option` so each program maps `None` to its own overflow error.

#![forbid(unsafe_code)]

pub mod constants;
pub mod math;
pub mod rate;
pub mod wad;
pub mod yield_lock;

pub use constants::*;
pub use math::*;
pub use rate::{compound_for, compute_multiplier, rpow, Schedule};
// `wad::mul_div_floor_u128_narrow` is not re-exported: it has a precondition
// its siblings lack. Use the full path.
pub use wad::{mul_div_wad_floor, mul_div_wad_half_up};
pub use yield_lock::yield_lock_engaged;
