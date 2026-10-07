//! LitePSM admin instructions. Pause and role rotation follow OpenZeppelin's
//! `Pausable` / `AccessControl`; freeze and thaw follow Circle FiatToken's
//! blacklister.

use crate::constants::{OKU_M_METADATA_NAME, OKU_M_METADATA_SYMBOL};
use crate::contexts::{
    AcceptRoleAdmin, AllowanceManager, CapManager, FreezeAccount, Pause, SetAuthority, ThawAccount,
    Unpause, UpdateTokenMetadata,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::roles::AuthorityRole;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface;
use anchor_spl::token_interface;
use spl_token_metadata_interface::state::Field;

pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.is_paused, LitePsmError::AlreadyPaused);
    config.is_paused = true;

    emit!(PauseEvent {
        pauser: ctx.accounts.pauser.key(),
    });

    Ok(())
}

pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.is_paused, LitePsmError::NotPaused);
    config.is_paused = false;

    emit!(UnpauseEvent {
        unpauser: ctx.accounts.unpauser.key(),
    });

    Ok(())
}

/// Refuses a cap below current supply, which would silently brick every mint.
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

/// Deliberately not pause-gated: compliance actions must work during an incident.
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let target_owner = ctx.accounts.target_oku_m_ata.owner;

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

/// Deliberately not pause-gated, like `freeze_account`.
pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
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

/// Name/symbol come from `OKU_M_METADATA_*` so they cannot drift from `initialize`.
/// The config PDA is the metadata update authority and signs both CPIs.
pub fn update_token_metadata(ctx: Context<UpdateTokenMetadata>) -> Result<()> {
    let bump_seed = [ctx.accounts.config.bump];
    let config_key = ctx.accounts.config.key();
    let mint_key = ctx.accounts.oku_m_mint.key();
    let token_2022_id = ctx.accounts.token_2022_program.key();

    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer_seeds = &[&seeds[..]];

    let account_infos = &[
        ctx.accounts.oku_m_mint.to_account_info(),
        ctx.accounts.config.to_account_info(),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &spl_token_metadata_interface::instruction::update_field(
            &token_2022_id,
            &mint_key,   // metadata account = mint (self)
            &config_key, // update authority (signs via PDA)
            Field::Name,
            OKU_M_METADATA_NAME.to_string(),
        ),
        account_infos,
        signer_seeds,
    )?;

    anchor_lang::solana_program::program::invoke_signed(
        &spl_token_metadata_interface::instruction::update_field(
            &token_2022_id,
            &mint_key,
            &config_key,
            Field::Symbol,
            OKU_M_METADATA_SYMBOL.to_string(),
        ),
        account_infos,
        signer_seeds,
    )?;

    emit!(TokenMetadataUpdatedEvent {
        mint: mint_key,
        name: OKU_M_METADATA_NAME.to_string(),
        symbol: OKU_M_METADATA_SYMBOL.to_string(),
    });

    Ok(())
}
