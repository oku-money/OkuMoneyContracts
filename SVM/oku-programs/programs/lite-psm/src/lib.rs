//! # OkuMoney Lite-PSM
//!
//! SVM port of the EVM-side `LitePSM.sol`. The structure mirrors
//! `EVM/src/psm/` module-for-module; deliberate divergences (token
//! decimals, yield-distribution model, queue size) are
//! documented in [`SVM/README.md § EVM vs SVM — divergence catalogue`](../../../README.md).
//!
//! v1 cross-chain transfers are handled off-chain by an orchestrator that
//! holds the PSM operational roles (`buffer_depositor`, `queue_processor`,
//! `rebaser`) and signs `mint_oku_m` / `redeem_oku_m` against its own
//! ATAs on each chain. There is no on-chain bridge program.
//!
//! Inline `// see SVM/README.md` comments throughout this crate point
//! to specific divergence rows in the catalogue.

// Zero unsafe code (confirmed by cargo-geiger); forbid accidental
// introduction.
#![forbid(unsafe_code)]
// Cycle 4 (PSM-17): the crate-wide
// `#![allow(clippy::too_many_arguments)]` is gone. `initialize`'s
// 15-pubkey signature collapsed into `InitializeParams`; no other
// instruction in the crate has more than 3 arguments.
// solana-lints `arbitrary_cpi` flags every CPI here because program ID
// is obtained at runtime from typed account fields. Every CPI target
// is constrained by Anchor's typed `Program<'info, T>` (which validates
// `account.key == T::id()` at deserialization), so all hits are false
// positives. See `oku-programs/audit/README.md` § Accepted Risks for
// the per-call review.
#![allow(unknown_lints, clippy::arbitrary_cpi)]
// Anchor `#[program]` dispatch glue trips
// `clippy::diverging_sub_expression`; can't annotate inside macro output.
#![allow(clippy::diverging_sub_expression)]
// `target_os = "solana"` is emitted by `solana-program-entrypoint`'s
// panic handler; check-cfg doesn't know about the BPF target.
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

declare_id!("3KZtxxYXD4tMZvVZk4EhCRxoTorBDZyJZuLE3znQ9kF1");

// `auditors` and `acknowledgements` are intentionally omitted until an audit
// is complete; populate them in a follow-up commit.
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

    // ===== Initialization (3-step) =====

    pub fn initialize(
        ctx: Context<Initialize>,
        params: instructions::init::InitializeParams,
    ) -> Result<()> {
        instructions::init::initialize(ctx, params)
    }

    pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()> {
        instructions::init::setup_redemption_queue(ctx)
    }

    pub fn setup_oku_money_escrow(ctx: Context<SetupOkuMoneyEscrow>) -> Result<()> {
        instructions::init::setup_oku_money_escrow(ctx)
    }

    // ===== PSM Operations =====

    /// Mint OkuMoney with USDC (price-aware)
    /// oku_m_amount = usdc_amount * PRECISION / oku_m_price
    pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
        instructions::psm::mint_oku_m(ctx, usdc_amount)
    }

    // ===== Migration =====

    /// One-time migration: extend PsmConfig from 674 -> 714 bytes to
    /// accommodate the `direct_minter` + `direct_minter_allowance` fields.
    /// Must be signed by the current `role_admin`.
    pub fn migrate_psm_config(ctx: Context<MigratePsmConfig>) -> Result<()> {
        instructions::direct_mint::migrate_psm_config(ctx)
    }

    /// One-time migration: extend PsmConfig from 594 -> 634 bytes to
    /// accommodate the `direct_burner` + `direct_burner_allowance` fields.
    /// Must be signed by the current `role_admin`.
    pub fn migrate_psm_config_v2(ctx: Context<MigratePsmConfigV2>) -> Result<()> {
        instructions::direct_burn::migrate_psm_config_v2(ctx)
    }

    // ===== Direct Mint (fiat on-ramp) =====

    /// Mint OkuMoney directly without USDC (permissioned — `direct_minter` only).
    /// Matches EVM `OkuMoney.mint(to, amount)` called by a non-PSM `OKUM_MINTER`.
    pub fn mint_oku_m_direct(ctx: Context<MintOkuMDirect>, oku_m_amount: u64) -> Result<()> {
        instructions::direct_mint::mint_oku_m_direct(ctx, oku_m_amount)
    }

    /// Mint OkuMoney and wrap into usdOku in a single instruction
    /// (permissioned — `direct_minter` only). Matches EVM `LitePSM.mintUsdOku`
    /// convenience pattern without USDC.
    pub fn mint_usd_oku_direct(
        ctx: Context<MintUsdOkuDirect>,
        oku_m_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::direct_mint::mint_usd_oku_direct(ctx, oku_m_amount, min_shares_out)
    }

    // ===== Direct Burn (bridge / off-ramp) =====

    /// Burn OkuMoney directly without USDC payout (permissioned --
    /// `direct_burner` only). Matches EVM `OkuMoney.burn(amount)` called
    /// by a non-PSM `OKUM_BURNER`. Enables SVM->EVM bridging.
    pub fn burn_oku_m_direct(ctx: Context<BurnOkuMDirect>, oku_m_amount: u64) -> Result<()> {
        instructions::direct_burn::burn_oku_m_direct(ctx, oku_m_amount)
    }

    /// Redeem OkuMoney for USDC (price-aware)
    /// usdc_amount = oku_m_amount * oku_m_price / PRECISION
    pub fn redeem_oku_m(ctx: Context<RedeemOkuM>, oku_m_amount: u64) -> Result<()> {
        instructions::psm::redeem_oku_m(ctx, oku_m_amount)
    }

    pub fn process_queue<'info>(
        ctx: Context<'info, ProcessQueue<'info>>,
        max_entries: u32,
    ) -> Result<()> {
        instructions::psm::process_queue(ctx, max_entries)
    }

    pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
        instructions::psm::deposit_buffer(ctx, amount)
    }

    pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
        instructions::psm::withdraw_buffer(ctx, amount)
    }

    /// Rescue a stuck queue entry — returns escrowed OkuMoney to recipient.
    /// Only queue_processor can call (matches EVM's rescueQueueEntry).
    ///
    /// `queue_index` is u64 — indexer / orchestrator code must pass
    /// the index as a `BN`/bigint on the TS side.
    pub fn rescue_queue_entry(ctx: Context<RescueQueueEntry>, queue_index: u64) -> Result<()> {
        instructions::psm::rescue_queue_entry(ctx, queue_index)
    }

    /// Permissionless self-rescue (cycle 4 / PSM-06).
    ///
    /// Any user can reclaim their own queued OkuMoney without operator
    /// involvement, unblocking the head-pin DoS where a frozen ATA on
    /// the head entry stalls every subsequent `process_queue` call.
    /// Signer must be the entry's original queued user; recipient ATA
    /// must be owned by that user (constraints enforced on the
    /// `UserSelfRescueQueueEntry` context).
    pub fn user_self_rescue_queue_entry(
        ctx: Context<UserSelfRescueQueueEntry>,
        queue_index: u64,
    ) -> Result<()> {
        instructions::psm::user_self_rescue_queue_entry(ctx, queue_index)
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

    // ===== Yield Operations =====

    /// Set OkuMoney price directly (REBASER only)
    /// Sets last_yield_distribution_slot for sandwich prevention
    pub fn set_oku_m_price(ctx: Context<SetOkuMPrice>, new_multiplier: u64) -> Result<()> {
        instructions::yield_ops::set_oku_m_price(ctx, new_multiplier)
    }

    /// Distribute yield across all OkuMoney holders (REBASER only)
    /// new_multiplier = old_multiplier + (yield_amount * PRECISION / total_supply)
    pub fn distribute_yield(ctx: Context<DistributeYield>, yield_amount: u64) -> Result<()> {
        instructions::yield_ops::distribute_yield(ctx, yield_amount)
    }
}
