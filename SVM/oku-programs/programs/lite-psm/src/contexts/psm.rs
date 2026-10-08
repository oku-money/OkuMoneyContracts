//! Accounts for the user-facing PSM instructions (mint, redeem) and the
//! buffer moves (deposit, withdraw).

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

/// Accounts for `mint_oku_m`: a user pays USDC into the vault and receives OkuM.
#[derive(Accounts)]
pub struct MintOkuM<'info> {
    /// Pays the USDC, receives the OkuM, and pays rent if their OkuM account is
    /// created here. Permissionless.
    #[account(mut)]
    pub user: Signer<'info>,

    /// The singleton config PDA. Writable because the PSM mint allowance is drawn
    /// down on every mint.
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint. Unchecked to skip deserialization: it is only forwarded to
    /// `transfer_checked`, which validates mint and decimals itself.
    ///
    /// CHECK: constrained to `config.usdc_mint`; never deserialized, only
    /// forwarded as an `AccountInfo` to `transfer_checked`, which validates it.
    #[account(address = config.usdc_mint)]
    pub usdc_mint: UncheckedAccount<'info>,

    /// OkuM mint (Token-2022). `mint::authority = config` is defense in depth.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account. `token::` rather than `associated_token::` skips the
    /// ~1.5k CU ATA derivation, which buys nothing here: the account is never
    /// created and `transfer_checked` validates it. Kept typed (not unchecked)
    /// so a client's wrong-account error names this field.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuM account. `associated_token::` because `init_if_needed` needs
    /// the canonical address.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = oku_m_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault. Unchecked for the same reason as `usdc_mint`.
    ///
    /// CHECK: constrained to `config.vault_usdc`; never deserialized, only
    /// forwarded as an `AccountInfo` to `transfer_checked`, which validates it.
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Accounts for `redeem_oku_m`: a user burns OkuM and receives USDC from the vault.
#[derive(Accounts)]
pub struct RedeemOkuM<'info> {
    /// Burns the OkuM, receives the USDC, and pays rent if their USDC account is
    /// created here. Permissionless.
    #[account(mut)]
    pub user: Signer<'info>,

    /// The singleton config PDA. Read-only: a redeem changes no config state (it
    /// only signs the vault transfer).
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint (pinned to the configured one)
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuM mint (Token-2022). `mint::authority = config` is defense in depth.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account, receives the payout. Created if missing so a user
    /// who has never held USDC can still redeem.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuM account; source of the burn
    #[account(
        mut,
        associated_token::mint = oku_m_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault; source of the payout. Typed (deserialized) because the
    /// handler reads its balance for the `InsufficientBuffer` check.
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Accounts for `deposit_buffer`: the buffer depositor adds USDC to the vault.
#[derive(Accounts)]
pub struct DepositBuffer<'info> {
    /// The configured `buffer_depositor` (enforced by `has_one` on `config`).
    pub buffer_depositor: Signer<'info>,

    /// The singleton config PDA; read-only here.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = buffer_depositor @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Buffer depositor's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = buffer_depositor,
        associated_token::token_program = token_program,
    )]
    pub buffer_depositor_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    /// USDC mint, for `transfer_checked`.
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

/// Accounts for `withdraw_buffer`: the buffer withdrawer takes USDC out of the vault.
#[derive(Accounts)]
pub struct WithdrawBuffer<'info> {
    /// The configured `buffer_withdrawer` (enforced by `has_one` on `config`).
    pub buffer_withdrawer: Signer<'info>,

    /// The singleton config PDA; read-only here. It owns the vault and signs the transfer out.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = buffer_withdrawer @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Buffer withdrawer's USDC account (destination)
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buffer_withdrawer,
    )]
    pub withdrawer_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// PSM's USDC vault (source)
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// USDC mint, for `transfer_checked`.
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}
