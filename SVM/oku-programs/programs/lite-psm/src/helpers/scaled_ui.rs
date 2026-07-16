//! OkuMoney price read/write via the `ScaledUiAmountConfig` Token-2022
//! extension on the OkuMoney mint.
//!
//! The OkuMoney mint carries the `ScaledUiAmountConfig` extension as the
//! **authoritative** source of the OkuMoney price multiplier (`oku_m_price`).
//! The PsmConfig PDA no longer stores this value.
//!
//! ## f64 precision budget
//!
//! `ScaledUiAmountConfig` stores its multiplier as IEEE 754 `f64`. The
//! protocol stores price as a PRECISION-scaled `u64` internally
//! (1e9 = $1.00). The round-trip `u64 -> f64 -> u64` is:
//!
//!   write: `multiplier_f64 = oku_m_price as f64 / PRECISION as f64`
//!   read:  `oku_m_price = (multiplier_f64 * PRECISION as f64).round() as u64`
//!
//! The maximum error after the divide-then-multiply is bounded by
//! `M * 2^-52` where M is the u64 value. For `.round()` to recover the
//! exact integer, we need `M * 2^-52 < 0.5`, i.e. `M < 2^51 ≈ 2.25e15`.
//!
//! `MAX_OKU_M_PRICE = 1e15`, giving a 2.25x safety margin. The round-trip
//! is **lossless** for all valid multiplier values.
//!
//! **Do not raise `MAX_OKU_M_PRICE` above 2.25e15** without revisiting
//! this analysis.
//!
//! ## Zero-init edge case
//!
//! After `InitializeScaledUiAmountConfig(multiplier = 1.0)`, the
//! `new_multiplier` field is zero-initialized (`0.0`). The
//! `new_multiplier_effective_timestamp` is also zero, so the extension's
//! `current_multiplier()` would normally select `new_multiplier` (since
//! `unix_timestamp >= 0`). We guard against this by checking whether
//! `new_multiplier > 0.0` before using it; if zero, we fall back to the
//! base `multiplier` field which is set correctly at init.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintRaw;
use oku_shared::PRECISION;

/// Read the OkuMoney price from the mint's `ScaledUiAmountConfig` extension.
///
/// Returns the price as a PRECISION-scaled `u64` (1e9 = $1.00).
///
/// # Errors
///
/// - `LitePsmError::InvalidMintExtension` if the mint does not carry the
///   `ScaledUiAmountConfig` extension or the data cannot be parsed.
/// - `LitePsmError::InvalidPrice` if the effective multiplier is zero or
///   negative.
pub fn read_oku_m_price(mint_account: &AccountInfo) -> Result<u64> {
    let data = mint_account.try_borrow_data()?;
    let mint_state = StateWithExtensions::<MintRaw>::unpack(&data)
        .map_err(|_| error!(LitePsmError::InvalidMintExtension))?;
    let config = mint_state
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| error!(LitePsmError::InvalidMintExtension))?;

    // Determine the effective multiplier. The extension has two fields:
    //   - `multiplier` (f64): the base multiplier set at init or last update
    //   - `new_multiplier` (f64): the scheduled next multiplier
    //   - `new_multiplier_effective_timestamp` (i64): when `new_multiplier`
    //     takes effect
    //
    // After init, `new_multiplier` is 0.0 (zero-initialized Pod). We
    // cannot rely on timestamp comparison alone because timestamp 0 is
    // always in the past. Check for `new_multiplier > 0.0` as the
    // "has been set" sentinel.
    let new_mult: f64 = config.new_multiplier.into();
    let base_mult: f64 = config.multiplier.into();

    let effective = if new_mult > 0.0 {
        // Normal case: `UpdateMultiplier` has been called at least once.
        // We always set `effective_timestamp = 0` (immediate), so
        // `new_multiplier` is always the current value.
        new_mult
    } else {
        // Init-only state: only the base `multiplier` has been set.
        base_mult
    };

    require!(effective > 0.0, LitePsmError::InvalidPrice);

    // Convert f64 -> PRECISION-scaled u64. Use `.round()` for lossless
    // round-trip (proven safe up to MAX_OKU_M_PRICE = 1e15; see module doc).
    let scaled = (effective * PRECISION as f64).round() as u64;

    require!(scaled > 0, LitePsmError::InvalidPrice);

    Ok(scaled)
}

/// Write the OkuMoney price to the mint's `ScaledUiAmountConfig` extension
/// via CPI to Token-2022's `UpdateMultiplier`.
///
/// The PsmConfig PDA signs as the `ScaledUiAmount` authority.
///
/// # Arguments
///
/// - `new_price`: the new price as a PRECISION-scaled `u64` (1e9 = $1.00)
/// - `mint_info`: the OkuMoney mint `AccountInfo` (mut)
/// - `config_info`: the PsmConfig PDA `AccountInfo` (signer via seeds)
/// - `token_2022_program_info`: the Token-2022 program `AccountInfo`
/// - `config_bump`: the PsmConfig PDA bump seed
pub fn write_oku_m_price<'info>(
    new_price: u64,
    mint_info: &AccountInfo<'info>,
    config_info: &AccountInfo<'info>,
    token_2022_program_info: &AccountInfo<'info>,
    config_bump: u8,
) -> Result<()> {
    // Convert PRECISION-scaled u64 to f64 for the extension.
    let new_multiplier_f64 = new_price as f64 / PRECISION as f64;

    let seeds = &[PsmConfig::SEED, &[config_bump]];
    let signer = &[&seeds[..]];

    // Build the UpdateMultiplier instruction manually. Anchor does not
    // provide a typed CPI wrapper for ScaledUiAmountConfig operations.
    let ix = anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier(
        &anchor_spl::token_2022::ID,
        mint_info.key,
        config_info.key,
        &[],               // no multisig signers
        new_multiplier_f64,
        0,                 // effective_timestamp = 0 (immediate)
    )
    .map_err(|_| error!(LitePsmError::Overflow))?;

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            mint_info.clone(),
            config_info.clone(),
            token_2022_program_info.clone(),
        ],
        signer,
    )?;

    Ok(())
}
