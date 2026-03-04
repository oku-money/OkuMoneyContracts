use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Token, TokenAccount, Mint},
    token_2022::Token2022,
    token_interface::{TokenAccount as TokenAccountInterface, Mint as MintInterface},
};
use crate::errors::RouterError;
use crate::state::RouterConfig;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = RouterConfig::LEN,
        seeds = [RouterConfig::SEED],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BridgeWrapped<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    // Vault program accounts
    /// CHECK: Vault config PDA - validated by vault program CPI
    #[account(mut)]
    pub vault_config: UncheckedAccount<'info>,

    /// OkuUSD mint (Token-2022)
    #[account(mut)]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL)
    #[account(mut)]
    pub wokusd_mint: Account<'info, Mint>,

    /// User's OkuUSD account
    #[account(mut)]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's wOkuUSD account
    #[account(mut)]
    pub user_wokusd_ata: Account<'info, TokenAccount>,

    /// Vault's OkuUSD account
    #[account(mut)]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    // PSM program accounts
    /// CHECK: Bridge config PDA - validated by PSM program CPI
    pub bridge_config: UncheckedAccount<'info>,

    /// CHECK: PSM config PDA - validated by PSM program CPI
    pub psm_config: UncheckedAccount<'info>,

    /// CHECK: Bridge nonce PDA - validated by PSM program CPI
    #[account(mut)]
    pub bridge_nonce: UncheckedAccount<'info>,

    /// CHECK: Fee recipient ATA - validated by PSM program CPI
    #[account(mut)]
    pub fee_recipient_ata: UncheckedAccount<'info>,

    /// CHECK: Vault program — hardcoded to wokusd_vault::ID
    #[account(address = wokusd_vault::ID)]
    pub vault_program: UncheckedAccount<'info>,

    /// CHECK: PSM program — hardcoded to lite_psm::ID
    #[account(address = lite_psm::ID)]
    pub psm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.pauser @ RouterError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.unpauser @ RouterError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// Role admin - only role_admin can update authorities
    #[account(
        constraint = role_admin.key() == config.role_admin @ RouterError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    /// Router config
    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,
}
