use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

/// Context for setting the usdOku multiplier directly.
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
#[derive(Accounts)]
pub struct SetMultiplier<'info> {
    /// Rebaser role - authorized to update usdOku multiplier
    pub rebaser: Signer<'info>,

    /// PSM config - stores multiplier state and last_yield_distribution_slot
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// usdOku mint - mutable (needed for UpdateMultiplier CPI) and to read total supply for event
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}

/// Context for distributing yield across all usdOku holders.
/// REBASER only. Calculates new multiplier based on yield amount and total supply.
#[derive(Accounts)]
pub struct DistributeYield<'info> {
    /// Rebaser role - authorized to distribute yield
    pub rebaser: Signer<'info>,

    /// PSM config - stores multiplier state and last_yield_distribution_slot
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// usdOku mint - mutable (needed for UpdateMultiplier CPI) and to read total supply
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}
