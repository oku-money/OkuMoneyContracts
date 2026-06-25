//! Sandwich-attack guard for yield distribution.
//!
//! Same-slot lock (Solana analogue of EVM's `block.number` lock) used by
//! both lite-psm and oku-dollar to block user operations in the same
//! slot as a yield distribution. SVM port of the EVM-side
//! `YieldSandwichGuard` (`EVM/src/lib/YieldSandwichGuard.sol`).
//!
//! Cycle 4 (OKUD-20): the slot comparison itself lives in
//! `oku_shared::yield_lock_engaged`. This module is now just the
//! Anchor-error mapping plus the `Clock::get()` sysvar read.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::yield_lock_engaged;

/// Check yield distribution lock — reverts if in the same slot as a
/// yield distribution.
///
/// This prevents sandwich attacks where an attacker:
///   1. Frontruns `distribute_yield()` with `mint_oku_m()` at the old
///      (lower) price.
///   2. Backruns with `redeem_oku_m()` at the new (higher) price.
///
/// The lock uses Solana slots (~400 ms each) and auto-releases in
/// subsequent slots.
pub fn check_yield_lock(config: &PsmConfig) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        !yield_lock_engaged(config.last_yield_distribution_slot, clock.slot),
        LitePsmError::YieldDistributionInProgress
    );
    Ok(())
}
