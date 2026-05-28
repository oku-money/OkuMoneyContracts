use crate::errors::LitePsmError;
use crate::state::{PsmConfig, RedemptionQueue};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = PsmConfig::LEN,
        seeds = [PsmConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint (standard SPL).
    ///
    /// Must have exactly 6 decimals on Solana — this matches the
    /// `OkuMoney`/`usdOku` decimal model. EVM resolves a runtime
    /// `usdcDecimalMultiplier` from `IERC20Metadata.decimals()`; SVM hardcodes
    /// 6 decimals and asserts at init. See `EVM_VS_SVM.md`.
    #[account(
        constraint = usdc_mint.decimals == 6 @ LitePsmError::InvalidUsdcDecimals
    )]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuMoney mint (Token-2022).
    ///
    /// At init we lock down both authorities to the PSM config PDA so that
    /// no EOA can mint or freeze OkuMoney post-deployment. Without these
    /// constraints, a misconfigured deploy could initialize PSM against a
    /// mint whose authority is a different program / multisig, silently
    /// breaking supply accounting.
    ///
    /// Decimals are pinned at 6 — all PSM math (`oku_m_price`,
    /// `oku_m_to_dollars`, yield distribution) assumes 6-decimal raw
    /// amounts. EVM resolves this at runtime from `IERC20Metadata`; SVM
    /// hardcodes the assumption and asserts it at init.
    #[account(
        mint::token_program = token_2022_program,
        mint::authority = config,
        mint::freeze_authority = config,
        constraint = oku_money_mint.decimals == 6 @ LitePsmError::InvalidOkuMoneyDecimals,
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's USDC vault
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // F-04: Rent::get() is called internally by Anchor's `init` and
    // `associated_token::*` constraints — passing the sysvar account is
    // unnecessary since Solana v1.8. Removed to save a transaction account slot.
}

#[derive(Accounts)]
pub struct SetupRedemptionQueue<'info> {
    /// `role_admin` is the only authority permitted to create the queue PDA.
    /// Without this gate, any signer could front-run the deployer and create
    /// the canonical-seeded `RedemptionQueue` PDA, forcing the legitimate
    /// `initialize` flow to fail with `AccountAlreadyInitialized` until the
    /// griefer's account is closed. Matches the authority model used by
    /// `SetupOkuMoneyEscrow` below.
    #[account(mut)]
    pub role_admin: Signer<'info>,

    /// PSM config must exist (initialize was called).
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        init,
        payer = role_admin,
        space = RedemptionQueue::LEN,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    pub system_program: Program<'info, System>,
}

/// Accounts for setup_oku_money_escrow instruction
/// Creates the OkuMoney escrow vault for queued redemptions
#[derive(Accounts)]
pub struct SetupOkuMoneyEscrow<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuMoney mint (Token-2022).
    /// Must match the mint stored in config during initialize, and must have
    /// the PSM config PDA as both mint and freeze authority.
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program,
        mint::authority = config,
        mint::freeze_authority = config,
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's OkuMoney escrow vault for queued redemptions
    /// Holds OkuMoney while users are in queue (yield comes from price appreciation)
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = oku_money_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_oku_money: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
