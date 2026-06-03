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
//! | `InvalidStaleness` | `StalenessOutOfBounds(uint256 staleness)` |

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

    // ===== Oracle Errors =====
    /// Oracle data is stale
    #[msg("Oracle data is stale")]
    StaleOracle,

    /// Insufficient reserves per oracle
    #[msg("Insufficient reserves per oracle")]
    InsufficientReserves,

    // ===== Buffer Errors =====
    /// Insufficient buffer for redemption
    /// EVM: InsufficientBuffer()
    #[msg("Insufficient buffer for redemption")]
    InsufficientBuffer,

    // ===== Account Errors =====
    /// Account is frozen (blacklisted)
    /// EVM: SenderBlacklisted() / RecipientBlacklisted()
    #[msg("Account is frozen")]
    AccountFrozen,

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

    /// Recipient account does not match queue entry user
    #[msg("Recipient account does not match queue entry user")]
    RecipientMismatch,

    // ===== Oracle Validation Errors =====
    /// Oracle account not provided but oracle is configured
    #[msg("Oracle account not provided but oracle is configured")]
    OracleAccountMissing,

    /// Invalid oracle response
    #[msg("Invalid oracle response")]
    InvalidOracleResponse,

    /// Pyth confidence interval is wider than the protocol's tolerance
    /// (`MAX_CONF_RATIO_BPS`). Indicates a thin / illiquid market and is
    /// rejected to avoid backing supply against an unreliable price print.
    #[msg("Oracle confidence interval too wide")]
    OracleConfidenceTooWide,

    // ===== Yield Distribution Errors =====
    /// Cannot perform operation in same slot as yield distribution
    /// EVM: YieldDistributionInProgress()
    #[msg("Cannot perform operation in same slot as yield distribution")]
    YieldDistributionInProgress,

    /// New price must be >= current price
    /// EVM: MultiplierCannotDecrease()
    #[msg("New price must be >= current price")]
    PriceCannotDecrease,

    /// Yield amount too small to affect price (truncates to zero)
    #[msg("Yield amount too small to affect price (truncates to zero)")]
    YieldTooSmall,

    /// Proposed `oku_m_price` exceeds the configured ceiling.
    /// Defense-in-depth: even with the rebaser key compromised, the price
    /// cannot be pushed past `MAX_OKU_M_PRICE`.
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

    // ===== Initialization Errors =====
    /// Pyth program owner pubkey supplied to `initialize` was the default (zero) pubkey.
    #[msg("Pyth program owner pubkey is required (cannot be the zero pubkey)")]
    InvalidPythProgramOwner,

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

    // ===== Oracle Validation Errors =====
    /// Staleness threshold is outside accepted range [60s, 7 days]
    #[msg("Staleness threshold out of range (must be 60s..=7 days)")]
    InvalidStaleness,

    // ===== Phase 10: mint extension invariants =====
    /// The OkuMoney mint has the Token-2022 `TransferHook` extension
    /// enabled. The SVM port assumes no transfer hook is installed (the
    /// hook could re-enter the PSM mid-transfer and break the
    /// effects-checks-interactions ordering that defends against
    /// re-entrancy). Rebuild the mint without `TransferHook` and re-init.
    #[msg("OkuMoney mint must not have the TransferHook Token-2022 extension")]
    TransferHookNotAllowed,
}
