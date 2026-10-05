use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

#[derive(Accounts)]
pub struct MintOkuM<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint. Only ever passed through to `transfer_checked` as an
    /// `AccountInfo` (`instructions/psm.rs::mint_oku_m`), never read in Rust —
    /// `UncheckedAccount` skips the SPL `Mint` deserialization entirely, and
    /// `transfer_checked` itself validates mint + decimals on-chain, so no
    /// security property is lost. `address = config.usdc_mint` is the whole
    /// check this account needs.
    ///
    /// CHECK: constrained to `config.usdc_mint`; never deserialized, only
    /// forwarded as an `AccountInfo` to `transfer_checked`, which validates it.
    #[account(address = config.usdc_mint)]
    pub usdc_mint: UncheckedAccount<'info>,

    /// OkuM mint (Token-2022 with ScaledUiAmount extension).
    /// `mint::authority = config` is defense-in-depth: even if someone attempted
    /// an out-of-band mint-authority rotation (which requires a CPI signed by
    /// the current authority = config PDA, so it cannot happen without the
    /// program's consent), this constraint would catch it at deserialization.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account. `token::` rather than `associated_token::`:
    /// the latter also derives the canonical ATA address
    /// (`find_program_address`, ~1.5k CU on SBF) purely to assert the passed
    /// account matches it. That derivation buys nothing here — this account
    /// is never created (no `init_if_needed`) and is only ever forwarded as
    /// an `AccountInfo` to `transfer_checked`, which validates mint and
    /// decimals itself. `token::mint`/`token::authority` keep the economic
    /// property (right mint, right owner) a non-canonical token account the
    /// user happens to also own is not a protocol concern, just a UX
    /// convention — without paying for the derivation.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuM account. Keeps `associated_token::` (vs. `user_usdc_ata`
    /// above) because `init_if_needed` NEEDS the canonical ATA address to
    /// create the account at — the derivation is not avoidable here.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = oku_m_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault. Same reasoning as `usdc_mint` above: only ever
    /// forwarded as an `AccountInfo` to `transfer_checked` (as the `to:`
    /// destination), never read in Rust.
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

#[derive(Accounts)]
pub struct RedeemOkuM<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuM mint (Token-2022 with ScaledUiAmount extension).
    /// `mint::authority = config` is defense-in-depth
    /// (see rationale on `MintOkuM::oku_m_mint`).
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuM account
    #[account(
        mut,
        associated_token::mint = oku_m_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
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

#[derive(Accounts)]
pub struct DepositBuffer<'info> {
    pub buffer_depositor: Signer<'info>,

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

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawBuffer<'info> {
    pub buffer_withdrawer: Signer<'info>,

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

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}
