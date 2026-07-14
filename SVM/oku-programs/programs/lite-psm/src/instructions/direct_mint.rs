//! Permissioned direct-mint instruction (fiat on-ramp path).
//!
//! This instruction allows a `direct_minter` authority to mint usdOku
//! WITHOUT depositing USDC on-chain. Matches EVM's `usdOku.mint(to, amount)`
//! called by a non-PSM `OKUM_MINTER` role holder.
//!
//! The on-chain collateral discipline for USDC-backed mints lives in
//! `instructions::psm::mint_oku_m`; the `direct_minter` path enforces
//! only role + allowance + supply-cap guards. The fiat collateral backing
//! these mints is held off-chain by the operator.

// CPI targets are constrained by Anchor's typed `Program<'info, Token2022>`
// accounts. The `arbitrary_cpi` warning is a false positive.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::contexts::direct_mint::MintUsdOkuDirect;
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_yield_lock, oku_m_to_dollars, read_multiplier};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Mint usdOku directly without USDC (permissioned).
///
/// Guards (matching EVM `usdOku.mint`):
/// - `direct_minter` must be signer, validated via `has_one` on config
/// - Pause check
/// - Yield-lock check (same slot as yield distribution -> reject)
/// - Max supply check
/// - `direct_minter_allowance` check + decrement (effects-before-interactions)
///
/// NOT included (no USDC involvement):
/// - No USDC transfer
/// - No round-trip drift check
pub fn mint_usd_oku_direct(ctx: Context<MintUsdOkuDirect>, raw_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let direct_minter_allowance = ctx.accounts.config.direct_minter_allowance;
    let current_supply = ctx.accounts.usd_oku_mint.supply;

    require!(!is_paused, LitePsmError::Paused);
    require!(raw_amount > 0, LitePsmError::ZeroAmount);

    // Check max supply
    require!(
        current_supply
            .checked_add(raw_amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );

    // Check direct-minter allowance
    require!(
        raw_amount <= direct_minter_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Effects-before-interactions: decrement allowance BEFORE the mint CPI
    let bump = ctx.accounts.config.bump;
    ctx.accounts.config.direct_minter_allowance = direct_minter_allowance
        .checked_sub(raw_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Mint usdOku to recipient (Token-2022)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    let direct_minter_key = ctx.accounts.direct_minter.key();
    let recipient_key = ctx.accounts.recipient.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.usd_oku_mint.to_account_info(),
                to: ctx.accounts.recipient_usd_oku_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        raw_amount,
    )?;

    // Read multiplier from mint to compute dollar value for the event
    let multiplier = read_multiplier(&ctx.accounts.usd_oku_mint.to_account_info())?;
    let dollar_value = oku_m_to_dollars(raw_amount, multiplier)?;

    ctx.accounts.usd_oku_mint.reload()?;
    let new_total_supply = ctx.accounts.usd_oku_mint.supply;

    emit!(DirectMintEvent {
        direct_minter: direct_minter_key,
        recipient: recipient_key,
        raw_usd_oku_amount: raw_amount,
        multiplier,
        dollar_value,
        new_total_supply,
    });

    Ok(())
}
