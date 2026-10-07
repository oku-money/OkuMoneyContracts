//! Permissioned direct mint (fiat on-ramp): no on-chain USDC leg, so only role,
//! allowance and supply-cap guards apply. Collateral is held off-chain; the
//! USDC-backed path is `psm::mint_oku_m`.

use crate::contexts::direct_mint::MintOkuMDirect;
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{
    check_supply_cap, check_yield_lock, consume_allowance, multiplier, raw_to_dollars,
};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

pub fn mint_oku_m_direct(ctx: Context<MintOkuMDirect>, raw_amount: u64) -> Result<()> {
    check_yield_lock(&ctx.accounts.config)?;
    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(raw_amount > 0, LitePsmError::ZeroAmount);

    let new_total_supply = check_supply_cap(
        ctx.accounts.oku_m_mint.supply,
        raw_amount,
        ctx.accounts.config.max_supply,
    )?;
    consume_allowance(&mut ctx.accounts.config.direct_minter_allowance, raw_amount)?;

    let bump_seed = [ctx.accounts.config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

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

    // Canonical multiplier, for the event's dollar value only.
    let multiplier = multiplier::current(&ctx.accounts.config)?;

    emit!(DirectMintEvent {
        direct_minter: ctx.accounts.direct_minter.key(),
        recipient: ctx.accounts.recipient.key(),
        raw_oku_m_amount: raw_amount,
        multiplier,
        dollar_value: raw_to_dollars(raw_amount, multiplier)?,
        new_total_supply,
    });

    Ok(())
}
