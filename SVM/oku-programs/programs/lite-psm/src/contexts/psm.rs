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
pub struct MintUsdOku<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// usdOku mint (Token-2022 with ScaledUiAmount extension).
    /// `mint::authority = config` is defense-in-depth: even if someone attempted
    /// an out-of-band mint-authority rotation (which requires a CPI signed by
    /// the current authority = config PDA, so it cannot happen without the
    /// program's consent), this constraint would catch it at deserialization.
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's usdOku account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
pub struct RedeemUsdOku<'info> {
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

    /// usdOku mint (Token-2022 with ScaledUiAmount extension).
    /// `mint::authority = config` is defense-in-depth
    /// (see rationale on `MintUsdOku::usd_oku_mint`).
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's usdOku account
    #[account(
        mut,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
