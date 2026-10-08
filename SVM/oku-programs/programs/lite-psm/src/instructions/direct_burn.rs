//! Permissioned direct burn (bridge / off-ramp): supply destruction with no USDC
//! payout. Settlement happens off-chain, via `mint_oku_m` on the destination
//! chain. Unlike EVM `burn()`, this is blocked while paused.

use crate::contexts::direct_burn::BurnOkuMDirect;
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_yield_lock, consume_allowance, multiplier, raw_to_dollars};
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Burn `raw_amount` OkuM from the `direct_burner`'s own token account, with no
/// USDC paid out.
///
/// The SVM->EVM bridge leg: the value leaves Solana here and is re-minted on the
/// destination chain off-chain. Only the `direct_burner` can call it, bounded by
/// its `direct_burner_allowance`.
pub fn burn_oku_m_direct(ctx: Context<BurnOkuMDirect>, raw_amount: u64) -> Result<()> {
    // Same guards as every supply-changing path: override slot, pause, zero amount.
    check_yield_lock(&ctx.accounts.config)?;
    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(raw_amount > 0, LitePsmError::ZeroAmount);

    consume_allowance(&mut ctx.accounts.config.direct_burner_allowance, raw_amount)?;

    // Supply after the burn, for the event (the burn changes it by exactly this).
    let new_total_supply = ctx
        .accounts
        .oku_m_mint
        .supply
        .checked_sub(raw_amount)
        .ok_or(LitePsmError::Overflow)?;

    // The burner owns the token account and signs the burn itself; no PDA signer.
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.oku_m_mint.to_account_info(),
                from: ctx.accounts.burner_oku_m_ata.to_account_info(),
                authority: ctx.accounts.direct_burner.to_account_info(),
            },
        ),
        raw_amount,
    )?;

    // Canonical multiplier, for the event's dollar value only.
    let multiplier = multiplier::current(&ctx.accounts.config)?;

    emit!(DirectBurnEvent {
        direct_burner: ctx.accounts.direct_burner.key(),
        raw_oku_m_amount: raw_amount,
        multiplier,
        dollar_value: raw_to_dollars(raw_amount, multiplier)?,
        new_total_supply,
    });

    Ok(())
}
