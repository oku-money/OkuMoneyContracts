//! Accounts for `mint_oku_m_direct`.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

/// Accounts for `mint_oku_m_direct`: the direct minter mints new OkuM to any
/// recipient, with no USDC involved.
#[derive(Accounts)]
pub struct MintOkuMDirect<'info> {
    /// Also pays for recipient ATA creation.
    #[account(mut)]
    pub direct_minter: Signer<'info>,

    /// The singleton config PDA. Writable because the direct-mint allowance is
    /// drawn down; `has_one` makes the signer the configured `direct_minter`.
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = direct_minter @ LitePsmError::Unauthorized
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

    /// Recipient of the minted OkuM; does not sign.
    /// CHECK: Used only as the ATA authority for `recipient_oku_m_ata`.
    pub recipient: UncheckedAccount<'info>,

    /// Recipient's OkuM token account, created if missing.
    #[account(
        init_if_needed,
        payer = direct_minter,
        associated_token::mint = oku_m_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_2022_program,
    )]
    pub recipient_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
