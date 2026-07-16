use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

/// Context for setting the OkuMoney price directly.
///
/// REBASER only. Writes to the mint's `ScaledUiAmountConfig` extension
/// via CPI and stamps `last_yield_distribution_slot` for sandwich prevention.
#[derive(Accounts)]
pub struct SetOkuMPrice<'info> {
    /// Rebaser role - authorized to update OkuMoney price
    pub rebaser: Signer<'info>,

    /// PSM config - stores last_yield_distribution_slot (oku_m_price is
    /// now on the mint's ScaledUiAmountConfig extension).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuMoney mint - carries the authoritative ScaledUiAmountConfig
    /// extension. Mutable because the CPI writes to the extension data.
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program (target of the UpdateMultiplier CPI)
    pub token_2022_program: Program<'info, Token2022>,
}

/// Context for distributing yield across all OkuMoney holders.
///
/// REBASER only. Reads the current price from the mint's
/// `ScaledUiAmountConfig` extension, computes the new price, and writes
/// it back via CPI.
#[derive(Accounts)]
pub struct DistributeYield<'info> {
    /// Rebaser role - authorized to distribute yield
    pub rebaser: Signer<'info>,

    /// PSM config - stores last_yield_distribution_slot.
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuMoney mint - carries the authoritative ScaledUiAmountConfig
    /// extension. Mutable because the CPI writes to the extension data.
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program (target of the UpdateMultiplier CPI)
    pub token_2022_program: Program<'info, Token2022>,
}
