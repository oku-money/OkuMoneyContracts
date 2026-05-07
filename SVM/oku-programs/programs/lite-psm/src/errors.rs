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
//! | `InvalidChainId` | `InvalidChainId(uint16 chainId)` |

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

    // ===== Blacklist Errors =====
    /// Account is blacklist exempt and cannot be frozen
    #[msg("Account is blacklist exempt and cannot be frozen")]
    BlacklistExempt,

    /// Blacklist exemption already initialized
    #[msg("Blacklist exemption already initialized")]
    BlacklistExemptAlreadyInitialized,

    // ===== Bridge-Specific Errors =====
    /// Bridge is paused
    #[msg("Bridge is paused")]
    BridgePaused,

    /// Signature has expired
    #[msg("Signature has expired")]
    SignatureExpired,

    /// Invalid Ed25519 signature
    #[msg("Invalid Ed25519 signature")]
    InvalidSignature,

    /// Recipient account does not match parameter
    #[msg("Recipient account does not match parameter")]
    InvalidRecipient,

    /// Authority pubkey is the zero pubkey or otherwise invalid
    #[msg("Authority pubkey is invalid (e.g. zero pubkey)")]
    InvalidAuthority,

    /// Request ID mismatch
    #[msg("Request ID mismatch")]
    InvalidRequestId,

    /// Invalid message length (expected 80 bytes)
    #[msg("Invalid message length (expected 80 bytes)")]
    InvalidMessageLength,

    /// Wrong destination chain
    #[msg("Wrong destination chain")]
    WrongDestinationChain,

    /// Chain not supported
    #[msg("Chain not supported")]
    UnsupportedChain,

    /// Request already processed
    #[msg("Request already processed")]
    RequestAlreadyProcessed,

    /// Amount below minimum
    #[msg("Amount below minimum")]
    BelowMinimum,

    /// Amount above maximum
    #[msg("Amount above maximum")]
    AboveMaximum,

    /// Limits configuration invalid (e.g., min > max)
    #[msg("Limits configuration invalid (min > max)")]
    InvalidLimits,

    /// Nonce skip request did not strictly advance the nonce
    #[msg("Nonce must strictly advance (new_nonce > current)")]
    NonceNotMonotonic,

    /// Chain already supported
    #[msg("Chain already supported")]
    ChainAlreadySupported,

    /// Chain list is full (max 32)
    #[msg("Chain list is full (max 32)")]
    ChainListFull,

    /// Chain not found in supported list
    #[msg("Chain not found in supported list")]
    ChainNotFound,

    /// Mint window still open, cannot refund yet
    #[msg("Mint window still open, cannot refund yet")]
    MintWindowStillOpen,

    /// Request source chain does not match this chain
    #[msg("Request source chain does not match this chain")]
    WrongSourceChain,

    /// Request was already minted, cannot refund
    #[msg("Request was already minted, cannot refund")]
    RequestAlreadyMinted,

    /// Escrow vault already initialized
    #[msg("Escrow vault already initialized")]
    EscrowAlreadyInitialized,

    /// Invalid fee basis points (must be <= 10000)
    #[msg("Invalid fee basis points (must be <= 10000)")]
    InvalidFeeBps,

    /// Invalid deadline value
    #[msg("Invalid deadline value")]
    InvalidDeadline,

    // ===== Two-Step Refund Errors =====
    /// Refund already pending for this request
    #[msg("Refund already pending for this request")]
    RefundAlreadyPending,

    /// No pending refund found for this request
    #[msg("No pending refund found for this request")]
    NoPendingRefund,

    /// Request was already refunded
    #[msg("Request was already refunded")]
    RequestAlreadyRefunded,

    /// Refund initiator and confirmer must be distinct keys, and neither may
    /// equal `bridge_admin`. Mirrors EVM OkuBridge's two-step refund key-separation
    /// requirement enforced at init time.
    #[msg("Refund initiator/confirmer must be distinct keys (and != bridge_admin)")]
    RefundRolesNotSeparated,

    /// `confirm_refund` rejects calls signed by the same physical key that
    /// initiated the refund. The role-level separation is configurable, but
    /// the per-call check is unconditional.
    /// Mirrors EVM `OkuBridge.confirmRefund`'s `InitiatorCannotConfirm` revert.
    #[msg("Confirmer must be a different key than the initiator that proposed this refund")]
    InitiatorCannotConfirm,

    // ===== Initialization Errors =====
    /// Pyth program owner pubkey supplied to `initialize` was the default (zero) pubkey.
    #[msg("Pyth program owner pubkey is required (cannot be the zero pubkey)")]
    InvalidPythProgramOwner,

    /// USDC mint must have exactly 6 decimals on Solana.
    /// EVM uses a runtime-resolved `usdcDecimalMultiplier`; SVM hardcodes 6.
    #[msg("USDC mint must have exactly 6 decimals")]
    InvalidUsdcDecimals,

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

    // ===== Bridge Configuration Errors =====
    /// Chain ID is invalid (zero, or equal to source_chain_id which would
    /// allow self-bridging).
    #[msg("Invalid chain ID (zero or equal to source chain)")]
    InvalidChainId,
}
