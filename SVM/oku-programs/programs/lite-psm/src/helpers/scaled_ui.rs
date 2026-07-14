//! Helpers for reading the ScaledUiAmount extension on the usdOku mint.
//!
//! The multiplier stored in this extension is the single source of truth
//! for the raw-token-to-dollar conversion rate. All mint/redeem/yield
//! instructions read the current multiplier via [`read_multiplier`].

use crate::errors::LitePsmError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintRaw;
use oku_shared::PRECISION;

/// Read the current effective multiplier from the usdOku mint's
/// `ScaledUiAmountConfig` extension and convert the f64 value to a
/// PRECISION-scaled u64 for use in integer math.
///
/// # ScaledUiAmountConfig layout
///
/// The extension stores three fields beyond the authority pubkey:
///
/// | Field | Type | Description |
/// |-------|------|-------------|
/// | `multiplier` | f64 | Base multiplier (set by init; rotated by `UpdateMultiplier`) |
/// | `new_multiplier_effective_timestamp` | i64 | When `new_multiplier` activates |
/// | `new_multiplier` | f64 | Scheduled multiplier (written by `UpdateMultiplier`) |
///
/// # Zero-init edge case
///
/// After `InitializeScaledUiAmountConfig(multiplier: 1.0)`, the on-chain
/// state is:
///
/// ```text
/// multiplier                         = 1.0   (set by init)
/// new_multiplier                     = 0.0   (account zero-init)
/// new_multiplier_effective_timestamp = 0     (account zero-init)
/// ```
///
/// The canonical `current_multiplier()` in spl-token-2022 returns
/// `new_multiplier` when `unix_timestamp >= effective_timestamp`, which
/// is always true (timestamp >= 0). This would return 0.0 — wrong.
///
/// We guard against this by checking `new_multiplier > 0.0` before
/// using it. When `new_multiplier` is zero (never been set via
/// `UpdateMultiplier`), we fall back to the base `multiplier` field,
/// which is always set correctly by init.
///
/// After the first `UpdateMultiplier` call, `new_multiplier` will be
/// positive and this guard becomes a no-op pass-through.
///
/// # Errors
///
/// Returns `MultiplierReadFailed` if:
/// - The mint account data cannot be unpacked
/// - The `ScaledUiAmountConfig` extension is not present
/// - The effective multiplier converts to 0 in u64
pub fn read_multiplier(mint_account: &AccountInfo) -> Result<u64> {
    use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig;

    let data = mint_account.try_borrow_data()?;
    let mint_state = StateWithExtensions::<MintRaw>::unpack(&data)
        .map_err(|_| error!(LitePsmError::MultiplierReadFailed))?;

    let config = mint_state
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| error!(LitePsmError::MultiplierReadFailed))?;

    let clock = Clock::get()?;

    let base_mult: f64 = config.multiplier.into();
    let new_mult: f64 = config.new_multiplier.into();
    let effective_ts: i64 = config.new_multiplier_effective_timestamp.into();

    // See doc-comment "Zero-init edge case" above.
    let effective: f64 = if new_mult > 0.0 && clock.unix_timestamp >= effective_ts {
        new_mult
    } else {
        base_mult
    };

    // Convert f64 to PRECISION-scaled u64.
    // A multiplier of 1.0 yields PRECISION (1_000_000_000).
    let scaled = (effective * PRECISION as f64) as u64;
    if scaled == 0 {
        return Err(error!(LitePsmError::MultiplierReadFailed));
    }

    Ok(scaled)
}
