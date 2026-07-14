//! Account contexts for the direct-mint instruction (fiat on-ramp path).
//!
//! This context supports the permissioned usdOku mint path that does NOT
//! require USDC collateral on-chain. Matches EVM's `usdOku.mint(to,
//! amount)` called by a non-PSM `OKUM_MINTER` role holder.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

/// Mint usdOku directly without USDC (permissioned -- `direct_minter` only).
///
/// The `direct_minter` authority is the sole signer; the `recipient` does
/// not need to sign. Mirrors EVM `usdOku.mint(to, amount)` where the
/// caller is a non-PSM `OKUM_MINTER`.
#[derive(Accounts)]
pub struct MintUsdOkuDirect<'info> {
    /// Operator / fiat gateway holding the `direct_minter` authority.
    /// Also pays for any ATA initialisation.
    #[account(mut)]
    pub direct_minter: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = direct_minter @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// usdOku mint (Token-2022). `mint::authority = config` is
    /// defense-in-depth (see rationale on `MintUsdOku::usd_oku_mint`).
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Recipient of the minted usdOku. Does NOT need to sign --
    /// the operator mints on behalf of the user.
    /// CHECK: Used only as the ATA authority for `recipient_usd_oku_ata`.
    pub recipient: UncheckedAccount<'info>,

    /// Recipient's usdOku token account. `init_if_needed` so the
    /// recipient doesn't need a pre-existing ATA.
    #[account(
        init_if_needed,
        payer = direct_minter,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_2022_program,
    )]
    pub recipient_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
