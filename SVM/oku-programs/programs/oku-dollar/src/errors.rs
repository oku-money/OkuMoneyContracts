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

    /// Collateral ratio cannot exceed 100% (PRECISION).
    /// EVM: RatioExceedsMax()
    #[msg("Collateral ratio exceeds maximum (100%)")]
    RatioExceedsMax,

    #[msg("USD multiplier can only increase")]
    MultiplierCannotDecrease,

    /// Proposed `usd_multiplier` exceeds `MAX_USD_MULTIPLIER`. Defense in
    /// depth — even with the rebaser key compromised, the multiplier cannot
    /// be pushed past the ceiling. Mirrors lite-psm `PriceAboveMax`.
    #[msg("Proposed usd_multiplier exceeds MAX_USD_MULTIPLIER ceiling")]
    MultiplierAboveMax,

    #[msg("Invalid USD multiplier")]
    InvalidMultiplier,

    #[msg("Invalid OkuMoney price")]
    InvalidPrice,

    #[msg("Output below minimum (slippage exceeded)")]
    SlippageExceeded,

    // ===== Dead-shares / Inflation Defense Errors =====
    /// First deposit must include the optional `dead_shares_ata` account.
    #[msg("Dead-shares ATA missing (required on first deposit)")]
    MissingDeadSharesAccount,

    /// Dead-shares ATA does not belong to the usdOku mint.
    #[msg("Dead-shares ATA mint does not match usdOku")]
    InvalidDeadSharesMint,

    /// Dead-shares ATA owner is not the System Program.
    #[msg("Dead-shares ATA owner must be the System Program")]
    InvalidDeadSharesOwner,

    /// Dead-shares ATA must be the canonical associated address derived from
    /// (usdOku mint, System Program owner). Prevents off-canonical placements
    /// that would split the dead supply across multiple accounts.
    #[msg("Dead-shares ATA must be the canonical associated address")]
    InvalidDeadSharesAddress,

    // ===== Initialization Errors =====
    /// Authority pubkey supplied to `initialize` was the default (zero) pubkey.
    #[msg("Authority pubkey cannot be the zero pubkey")]
    ZeroAuthority,

    // ===== Yield-distribution sandwich guard =====
    /// Operation rejected because it lands in the same slot as
    /// `update_usd_multiplier`. Mirrors EVM `YieldSandwichGuard`.
    #[msg("Cannot perform operation in same slot as USD multiplier update")]
    YieldDistributionInProgress,

    /// Vault's `oku_money_mint` doesn't match the PSM's `oku_money_mint`
    /// at init time. Caught early instead of silently storing inconsistent
    /// references that break wrap/unwrap math.
    #[msg("Vault oku_money_mint must match PSM oku_money_mint")]
    OkuMoneyMintMismatch,
}
