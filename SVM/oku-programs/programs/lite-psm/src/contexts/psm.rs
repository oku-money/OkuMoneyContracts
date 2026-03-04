use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};
use crate::errors::OkuError;
use crate::state::{PsmConfig, RedemptionQueue};

#[derive(Accounts)]
pub struct MintOkusd<'info> {
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

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuUSD account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// Pyth price account (optional - only required if oracle is configured)
    /// CHECK: Validated manually in check_oracle_reserves - verifies account key matches config.oracle
    pub price_update: Option<UncheckedAccount<'info>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuUSD account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// PSM's OkuUSD escrow vault (for queued redemptions)
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessQueue<'info> {
    #[account(
        constraint = queue_processor.key() == config.queue_processor @ OkuError::Unauthorized
    )]
    pub queue_processor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    /// OkuUSD mint (Token-2022) - needed for burn CPI
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// PSM's OkuUSD escrow vault - holds queued redemptions
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    // Note: Recipient USDC ATAs are passed via remaining_accounts in queue order
}

#[derive(Accounts)]
pub struct DepositBuffer<'info> {
    #[account(
        constraint = buffer_depositor.key() == config.buffer_depositor @ OkuError::Unauthorized
    )]
    pub buffer_depositor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
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
    #[account(
        constraint = buffer_withdrawer.key() == config.buffer_withdrawer @ OkuError::Unauthorized
    )]
    pub buffer_withdrawer: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Redemption queue (read-only) — used to calculate reserved USDC for pending entries
    #[account(
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Account<'info, RedemptionQueue>,

    /// Buffer withdrawer's USDC account (destination)
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buffer_withdrawer,
    )]
    pub withdrawer_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's USDC vault (source)
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}
