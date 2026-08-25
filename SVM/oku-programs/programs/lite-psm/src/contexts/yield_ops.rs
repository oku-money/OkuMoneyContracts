use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

/// Context for setting the OkuM multiplier directly.
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
#[derive(Accounts)]
pub struct SetMultiplier<'info> {
    /// Rebaser role - authorized to update OkuM multiplier
    pub rebaser: Signer<'info>,

    /// PSM config - stores multiplier state and last_yield_distribution_slot
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuM mint - mutable (needed for UpdateMultiplier CPI) and to read total supply for event
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}

/// Context for distributing yield across all OkuM holders.
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

    /// OkuM mint - mutable (needed for UpdateMultiplier CPI) and to read total supply
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}

/// Context for opening / closing the cross-chain multiplier sync window.
///
/// Held by `rebaser` rather than a dedicated role: the orchestrator that
/// writes the multiplier is the same actor that knows when a tick has
/// landed on both chains, so a separate key would add plumbing without
/// adding separation. Deliberately does **not** take the mint — opening a
/// window touches no token state, and keeping the account set minimal
/// keeps the instruction cheap enough to bundle with the tick.
#[derive(Accounts)]
pub struct SyncWindow<'info> {
    /// Rebaser role — the orchestrator driving the cross-chain tick.
    pub rebaser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}
