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

    /// New `usd_multiplier` did not strictly increase. Reverts on both
    /// backward moves and no-op (equal-value) updates so a no-op call
    /// cannot stamp the sandwich-lock slot without moving the multiplier.
    /// EVM: MultiplierCannotDecrease() (post audit-prep tighten).
    #[msg("USD multiplier must strictly increase")]
    MultiplierCannotDecrease,

    /// Proposed `usd_multiplier` exceeds `MAX_USD_MULTIPLIER`. Math-sanity
    /// bound that keeps downstream `u64 * u64 -> u128` multiplications
    /// inside the overflow-safe region. Not a guard against operator
    /// compromise (out of scope per the centralized trust model) but a
    /// math bound. Mirrors lite-psm `PriceAboveMax`.
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

    /// Cycle 4 (OKUD-09): `dead_shares_ata` was supplied on a
    /// subsequent-deposit wrap. The account is only meaningful on the
    /// first deposit (`total_supply == 0`); passing it on later calls
    /// invites confusion about which path the program took.
    #[msg("dead_shares_ata must be omitted on subsequent deposits")]
    UnexpectedDeadSharesAccount,

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

    /// OkuMoney mint decimals do not equal `oku_shared::TOKEN_DECIMALS`
    /// (= 6). Every share-math conversion assumes 6-decimal raw tokens
    /// and would silently invert by an order of magnitude on mismatch.
    /// Cycle 4 (OKUD-01).
    #[msg("OkuMoney mint must have exactly 6 decimals")]
    InvalidOkuMoneyDecimals,

    /// `accept_role_admin` was called but no proposal is in flight
    /// (`pending_role_admin == Pubkey::default()`).
    #[msg("No pending role-admin transfer to accept")]
    NoPendingRoleAdmin,

    /// `accept_role_admin` caller is not the proposed `pending_role_admin`.
    #[msg("Caller is not the pending role admin")]
    NotPendingRoleAdmin,
}
