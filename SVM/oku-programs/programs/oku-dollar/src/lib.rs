//! # OkuDollar (rebasing usdOku vault)
//!
//! SVM port of the EVM-side `OkuDollar.sol`. usdOku shares appreciate via a
//! discrete `usd_multiplier` bumped by the orchestrator (`update_usd_multiplier`),
//! NOT a continuous `_rpow`-style accrual as on EVM. See
//! [`SVM/EVM_VS_SVM.md`](../../../EVM_VS_SVM.md) for the full divergence list,
//! including the dual-side yield-distribution slot fence (PSM + vault) and
//! the Uniswap-V2 dead-shares first-deposit defense (SVM-only addition).

// F-02 (audit finding): The solana-lints `arbitrary_cpi` lint flags all 8
// CPI call sites in this crate because program ID is obtained at runtime from
// the context's typed account fields rather than a hardcoded literal.
//
// After review (self-audit 2026-05-27), every CPI target is constrained by
// Anchor's typed `Program<'info, T>` account system, which validates
// `account.key == T::id()` at deserialization time before the instruction
// handler executes. No `token_2022_program` field in any context struct is
// left unconstrained.
//
// These are confirmed false positives. Suppressed at crate level to keep
// `cargo dylint` output clean.
#[allow(clippy::arbitrary_cpi)]
use anchor_lang::prelude::*;

pub mod constants;
pub mod contexts;
pub mod errors;
pub mod events;
pub mod helpers;
pub mod instructions;
pub mod roles;
pub mod state;

use contexts::*;
use roles::*;

declare_id!("3TeNwAqQxxGZwF7LSveLcVEKZ5tuXNKSvfMj6nz3PJgy");

// `auditors` and `acknowledgements` are intentionally omitted until an audit
// is complete; populate them in a follow-up commit.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "OkuMoney OkuDollar Vault",
    project_url: "https://github.com/anomalyco/okuMoney",
    contacts: "email:security@okumoney.example",
    policy: "https://github.com/anomalyco/okuMoney/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/anomalyco/okuMoney"
}

#[program]
pub mod oku_dollar {
    use super::*;

    /// Initialize the OkuDollar vault
    /// Creates config PDA, usdOku mint, and reserve vault
    pub fn initialize(
        ctx: Context<Initialize>,
        pauser: Pubkey,
        unpauser: Pubkey,
        usd_rebaser: Pubkey,
        reserve_manager: Pubkey,
        min_collateral_ratio: u64,
    ) -> Result<()> {
        instructions::core::initialize(
            ctx,
            pauser,
            unpauser,
            usd_rebaser,
            reserve_manager,
            min_collateral_ratio,
        )
    }

    /// Wrap OkuMoney -> usdOku
    /// Deposits OkuMoney and mints usdOku shares
    pub fn wrap(ctx: Context<Wrap>, oku_m_amount: u64, min_shares_out: u64) -> Result<u64> {
        instructions::core::wrap(ctx, oku_m_amount, min_shares_out)
    }

    /// Unwrap usdOku -> OkuMoney
    /// Burns usdOku shares and returns OkuMoney
    pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()> {
        instructions::core::unwrap(ctx, shares)
    }

    /// Update the USD multiplier (rebasing)
    /// Called by usd_rebaser (orchestrator) to distribute yield
    pub fn update_usd_multiplier(
        ctx: Context<UpdateUsdMultiplier>,
        new_usd_multiplier: u64,
    ) -> Result<()> {
        instructions::core::update_usd_multiplier(ctx, new_usd_multiplier)
    }

    /// Deposit OkuMoney reserves
    /// Called by reserve_manager to add collateral
    pub fn deposit_reserves(ctx: Context<DepositReserves>, amount: u64) -> Result<()> {
        instructions::core::deposit_reserves(ctx, amount)
    }

    /// Withdraw OkuMoney reserves
    /// Called by reserve_manager to remove excess collateral
    pub fn withdraw_reserves(ctx: Context<WithdrawReserves>, amount: u64) -> Result<()> {
        instructions::core::withdraw_reserves(ctx, amount)
    }

    /// Pause the vault (emergency)
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause the vault
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Update an authority role. `RoleAdmin` is two-step (propose +
    /// accept, via `set_authority(RoleAdmin, ...)` + `accept_role_admin`).
    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: AuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_authority(ctx, role, new_authority)
    }

    /// Step 2 of the two-step `RoleAdmin` rotation.
    pub fn accept_role_admin(ctx: Context<AcceptRoleAdmin>) -> Result<()> {
        instructions::admin::accept_role_admin(ctx)
    }

    /// Withdraw an in-flight `RoleAdmin` two-step proposal.
    pub fn cancel_role_admin_transfer(ctx: Context<SetAuthority>) -> Result<()> {
        instructions::admin::cancel_role_admin_transfer(ctx)
    }

    /// Set the minimum collateral ratio
    pub fn set_min_collateral_ratio(
        ctx: Context<SetMinCollateralRatio>,
        new_min_collateral_ratio: u64,
    ) -> Result<()> {
        instructions::admin::set_min_collateral_ratio(ctx, new_min_collateral_ratio)
    }
}
