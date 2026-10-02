//! The wallet-display mirror.
//!
//! ## Why this exists
//!
//! The canonical multiplier streams continuously and costs no transactions.
//! Wallets, however, cannot see it: Phantom, Solflare, Jupiter and the RPC's
//! `getTokenAccountBalance` all render a Token-2022 mint's UI amount via
//! `ScaledUiAmountConfig::current_multiplier()`, which is a **step function**.
//!
//! There is therefore no transaction-free way to make a wallet balance stream
//! on SVM. The alternative extension that *does* accrue continuously,
//! `InterestBearingConfig`, is mutually exclusive with `ScaledUiAmount` and
//! would cost us the bounded rate window, the pre-staged successor, and the
//! ability to re-anchor — i.e. it trades a cosmetic problem for three
//! correctness ones.
//!
//! So: the extension is a **lagging display mirror**, cranked permissionlessly.
//!
//! ## The one invariant
//!
//! ```text
//!     display <= canonical,  always
//! ```
//!
//! A user redeems for at least what their wallet showed. Two things make it
//! hold **unconditionally**:
//!
//! 1. Each sync writes only `m(now)`, effective immediately. The display is a
//!    pure lag: flat between cranks, stepping up at each one, never ahead of a
//!    monotonically-increasing curve. There is no pre-armed future step that
//!    could fire under a schedule different from the one that computed it —
//!    see `sync_display_multiplier` for why that matters.
//!
//!    This leg is structural, not a convention the call sites must remember:
//!    [`write_display_multiplier`] derives the effective timestamp itself from
//!    `Clock`, so there is no parameter through which a caller could pair a
//!    multiplier with a timestamp it was not computed at. It is also tested
//!    end-to-end against the real `spl_token_2022.so` in
//!    `tests/bankrun/display-mirror.ts`, across a rate decrease and a halt.
//! 2. The `f64` conversion is biased **downward** (see
//!    [`multiplier_to_f64_floor`]), because `x as f64` rounds to nearest and
//!    could otherwise land a hair above the canonical integer.
//!
//! ## Cost of the lag
//!
//! The display under-reads by one crank interval of yield: at a 60s cadence and
//! 20% APY, ~3.5e-5 %, about **$0.35 per $1,000,000** — the same order as EVM's
//! per-block granularity, and always in the protocol's favour. The cadence is
//! an operator choice; nothing on-chain enforces or assumes an interval.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;
use oku_shared::PRECISION;

/// Convert a WAD-scaled canonical multiplier to the `f64` the extension
/// stores, biased **downward**.
///
/// ## Why an unconditional bias rather than a check
///
/// The obvious implementation is to compute `m as f64 / 1e18` and step down one
/// ULP only if the result reconstructs above `m`. That check does not work:
/// `m as f64` is ITSELF lossy at WAD scale (the ULP of an `f64` near 1e18 is
/// 128), so both sides of the comparison are rounded and it cannot detect an
/// excess smaller than the rounding it is trying to detect.
///
/// ## Why the bias is exactly two ULPs, and what that does and does not buy
///
/// Write `u = 2^-53` (the `f64` unit roundoff) and `q = fl(fl(m) / 1e18)`.
/// Two roundings occur, and `1e18` is exactly representable in `f64` so the
/// divisor itself contributes none:
///
/// ```text
///   fl(m)              relative error <= u
///   fl(fl(m) / 1e18)   relative error <= u
///   so                 q <= (m/P) * (1 + u)^2
/// ```
///
/// Each `next_down` step subtracts at least `q * 2^-53` (exactly one ULP;
/// relative ULP is `2^-53` at the bottom of a binade and `2^-52` at the top).
/// Two steps therefore give `f <= q * (1 - 2^-52)`, and:
///
/// ```text
///   f <= (m/P) * (1 + 2^-52) * (1 - 2^-52) = (m/P) * (1 - 2^-104) < m/P
/// ```
///
/// So `display <= canonical` holds **unconditionally over the whole domain**
/// `[PRECISION, MAX_MULTIPLIER]`, which is what the mirror needs.
///
/// BUT NOTE WHAT THAT PROOF IS: the two-ULP decrement **exactly cancels** the
/// two roundings, leaving `2^-104` of relative slack. It is a second-order
/// margin, not a cushion — there is no headroom here.
///
/// Relative ULP is `2^-52` at the BOTTOM of a binade and `2^-53` at the TOP, so
/// two `next_down` steps buy progressively less relative margin as a quotient
/// climbs through a binade. (An earlier revision of this comment had that
/// direction inverted.)
///
/// **Measured minimum margin over the domain is `1.04e-16`, i.e. 0.47x of the
/// `2.22e-16` two-rounding budget.** So `m ~ 1e18` is the BEST case, not the
/// worst: its quotient sits at `2^0`, the bottom of a binade.
///
/// MEASURE THE RIGHT QUANTITY. The margin that matters is the EXACT INTEGER one
/// — `m - f * 1e18` — because that is the invariant. It is NOT the relative bias
/// of `f` against `fl(m) / fl(PRECISION)`, which is a comparison between two
/// floats and runs about `1.11e-16` (0.50x) at its minimum. The two differ
/// because `fl(m)` is itself rounded, and minimising one does not minimise the
/// other: witnesses chosen to minimise the float-relative bias do NOT detect a
/// dropped `next_down`, while witnesses chosen to minimise the integer margin
/// detect it at every binade. The test below uses the integer form.
///
/// Practical consequence: adding a third rounding operation anywhere in this
/// function (an intermediate `f32`, a normalisation multiply, a different
/// divisor) breaks the cancellation and makes `display > canonical` reachable.
/// The test below checks the invariant EXACTLY, in integer arithmetic, rather
/// than via a float-relative threshold, precisely so such a change fails
/// rather than slipping through. Do not "simplify" it back to a float compare.
///
/// ## The step itself is a standard operation, not a bit-hack
///
/// Stepping a float down by one ULP is IEEE-754's `nextDown`, specified since
/// the 2008 revision and implemented by every libm as `nextafter`. Rust
/// stabilised it as [`f64::next_down`] in 1.86; this workspace pins 1.90
/// (`rust-toolchain.toml`), so it is used directly rather than reconstructed.
///
/// Do not open-code it as `f64::from_bits(x.to_bits() - 2)`. That is
/// bit-identical for a positive, finite, normal `x`, but it hardcodes the
/// assumption that no exponent or sign boundary is crossed, which `next_down`
/// encodes in the standard library instead.
///
/// ## What this actually guarantees
///
/// `display <= canonical`, strictly, everywhere on the domain — see the
/// cancellation argument above. That is an exact statement, not an approximate
/// one, and the test asserts it exactly.
///
/// Two independent reasons the mirror is far below the bound in practice, so
/// the thin `2^-104` slack never becomes operationally interesting:
///
/// 1. The display is a staircase that lags canonical by up to one crank
///    interval. At a 60s cadence and 20% APY that is ~3.5e-7 relative — nine
///    orders of magnitude larger than the f64 error, so outside the instant of
///    a sync the display is nowhere near the bound.
/// 2. OkuM has 6 decimals, so a rendered balance is truncated to 1e-6. A 1e-16
///    relative error on a $1,000,000 balance is ~$1e-10. It cannot change a
///    displayed figure at any balance that fits in a `u64`.
///
/// The bias itself costs at most ~2.2e-16 relative, equally invisible.
#[inline]
pub fn multiplier_to_f64_floor(multiplier: u128) -> f64 {
    let scaled = multiplier as f64 / PRECISION as f64;
    if scaled <= 0.0 || !scaled.is_finite() {
        // Cannot happen for a valid multiplier (>= PRECISION). Kept because
        // `next_down` is well-defined but useless at these boundaries: it maps
        // +0.0 to -TINY (a negative subnormal) and NEG_INFINITY to itself,
        // neither of which belongs in a mint's multiplier field.
        return scaled;
    }
    scaled.next_down().next_down()
}

/// Push `multiplier` into the mint's `ScaledUiAmountConfig`, effective
/// immediately.
///
/// ## Why the timestamp is not a parameter
///
/// Taking it as a parameter would make leg 1 of the module invariant a
/// convention every call site has to honour independently: nothing would
/// couple the `multiplier` argument to the `effective_timestamp` argument, so
/// a caller could pair a multiplier computed at one instant with an effective
/// time at another.
///
/// Reading `Clock` here instead makes "effective immediately" a property of
/// this function rather than a property of its callers. A future caller cannot
/// arm a future step through this path, because there is no longer an argument
/// with which to express one. Callers must still pass a `multiplier` evaluated
/// at the current timestamp — that remains their obligation — but the
/// *effective* time can no longer disagree with the write.
///
/// The `PsmConfig` PDA is the extension's authority, so the program signs.
/// The Token-2022 multisig signer array is empty — role separation is handled
/// by our own `has_one` checks, not by the token program.
///
/// NOTE: this does NOT stamp `last_yield_distribution_slot`. Display syncs are
/// cosmetic and must not engage the sandwich lock, or the PSM would be
/// unusable for one slot out of every sync interval. See `PsmConfig`.
pub fn write_display_multiplier<'info>(
    multiplier: u128,
    config: &Account<'info, PsmConfig>,
    oku_m_mint: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
) -> Result<()> {
    // Effective immediately, by construction. Token-2022 treats an effective
    // timestamp at or before `now` as an immediate set (see
    // `ScaledUiAmountMintInstruction::UpdateMultiplier`), collapsing the
    // extension's two-slot step function to a single standing value.
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

    let bump = [config.bump];
    let seeds = PsmConfig::signer_seeds(&bump);
    let signer = &[&seeds[..]];

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[oku_m_mint.clone(), config.to_account_info()],
        signer,
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    Ok(())
}

// NOTE: do not piggyback a display sync onto the PSM instructions. Measured at
// ~31k compute units on a cold mint, on a hot path already close to Solana's
// 200k default.

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact integer check of `f * PRECISION <= m` — the mirror's actual
    /// safety invariant, with no floating-point arithmetic in the assertion.
    ///
    /// A positive normal `f64` is EXACTLY `mantissa * 2^exp` for integers
    /// `mantissa < 2^53` and (over this domain) `exp < 0`. So the claim
    /// `f * 1e18 <= m` is equivalent to the exact integer statement
    /// `mantissa * 1e18 <= m * 2^-exp`, which can be evaluated with no
    /// rounding at all.
    ///
    /// This is the point of the rewrite. The previous version of this test
    /// computed `(exact - f) / exact` in `f64` and compared it to a hardcoded
    /// `1e-16` — evaluating the error in the same arithmetic whose error it
    /// was measuring, against a threshold that sits BELOW the true `2 * 2^-53
    /// = 2.22e-16` budget. It therefore passed on inputs that violated the
    /// property it claimed to check (`m ~ 1.3e23` has a bias of `1.05e-16`:
    /// over the old threshold, under the real budget). It tested what the code
    /// did, not what the code needs to be true.
    ///
    /// The right-hand side reaches `2^132`, so it is held in two `u128` limbs
    /// and compared lexicographically.
    fn scaled_f64_does_not_exceed(f: f64, m: u128) -> bool {
        assert!(
            f.is_normal() && f > 0.0,
            "domain: {f} must be a positive normal"
        );

        let bits = f.to_bits();
        let frac = bits & ((1u64 << 52) - 1);
        let exp_field = ((bits >> 52) & 0x7ff) as i32;
        // Normal f64: value = (2^52 + frac) * 2^(E - 1075).
        let mantissa = u128::from(frac | (1u64 << 52));
        let exp = exp_field - 1075;
        assert!(
            exp < 0,
            "domain: quotient in [1, 1e6] always has a negative binary exponent, got {exp}"
        );
        let k = (-exp) as u32;
        assert!(k < 128, "shift {k} must stay within a u128 limb");

        // lhs = mantissa * 1e18 < 2^53 * 2^60 = 2^113 — fits one limb.
        let (lhs_hi, lhs_lo) = (0u128, mantissa * PRECISION);
        // rhs = m << k, up to 2^80 * 2^52 = 2^132 — needs two.
        // `<<` on u128 with shift < 128 keeps the low 128 bits, which is
        // exactly the low limb; the high limb is the complementary shift.
        let rhs_hi = if k == 0 { 0 } else { m >> (128 - k) };
        let rhs_lo = m << k;

        (lhs_hi, lhs_lo) <= (rhs_hi, rhs_lo)
    }

    /// One minimum-margin witness per binade spanned by the domain.
    ///
    /// "Margin" here is the EXACT INTEGER quantity the invariant is about,
    /// `m - f * 1e18`, relative to `m`. Each witness is the smallest-margin
    /// multiplier found by sampling 80k values uniformly within its binade; all
    /// twenty land near `1.04e-16`, i.e. 0.47x of the `2.22e-16` budget.
    ///
    /// TWO EARLIER ATTEMPTS AT THIS LIST WERE WRONG, IN DIFFERENT WAYS.
    ///
    /// The first used `(1u128 << k) * PRECISION - 1`, reasoning that subtracting
    /// one lands just below `2^k`. It does not: at that magnitude `ulp(m)` is far
    /// larger than 1, so `fl(m)` rounds straight back UP to the binade boundary.
    /// All twenty collapsed to the quotient `2^k` — the bottom of a binade, the
    /// SAFEST point in the domain. Twenty entries tested one behaviour, and the
    /// list named "weak region" exercised the strong region.
    ///
    /// The second minimised the wrong metric: the relative bias of `f` against
    /// the float `fl(m) / fl(PRECISION)`, rather than against the integer `m`.
    /// Those witnesses sit at a genuine minimum of that metric and are still
    /// useless here — measured against a mutant with one `next_down` removed,
    /// they violate 0 of 20, while the witnesses below violate 20 of 20.
    ///
    /// Backing off by multiples of `ulp(m)` does not work either: the division's
    /// own rounding dominates, and the weak point needs `fl(m)` AND the divide to
    /// round in a particular direction — a joint condition on bit patterns, not
    /// something with a closed form. Hence witnesses, found by search, pinned.
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
            // An empirical low-margin witness found before the per-binade
            // sweep above existed; kept as a fixed regression pin.
            130_576_977_149_543_642_620_974u128,
        ];
        cases.extend(weak_region_cases());

        // Deterministic sweep across the whole domain so the property is not
        // only pinned at hand-picked points. LCG rather than a dependency.
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

    /// The bias must also stay SMALL — a correct floor that undershoots badly
    /// would satisfy the invariant above while being wrong for users.
    ///
    /// Unlike the lower bound this upper bound is legitimately a float
    /// comparison: `1e-14` is nine orders of magnitude above the quantity
    /// being measured, so the measurement's own rounding cannot affect the
    /// verdict. It bounds what a wallet renders, which is a real-world
    /// property rather than a restatement of the implementation.
    #[test]
    fn f64_conversion_bias_stays_below_rendered_precision() {
        let mut cases = vec![PRECISION, 2 * PRECISION, oku_shared::MAX_MULTIPLIER];
        cases.extend(weak_region_cases());

        for m in cases {
            // NOTE `exact` here is the f64 APPROXIMATION of m/1e18, which is
            // precisely the value `multiplier_to_f64_floor` takes two
            // `next_down` steps from. Asserting `f < exact` would therefore be
            // a round-trip that cannot fail, and is deliberately absent: the
            // real `display <= canonical` direction is proven exactly, in
            // integer arithmetic, by the test above.
            //
            // What this adds is the MAGNITUDE, in the unit a wallet renders.
            let exact = m as f64 / PRECISION as f64;
            let f = multiplier_to_f64_floor(m);

            let rel_bias = (exact - f) / exact;
            assert!(
                rel_bias < 1e-14,
                "bias {rel_bias} is larger than intended for {m}"
            );
        }
    }
    /// Bound the bias in the unit that actually matters: dollars. The relative
    /// bias is fixed, so a *rendered unit count* is the wrong framing — at
    /// `u64::MAX` raw the bias costs 8192 units, but that is $0.008 on a ~$18
    /// trillion position.
    ///
    /// It only becomes a whole rendered unit above roughly $2.3B of balance,
    /// and even at the largest position expressible in a `u64` the shortfall is
    /// under a cent — always downward, so always in the user's favour.
    #[test]
    fn bias_is_negligible_in_dollar_terms_at_every_representable_balance() {
        let m = 1_037_419_283_746_192_837u128; // ~1.037x
        let f = multiplier_to_f64_floor(m);
        let exact = m as f64 / PRECISION as f64;
        let rel_bias = (exact - f) / exact;

        // Dollar shortfall = relative bias x position size.
        // u64::MAX raw at 6 decimals ~ 1.8e13 tokens ~ $1.9e13 at this multiplier.
        let max_position_usd = (u64::MAX as f64 / 1e6) * exact;
        let shortfall_usd = rel_bias * max_position_usd;
        assert!(
            shortfall_usd < 0.01,
            "bias costs ${shortfall_usd} at the maximum representable position"
        );

        // And it is dwarfed by the staircase lag that exists BY DESIGN: one
        // crank interval of yield. At a 60s cadence and 20% APY that is
        // ~3.5e-7 relative, ~6 orders of magnitude larger than this bias, so
        // the f64 conversion is nowhere near the binding term.
        const TYPICAL_CRANK_SECS: f64 = 60.0;
        let staircase_lag_rel = 0.20_f64.ln_1p() * TYPICAL_CRANK_SECS / 31_536_000.0;
        assert!(
            rel_bias * 1_000.0 < staircase_lag_rel,
            "f64 bias {rel_bias} is not negligible next to the {staircase_lag_rel} staircase lag"
        );
    }
}
