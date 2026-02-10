use anchor_lang::prelude::*;

#[error_code]
pub enum OkuError {
    #[msg("Caller not authorized")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Mint would exceed max supply")]
    MaxSupplyExceeded,
    #[msg("Mint would exceed minter allowance")]
    AllowanceExceeded,
    #[msg("Oracle data is stale")]
    StaleOracle,
    #[msg("Insufficient reserves per oracle")]
    InsufficientReserves,
    #[msg("Insufficient buffer for redemption")]
    InsufficientBuffer,
    #[msg("Account is frozen")]
    AccountFrozen,
    #[msg("Queue is empty")]
    QueueEmpty,
    #[msg("Queue is full")]
    QueueFull,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough accounts provided for queue entries")]
    InsufficientAccounts,
    #[msg("Recipient account does not match queue entry user")]
    RecipientMismatch,
    #[msg("Oracle account not provided but oracle is configured")]
    OracleAccountMissing,
    #[msg("Invalid oracle response")]
    InvalidOracleResponse,

    // ===== Bridge-Specific Errors =====
    #[msg("Bridge is paused")]
    BridgePaused,
    #[msg("Signature has expired")]
    SignatureExpired,
    #[msg("Invalid Ed25519 signature")]
    InvalidSignature,
    #[msg("Recipient account does not match parameter")]
    InvalidRecipient,
    #[msg("Request ID mismatch")]
    InvalidRequestId,
    #[msg("Invalid message length (expected 80 bytes)")]
    InvalidMessageLength,
    #[msg("Wrong destination chain")]
    WrongDestinationChain,
    #[msg("Chain not supported")]
    UnsupportedChain,
    #[msg("Request already processed")]
    RequestAlreadyProcessed,
    #[msg("Amount below minimum")]
    BelowMinimum,
    #[msg("Amount above maximum")]
    AboveMaximum,
    #[msg("Chain already supported")]
    ChainAlreadySupported,
    #[msg("Chain list is full (max 32)")]
    ChainListFull,
    #[msg("Chain not found in supported list")]
    ChainNotFound,
}
