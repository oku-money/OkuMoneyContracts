use anchor_lang::prelude::*;
use crate::contexts::{Pause, Unpause, SetAuthority};
use crate::errors::VaultError;
use crate::events::*;
use crate::roles::AuthorityRole;

/// Pause the vault (emergency response)
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
        paused: true,
    });

    Ok(())
}

/// Unpause the vault (deliberate review required)
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
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
    role: AuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    require!(new_authority != Pubkey::default(), VaultError::Unauthorized);

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
    };

    emit!(AuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}
