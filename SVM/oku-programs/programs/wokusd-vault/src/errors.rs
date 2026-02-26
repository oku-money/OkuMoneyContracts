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
    #[msg("First deposit must exceed minimum liquidity threshold")]
    MinimumLiquidity,
    #[msg("OkuUSD mint has malformed InterestBearingConfig extension data")]
    InvalidMintExtension,
    #[msg("Interest-adjusted payout exceeds raw vault balance; orchestrator must top up")]
    InsufficientVaultBalance,
}
