use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use crate::contexts::{
    Pause, Unpause, CapManager, AllowanceManager, OracleManager,
    FreezeAccount, ThawAccount, SetAuthority,
};
use crate::errors::OkuError;
use crate::events::*;
use crate::roles::AuthorityRole;
use crate::state::PsmConfig;

/// Pause the PSM (emergency response)
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
        paused: true,
    });

    Ok(())
}

/// Unpause the PSM (deliberate review required)
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.is_paused = false;

    emit!(UnpauseEvent {
        unpauser: ctx.accounts.unpauser.key(),
    });

    Ok(())
}

/// Update max supply (cap_manager only)
pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.max_supply = new_max_supply;

    emit!(MaxSupplyUpdatedEvent {
        role_admin: ctx.accounts.cap_manager.key(),
        new_max_supply,
    });

    Ok(())
}

/// Reset minter allowance (allowance_manager only)
pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.minter_allowance = amount;

    emit!(MinterAllowanceUpdatedEvent {
        role_admin: ctx.accounts.allowance_manager.key(),
        new_allowance: amount,
    });

    Ok(())
}

/// Update oracle config (oracle_manager only)
pub fn set_oracle(
    ctx: Context<OracleManager>,
    oracle: Pubkey,
    staleness_threshold: i64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.oracle = oracle;
    config.staleness_threshold = staleness_threshold;

    emit!(OracleUpdatedEvent {
        role_admin: ctx.accounts.oracle_manager.key(),
        oracle,
        staleness_threshold,
    });

    Ok(())
}

/// Freeze an OkuUSD token account (compliance/blacklist)
/// Uses Token-2022 freeze authority CPI
/// MUST work even when PSM is paused (no pause check)
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // CPI to Token-2022 to freeze the account
    token_interface::freeze_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_interface::FreezeAccount {
                account: ctx.accounts.target_okusd_ata.to_account_info(),
                mint: ctx.accounts.okusd_mint.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
    )?;

    emit!(FreezeEvent {
        account: ctx.accounts.target_okusd_ata.key(),
        target_owner: ctx.accounts.target_okusd_ata.owner,
    });

    Ok(())
}

/// Thaw a frozen OkuUSD token account
/// Uses Token-2022 thaw authority CPI
/// MUST work even when PSM is paused (no pause check)
pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
    let bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // CPI to Token-2022 to thaw the account
    token_interface::thaw_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_interface::ThawAccount {
                account: ctx.accounts.target_okusd_ata.to_account_info(),
                mint: ctx.accounts.okusd_mint.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
    )?;

    emit!(ThawEvent {
        account: ctx.accounts.target_okusd_ata.key(),
        target_owner: ctx.accounts.target_okusd_ata.owner,
    });

    Ok(())
}

/// Update a specific authority role
/// Only role_admin can call this function
pub fn set_authority(
    ctx: Context<SetAuthority>,
    role: AuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    require!(new_authority != Pubkey::default(), OkuError::Unauthorized);

    let config = &mut ctx.accounts.config;
    let old_authority = match role {
        AuthorityRole::RoleAdmin => {
            let old = config.role_admin;
            config.role_admin = new_authority;
            old
        }
        AuthorityRole::Pauser => {
            let old = config.pauser;
            config.pauser = new_authority;
            old
        }
        AuthorityRole::Unpauser => {
            let old = config.unpauser;
            config.unpauser = new_authority;
            old
        }
        AuthorityRole::Freezer => {
            let old = config.freezer;
            config.freezer = new_authority;
            old
        }
        AuthorityRole::Unfreezer => {
            let old = config.unfreezer;
            config.unfreezer = new_authority;
            old
        }
        AuthorityRole::QueueProcessor => {
            let old = config.queue_processor;
            config.queue_processor = new_authority;
            old
        }
        AuthorityRole::BufferDepositor => {
            let old = config.buffer_depositor;
            config.buffer_depositor = new_authority;
            old
        }
        AuthorityRole::BufferWithdrawer => {
            let old = config.buffer_withdrawer;
            config.buffer_withdrawer = new_authority;
            old
        }
        AuthorityRole::OracleManager => {
            let old = config.oracle_manager;
            config.oracle_manager = new_authority;
            old
        }
        AuthorityRole::CapManager => {
            let old = config.cap_manager;
            config.cap_manager = new_authority;
            old
        }
        AuthorityRole::AllowanceManager => {
            let old = config.allowance_manager;
            config.allowance_manager = new_authority;
            old
        }
        AuthorityRole::Rebaser => {
            let old = config.rebaser;
            config.rebaser = new_authority;
            old
        }
    };

    emit!(AuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}
