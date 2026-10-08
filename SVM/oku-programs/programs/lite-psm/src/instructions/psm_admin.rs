//! LitePSM admin instructions. Pause and role rotation follow OpenZeppelin's
//! `Pausable` / `AccessControl`; freeze and thaw follow Circle FiatToken's
//! blacklister.

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

/// Stop mint, redeem, direct mint/burn and buffer moves (`pauser` only).
/// Freeze/thaw and rate decreases keep working. Not blocked by the override
/// slot: pausing must always be possible.
pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.is_paused, LitePsmError::AlreadyPaused);
    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
    });

    Ok(())
}

/// Resume normal operation (`unpauser` only). Fails if not paused.
pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.is_paused, LitePsmError::NotPaused);
    config.is_paused = false;

    emit!(UnpauseEvent {
        unpauser: ctx.accounts.unpauser.key(),
    });

    Ok(())
}

/// Set the maximum OkuM supply, in raw units (`cap_manager` only). Refuses a
/// cap below current supply, which would silently brick every mint.
pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()> {
    let current_supply = ctx.accounts.oku_m_mint.supply;
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

/// Set how much more OkuM the PSM may mint through `mint_oku_m`
/// (`allowance_manager` only). It REPLACES the allowance (it does not add to it), and is
/// allowed while paused so an incident can cut the allowance to zero. The
/// value is not bounded: the supply cap still applies at mint time.
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

/// Set how much more OkuM the `direct_minter` may mint through
/// `mint_oku_m_direct` (`allowance_manager` only). Zero is the off-switch for
/// direct minting. It REPLACES the allowance (it does not add to it), and is
/// allowed while paused so an incident can cut the allowance to zero. The
/// value is not bounded: the supply cap still applies at mint time.
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

/// Set how much more OkuM the `direct_burner` may burn through
/// `burn_oku_m_direct` (`allowance_manager` only). It REPLACES the allowance
/// (it does not add to it), and is allowed while paused so an incident can cut
/// the allowance to zero.
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

/// Freeze one OkuM token account so it can neither send nor receive
/// (`freezer` only). This covers that account only, not the wallet: the owner's
/// other OkuM accounts are unaffected.
///
/// Deliberately not pause-gated: compliance actions must work during an incident.
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let target_owner = ctx.accounts.target_oku_m_ata.owner;

    // The config PDA is the mint's freeze authority, so it signs the CPI.
    let bump_seed = [config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

    token_interface::freeze_account(CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.key(),
        token_interface::FreezeAccount {
            account: ctx.accounts.target_oku_m_ata.to_account_info(),
            mint: ctx.accounts.oku_m_mint.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        signer,
    ))?;

    emit!(FreezeEvent {
        account: ctx.accounts.target_oku_m_ata.key(),
        target_owner,
    });

    Ok(())
}

/// Unfreeze an OkuM token account (`unfreezer` only). Deliberately not
/// pause-gated, like `freeze_account`.
pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
    // The config PDA is the mint's freeze authority, so it signs the CPI.
    let bump_seed = [ctx.accounts.config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

    token_interface::thaw_account(CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.key(),
        token_interface::ThawAccount {
            account: ctx.accounts.target_oku_m_ata.to_account_info(),
            mint: ctx.accounts.oku_m_mint.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        signer,
    ))?;

    emit!(ThawEvent {
        account: ctx.accounts.target_oku_m_ata.key(),
        target_owner: ctx.accounts.target_oku_m_ata.owner,
    });

    Ok(())
}

/// Hand one of the 12 PSM roles to a new key (`role_admin` only).
///
/// Non-`RoleAdmin` roles commit immediately. `RoleAdmin` is a two-step
/// propose/accept (like `Ownable2Step`): this writes `pending_role_admin` and
/// `accept_role_admin` commits it, so a typo cannot lock out the meta-role.
pub fn set_authority(
    ctx: Context<SetAuthority>,
    role: AuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    // Zero address would lock the role out. Equality with `role_admin` is
    // rejected so the cold key is never collapsed into a warm role, and so a
    // `RoleAdmin` proposal is never a no-op.
    let config = &mut ctx.accounts.config;
    require!(
        new_authority != Pubkey::default() && new_authority != config.role_admin,
        LitePsmError::InvalidAuthority
    );

    if matches!(role, AuthorityRole::RoleAdmin) {
        let current_admin = config.role_admin;
        config.pending_role_admin = new_authority;

        // No `AuthorityUpdatedEvent` yet; `accept_role_admin` emits it on commit.
        emit!(RoleAdminTransferProposedEvent {
            current_admin,
            pending_admin: new_authority,
        });
        return Ok(());
    }

    // Swap in the new authority and return the old one. `RoleAdmin` is handled
    // by the two-step branch above.
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
        BufferDepositor   => buffer_depositor,
        BufferWithdrawer  => buffer_withdrawer,
        CapManager        => cap_manager,
        AllowanceManager  => allowance_manager,
        RateManager           => rate_manager,
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

/// Second step of a `role_admin` handover: the proposed admin signs to take
/// over, and the pending slot is cleared.
///
/// Emits the canonical `AuthorityUpdatedEvent` so indexers need not special-case
/// the two-step path.
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

/// Withdraw a pending `role_admin` proposal before it is accepted (`role_admin`
/// only). Uses the `SetAuthority` accounts: the signer must be the current admin.
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
