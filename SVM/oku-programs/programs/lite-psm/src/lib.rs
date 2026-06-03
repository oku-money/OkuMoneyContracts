//! # OkuMoney Lite-PSM
//!
//! SVM port of the EVM-side `LitePSM.sol`. The structure mirrors
//! `EVM/src/psm/` module-for-module; deliberate divergences (token
//! decimals, yield-distribution model, oracle parser, queue size) are
//! documented in the top-level [`SVM/EVM_VS_SVM.md`](../../../EVM_VS_SVM.md)
//! reference.
//!
//! v1 cross-chain transfers are handled off-chain by an orchestrator that
//! holds the PSM operational roles (`buffer_depositor`, `queue_processor`,
//! `rebaser`) and signs `mint_oku_m` / `redeem_oku_m` against its own
//! ATAs on each chain. There is no on-chain bridge program.
//!
//! Inline `// see EVM_VS_SVM.md` comments throughout this crate point to
//! specific divergence rows in that document.

// F-17: Zero unsafe code in this crate (confirmed by cargo-geiger). Forbid
// future accidental introduction.
#![forbid(unsafe_code)]
// F-13: The Anchor #[program] macro generates a dispatch wrapper for
// initialize() that inherits its 15-argument signature. Clippy fires on the
// macro-expansion site, which cannot be suppressed externally. Suppressed
// crate-wide — this is the only 15-arg function and it is intentional.
#![allow(clippy::too_many_arguments)]
// F-02 (audit finding): The solana-lints `arbitrary_cpi` lint flags CPI call
// sites in this crate because program ID is obtained at runtime from typed
// account fields rather than a hardcoded literal.
//
// After review (self-audit 2026-05-27), every CPI target is constrained by
// Anchor's typed `Program<'info, T>` account system, which validates
// `account.key == T::id()` at deserialization time. Targeted `#![allow]`
// annotations are also present in each instruction module that contains CPIs.
// Confirmed false positives — suppressed here for `cargo dylint` cleanliness.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

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

declare_id!("3CLDWjDTtvWcRr1iNS9SRtDvqXgEZLm6hq1P6426YC7N");

// `auditors` and `acknowledgements` are intentionally omitted until an audit
// is complete; populate them in a follow-up commit.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "OkuMoney Lite-PSM",
    project_url: "https://github.com/anomalyco/okuMoney",
    contacts: "email:security@okumoney.example",
    policy: "https://github.com/anomalyco/okuMoney/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/anomalyco/okuMoney"
}

#[program]
pub mod lite_psm {
    use super::*;

    // ===== Initialization (3-step) =====

    // F-13: 15 args maps one-to-one to independent on-chain authority roles.
    // Grouping into a struct would change the Anchor IDL wire format.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        ctx: Context<Initialize>,
        max_supply: u64,
        minter_allowance: u64,
        pauser: Pubkey,
        unpauser: Pubkey,
        freezer: Pubkey,
        unfreezer: Pubkey,
        queue_processor: Pubkey,
        buffer_depositor: Pubkey,
        buffer_withdrawer: Pubkey,
        oracle_manager: Pubkey,
        cap_manager: Pubkey,
        allowance_manager: Pubkey,
        rebaser: Pubkey,
        pyth_program_owner: Pubkey,
    ) -> Result<()> {
        instructions::init::initialize(
            ctx,
            max_supply,
            minter_allowance,
            pauser,
            unpauser,
            freezer,
            unfreezer,
            queue_processor,
            buffer_depositor,
            buffer_withdrawer,
            oracle_manager,
            cap_manager,
            allowance_manager,
            rebaser,
            pyth_program_owner,
        )
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
    /// `queue_index` widened from u32 → u64 in Phase 13b alongside the
    /// `RedemptionQueue::{head,tail}` widening. Indexer / orchestrator code
    /// must pass the index as a `BN`/bigint on the TS side.
    pub fn rescue_queue_entry(ctx: Context<RescueQueueEntry>, queue_index: u64) -> Result<()> {
        instructions::psm::rescue_queue_entry(ctx, queue_index)
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

    pub fn set_oracle(
        ctx: Context<OracleManager>,
        oracle: Pubkey,
        staleness_threshold: i64,
    ) -> Result<()> {
        instructions::psm_admin::set_oracle(ctx, oracle, staleness_threshold)
    }

    /// Rotate the accepted Pyth program owner pubkey.
    /// Use this to migrate from legacy Pyth V2 to a different Pyth deployment
    /// (e.g. the Pyth Solana Receiver) without redeploying the proxy.
    /// Oracle_manager-gated.
    pub fn set_pyth_program_owner(
        ctx: Context<OracleManager>,
        new_pyth_program_owner: Pubkey,
    ) -> Result<()> {
        instructions::psm_admin::set_pyth_program_owner(ctx, new_pyth_program_owner)
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

    /// Initialize blacklist exemption for bridge and router (one-time, ROLE_ADMIN only)
    pub fn initialize_blacklist_exempt(
        ctx: Context<InitializeBlacklistExempt>,
        bridge: Pubkey,
        router: Pubkey,
    ) -> Result<()> {
        instructions::psm_admin::initialize_blacklist_exempt(ctx, bridge, router)
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
