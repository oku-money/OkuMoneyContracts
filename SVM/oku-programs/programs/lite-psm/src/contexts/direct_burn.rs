//! Account contexts for direct-burn instructions (bridge / off-ramp path)
//! and the one-time PsmConfig migration (594 -> 634 bytes).
//!
//! These contexts support the permissioned OkuMoney burn path that does NOT
//! trigger a USDC payout. Matches EVM's `OkuMoney.burn(amount)` called by
//! a non-PSM `OKUM_BURNER` role holder. Enables SVM->EVM bridging via
//! the KMS-backed orchestrator.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface};

/// Burn OkuMoney directly without USDC payout (permissioned -- `direct_burner` only).
///
/// The `direct_burner` authority is the sole signer and burns from its own
/// ATA. Mirrors EVM `OkuMoney.burn(amount)` where the caller (msg.sender)
/// must hold the `OKUM_BURNER` role and burns from its own balance.
#[derive(Accounts)]
pub struct BurnOkuMDirect<'info> {
    /// Operator / bridge backend holding the `direct_burner` authority.
    #[account(mut)]
    pub direct_burner: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = direct_burner @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuMoney mint (Token-2022). `mint::authority = config` is
    /// defense-in-depth (see rationale on `MintOkuM::oku_money_mint`).
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Burner's OkuMoney token account -- source of the burn. The burner
    /// must hold the tokens it wants to destroy.
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::authority = direct_burner,
        token::token_program = token_2022_program,
    )]
    pub burner_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// One-time migration: extend PsmConfig from 594 -> 634 bytes.
///
/// Appends 40 zero bytes (= `direct_burner: Pubkey::default()` +
/// `direct_burner_allowance: 0u64`). After the realloc, every
/// instruction that deserializes `Account<PsmConfig>` works normally.
///
/// Idempotent: reverts if the account is already 634 bytes.
///
/// Guard: `role_admin` must sign. The handler validates the signer
/// against the raw `role_admin` bytes stored in the account (offset
/// 9..41 after the 8-byte discriminator + 1-byte bump).
#[derive(Accounts)]
pub struct MigratePsmConfigV2<'info> {
    /// Pays for the additional rent-exempt lamports.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must match the `role_admin` stored in PsmConfig.
    pub role_admin: Signer<'info>,

    /// PsmConfig PDA -- verified by seeds but NOT deserialized as
    /// `Account<PsmConfig>` (it's too small pre-migration).
    /// CHECK: Seeds + discriminator + role_admin verified in handler.
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump,
    )]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
