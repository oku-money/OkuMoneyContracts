//! Sandwich-attack guard for yield distribution.
//!
//! Same-slot lock (Solana analogue of EVM's `block.number` lock) used by both
//! lite-psm and oku-dollar to block user operations in the same slot as a
//! yield distribution. SVM port of the EVM-side `YieldSandwichGuard`
//! (`EVM/src/lib/YieldSandwichGuard.sol`).

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;

/// Check yield distribution lock - reverts if in same slot as yield distribution
///
/// This prevents sandwich attacks where an attacker:
/// 1. Frontruns `distribute_yield()` with `mint_oku_m()` at old (lower) price
/// 2. Backruns with `redeem_oku_m()` at new (higher) price
///
/// The lock uses Solana slots (equivalent to EVM's block.number).
/// A slot is ~400ms. Operations in the same slot as yield distribution are blocked.
/// The lock auto-releases in subsequent slots.
pub fn check_yield_lock(config: &PsmConfig) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        clock.slot != config.last_yield_distribution_slot,
        LitePsmError::YieldDistributionInProgress
    );
    Ok(())
}
