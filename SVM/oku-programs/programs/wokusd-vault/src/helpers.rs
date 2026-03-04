use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{interest_bearing_mint::InterestBearingConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as SplMint,
};
use crate::errors::VaultError;

/// Dead shares permanently locked in an ATA owned by the System Program.
/// Nobody holds the System Program's private key, so the tokens are unrecoverable.
pub const MINIMUM_LIQUIDITY: u64 = 1_000_000; // 10^6 = 1 OkuUSD (6 decimals)

/// Seconds per year used by Token-2022's InterestBearing extension (365.24 days).
const SECONDS_PER_YEAR: f64 = 31_556_736.0;

/// Basis points denominator used by Token-2022's InterestBearing extension.
const BPS_DENOMINATOR: f64 = 10_000.0;

/// Compute the interest-adjusted balance for a Token-2022 account with an
/// InterestBearing extension.  Uses the same continuous-compounding formula as
/// Token-2022 so that vault share math matches the balance wallets display:
///
///   adjusted = raw_amount × e^(r1 × t1 / (10000 × 31556736))
///                         × e^(r2 × t2 / (10000 × 31556736))
///
/// where r1 = pre_update_average_rate, t1 = time from init to last rate change,
///       r2 = current_rate, t2 = time from last rate change to now.
///
/// Falls back to `raw_amount` if the mint has no InterestBearing extension.
pub fn compute_interest_adjusted_balance(
    raw_amount: u64,
    mint_account_info: &AccountInfo,
    unix_timestamp: i64,
) -> Result<u64> {
    if raw_amount == 0 {
        return Ok(0);
    }

    let mint_data = mint_account_info.data.borrow();
    let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
        .map_err(|_| VaultError::InvalidMintExtension)?;

    let interest_config = match mint_state.get_extension::<InterestBearingConfig>() {
        Ok(cfg) => cfg,
        Err(_) => return Ok(raw_amount), // No extension — return raw
    };

    let init_ts = i64::from(interest_config.initialization_timestamp) as f64;
    let last_update_ts = i64::from(interest_config.last_update_timestamp) as f64;
    let pre_rate = i16::from(interest_config.pre_update_average_rate) as f64;
    let cur_rate = i16::from(interest_config.current_rate) as f64;
    let now = unix_timestamp as f64;

    // Time intervals
    let t1 = (last_update_ts - init_ts).max(0.0);
    let t2 = (now - last_update_ts).max(0.0);

    let exp1 = (pre_rate * t1 / (BPS_DENOMINATOR * SECONDS_PER_YEAR)).exp();
    let exp2 = (cur_rate * t2 / (BPS_DENOMINATOR * SECONDS_PER_YEAR)).exp();

    // Guard: f64 can only represent integers exactly up to 2^53
    if raw_amount > (1u64 << 53) {
        return Err(VaultError::Overflow.into());
    }

    let adjusted = (raw_amount as f64) * exp1 * exp2;

    // Guard against NaN / Infinity from corrupted clock or rate data
    if !adjusted.is_finite() {
        return Err(VaultError::InvalidMintExtension.into());
    }

    // Guard: result must fit in u64
    if adjusted > u64::MAX as f64 {
        return Err(VaultError::Overflow.into());
    }

    let result = adjusted.floor() as u64;

    // Sanity: if rates are non-negative the adjusted value should be >= raw
    if cur_rate >= 0.0 && pre_rate >= 0.0 && result < raw_amount {
        return Ok(raw_amount);
    }

    Ok(result)
}
