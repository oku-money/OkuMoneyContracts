//! Lite-PSM error codes. Where an EVM custom error has the same name the variant
//! is undocumented; otherwise the EVM name is given. `Unauthorized` and `Paused`
//! have no EVM custom error (AccessControl / Pausable revert with their own).

use anchor_lang::prelude::*;

#[error_code]
pub enum LitePsmError {
    #[msg("Caller not authorized")]
    Unauthorized,

    #[msg("Program is paused")]
    Paused,

    #[msg("Program is already paused")]
    AlreadyPaused,

    #[msg("Program is not paused")]
    NotPaused,

    /// EVM: ExceedsSupplyCap
    #[msg("Mint would exceed max supply")]
    MaxSupplyExceeded,

    /// A cap below circulating supply would silently block all future mints.
    #[msg("New max_supply must be >= current circulating supply")]
    BelowCurrentSupply,

    /// EVM: ExceedsAllowance
    #[msg("Mint would exceed minter allowance")]
    AllowanceExceeded,

    /// EVM's carries `(available, required)` fields.
    #[msg("Insufficient buffer for redemption")]
    InsufficientBuffer,

    /// The user's balance, as opposed to the vault's (`InsufficientBuffer`).
    /// EVM: ERC20InsufficientBalance
    #[msg("User does not hold enough OkuM for redemption")]
    InsufficientUserBalance,

    #[msg("Arithmetic overflow")]
    Overflow,

    /// A zero amount was passed. Also returned if the multiplier is zero, which
    /// no schedule can produce.
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    /// Retry in the next slot. EVM: OverrideInProgress
    #[msg("Cannot perform operation in the same slot as a multiplier override")]
    OverrideInProgress,

    /// Also rejects a no-op override, which would stamp the yield lock without
    /// moving the multiplier.
    #[msg("New multiplier must strictly increase")]
    MultiplierCannotDecrease,

    /// Rate below `PRECISION`: the multiplier is monotonic, so a loss has no
    /// on-chain representation.
    #[msg("Rate must be >= PRECISION (the multiplier cannot decrease)")]
    InvalidRate,

    /// Rate above `MAX_RATE` (~2242% APY), a sanity bound on `rpow` inputs.
    #[msg("Rate exceeds MAX_RATE")]
    RateTooHigh,

    /// A halted rate (`== PRECISION`) carries no window.
    #[msg("A halted rate must not carry an end timestamp")]
    EndTimestampNotAllowed,

    /// Every yielding rate needs a future window so an unattended schedule halts.
    #[msg("A yielding rate requires an end timestamp in the future")]
    EndTimestampInPast,

    /// Applies to the active window and, independently, to a successor's own
    /// span. An unbounded window could push `rpow` past 256 bits and brick every
    /// schedule writer, including the emergency override.
    #[msg("Rate window exceeds the maximum permitted length (90 days)")]
    RateWindowTooLong,

    /// `set_next_okum_yield_rate` with no active window (halted schedule).
    /// EVM: NoRateEndSet
    #[msg("Cannot stage a successor: no active rate window is set")]
    NoRateEndSet,

    /// The active window has already ended, so the successor would never be the
    /// one taking over. EVM: RateAlreadyExpired
    #[msg("Cannot stage a successor: the active rate window has already expired")]
    RateAlreadyExpired,

    /// EVM: PendingEndNotAfterRateEnd
    #[msg("Successor expiry must be strictly after the active rate end")]
    PendingEndNotAfterRateEnd,

    /// A math-sanity ceiling at 1e18 precision, keeping 256-bit intermediates in range.
    #[msg("Proposed multiplier exceeds MAX_MULTIPLIER ceiling")]
    MultiplierTooHigh,

    /// Unreachable for schedules the writers can produce. Surfaced rather than
    /// swallowed: a wrong value here would misprice every mint and redeem.
    #[msg("Multiplier could not be computed from the current rate schedule")]
    MultiplierOutOfRange,

    /// The Token-2022 `ScaledUiAmount` update CPI failed (display mirror only).
    /// No EVM equivalent.
    #[msg("Failed to update ScaledUiAmount multiplier")]
    MultiplierUpdateFailed,

    #[msg("Authority pubkey is invalid (e.g. zero pubkey)")]
    InvalidAuthority,

    #[msg("No pending role-admin transfer to accept")]
    NoPendingRoleAdmin,

    #[msg("Caller is not the pending role admin")]
    NotPendingRoleAdmin,

    /// `initialize` was given a USDC mint without `USDC_DECIMALS` decimals.
    /// EVM: UsdcDecimalsTooLarge (EVM accepts any decimals up to 18)
    #[msg("USDC mint must have exactly 6 decimals")]
    InvalidUsdcDecimals,

    /// Mint output rounded down to zero (redeem output cannot).
    #[msg("Output amount too small (rounds to zero)")]
    AmountTooSmall,

    /// No EVM PSM equivalent (EVM has no slippage parameter).
    #[msg("Redeem output is below min_usdc_out")]
    SlippageExceeded,
}
