//! Permissioned direct-mint instruction (fiat on-ramp path).
//!
//! This instruction allows a `direct_minter` authority to mint OkuM
//! WITHOUT depositing USDC on-chain. Matches EVM's `OkuM.mint(to, amount)`
//! called by a non-PSM `OKUM_MINTER` role holder.
//!
//! The on-chain collateral discipline for USDC-backed mints lives in
//! `instructions::psm::mint_oku_m`; the `direct_minter` path enforces
//! only role + allowance + supply-cap guards. The fiat collateral backing
//! these mints is held off-chain by the operator.

use crate::contexts::direct_mint::MintOkuMDirect;
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_sync_window, check_yield_lock, raw_to_dollars, read_multiplier};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Mint OkuM directly without USDC (permissioned).
///
/// Guards (matching EVM `OkuM.mint`):
/// - `direct_minter` must be signer, validated via `has_one` on config
/// - Pause check
/// - Yield-lock check (same slot as yield distribution -> reject)
/// - Max supply check
/// - `direct_minter_allowance` check + decrement (effects-before-interactions)
///
/// NOT included (no USDC involvement):
/// - No USDC transfer
/// - No round-trip drift check
pub fn mint_oku_m_direct(ctx: Context<MintOkuMDirect>, raw_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Cross-chain sync window.
    //
    // This instruction does not price through the multiplier on its own --
    // the quantity is the caller-supplied raw amount, and the multiplier read
    // below feeds only the event's dollar_value field. But the CROSS-CHAIN
    // PAIR does price: burning 100 raw where M=1.04 destroys $104 of claim
    // while minting 100 raw where M=1.05 creates $105, conjuring $1 out of a
    // mid-tick divergence.
    //
    // So the gating rule is "can this move value across a multiplier
    // boundary", not "does this price locally". Raw-conserving is a
    // per-instruction property and does not survive the round trip.
    check_sync_window(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let direct_minter_allowance = ctx.accounts.config.direct_minter_allowance;
    let current_supply = ctx.accounts.oku_m_mint.supply;

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

    // Mint OkuM to recipient (Token-2022)
    let bump = [bump];
    let seeds = PsmConfig::signer_seeds(&bump);
    let signer = &[&seeds[..]];

    let direct_minter_key = ctx.accounts.direct_minter.key();
    let recipient_key = ctx.accounts.recipient.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_m_mint.to_account_info(),
                to: ctx.accounts.recipient_oku_m_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        raw_amount,
    )?;

    // Read multiplier from mint to compute dollar value for the event
    let multiplier = read_multiplier(&ctx.accounts.oku_m_mint.to_account_info())?;
    let dollar_value = raw_to_dollars(raw_amount, multiplier)?;

    ctx.accounts.oku_m_mint.reload()?;
    let new_total_supply = ctx.accounts.oku_m_mint.supply;

    emit!(DirectMintEvent {
        direct_minter: direct_minter_key,
        recipient: recipient_key,
        raw_oku_m_amount: raw_amount,
        multiplier,
        dollar_value,
        new_total_supply,
    });

    Ok(())
}
