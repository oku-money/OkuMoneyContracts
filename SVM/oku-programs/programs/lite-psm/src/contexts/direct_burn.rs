//! Account contexts for the direct-burn instruction (bridge / off-ramp path).
//!
//! This context supports the permissioned OkuM burn path that does NOT
//! trigger a USDC payout. Matches EVM's `OkuM.burn(amount)` called by
//! a non-PSM `OKUM_BURNER` role holder. Enables SVM->EVM bridging via
//! the KMS-backed orchestrator.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface};

/// Burn OkuM directly without USDC payout (permissioned -- `direct_burner` only).
///
/// The `direct_burner` authority is the sole signer and burns from its own
/// ATA. Mirrors EVM `OkuM.burn(amount)` where the caller (msg.sender)
/// must hold the `OKUM_BURNER` role and burns from its own balance.
#[derive(Accounts)]
pub struct BurnOkuMDirect<'info> {
    /// Operator / bridge backend holding the `direct_burner` authority.
    pub direct_burner: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = direct_burner @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuM mint (Token-2022). `mint::authority = config` is
    /// defense-in-depth (see rationale on `MintOkuM::oku_m_mint`).
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Burner's OkuM token account -- source of the burn. The burner
    /// must hold the tokens it wants to destroy.
    #[account(
        mut,
        token::mint = oku_m_mint,
        token::authority = direct_burner,
        token::token_program = token_2022_program,
    )]
    pub burner_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}
