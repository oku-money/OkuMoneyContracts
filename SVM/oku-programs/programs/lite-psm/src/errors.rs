//! # OkuMoney Lite-PSM Errors
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
//! | `PriceCannotDecrease` | `MultiplierCannotDecrease()` |
//! | `YieldDistributionInProgress` | `YieldDistributionInProgress()` |
//! | `OutputBelowMinimum` | `OutputBelowMinimum(uint256 actual, uint256 minimum)` |
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
    /// `OkuMoney.setMaxSupply` parity.
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

    /// User does not hold enough OkuMoney to satisfy the redemption.
    /// Cycle 4 (PSM-11): separated from `InsufficientBuffer` to remove
    /// the misleading "the PSM's buffer is empty" interpretation.
    /// EVM analogue: `ERC20InsufficientBalance` (OZ standard revert).
    #[msg("User does not hold enough OkuMoney for redemption")]
    InsufficientUserBalance,

    // ===== Queue Errors =====
    /// Queue is empty
    #[msg("Queue is empty")]
    QueueEmpty,

    /// Queue is full
    #[msg("Queue is full")]
    QueueFull,

    /// Invalid queue index
    #[msg("Invalid queue index")]
    InvalidQueueIndex,

    /// Queue entry already cleared
    #[msg("Queue entry already cleared")]
    EntryAlreadyCleared,

    // ===== Arithmetic Errors =====
    /// Arithmetic overflow
    #[msg("Arithmetic overflow")]
    Overflow,

    // ===== Input Validation Errors =====
    /// Amount must be greater than zero
    /// EVM: ZeroAmount()
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    /// Not enough accounts provided for queue entries
    #[msg("Not enough accounts provided for queue entries")]
    InsufficientAccounts,

    // ===== Yield Distribution Errors =====
    /// Cannot perform operation in same slot as yield distribution
    /// EVM: YieldDistributionInProgress()
    #[msg("Cannot perform operation in same slot as yield distribution")]
    YieldDistributionInProgress,

    /// New price did not strictly increase. Reverts on both backward moves
    /// and no-op (equal-value) updates so a no-op call cannot stamp the
    /// sandwich-lock slot without moving the multiplier.
    /// EVM: MultiplierCannotDecrease()
    #[msg("New price must strictly increase")]
    PriceCannotDecrease,

    /// Yield amount too small to affect price (truncates to zero)
    #[msg("Yield amount too small to affect price (truncates to zero)")]
    YieldTooSmall,

    /// Proposed `oku_m_price` exceeds the configured ceiling.
    /// Math-sanity bound that keeps downstream `u64 * u64 -> u128`
    /// multiplications inside the overflow-safe region. Not a guard
    /// against operator compromise (out of scope per the centralized
    /// trust model) but a math bound.
    #[msg("Proposed oku_m_price exceeds MAX_OKU_M_PRICE ceiling")]
    PriceAboveMax,

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

    /// Escrow vault already initialized
    #[msg("Escrow vault already initialized")]
    EscrowAlreadyInitialized,

    /// PsmConfig is already at the new size (migration not needed).
    #[msg("PsmConfig already migrated to current layout")]
    MigrationNotNeeded,

    // ===== Initialization Errors =====
    /// USDC mint must have exactly 6 decimals on Solana.
    /// EVM uses a runtime-resolved `usdcDecimalMultiplier`; SVM hardcodes 6.
    #[msg("USDC mint must have exactly 6 decimals")]
    InvalidUsdcDecimals,

    /// OkuMoney mint must have exactly 6 decimals on Solana.
    /// All PSM math (oku_m_price, distribute_yield, oku_m_to_dollars)
    /// assumes 6-decimal raw token amounts; a mismatched decimal count
    /// would silently break every accounting path.
    #[msg("OkuMoney mint must have exactly 6 decimals")]
    InvalidOkuMoneyDecimals,

    // ===== PSM Math / Slippage Errors =====
    /// Mint output rounded down to zero (oku_m_price too high relative to input).
    /// EVM: AmountTooSmall()
    #[msg("Output amount too small (rounds to zero)")]
    AmountTooSmall,

    /// Redeem output below user-specified minimum (slippage exceeded).
    /// EVM: OutputBelowMinimum(uint256 actual, uint256 minimum)
    #[msg("Output below minimum (slippage exceeded)")]
    OutputBelowMinimum,

    // ===== Phase 10 / Cycle 4: mint extension invariants =====
    /// The OkuMoney mint carries a Token-2022 extension that the protocol
    /// does not support. Cycle 4 widened the original `TransferHook`-only
    /// check to a full allow-list (see `helpers::mint_extensions`); any
    /// extension not on the whitelist trips this error at `initialize`.
    /// Same hard reject is applied at the `oku-dollar` initialize boundary
    /// so both programs agree on what a clean OkuMoney mint looks like.
    #[msg("OkuMoney mint carries an incompatible Token-2022 extension (see helpers::mint_extensions for the allow-list)")]
    IncompatibleMintExtension,

    // ===== ScaledUiAmountConfig extension errors =====
    /// The OkuMoney mint does not carry the expected `ScaledUiAmountConfig`
    /// extension, or the extension data could not be parsed.
    #[msg("OkuMoney mint missing or corrupt ScaledUiAmountConfig extension")]
    InvalidMintExtension,

    /// The OkuMoney price read from the `ScaledUiAmountConfig` extension
    /// is zero or negative. This should never happen in normal operation;
    /// a zero multiplier would break all PSM math.
    #[msg("OkuMoney price from ScaledUiAmountConfig is zero or invalid")]
    InvalidPrice,
}
