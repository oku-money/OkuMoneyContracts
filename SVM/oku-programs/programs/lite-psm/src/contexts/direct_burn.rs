//! Accounts for `burn_oku_m_direct`.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface};

/// Accounts for `burn_oku_m_direct`: the direct burner destroys OkuM from its own
/// account, with no USDC paid out.
#[derive(Accounts)]
pub struct BurnOkuMDirect<'info> {
    /// The configured `direct_burner`; owns and signs for the burned account.
    pub direct_burner: Signer<'info>,

    /// The singleton config PDA. Writable because the direct-burn allowance is
    /// drawn down; `has_one` enforces the role.
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = direct_burner @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuM mint (Token-2022). `mint::authority = config` is defense in depth.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// The burner's own account; source of the burn.
    #[account(
        mut,
        token::mint = oku_m_mint,
        token::authority = direct_burner,
        token::token_program = token_2022_program,
    )]
    pub burner_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}
