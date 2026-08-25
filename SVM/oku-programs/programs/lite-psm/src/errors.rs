//! # OkuM Lite-PSM Errors
//!
//! Error codes for the Lite-PSM program. Aligned with the EVM custom
//! errors where an equivalent exists.
//!
//! ## EVM Error Mapping
//!
//! | SVM Error | EVM Equivalent |
//! |-----------|----------------|
//! | `Unauthorized` | N/A (AccessControl revert) |
//! | `Paused` | N/A (Pausable revert) |
//! | `MaxSupplyExceeded` | `ExceedsSupplyCap()` |
//! | `AllowanceExceeded` | `ExceedsAllowance()` |
//! | `InsufficientBuffer` | `InsufficientBuffer()` |
//! | `MultiplierCannotDecrease` | `MultiplierCannotDecrease()` |
//! | `YieldDistributionInProgress` | `YieldDistributionInProgress()` |
//! | `SlippageExceeded` | `OutputBelowMinimum()` |
//! | `AmountTooSmall` | `AmountTooSmall()` |
//! | `InvalidUsdcDecimals` | (initialize-time decimals check) |

use anchor_lang::prelude::*;

#[error_code]
pub enum LitePsmError {
    // ===== Authorization Errors =====
    /// Caller not authorized for this operation.
    #[msg("Caller not authorized")]
    Unauthorized,

    // ===== State Errors =====
    /// Program is paused.
    #[msg("Program is paused")]
    Paused,

    /// Program is already paused.
    #[msg("Program is already paused")]
    AlreadyPaused,

    /// Program is not paused.
    #[msg("Program is not paused")]
    NotPaused,

    // ===== Supply/Allowance Errors =====
    /// Mint would exceed max supply.
    /// EVM: ExceedsSupplyCap()
    #[msg("Mint would exceed max supply")]
    MaxSupplyExceeded,

    /// Proposed `max_supply` is below the current circulating supply.
    /// Setting it would silently block all future mints.
    #[msg("New max_supply must be >= current circulating supply")]
    BelowCurrentSupply,

    /// Mint would exceed minter allowance.
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
    /// Arithmetic overflow.
    #[msg("Arithmetic overflow")]
    Overflow,

    // ===== Input Validation Errors =====
    /// Amount must be greater than zero.
    /// EVM: ZeroAmount()
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    // ===== Yield Distribution Errors =====
    /// Cannot perform this operation in the same slot as a yield distribution.
    /// EVM: YieldDistributionInProgress()
    #[msg("Cannot perform operation in same slot as yield distribution")]
    YieldDistributionInProgress,

    /// New multiplier did not strictly increase. Reverts on both backward
    /// moves and no-op (equal-value) updates, so a no-op call cannot stamp
    /// the sandwich-lock slot without moving the multiplier.
    /// EVM: MultiplierCannotDecrease()
    #[msg("New multiplier must strictly increase")]
    MultiplierCannotDecrease,

    /// Yield amount too small to affect the multiplier (truncates to zero).
    #[msg("Yield amount too small to affect multiplier (truncates to zero)")]
    YieldTooSmall,

    /// Proposed multiplier exceeds the configured ceiling. A math-sanity
    /// bound that keeps downstream `u64 * u64 -> u128` multiplications inside
    /// the overflow-safe region.
    #[msg("Proposed multiplier exceeds MAX_MULTIPLIER ceiling")]
    MultiplierAboveMax,

    /// The OkuM mint account data could not be unpacked as a Token-2022 mint.
    #[msg("Failed to unpack OkuM mint account data")]
    MultiplierUnpackFailed,

    /// The OkuM mint does not carry the `ScaledUiAmount` extension.
    #[msg("OkuM mint is missing the ScaledUiAmount extension")]
    ScaledUiExtensionMissing,

    /// The multiplier read from the `ScaledUiAmount` extension is zero or
    /// exceeds `MAX_MULTIPLIER` (e.g. an uninitialized, NaN, or corrupt f64).
    #[msg("Multiplier from ScaledUiAmount extension is zero or out of range")]
    MultiplierOutOfRange,

    /// Failed to update the `ScaledUiAmount` multiplier.
    #[msg("Failed to update ScaledUiAmount multiplier")]
    MultiplierUpdateFailed,

    // ===== Authority validation =====
    /// Authority pubkey is the zero pubkey or otherwise invalid.
    #[msg("Authority pubkey is invalid (e.g. zero pubkey)")]
    InvalidAuthority,

    /// `accept_role_admin` was called but no proposal is in flight
    /// (`pending_role_admin == Pubkey::default()`).
    #[msg("No pending role-admin transfer to accept")]
    NoPendingRoleAdmin,

    /// `accept_role_admin` caller is not the proposed `pending_role_admin`.
    #[msg("Caller is not the pending role admin")]
    NotPendingRoleAdmin,

    // ===== Initialization Errors =====
    /// USDC mint must have exactly 6 decimals on Solana.
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

    // ===== Cross-chain sync window =====
    //
    // NOTE: appended deliberately. Anchor derives error codes from enum
    // position, so inserting anywhere above would silently renumber every
    // subsequent variant and invalidate every client that maps codes to
    // names (including the bankrun assertions and the operator CLIs).
    /// A multiplier tick is propagating across chains; price-sensitive
    /// operations are blocked until it lands on both sides.
    /// EVM: SyncWindowActive()
    #[msg("Cross-chain multiplier sync window is active")]
    SyncWindowActive,

    /// `begin_sync_window` was called before `MIN_SYNC_WINDOW_GAP_SECS`
    /// elapsed since the previous window closed. This bound is what stops
    /// chained windows becoming an indefinite redemption lock.
    ///
    /// Note this error is reachable only from the explicit entrypoint. On
    /// the multiplier-write path an unelapsed gap silently declines to
    /// re-arm rather than failing, so the multiplier setter is never
    /// censorable.
    #[msg("Minimum gap between sync windows has not elapsed")]
    SyncWindowGapNotElapsed,

    /// The supplied sync epoch does not follow the stored one
    /// (`begin_sync_window` requires exactly `stored + 1`) or does not
    /// match it (`end_sync_window` requires equality).
    ///
    /// Equality on close makes the call idempotent-safe and prevents a
    /// stale release from closing a window it never observed.
    #[msg("Sync epoch does not match the expected value")]
    EpochMismatch,

    /// Proposed `sync_window_secs` exceeds `MAX_SYNC_WINDOW_SECS`, or is
    /// negative.
    #[msg("Proposed sync window exceeds MAX_SYNC_WINDOW_SECS")]
    SyncWindowTooLong,

    // ===== Fees =====
    /// Proposed `tin_bps` / `tout_bps` exceeds `MAX_FEE_BPS`.
    #[msg("Proposed fee exceeds MAX_FEE_BPS")]
    FeeAboveMax,

    // ===== Step-arbitrage coverage =====
    /// The proposed multiplier step is larger than `tout_bps` covers, so a
    /// mint-hold-redeem round trip across it would be profitable.
    ///
    /// At `tout_bps == 0` this rejects EVERY increase — rebasing is impossible
    /// until a redemption fee is configured. That is deliberate: it makes the
    /// operator unable to create the arbitrage condition rather than merely
    /// trusted not to.
    #[msg("Multiplier step exceeds what tout_bps covers (raise tout or take a smaller step)")]
    StepExceedsFeeCoverage,

    /// The proposed `tout_bps` is below `max_step_bps`, the high-water mark of
    /// steps already taken.
    ///
    /// Lowering it would retroactively un-cover a past step and hand a cheap
    /// exit to anyone who held across it. Clear the mark with
    /// `reset_step_high_water_mark` first, understanding that doing so reopens
    /// that historical exposure.
    #[msg("Proposed tout_bps is below the step high-water mark")]
    FeeBelowStepHighWaterMark,

    /// `end_sync_window` was called for an epoch in which no multiplier write
    /// landed. Closing here would leave `sync_epoch` claiming a tick completed
    /// against an untouched multiplier.
    #[msg("No multiplier write landed in this sync epoch")]
    NoWriteInEpoch,
}
