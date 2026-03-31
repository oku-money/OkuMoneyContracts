use crate::contexts::{Pause, SetAuthority, Unpause};
use crate::errors::RouterError;
use crate::events::*;
use crate::roles::RouterAuthorityRole;
use anchor_lang::prelude::*;

/// Pause the router (emergency response)
/// Reverts if already paused (matches OZ Pausable behavior)
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Prevent redundant pause (matches OZ Pausable)
    require!(!config.is_paused, RouterError::AlreadyPaused);

    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
        paused: true,
    });

    Ok(())
}

/// Unpause the router (deliberate review required)
/// Reverts if not paused (matches OZ Pausable behavior)
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Prevent redundant unpause (matches OZ Pausable)
    require!(config.is_paused, RouterError::NotPaused);

    config.is_paused = false;

    emit!(UnpauseEvent {
        unpauser: ctx.accounts.unpauser.key(),
    });

    Ok(())
}

/// Update a specific authority role
/// Only role_admin can call this function
pub fn set_authority(
    ctx: Context<SetAuthority>,
    role: RouterAuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    // Reject zero address to prevent accidental lockout
    require!(
        new_authority != Pubkey::default(),
        RouterError::InvalidAuthority
    );

    let config = &mut ctx.accounts.config;
    let old_authority = match role {
        RouterAuthorityRole::RoleAdmin => {
            let old = config.role_admin;
            config.role_admin = new_authority;
            old
        }
        RouterAuthorityRole::Pauser => {
            let old = config.pauser;
            config.pauser = new_authority;
            old
        }
        RouterAuthorityRole::Unpauser => {
            let old = config.unpauser;
            config.unpauser = new_authority;
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
