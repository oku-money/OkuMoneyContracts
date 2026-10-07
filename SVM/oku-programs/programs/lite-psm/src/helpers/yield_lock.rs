//! Same-slot sandwich lock; EVM: `OverrideBlockGuard.whenNoOverrideThisBlock`.
//! The comparison lives in `oku_shared::yield_lock_engaged`.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::yield_lock_engaged;

/// Reverts with `OverrideInProgress` in the same slot as an emergency
/// multiplier override. `set_okum_multiplier` is the only writer of
/// `last_yield_distribution_slot`; routine accrual and display sync do not
/// stamp it, so the check normally never fires.
pub fn check_yield_lock(config: &PsmConfig) -> Result<()> {
    check_yield_lock_with_clock(config, &Clock::get()?)
}

/// Same check with an already-fetched [`Clock`], to avoid a second sysvar read.
pub fn check_yield_lock_with_clock(config: &PsmConfig, clock: &Clock) -> Result<()> {
    require!(
        !yield_lock_engaged(config.last_yield_distribution_slot, clock.slot),
        LitePsmError::OverrideInProgress
    );
    Ok(())
}
