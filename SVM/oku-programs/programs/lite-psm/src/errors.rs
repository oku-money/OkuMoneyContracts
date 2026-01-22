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
}
