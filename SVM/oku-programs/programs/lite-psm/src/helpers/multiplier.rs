//! The canonical OkuM multiplier: computed from the rate schedule on
//! [`PsmConfig`] and the clock, never stored. Every PSM price comes from
//! [`current`] / [`at`]; the Token-2022 `ScaledUiAmount` extension is a
//! write-only display mirror (see `display_sync`) and must never be read back
//! for pricing. EVM: `OkuMoney.okuMMultiplier()`.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::rate::Schedule;

/// Project the config's accrual fields into [`Schedule`] (rates widen `u64` -> `u128`).
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

/// The canonical multiplier at `unix_timestamp` (lets callers reuse one `Clock` read).
#[inline]
pub fn at(config: &PsmConfig, unix_timestamp: i64) -> Result<u128> {
    schedule_of(config)
        .multiplier_at(unix_timestamp)
        .ok_or_else(|| error!(LitePsmError::MultiplierOutOfRange))
}

/// The canonical multiplier now.
#[inline]
pub fn current(config: &PsmConfig) -> Result<u128> {
    at(config, Clock::get()?.unix_timestamp)
}

/// The rate actually accruing now (the successor or nothing once the stored
/// window has closed). The pause gate compares against this, not the stored
/// rate, so a stale rate cannot disguise an increase as a decrease.
/// EVM: `OkuMoneyRateSchedule.okuMEffectiveRatePerSecond`.
#[inline]
pub fn effective_rate(config: &PsmConfig, unix_timestamp: i64) -> u128 {
    schedule_of(config).effective_rate(unix_timestamp)
}
