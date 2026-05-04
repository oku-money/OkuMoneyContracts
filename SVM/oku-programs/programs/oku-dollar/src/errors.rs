use anchor_lang::prelude::*;

#[error_code]
pub enum OkuDollarError {
    #[msg("Caller not authorized")]
    Unauthorized,

    #[msg("Invalid authority address")]
    InvalidAuthority,

    #[msg("Vault is paused")]
    VaultPaused,

    #[msg("Vault is already paused")]
    AlreadyPaused,

    #[msg("Vault is not paused")]
    NotPaused,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Insufficient shares to unwrap")]
    InsufficientShares,

    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("First deposit must exceed minimum liquidity threshold")]
    MinimumLiquidity,

    #[msg("Insufficient reserves for unwrap")]
    InsufficientReserves,

    #[msg("Operation would breach minimum collateral ratio")]
    InsufficientCollateral,

    #[msg("Invalid collateral ratio (below minimum floor)")]
    InvalidCollateralRatio,

    #[msg("USD multiplier can only increase")]
    MultiplierCannotDecrease,

    #[msg("Invalid USD multiplier")]
    InvalidMultiplier,

    #[msg("Invalid OkuMoney price")]
    InvalidPrice,

    #[msg("Output below minimum (slippage exceeded)")]
    SlippageExceeded,
}
