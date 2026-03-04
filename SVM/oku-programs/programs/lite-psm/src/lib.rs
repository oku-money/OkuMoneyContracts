use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod events;
pub mod roles;
pub mod helpers;
pub mod contexts;
pub mod instructions;

use contexts::*;
use roles::*;

declare_id!("AhKZ4TT5W4mnvR3CsX1t9ymQmZx4535AN9SsrThu6C1T");

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
    ) -> Result<()> {
        instructions::init::initialize(ctx, max_supply, minter_allowance, pauser, unpauser, freezer, unfreezer, queue_processor, buffer_depositor, buffer_withdrawer, oracle_manager, cap_manager, allowance_manager, rebaser)
    }

    pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()> {
        instructions::init::setup_redemption_queue(ctx)
    }

    pub fn setup_okusd_escrow(ctx: Context<SetupOkusdEscrow>) -> Result<()> {
        instructions::init::setup_okusd_escrow(ctx)
    }

    // ===== PSM Operations =====

    pub fn mint(ctx: Context<MintOkusd>, usdc_amount: u64) -> Result<()> {
        instructions::psm::mint(ctx, usdc_amount)
    }

    pub fn redeem(ctx: Context<Redeem>, okusd_amount: u64) -> Result<()> {
        instructions::psm::redeem(ctx, okusd_amount)
    }

    pub fn process_queue<'info>(ctx: Context<'_, '_, '_, 'info, ProcessQueue<'info>>, max_entries: u32) -> Result<()> {
        instructions::psm::process_queue(ctx, max_entries)
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

    pub fn set_oracle(ctx: Context<OracleManager>, oracle: Pubkey, staleness_threshold: i64) -> Result<()> {
        instructions::psm_admin::set_oracle(ctx, oracle, staleness_threshold)
    }

    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::psm_admin::freeze_account(ctx)
    }

    pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
        instructions::psm_admin::thaw_account(ctx)
    }

    pub fn set_authority(ctx: Context<SetAuthority>, role: AuthorityRole, new_authority: Pubkey) -> Result<()> {
        instructions::psm_admin::set_authority(ctx, role, new_authority)
    }

    // ===== Yield Operations =====

    pub fn update_interest_rate(ctx: Context<UpdateInterestRate>, new_rate: i16) -> Result<()> {
        instructions::yield_ops::update_interest_rate(ctx, new_rate)
    }

    pub fn set_yield_rate(ctx: Context<UpdateInterestRate>, new_rate: i16, end_timestamp: i64) -> Result<()> {
        instructions::yield_ops::set_yield_rate(ctx, new_rate, end_timestamp)
    }

    pub fn set_next_yield_rate(ctx: Context<SetNextYieldRate>, new_rate: i16) -> Result<()> {
        instructions::yield_ops::set_next_yield_rate(ctx, new_rate)
    }

    pub fn apply_pending_rate(ctx: Context<UpdateInterestRate>) -> Result<()> {
        instructions::yield_ops::apply_pending_rate(ctx)
    }

    // ===== Bridge Operations =====

    pub fn bridge_mint(ctx: Context<BridgeMint>, message_bytes: Vec<u8>, signature: Vec<u8>, request_id: [u8; 32]) -> Result<()> {
        instructions::bridge::bridge_mint(ctx, message_bytes, signature, request_id)
    }

    pub fn bridge_burn(ctx: Context<BridgeBurn>, amount: u64, recipient: [u8; 20], destination_chain_id: u16) -> Result<()> {
        instructions::bridge::bridge_burn(ctx, amount, recipient, destination_chain_id)
    }

    pub fn refund_bridge_request(ctx: Context<RefundBridgeRequest>, message_bytes: Vec<u8>, request_id: [u8; 32]) -> Result<()> {
        instructions::bridge::refund_bridge_request(ctx, message_bytes, request_id)
    }

    // ===== Bridge Admin =====

    pub fn initialize_bridge(ctx: Context<InitializeBridge>, source_chain_id: u16) -> Result<()> {
        instructions::bridge_admin::initialize_bridge(ctx, source_chain_id)
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

    pub fn update_fee_recipient(ctx: Context<BridgeFeeManager>, new_recipient: Pubkey) -> Result<()> {
        instructions::bridge_admin::update_fee_recipient(ctx, new_recipient)
    }

    pub fn update_bridge_limits(ctx: Context<BridgeLimitsManager>, min_amount: u64, max_amount: u64) -> Result<()> {
        instructions::bridge_admin::update_bridge_limits(ctx, min_amount, max_amount)
    }

    pub fn pause_bridge(ctx: Context<BridgePause>) -> Result<()> {
        instructions::bridge_admin::pause_bridge(ctx)
    }

    pub fn unpause_bridge(ctx: Context<BridgeUnpause>) -> Result<()> {
        instructions::bridge_admin::unpause_bridge(ctx)
    }

    pub fn skip_nonce(ctx: Context<BridgeNonceAdmin>, destination_chain_id: u16, new_nonce: u64) -> Result<()> {
        instructions::bridge_admin::skip_nonce(ctx, destination_chain_id, new_nonce)
    }

    pub fn update_bridge_deadline(ctx: Context<BridgeLimitsManager>, new_deadline: i64) -> Result<()> {
        instructions::bridge_admin::update_bridge_deadline(ctx, new_deadline)
    }

    pub fn update_orchestrator_signer(ctx: Context<BridgeSignerManager>, new_signer: Pubkey) -> Result<()> {
        instructions::bridge_admin::update_orchestrator_signer(ctx, new_signer)
    }

    pub fn set_bridge_authority(ctx: Context<BridgeAdmin>, role: BridgeAuthorityRole, new_authority: Pubkey) -> Result<()> {
        instructions::bridge_admin::set_bridge_authority(ctx, role, new_authority)
    }
}
