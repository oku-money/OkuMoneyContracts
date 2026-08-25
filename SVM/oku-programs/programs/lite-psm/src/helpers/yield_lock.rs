//! Same-slot atomic-re-entry fence for yield distribution.
//!
//! Blocks operations landing in the *same slot* as a multiplier write.
//! The EVM side has no counterpart: continuous accrual has no discrete
//! distribution transaction to co-locate with. (An earlier
//! `EVM/src/lib/YieldSandwichGuard.sol` was removed when EVM moved to
//! continuous accrual; this module is no longer a port of anything.)
//!
//! The slot comparison itself lives in `oku_shared::yield_lock_engaged`;
//! this module is the Anchor-error mapping plus the `Clock::get()` sysvar
//! read.
//!
//! # Scope — read this before relying on it
//!
//! This fence stops one thing: an operation sharing a slot with the
//! multiplier write. It does **not** prevent step arbitrage, because that
//! attack never needs to share a slot — mint at slot `N-1`, let the write
//! land at `N`, redeem at `N+1`, and collect the entire step having held
//! for ~800 ms. Widening this fence does not help either; the attacker
//! simply moves further out.
//!
//! Two separate mechanisms cover the two real surfaces:
//!   - *Cross-chain* price divergence during a tick →
//!     [`crate::helpers::sync_window`] (blocks transacting during the
//!     propagation interval).
//!   - *Local* step arbitrage → the `tout` redemption fee (makes the
//!     round trip unprofitable regardless of timing).
//!
//! This fence is retained because it is still the correct and cheapest
//! guard against same-slot atomicity games, and it is orthogonal to both.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::yield_lock_engaged;

/// Check the same-slot fence — reverts if the current slot is the slot of
/// the last multiplier write.
///
/// Also self-fences the multiplier writers themselves, so two
/// yield-affecting writes cannot share a slot.
///
/// The lock uses Solana slots (~400 ms each) and auto-releases in
/// subsequent slots. See the module note for what this does and does not
/// defend against.
pub fn check_yield_lock(config: &PsmConfig) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        !yield_lock_engaged(config.last_yield_distribution_slot, clock.slot),
        LitePsmError::YieldDistributionInProgress
    );
    Ok(())
}
