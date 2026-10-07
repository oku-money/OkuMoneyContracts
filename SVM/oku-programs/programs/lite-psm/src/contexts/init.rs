use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
};
use oku_shared::USDC_DECIMALS;

/// This program's ProgramData PDA, computed so the caller cannot substitute
/// another program's account that names them as upgrade authority.
fn program_data_address() -> Pubkey {
    anchor_lang::solana_program::bpf_loader_upgradeable::get_program_data_address(&crate::ID)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Becomes `config.role_admin`. Must be the program's upgrade authority
    /// (see `program_data`). Otherwise `initialize` is a land-grab: `config` is a
    /// singleton PDA, deploy and initialize are separate transactions, and
    /// whoever lands first becomes `role_admin` permanently and picks `usdc_mint`
    /// (only its decimals are validated). There is no re-init, so the program ID
    /// would be unrecoverable.
    #[account(mut)]
    pub role_admin: Signer<'info>,

    /// This program's ProgramData, proving `role_admin` is the upgrade authority.
    /// Checked at runtime rather than a hardcoded key, so one binary serves every
    /// cluster; passing it grants nothing the upgrade authority lacks.
    #[account(
        address = program_data_address() @ LitePsmError::Unauthorized,
        constraint = program_data.upgrade_authority_address == Some(role_admin.key())
            @ LitePsmError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,

    #[account(
        init,
        payer = role_admin,
        space = PsmConfig::LEN,
        seeds = [PsmConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint (standard SPL); must have `USDC_DECIMALS` decimals.
    #[account(
        constraint = usdc_mint.decimals == USDC_DECIMALS @ LitePsmError::InvalidUsdcDecimals
    )]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Fresh keypair for the OkuM mint, created in the handler (`CreateAccount`
    /// needs the new account to sign).
    #[account(mut)]
    pub oku_m_mint: Signer<'info>,

    /// PSM's USDC vault (ATA of `config`).
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
