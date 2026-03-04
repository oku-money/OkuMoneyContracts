use anchor_lang::prelude::*;
use crate::errors::OkuError;

/// Calculate the interest-bearing value of a raw OkuUSD amount
/// Uses the Token-2022 Interest-Bearing extension formula (continuous compounding):
/// ui_amount = raw_amount × e^(rate_bps × time_elapsed / (10000 × SECONDS_PER_YEAR))
///
/// Matches the vault's `compute_interest_adjusted_balance` and Token-2022's native formula.
///
// TODO: Revisit f64 usage — consider replacing with fixed-point integer math
// (u128 Taylor series) if BPF float determinism proves problematic. See audit notes.
pub fn calculate_interest_bearing_value(
    raw_amount: u64,
    rate_bps: i16,
    time_elapsed_secs: i64,
) -> Result<u64> {
    // Handle edge cases
    if time_elapsed_secs <= 0 || rate_bps <= 0 {
        return Ok(raw_amount);
    }

    /// Seconds per year used by Token-2022's InterestBearing extension (365.24 days).
    const SECONDS_PER_YEAR: f64 = 31_556_736.0;
    const BPS_DENOMINATOR: f64 = 10_000.0;

    let exponent = (rate_bps as f64) * (time_elapsed_secs as f64)
        / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    let adjusted = (raw_amount as f64) * exponent.exp();

    // Guard against NaN / Infinity from corrupted data
    if !adjusted.is_finite() {
        return Err(OkuError::Overflow.into());
    }

    let result = adjusted.floor() as u64;

    Ok(result)
}
