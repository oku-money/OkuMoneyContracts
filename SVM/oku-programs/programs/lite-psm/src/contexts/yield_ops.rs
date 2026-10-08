//! Accounts for the rate-schedule instructions and the display-mirror crank.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

/// Shared by the three rate-schedule writers. Deliberately takes no mint: the
/// schedule lives on `PsmConfig`, so these cannot fail on a token-program error
/// at epoch boundaries.
#[derive(Accounts)]
pub struct SetYieldRate<'info> {
    /// The configured `rebaser`.
    pub rebaser: Signer<'info>,

    /// The singleton config PDA (writable: the rate schedule).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// The mint is mutable because the override force-syncs the display mirror;
/// leaving it to the crank could let the mirror read above canonical.
#[derive(Accounts)]
pub struct SetOkuMMultiplier<'info> {
    /// The configured `rebaser`.
    pub rebaser: Signer<'info>,

    /// The singleton config PDA (writable: the schedule is collapsed).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuM mint; its `ScaledUiAmount` display multiplier is rewritten.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Permissionless by design: the written value is a pure function of `PsmConfig`
/// and the clock, and the config PDA signs the CPI.
#[derive(Accounts)]
pub struct SyncDisplayMultiplier<'info> {
    /// Anyone.
    pub cranker: Signer<'info>,

    /// The singleton config PDA (writable: `last_display_sync_ts`). Signs the
    /// mirror update as `ScaledUiAmount` authority.
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuM mint; its `ScaledUiAmount` display multiplier is rewritten.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}
