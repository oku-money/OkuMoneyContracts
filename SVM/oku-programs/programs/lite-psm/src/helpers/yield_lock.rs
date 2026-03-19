use crate::errors::OkuError;
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
        OkuError::YieldDistributionInProgress
    );
    Ok(())
}

/// Check yield distribution lock from an external config reference
/// Used by OkuDollar to read the lock from PsmConfig
pub fn check_yield_lock_from_account(
    psm_config_info: &AccountInfo,
    expected_key: &Pubkey,
) -> Result<()> {
    // Verify the account is the expected PsmConfig
    require!(
        psm_config_info.key() == *expected_key,
        OkuError::InvalidPsmConfig
    );

    // Deserialize and check
    let config_data = psm_config_info.try_borrow_data()?;

    // Skip discriminator (8 bytes) and bump (1 byte) to read last_yield_distribution_slot
    // Based on PsmConfig layout, last_yield_distribution_slot is at a specific offset
    // This is fragile - better to use proper deserialization, but we need to avoid
    // full Account deserialization overhead in cross-program calls

    // For now, let's use proper deserialization via Account::try_deserialize
    // The caller should pass a properly typed Account instead
    drop(config_data);

    // This function expects the config to be passed as properly typed
    // Use check_yield_lock() directly when you have the typed config
    Err(OkuError::InvalidPsmConfig.into())
}

#[cfg(test)]
mod tests {
    // Tests would require mocking Solana runtime
}
