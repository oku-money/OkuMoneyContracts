//! Wallet-display mirror: a lagging, permissionlessly-cranked copy of the
//! canonical multiplier in the mint's `ScaledUiAmountConfig`.
//!
//! Wallets render Token-2022 UI amounts through a step function, so a stream
//! cannot be shown without transactions. See SVM/README.md, "The mint extension is
//! NOT the source of truth".
//!
//! Invariant: `display <= canonical`, always, at the balance level. Three legs:
//! 1. Each sync writes only `m(now)`, effective immediately, so the display is a
//!    pure lag behind a monotonically increasing curve.
//! 2. The `f64` conversion is biased downward ([`multiplier_to_f64_floor`]).
//! 3. The bias is large enough that Token-2022's own rounding, when it multiplies
//!    a balance by the stored `f64`, cannot round a rendered amount up past the
//!    PSM's integer redeem floor (Cyfrin audit finding #23).

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;
use oku_shared::PRECISION;

/// Convert a WAD-scaled multiplier to the `f64` the extension stores, biased
/// three ULPs **downward** so the result never exceeds `m / PRECISION` and a
/// rendered balance never exceeds `raw_to_dollars(balance, m)`.
///
/// A compare-and-step-down check cannot work: `m as f64` is itself lossy at WAD
/// scale, so both sides of the comparison are rounded.
///
/// Let `u = 2^-53` and `x = m / PRECISION` (exact real).
///
/// Leg 1, `f2 <= x`. `1e18` is exact in `f64`, so `q = fl(fl(m) / 1e18)` carries
/// two roundings and `q <= x(1+u)^2`. One `next_down` removes one ULP, which is at
/// least `u * value`, so two steps give `f2 <= q(1-u)^2 <= x(1-u^2)^2 < x`. The
/// slack is second-order: the decrement exactly cancels the roundings.
///
/// Leg 2, the balance level. Token-2022 renders a balance `a` as
/// `trunc(fl(a as f64 * f))`, a THIRD rounding. For `a <= 2^53`, `a as f64` is
/// exact and `fl(a f) <= a f (1+u)`, so the render exceeds the exact floor
/// `floor(a x)` only if `f(1+u) >= x`. With `f2` that is possible: `x - f2` can be
/// as small as ~0.95 `u f2`, and a product just under an integer then rounds UP
/// across it. One more `next_down` moves `f` down by at least `u * f2`, so
/// `x - f3 >= f2 - f3 >= u f2 > u f3`, i.e. `f3 (1+u) < x`, hence
/// `fl(a f3) < a x` and the truncation cannot exceed `floor(a x)`.
///
/// Precondition: balances at most `2^53` raw (9.007e15, ~9.0 billion OkuM at 6
/// decimals), where `a as f64` is exact. The deploy supply cap is 1e15 raw. A
/// `set_max_supply` above `2^53` would add a fourth, uncovered rounding.
///
/// Caveat: this holds for Token-2022's truncating renderer (`amount_to_ui_amount`
/// in `spl-token-2022-interface`, pinned in Cargo.lock). A client that rounds to
/// nearest instead of truncating can still display one unit more; derive any
/// `min_usdc_out` from the canonical multiplier, not from the displayed amount
/// (SVM/README.md, "The mint extension is NOT the source of truth").
///
/// Do not add another rounding (an `f32` hop, a normalising multiply, a
/// different divisor): it breaks the cancellation. The tests check the bound in
/// exact integer arithmetic, and the render against the real Token-2022 code.
///
/// Rendered impact is invisible: OkuM has 6 decimals and the bias is ~3e-16
/// relative, far below the by-design lag of one crank interval.
#[inline]
pub fn multiplier_to_f64_floor(multiplier: u128) -> f64 {
    let scaled = multiplier as f64 / PRECISION as f64;
    if scaled <= 0.0 || !scaled.is_finite() {
        // Unreachable for multipliers >= PRECISION; `next_down` would turn +0.0
        // into a negative subnormal, which a mint must never store.
        return scaled;
    }
    scaled.next_down().next_down().next_down()
}

/// Push `multiplier` into the mint's `ScaledUiAmountConfig`, effective now.
///
/// The timestamp is read from `Clock` here rather than taken as a parameter, so
/// a caller cannot pair a multiplier with an effective time it was not computed
/// at. Callers must still pass a multiplier evaluated at the current time.
///
/// Does NOT stamp `last_override_slot`: display syncs are cosmetic and
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
    /// quantity `m - f * 1e18`; each witness violates the leg-1 invariant at ONE
    /// `next_down` (the production function takes three, see leg 2).
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

    // ---- Leg 2 (Cyfrin audit finding #23): Token-2022's balance-level rounding ----

    use crate::helpers::raw_to_dollars;
    use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig;

    const U: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53

    /// `m / PRECISION` stepped down `k` ULPs, the stored value for a `k`-step floor.
    fn floor_steps(m: u128, k: u32) -> f64 {
        let mut f = m as f64 / PRECISION as f64;
        for _ in 0..k {
            f = f.next_down();
        }
        f
    }

    /// What a wallet shows for `raw` at stored multiplier `f`, in micro-units, through
    /// the real Token-2022 `amount_to_ui_amount` (the string path wallets use).
    fn rendered_micro(raw: u64, f: f64) -> u128 {
        let cfg = ScaledUiAmountConfig {
            multiplier: f.into(),
            new_multiplier: f.into(),
            new_multiplier_effective_timestamp: 0i64.into(),
            ..ScaledUiAmountConfig::default()
        };
        let ui = cfg
            .amount_to_ui_amount(raw, crate::constants::TOKEN_DECIMALS, 0)
            .unwrap();
        let (int, frac) = ui.split_once('.').unwrap_or((ui.as_str(), ""));
        let mut frac = frac.to_string();
        while frac.len() < 6 {
            frac.push('0');
        }
        int.parse::<u128>().unwrap() * 1_000_000 + frac.parse::<u128>().unwrap()
    }

    /// The renderer's own arithmetic without the string round trip (about 20x faster).
    fn rendered_trunc(raw: u64, f: f64) -> u128 {
        (raw as f64 * f).trunc() as u128
    }

    /// `(x - f) / f` with `x = m / PRECISION`, from the exact integer difference
    /// `m * 2^k - mantissa * PRECISION` (same representation as the exactness check).
    fn gap_rel(f: f64, m: u128) -> f64 {
        let bits = f.to_bits();
        let mantissa = u128::from((bits & ((1u64 << 52) - 1)) | (1u64 << 52));
        let exp_field = ((bits >> 52) & 0x7ff) as i32;
        let k = (-(exp_field - 1075)) as u32;
        let lhs = mantissa * PRECISION;
        let (rhs_hi, rhs_lo) = (m >> (128 - k), m << k);
        let (d_lo, borrow) = rhs_lo.overflowing_sub(lhs);
        let d = (rhs_hi - u128::from(borrow)) as f64 * 2f64.powi(128) + d_lo as f64;
        d / lhs as f64
    }

    /// Cases found by search where the TWO-step floor renders one unit above the exact
    /// floor: `(canonical multiplier, raw balance)`. The first is the reporter's.
    const TWO_STEP_WITNESSES: [(u128, u64); 7] = [
        (1_849_869_492_742_330_240, 37_161_506_851),
        (1_931_959_294_739_476_354, 2_279_920_147_080),
        (1_970_136_445_134_836_867, 285_681_991_495),
        (1_967_231_701_295_444_097, 35_218_749_176),
        (1_969_094_761_694_622_601, 2_272_028_795_448),
        (1_962_681_304_767_221_130, 2_250_323_727_643),
        (3_993_942_752_493_790_478, 138_416_498_441),
    ];

    /// The reported case, through the real Token-2022 renderer: the wallet balance
    /// must not exceed what the PSM redeems.
    #[test]
    fn rendered_balance_never_exceeds_psm_redeem_floor_reported_case() {
        const CANONICAL_MULTIPLIER: u128 = 1_849_869_492_742_330_240;
        const RAW_OKU_M: u64 = 37_161_506_851;

        let redeemable = u128::from(raw_to_dollars(RAW_OKU_M, CANONICAL_MULTIPLIER).unwrap());
        assert_eq!(redeemable, 68_743_937_827);

        // The old two-step value is what Cyfrin reproduced: it renders one unit too high.
        let old = floor_steps(CANONICAL_MULTIPLIER, 2);
        assert_eq!(old.to_bits(), 0x3ffd_9910_c0d3_2486);
        assert_eq!(rendered_micro(RAW_OKU_M, old), redeemable + 1);

        let stored = multiplier_to_f64_floor(CANONICAL_MULTIPLIER);
        assert_eq!(
            stored.to_bits(),
            old.to_bits() - 1,
            "one ULP lower than before"
        );
        assert_eq!(rendered_micro(RAW_OKU_M, stored), redeemable);
    }

    /// Every pinned case renders above the floor with two steps (so the third is
    /// necessary) and at or below it with the production function.
    #[test]
    fn two_step_floor_overshoots_and_production_floor_does_not() {
        for (m, a) in TWO_STEP_WITNESSES {
            let exact = u128::from(raw_to_dollars(a, m).unwrap());
            assert_eq!(
                rendered_micro(a, floor_steps(m, 2)),
                exact + 1,
                "m = {m}, a = {a}"
            );
            let shown = rendered_micro(a, multiplier_to_f64_floor(m));
            assert!(
                shown <= exact,
                "m = {m}, a = {a}: shown {shown} > redeemable {exact}"
            );
        }
    }

    /// Around each pinned case, every consecutive balance in a window (a few hundred
    /// thousand, spanning several rounding patterns): two steps overshoot somewhere,
    /// the production floor never does.
    #[test]
    fn dense_balance_windows_around_witnesses() {
        const HALF_WINDOW: u64 = 40_000;
        for (m, a0) in TWO_STEP_WITNESSES {
            let (f2, f3) = (floor_steps(m, 2), multiplier_to_f64_floor(m));
            let (mut over2, mut over3) = (0u32, 0u32);
            for a in (a0 - HALF_WINDOW)..=(a0 + HALF_WINDOW) {
                let exact = u128::from(raw_to_dollars(a, m).unwrap());
                over2 += u32::from(rendered_trunc(a, f2) > exact);
                over3 += u32::from(rendered_trunc(a, f3) > exact);
            }
            assert!(
                over2 > 0,
                "m = {m}: the window should contain a two-step overshoot"
            );
            assert_eq!(
                over3, 0,
                "m = {m}: production floor overshot in {over3} balances"
            );
        }
    }

    /// Sweep across the multiplier domain and balances up to `2^53`: the stored value
    /// leaves more than `u` of relative headroom (the leg-2 premise, from exact
    /// integers), and no rendered balance exceeds the redeem floor.
    #[test]
    fn rendered_balance_sweep_never_exceeds_redeem_floor() {
        let mut state: u128 = 0x7A3B_91C4_5D2E_8F60;
        let mut next = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as u64
        };
        let span = oku_shared::MAX_MULTIPLIER - PRECISION;
        let max_raw = 1u64 << 53;

        for i in 0..4_000u32 {
            // Half the draws are near par, where real multipliers live.
            let m = if i % 2 == 0 {
                PRECISION + u128::from(next()) % (3 * PRECISION)
            } else {
                PRECISION + ((u128::from(next()) << 31) ^ u128::from(next())) % span
            };
            let f = multiplier_to_f64_floor(m);
            assert!(scaled_f64_does_not_exceed(f, m), "leg 1 failed for m = {m}");
            assert!(gap_rel(f, m) > U, "headroom <= u for m = {m}");

            for _ in 0..40 {
                let a = 1 + ((u128::from(next()) << 20) ^ u128::from(next())) as u64 % max_raw;
                let Some(exact) = raw_to_dollars(a, m).ok().map(u128::from) else {
                    continue;
                };
                assert!(rendered_trunc(a, f) <= exact, "m = {m}, a = {a}");
            }
        }
    }

    /// The string path wallets use, on a smaller sweep (the format round trip is slow).
    #[test]
    fn rendered_string_sweep_never_exceeds_redeem_floor() {
        let mut state: u128 = 0x0F1E_2D3C_4B5A_6978;
        let mut next = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as u64
        };
        for _ in 0..300 {
            let m = PRECISION + u128::from(next()) % (2 * PRECISION);
            let f = multiplier_to_f64_floor(m);
            for _ in 0..40 {
                // Up to 1e15 raw, the deploy supply cap.
                let a = 1 + next() % 1_000_000_000_000_000;
                let exact = u128::from(raw_to_dollars(a, m).unwrap());
                assert!(rendered_micro(a, f) <= exact, "m = {m}, a = {a}");
            }
        }
    }

    /// Bound the bias in dollars: three ULPs cost ~6e-16 relative, so at the deploy
    /// supply cap (1e15 raw, ~$1e9) the shortfall is far below a micro-unit's worth
    /// of rounding, and even at `u64::MAX` raw (~$1.9e13, unreachable) it is ~1.2 cents.
    #[test]
    fn bias_is_negligible_in_dollar_terms_at_every_representable_balance() {
        let m = 1_037_419_283_746_192_837u128; // ~1.037x
        let f = multiplier_to_f64_floor(m);
        let exact = m as f64 / PRECISION as f64;
        let rel_bias = (exact - f) / exact;

        let max_position_usd = (u64::MAX as f64 / 1e6) * exact;
        let shortfall_usd = rel_bias * max_position_usd;
        assert!(
            shortfall_usd < 0.02,
            "bias costs ${shortfall_usd} at the maximum representable position"
        );
        let cap_position_usd = (1e15 / 1e6) * exact;
        assert!(
            rel_bias * cap_position_usd < 0.000_001,
            "bias costs ${} at the deploy supply cap",
            rel_bias * cap_position_usd
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
