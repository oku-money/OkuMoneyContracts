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
    #[msg("Invalid recipient (zero address)")]
    InvalidRecipient,
    #[msg("Invalid destination chain")]
    InvalidDestinationChain,
    #[msg("Invalid authority address (zero address)")]
    InvalidAuthority,
    #[msg("Router is already paused")]
    AlreadyPaused,
    #[msg("Router is not paused")]
    NotPaused,
}
