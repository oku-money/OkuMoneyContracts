//! Sandwich-attack guard for yield distribution.
//!
//! Same-slot lock (Solana analogue of EVM's `block.number` lock) used by
//! lite-psm to block user operations in the same slot as a yield
//! distribution. SVM port of the EVM-side
//! `OverrideBlockGuard` (`EVM/src/lib/OverrideBlockGuard.sol`).
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
/// Under streaming accrual the multiplier is a continuous function of time, so
/// routine accrual offers nothing to straddle. `set_okum_multiplier` is the
/// one instruction that still produces a discrete jump, and the only writer of
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
/// EVM mirror: `OverrideBlockGuard.whenNoOverrideThisBlock`, which likewise
/// keys on a field written only by `setOkuMMultiplier`.
pub fn check_yield_lock(config: &PsmConfig) -> Result<()> {
    check_yield_lock_with_clock(config, &Clock::get()?)
}

/// Same check, taking an already-fetched [`Clock`].
///
/// A caller that also needs the clock for another read in the same
/// instruction (e.g. [`crate::helpers::multiplier::at`]'s `unix_timestamp`)
/// should fetch it once and pass it here, rather than letting this function
/// make its own `Clock::get()` sysvar call. Both reads are cheap individually,
/// but the hot mint/redeem paths are already close to the compute budget —
/// see `tests/bankrun/compute-budget.ts`.
pub fn check_yield_lock_with_clock(config: &PsmConfig, clock: &Clock) -> Result<()> {
    require!(
        !yield_lock_engaged(config.last_yield_distribution_slot, clock.slot),
        LitePsmError::OverrideInProgress
    );
    Ok(())
}
