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
use crate::contexts::{DistributeYield, SetMultiplier, SyncWindow};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{arm_sync_window, check_yield_lock};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;
use oku_shared::{
    step_bps_ceil, step_is_covered, sync_window_end, sync_window_gap_elapsed,
    MIN_SYNC_WINDOW_GAP_SECS,
};

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
/// profit at all — that is `tout`'s job, and `tout` handles it regardless
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
    // Refuse to create exposure the current `tout` does not cover. At
    // `tout_bps == 0` this rejects every increase, so rebasing is impossible
    // until a fee is configured — the operator cannot create the arbitrage
    // condition rather than being trusted not to.
    //
    // Half 2 is the `max_step_bps` floor in `set_fees`, which stops the fee
    // being lowered afterwards. Neither half is sufficient alone.
    require!(
        step_is_covered(current_multiplier, new_multiplier, config.tout_bps),
        LitePsmError::StepExceedsFeeCoverage
    );

    // Record the step so the fee can never later drop below it. Ceiled, since
    // the mark becomes a floor. `proof_mark_never_exceeds_permitting_fee`
    // guarantees this cannot invalidate the fee that just permitted the step.
    let step_bps =
        step_bps_ceil(current_multiplier, new_multiplier).ok_or(LitePsmError::Overflow)?;
    if step_bps > config.max_step_bps {
        config.max_step_bps = step_bps;
    }

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

    // Attest that a write actually landed in the current epoch. `end_sync_window`
    // requires this, so a window cannot be opened and closed with nothing having
    // happened — which would otherwise leave `sync_epoch` claiming a completed
    // tick against an untouched multiplier, and make the cross-chain parity
    // check report a false OK.
    config.last_write_epoch = config.sync_epoch;

    // Fail-closed: arm the sync window on every multiplier write, so a
    // tick can never land completely unfenced even if the orchestrator
    // forgot to open a window first.
    //
    // Clamped, never fatal — if the inter-window gap has not elapsed this
    // declines to re-arm and the write still succeeds. See
    // `helpers::sync_window::arm_sync_window` for why a multiplier write
    // must never be rejectable on window state.
    let armed = arm_sync_window(config, clock.unix_timestamp);
    if armed {
        emit!(SyncWindowOpened {
            epoch: config.sync_epoch,
            until_ts: config.sync_lock_until_ts,
            auto_armed: true,
            timestamp: clock.unix_timestamp,
        });
    }

    Ok(clock)
}

/// Open a cross-chain multiplier sync window (REBASER only).
///
/// Blocks the price-sensitive instructions (`mint_oku_m`, `redeem_oku_m`)
/// while a multiplier tick propagates between EVM and SVM, so nobody can
/// transact against a price only one chain has updated.
///
/// # Epoch discipline
///
/// `epoch` must be exactly `stored + 1`. The orchestrator assigns the same
/// number on both chains for a given tick, which makes
/// `epoch_evm == epoch_svm` an externally checkable statement that no tick
/// is mid-flight. Requiring strict succession stops a replayed or
/// out-of-order open from silently reusing a number and defeating that
/// check.
///
/// # Liveness
///
/// The window auto-expires after at most `MAX_SYNC_WINDOW_SECS`; there is
/// no code path that extends it indefinitely, so a dead orchestrator
/// cannot brick redemption. `MIN_SYNC_WINDOW_GAP_SECS` between windows
/// bounds the duty cycle, giving an on-chain availability floor.
pub fn begin_sync_window(ctx: Context<SyncWindow>, epoch: u64) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;

    let expected = config
        .sync_epoch
        .checked_add(1)
        .ok_or(LitePsmError::Overflow)?;
    require!(epoch == expected, LitePsmError::EpochMismatch);

    // Unlike the auto-arm path, an explicit open DOES fail on an
    // unelapsed gap. Nothing depends on this call succeeding for the
    // protocol to stay safe, so it is free to be strict — and being
    // strict here is what makes the availability floor enforceable.
    require!(
        sync_window_gap_elapsed(
            config.sync_lock_until_ts,
            clock.unix_timestamp,
            MIN_SYNC_WINDOW_GAP_SECS
        ),
        LitePsmError::SyncWindowGapNotElapsed
    );

    config.sync_epoch = epoch;
    config.sync_lock_until_ts = sync_window_end(clock.unix_timestamp, config.sync_window_secs);

    emit!(SyncWindowOpened {
        epoch,
        until_ts: config.sync_lock_until_ts,
        auto_armed: false,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Close the current sync window early (REBASER only).
///
/// Called once the orchestrator has confirmed the tick landed on every
/// chain. `epoch` must equal the stored epoch, so a stale release cannot
/// close a window it never observed.
///
/// Truncates `sync_lock_until_ts` to now rather than zeroing it: that
/// field doubles as the anchor for the inter-window gap check, and zeroing
/// would reset the gap and let windows be chained back-to-back.
pub fn end_sync_window(ctx: Context<SyncWindow>, epoch: u64) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;

    require!(epoch == config.sync_epoch, LitePsmError::EpochMismatch);

    // A window may only be closed if a multiplier write actually landed in it.
    //
    // Without this, "open, forget to write, close" advances `sync_epoch` against
    // an untouched multiplier, and the cross-chain parity check — which compares
    // epochs — reports OK. That is a false negative on the only completion check
    // the system has. With it, `sync_epoch` means "this chain wrote for tick N".
    //
    // If the write genuinely cannot be made, let the window auto-expire instead;
    // the epoch then visibly lags, which is the correct signal.
    require!(
        config.last_write_epoch == epoch,
        LitePsmError::NoWriteInEpoch
    );

    // Only ever move the end backwards. Guards against a same-second
    // double-close pushing the gap anchor forward.
    if config.sync_lock_until_ts > clock.unix_timestamp {
        config.sync_lock_until_ts = clock.unix_timestamp;
    }

    emit!(SyncWindowClosed {
        epoch,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
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
