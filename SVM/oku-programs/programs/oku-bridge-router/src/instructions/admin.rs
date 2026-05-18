//! OkuBridgeRouter admin instructions.
//!
//! Pause / unpause symmetry mirrors OpenZeppelin `Pausable`.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/Pausable.sol
//!
//! Role rotation via `set_authority` mirrors OpenZeppelin `AccessControl`.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol

use crate::contexts::{AcceptRoleAdmin, Pause, SetAuthority, Unpause};
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

/// Update a specific authority role.
///
/// Only `role_admin` can call this. Non-meta roles commit immediately;
/// `RoleAdmin` is two-step (propose + accept) — see `accept_role_admin`.
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

    if matches!(role, RouterAuthorityRole::RoleAdmin) {
        let current_admin = config.role_admin;
        config.pending_role_admin = new_authority;

        emit!(RoleAdminTransferProposedEvent {
            current_admin,
            pending_admin: new_authority,
        });
        return Ok(());
    }

    let old_authority = match role {
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
        RouterAuthorityRole::RoleAdmin => unreachable!("handled above"),
    };

    emit!(AuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}

/// Step 2 of the two-step `RoleAdmin` transfer.
pub fn accept_role_admin(ctx: Context<AcceptRoleAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_role_admin != Pubkey::default(),
        RouterError::NoPendingRoleAdmin
    );
    require!(
        ctx.accounts.new_role_admin.key() == config.pending_role_admin,
        RouterError::NotPendingRoleAdmin
    );

    let previous_admin = config.role_admin;
    let new_admin = config.pending_role_admin;

    config.role_admin = new_admin;
    config.pending_role_admin = Pubkey::default();

    emit!(RoleAdminTransferAcceptedEvent {
        previous_admin,
        new_admin,
    });
    emit!(AuthorityUpdatedEvent {
        role: RouterAuthorityRole::RoleAdmin,
        old_authority: previous_admin,
        new_authority: new_admin,
    });

    Ok(())
}

/// Withdraw an in-flight `RoleAdmin` two-step proposal (current admin only).
pub fn cancel_role_admin_transfer(ctx: Context<SetAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_role_admin != Pubkey::default(),
        RouterError::NoPendingRoleAdmin
    );

    let cancelled_pending = config.pending_role_admin;
    config.pending_role_admin = Pubkey::default();

    emit!(RoleAdminTransferCancelledEvent {
        current_admin: config.role_admin,
        cancelled_pending,
    });

    Ok(())
}
