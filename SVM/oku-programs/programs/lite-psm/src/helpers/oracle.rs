//! Pyth V2 PriceAccount manual parser.
//!
//! Anchor pulls in heavyweight transitive deps from `pyth-sdk-solana`, so we
//! manually parse the bytes we need. Field offsets and widths are derived
//! from the canonical Pyth SDK struct layout.
//!
//! Taken from https://github.com/pyth-network/pyth-sdk-rs/blob/main/pyth-sdk-solana/src/state.rs
//! Taken from https://docs.pyth.network/price-feeds/contract-addresses/solana
//!
//! NOTE: This is the *legacy* Pyth V2 layout (`SolanaPriceAccount`). The
//! modern Pyth Solana Receiver (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`)
//! uses a different account layout (`PriceUpdateV2`) and a different staleness
//! model. Programs that want to consume modern Pyth feeds should pass that
//! program ID via `set_pyth_program_owner` and add a parallel parser.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;

// ---- Pyth V2 PriceAccount byte offsets (`SolanaPriceAccount = GenericPriceAccount<32, ()>`) ----
//
// Layout source (verified against https://github.com/pyth-network/pyth-sdk-rs):
//
//   #[repr(C)] struct GenericPriceAccount {
//      magic: u32,                  //   0..  4
//      ver: u32,                    //   4..  8
//      atype: u32,                  //   8.. 12
//      size: u32,                   //  12.. 16
//      ptype: PriceType (u8),       //  16.. 17  (1 byte + 3 bytes pad)
//      expo: i32,                   //  20.. 24
//      num: u32,                    //  24.. 28
//      num_qt: u32,                 //  28.. 32
//      last_slot: u64,              //  32.. 40
//      valid_slot: u64,             //  40.. 48
//      ema_price: Rational,         //  48.. 72  (3 * i64)
//      ema_conf: Rational,          //  72.. 96
//      timestamp: i64,              //  96..104  <-- aggregate publish UNIX time
//      min_pub: u8,                 // 104..105
//      drv2: u8,                    // 105..106
//      drv3: u16,                   // 106..108
//      drv4: u32,                   // 108..112
//      prod: Pubkey,                // 112..144
//      next: Pubkey,                // 144..176
//      prev_slot: u64,              // 176..184
//      prev_price: i64,             // 184..192
//      prev_conf: u64,              // 192..200
//      prev_timestamp: i64,         // 200..208
//      agg: PriceInfo {             // 208..240
//          price: i64,              // 208..216
//          conf: u64,               // 216..224
//          status: PriceStatus(u8), // 224..225  <-- 1 = Trading
//          corp_act: u8,            // 225..226
//          // 6 bytes pad to align pub_slot
//          pub_slot: u64,           // 232..240  <-- SLOT, not timestamp
//      },
//      comp: [PriceComp; 32],       // 240.. (...)
//      ...
//   }
//
// IMPORTANT: a previous revision of this parser used offset 232 as the
// `publish_time` field. That offset actually holds `agg.pub_slot` (a Solana
// slot number, ~3.3e8 on mainnet). Subtracting it from the unix timestamp
// produced age values around 1.4e9 seconds, which always exceeded any sane
// staleness threshold and silently broke every oracle-enabled mint. The
// canonical aggregate-publish unix timestamp lives at offset 96.

/// Pyth `magic` constant.
const PYTH_MAGIC: u32 = 0xa1b2c3d4;
/// Expected Pyth account version.
const PYTH_VERSION_2: u32 = 2;
/// `AccountType::Price` discriminant. Pyth defines `Unknown=0, Mapping=1, Product=2, Price=3`.
const PYTH_ATYPE_PRICE: u32 = 3;

/// Offset of `magic: u32`.
const PYTH_MAGIC_OFFSET: usize = 0;
/// Offset of `ver: u32`.
const PYTH_VERSION_OFFSET: usize = 4;
/// Offset of `atype: u32`.
const PYTH_ATYPE_OFFSET: usize = 8;
/// Offset of `expo: i32`.
const PYTH_EXPO_OFFSET: usize = 20;
/// Offset of the aggregate publish-timestamp `timestamp: i64` (unix seconds).
const PYTH_TIMESTAMP_OFFSET: usize = 96;
/// Offset of `agg.price: i64` (the integer price, scaled by 10^expo).
const PYTH_PRICE_OFFSET: usize = 208;
/// Offset of `agg.conf: u64` — the publisher-supplied confidence interval
/// around `agg.price`. A wide confidence interval indicates a thin /
/// illiquid market and should be rejected as untrustworthy.
const PYTH_CONF_OFFSET: usize = 216;
/// Offset of `agg.status: u8` (1 = Trading; anything else = stale/halted).
const PYTH_STATUS_OFFSET: usize = 224;
/// Minimum byte length we read from the price account.
/// We touch bytes through `agg.pub_slot` end (offset 240); keeping the bound
/// here also serves as a sanity guard against truncated inputs.
const PYTH_MIN_DATA_LEN: usize = 240;

/// `agg.status == Trading` value per the Pyth V2 PriceStatus enum.
const PYTH_STATUS_TRADING: u8 = 1;

/// Maximum confidence-interval ratio expressed in basis points of price.
/// `conf / price > MAX_CONF_RATIO_BPS / 10_000` is rejected. 200 bps = 2%
/// is the standard band used by Marinade, Kamino, and Pyth's own
/// `get_price_no_older_than` example. Tighter than this rejects routine
/// publisher churn; looser leaves the protocol exposed to thin-market
/// price prints.
const MAX_CONF_RATIO_BPS: u64 = 200;

/// Check oracle reserves before minting.
/// Returns `Ok` if reserves are sufficient, error otherwise. Manually parses
/// the Pyth V2 price account to avoid SDK dependency conflicts.
///
/// IMPORTANT: the oracle feed must:
///   1. Be owned by `PsmConfig::pyth_program_owner` (set at init, rotatable).
///   2. Have the canonical Pyth header (`magic`, `ver=2`, `atype=Price`).
///   3. Have `agg.status == Trading` (1) — halted/auction/unknown feeds rejected.
///   4. Have `expo == 0` — the price is interpreted directly as a raw token
///      count of reserves with no scaling. A custom feed publishing reserves
///      in OkuMoney base units (decimals = 6) is the expected configuration.
///   5. Be fresh per the configured `staleness_threshold` (compared against
///      `GenericPriceAccount::timestamp`, the aggregate publish unix time).
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

    // Minimum data length: we read through `agg.pub_slot` end at offset 240.
    require!(
        data.len() >= PYTH_MIN_DATA_LEN,
        LitePsmError::InvalidOracleResponse
    );

    // Header sanity: refuse anything that isn't a Pyth V2 Price account.
    let magic = u32::from_le_bytes(
        data[PYTH_MAGIC_OFFSET..PYTH_MAGIC_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(magic == PYTH_MAGIC, LitePsmError::InvalidOracleResponse);

    let version = u32::from_le_bytes(
        data[PYTH_VERSION_OFFSET..PYTH_VERSION_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(
        version == PYTH_VERSION_2,
        LitePsmError::InvalidOracleResponse
    );

    let atype = u32::from_le_bytes(
        data[PYTH_ATYPE_OFFSET..PYTH_ATYPE_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(
        atype == PYTH_ATYPE_PRICE,
        LitePsmError::InvalidOracleResponse
    );

    // Read expo, price, status (single byte!), publish timestamp.
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
    let conf = u64::from_le_bytes(
        data[PYTH_CONF_OFFSET..PYTH_CONF_OFFSET + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    // `agg.status` is a `#[repr(u8)]` enum — read as a single byte. A previous
    // revision read this as `u32`, which silently included `corp_act` and two
    // padding bytes; the comparison happened to pass for `Trading=1` only by
    // accident of layout/padding initialization.
    let status = data[PYTH_STATUS_OFFSET];
    let publish_time = i64::from_le_bytes(
        data[PYTH_TIMESTAMP_OFFSET..PYTH_TIMESTAMP_OFFSET + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );

    // Reject non-trading feeds (halted, unknown, auction). Without this, a
    // paused Pyth feed would still pass age and price checks since
    // `publish_time` continues to advance even when the feed isn't trading.
    require!(
        status == PYTH_STATUS_TRADING,
        LitePsmError::InvalidOracleResponse
    );

    // Reject feeds that don't report price as raw token base units. The
    // helper interprets `price` directly as a token-count of reserves; any
    // non-zero exponent would silently scale the comparison incorrectly.
    // Operators must publish a custom feed with `expo == 0` (or extend this
    // parser to apply the scaling).
    require!(expo == 0, LitePsmError::InvalidOracleResponse);

    // Check staleness against the aggregate publish UNIX timestamp.
    let current_time = clock.unix_timestamp;
    let age = current_time.saturating_sub(publish_time);
    require!(age <= staleness_threshold, LitePsmError::StaleOracle);

    // Price represents total reserves (e.g., T-Bill NAV backing in base units)
    // Ensure reserves >= current_supply + mint_amount
    require!(price >= 0, LitePsmError::InvalidOracleResponse);

    // Use `u64::try_from` rather than `as u64` so a pathological `i64::MAX`
    // (or any value where the high bit is set in a misbehaving feed) is
    // rejected cleanly instead of producing a misleadingly-large reserve.
    let reserves = u64::try_from(price).map_err(|_| LitePsmError::InvalidOracleResponse)?;
    let new_supply = current_supply
        .checked_add(mint_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Confidence-interval guard: reject feeds whose publisher uncertainty
    // is wider than `MAX_CONF_RATIO_BPS` of the price. A wide confidence
    // band is Pyth's standard signal for thin or stressed markets, and we
    // would rather pause minting than back the supply against an
    // unreliable print. The check is skipped when `reserves == 0` (the
    // outer `reserves >= new_supply` would catch this anyway).
    if reserves > 0 {
        let conf_bps = (conf as u128)
            .checked_mul(10_000u128)
            .ok_or(LitePsmError::Overflow)?
            .checked_div(reserves as u128)
            .ok_or(LitePsmError::Overflow)?;
        require!(
            conf_bps <= MAX_CONF_RATIO_BPS as u128,
            LitePsmError::OracleConfidenceTooWide
        );
    }

    require!(reserves >= new_supply, LitePsmError::InsufficientReserves);

    Ok(())
}

/// Pre-flight validation used by `set_oracle` to reject mis-configured
/// feeds at admin time rather than at every subsequent `mint_oku_m` call.
///
/// Asserts the header invariants (`magic`, `ver == 2`, `atype == Price`),
/// the program owner, and `expo == 0`. Does NOT assert staleness or
/// confidence because the feed is typically a fresh deploy with no
/// publishers attached yet; runtime checks still apply at mint time.
///
/// `oracle_pubkey` is the address the admin is trying to commit to config;
/// `oracle_account` must be that exact account.
///
/// F-03 (audit finding / `missing_signer_check`): No `.is_signer` check is
/// needed here because this function validates the **content** of a Pyth price
/// feed account, not the identity of a transaction signer. The oracle account
/// is a data account owned by the Pyth program — it neither can nor should sign
/// transactions. Authorization (who may call `set_oracle`) is enforced by the
/// calling `OracleManager` context, which requires `oracle_manager: Signer<'info>`
/// with `has_one = oracle_manager` pinned to `PsmConfig.oracle_manager`.
#[allow(unknown_lints, clippy::missing_signer_check)]
pub fn validate_oracle_feed(
    oracle_account: &AccountInfo,
    oracle_pubkey: Pubkey,
    pyth_program_owner: Pubkey,
) -> Result<()> {
    require!(
        oracle_account.key() == oracle_pubkey,
        LitePsmError::InvalidOracleResponse
    );
    require!(
        *oracle_account.owner == pyth_program_owner,
        LitePsmError::InvalidOracleResponse
    );

    let data = oracle_account.try_borrow_data()?;
    require!(
        data.len() >= PYTH_MIN_DATA_LEN,
        LitePsmError::InvalidOracleResponse
    );

    let magic = u32::from_le_bytes(
        data[PYTH_MAGIC_OFFSET..PYTH_MAGIC_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(magic == PYTH_MAGIC, LitePsmError::InvalidOracleResponse);

    let version = u32::from_le_bytes(
        data[PYTH_VERSION_OFFSET..PYTH_VERSION_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(
        version == PYTH_VERSION_2,
        LitePsmError::InvalidOracleResponse
    );

    let atype = u32::from_le_bytes(
        data[PYTH_ATYPE_OFFSET..PYTH_ATYPE_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(
        atype == PYTH_ATYPE_PRICE,
        LitePsmError::InvalidOracleResponse
    );

    let expo = i32::from_le_bytes(
        data[PYTH_EXPO_OFFSET..PYTH_EXPO_OFFSET + 4]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );
    require!(expo == 0, LitePsmError::InvalidOracleResponse);

    Ok(())
}
