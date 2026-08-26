//! Yield distribution / multiplier-update instructions.
//!
//! The OkuM multiplier lives on the mint itself via the Token-2022
//! `ScaledUiAmountConfig` extension. These instructions read the current
//! multiplier from the extension, compute the new value, and CPI to
//! Token-2022's `UpdateMultiplier` to write it back.
//!
//! Discrete (per-call) multiplier accrual modelled on MakerDAO's `chi` / `_rpow`
//! pattern from sDAI. SVM uses a discrete bump per orchestrator call rather than
//! continuous on-read accrual to avoid recomputing on every PSM mint/redeem.
//! Taken from https://github.com/makerdao/sdai/blob/master/src/SavingsDai.sol

use crate::constants::{MAX_MULTIPLIER, PRECISION};
use crate::contexts::{DistributeYield, SetMultiplier};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{arm_sync_window, check_yield_lock};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;
use oku_shared::{step_bps_ceil, MAX_STEP_BPS, MIN_MARK_INTERVAL_SECS};

/// Write a new multiplier to the OkuM mint's ScaledUiAmountConfig extension
/// via CPI, stamp the yield-distribution slot, and arm the cross-chain sync
/// window.
///
/// Shared by `set_multiplier` and `distribute_yield` to ensure both paths
/// use identical CPI construction, slot-stamping, and window-arming logic.
///
/// # Why the multiplier is written to take effect immediately
///
/// Token-2022's `ScaledUiAmountConfig` supports a *scheduled* multiplier
/// (`new_multiplier` + `new_multiplier_effective_timestamp`), and an
/// earlier design used it to pre-announce the step MakerDAO-OSM style. It
/// was dropped deliberately: scheduling makes the step *predictable* but
/// does not make it *smaller*, so it does not reduce step-arbitrage
/// profit at all — that is the fees' job, and they handle it regardless
/// of timing. Meanwhile scheduling would add a second timing parameter
/// the orchestrator must align across chains, and would decouple "the
/// write landed" from "the price changed", which is exactly the ambiguity
/// the sync window exists to eliminate. Immediate writes keep one
/// timeline: the window covers the write, and the write is the step.
fn write_multiplier_and_stamp<'info>(
    new_multiplier: u64,
    current_multiplier: u64,
    config: &mut Account<'info, PsmConfig>,
    oku_m_mint: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
) -> Result<Clock> {
    // ---- STEP-ARBITRAGE COVERAGE (half 1 of 2) ----
    //
    // A discrete step is free money without a fee: mint at M0, wait for the
    // step to M1, redeem, pocket the difference — zero holding time, zero risk,
    // repeatable. The sync window cannot help; the attacker never transacts
    // while it is open.
    //
    // ---- STEP-ARBITRAGE COVERAGE (the whole of it) ----
    //
    // Bound the mark at `MAX_STEP_BPS` and stop. Coverage is not read from the
    // fee schedule here and cannot fail, because `set_fees` enforces
    // `tout_bps >= MAX_STEP_BPS` — and the exit leg is where the arbitrage gain
    // would be realised.
    //
    // This replaces a `step_is_covered(tin + tout)` read plus a `max_step_bps`
    // high-water ratchet that floored later `set_fees` calls plus a cold
    // `reset_step_high_water_mark` escape hatch. The static floor subsumes all
    // three and is strictly stronger — the ratchet only ever covered steps that
    // had actually been taken.
    //
    // Ceiled, so a fractionally-oversized mark cannot round its way through.
    let step_bps =
        step_bps_ceil(current_multiplier, new_multiplier).ok_or(LitePsmError::Overflow)?;
    require!(
        step_bps <= MAX_STEP_BPS,
        LitePsmError::StepAboveMax
    );

    // ---- MARK CADENCE ----
    //
    // What makes the bound above a bound on yield per unit TIME rather than per
    // call. Without it, `MAX_STEP_BPS` limits one mark while nothing limits how
    // many land in a slot, so a compromised `rebaser` could loop this
    // instruction and compound arbitrarily fast.
    //
    // `last_mark_ts == 0` (fresh deployment) is never too soon — there is no
    // prior mark to be close to.
    let now_ts = Clock::get()?.unix_timestamp;
    if config.last_mark_ts != 0 {
        let next_allowed = config
            .last_mark_ts
            .checked_add(MIN_MARK_INTERVAL_SECS)
            .ok_or(LitePsmError::Overflow)?;
        require!(now_ts >= next_allowed, LitePsmError::MarkTooSoon);
    }
    config.last_mark_ts = now_ts;

    let new_multiplier_f64 = new_multiplier as f64 / PRECISION as f64;

    let ix = update_multiplier(
        &token_2022_program.key(),
        &oku_m_mint.key(),
        &config.key(),
        &[],
        new_multiplier_f64,
        0, // effective_timestamp = 0 (immediate) — see fn doc.
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    let bump = [config.bump];
    let seeds = PsmConfig::signer_seeds(&bump);
    let signer = &[&seeds[..]];
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[oku_m_mint.clone(), config.to_account_info()],
        signer,
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    let clock = Clock::get()?;
    config.last_yield_distribution_slot = clock.slot;

    // Arm the sync window. The fence and the tick are the same transaction,
    // so a step can never land unfenced — there is no ordering for an
    // operator to get wrong and no separate open call to forget.
    //
    // Assigns rather than extends, which is what bounds the window by
    // construction. See `helpers::sync_window::arm_sync_window`.
    if arm_sync_window(config, clock.unix_timestamp) {
        emit!(SyncWindowArmed {
            until_ts: config.sync_lock_until_ts,
            timestamp: clock.unix_timestamp,
        });
    }

    Ok(clock)
}

/// Set OkuM multiplier directly
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
/// `new_multiplier` must be strictly greater than the current multiplier
/// (read from the mint's ScaledUiAmountConfig extension).
///
/// This is the SVM equivalent of EVM's `setOkuMMultiplier(uint256)`.
///
/// Rejects `new_multiplier == current` so a no-op call cannot stamp
/// the sandwich-lock slot without actually moving the multiplier (which
/// would waste the lock window for the entire slot). Mirrors the
/// `YieldTooSmall` guard on `distribute_yield`.
pub fn set_multiplier(ctx: Context<SetMultiplier>, new_multiplier: u64) -> Result<()> {
    // Self-fence on the yield slot. Two yield-affecting writes in the same
    // slot would otherwise be legal (strict-increase admits the second),
    // defeating the "one yield event per slot" invariant. Strict-increase
    // alone catches no-op writes; this catches near-no-op writes that would
    // still consume the same-slot lock budget.
    check_yield_lock(&ctx.accounts.config)?;

    // Read current multiplier from the OkuM mint's ScaledUiAmountConfig extension
    let current_multiplier =
        crate::helpers::scaled_ui::read_multiplier(&ctx.accounts.oku_m_mint.to_account_info())?;

    // Strict increase — see fn-level doc for rationale.
    require!(
        new_multiplier > current_multiplier,
        LitePsmError::MultiplierCannotDecrease
    );

    // Math-sanity ceiling — keeps the downstream `u64 * u64 -> u128`
    // multiplications inside the overflow-safe region. Not a guard against
    // a malicious operator (which is out of scope per the centralized
    // trust model) but a math bound. See `MAX_MULTIPLIER` in
    // `oku-shared/constants.rs`.
    require!(
        new_multiplier <= MAX_MULTIPLIER,
        LitePsmError::MultiplierAboveMax
    );

    let clock = write_multiplier_and_stamp(
        new_multiplier,
        current_multiplier,
        &mut ctx.accounts.config,
        &ctx.accounts.oku_m_mint.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
    )?;

    emit!(MultiplierUpdated {
        old_multiplier: current_multiplier,
        new_multiplier,
        total_supply: ctx.accounts.oku_m_mint.supply,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Distribute dollar-denominated yield across all OkuM holders
///
/// new_multiplier = old_multiplier + (yield_amount * PRECISION / total_supply)
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
///
/// This is the SVM equivalent of EVM's `distributeYield(uint256 yieldAmount)`.
pub fn distribute_yield(ctx: Context<DistributeYield>, yield_amount: u64) -> Result<()> {
    // Self-fence on the yield slot. See `set_multiplier` for rationale.
    check_yield_lock(&ctx.accounts.config)?;

    require!(yield_amount > 0, LitePsmError::ZeroAmount);

    let total_supply = ctx.accounts.oku_m_mint.supply;
    require!(total_supply > 0, LitePsmError::ZeroAmount);

    // Read current multiplier from the OkuM mint's ScaledUiAmountConfig extension
    let current_multiplier =
        crate::helpers::scaled_ui::read_multiplier(&ctx.accounts.oku_m_mint.to_account_info())?;

    // Per-token yield increment: `(yield_amount * PRECISION) / total_supply`,
    // floored via the shared `mul_div_floor` primitive (u128 widening +
    // try_from narrowing).
    let yield_per_token = oku_shared::mul_div_floor(yield_amount, PRECISION, total_supply)
        .ok_or(LitePsmError::Overflow)?;

    // Prevent no-op distributions that waste the yield lock slot
    // This can happen when yield_amount is tiny relative to total_supply
    require!(yield_per_token > 0, LitePsmError::YieldTooSmall);

    let new_multiplier = current_multiplier
        .checked_add(yield_per_token)
        .ok_or(LitePsmError::Overflow)?;

    // Sanity ceiling — see `set_multiplier` for rationale.
    require!(
        new_multiplier <= MAX_MULTIPLIER,
        LitePsmError::MultiplierAboveMax
    );

    let clock = write_multiplier_and_stamp(
        new_multiplier,
        current_multiplier,
        &mut ctx.accounts.config,
        &ctx.accounts.oku_m_mint.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
    )?;

    emit!(YieldDistributed {
        yield_amount,
        old_multiplier: current_multiplier,
        new_multiplier,
        total_supply,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
