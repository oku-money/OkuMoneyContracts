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

    /// USDC mint (standard SPL)
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuUSD mint (Token-2022)
    /// PSM config PDA must be mint authority
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

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
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetupRedemptionQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// PSM config must exist (initialize was called)
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        init,
        payer = payer,
        space = RedemptionQueue::LEN,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    pub system_program: Program<'info, System>,
}

/// Accounts for setup_okusd_escrow instruction
/// Creates the OkuUSD escrow vault for queue yield alignment
#[derive(Accounts)]
pub struct SetupOkusdEscrow<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ OkuError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's OkuUSD escrow vault for queued redemptions
    /// Holds OkuUSD while users are in queue so they earn yield
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = okusd_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
