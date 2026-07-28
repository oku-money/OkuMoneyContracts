//! # OkuM Lite-PSM Errors
//!
//! Error codes for the Lite-PSM program.
//! Aligned with EVM custom errors where applicable.
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
//! | `OutputBelowMinimum` | N/A (zero-output guard; EVM uses `OutputBelowMinimum` for slippage) |
//! | `AmountTooSmall` | `AmountTooSmall()` |
//! | `InvalidUsdcDecimals` | (initialize-time decimals check) |

use anchor_lang::prelude::*;

#[error_code]
pub enum LitePsmError {
    // ===== Authorization Errors =====
    /// Caller not authorized for this operation
    #[msg("Caller not authorized")]
    Unauthorized,

    // ===== State Errors =====
    /// Program is paused
    /// EVM: Pausable revert
    #[msg("Program is paused")]
    Paused,

    /// Program is already paused
    #[msg("Program is already paused")]
    AlreadyPaused,

    /// Program is not paused
    #[msg("Program is not paused")]
    NotPaused,

    // ===== Supply/Allowance Errors =====
    /// Mint would exceed max supply
    /// EVM: ExceedsSupplyCap()
    #[msg("Mint would exceed max supply")]
    MaxSupplyExceeded,

    /// Proposed `max_supply` is below the current circulating supply.
    /// Setting it would silently brick all future mints. EVM
    /// `OkuM.setMaxSupply` parity.
    #[msg("New max_supply must be >= current circulating supply")]
    BelowCurrentSupply,

    /// Mint would exceed minter allowance
    /// EVM: ExceedsAllowance()
    #[msg("Mint would exceed minter allowance")]
    AllowanceExceeded,

    // ===== Buffer Errors =====
    /// Insufficient buffer for redemption
    /// EVM: InsufficientBuffer()
    #[msg("Insufficient buffer for redemption")]
    InsufficientBuffer,

    /// User does not hold enough OkuM to satisfy the redemption.
    /// Cycle 4 (PSM-11): separated from `InsufficientBuffer` to remove
    /// the misleading "the PSM's buffer is empty" interpretation.
    /// EVM analogue: `ERC20InsufficientBalance` (OZ standard revert).
    #[msg("User does not hold enough OkuM for redemption")]
    InsufficientUserBalance,

    // ===== Arithmetic Errors =====
    /// Arithmetic overflow
    #[msg("Arithmetic overflow")]
    Overflow,

    // ===== Input Validation Errors =====
    /// Amount must be greater than zero
    /// EVM: ZeroAmount()
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    // ===== Yield Distribution Errors =====
    /// Cannot perform operation in same slot as yield distribution
    /// EVM: YieldDistributionInProgress()
    #[msg("Cannot perform operation in same slot as yield distribution")]
    YieldDistributionInProgress,

    /// New multiplier did not strictly increase. Reverts on both backward
    /// moves and no-op (equal-value) updates so a no-op call cannot stamp
    /// the sandwich-lock slot without moving the multiplier.
    /// EVM: MultiplierCannotDecrease()
    #[msg("New multiplier must strictly increase")]
    MultiplierCannotDecrease,

    /// Yield amount too small to affect multiplier (truncates to zero)
    #[msg("Yield amount too small to affect multiplier (truncates to zero)")]
    YieldTooSmall,

    /// Proposed multiplier exceeds the configured ceiling.
    /// Math-sanity bound that keeps downstream `u64 * u64 -> u128`
    /// multiplications inside the overflow-safe region. Not a guard
    /// against operator compromise (out of scope per the centralized
    /// trust model) but a math bound.
    #[msg("Proposed multiplier exceeds MAX_MULTIPLIER ceiling")]
    MultiplierAboveMax,

    /// Failed to read multiplier from ScaledUiAmount extension
    #[msg("Failed to read multiplier from ScaledUiAmount extension")]
    MultiplierReadFailed,

    /// Failed to update ScaledUiAmount multiplier
    #[msg("Failed to update ScaledUiAmount multiplier")]
    MultiplierUpdateFailed,

    // ===== Authority validation =====
    /// Authority pubkey is the zero pubkey or otherwise invalid
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
    /// EVM uses a runtime-resolved `usdcDecimalMultiplier`; SVM hardcodes 6.
    #[msg("USDC mint must have exactly 6 decimals")]
    InvalidUsdcDecimals,

    // ===== PSM Math Errors =====
    /// Mint output rounded down to zero (multiplier too high relative to input).
    /// EVM: AmountTooSmall()
    #[msg("Output amount too small (rounds to zero)")]
    AmountTooSmall,

    /// Redeem output is zero. At low `raw_oku_m_amount` and near-unit
    /// multiplier, the floor division can truncate to zero, which would
    /// burn OkuM for no USDC.
    #[msg("Redeem output is zero")]
    OutputBelowMinimum,
}
