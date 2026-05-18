//! # OkuMoney Lite-PSM
//!
//! SVM port of the EVM-side `LitePSM.sol` + `OkuBridge.sol`. The structure
//! mirrors `EVM/src/psm/` and `EVM/src/bridge/` module-for-module; deliberate
//! divergences (token decimals, yield-distribution model, bridge wire
//! format, oracle parser, queue size) are documented in the top-level
//! [`SVM/EVM_VS_SVM.md`](../../../EVM_VS_SVM.md) reference.
//!
//! Inline `// see EVM_VS_SVM.md` comments throughout this crate point to
//! specific divergence rows in that document.

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

declare_id!("3pi3vBj7dn98C4QbrrKD1LEFacpXBtmCzY17YR6j7wNa");

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

    // ===== Bridge Operations =====

    pub fn bridge_mint(
        ctx: Context<BridgeMint>,
        message_bytes: Vec<u8>,
        signature: Vec<u8>,
        request_id: [u8; 32],
    ) -> Result<()> {
        instructions::bridge::bridge_mint(ctx, message_bytes, signature, request_id)
    }

    pub fn bridge_burn(
        ctx: Context<BridgeBurn>,
        amount: u64,
        recipient: [u8; 20],
        destination_chain_id: u16,
    ) -> Result<()> {
        instructions::bridge::bridge_burn(ctx, amount, recipient, destination_chain_id)
    }

    // ===== Two-Step Refund (matching EVM OkuBridge) =====

    /// Initiate a refund (step 1 of two-step refund pattern)
    /// Creates a PendingRefund PDA that must be confirmed by refund_confirmer
    pub fn initiate_refund(
        ctx: Context<InitiateRefund>,
        message_bytes: Vec<u8>,
        request_id: [u8; 32],
    ) -> Result<()> {
        instructions::bridge::initiate_refund(ctx, message_bytes, request_id)
    }

    /// Confirm a refund (step 2 of two-step refund pattern)
    /// Must be called by refund_confirmer (different key than initiator)
    pub fn confirm_refund(ctx: Context<ConfirmRefund>, request_id: [u8; 32]) -> Result<()> {
        instructions::bridge::confirm_refund(ctx, request_id)
    }

    /// Cancel a pending refund
    /// Can be called by either refund_initiator or refund_confirmer
    pub fn cancel_refund(ctx: Context<CancelRefund>, request_id: [u8; 32]) -> Result<()> {
        instructions::bridge::cancel_refund(ctx, request_id)
    }

    // ===== Bridge Admin =====

    pub fn initialize_bridge(
        ctx: Context<InitializeBridge>,
        config_args: instructions::bridge_admin::BridgeInitConfig,
    ) -> Result<()> {
        instructions::bridge_admin::initialize_bridge(ctx, config_args)
    }

    pub fn add_supported_chain(ctx: Context<BridgeChainManager>, chain_id: u16) -> Result<()> {
        instructions::bridge_admin::add_supported_chain(ctx, chain_id)
    }

    pub fn remove_supported_chain(ctx: Context<BridgeChainManager>, chain_id: u16) -> Result<()> {
        instructions::bridge_admin::remove_supported_chain(ctx, chain_id)
    }

    pub fn update_bridge_fee(ctx: Context<BridgeFeeManager>, new_fee_bps: u16) -> Result<()> {
        instructions::bridge_admin::update_bridge_fee(ctx, new_fee_bps)
    }

    pub fn update_fee_recipient(
        ctx: Context<BridgeFeeManager>,
        new_recipient: Pubkey,
    ) -> Result<()> {
        instructions::bridge_admin::update_fee_recipient(ctx, new_recipient)
    }

    pub fn update_bridge_limits(
        ctx: Context<BridgeLimitsManager>,
        min_amount: u64,
        max_amount: u64,
    ) -> Result<()> {
        instructions::bridge_admin::update_bridge_limits(ctx, min_amount, max_amount)
    }

    pub fn pause_bridge(ctx: Context<BridgePause>) -> Result<()> {
        instructions::bridge_admin::pause_bridge(ctx)
    }

    pub fn unpause_bridge(ctx: Context<BridgeUnpause>) -> Result<()> {
        instructions::bridge_admin::unpause_bridge(ctx)
    }

    pub fn skip_nonce(
        ctx: Context<BridgeNonceAdmin>,
        destination_chain_id: u16,
        new_nonce: u64,
    ) -> Result<()> {
        instructions::bridge_admin::skip_nonce(ctx, destination_chain_id, new_nonce)
    }

    pub fn update_bridge_deadline(
        ctx: Context<BridgeLimitsManager>,
        new_deadline: i64,
    ) -> Result<()> {
        instructions::bridge_admin::update_bridge_deadline(ctx, new_deadline)
    }

    pub fn update_orchestrator_signer(
        ctx: Context<BridgeSignerManager>,
        new_signer: Pubkey,
    ) -> Result<()> {
        instructions::bridge_admin::update_orchestrator_signer(ctx, new_signer)
    }

    pub fn set_bridge_authority(
        ctx: Context<BridgeAdmin>,
        role: BridgeAuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::bridge_admin::set_bridge_authority(ctx, role, new_authority)
    }
}
