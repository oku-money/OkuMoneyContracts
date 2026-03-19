use crate::errors::OkuDollarError;
use crate::state::OkuDollarConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

// Import PsmConfig from lite-psm for cross-program reads
use lite_psm::state::PsmConfig;

/// Initialize the OkuDollar vault
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = OkuDollarConfig::LEN,
        seeds = [OkuDollarConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    /// Mint authority must be the config PDA
    #[account(
        init,
        payer = role_admin,
        mint::decimals = oku_money_mint.decimals,
        mint::authority = config,
        mint::token_program = token_2022_program,
        seeds = [b"usd_oku_mint"],
        bump
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = oku_money_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    /// CHECK: Validated by address in handler - must match lite_psm's PsmConfig PDA
    pub psm_config: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Wrap OkuMoney into usdOku
#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        constraint = !config.is_paused @ OkuDollarError::VaultPaused
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney token account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku token account (init_if_needed)
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Account<'info, PsmConfig>,

    /// Dead shares ATA — only required on the first deposit (total_shares == 0).
    /// This is a usdOku ATA owned by a known dead address (System Program)
    /// where MINIMUM_LIQUIDITY shares are permanently locked.
    /// CHECK: Validated in handler when needed
    #[account(mut)]
    pub dead_shares_ata: Option<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Unwrap usdOku back to OkuMoney
#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        // Note: Unwrap blocked when paused (matches EVM behavior)
        constraint = !config.is_paused @ OkuDollarError::VaultPaused
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney token account (init_if_needed)
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku token account
    #[account(
        mut,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Account<'info, PsmConfig>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Update the USD multiplier (rebasing)
#[derive(Accounts)]
pub struct UpdateUsdMultiplier<'info> {
    #[account(
        constraint = usd_rebaser.key() == config.usd_rebaser @ OkuDollarError::Unauthorized
    )]
    pub usd_rebaser: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// Reserve vault to check collateralization
    #[account(
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// usdOku mint to check total supply
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM config account (for reading oku_m_price for collateral check)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Account<'info, PsmConfig>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Deposit reserves (reserve manager)
#[derive(Accounts)]
pub struct DepositReserves<'info> {
    #[account(
        constraint = reserve_manager.key() == config.reserve_manager @ OkuDollarError::Unauthorized
    )]
    pub reserve_manager: Signer<'info>,

    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Reserve manager's OkuMoney source account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = reserve_manager,
        associated_token::token_program = token_2022_program,
    )]
    pub source_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Withdraw reserves (reserve manager)
#[derive(Accounts)]
pub struct WithdrawReserves<'info> {
    #[account(
        constraint = reserve_manager.key() == config.reserve_manager @ OkuDollarError::Unauthorized
    )]
    pub reserve_manager: Signer<'info>,

    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Reserve manager's OkuMoney destination account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = reserve_manager,
        associated_token::token_program = token_2022_program,
    )]
    pub destination_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// usdOku mint to check total supply for collateral ratio
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM config account (for reading oku_m_price for collateral check)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Account<'info, PsmConfig>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Pause the vault (pauser only)
#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.pauser @ OkuDollarError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Unpause the vault (unpauser only)
#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.unpauser @ OkuDollarError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Set authority roles (role_admin only)
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(
        constraint = role_admin.key() == config.role_admin @ OkuDollarError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Set minimum collateral ratio (role_admin only)
#[derive(Accounts)]
pub struct SetMinCollateralRatio<'info> {
    #[account(
        constraint = role_admin.key() == config.role_admin @ OkuDollarError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}
