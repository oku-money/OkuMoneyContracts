//! OkuDollar vault admin instructions.
//!
//! Pause / unpause semantics mirror OpenZeppelin's `Pausable` (already-paused
//! and not-paused checks symmetric on both ends).
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/Pausable.sol
//!
//! Role-rotation via `set_authority` mirrors OpenZeppelin's `AccessControl`.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol

use crate::constants::{MIN_COLLATERAL_RATIO_FLOOR, PRECISION};
use crate::contexts::{AcceptRoleAdmin, Pause, SetAuthority, SetMinCollateralRatio, Unpause};
use crate::errors::OkuDollarError;
use crate::events::*;
use crate::helpers::is_sufficiently_collateralized;
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

/// Update a specific authority role.
///
/// Only `role_admin` can call this. Non-meta roles commit immediately;
/// `RoleAdmin` is two-step (propose + accept, mirroring OpenZeppelin's
/// `Ownable2Step`). See `accept_role_admin` for step 2.
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

    if matches!(role, AuthorityRole::RoleAdmin) {
        let current_admin = config.role_admin;
        config.pending_role_admin = new_authority;

        emit!(RoleAdminTransferProposedEvent {
            current_admin,
            pending_admin: new_authority,
        });
        return Ok(());
    }

    let old_authority = match role {
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
        AuthorityRole::RoleAdmin => unreachable!("handled above"),
    };

    emit!(AuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}

/// Step 2 of the two-step `role_admin` transfer.
///
/// Must be signed by the previously-proposed `pending_role_admin`. Moves
/// the value into `role_admin` and clears the pending slot.
pub fn accept_role_admin(ctx: Context<AcceptRoleAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_role_admin != Pubkey::default(),
        OkuDollarError::NoPendingRoleAdmin
    );
    require!(
        ctx.accounts.new_role_admin.key() == config.pending_role_admin,
        OkuDollarError::NotPendingRoleAdmin
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
        role: AuthorityRole::RoleAdmin,
        old_authority: previous_admin,
        new_authority: new_admin,
    });

    Ok(())
}

/// Withdraw an in-flight two-step `role_admin` proposal (current admin only).
pub fn cancel_role_admin_transfer(ctx: Context<SetAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_role_admin != Pubkey::default(),
        OkuDollarError::NoPendingRoleAdmin
    );

    let cancelled_pending = config.pending_role_admin;
    config.pending_role_admin = Pubkey::default();

    emit!(RoleAdminTransferCancelledEvent {
        current_admin: config.role_admin,
        cancelled_pending,
    });

    Ok(())
}

/// Set the minimum collateral ratio.
///
/// Only `role_admin` can call this. The ratio must lie in
/// `[MIN_COLLATERAL_RATIO_FLOOR (90%), PRECISION (100%)]`. Mirrors EVM
/// `OkuDollar.setMinCollateralRatio`'s `RatioExceedsMax()` upper bound.
///
/// **Current-health gate:** the call additionally rejects any new floor
/// that the live vault does not already meet. Without this check, raising
/// the floor above the live ratio would silently brick
/// `update_usd_multiplier` and `withdraw_reserves` until the operator
/// deposited additional reserves. Operational expectation: if you want
/// to raise the floor above current health, call `deposit_reserves` first
/// so the vault clears the new bar in the same operational batch.
pub fn set_min_collateral_ratio(
    ctx: Context<SetMinCollateralRatio>,
    new_min_collateral_ratio: u64,
) -> Result<()> {
    require!(
        new_min_collateral_ratio >= MIN_COLLATERAL_RATIO_FLOOR,
        OkuDollarError::InvalidCollateralRatio
    );
    require!(
        new_min_collateral_ratio <= PRECISION,
        OkuDollarError::RatioExceedsMax
    );

    // Live-health gate. Reading these *before* the mutable `config`
    // borrow keeps the borrow checker happy.
    let reserve_balance = ctx.accounts.reserve_vault.amount;
    let total_supply = ctx.accounts.usd_oku_mint.supply;
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;
    let usd_multiplier = ctx.accounts.config.usd_multiplier;

    require!(
        is_sufficiently_collateralized(
            reserve_balance,
            total_supply,
            usd_multiplier,
            oku_m_price,
            new_min_collateral_ratio,
        )?,
        OkuDollarError::InsufficientCollateral
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
