//! LitePSM admin instructions (pause, freeze, thaw, role admin, etc.).
//!
//! Pause / unpause and the role-rotation match arms mirror OpenZeppelin's
//! `Pausable` and `AccessControl` patterns.
//! Taken from <https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/Pausable.sol>.
//! Taken from <https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol>.
//!
//! Freeze / thaw mirrors Circle FiatToken's blacklister pattern.
//! Taken from <https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol>.

// F-02: CPI targets (freeze_account, thaw_account) use Anchor's typed
// `Interface<'info, TokenInterface>` account which validates program ID at
// deserialization. The `arbitrary_cpi` warning is a false positive here.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::contexts::{
    AcceptRoleAdmin, AllowanceManager, CapManager, FreezeAccount, Pause, SetAuthority, ThawAccount,
    Unpause,
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
/// silently brick every subsequent `mint_oku_m` because the mint path
/// checks `current_supply + amount <= max_supply` and `add(0) > cap` is
/// true on a starting state of `current_supply > cap`. Mirrors EVM
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

/// Reset direct-minter allowance (allowance_manager only).
///
/// Mirrors `set_minter_allowance` but controls the separate
/// `direct_minter_allowance` consumed by `mint_oku_m_direct` /
/// `mint_usd_oku_direct`. EVM equivalent: `configureMinterAllowance`
/// called for the direct-minter address.
pub fn set_direct_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_allowance = config.direct_minter_allowance;
    config.direct_minter_allowance = amount;

    emit!(DirectMinterAllowanceUpdatedEvent {
        actor: ctx.accounts.allowance_manager.key(),
        old_allowance,
        new_allowance: amount,
    });

    Ok(())
}

/// Reset direct-burner allowance (allowance_manager only).
///
/// Mirrors `set_direct_minter_allowance` but controls the separate
/// `direct_burner_allowance` consumed by `burn_oku_m_direct`.
/// EVM equivalent: allowance management for the `OKUM_BURNER` address.
pub fn set_direct_burner_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_allowance = config.direct_burner_allowance;
    config.direct_burner_allowance = amount;

    emit!(DirectBurnerAllowanceUpdatedEvent {
        actor: ctx.accounts.allowance_manager.key(),
        old_allowance,
        new_allowance: amount,
    });

    Ok(())
}

/// Freeze an OkuMoney token account (compliance/blacklist).
/// Uses Token-2022 freeze authority CPI.
/// MUST work even when PSM is paused (no pause check).
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let target_owner = ctx.accounts.target_oku_money_ata.owner;

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

/// Update a specific authority role.
///
/// Only `role_admin` can call this. All non-meta roles commit immediately;
/// `RoleAdmin` is special-cased into a two-step (propose + accept) flow
/// modelled on OpenZeppelin's `Ownable2Step`:
///
/// 1. The current `role_admin` calls `set_authority(RoleAdmin, new_admin)`.
///    This writes `new_admin` to `pending_role_admin`. The live
///    `role_admin` is unchanged.
/// 2. `new_admin` calls `accept_role_admin`, which moves the value into
///    `role_admin` and clears the slot.
///
/// Step 1 can be repeated or cleared via `cancel_role_admin_transfer`. A
/// typo or stale-key proposal therefore does not lock the protocol out
/// of its meta-role.
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

    // Cycle 4 (PSM-02): reject `new_authority == role_admin` for
    // non-RoleAdmin roles. Collapsing the cold-multisig key into a
    // warm-multisig role destroys the separation-of-duties model the
    // protocol is designed around, and a typo or stale-key in the
    // proposing flow is the most likely way it would happen. The
    // `RoleAdmin` two-step branch below handles its own equality check
    // (a self-set is a legal no-op cancel/re-propose).
    if !matches!(role, AuthorityRole::RoleAdmin) {
        require!(
            new_authority != config.role_admin,
            LitePsmError::InvalidAuthority
        );
    }

    // RoleAdmin uses a two-step transfer; every other role commits
    // immediately. See doc comment above for rationale.
    if matches!(role, AuthorityRole::RoleAdmin) {
        // Cycle 4 (PSM-02): also reject a no-op proposal (proposing the
        // current admin to themselves). Harmless on-chain but obscures
        // event-log inspection of in-flight rotations.
        require!(
            new_authority != config.role_admin,
            LitePsmError::InvalidAuthority
        );
        let current_admin = config.role_admin;
        config.pending_role_admin = new_authority;

        emit!(RoleAdminTransferProposedEvent {
            current_admin,
            pending_admin: new_authority,
        });
        // Do NOT emit `AuthorityUpdatedEvent` here — the rotation has not
        // taken effect yet. `accept_role_admin` emits the canonical
        // `AuthorityUpdatedEvent` once the transfer commits.
        return Ok(());
    }

    // Swap-in the new authority and return the old value. Each arm is
    // structurally identical (`let old = config.X; config.X = new;
    // old`), so we use a one-line macro to dispatch on the role enum
    // and collapse the 12-arm match. Behavior is byte-for-byte
    // identical to the previous open-coded version. `RoleAdmin` is
    // intentionally absent — it's handled by the two-step branch above.
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
                AuthorityRole::RoleAdmin => unreachable!("handled above"),
            }
        };
    }
    let old_authority = rotate_role! {
        Pauser            => pauser,
        Unpauser          => unpauser,
        Freezer           => freezer,
        Unfreezer         => unfreezer,
        QueueProcessor    => queue_processor,
        BufferDepositor   => buffer_depositor,
        BufferWithdrawer  => buffer_withdrawer,
        CapManager        => cap_manager,
        AllowanceManager  => allowance_manager,
        Rebaser           => rebaser,
        DirectMinter      => direct_minter,
        DirectBurner      => direct_burner,
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
/// Must be signed by the `pending_role_admin` previously proposed by the
/// outgoing admin via `set_authority(RoleAdmin, ...)`. Moves the value
/// into `role_admin` and clears the pending slot. Emits the canonical
/// `AuthorityUpdatedEvent` so downstream indexers do not need to special-
/// case the two-step path.
pub fn accept_role_admin(ctx: Context<AcceptRoleAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_role_admin != Pubkey::default(),
        LitePsmError::NoPendingRoleAdmin
    );
    require!(
        ctx.accounts.new_role_admin.key() == config.pending_role_admin,
        LitePsmError::NotPendingRoleAdmin
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

/// Withdraw an in-flight two-step `role_admin` proposal.
///
/// Only the *current* `role_admin` may cancel. The pending slot is reset
/// to `Pubkey::default()`. Useful if the outgoing admin discovers a typo
/// in the proposed pubkey before the new admin has accepted.
pub fn cancel_role_admin_transfer(ctx: Context<SetAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_role_admin != Pubkey::default(),
        LitePsmError::NoPendingRoleAdmin
    );

    let cancelled_pending = config.pending_role_admin;
    config.pending_role_admin = Pubkey::default();

    emit!(RoleAdminTransferCancelledEvent {
        current_admin: config.role_admin,
        cancelled_pending,
    });

    Ok(())
}
