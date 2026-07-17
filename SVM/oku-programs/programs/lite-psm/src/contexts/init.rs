use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
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
