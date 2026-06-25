//! USDC peg circuit-breaker.
//!
//! Wraps a Pyth-V2 USDC/USD price feed and exposes two consumer functions:
//!
//! - [`check_usdc_peg`] — reverts when USDC is depegged or the oracle is
//!   unhealthy (round invalid / stale / out-of-band).
//! - [`get_usdc_price`] — returns the normalized USDC price in 1e9
//!   precision for off-chain monitoring use.
//!
//! Replaces the previous Proof-of-Reserves (`check_oracle_reserves`) plumbing
//! that was removed in this audit-prep cycle. Rationale: okuMoney is a
//! centralized US-regulated MSB; the operator is already responsible for
//! backing USDC, so an on-chain PoR check did not detect operator-side
//! reserve fraud — only oracle malfunction. The peg-check is a strict
//! circuit-breaker that prevents value bleed during a USDC depeg event,
//! which the operator-trust assumption does NOT cover.
//!
//! ## Pyth-V2 layout
//!
//! The relay parses the legacy `SolanaPriceAccount` (`GenericPriceAccount<32, ()>`)
//! layout directly to avoid pulling in `pyth-sdk-solana`'s transitive
//! dependency tree. Field offsets are documented inline below.
//!
//! Taken from <https://github.com/pyth-network/pyth-sdk-rs/blob/main/pyth-sdk-solana/src/state.rs>.
//! Taken from <https://docs.pyth.network/price-feeds/contract-addresses/solana>.
//!
//! NOTE: This is the *legacy* Pyth V2 layout. The modern Pyth Solana
//! Receiver (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) uses a different
//! account layout (`PriceUpdateV2`) and is NOT supported in v1. The
//! `set_oracle_relay_pyth_program_owner` instruction is the migration hook
//! once a second parser is added; for now operators must point at the
//! legacy program (mainnet `FsJ3...`, devnet `gSbe...`).
//!
//! ## Normalization
//!
//! Pyth publishes `(price: i64, expo: i32)` where the real value is
//! `price * 10^expo`. USDC/USD feeds typically use `expo == -8`. The relay
//! normalizes to SVM's 1e9 precision (matching `oku_m_price`, `usd_multiplier`)
//! by computing `price_e9 = price * 10^(9 + expo)` (with the sign on `expo`
//! folded into the formula). `expo > 0` is allowed but unusual; `|expo|` is
//! bounded by `MAX_FEED_EXPO_MAGNITUDE` to keep the scaling math finite.

use crate::constants::MAX_FEED_EXPO_MAGNITUDE;
use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::{BASIS_POINTS, MAX_ORACLE_CONFIDENCE_BPS};

// ---- Pyth V2 PriceAccount byte offsets ----
//
// Subset of the layout we read; full annotation lives in the noBridge
// commit history if a reviewer wants to cross-reference. The offsets here
// match the canonical `GenericPriceAccount<32, ()>` struct in pyth-sdk-rs.

/// Pyth `magic` constant.
const PYTH_MAGIC: u32 = 0xa1b2c3d4;
/// Expected Pyth account version (legacy V2).
const PYTH_VERSION_2: u32 = 2;
/// `AccountType::Price` discriminant (`Unknown=0, Mapping=1, Product=2, Price=3`).
const PYTH_ATYPE_PRICE: u32 = 3;

const PYTH_MAGIC_OFFSET: usize = 0;
const PYTH_VERSION_OFFSET: usize = 4;
const PYTH_ATYPE_OFFSET: usize = 8;
const PYTH_EXPO_OFFSET: usize = 20;
/// Aggregate publish-timestamp (`agg.publish_time: i64`, unix seconds).
const PYTH_TIMESTAMP_OFFSET: usize = 96;
/// Aggregate price (`agg.price: i64`, scaled by `10^expo`).
const PYTH_PRICE_OFFSET: usize = 208;
/// Aggregate confidence interval (`agg.conf: u64`, in the same units as
/// `agg.price`). Sits immediately after `agg.price` in the canonical
/// `PriceInfo` struct.
const PYTH_CONF_OFFSET: usize = 216;
/// Aggregate status (`agg.status: u8`; `1 == Trading`).
const PYTH_STATUS_OFFSET: usize = 224;
/// Minimum data length we require — covers through `agg.pub_slot` end
/// (offset 240). Defends against truncated input data.
const PYTH_MIN_DATA_LEN: usize = 240;

/// `agg.status == Trading` value per the Pyth V2 `PriceStatus` enum.
const PYTH_STATUS_TRADING: u8 = 1;

/// Reverts when the configured USDC/USD feed reports an out-of-band or
/// otherwise unhealthy price. This is the hot-path entry the PSM and vault
/// call at the top of every mint, redeem, and queue-process path.
///
/// `relay_feed_account` is the Pyth price account the caller supplied. The
/// helper verifies it matches `config.oracle_relay_feed`, that it's owned
/// by `config.oracle_relay_pyth_program_owner`, that the round is fresh +
/// trading + positive, and that the normalized price is inside
/// `[config.oracle_relay_min_price_e9, config.oracle_relay_max_price_e9]`.
pub fn check_usdc_peg<'info>(
    config: &PsmConfig,
    relay_feed_account: &Option<UncheckedAccount<'info>>,
) -> Result<()> {
    let _ = get_usdc_price(config, relay_feed_account)?;
    Ok(())
}

/// Reads the USDC/USD price from the configured Pyth feed and returns it
/// normalized to 1e9 precision. Validates the round (status, freshness,
/// positive answer), the band, and the feed's `|expo|` clamp. Reverts on
/// any validation failure.
///
/// Off-chain monitoring scripts can call this directly via `simulate` to
/// observe the live normalized price without affecting state.
pub fn get_usdc_price<'info>(
    config: &PsmConfig,
    relay_feed_account: &Option<UncheckedAccount<'info>>,
) -> Result<u64> {
    let feed_account = relay_feed_account
        .as_ref()
        .ok_or(LitePsmError::OracleAccountMissing)?;

    require!(
        feed_account.key() == config.oracle_relay_feed,
        LitePsmError::InvalidOracleResponse
    );

    // The price account is a Pyth-owned data account. Verifying ownership
    // against the configured program owner is what stops an attacker from
    // pointing the PSM at an arbitrary spoofed buffer.
    require!(
        *feed_account.owner == config.oracle_relay_pyth_program_owner,
        LitePsmError::InvalidOracleResponse
    );

    let clock = Clock::get()?;
    let data = feed_account.try_borrow_data()?;

    require!(
        data.len() >= PYTH_MIN_DATA_LEN,
        LitePsmError::InvalidOracleResponse
    );

    // Header sanity: magic + version + atype must all match the canonical
    // Pyth V2 price-account shape.
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
    let status = data[PYTH_STATUS_OFFSET];
    let publish_time = i64::from_le_bytes(
        data[PYTH_TIMESTAMP_OFFSET..PYTH_TIMESTAMP_OFFSET + 8]
            .try_into()
            .map_err(|_| LitePsmError::InvalidOracleResponse)?,
    );

    // Drop the data borrow before any later sysvar read or arithmetic
    // that might re-borrow the account.
    drop(data);

    // 1. Status must be Trading. Halted/auction/unknown feeds advance
    //    `publish_time` even when no real price is being formed.
    require!(
        status == PYTH_STATUS_TRADING,
        LitePsmError::InvalidOracleResponse
    );

    // 2. Freshness: `now − publish_time <= staleness_threshold`.
    let age = clock.unix_timestamp.saturating_sub(publish_time);
    require!(
        age <= config.oracle_relay_staleness,
        LitePsmError::StaleOracle
    );

    // 3. Positive answer. A negative or zero Pyth aggregate is meaningless
    //    for a USDC/USD feed and treated as malformed.
    require!(price > 0, LitePsmError::NonPositiveAnswer);

    // 4. Confidence interval. Reject rounds where the publisher set's
    //    stated uncertainty (`conf`) exceeds
    //    `MAX_ORACLE_CONFIDENCE_BPS / 10_000` of the price. The standard
    //    Pyth integration guidance (every Solana DeFi protocol that
    //    consumes Pyth — Marginfi, Drift, Kamino — does this) protects
    //    against publisher-degradation rounds whose `price` is in-band
    //    but whose `conf` is unbounded.
    //
    //    Use cross-multiplication (`conf * BASIS_POINTS > price * bps`)
    //    rather than `conf / price > bps / BASIS_POINTS` to avoid the
    //    truncation in the divide direction. `price` is non-negative
    //    (checked above) and the cast to u128 keeps both products from
    //    overflowing for any pair of i64 / u64 values.
    {
        let price_u128 = u128::try_from(price).map_err(|_| LitePsmError::InvalidOracleResponse)?;
        let conf_u128 = conf as u128;
        let lhs = conf_u128
            .checked_mul(BASIS_POINTS as u128)
            .ok_or(LitePsmError::Overflow)?;
        let rhs = price_u128
            .checked_mul(MAX_ORACLE_CONFIDENCE_BPS as u128)
            .ok_or(LitePsmError::Overflow)?;
        require!(lhs <= rhs, LitePsmError::OracleConfidenceTooWide);
    }

    // 5. Normalize raw `(price, expo)` to 1e9 precision (matching SVM's
    //    `oku_m_price` / `usd_multiplier` scale).
    //
    //    Real value = price * 10^expo.
    //    Normalized = price * 10^expo * 1e9
    //               = price * 10^(expo + 9)   when (expo + 9) >= 0
    //               = price / 10^-(expo + 9)  when (expo + 9) <  0
    //
    //    `|expo|` is clamped at admin time to `MAX_FEED_EXPO_MAGNITUDE`
    //    (= 18) so the 10^k term cannot blow past u128.
    let expo_magnitude = expo.unsigned_abs();
    require!(
        expo_magnitude <= MAX_FEED_EXPO_MAGNITUDE,
        LitePsmError::FeedExpoTooLarge
    );

    // `precision_exp = 9` (= log10(PRECISION = 1e9)). The shift cannot
    // overflow because `|expo| <= 18` (clamped above) so
    // `shift ∈ [-18 + 9, 18 + 9] = [-9, 27]`. Use `checked_add` anyway
    // for the explicit arithmetic-safety audit trail.
    const PRECISION_EXP: i32 = 9; // log10(PRECISION = 1e9)
    let shift = expo
        .checked_add(PRECISION_EXP)
        .ok_or(LitePsmError::Overflow)?;
    // `price > 0` was asserted above, so the i64 -> u128 cast is sign-safe.
    let raw = u128::try_from(price).map_err(|_| LitePsmError::NonPositiveAnswer)?;
    let price_e9_u128 = if shift >= 0 {
        // `shift` is non-negative here; `shift as u32` cannot lose sign.
        // The upper bound is 27, well below `u32::MAX`.
        let factor = 10u128
            .checked_pow(shift.unsigned_abs())
            .ok_or(LitePsmError::Overflow)?;
        raw.checked_mul(factor).ok_or(LitePsmError::Overflow)?
    } else {
        // `shift < 0`; `unsigned_abs()` returns `|shift|` as u32 without
        // an intermediate `(-shift) as u32` that clippy flags as a
        // sign-cast on a potential `i32::MIN` overflow (the explicit
        // `checked_add` above keeps `shift >= -18` so the panic case
        // is mathematically unreachable, but `unsigned_abs` is the
        // documented overflow-free idiom).
        let divisor = 10u128
            .checked_pow(shift.unsigned_abs())
            .ok_or(LitePsmError::Overflow)?;
        // Floor on the divide is acceptable: at expo == -8 with 1e9
        // normalization the shift is 1, so divisor == 10 and the lost
        // precision is at most 1 lamport per read. Symmetric to EVM's
        // truncation under the same conditions.
        raw.checked_div(divisor).ok_or(LitePsmError::Overflow)?
    };

    let price_e9 = u64::try_from(price_e9_u128).map_err(|_| LitePsmError::Overflow)?;

    // 6. Band check. Both bounds inclusive — same semantics as EVM's
    //    `priceE18 < min || priceE18 > max` revert.
    require!(
        price_e9 >= config.oracle_relay_min_price_e9
            && price_e9 <= config.oracle_relay_max_price_e9,
        LitePsmError::PriceOutOfBand
    );

    Ok(price_e9)
}

/// Pre-flight validation used by `set_oracle_relay_feed` to reject
/// mis-configured feeds at admin time rather than at every subsequent
/// mint/redeem call.
///
/// Asserts the header invariants (`magic`, `version == 2`, `atype == Price`)
/// and the program owner. Does NOT assert status/staleness/positivity/band
/// because a freshly-deployed feed may not have published its first round
/// yet; runtime checks still apply at consumer time.
///
/// F-03 (audit-style note): no `.is_signer` check is needed here — the
/// price account is a Pyth-owned data account, not a transaction signer.
/// Authorization (who may call `set_oracle_relay_feed`) is enforced by the
/// `OracleManager` context's `has_one = oracle_manager` constraint.
#[allow(unknown_lints, clippy::missing_signer_check)]
pub fn validate_oracle_relay_feed(
    feed_account: &AccountInfo,
    expected_feed: Pubkey,
    pyth_program_owner: Pubkey,
) -> Result<()> {
    require!(
        feed_account.key() == expected_feed,
        LitePsmError::InvalidOracleResponse
    );
    require!(
        *feed_account.owner == pyth_program_owner,
        LitePsmError::InvalidOracleResponse
    );

    let data = feed_account.try_borrow_data()?;
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
    require!(
        expo.unsigned_abs() <= MAX_FEED_EXPO_MAGNITUDE,
        LitePsmError::FeedExpoTooLarge
    );

    Ok(())
}
