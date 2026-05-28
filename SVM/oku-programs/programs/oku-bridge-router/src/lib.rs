//! # OkuBridgeRouter
//!
//! Convenience CPI wrapper that lets a user mint usdOku from USDC, redeem
//! usdOku to USDC, or bridge usdOku cross-chain in a single transaction.
//! Mirrors the user-facing surface of EVM `OkuBridgeRouter.sol`, except the
//! third-party adapter paths (NTT / CCIP) which are not implemented on SVM.
//!
//! Defense-in-depth: each entry point deserializes the target program PDAs
//! (PsmConfig / BridgeConfig / OkuDollarConfig) via `crate::validation` and
//! asserts cross-program invariants (vault.psm_config link, no underlying
//! pause) before issuing CPIs, so failures surface as clean RouterErrors.
//!
//! See [`SVM/EVM_VS_SVM.md`](../../../EVM_VS_SVM.md) for the full divergence
//! list, including the lack of a `sweep` admin (router holds no escrow on SVM).

// F-02 (audit finding): The solana-lints `arbitrary_cpi` lint flags CPI call
// sites in this crate because program ID is obtained at runtime from typed
// account fields rather than a hardcoded literal.
//
// After review (self-audit 2026-05-27), all CPI targets are constrained by:
//   1. Anchor's typed `Program<'info, T>` accounts (Token, Token2022, System)
//      validated at deserialization via `T::id()`.
//   2. `UncheckedAccount` with explicit `#[account(address = lite_psm::ID)]`
//      or `#[account(address = oku_dollar::ID)]` constraints on
//      `vault_program` / `psm_program` fields in every composite context.
//
// Targeted `#![allow]` annotations are also present in the instruction module.
// Confirmed false positives — suppressed here for `cargo dylint` cleanliness.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use anchor_lang::prelude::*;

pub mod contexts;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod roles;
pub mod state;
pub mod validation;

use contexts::*;
use roles::*;

declare_id!("GAjPAbq7sqFNzfnyhEAxBD9ofTPSTk4EtjFpq45BjRWb");

// `auditors` and `acknowledgements` are intentionally omitted until an audit
// is complete; populate them in a follow-up commit.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "OkuMoney OkuBridgeRouter",
    project_url: "https://github.com/anomalyco/okuMoney",
    contacts: "email:security@okumoney.example",
    policy: "https://github.com/anomalyco/okuMoney/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/anomalyco/okuMoney"
}

#[program]
pub mod oku_bridge_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        instructions::core::initialize(ctx, pauser, unpauser)
    }

    /// Bridge usdOku cross-chain in one transaction
    /// 1. Unwraps usdOku -> OkuMoney via oku-dollar vault
    /// 2. Burns OkuMoney via PSM bridge_burn
    pub fn bridge_usd_oku(
        ctx: Context<BridgeUsdOku>,
        usd_oku_shares: u64,
        recipient: [u8; 20],
        destination_chain: u16,
        min_oku_money_out: u64,
    ) -> Result<()> {
        instructions::core::bridge_usd_oku(
            ctx,
            usd_oku_shares,
            recipient,
            destination_chain,
            min_oku_money_out,
        )
    }

    /// Bridge OkuMoney directly cross-chain
    /// Calls PSM bridge_burn directly — no vault unwrap needed
    pub fn bridge_oku_m(
        ctx: Context<BridgeOkuM>,
        oku_m_amount: u64,
        recipient: [u8; 20],
        destination_chain: u16,
    ) -> Result<()> {
        instructions::core::bridge_oku_m(ctx, oku_m_amount, recipient, destination_chain)
    }

    /// Mint usdOku from USDC in one transaction
    /// 1. PSM mint_oku_m: USDC -> OkuMoney
    /// 2. Vault wrap: OkuMoney -> usdOku
    pub fn mint_usd_oku(
        ctx: Context<MintUsdOku>,
        usdc_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::core::mint_usd_oku(ctx, usdc_amount, min_shares_out)
    }

    /// Redeem usdOku to USDC in one transaction
    /// 1. Vault unwrap: usdOku -> OkuMoney
    /// 2. PSM redeem_oku_m: OkuMoney -> USDC (instant or queued)
    pub fn redeem_usd_oku(
        ctx: Context<RedeemUsdOku>,
        usd_oku_shares: u64,
        min_oku_money_out: u64,
    ) -> Result<()> {
        instructions::core::redeem_usd_oku(ctx, usd_oku_shares, min_oku_money_out)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Update an authority role. `RoleAdmin` is two-step (propose +
    /// accept, via `set_authority(RoleAdmin, ...)` + `accept_role_admin`).
    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: RouterAuthorityRole,
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
}
