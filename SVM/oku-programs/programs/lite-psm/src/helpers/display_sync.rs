//! The wallet-display mirror.
//!
//! ## Why this exists
//!
//! The canonical multiplier streams continuously and costs no transactions.
//! Wallets, however, cannot see it: Phantom, Solflare, Jupiter and the RPC's
//! `getTokenAccountBalance` all render a Token-2022 mint's UI amount via
//! `ScaledUiAmountConfig::current_multiplier()`, which is a **step function
//! with exactly one pre-armable future step**
//! (`spl-token-2022-interface-2.1.0/src/extension/scaled_ui_amount/mod.rs:57-63`).
//!
//! There is therefore no transaction-free way to make a wallet balance stream
//! on SVM. The alternative extension that *does* accrue continuously,
//! `InterestBearingConfig`, is mutually exclusive with `ScaledUiAmount`
//! (`.../extension/mod.rs:1359-1361`) and would cost us the bounded rate
//! window, the pre-staged successor, and the ability to re-anchor — i.e. it
//! trades a cosmetic problem for three correctness ones.
//!
//! So: the extension becomes a **lagging display mirror**, cranked
//! permissionlessly, and the economics never touch it.
//!
//! ## The safety direction
//!
//! Display must always be `<= canonical`. A user then redeems for at least
//! what their wallet showed — surprises are in their favour. Two things
//! enforce this:
//!
//! 1. The pre-armed step is evaluated at the exact timestamp it becomes
//!    effective, so the staircase touches the true curve at each step and
//!    lies below it in between — never above.
//! 2. The `f64` conversion rounds **down** (see [`multiplier_to_f64_floor`]),
//!    because `x as f64` rounds to nearest and could otherwise land a hair
//!    above the canonical integer.
//!
//! ## Cost of the lag
//!
//! At [`DISPLAY_SYNC_INTERVAL`] = 60s and 20% APY the display under-reads by
//! ~3.5e-5 %, i.e. about **$0.35 per $1,000,000**. Integrators pricing off the
//! extension rather than off `PsmConfig` see an arbitrage of at most that,
//! which is the same order as EVM's per-block granularity.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;
use oku_shared::PRECISION;

/// How far ahead the display staircase is pre-armed, and the staleness
/// threshold for the opportunistic piggyback sync.
///
/// 60s costs ~1440 transactions/day (~0.007 SOL) for ~$0.35 of under-read per
/// $1M at 20% APY. Shortening it is a linear trade of cost against drift;
/// nothing in the protocol's correctness depends on the value.
pub const DISPLAY_SYNC_INTERVAL: i64 = 60;

/// Convert a WAD-scaled canonical multiplier to the `f64` the extension
/// stores, rounding **toward zero**.
///
/// `u128 as f64` rounds to nearest, which can round *up* and put the display
/// a hair above canonical — the one direction that is not safe. `f64` carries
/// ~15.95 significant decimal digits, so at a multiplier near 1.0 the
/// downward adjustment is ~1e-16 relative: far finer than the 60-second
/// staircase step it sits inside, and therefore invisible.
#[inline]
pub fn multiplier_to_f64_floor(multiplier: u128) -> f64 {
    let scaled = multiplier as f64 / PRECISION as f64;
    // Reconstruct and step down one ULP if the cast rounded upward.
    if (scaled * PRECISION as f64) > multiplier as f64 {
        f64::from_bits(scaled.to_bits() - 1)
    } else {
        scaled
    }
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

/// `true` if the display mirror is stale enough to be worth refreshing on the
/// back of an unrelated PSM instruction.
///
/// Keeping active mints and redeems self-syncing means the external crank
/// only matters when the PSM is idle, which is exactly when nobody is looking
/// at a stale number anyway.
#[inline]
pub fn display_is_stale(config: &PsmConfig, now_ts: i64) -> bool {
    now_ts.saturating_sub(config.last_display_sync_ts) >= DISPLAY_SYNC_INTERVAL
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The invariant the whole mirror rests on: the value written to the
    /// extension must never exceed the canonical integer it came from.
    #[test]
    fn f64_conversion_never_rounds_up() {
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
            let f = multiplier_to_f64_floor(m);
            assert!(
                f * PRECISION as f64 <= m as f64,
                "display {f} rounded ABOVE canonical {m} — users would see more than they can redeem"
            );
            // And it must still be close enough to be useful.
            let rel_err = (m as f64 - f * PRECISION as f64) / m as f64;
            assert!(rel_err < 1e-15, "lost too much precision: {rel_err} for {m}");
        }
    }

    /// `PsmConfig` has no `Default` (it is an Anchor account with 16 pubkeys),
    /// so the staleness predicate is tested against its only input directly.
    fn stale(last_sync: i64, now: i64) -> bool {
        now.saturating_sub(last_sync) >= DISPLAY_SYNC_INTERVAL
    }

    #[test]
    fn staleness_threshold_respects_the_interval() {
        assert!(!stale(1_000, 1_000));
        assert!(!stale(1_000, 1_000 + DISPLAY_SYNC_INTERVAL - 1));
        assert!(stale(1_000, 1_000 + DISPLAY_SYNC_INTERVAL));
        // A clock that appears to move backwards must not wrap into "stale"
        // (saturating_sub, not a wrapping subtraction).
        assert!(!stale(1_000, 0));
        assert!(!stale(i64::MAX, i64::MIN));
    }
}
