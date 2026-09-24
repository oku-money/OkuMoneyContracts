//! The canonical OkuM multiplier.
//!
//! ## Where the multiplier lives (and where it does NOT)
//!
//! It is **computed**, never stored. The source of truth is the six-field
//! rate schedule on [`PsmConfig`] plus `Clock::unix_timestamp`.
//!
//! The mint's Token-2022 `ScaledUiAmountConfig` extension is a **write-only
//! display mirror**: the program pushes values to it for wallets to render and
//! never reads them back. Consequences worth internalising before touching
//! this file:
//!
//! - The extension value **lags** the canonical value by up to one display
//!   sync interval. That is by design and is safe in one direction only:
//!   display must always be `<=` canonical, so a redeem pays at least what
//!   the wallet showed. See `helpers::display_sync`.
//! - Nothing in the PSM may price against the extension. Mint, redeem, direct
//!   mint and direct burn all call [`current`]. Do not add a read path.
//!
//! EVM counterpart: `OkuMoney.okuMMultiplier()`, likewise a view over schedule
//! state with no stored index.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::rate::Schedule;

/// Project the config's accrual fields into the shared math crate's
/// [`Schedule`] type.
///
/// The widths differ deliberately — `PsmConfig` stores rates as `u64` (the
/// same width EVM packs them into) while the math crate works in `u128` — so
/// this is the single place the conversion happens.
#[inline]
pub fn schedule_of(config: &PsmConfig) -> Schedule {
    Schedule {
        base_multiplier: config.okum_base_multiplier,
        rate_per_second: config.okum_rate_per_second as u128,
        last_accrual_time: config.okum_last_accrual_time,
        rate_end: config.okum_rate_end,
        pending_rate_per_second: config.okum_pending_rate_per_second as u128,
        pending_rate_end: config.okum_pending_rate_end,
    }
}

/// The canonical multiplier at a given timestamp.
///
/// Every caller passes the current clock reading; the explicit parameter only
/// lets one `Clock::get()` be threaded through an instruction that also needs
/// `now_ts` for its own writes.
#[inline]
pub fn at(config: &PsmConfig, unix_timestamp: i64) -> Result<u128> {
    schedule_of(config)
        .multiplier_at(unix_timestamp)
        .ok_or_else(|| error!(LitePsmError::MultiplierOutOfRange))
}

/// The canonical multiplier right now. This is what every PSM operation
/// prices against.
#[inline]
pub fn current(config: &PsmConfig) -> Result<u128> {
    at(config, Clock::get()?.unix_timestamp)
}

/// The rate that is *actually* accruing right now.
///
/// This lags the stored `okum_rate_per_second` once the active window has
/// closed: past `okum_rate_end` the successor is accruing, and past
/// `okum_pending_rate_end` nothing is. The pause gate compares against THIS
/// rather than the stored value, otherwise a stale storage rate could be used
/// to dress an increase up as a decrease and slip past the gate while the
/// protocol is paused.
///
/// EVM counterpart: `OkuMoney._effectiveRate`; the same hole is closed there
/// and regression-tested in `EVM/test/token/OkuMoney.t.sol`.
#[inline]
pub fn effective_rate(config: &PsmConfig, unix_timestamp: i64) -> u128 {
    schedule_of(config).effective_rate(unix_timestamp)
}
