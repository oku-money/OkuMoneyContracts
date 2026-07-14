use crate::errors::LitePsmError;
use crate::state::{PsmConfig, RedemptionQueue};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};
use oku_shared::TOKEN_DECIMALS;

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

    /// USDC mint (standard SPL).
    ///
    /// Must have exactly `TOKEN_DECIMALS` (= 6) decimals on Solana —
    /// this matches the `usdOku` decimal model. EVM resolves
    /// a runtime `usdcDecimalMultiplier` from `IERC20Metadata.decimals()`;
    /// SVM hardcodes the value via the shared constant and asserts at
    /// init.
    #[account(
        constraint = usdc_mint.decimals == TOKEN_DECIMALS @ LitePsmError::InvalidUsdcDecimals
    )]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Fresh keypair for the usdOku mint (Token-2022).
    ///
    /// The instruction creates this mint via manual CPIs with
    /// ScaledUiAmount + MetadataPointer + TokenMetadata extensions.
    /// The PsmConfig PDA is set as mint authority, freeze authority,
    /// and ScaledUiAmount authority. Passed as a `Signer` because
    /// `CreateAccount` requires the new account to sign.
    #[account(mut)]
    pub usd_oku_mint: Signer<'info>,

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
    /// `role_admin` is the only authority permitted to create the queue PDA.
    /// Without this gate, any signer could front-run the deployer and create
    /// the canonical-seeded `RedemptionQueue` PDA, forcing the legitimate
    /// `initialize` flow to fail with `AccountAlreadyInitialized` until the
    /// griefer's account is closed. Matches the authority model used by
    /// `SetupUsdOkuEscrow` below.
    #[account(mut)]
    pub role_admin: Signer<'info>,

    /// PSM config must exist (initialize was called).
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        init,
        payer = role_admin,
        space = RedemptionQueue::LEN,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    pub system_program: Program<'info, System>,
}

/// Accounts for setup_usd_oku_escrow instruction
/// Creates the usdOku escrow vault for queued redemptions
#[derive(Accounts)]
pub struct SetupUsdOkuEscrow<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// usdOku mint (Token-2022).
    /// Must match the mint stored in config during initialize, and must have
    /// the PSM config PDA as both mint and freeze authority.
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program,
        mint::authority = config,
        mint::freeze_authority = config,
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's usdOku escrow vault for queued redemptions.
    /// Holds raw usdOku while users are in queue.
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_usd_oku: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
