//! Accounts for the admin instructions. Several structs are named after the
//! role they check rather than the instruction, because more than one
//! instruction shares them (noted on each).

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

/// Accounts for `pause`: the pauser flips the config's pause flag.
#[derive(Accounts)]
pub struct Pause<'info> {
    /// The configured `pauser`.
    pub pauser: Signer<'info>,

    /// The singleton config PDA (writable: the pause flag).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = pauser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// Accounts for `unpause`.
#[derive(Accounts)]
pub struct Unpause<'info> {
    /// The configured `unpauser`.
    pub unpauser: Signer<'info>,

    /// The singleton config PDA (writable: the pause flag).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = unpauser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// Accounts for `set_max_supply`, checked against the `cap_manager` role.
#[derive(Accounts)]
pub struct CapManager<'info> {
    /// The configured `cap_manager`.
    pub cap_manager: Signer<'info>,

    /// The singleton config PDA (writable: `max_supply`).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = cap_manager @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuM mint, read so `set_max_supply` can refuse a cap below current supply.
    #[account(
        address = config.oku_m_mint,
        mint::token_program = token_2022_program,
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Accounts shared by `set_minter_allowance`, `set_direct_minter_allowance` and
/// `set_direct_burner_allowance`, checked against the `allowance_manager` role.
#[derive(Accounts)]
pub struct AllowanceManager<'info> {
    /// The configured `allowance_manager`.
    pub allowance_manager: Signer<'info>,

    /// The singleton config PDA (writable: the allowances).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = allowance_manager @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// Accounts for `freeze_account`. The config PDA is the mint's freeze authority.
#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// Works while paused.
    pub freezer: Signer<'info>,

    /// The singleton config PDA; read-only here. Signs the freeze as freeze authority.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = freezer @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuM mint (Token-2022)
    #[account(
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Token account to freeze
    #[account(
        mut,
        token::mint = oku_m_mint,
        token::token_program = token_2022_program,
    )]
    pub target_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Accounts for `thaw_account`. The config PDA is the mint's freeze authority.
#[derive(Accounts)]
pub struct ThawAccount<'info> {
    /// Works while paused.
    pub unfreezer: Signer<'info>,

    /// The singleton config PDA; read-only here. Signs the thaw as freeze authority.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = unfreezer @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuM mint (Token-2022)
    #[account(
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Target account to thaw
    #[account(
        mut,
        token::mint = oku_m_mint,
        token::token_program = token_2022_program,
    )]
    pub target_oku_m_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Accounts shared by `set_authority` and `cancel_role_admin_transfer`; the
/// signer must be the current `role_admin`.
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// The current `role_admin`.
    pub role_admin: Signer<'info>,

    /// The singleton config PDA (writable: role keys / `pending_role_admin`).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// Accounts for `update_token_metadata`. The config PDA is the metadata update
/// authority.
#[derive(Accounts)]
pub struct UpdateTokenMetadata<'info> {
    /// The current `role_admin`.
    pub role_admin: Signer<'info>,

    /// The singleton config PDA; read-only here. Signs as metadata update authority.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuM mint (Token-2022); also the metadata account, since the pointer
    /// targets the mint itself.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program,
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// The signer is the proposed admin, not the current one. The match against
/// `pending_role_admin` is checked in the handler (it may be the zero pubkey).
#[derive(Accounts)]
pub struct AcceptRoleAdmin<'info> {
    /// Must match `config.pending_role_admin`.
    pub new_role_admin: Signer<'info>,

    /// The singleton config PDA (writable: `role_admin`, `pending_role_admin`).
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,
}
