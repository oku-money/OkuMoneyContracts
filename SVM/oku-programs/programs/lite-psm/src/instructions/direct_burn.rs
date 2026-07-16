//! Permissioned direct-burn instruction (bridge / off-ramp path).
//!
//! This instruction allows a `direct_burner` authority to burn OkuMoney
//! from its own ATA WITHOUT triggering a USDC payout. Matches EVM's
//! `OkuMoney.burn(amount)` called by a non-PSM `OKUM_BURNER` role holder.
//!
//! The USDC settlement for burns lives off-chain (the KMS-backed
//! orchestrator mints on the destination chain via `mint_oku_m`). This
//! instruction is the supply-destruction half of the SVM->EVM bridge flow.

// CPI targets are constrained by Anchor's typed `Program<'info, Token2022>`
// accounts. The `arbitrary_cpi` warning is a false positive.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::contexts::direct_burn::{BurnOkuMDirect, MigratePsmConfigV2};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_yield_lock, oku_m_to_dollars, read_oku_m_price};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Old PsmConfig account size (before direct-burner fields).
/// 594 = current size with direct_minter but without direct_burner.
const OLD_PSM_CONFIG_LEN_V2: usize = 594;

/// Byte offset of the `role_admin` pubkey inside a PsmConfig account.
/// Layout: 8 (discriminator) + 1 (bump) = 9 bytes before role_admin.
const ROLE_ADMIN_OFFSET: usize = 9;

/// One-time migration: extend PsmConfig from 594 -> 634 bytes.
///
/// Appends 40 zero bytes (= `direct_burner: Pubkey::default()` +
/// `direct_burner_allowance: 0u64`). After the realloc, every
/// instruction that deserializes `Account<PsmConfig>` works normally.
///
/// Idempotent: reverts if the account is already 634 bytes.
pub fn migrate_psm_config_v2(ctx: Context<MigratePsmConfigV2>) -> Result<()> {
    let config_info = ctx.accounts.config.to_account_info();
    let current_len = config_info.data_len();

    // Guard: only run on pre-migration accounts
    require!(
        current_len == OLD_PSM_CONFIG_LEN_V2,
        LitePsmError::MigrationNotNeeded
    );

    // Verify role_admin matches the signer
    {
        let data = config_info.try_borrow_data()?;

        let stored_role_admin = Pubkey::try_from(&data[ROLE_ADMIN_OFFSET..ROLE_ADMIN_OFFSET + 32])
            .map_err(|_| error!(LitePsmError::Unauthorized))?;
        require!(
            stored_role_admin == ctx.accounts.role_admin.key(),
            LitePsmError::Unauthorized
        );
    }
    // Borrow dropped -- safe to realloc

    // Resize to new length. The extended region is zero-filled by the
    // Solana runtime, which is exactly what we want -- zero bytes encode
    // `Pubkey::default()` + `u64(0)` in borsh.
    config_info
        .resize(PsmConfig::LEN)
        .map_err(|_| error!(LitePsmError::Overflow))?;

    // Top up rent-exempt lamports
    let rent = Rent::get()?;
    let new_minimum = rent.minimum_balance(PsmConfig::LEN);
    let current_lamports = config_info.lamports();
    let lamports_diff = new_minimum.saturating_sub(current_lamports);
    if lamports_diff > 0 {
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.payer.key(),
            &config_info.key(),
            lamports_diff,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                config_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    emit!(PsmConfigMigratedEvent {
        old_len: OLD_PSM_CONFIG_LEN_V2 as u64,
        new_len: PsmConfig::LEN as u64,
    });

    Ok(())
}

/// Burn OkuMoney directly without USDC payout (permissioned).
///
/// Guards (matching EVM `OkuMoney.burn`):
/// - `direct_burner` must be signer, validated via `has_one` on config
/// - Pause check (EVM `burn()` is allowed while paused; we match the
///   stricter SVM convention of checking pause on all user-facing ops)
/// - Yield-lock check (same slot as yield distribution -> reject)
/// - `direct_burner_allowance` check + decrement (effects-before-interactions)
///
/// NOT included:
/// - No USDC transfer (pure supply destruction)
/// - No max supply check (burning reduces supply, doesn't increase it)
pub fn burn_oku_m_direct(ctx: Context<BurnOkuMDirect>, oku_m_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let direct_burner_allowance = ctx.accounts.config.direct_burner_allowance;

    require!(!is_paused, LitePsmError::Paused);
    require!(oku_m_amount > 0, LitePsmError::ZeroAmount);

    // Check direct-burner allowance
    require!(
        oku_m_amount <= direct_burner_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Effects-before-interactions: decrement allowance BEFORE the burn CPI
    ctx.accounts.config.direct_burner_allowance = direct_burner_allowance
        .checked_sub(oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Capture keys before borrow
    let direct_burner_key = ctx.accounts.direct_burner.key();

    // Burn OkuMoney from the burner's ATA (Token-2022).
    // The burner is the token account owner, so it signs the burn directly.
    // No PDA signer needed -- unlike minting, burning only requires the
    // token account owner's signature, not the mint authority.
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                from: ctx.accounts.burner_oku_money_ata.to_account_info(),
                authority: ctx.accounts.direct_burner.to_account_info(),
            },
        ),
        oku_m_amount,
    )?;

    // Calculate dollar value and post-burn supply for event.
    // Read price from the mint's ScaledUiAmountConfig extension.
    ctx.accounts.oku_money_mint.reload()?;
    let oku_m_price = read_oku_m_price(&ctx.accounts.oku_money_mint.to_account_info())?;
    let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;
    let new_total_supply = ctx.accounts.oku_money_mint.supply;

    emit!(DirectBurnEvent {
        direct_burner: direct_burner_key,
        oku_m_amount,
        oku_m_price,
        dollar_value,
        new_total_supply,
    });

    Ok(())
}
