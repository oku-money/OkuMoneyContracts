//! # OkuM Lite-PSM
//!
//! SVM port of the EVM-side `LitePSM.sol`. The structure mirrors
//! `EVM/src/psm/` module-for-module; deliberate divergences (token
//! decimals, yield-distribution model) are
//! documented in [`SVM/README.md § EVM vs SVM — divergence catalogue`](../../../README.md).
//!
//! v1 cross-chain transfers are handled off-chain by an orchestrator that
//! holds the PSM operational roles (`buffer_depositor`,
//! `rebaser`) and signs `mint_oku_m` / `redeem_oku_m` against its own
//! ATAs on each chain. There is no on-chain bridge program.
//!
//! Inline `// see SVM/README.md` comments throughout this crate point
//! to specific divergence rows in the catalogue.

// No unsafe code anywhere in the crate.
#![forbid(unsafe_code)]
// `arbitrary_cpi` fires on every CPI here because the target program ID is
// obtained at runtime from a typed account field. Each CPI target is a typed
// `Program<'info, T>`, which validates `account.key == T::id()` at
// deserialization, so the program ID is always constrained — these are false
// positives.
#![allow(unknown_lints, clippy::arbitrary_cpi)]
// Anchor's `#[program]` dispatch glue trips `clippy::diverging_sub_expression`
// inside macro-generated code that cannot be annotated directly.
#![allow(clippy::diverging_sub_expression)]
// `target_os = "solana"` is emitted by `solana-program-entrypoint`'s panic
// handler; check-cfg does not know about the BPF target.
#![allow(unexpected_cfgs)]

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

declare_id!("4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "OkuMoney Lite-PSM",
    project_url: "https://github.com/anomalyco/okuMoney",
    contacts: "uri:https://github.com/anomalyco/okuMoney/security/advisories/new",
    policy: "https://github.com/anomalyco/okuMoney/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/anomalyco/okuMoney"
}

#[program]
pub mod lite_psm {
    use super::*;

    // ===== Initialization =====

    pub fn initialize(
        ctx: Context<Initialize>,
        params: instructions::init::InitializeParams,
    ) -> Result<()> {
        instructions::init::initialize(ctx, params)
    }

    // ===== PSM Operations =====

    /// Mint OkuM with USDC (multiplier-aware)
    /// raw_oku_m_amount = usdc_amount * PRECISION / multiplier
    pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
        instructions::psm::mint_oku_m(ctx, usdc_amount)
    }

    // ===== Direct Mint (fiat on-ramp) =====

    /// Mint OkuM directly without USDC (permissioned -- `direct_minter` only).
    /// Matches EVM `OkuM.mint(to, amount)` called by a non-PSM `OKUM_MINTER`.
    pub fn mint_oku_m_direct(ctx: Context<MintOkuMDirect>, raw_amount: u64) -> Result<()> {
        instructions::direct_mint::mint_oku_m_direct(ctx, raw_amount)
    }

    // ===== Direct Burn (bridge / off-ramp) =====

    /// Burn OkuM directly without USDC payout (permissioned --
    /// `direct_burner` only). Matches EVM `OkuM.burn(amount)` called
    /// by a non-PSM `OKUM_BURNER`. Enables SVM->EVM bridging.
    pub fn burn_oku_m_direct(ctx: Context<BurnOkuMDirect>, raw_amount: u64) -> Result<()> {
        instructions::direct_burn::burn_oku_m_direct(ctx, raw_amount)
    }

    /// Redeem OkuM for USDC (multiplier-aware, with slippage protection)
    /// usdc_amount = raw_oku_m_amount * multiplier / PRECISION
    /// Pass min_usdc_out = 0 to skip slippage check.
    pub fn redeem_oku_m(
        ctx: Context<RedeemOkuM>,
        raw_oku_m_amount: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        instructions::psm::redeem_oku_m(ctx, raw_oku_m_amount, min_usdc_out)
    }

    pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
        instructions::psm::deposit_buffer(ctx, amount)
    }

    pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
        instructions::psm::withdraw_buffer(ctx, amount)
    }

    // ===== PSM Admin =====

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::psm_admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::psm_admin::unpause(ctx)
    }

    pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()> {
        instructions::psm_admin::set_max_supply(ctx, new_max_supply)
    }

    pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        instructions::psm_admin::set_minter_allowance(ctx, amount)
    }

    pub fn set_direct_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        instructions::psm_admin::set_direct_minter_allowance(ctx, amount)
    }

    pub fn set_direct_burner_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        instructions::psm_admin::set_direct_burner_allowance(ctx, amount)
    }

    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::psm_admin::freeze_account(ctx)
    }

    pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
        instructions::psm_admin::thaw_account(ctx)
    }

    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: AuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::psm_admin::set_authority(ctx, role, new_authority)
    }

    /// Step 2 of the two-step `RoleAdmin` rotation. Must be signed by the
    /// `pending_role_admin` previously proposed via `set_authority(RoleAdmin,
    /// new_admin)`. See `instructions::psm_admin::accept_role_admin`.
    pub fn accept_role_admin(ctx: Context<AcceptRoleAdmin>) -> Result<()> {
        instructions::psm_admin::accept_role_admin(ctx)
    }

    /// Withdraw an in-flight `RoleAdmin` two-step proposal (current
    /// `role_admin` only). Useful for typo recovery before the new admin
    /// accepts.
    pub fn cancel_role_admin_transfer(ctx: Context<SetAuthority>) -> Result<()> {
        instructions::psm_admin::cancel_role_admin_transfer(ctx)
    }

    /// Set the OkuM mint's Token-2022 `TokenMetadata` `name`/`symbol` in
    /// place (`role_admin` only) to the canonical OkuM ("OkuMoney") identity.
    /// This is the true on-chain token identity shown by wallets and
    /// explorers; the "$1-pegged usdOku" figure is a separate ScaledUiAmount
    /// display value and is unaffected.
    pub fn update_token_metadata(ctx: Context<UpdateTokenMetadata>) -> Result<()> {
        instructions::psm_admin::update_token_metadata(ctx)
    }

    // ===== Yield Operations (streaming accrual) =====
    //
    // The multiplier is computed on read from a rate schedule, not stored and
    // not bumped. These instructions change the SLOPE of a continuous curve;
    // none of them produces a discrete jump except the emergency override.
    //
    // `distribute_yield` was removed with the streaming port: under
    // rear-facing epochs the operator derives a RATE off-chain from measured
    // realised yield, so there is no on-chain "distribute N dollars" primitive.

    /// Set the active per-second rate and its bounded window (REBASER only).
    ///
    /// EVM: `OkuMoney.setOkuMYieldRate(uint256,uint256)`.
    pub fn set_okum_yield_rate(
        ctx: Context<SetYieldRate>,
        new_rate: u64,
        end_timestamp: i64,
    ) -> Result<()> {
        instructions::yield_ops::set_okum_yield_rate(ctx, new_rate, end_timestamp)
    }

    /// Pre-stage the successor rate that takes over at `okum_rate_end` with NO
    /// transaction at the boundary (REBASER only).
    ///
    /// EVM: `OkuMoney.setNextOkuMYieldRate(uint256,uint256)`.
    pub fn set_next_okum_yield_rate(
        ctx: Context<SetYieldRate>,
        new_rate: u64,
        pending_end_timestamp: i64,
    ) -> Result<()> {
        instructions::yield_ops::set_next_okum_yield_rate(ctx, new_rate, pending_end_timestamp)
    }

    /// Set the active rate and its successor atomically (REBASER only).
    /// This is the instruction the epoch orchestrator uses.
    ///
    /// EVM: `OkuMoney.setOkuMYieldRateWithSuccessor(uint256,uint256,uint256,uint256)`.
    pub fn set_okum_yield_rate_with_successor(
        ctx: Context<SetYieldRate>,
        new_rate: u64,
        end_timestamp: i64,
        next_rate: u64,
        next_end_timestamp: i64,
    ) -> Result<()> {
        instructions::yield_ops::set_okum_yield_rate_with_successor(
            ctx,
            new_rate,
            end_timestamp,
            next_rate,
            next_end_timestamp,
        )
    }

    /// EMERGENCY: force the multiplier to an explicit value and halt accrual
    /// (REBASER only). The only instruction that engages the sandwich lock.
    ///
    /// EVM: `OkuMoney.setOkuMMultiplier(uint256)`.
    pub fn set_okum_multiplier(
        ctx: Context<SetOkuMMultiplier>,
        new_multiplier: u128,
    ) -> Result<()> {
        instructions::yield_ops::set_okum_multiplier(ctx, new_multiplier)
    }

    /// Refresh the wallet-facing ScaledUiAmount display mirror.
    /// **Permissionless** — the written value is fully determined by on-chain
    /// state, so the caller has no discretion. No EVM counterpart.
    pub fn sync_display_multiplier(ctx: Context<SyncDisplayMultiplier>) -> Result<()> {
        instructions::yield_ops::sync_display_multiplier(ctx)
    }
}
