//! Permissioned direct-burn instruction (bridge / off-ramp path).
//!
//! This instruction allows a `direct_burner` authority to burn usdOku
//! from its own ATA WITHOUT triggering a USDC payout. Matches EVM's
//! `usdOku.burn(amount)` called by a non-PSM `OKUM_BURNER` role holder.
//!
//! The USDC settlement for burns lives off-chain (the KMS-backed
//! orchestrator mints on the destination chain via `mint_usd_oku`). This
//! instruction is the supply-destruction half of the SVM->EVM bridge flow.

use crate::contexts::direct_burn::BurnUsdOkuDirect;
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_yield_lock, raw_to_dollars, read_multiplier};
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Burn usdOku directly without USDC payout (permissioned).
///
/// Guards (matching EVM `usdOku.burn`):
/// - `direct_burner` must be signer, validated via `has_one` on config
/// - Pause check (EVM `burn()` is allowed while paused; we match the
///   stricter SVM convention of checking pause on all user-facing ops)
/// - Yield-lock check (same slot as yield distribution -> reject)
/// - `direct_burner_allowance` check + decrement (effects-before-interactions)
///
/// NOT included:
/// - No USDC transfer (pure supply destruction)
/// - No max supply check (burning reduces supply, doesn't increase it)
pub fn burn_usd_oku_direct(ctx: Context<BurnUsdOkuDirect>, raw_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let direct_burner_allowance = ctx.accounts.config.direct_burner_allowance;

    require!(!is_paused, LitePsmError::Paused);
    require!(raw_amount > 0, LitePsmError::ZeroAmount);

    // Check direct-burner allowance
    require!(
        raw_amount <= direct_burner_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Effects-before-interactions: decrement allowance BEFORE the burn CPI
    ctx.accounts.config.direct_burner_allowance = direct_burner_allowance
        .checked_sub(raw_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Capture keys before borrow
    let direct_burner_key = ctx.accounts.direct_burner.key();

    // Burn usdOku from the burner's ATA (Token-2022).
    // The burner is the token account owner, so it signs the burn directly.
    // No PDA signer needed -- unlike minting, burning only requires the
    // token account owner's signature, not the mint authority.
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.usd_oku_mint.to_account_info(),
                from: ctx.accounts.burner_usd_oku_ata.to_account_info(),
                authority: ctx.accounts.direct_burner.to_account_info(),
            },
        ),
        raw_amount,
    )?;

    // Read multiplier from mint to compute dollar value for event
    let multiplier = read_multiplier(&ctx.accounts.usd_oku_mint.to_account_info())?;
    let dollar_value = raw_to_dollars(raw_amount, multiplier)?;

    ctx.accounts.usd_oku_mint.reload()?;
    let new_total_supply = ctx.accounts.usd_oku_mint.supply;

    emit!(DirectBurnEvent {
        direct_burner: direct_burner_key,
        raw_usd_oku_amount: raw_amount,
        multiplier,
        dollar_value,
        new_total_supply,
    });

    Ok(())
}
