//! Pyth V2 PriceAccount manual parser.
//!
//! Anchor pulls in heavyweight transitive deps from `pyth-sdk-solana`, so we
//! manually parse the bytes we need. The byte offsets (208 = `agg.price`,
//! 232 = `timestamp`) and the program-owner-id whitelist are documented in
//! Pyth's own SDK.
//!
//! Taken from https://github.com/pyth-network/pyth-sdk-solana/blob/main/pyth-sdk-solana/src/state.rs
//! Taken from https://docs.pyth.network/price-feeds/contract-addresses/solana
//!
//! NOTE: This is the *legacy* Pyth V2 layout. The modern Pyth Solana Receiver
//! (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) uses a different account
//! layout (`PriceUpdateV2`) and a different staleness model. Programs that
//! want to consume modern Pyth feeds should pass that program ID via
//! `set_pyth_program_owner` and add a parallel parser.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;

/// Check oracle reserves before minting
/// Returns Ok if reserves are sufficient, error otherwise
/// Manually parses Pyth price account to avoid SDK dependency conflicts
///
/// IMPORTANT: Oracle must report total reserves in raw token base units
/// matching OkuMoney's supply denomination. No Pyth exponent adjustment
/// is applied — the raw i64 price value IS the reserves figure.
/// Example: If OkuMoney uses 6 decimals and reserves are $10M,
/// oracle should report 10_000_000_000_000 (10M * 10^6).
///
/// SECURITY: Validates that the oracle account is owned by the configured
/// Pyth program (PsmConfig::pyth_program_owner) to prevent attackers from
/// providing arbitrary data as oracle responses. The owner is set at init
/// time and rotatable via `set_pyth_program_owner` so the protocol can
/// migrate between Pyth versions without redeploy.
pub fn check_oracle_reserves<'info>(
    price_account_info: &Option<UncheckedAccount<'info>>,
    config: &PsmConfig,
    current_supply: u64,
    mint_amount: u64,
) -> Result<()> {
    let oracle_feed = config.oracle;
    let staleness_threshold = config.staleness_threshold;
    let pyth_program_owner = config.pyth_program_owner;

    // If oracle is configured, price_update account must be provided
    let price_account = price_account_info
        .as_ref()
        .ok_or(LitePsmError::OracleAccountMissing)?;

    // Verify the account key matches the expected oracle feed
    require!(
        price_account.key() == oracle_feed,
        LitePsmError::InvalidOracleResponse
    );

    // SECURITY: Verify the oracle account is owned by the configured Pyth program.
    // Set at init via `initialize(pyth_program_owner: Pubkey)` and rotatable via
    // `set_pyth_program_owner` (oracle_manager-gated). A single owner is enforced —
    // operators must redeploy the proxy or rotate before switching Pyth programs.
    let owner = price_account.owner;
    require!(
        *owner == pyth_program_owner,
        LitePsmError::InvalidOracleResponse
    );

    let clock = Clock::get()?;
    let data = price_account.try_borrow_data()?;

    // Minimum data length check — code reads up to offset 240 (timestamp at 232 + 8 bytes).
    // Layout taken from
    //   https://github.com/pyth-network/pyth-sdk-solana/blob/main/pyth-sdk-solana/src/state.rs
    require!(data.len() >= 240, LitePsmError::InvalidOracleResponse);

    // Read price at offset 208 (Pyth V2 price account agg.price offset)
    // and timestamp at offset 232.
    let price_offset = 208usize;
    let timestamp_offset = 232usize;

    let price = i64::from_le_bytes(
        data[price_offset..price_offset + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );

    let publish_time = i64::from_le_bytes(
        data[timestamp_offset..timestamp_offset + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );

    // Check staleness
    let current_time = clock.unix_timestamp;
    let age = current_time.saturating_sub(publish_time);
    require!(age <= staleness_threshold, LitePsmError::StaleOracle);

    // Price represents total reserves (e.g., T-Bill NAV backing in base units)
    // Ensure reserves >= current_supply + mint_amount
    require!(price >= 0, LitePsmError::InvalidOracleResponse);

    let reserves = price as u64;
    let new_supply = current_supply
        .checked_add(mint_amount)
        .ok_or(LitePsmError::Overflow)?;

    require!(reserves >= new_supply, LitePsmError::InsufficientReserves);

    Ok(())
}
