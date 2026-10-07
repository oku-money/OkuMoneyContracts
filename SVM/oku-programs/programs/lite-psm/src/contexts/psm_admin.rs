use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

#[derive(Accounts)]
pub struct Pause<'info> {
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = pauser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = unpauser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct CapManager<'info> {
    pub cap_manager: Signer<'info>,

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

#[derive(Accounts)]
pub struct AllowanceManager<'info> {
    pub allowance_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = allowance_manager @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// Works while paused.
    pub freezer: Signer<'info>,

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

#[derive(Accounts)]
pub struct ThawAccount<'info> {
    /// Works while paused.
    pub unfreezer: Signer<'info>,

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

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct UpdateTokenMetadata<'info> {
    pub role_admin: Signer<'info>,

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

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,
}
