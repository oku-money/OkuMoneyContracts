use crate::errors::OkuError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

/// Pyth Oracle Program IDs (mainnet and devnet)
/// These are the only valid owners for Pyth price accounts
pub const PYTH_MAINNET_PROGRAM_ID: Pubkey = pubkey!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");
pub const PYTH_DEVNET_PROGRAM_ID: Pubkey = pubkey!("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");

/// Check oracle reserves before minting
/// Returns Ok if reserves are sufficient, error otherwise
/// Manually parses Pyth price account to avoid SDK dependency conflicts
///
/// IMPORTANT: Oracle must report total reserves in raw token base units
/// matching OkuUSD's supply denomination. No Pyth exponent adjustment
/// is applied -- the raw i64 price value IS the reserves figure.
/// Example: If OkuUSD uses 6 decimals and reserves are $10M,
/// oracle should report 10_000_000_000_000 (10M * 10^6).
///
/// SECURITY: Validates that the oracle account is owned by the Pyth program
/// to prevent attackers from providing arbitrary data as oracle responses.
pub fn check_oracle_reserves<'info>(
    price_account_info: &Option<UncheckedAccount<'info>>,
    oracle_feed: Pubkey,
    staleness_threshold: i64,
    current_supply: u64,
    mint_amount: u64,
) -> Result<()> {
    // If oracle is configured, price_update account must be provided
    let price_account = price_account_info
        .as_ref()
        .ok_or(OkuError::OracleAccountMissing)?;

    // Verify the account key matches the expected oracle feed
    require!(
        price_account.key() == oracle_feed,
        OkuError::InvalidOracleResponse
    );

    // SECURITY: Verify the oracle account is owned by the Pyth program
    // This prevents attackers from crafting fake oracle data
    let owner = price_account.owner;
    require!(
        *owner == PYTH_MAINNET_PROGRAM_ID || *owner == PYTH_DEVNET_PROGRAM_ID,
        OkuError::InvalidOracleResponse
    );

    let clock = Clock::get()?;
    let data = price_account.try_borrow_data()?;

    // Minimum data length check — code reads up to offset 240 (timestamp at 232 + 8 bytes)
    require!(data.len() >= 240, OkuError::InvalidOracleResponse);

    // Read price at offset 208 (Pyth V2 price account agg.price offset)
    // and timestamp at offset 232
    let price_offset = 208usize;
    let timestamp_offset = 232usize;

    let price = i64::from_le_bytes(
        data[price_offset..price_offset + 8]
            .try_into()
            .map_err(|_| OkuError::InvalidOracleResponse)?,
    );

    let publish_time = i64::from_le_bytes(
        data[timestamp_offset..timestamp_offset + 8]
            .try_into()
            .map_err(|_| OkuError::InvalidOracleResponse)?,
    );

    // Check staleness
    let current_time = clock.unix_timestamp;
    let age = current_time.saturating_sub(publish_time);
    require!(age <= staleness_threshold, OkuError::StaleOracle);

    // Price represents total reserves (e.g., T-Bill NAV backing in base units)
    // Ensure reserves >= current_supply + mint_amount
    require!(price >= 0, OkuError::InvalidOracleResponse);

    let reserves = price as u64;
    let new_supply = current_supply
        .checked_add(mint_amount)
        .ok_or(OkuError::Overflow)?;

    require!(reserves >= new_supply, OkuError::InsufficientReserves);

    Ok(())
}
