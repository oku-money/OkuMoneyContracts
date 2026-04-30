//! OkuDollar vault admin instructions.
//!
//! Pause / unpause semantics mirror OpenZeppelin's `Pausable` (already-paused
//! and not-paused checks symmetric on both ends).
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/Pausable.sol
//!
//! Role-rotation via `set_authority` mirrors OpenZeppelin's `AccessControl`.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol

use crate::constants::MIN_COLLATERAL_RATIO_FLOOR;
use crate::contexts::{Pause, SetAuthority, SetMinCollateralRatio, Unpause};
use crate::errors::OkuDollarError;
use crate::events::*;
use crate::roles::AuthorityRole;
use anchor_lang::prelude::*;

/// Pause the vault (emergency response)
/// Only pauser can call this function.
/// When paused, wrap and unwrap are both blocked (matches EVM behavior).
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.is_paused, OkuDollarError::AlreadyPaused);

    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
    });

    Ok(())
}

/// Unpause the vault (deliberate review required)
/// Only unpauser can call this function.
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.is_paused, OkuDollarError::NotPaused);

    config.is_paused = false;

    emit!(UnpauseEvent {
        unpauser: ctx.accounts.unpauser.key(),
    });

    Ok(())
}

/// Update a specific authority role
/// Only role_admin can call this function.
pub fn set_authority(
    ctx: Context<SetAuthority>,
    role: AuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        OkuDollarError::InvalidAuthority
    );

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
        AuthorityRole::UsdRebaser => {
            let old = config.usd_rebaser;
            config.usd_rebaser = new_authority;
            old
        }
        AuthorityRole::ReserveManager => {
            let old = config.reserve_manager;
            config.reserve_manager = new_authority;
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

/// Set the minimum collateral ratio
/// Only role_admin can call this function.
/// The ratio must be at least MIN_COLLATERAL_RATIO_FLOOR (90%).
pub fn set_min_collateral_ratio(
    ctx: Context<SetMinCollateralRatio>,
    new_min_collateral_ratio: u64,
) -> Result<()> {
    require!(
        new_min_collateral_ratio >= MIN_COLLATERAL_RATIO_FLOOR,
        OkuDollarError::InvalidCollateralRatio
    );

    let config = &mut ctx.accounts.config;
    let old_ratio = config.min_collateral_ratio;
    config.min_collateral_ratio = new_min_collateral_ratio;

    emit!(MinCollateralRatioUpdatedEvent {
        old_ratio,
        new_ratio: new_min_collateral_ratio,
    });

    Ok(())
}
