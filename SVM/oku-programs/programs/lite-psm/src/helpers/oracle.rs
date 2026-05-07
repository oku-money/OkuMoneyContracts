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

// ---- Pyth V2 PriceAccount byte offsets ----
// Layout source:
//   https://github.com/pyth-network/pyth-sdk-solana/blob/main/pyth-sdk-solana/src/state.rs
// Field offsets (relative to account-data start, post-discriminator since
// Pyth accounts have no Anchor discriminator):
//
//   0..4    magic                u32
//   4..8    ver                  u32
//   8..12   atype                u32
//   12..16  size                 u32
//   16..20  ptype                u32
//   20..24  expo                 i32   <-- price scaling exponent
//   ...
//   208..216 agg.price            i64
//   216..224 agg.conf             u64
//   224..228 agg.status           u32   <-- 1 = Trading
//   228..232 agg.corp_act         u32
//   232..240 agg.publish_time     i64

/// Offset of `expo: i32` in the Pyth V2 price account.
const PYTH_EXPO_OFFSET: usize = 20;
/// Offset of `agg.price: i64` (the integer price, scaled by 10^expo).
const PYTH_PRICE_OFFSET: usize = 208;
/// Offset of `agg.status: u32` (1 = Trading, anything else = stale/halted).
const PYTH_STATUS_OFFSET: usize = 224;
/// Offset of `agg.publish_time: i64` (unix-second timestamp of the latest agg).
const PYTH_TIMESTAMP_OFFSET: usize = 232;
/// Minimum byte length we read from the price account.
/// timestamp ends at offset 240, so we need at least that many bytes.
const PYTH_MIN_DATA_LEN: usize = 240;

/// `agg.status == Trading` value per the Pyth V2 PriceStatus enum.
const PYTH_STATUS_TRADING: u32 = 1;

/// Check oracle reserves before minting.
/// Returns `Ok` if reserves are sufficient, error otherwise. Manually parses
/// the Pyth V2 price account to avoid SDK dependency conflicts.
///
/// IMPORTANT: the oracle feed must:
///   1. Be owned by `PsmConfig::pyth_program_owner` (set at init, rotatable).
///   2. Have `agg.status == Trading` (1) — halted feeds are rejected.
///   3. Have `expo == 0` — the price is interpreted directly as a raw token
///      count of reserves with no scaling. A custom feed publishing reserves
///      in OkuMoney base units (decimals = 6) is the expected configuration.
///   4. Be fresh per the configured `staleness_threshold`.
///
/// Example: If OkuMoney uses 6 decimals and reserves are $10M, the oracle
/// should report `10_000_000_000_000` (10M * 10^6) with `expo = 0`.
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

    // Minimum data length: timestamp ends at offset 240.
    require!(data.len() >= PYTH_MIN_DATA_LEN, LitePsmError::InvalidOracleResponse);

    // Read expo, price, status, timestamp.
    let expo = i32::from_le_bytes(
        data[PYTH_EXPO_OFFSET..PYTH_EXPO_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    let price = i64::from_le_bytes(
        data[PYTH_PRICE_OFFSET..PYTH_PRICE_OFFSET + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    let status = u32::from_le_bytes(
        data[PYTH_STATUS_OFFSET..PYTH_STATUS_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    let publish_time = i64::from_le_bytes(
        data[PYTH_TIMESTAMP_OFFSET..PYTH_TIMESTAMP_OFFSET + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );

    // Reject non-trading feeds (halted, unknown). Without this, a paused
    // Pyth feed would still pass age and price checks since publish_time
    // continues to advance even when the feed is not actively trading.
    require!(status == PYTH_STATUS_TRADING, LitePsmError::InvalidOracleResponse);

    // Reject feeds that don't report price as raw token base units. The
    // helper interprets `price` directly as a token-count of reserves; any
    // non-zero exponent would silently scale the comparison incorrectly.
    // Operators must publish a custom feed with `expo == 0` (or extend this
    // parser to apply the scaling).
    require!(expo == 0, LitePsmError::InvalidOracleResponse);

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
