use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

/// Context for setting the OkuMoney price directly
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
#[derive(Accounts)]
pub struct SetOkuMPrice<'info> {
    /// Rebaser role - authorized to update OkuMoney price
    #[account(
        constraint = rebaser.key() == config.rebaser @ LitePsmError::Unauthorized
    )]
    pub rebaser: Signer<'info>,

    /// PSM config - stores oku_m_price and last_yield_distribution_slot
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuMoney mint - needed to read total supply for event
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}

/// Context for distributing yield across all OkuMoney holders
/// REBASER only. Calculates new price based on yield amount and total supply.
#[derive(Accounts)]
pub struct DistributeYield<'info> {
    /// Rebaser role - authorized to distribute yield
    #[account(
        constraint = rebaser.key() == config.rebaser @ LitePsmError::Unauthorized
    )]
    pub rebaser: Signer<'info>,

    /// PSM config - stores oku_m_price and last_yield_distribution_slot
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuMoney mint - needed to read total supply for yield distribution calculation
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}
