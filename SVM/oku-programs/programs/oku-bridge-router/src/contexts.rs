use crate::errors::RouterError;
use crate::state::RouterConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
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
        space = RouterConfig::LEN,
        seeds = [RouterConfig::SEED],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    pub system_program: Program<'info, System>,
}

/// Bridge usdOku cross-chain in one transaction
/// 1. Unwraps usdOku -> OkuMoney via oku-dollar vault
/// 2. Burns OkuMoney via PSM bridge_burn
#[derive(Accounts)]
pub struct BridgeUsdOku<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    // OkuDollar vault program accounts
    /// CHECK: OkuDollar config PDA - validated by vault program CPI
    #[account(mut)]
    pub vault_config: UncheckedAccount<'info>,

    /// OkuMoney mint (Token-2022)
    #[account(mut)]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    #[account(mut)]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney account
    #[account(mut)]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku account
    #[account(mut)]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(mut)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// CHECK: PSM config account - needed by vault for reading oku_m_price
    pub vault_psm_config: UncheckedAccount<'info>,

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

    /// CHECK: Vault program — hardcoded to oku_dollar::ID
    #[account(address = oku_dollar::ID)]
    pub vault_program: UncheckedAccount<'info>,

    /// CHECK: PSM program — hardcoded to lite_psm::ID
    #[account(address = lite_psm::ID)]
    pub psm_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Bridge OkuMoney directly cross-chain (no unwrap needed)
/// Calls PSM bridge_burn directly
#[derive(Accounts)]
pub struct BridgeOkuM<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// OkuMoney mint (Token-2022)
    #[account(mut)]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney account
    #[account(mut)]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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

    /// CHECK: PSM program — hardcoded to lite_psm::ID
    #[account(address = lite_psm::ID)]
    pub psm_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
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
