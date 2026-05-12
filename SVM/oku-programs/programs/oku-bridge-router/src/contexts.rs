use crate::errors::RouterError;
use crate::state::RouterConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
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

    /// OkuMoney mint (Token-2022) - stored in config for validation
    #[account(mint::token_program = token_2022_program)]
    pub oku_money_mint: InterfaceAccount<'info, MintInterface>,

    /// usdOku mint (Token-2022) - stored in config for validation
    #[account(mint::token_program = token_2022_program)]
    pub usd_oku_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
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

    /// OkuMoney mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.oku_money_mint
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.usd_oku_mint
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = oku_money_mint
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = usd_oku_mint
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(mut)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    // PSM program accounts
    /// CHECK: Bridge config PDA - validated by PSM program CPI
    pub bridge_config: UncheckedAccount<'info>,

    /// CHECK: PSM config PDA - used by both vault (for oku_m_price) and PSM (as config)
    /// Single account passed to both CPIs to avoid duplication
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

    /// OkuMoney mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.oku_money_mint
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = oku_money_mint
    )]
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

/// Mint usdOku from USDC in one transaction
/// 1. PSM mint_oku_m: USDC -> OkuMoney
/// 2. Vault wrap: OkuMoney -> usdOku
#[derive(Accounts)]
pub struct MintUsdOku<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    // --- PSM mint_oku_m accounts ---
    /// CHECK: PSM config PDA - validated by PSM CPI (also used by vault wrap as psm_config)
    #[account(mut)]
    pub psm_config: UncheckedAccount<'info>,

    /// CHECK: USDC mint - validated by PSM CPI
    pub usdc_mint: UncheckedAccount<'info>,

    /// OkuMoney mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.oku_money_mint
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// CHECK: User's USDC account - validated by PSM CPI
    #[account(mut)]
    pub user_usdc_ata: UncheckedAccount<'info>,

    /// User's OkuMoney account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = oku_money_mint
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// CHECK: PSM's USDC vault - validated by PSM CPI
    #[account(mut)]
    pub vault_usdc: UncheckedAccount<'info>,

    /// CHECK: Pyth price account (optional for PSM oracle)
    pub price_update: Option<UncheckedAccount<'info>>,

    // --- Vault wrap accounts ---
    /// CHECK: OkuDollar vault config PDA - validated by vault CPI
    #[account(mut)]
    pub vault_config: UncheckedAccount<'info>,

    /// usdOku mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.usd_oku_mint
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's usdOku account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = usd_oku_mint
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(mut)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Dead shares ATA (optional, only needed on first vault deposit)
    /// CHECK: Validated by vault CPI when needed
    #[account(mut)]
    pub dead_shares_ata: Option<InterfaceAccount<'info, TokenAccountInterface>>,

    // --- Programs ---
    /// CHECK: Vault program — hardcoded to oku_dollar::ID
    #[account(address = oku_dollar::ID)]
    pub vault_program: UncheckedAccount<'info>,

    /// CHECK: PSM program — hardcoded to lite_psm::ID
    #[account(address = lite_psm::ID)]
    pub psm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Redeem usdOku to USDC in one transaction
/// 1. Vault unwrap: usdOku -> OkuMoney
/// 2. PSM redeem_oku_m: OkuMoney -> USDC (instant or queued)
#[derive(Accounts)]
pub struct RedeemUsdOku<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    // --- Vault unwrap accounts ---
    /// CHECK: OkuDollar vault config PDA - validated by vault CPI
    #[account(mut)]
    pub vault_config: UncheckedAccount<'info>,

    /// OkuMoney mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.oku_money_mint
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022) - validated against stored config
    #[account(
        mut,
        address = config.usd_oku_mint
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = oku_money_mint
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku account - validated to belong to user (defense-in-depth)
    #[account(
        mut,
        token::authority = user,
        token::mint = usd_oku_mint
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(mut)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// CHECK: PSM config PDA - shared: vault reads oku_m_price, PSM uses as config
    #[account(mut)]
    pub psm_config: UncheckedAccount<'info>,

    // --- PSM redeem_oku_m accounts ---
    /// CHECK: Redemption queue PDA - validated by PSM CPI
    #[account(mut)]
    pub redemption_queue: UncheckedAccount<'info>,

    /// CHECK: USDC mint - validated by PSM CPI
    pub usdc_mint: UncheckedAccount<'info>,

    /// CHECK: User's USDC account - validated by PSM CPI
    #[account(mut)]
    pub user_usdc_ata: UncheckedAccount<'info>,

    /// CHECK: PSM's USDC vault - validated by PSM CPI
    #[account(mut)]
    pub vault_usdc: UncheckedAccount<'info>,

    /// CHECK: PSM's OkuMoney escrow vault - validated by PSM CPI
    #[account(mut)]
    pub vault_oku_money: UncheckedAccount<'info>,

    // --- Programs ---
    /// CHECK: Vault program — hardcoded to oku_dollar::ID
    #[account(address = oku_dollar::ID)]
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
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump,
        has_one = pauser @ RouterError::Unauthorized
    )]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump,
        has_one = unpauser @ RouterError::Unauthorized
    )]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// Role admin - only role_admin can update authorities
    pub role_admin: Signer<'info>,

    /// Router config
    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ RouterError::Unauthorized
    )]
    pub config: Account<'info, RouterConfig>,
}
