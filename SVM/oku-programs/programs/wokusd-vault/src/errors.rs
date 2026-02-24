use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Caller not authorized")]
    Unauthorized,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Insufficient shares to unwrap")]
    InsufficientShares,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
