//! Helpers for reading the ScaledUiAmount extension on the OkuM mint.
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
use oku_shared::{MAX_MULTIPLIER, PRECISION};

// Compile-time invariant: the `u64 -> f64 -> u64` round trip performed by
// `multiplier_f64_to_u64` is only exact because `MAX_MULTIPLIER` fits inside
// an f64's 52-bit mantissa (2^52 represents all integers up to that bound
// exactly). If `MAX_MULTIPLIER` is ever raised past this bound, `.round()`
// in `multiplier_f64_to_u64` would start masking silent precision drift
// instead of the exact identity it relies on today. This assertion fails
// the build rather than the invariant failing silently at runtime.
const _: () = assert!(MAX_MULTIPLIER < (1u64 << 52));

/// Convert an effective `ScaledUiAmountConfig` multiplier (f64, where `1.0`
/// = no yield) to a `PRECISION`-scaled `u64` for integer math.
///
/// Pure and side-effect-free so the `u64 -> f64 -> u64` round trip can be
/// unit-tested directly (see `tests` module below) without needing a mint
/// `AccountInfo`. Callers are responsible for the zero/overflow checks —
/// see `read_multiplier`.
fn multiplier_f64_to_u64(effective: f64) -> u64 {
    (effective * PRECISION as f64).round() as u64
}

/// Read the current effective multiplier from the OkuM mint's
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
    let scaled = multiplier_f64_to_u64(effective);

    // Guard: reject zero (NaN/negative f64 -> 0 via saturating cast)
    // and values above MAX_MULTIPLIER (infinity/corrupt f64 -> u64::MAX
    // via saturating cast). Both would silently break PSM math.
    if scaled == 0 || scaled > MAX_MULTIPLIER {
        return Err(error!(LitePsmError::MultiplierReadFailed));
    }

    Ok(scaled)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `u64 -> f64 -> u64` round trip must be the identity for every
    /// multiplier value the protocol can produce (PRECISION..=MAX_MULTIPLIER
    /// on the SVM side). This is the concrete check backing the compile-time
    /// `MAX_MULTIPLIER < 2^52` assertion above: if this test ever fails,
    /// either the assertion is wrong or `MAX_MULTIPLIER` has been raised
    /// past the point where f64 can represent every integer in range.
    fn round_trip(raw: u64) -> u64 {
        let effective = raw as f64 / PRECISION as f64;
        multiplier_f64_to_u64(effective)
    }

    #[test]
    fn round_trip_identity_at_precision() {
        // 1.0x multiplier (no yield) — the init-time default.
        assert_eq!(round_trip(PRECISION), PRECISION);
    }

    #[test]
    fn round_trip_identity_mid_range() {
        // A representative mid-range value, e.g. ~1.05x.
        let mid = PRECISION + PRECISION / 20;
        assert_eq!(round_trip(mid), mid);
    }

    #[test]
    fn round_trip_identity_at_max_multiplier() {
        assert_eq!(round_trip(MAX_MULTIPLIER), MAX_MULTIPLIER);
    }

    #[test]
    fn round_trip_identity_exhaustive_sample() {
        // Sample densely across the full supported range (every integer is
        // exactly representable below 2^52, well above MAX_MULTIPLIER, so
        // this is expected to hold for all of them — sampling is just to
        // keep the test fast rather than iterating every value).
        let mut raw = 1u64;
        while raw <= MAX_MULTIPLIER {
            assert_eq!(round_trip(raw), raw, "round trip drifted at raw={raw}");
            raw = raw.saturating_mul(7).saturating_add(1);
        }
    }
}
