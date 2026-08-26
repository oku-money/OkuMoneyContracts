//! LitePSM admin instructions (pause, freeze, thaw, role admin, etc.).
//!
//! Pause / unpause and the role-rotation match arms mirror OpenZeppelin's
//! `Pausable` and `AccessControl` patterns.
//! Taken from <https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/Pausable.sol>.
//! Taken from <https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol>.
//!
//! Freeze / thaw mirrors Circle FiatToken's blacklister pattern.
//! Taken from <https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol>.

use crate::constants::{OKU_M_METADATA_NAME, OKU_M_METADATA_SYMBOL};
use crate::contexts::{
    AcceptRoleAdmin, AllowanceManager, CapManager, CapManagerParams, FreezeAccount, Pause,
    SetAuthority, ThawAccount, Unpause, UpdateTokenMetadata,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::validate_sync_window_secs;
use crate::roles::AuthorityRole;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface;
use anchor_spl::token_interface;
use oku_shared::MAX_FEE_BPS;
use spl_token_metadata_interface::state::Field;

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
/// `OkuM.setMaxSupply`'s `BelowCurrentSupply` revert.
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
/// `direct_minter_allowance` consumed by `mint_oku_m_direct`.
/// EVM equivalent: `configureMinterAllowance`
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

/// Freeze a OkuM token account (compliance/blacklist).
/// Uses Token-2022 freeze authority CPI.
/// MUST work even when PSM is paused (no pause check).
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let target_owner = ctx.accounts.target_oku_m_ata.owner;

    let bump = [config.bump];
    let seeds = PsmConfig::signer_seeds(&bump);
    let signer = &[&seeds[..]];

    // CPI to Token-2022 to freeze the account
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

/// Thaw a frozen OkuM token account
/// Uses Token-2022 thaw authority CPI
/// MUST work even when PSM is paused (no pause check)
pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
    let bump = [ctx.accounts.config.bump];
    let seeds = PsmConfig::signer_seeds(&bump);
    let signer = &[&seeds[..]];

    // CPI to Token-2022 to thaw the account
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

    // Reject `new_authority == role_admin` for non-RoleAdmin roles.
    // Collapsing the cold-multisig key into a warm-multisig role would
    // destroy the separation-of-duties model, and a typo or stale key in
    // the proposing flow is the most likely way it would happen. The
    // `RoleAdmin` two-step branch below handles its own equality check.
    if !matches!(role, AuthorityRole::RoleAdmin) {
        require!(
            new_authority != config.role_admin,
            LitePsmError::InvalidAuthority
        );
    }

    // RoleAdmin uses a two-step transfer; every other role commits
    // immediately. See doc comment above for rationale.
    if matches!(role, AuthorityRole::RoleAdmin) {
        // Also reject a no-op proposal (proposing the current admin to
        // themselves) so the event log unambiguously reflects in-flight
        // rotations.
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

    // Swap in the new authority and return the old value. Each arm is
    // structurally identical (`let old = config.X; config.X = new; old`),
    // so a one-line macro dispatches on the role enum and collapses the
    // match. `RoleAdmin` is intentionally absent — it's handled by the
    // two-step branch above.
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

/// Set the OkuM mint's Token-2022 `TokenMetadata` `name`/`symbol` in place
/// (`role_admin` only).
///
/// # What it does
/// Sets the mint's on-chain identity to the canonical OkuM ("OkuMoney")
/// name/symbol. This is a metadata-only edit: existing balances and ATAs are
/// untouched, and no new mint is created.
///
/// # OkuM vs usdOku
/// The `name`/`symbol` set here are the TRUE on-chain identity of the
/// base token — **OkuM ("OkuMoney")** — which wallets and block explorers
/// display for the mint and for transfers. Values come from the single
/// source of truth `OKU_M_METADATA_*` (constants.rs) so they cannot drift
/// from `initialize`. The "$1-pegged usdOku" figure is a separate
/// ScaledUiAmount display value (raw_amount * multiplier) and is NOT
/// affected by this instruction.
///
/// # Authority
/// The metadata `update_authority` is the `config` PDA; it CPI-signs the
/// two `update_field` calls (Name, Symbol) via `invoke_signed`. Access is
/// gated to `role_admin` via `has_one` on the context.
pub fn update_token_metadata(ctx: Context<UpdateTokenMetadata>) -> Result<()> {
    let bump = [ctx.accounts.config.bump];
    let config_key = ctx.accounts.config.key();
    let mint_key = ctx.accounts.oku_m_mint.key();
    let token_2022_id = ctx.accounts.token_2022_program.key();

    // The config PDA is the metadata update authority; sign both CPIs
    // with its seeds (same pattern as `initialize`'s metadata-init CPI).
    let seeds = PsmConfig::signer_seeds(&bump);
    let signer_seeds = &[&seeds[..]];

    let account_infos = &[
        ctx.accounts.oku_m_mint.to_account_info(),
        ctx.accounts.config.to_account_info(),
    ];

    // Update `name`.
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

    // Update `symbol`.
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

/// Set the post-step sync window length in seconds (CAP_MANAGER only).
///
/// `0` disables the window entirely. It ships ON at
/// `DEFAULT_SYNC_WINDOW_SECS` so a fresh deployment is protected from the
/// first mark. Bounded by `MAX_SYNC_WINDOW_SECS`, so no key — cold
/// included — can turn this into an indefinite redemption block.
///
/// Sized from cross-chain propagation, not from arbitrage economics: the
/// window need only outlast the interval between the first chain's write
/// and the last's. It is NOT the step-arbitrage control — the fees are,
/// since an attacker holding raw across a step never transacts during the
/// window and is therefore indifferent to its length.
pub fn set_sync_window_secs(ctx: Context<CapManagerParams>, new_secs: i64) -> Result<()> {
    validate_sync_window_secs(new_secs)?;

    let config = &mut ctx.accounts.config;
    let old_secs = config.sync_window_secs;
    config.sync_window_secs = new_secs;

    emit!(SyncWindowSecsSet { old_secs, new_secs });

    Ok(())
}

/// Set the PSM `tin` / `tout` fee schedule in basis points (CAP_MANAGER only).
///
/// # What the fees are for
///
/// The multiplier moves in discrete steps on both chains (Token-2022
/// forbids `ScaledUiAmount` alongside `InterestBearingConfig`, so
/// continuous accrual is unavailable here — and the EVM twin is stepwise
/// by design so both sides carry the same value at the same cadence). A
/// discrete step is free money to anyone who mints at `M0`, holds across
/// the step, and redeems at `M1` — no risk, no meaningful holding period,
/// repeatable every step, bounded only by `minter_allowance` and buffer
/// depth.
///
/// The sync window does **not** stop this: the attacker never needs to
/// transact while the window is open, so widening it only lengthens their
/// hold. A round trip pays `tin` going in and `tout` coming out, so it is
/// the COMBINED `tin + tout` exceeding one step's yield that makes the
/// round trip lossy — permanently, and independently of tick cadence. A
/// `tout`-only rule leaks the mint-side half. Set them accordingly: at a
/// weekly cadence and 5% APY one step is ~9.6 bps, so `tin + tout` must
/// exceed that with margin.
///
/// Both fees accrue to the USDC buffer (no recipient, no transfer), so
/// they raise the collateral ratio rather than being swept.
///
/// Ported concept: `tin` / `tout` from the upstream this PSM was modelled on.
/// Taken from <https://github.com/makerdao/dss-lite-psm/blob/master/src/DssLitePsm.sol>.
pub fn set_fees(ctx: Context<CapManagerParams>, tin_bps: u64, tout_bps: u64) -> Result<()> {
    require!(tin_bps <= MAX_FEE_BPS, LitePsmError::FeeAboveMax);
    require!(tout_bps <= MAX_FEE_BPS, LitePsmError::FeeAboveMax);

    // ---- STEP-ARBITRAGE COVERAGE (half 2 of 2) ----
    //
    // The COMBINED `tin + tout` may not drop below the largest step ever
    // taken. Half 1 (the `step_is_covered` check at write time) stops exposure
    // being created that the fees do not cover; this stops the coverage being
    // removed afterwards.
    //
    // Without it: raise fees, take a big step, lower fees — and everyone who
    // held across the step gets a cheap exit. The attacker's edge is locked in
    // the moment the step lands and never decays, which is why a time-based
    // cooldown does not work here and a high-water mark does.
    //
    // Binding the SUM rather than `tout` alone matters: coverage may legally be
    // carried entirely by `tin`, and a `tout`-only floor would then permit
    // dropping to zero total coverage while still passing.
    //
    // Only pins against steps ACTUALLY taken: if every step was 1.4 bps, the
    // fees can still be lowered to 1.4 bps combined. Clearing the mark is
    // possible but is a separate, explicitly-named instruction.
    let combined_bps = tin_bps
        .checked_add(tout_bps)
        .ok_or(LitePsmError::Overflow)?;
    require!(
        combined_bps >= ctx.accounts.config.max_step_bps,
        LitePsmError::FeeBelowStepHighWaterMark
    );

    let config = &mut ctx.accounts.config;
    let old_tin_bps = config.tin_bps;
    let old_tout_bps = config.tout_bps;
    config.tin_bps = tin_bps;
    config.tout_bps = tout_bps;

    emit!(FeesSet {
        old_tin_bps,
        new_tin_bps: tin_bps,
        old_tout_bps,
        new_tout_bps: tout_bps,
    });

    Ok(())
}

/// Clear the multiplier-step high-water mark (CAP_MANAGER only).
///
/// # Read this before calling
///
/// `max_step_bps` is the floor under `tin_bps + tout_bps`, and it exists so a step that
/// was covered when it was taken cannot be un-covered later. Clearing it
/// **reopens that historical exposure**: anyone still holding raw acquired
/// before a large past step can then redeem at a fee that no longer covers it.
///
/// This is deliberately a separate, explicitly-named instruction rather than a
/// side effect of `set_fees`, so it cannot happen by accident during a routine
/// fee change and shows up unambiguously in an audit trail.
///
/// # When it is legitimate
///
/// Moving to a materially finer cadence — e.g. a protocol that ran on weekly
/// ~9.6 bps steps switching to hourly ~0.06 bps steps — would otherwise be
/// pinned at the old weekly fee forever. The honest precondition is that the
/// raw supply outstanding at the time of the large step has substantially
/// turned over, which the chain cannot verify. That judgement is the cold
/// multisig's, which is why this sits on `cap_manager`.
pub fn reset_step_high_water_mark(ctx: Context<CapManagerParams>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_mark = config.max_step_bps;
    config.max_step_bps = 0;

    emit!(StepHighWaterMarkReset {
        old_mark_bps: old_mark,
        tout_bps_at_reset: config.tout_bps,
    });

    Ok(())
}
