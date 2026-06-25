use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut)]
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
    #[account(mut)]
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
    #[account(mut)]
    pub cap_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = cap_manager @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuMoney mint — read so `set_max_supply` can refuse a new cap below
    /// the current circulating supply (would silently brick all future
    /// mints). EVM `OkuMoney.setMaxSupply` parity.
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program,
    )]
    pub oku_money_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct AllowanceManager<'info> {
    #[account(mut)]
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
pub struct OracleManager<'info> {
    #[account(mut)]
    pub oracle_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = oracle_manager @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// Optional pre-flight account for `set_oracle_relay_feed`. When
    /// `new_feed != Pubkey::default()` and this account is supplied, the
    /// handler parses the Pyth header and asserts the runtime invariants
    /// (`magic`, `version == 2`, `atype == Price`, owner,
    /// `|expo| <= MAX_FEED_EXPO_MAGNITUDE`) before persisting the new
    /// feed pubkey. Without the pre-flight check, an admin could silently
    /// configure a malformed feed that would only error at every
    /// subsequent mint / redeem / queue-process call. The other relay
    /// setters (`set_oracle_relay_staleness`, `_band`,
    /// `_pyth_program_owner`) ignore this account.
    /// CHECK: parsed defensively by `validate_oracle_relay_feed`; only
    /// required for the `set_oracle_relay_feed` path with a non-default
    /// feed pubkey.
    pub oracle_account: Option<UncheckedAccount<'info>>,
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

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Target account to freeze
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::token_program = token_2022_program,
    )]
    pub target_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Target account to thaw
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::token_program = token_2022_program,
    )]
    pub target_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
