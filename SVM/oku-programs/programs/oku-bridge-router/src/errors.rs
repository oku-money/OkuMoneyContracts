use anchor_lang::prelude::*;

#[error_code]
pub enum RouterError {
    #[msg("Caller not authorized")]
    Unauthorized,
    #[msg("Router is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Unexpected balance decrease")]
    MathError,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
}
