use anchor_lang::prelude::*;

#[error_code]
pub enum RouterError {
    #[msg("Caller not authorized")]
    Unauthorized,
    #[msg("Router is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    /// Despite the legacy variant name, this error fires when a post-CPI
    /// balance read is unexpectedly less than the pre-CPI snapshot — i.e.
    /// some other tx moved tokens out from under us. Kept named `MathError`
    /// for IDL ABI stability; treat as `UnexpectedBalanceDecrease`.
    #[msg("Unexpected balance decrease (post-CPI balance < pre-CPI snapshot)")]
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

    // ===== Cross-program PDA validation =====
    /// Supplied PsmConfig account is not the canonical lite_psm PDA.
    #[msg("Supplied PsmConfig is not the canonical lite_psm PDA")]
    InvalidPsmConfig,

    /// Supplied BridgeConfig account is not the canonical lite_psm PDA.
    #[msg("Supplied BridgeConfig is not the canonical lite_psm PDA")]
    InvalidBridgeConfig,

    /// Supplied vault config account is not the canonical oku_dollar PDA.
    #[msg("Supplied VaultConfig is not the canonical oku_dollar PDA")]
    InvalidVaultConfig,

    /// Vault's stored psm_config does not match the supplied psm_config.
    #[msg("Vault config and PSM config do not match (cross-program mismatch)")]
    PsmVaultMismatch,

    /// Underlying PSM is paused — fail-fast on the router side instead of
    /// surfacing a deep CPI error.
    #[msg("Underlying PSM is paused")]
    PsmPaused,

    /// Underlying bridge is paused — fail-fast on the router side.
    #[msg("Underlying bridge is paused")]
    BridgePaused,

    /// Underlying vault is paused — fail-fast on the router side.
    #[msg("Underlying vault is paused")]
    VaultPaused,
}
