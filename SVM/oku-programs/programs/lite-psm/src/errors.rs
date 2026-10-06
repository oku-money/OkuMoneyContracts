//! # OkuM Lite-PSM Errors
//!
//! Error codes for the Lite-PSM program. The EVM custom error each one
//! corresponds to, where an equivalent exists, is named on the variant.
//! `Unauthorized` and `Paused` have no EVM custom error (AccessControl and
//! Pausable revert with their own).

use anchor_lang::prelude::*;

#[error_code]
pub enum LitePsmError {
    // ===== Authorization Errors =====
    #[msg("Caller not authorized")]
    Unauthorized,

    // ===== State Errors =====
    #[msg("Program is paused")]
    Paused,

    #[msg("Program is already paused")]
    AlreadyPaused,

    #[msg("Program is not paused")]
    NotPaused,

    // ===== Supply/Allowance Errors =====
    /// EVM: ExceedsSupplyCap()
    #[msg("Mint would exceed max supply")]
    MaxSupplyExceeded,

    /// Proposed `max_supply` is below the current circulating supply.
    /// Setting it would silently block all future mints.
    #[msg("New max_supply must be >= current circulating supply")]
    BelowCurrentSupply,

    /// EVM: ExceedsAllowance()
    #[msg("Mint would exceed minter allowance")]
    AllowanceExceeded,

    // ===== Buffer Errors =====
    /// The USDC buffer vault cannot cover the redemption.
    /// EVM: InsufficientBuffer()
    #[msg("Insufficient buffer for redemption")]
    InsufficientBuffer,

    /// The user does not hold enough OkuM to satisfy the redemption.
    /// Distinct from `InsufficientBuffer` (which is about the vault) so the
    /// failure reason is unambiguous.
    /// EVM analogue: `ERC20InsufficientBalance`.
    #[msg("User does not hold enough OkuM for redemption")]
    InsufficientUserBalance,

    // ===== Arithmetic Errors =====
    #[msg("Arithmetic overflow")]
    Overflow,

    // ===== Input Validation Errors =====
    /// EVM: ZeroAmount()
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    // ===== Yield Distribution Errors =====
    /// EVM: OverrideInProgress()
    #[msg("Cannot perform operation in same slot as yield distribution")]
    OverrideInProgress,

    /// New multiplier did not strictly increase. Reverts on both backward
    /// moves and no-op (equal-value) updates, so a no-op call cannot stamp
    /// the sandwich-lock slot without moving the multiplier.
    /// EVM: MultiplierCannotDecrease()
    #[msg("New multiplier must strictly increase")]
    MultiplierCannotDecrease,

    // ===== Rate schedule =====
    //
    // Mirrors the rails in EVM `OkuMoney._setOkuMYieldRate` /
    // `_setNextOkuMYieldRate`.
    /// Rate below `PRECISION`. The multiplier is monotonic — there is no
    /// on-chain representation of a loss, so a sub-unity rate is meaningless.
    /// Over-payment is corrected by publishing a SLOWER rate next epoch.
    /// EVM: InvalidRate()
    #[msg("Rate must be >= PRECISION (the multiplier cannot decrease)")]
    InvalidRate,

    /// Rate above `MAX_RATE` (~2242% APY). A sanity bound on `rpow` inputs.
    /// EVM: RateTooHigh()
    #[msg("Rate exceeds MAX_RATE")]
    RateTooHigh,

    /// A halting rate (`== PRECISION`) was given a non-zero window. Halted
    /// rates carry no window by construction.
    /// EVM: EndTimestampNotAllowed()
    #[msg("A halted rate must not carry an end timestamp")]
    EndTimestampNotAllowed,

    /// A yielding rate was given an end timestamp at or before now.
    ///
    /// Every yielding rate MUST carry a bounded window in the future, so that
    /// an unattended schedule halts rather than compounding forever, and so a
    /// rate can never expire at a transaction-dependent, per-chain moment.
    /// EVM: EndTimestampInPast()
    #[msg("A yielding rate requires an end timestamp in the future")]
    EndTimestampInPast,

    /// A single rate window exceeded `MAX_RATE_WINDOW_SECONDS` (90 days).
    ///
    /// An unbounded window can drive `rpow` past 256 bits; once
    /// `compute_multiplier` starts returning `None`, every instruction that
    /// could rewrite the schedule re-anchors through `multiplier::at` and so
    /// fails too — including the emergency override. Applies independently to
    /// the active window and to a successor's own `[rate_end, pending_end]`
    /// span. EVM: RateWindowTooLong()
    #[msg("Rate window exceeds the maximum permitted length (90 days)")]
    RateWindowTooLong,

    /// EVM: NoRateEndSet()
    #[msg("Cannot stage a successor: no active rate window is set")]
    NoRateEndSet,

    /// Tried to stage a successor against an already-expired window, which
    /// would snapshot unearned yield.
    /// EVM: RateAlreadyExpired()
    #[msg("Cannot stage a successor: the active rate window has already expired")]
    RateAlreadyExpired,

    /// EVM: PendingEndNotAfterRateEnd()
    #[msg("Successor expiry must be strictly after the active rate end")]
    PendingEndNotAfterRateEnd,

    /// Proposed multiplier exceeds the configured ceiling. A math-sanity
    /// bound that keeps downstream `u64 * u64 -> u128` multiplications inside
    /// the overflow-safe region.
    #[msg("Proposed multiplier exceeds MAX_MULTIPLIER ceiling")]
    MultiplierAboveMax,

    /// `compute_multiplier` could not produce a value for the current schedule
    /// and timestamp — an `rpow` intermediate exceeded `u128`, or a timestamp
    /// was negative.
    ///
    /// Unreachable for any schedule the writers can produce: rates are bounded
    /// by `MAX_RATE`, windows are bounded, and timestamps come from `Clock`.
    /// Surfaced rather than swallowed because this is a view on the hot path —
    /// a wrong number here would misprice every mint and redeem.
    #[msg("Multiplier could not be computed from the current rate schedule")]
    MultiplierOutOfRange,

    #[msg("Failed to update ScaledUiAmount multiplier")]
    MultiplierUpdateFailed,

    // ===== Authority validation =====
    #[msg("Authority pubkey is invalid (e.g. zero pubkey)")]
    InvalidAuthority,

    /// `accept_role_admin` was called but no proposal is in flight
    /// (`pending_role_admin == Pubkey::default()`).
    #[msg("No pending role-admin transfer to accept")]
    NoPendingRoleAdmin,

    #[msg("Caller is not the pending role admin")]
    NotPendingRoleAdmin,

    // ===== Initialization Errors =====
    #[msg("USDC mint must have exactly 6 decimals")]
    InvalidUsdcDecimals,

    // ===== PSM Math Errors =====
    /// Mint output rounded down to zero (multiplier too high relative to input).
    /// EVM: AmountTooSmall()
    #[msg("Output amount too small (rounds to zero)")]
    AmountTooSmall,

    /// Redeem output rounded down to zero. At a low `raw_oku_m_amount` and a
    /// near-unit multiplier the floor division truncates to zero, which would
    /// burn OkuM for no USDC.
    #[msg("Redeem output is zero")]
    ZeroOutput,

    /// Redeem output is below the caller's `min_usdc_out` slippage floor.
    /// EVM: OutputBelowMinimum()
    #[msg("Redeem output is below min_usdc_out")]
    SlippageExceeded,
}
