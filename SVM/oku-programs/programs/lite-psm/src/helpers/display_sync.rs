//! Wallet-display mirror: a lagging, permissionlessly-cranked copy of the
//! canonical multiplier in the mint's `ScaledUiAmountConfig`.
//!
//! Wallets render Token-2022 UI amounts through a step function, so a stream
//! cannot be shown without transactions. See SVM/README.md, "The mint extension is
//! NOT the source of truth".
//!
//! Invariant: `display <= canonical`, always. Two legs:
//! 1. Each sync writes only `m(now)`, effective immediately, so the display is a
//!    pure lag behind a monotonically increasing curve.
//! 2. The `f64` conversion is biased downward ([`multiplier_to_f64_floor`]).

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;
use oku_shared::PRECISION;

/// Convert a WAD-scaled multiplier to the `f64` the extension stores, biased
/// two ULPs **downward** so the result never exceeds `m / PRECISION`.
///
/// A compare-and-step-down check cannot work: `m as f64` is itself lossy at WAD
/// scale, so both sides of the comparison are rounded.
///
/// Bias proof sketch. Let `u = 2^-53` and `q = fl(fl(m) / 1e18)`; `1e18` is
/// exact in `f64`, so two roundings occur and `q <= (m/P)(1+u)^2`. One
/// `next_down` removes one ULP, which is at least `u * value` (relative ULP
/// spans `2^-53..2^-52` across a binade), so two steps give `f <= q(1-u)^2`.
/// Hence `f <= (m/P)(1-u^2)^2 < m/P` on all of `[PRECISION, MAX_MULTIPLIER]`.
/// The slack is second-order: the decrement exactly cancels the roundings.
///
/// Do not add a third rounding (an `f32` hop, a normalising multiply, a
/// different divisor): it breaks the cancellation. The tests check the bound in
/// exact integer arithmetic for this reason.
///
/// Rendered impact is invisible: OkuM has 6 decimals and the bias is ~2e-16
/// relative, far below the by-design lag of one crank interval.
#[inline]
pub fn multiplier_to_f64_floor(multiplier: u128) -> f64 {
    let scaled = multiplier as f64 / PRECISION as f64;
    if scaled <= 0.0 || !scaled.is_finite() {
        // Unreachable for multipliers >= PRECISION; `next_down` would turn +0.0
        // into a negative subnormal, which a mint must never store.
        return scaled;
    }
    scaled.next_down().next_down()
}

/// Push `multiplier` into the mint's `ScaledUiAmountConfig`, effective now.
///
/// The timestamp is read from `Clock` here rather than taken as a parameter, so
/// a caller cannot pair a multiplier with an effective time it was not computed
/// at. Callers must still pass a multiplier evaluated at the current time.
///
/// Does NOT stamp `last_yield_distribution_slot`: display syncs are cosmetic and
/// must not engage the yield lock.
pub fn write_display_multiplier<'info>(
    multiplier: u128,
    config: &Account<'info, PsmConfig>,
    oku_m_mint: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
) -> Result<()> {
    // Token-2022 treats an effective timestamp at or before `now` as immediate.
    let effective_timestamp = Clock::get()?.unix_timestamp;

    let ix = update_multiplier(
        &token_2022_program.key(),
        &oku_m_mint.key(),
        &config.key(),
        &[],
        multiplier_to_f64_floor(multiplier),
        effective_timestamp,
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    let bump_seed = [config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[oku_m_mint.clone(), config.to_account_info()],
        signer,
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    Ok(())
}

// Do not piggyback a display sync onto PSM instructions: ~31k CU on a cold mint.

#[cfg(test)]
mod tests {
    use super::*;

    const F64_MANTISSA_BITS: u32 = 52;
    const F64_EXPONENT_MASK: u64 = 0x7ff;
    /// Exponent bias (1023) plus mantissa width: `value = int_mantissa * 2^(E - this)`.
    const F64_EXPONENT_OFFSET: i32 = 1023 + F64_MANTISSA_BITS as i32;

    /// Exact integer check of `f * PRECISION <= m`, with no float arithmetic.
    ///
    /// A positive normal `f64` is `mantissa * 2^exp` with an integer mantissa, so
    /// the claim is `mantissa * 1e18 <= m * 2^-exp`. The right side reaches
    /// `2^132`, so it is held as two `u128` limbs and compared lexicographically.
    fn scaled_f64_does_not_exceed(f: f64, m: u128) -> bool {
        assert!(
            f.is_normal() && f > 0.0,
            "domain: {f} must be a positive normal"
        );

        let bits = f.to_bits();
        let frac = bits & ((1u64 << F64_MANTISSA_BITS) - 1);
        let exp_field = ((bits >> F64_MANTISSA_BITS) & F64_EXPONENT_MASK) as i32;
        let mantissa = u128::from(frac | (1u64 << F64_MANTISSA_BITS));
        let exp = exp_field - F64_EXPONENT_OFFSET;
        assert!(
            exp < 0,
            "domain: quotient in [1, 1e6] always has a negative binary exponent, got {exp}"
        );
        let k = (-exp) as u32;
        assert!(k < 128, "shift {k} must stay within a u128 limb");

        // lhs < 2^113 fits one limb; rhs = m << k needs two.
        let (lhs_hi, lhs_lo) = (0u128, mantissa * PRECISION);
        let rhs_hi = if k == 0 { 0 } else { m >> (128 - k) };
        let rhs_lo = m << k;

        (lhs_hi, lhs_lo) <= (rhs_hi, rhs_lo)
    }

    /// One minimum-margin witness per binade of the domain, found by search and
    /// pinned: the weak point depends jointly on the bit patterns of `fl(m)` and
    /// the division, so it has no closed form. Margin is the exact integer
    /// quantity `m - f * 1e18`; each witness violates the invariant if one
    /// `next_down` is removed.
    fn weak_region_cases() -> Vec<u128> {
        vec![
            1_997_203_241_501_062_532u128,
            3_999_017_787_520_303_880u128,
            7_875_329_349_306_348_039u128,
            15_888_210_600_498_533_406u128,
            31_807_397_162_189_555_722u128,
            63_252_122_006_378_598_403u128,
            126_191_910_504_054_546_725u128,
            253_799_449_563_676_033_079u128,
            508_184_927_894_374_024_509u128,
            1_015_560_402_451_498_470_997u128,
            2_044_213_198_655_876_105_406u128,
            4_092_893_284_482_870_939_269u128,
            8_028_163_178_843_396_904_108u128,
            16_338_682_553_429_602_124_857u128,
            32_229_466_972_163_277_868_396u128,
            63_880_056_560_116_310_219_093u128,
            131_046_072_564_624_903_904_170u128,
            262_119_928_263_077_219_707_753u128,
            516_602_446_857_463_856_625_421u128,
            987_430_109_884_523_662_499_314u128,
        ]
    }

    #[test]
    fn f64_conversion_never_exceeds_canonical_exactly() {
        let mut cases = vec![
            PRECISION,
            PRECISION + 1,
            1_000_000_000_000_000_001u128,
            1_037_419_283_746_192_837u128,
            2 * PRECISION,
            oku_shared::MAX_MULTIPLIER,
            oku_shared::MAX_MULTIPLIER - 1,
            // Fixed low-margin regression pin.
            130_576_977_149_543_642_620_974u128,
        ];
        cases.extend(weak_region_cases());

        // Deterministic LCG sweep across the whole domain.
        let mut state: u128 = 0x2545_F491_4F6C_DD1D;
        let span = oku_shared::MAX_MULTIPLIER - PRECISION;
        for _ in 0..20_000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            cases.push(PRECISION + (state % span));
        }

        for m in cases {
            let f = multiplier_to_f64_floor(m);
            assert!(
                scaled_f64_does_not_exceed(f, m),
                "display mirror exceeded canonical for m = {m} (f = {f:e})"
            );
        }
    }

    /// The bias must also stay small: a floor that undershoots badly would pass
    /// the exactness test while being wrong for users. A float comparison is fine
    /// here because `1e-14` is orders above the measurement's own rounding.
    #[test]
    fn f64_conversion_bias_stays_below_rendered_precision() {
        let mut cases = vec![PRECISION, 2 * PRECISION, oku_shared::MAX_MULTIPLIER];
        cases.extend(weak_region_cases());

        for m in cases {
            // `exact` is the f64 approximation the floor steps down from, so only
            // magnitude is checked here; direction is proven exactly above.
            let exact = m as f64 / PRECISION as f64;
            let f = multiplier_to_f64_floor(m);

            let rel_bias = (exact - f) / exact;
            assert!(
                rel_bias < 1e-14,
                "bias {rel_bias} is larger than intended for {m}"
            );
        }
    }

    /// Bound the bias in dollars: at `u64::MAX` raw the shortfall is under a cent.
    #[test]
    fn bias_is_negligible_in_dollar_terms_at_every_representable_balance() {
        let m = 1_037_419_283_746_192_837u128; // ~1.037x
        let f = multiplier_to_f64_floor(m);
        let exact = m as f64 / PRECISION as f64;
        let rel_bias = (exact - f) / exact;

        let max_position_usd = (u64::MAX as f64 / 1e6) * exact;
        let shortfall_usd = rel_bias * max_position_usd;
        assert!(
            shortfall_usd < 0.01,
            "bias costs ${shortfall_usd} at the maximum representable position"
        );

        // Dwarfed by the by-design staircase lag (one crank at 60s, 20% APY).
        const TYPICAL_CRANK_SECS: f64 = 60.0;
        let staircase_lag_rel = 0.20_f64.ln_1p() * TYPICAL_CRANK_SECS / 31_536_000.0;
        assert!(
            rel_bias * 1_000.0 < staircase_lag_rel,
            "f64 bias {rel_bias} is not negligible next to the {staircase_lag_rel} staircase lag"
        );
    }
}
