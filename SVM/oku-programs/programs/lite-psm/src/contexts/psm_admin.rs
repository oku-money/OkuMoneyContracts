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

    /// OkuM mint -- read so `set_max_supply` can refuse a new cap below
    /// the current circulating supply (would silently brick all future
    /// mints). EVM `OkuM.setMaxSupply` parity.
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
    /// Blacklister authority - can freeze even when PSM is paused
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

    /// Target account to freeze
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
    /// Unblacklister authority - can thaw even when PSM is paused (requires deliberate review)
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
    /// Role admin - only role_admin can update authorities
    pub role_admin: Signer<'info>,

    /// PSM config
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// Update the OkuM mint's Token-2022 `TokenMetadata` `name`/`symbol`
/// in place on an already-deployed mint.
///
/// This rewrites the TRUE on-chain identity (OkuM / "OkuMoney") that
/// wallets and block explorers display for the mint and its transfers.
/// It does NOT touch the ScaledUiAmount multiplier, so the "$1-pegged
/// usdOku" display value is unaffected.
///
/// Authority model mirrors `SetAuthority`: only `role_admin` (the
/// most-privileged config-level admin) may rename the token. The actual
/// Token-2022 metadata `update_authority` is the `config` PDA, which
/// signs the CPI via `invoke_signed` in the handler.
#[derive(Accounts)]
pub struct UpdateTokenMetadata<'info> {
    /// Role admin — only `role_admin` may rename the token.
    pub role_admin: Signer<'info>,

    /// PSM config PDA. Holds the Token-2022 metadata `update_authority`
    /// for the mint and CPI-signs the `update_field` calls.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuM mint (Token-2022). The metadata is stored on the mint itself
    /// (metadata-pointer points to self), so this is the `mut` metadata
    /// account passed to `update_field`.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program,
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Step 2 of the two-step `role_admin` transfer.
///
/// Signed by the proposed `pending_role_admin` (NOT the current
/// `role_admin`). Anchor cannot express "signer matches a field that may
/// be the zero pubkey" cleanly via `has_one`, so the runtime check lives
/// in the handler (`accept_role_admin`).
#[derive(Accounts)]
pub struct AcceptRoleAdmin<'info> {
    /// The proposed new role admin — must match `config.pending_role_admin`.
    pub new_role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,
}
