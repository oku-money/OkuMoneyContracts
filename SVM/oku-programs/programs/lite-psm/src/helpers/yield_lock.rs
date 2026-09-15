//! Sandwich-attack guard for yield distribution.
//!
//! Same-slot lock (Solana analogue of EVM's `block.number` lock) used by
//! lite-psm to block user operations in the same slot as a yield
//! distribution. SVM port of the EVM-side
//! `YieldSandwichGuard` (`EVM/src/lib/YieldSandwichGuard.sol`).
//!
//! The slot comparison itself lives in `oku_shared::yield_lock_engaged`;
//! this module is the Anchor-error mapping plus the `Clock::get()` sysvar
//! read.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::yield_lock_engaged;

/// Check the sandwich lock — reverts if in the same slot as an EMERGENCY
/// multiplier override.
///
/// ## What this does and does not defend against, post-streaming-accrual
///
/// It used to guard the routine yield path: `distribute_yield` moved the
/// multiplier in a discrete step, and an attacker could mint immediately
/// before and redeem immediately after for riskless profit.
///
/// That attack no longer exists, because the step no longer exists. The
/// multiplier is now a continuous function of time, so there is nothing to
/// straddle — which is precisely why EVM moved to streaming accrual, since
/// widening the lock can never fix a discrete tick (the searcher simply
/// straddles it by one more block on each side).
///
/// What remains is the EMERGENCY override (`set_okum_multiplier`), which is
/// the one instruction that still produces a jump. That is the only writer of
/// `last_yield_distribution_slot`, so in normal operation this check is free
/// and never fires.
///
/// Critically, the routine display sync does NOT stamp the slot. If it did,
/// the PSM would be unavailable for one slot out of every sync interval, for
/// no security benefit — the display mirror has no economic meaning.
///
/// The lock uses Solana slots (~400 ms each) and auto-releases in
/// subsequent slots.
///
/// EVM mirror: `YieldSandwichGuard.whenYieldNotDistributing`
/// (`EVM/src/lib/YieldSandwichGuard.sol:21-26`), which likewise keys on a
/// field written only by `setOkuMMultiplier`.
pub fn check_yield_lock(config: &PsmConfig) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        !yield_lock_engaged(config.last_yield_distribution_slot, clock.slot),
        LitePsmError::YieldDistributionInProgress
    );
    Ok(())
}
