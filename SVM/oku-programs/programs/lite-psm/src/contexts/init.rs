use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
};
use oku_shared::USDC_DECIMALS;

/// This program's ProgramData PDA: `[program_id]` under the BPF upgradeable
/// loader. Computed rather than trusted from the caller, so `program_data`
/// cannot be pointed at some OTHER program's account that happens to name the
/// caller as its upgrade authority.
fn program_data_address() -> Pubkey {
    anchor_lang::solana_program::bpf_loader_upgradeable::get_program_data_address(&crate::ID)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Becomes `config.role_admin` — the permanent root authority.
    ///
    /// MUST be the program's BPF upgrade authority (see `program_data`
    /// below). Without that tie this instruction is a land-grab: `config` is
    /// a singleton PDA at `["psm_config"]`, deploy and initialize are
    /// necessarily separate transactions, and whoever lands `initialize`
    /// first becomes `role_admin` permanently AND chooses `usdc_mint` — for
    /// which only the decimal count is validated, so an attacker-controlled
    /// fake mint passes. There is no `close_config` and no re-init, so the
    /// program ID would be unrecoverable.
    #[account(mut)]
    pub role_admin: Signer<'info>,

    /// The program's own ProgramData account, used only to prove
    /// `role_admin` is the upgrade authority.
    ///
    /// Checked against the upgrade authority rather than a hardcoded
    /// `const DEPLOY_AUTHORITY`, so the binary is identical across devnet and
    /// mainnet. Anyone passing this check could already replace the whole
    /// program via `bpf_loader_upgradeable::Upgrade`, so it grants no new
    /// authority — it just stops anyone ELSE claiming the config.
    ///
    /// `Account<'info, ProgramData>` enforces `owner == BPFLoaderUpgradeable`
    /// and the discriminant; `address =` pins it to THIS program's ProgramData
    /// PDA, so another program's account cannot be substituted.
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

    /// USDC mint (standard SPL).
    ///
    /// Must have exactly `USDC_DECIMALS` (= 6, the canonical USDC mint) decimals.
    /// EVM resolves a runtime `usdcDecimalMultiplier` from
    /// `IERC20Metadata.decimals()`; SVM hardcodes it and asserts at init.
    #[account(
        constraint = usdc_mint.decimals == USDC_DECIMALS @ LitePsmError::InvalidUsdcDecimals
    )]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// Fresh keypair for the OkuM mint (Token-2022).
    ///
    /// Created via manual CPIs with ScaledUiAmount + MetadataPointer +
    /// TokenMetadata extensions; the PsmConfig PDA becomes mint, freeze, and
    /// ScaledUiAmount authority. A `Signer` because `CreateAccount` requires
    /// the new account to sign.
    #[account(mut)]
    pub oku_m_mint: Signer<'info>,

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
