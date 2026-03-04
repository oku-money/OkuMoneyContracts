use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};
use crate::errors::VaultError;
use crate::state::VaultConfig;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = VaultConfig::LEN,
        seeds = [VaultConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    /// OkuUSD mint (Token-2022 with Interest-Bearing extension)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL Token)
    /// Mint authority must be the config PDA
    #[account(
        init,
        payer = role_admin,
        mint::decimals = okusd_mint.decimals,
        mint::authority = config,
        mint::token_program = token_program,
    )]
    pub wokusd_mint: Box<Account<'info, Mint>>,

    /// Vault's OkuUSD token account
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = okusd_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL)
    #[account(
        mut,
        address = config.wokusd_mint
    )]
    pub wokusd_mint: Box<Account<'info, Mint>>,

    /// User's OkuUSD token account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's wOkuUSD token account (must be pre-created by frontend)
    #[account(
        mut,
        associated_token::mint = wokusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wokusd_ata: Box<Account<'info, TokenAccount>>,

    /// Vault's OkuUSD token account
    #[account(
        mut,
        address = config.vault_okusd
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Dead shares ATA — only required on the first deposit (total_shares == 0).
    /// This is a wOkuUSD ATA owned by a known dead address (System Program)
    /// where MINIMUM_LIQUIDITY shares are permanently locked.
    #[account(mut)]
    pub dead_shares_ata: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL)
    #[account(
        mut,
        address = config.wokusd_mint
    )]
    pub wokusd_mint: Box<Account<'info, Mint>>,

    /// User's OkuUSD token account (must be pre-created by frontend)
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's wOkuUSD token account
    #[account(
        mut,
        associated_token::mint = wokusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wokusd_ata: Box<Account<'info, TokenAccount>>,

    /// Vault's OkuUSD token account
    #[account(
        mut,
        address = config.vault_okusd
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.pauser @ VaultError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.unpauser @ VaultError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// Role admin - only role_admin can update authorities
    #[account(
        constraint = role_admin.key() == config.role_admin @ VaultError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    /// Vault config
    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,
}
