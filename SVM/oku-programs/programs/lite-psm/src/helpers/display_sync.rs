//! The wallet-display mirror.
//!
//! ## Why this exists
//!
//! The canonical multiplier streams continuously and costs no transactions.
//! Wallets, however, cannot see it: Phantom, Solflare, Jupiter and the RPC's
//! `getTokenAccountBalance` all render a Token-2022 mint's UI amount via
//! `ScaledUiAmountConfig::current_multiplier()`, which is a **step function**
//! (`spl-token-2022-interface-2.1.0/src/extension/scaled_ui_amount/mod.rs:57-63`).
//!
//! There is therefore no transaction-free way to make a wallet balance stream
//! on SVM. The alternative extension that *does* accrue continuously,
//! `InterestBearingConfig`, is mutually exclusive with `ScaledUiAmount`
//! (`.../extension/mod.rs:1359-1361`) and would cost us the bounded rate
//! window, the pre-staged successor, and the ability to re-anchor — i.e. it
//! trades a cosmetic problem for three correctness ones.
//!
//! So: the extension is a **lagging display mirror**, cranked permissionlessly,
//! and the economics never touch it.
//!
//! ## The one invariant
//!
//! ```text
//!     display <= canonical,  always
//! ```
//!
//! A user then redeems for at least what their wallet showed — surprises are in
//! their favour. Two things make it hold **unconditionally**:
//!
//! 1. Each sync writes only `m(now)`, effective immediately. The display is a
//!    pure lag: flat between cranks, stepping up at each one, never ahead of a
//!    monotonically-increasing curve. There is no pre-armed future step that
//!    could fire under a schedule different from the one that computed it —
//!    see `sync_display_multiplier` for why that mattered.
//! 2. The `f64` conversion is biased **downward** (see
//!    [`multiplier_to_f64_floor`]), because `x as f64` rounds to nearest and
//!    could otherwise land a hair above the canonical integer.
//!
//! ## Cost of the lag
//!
//! The display under-reads by one crank interval of yield. At a 60s cadence and
//! 20% APY that is ~3.5e-5 %, about **$0.35 per $1,000,000** — the same order as
//! EVM's per-block granularity. Integrators pricing off the extension rather
//! than off `PsmConfig` see at most that, always in the protocol's favour.
//!
//! The cadence is an operator choice, not a protocol constant: nothing on-chain
//! enforces or assumes any particular interval.

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
/// ULP only if the result reconstructs above `m`. That check does not work, and
/// the first version of this function got it wrong: `m as f64` is ITSELF lossy
/// at WAD scale (the ULP of an `f64` near 1e18 is 128), so both sides of the
/// comparison are rounded and it cannot detect an excess smaller than the
/// rounding it is trying to detect.
///
/// The error budget, for a multiplier `m` near 1e18:
///
/// ```text
///   fl(m)                    introduces up to ulp(m)/2   = 64
///   fl(fl(m) / 1e18)         introduces up to m * 2^-53  = 111
///   worst-case excess                                    ~ 175  (1.75e-16 relative)
/// ```
///
/// (`1e18` is exactly representable in `f64`, so the divisor contributes
/// nothing.) Stepping down **two** ULPs of the quotient gives ~4.4e-16 of
/// margin, which strictly dominates that bound.
///
/// ## What this actually guarantees
///
/// `display <= canonical` up to ~1e-16 relative — an arithmetic bound, not an
/// exact proof. In practice the guarantee is far stronger than that bound
/// suggests, for two independent reasons:
///
/// 1. The display is a staircase that lags canonical by up to one
///    one crank interval. At a 60s cadence and 20% APY that is ~3.5e-7
///    relative — nine
///    orders of magnitude larger than the f64 error, so outside the instant of
///    a sync the display is nowhere near the bound.
/// 2. OkuM has 6 decimals, so a rendered balance is truncated to 1e-6. A 1e-16
///    relative error on a $1,000,000 balance is ~$1e-10. It cannot change a
///    displayed figure at any balance that fits in a `u64`.
///
/// The cost of the bias is symmetric and equally invisible: the display reads
/// ~4e-16 relative low.
#[inline]
pub fn multiplier_to_f64_floor(multiplier: u128) -> f64 {
    let scaled = multiplier as f64 / PRECISION as f64;
    if scaled <= 0.0 || !scaled.is_finite() {
        // Cannot happen for a valid multiplier (>= PRECISION), but stepping the
        // bit pattern of 0 or NaN downward would be nonsense.
        return scaled;
    }
    f64::from_bits(scaled.to_bits() - 2)
}

/// Push `multiplier` into the mint's `ScaledUiAmountConfig`, effective at
/// `effective_timestamp`.
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
    effective_timestamp: i64,
    config: &Account<'info, PsmConfig>,
    oku_m_mint: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
) -> Result<()> {
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

// NOTE: `display_is_stale` lived here to gate an opportunistic "piggyback"
// sync on the PSM instructions. It was removed after measurement showed the
// piggyback cost ~31k compute units on a cold mint, on a hot path already
// close to Solana's 200k default. `last_display_sync_ts` is retained on
// PsmConfig purely as an observability field -- it tells an operator (and
// `scripts/admin/sync-display.ts`) how stale the mirror is.

#[cfg(test)]
mod tests {
    use super::*;

    /// The mirror's safety property, stated as what it actually is: a BOUNDED
    /// downward bias, not an exact floor.
    ///
    /// Note this test cannot prove `f * 1e18 <= m` exactly, because evaluating
    /// that expression in `f64` is subject to the same rounding it would be
    /// checking — which is precisely the trap the first implementation fell
    /// into. What it can and does check is that the conversion sits strictly
    /// below the input by a margin larger than the f64 error budget and
    /// smaller than one unit of rendered precision.
    #[test]
    fn f64_conversion_is_biased_downward_within_bounds() {
        let cases = [
            PRECISION,
            PRECISION + 1,
            1_000_000_000_000_000_001u128,
            1_037_419_283_746_192_837u128,
            2 * PRECISION,
            999_999_999_999_999_999u128,
            oku_shared::MAX_MULTIPLIER,
            oku_shared::MAX_MULTIPLIER - 1,
        ];
        for m in cases {
            let exact = m as f64 / PRECISION as f64;
            let f = multiplier_to_f64_floor(m);

            assert!(f < exact, "conversion was not biased downward for {m}");

            // Bias must exceed the ~1.75e-16 f64 error budget (so it actually
            // dominates it) and stay far below 1e-6, one unit of rendered
            // precision at 6 decimals.
            let rel_bias = (exact - f) / exact;
            assert!(
                rel_bias > 1e-16,
                "bias {rel_bias} does not dominate the f64 error budget for {m}"
            );
            assert!(
                rel_bias < 1e-14,
                "bias {rel_bias} is larger than intended for {m}"
            );
        }
    }

    /// Bound the bias in the unit that actually matters: dollars.
    ///
    /// An earlier version of this test asserted the bias could never change a
    /// *rendered unit*, and failed — at `u64::MAX` raw it costs 8192 units.
    /// That framing was wrong: 8192 units of a 6-decimal token is $0.008, and
    /// `u64::MAX` raw is a ~$18 trillion position. The relative bias is fixed,
    /// so the meaningful statement is about relative and absolute dollar error,
    /// not unit counts.
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
