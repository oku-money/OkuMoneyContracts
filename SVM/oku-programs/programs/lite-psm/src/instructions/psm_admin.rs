//! LitePSM admin instructions (pause, freeze, thaw, role admin, etc.).
//!
//! Pause / unpause and the role-rotation match arms mirror OpenZeppelin's
//! `Pausable` and `AccessControl` patterns.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/Pausable.sol
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol
//!
//! Freeze / thaw against a blacklist-exempt list (bridge + router PDAs cannot
//! be frozen) mirrors Circle FiatToken's blacklister/exempted-address pattern.
//! Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol

use crate::constants::{ORACLE_MAX_STALENESS_SECS, ORACLE_MIN_STALENESS_SECS};
use crate::contexts::{
    AllowanceManager, CapManager, FreezeAccount, InitializeBlacklistExempt, OracleManager, Pause,
    SetAuthority, ThawAccount, Unpause,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::roles::AuthorityRole;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Pause the PSM (emergency response)
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.is_paused, LitePsmError::AlreadyPaused);
    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
    });

    Ok(())
}

/// Unpause the PSM (deliberate review required)
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.is_paused, LitePsmError::NotPaused);
    config.is_paused = false;

    emit!(UnpauseEvent {
        unpauser: ctx.accounts.unpauser.key(),
    });

    Ok(())
}

/// Update max supply (cap_manager only).
///
/// Refuses any new cap below the current circulating supply — that would
/// silently brick every subsequent `mint_oku_m` and `bridge_mint` because
/// both check `current_supply + amount <= max_supply` and `add(0) > cap`
/// is true on a starting state of `current_supply > cap`. Mirrors EVM
/// `OkuMoney.setMaxSupply`'s `BelowCurrentSupply` revert.
pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()> {
    let current_supply = ctx.accounts.oku_money_mint.supply;
    require!(
        new_max_supply >= current_supply,
        LitePsmError::BelowCurrentSupply
    );

    let config = &mut ctx.accounts.config;
    let old_max_supply = config.max_supply;
    config.max_supply = new_max_supply;

    emit!(MaxSupplyUpdatedEvent {
        actor: ctx.accounts.cap_manager.key(),
        old_max_supply,
        new_max_supply,
    });

    Ok(())
}

/// Reset minter allowance (allowance_manager only)
pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_allowance = config.minter_allowance;
    config.minter_allowance = amount;

    emit!(MinterAllowanceUpdatedEvent {
        actor: ctx.accounts.allowance_manager.key(),
        old_allowance,
        new_allowance: amount,
    });

    Ok(())
}

/// Update oracle config (oracle_manager only).
///
/// `oracle == Pubkey::default()` is allowed and disables oracle checks
/// entirely (matches the existing `oracle != default` branch in `mint_oku_m`).
/// `staleness_threshold` must lie in `[ORACLE_MIN_STALENESS_SECS,
/// ORACLE_MAX_STALENESS_SECS]` whenever an oracle is configured. Mirrors EVM
/// `LitePSM.setOracle` bounds.
pub fn set_oracle(
    ctx: Context<OracleManager>,
    oracle: Pubkey,
    staleness_threshold: i64,
) -> Result<()> {
    if oracle != Pubkey::default() {
        require!(
            staleness_threshold >= ORACLE_MIN_STALENESS_SECS
                && staleness_threshold <= ORACLE_MAX_STALENESS_SECS,
            LitePsmError::InvalidStaleness
        );
    }

    let config = &mut ctx.accounts.config;
    config.oracle = oracle;
    config.staleness_threshold = staleness_threshold;

    emit!(OracleUpdatedEvent {
        actor: ctx.accounts.oracle_manager.key(),
        oracle,
        staleness_threshold,
    });

    Ok(())
}

/// Rotate the accepted Pyth program owner pubkey (oracle_manager only).
///
/// Lets the protocol migrate between Pyth deployments (e.g. legacy Pyth V2 →
/// Pyth Solana Receiver) without redeploying the program. Rejects the zero
/// pubkey since `Pubkey::default()` would silently disable the owner check.
pub fn set_pyth_program_owner(
    ctx: Context<OracleManager>,
    new_pyth_program_owner: Pubkey,
) -> Result<()> {
    require!(
        new_pyth_program_owner != Pubkey::default(),
        LitePsmError::InvalidPythProgramOwner
    );

    let config = &mut ctx.accounts.config;
    let old_pyth_program_owner = config.pyth_program_owner;
    config.pyth_program_owner = new_pyth_program_owner;

    emit!(PythProgramOwnerUpdatedEvent {
        actor: ctx.accounts.oracle_manager.key(),
        old_pyth_program_owner,
        new_pyth_program_owner,
    });

    Ok(())
}

/// Freeze an OkuMoney token account (compliance/blacklist)
/// Uses Token-2022 freeze authority CPI
/// MUST work even when PSM is paused (no pause check)
/// Cannot freeze blacklist-exempt addresses (bridge, router)
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let target_owner = ctx.accounts.target_oku_money_ata.owner;

    // Check blacklist exemption
    require!(
        target_owner != config.blacklist_exempt_bridge
            && target_owner != config.blacklist_exempt_router,
        LitePsmError::BlacklistExempt
    );

    let bump = config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // CPI to Token-2022 to freeze the account
    token_interface::freeze_account(CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.key(),
        token_interface::FreezeAccount {
            account: ctx.accounts.target_oku_money_ata.to_account_info(),
            mint: ctx.accounts.oku_money_mint.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        signer,
    ))?;

    emit!(FreezeEvent {
        account: ctx.accounts.target_oku_money_ata.key(),
        target_owner,
    });

    Ok(())
}

/// Thaw a frozen OkuMoney token account
/// Uses Token-2022 thaw authority CPI
/// MUST work even when PSM is paused (no pause check)
pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
    let bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // CPI to Token-2022 to thaw the account
    token_interface::thaw_account(CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.key(),
        token_interface::ThawAccount {
            account: ctx.accounts.target_oku_money_ata.to_account_info(),
            mint: ctx.accounts.oku_money_mint.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        signer,
    ))?;

    emit!(ThawEvent {
        account: ctx.accounts.target_oku_money_ata.key(),
        target_owner: ctx.accounts.target_oku_money_ata.owner,
    });

    Ok(())
}

/// Initialize blacklist exemption for bridge and router addresses.
/// One-time admin call — cannot be changed after set.
///
/// Both pubkeys must be non-default. Allowing `Pubkey::default()` would lock
/// the exemption slot into uselessness (no real account can ever match) yet
/// the one-shot guard would still fire on a re-call.
pub fn initialize_blacklist_exempt(
    ctx: Context<InitializeBlacklistExempt>,
    bridge: Pubkey,
    router: Pubkey,
) -> Result<()> {
    require!(
        bridge != Pubkey::default(),
        LitePsmError::InvalidBlacklistExemptAddress
    );
    require!(
        router != Pubkey::default(),
        LitePsmError::InvalidBlacklistExemptAddress
    );

    let config = &mut ctx.accounts.config;

    // Ensure not already initialized
    require!(
        config.blacklist_exempt_bridge == Pubkey::default()
            && config.blacklist_exempt_router == Pubkey::default(),
        LitePsmError::BlacklistExemptAlreadyInitialized
    );

    config.blacklist_exempt_bridge = bridge;
    config.blacklist_exempt_router = router;

    emit!(BlacklistExemptInitialized { bridge, router });

    Ok(())
}

/// Update a specific authority role
/// Only role_admin can call this function
pub fn set_authority(
    ctx: Context<SetAuthority>,
    role: AuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    // Reject zero address to prevent accidental lockout
    require!(
        new_authority != Pubkey::default(),
        LitePsmError::InvalidAuthority
    );

    let config = &mut ctx.accounts.config;

    // Swap-in the new authority and return the old value. Each arm is
    // structurally identical (`let old = config.X; config.X = new;
    // old`), so we use a one-line macro to dispatch on the role enum
    // and collapse the 12-arm match. Behavior is byte-for-byte
    // identical to the previous open-coded version.
    macro_rules! rotate_role {
        ( $( $variant:ident => $field:ident ),+ $(,)? ) => {
            match role {
                $(
                    AuthorityRole::$variant => {
                        let old = config.$field;
                        config.$field = new_authority;
                        old
                    }
                ),+
            }
        };
    }
    let old_authority = rotate_role! {
        RoleAdmin         => role_admin,
        Pauser            => pauser,
        Unpauser          => unpauser,
        Freezer           => freezer,
        Unfreezer         => unfreezer,
        QueueProcessor    => queue_processor,
        BufferDepositor   => buffer_depositor,
        BufferWithdrawer  => buffer_withdrawer,
        OracleManager     => oracle_manager,
        CapManager        => cap_manager,
        AllowanceManager  => allowance_manager,
        Rebaser           => rebaser,
    };

    emit!(AuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}
