//! Account contexts for direct-mint instructions (fiat on-ramp path) and
//! the one-time PsmConfig migration (674 → 714 bytes).
//!
//! These contexts support the permissioned OkuMoney mint path that does NOT
//! require USDC collateral on-chain. Matches EVM's `OkuMoney.mint(to,
//! amount)` called by a non-PSM `OKUM_MINTER` role holder.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

/// Mint OkuMoney directly without USDC (permissioned — `direct_minter` only).
///
/// The `direct_minter` authority is the sole signer; the `recipient` does
/// not need to sign. Mirrors EVM `OkuMoney.mint(to, amount)` where the
/// caller is a non-PSM `OKUM_MINTER`.
#[derive(Accounts)]
pub struct MintOkuMDirect<'info> {
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

    /// OkuMoney mint (Token-2022). `mint::authority = config` is
    /// defense-in-depth (see rationale on `MintOkuM::oku_money_mint`).
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Recipient of the minted OkuMoney. Does NOT need to sign —
    /// the operator mints on behalf of the user.
    /// CHECK: Used only as the ATA authority for `recipient_oku_money_ata`.
    pub recipient: UncheckedAccount<'info>,

    /// Recipient's OkuMoney token account. `init_if_needed` so the
    /// recipient doesn't need a pre-existing ATA.
    #[account(
        init_if_needed,
        payer = direct_minter,
        associated_token::mint = oku_money_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_2022_program,
    )]
    pub recipient_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mint OkuMoney directly and wrap into usdOku in a single instruction
/// (permissioned — `direct_minter` only).
///
/// Flow:
/// 1. Mint OkuMoney to the PsmConfig PDA's OkuMoney ATA (`vault_oku_money`)
/// 2. CPI to `oku_dollar::wrap_to` — transfers OkuMoney from `vault_oku_money`
///    to the oku-dollar reserve vault, mints usdOku shares to the `recipient`
///
/// Matches EVM `LitePSM.mintUsdOku` convenience pattern (minus the USDC).
#[derive(Accounts)]
pub struct MintUsdOkuDirect<'info> {
    /// Operator / fiat gateway. Also pays for ATA init.
    #[account(mut)]
    pub direct_minter: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = direct_minter @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuMoney mint (Token-2022).
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's OkuMoney escrow vault — used as the intermediary ATA for the
    /// mint→wrap atomic flow. The OkuMoney is minted here and immediately
    /// transferred to the oku-dollar reserve vault via the `wrap_to` CPI,
    /// so the balance is net-zero before and after the instruction.
    #[account(
        mut,
        address = config.vault_oku_money,
        token::mint = oku_money_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_oku_money: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Recipient of the minted usdOku shares. Does NOT need to sign.
    /// CHECK: Used only as the ATA authority for `recipient_usd_oku_ata`.
    pub recipient: UncheckedAccount<'info>,

    // ===== oku-dollar CPI accounts (passed through to `wrap_to`) =====
    /// OkuDollar config PDA (read-only for wrap math).
    /// CHECK: Validated by the oku-dollar program during CPI. We verify
    /// the address matches config.psm_config's back-reference by checking
    /// it is the canonical oku-dollar PDA.
    pub oku_dollar_config: UncheckedAccount<'info>,

    /// usdOku mint (Token-2022) — mutated by wrap_to's mint_to CPI.
    /// CHECK: Validated by the oku-dollar program during CPI.
    #[account(mut)]
    pub usd_oku_mint: UncheckedAccount<'info>,

    /// Recipient's usdOku token account — init_if_needed by wrap_to.
    /// CHECK: Validated by the oku-dollar program during CPI.
    #[account(mut)]
    pub recipient_usd_oku_ata: UncheckedAccount<'info>,

    /// OkuDollar's OkuMoney reserve vault — receives OkuMoney from wrap_to.
    /// CHECK: Validated by the oku-dollar program during CPI.
    #[account(mut)]
    pub oku_dollar_reserve_vault: UncheckedAccount<'info>,

    /// Dead-shares ATA (optional, only needed on first usdOku deposit).
    /// CHECK: Validated by the oku-dollar program during CPI.
    #[account(mut)]
    pub dead_shares_ata: Option<UncheckedAccount<'info>>,

    /// The oku-dollar program to CPI into.
    /// CHECK: Validated by program ID comparison in the handler.
    pub oku_dollar_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// One-time migration: extend PsmConfig from 674 → 714 bytes.
///
/// The config account is taken as `UncheckedAccount` because Anchor
/// would try to borsh-deserialize it as the new (714-byte) `PsmConfig`
/// struct, which fails on the pre-migration 674-byte account.
///
/// After calling this instruction, all other instructions can
/// deserialize normally because the account matches the new layout.
///
/// Guard: `role_admin` must sign. The handler validates the signer
/// against the raw `role_admin` bytes stored in the account (offset
/// 9..41 after the 8-byte discriminator + 1-byte bump).
#[derive(Accounts)]
pub struct MigratePsmConfig<'info> {
    /// Pays for the additional rent-exempt lamports.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must match the `role_admin` stored in PsmConfig.
    pub role_admin: Signer<'info>,

    /// PsmConfig PDA — verified by seeds but NOT deserialized as
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
