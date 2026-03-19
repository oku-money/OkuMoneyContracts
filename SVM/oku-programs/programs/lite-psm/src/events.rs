use crate::roles::{AuthorityRole, BridgeAuthorityRole};
use anchor_lang::prelude::*;

// ============================================================================
// PSM Events
// ============================================================================

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub oku_money_mint: Pubkey,
    pub max_supply: u64,
}

#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
    pub oku_m_amount: u64,
    /// Dollar value of the minted amount (oku_m_amount * oku_m_price / PRECISION)
    pub dollar_value: u64,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub oku_m_amount: u64,
    pub usdc_amount: u64,
    /// Dollar value of the redeemed amount
    pub dollar_value: u64,
}

#[event]
pub struct RedemptionQueuedEvent {
    pub user: Pubkey,
    pub oku_m_amount: u64,
    pub queue_position: u32,
}

#[event]
pub struct RedemptionProcessedEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
}

#[event]
pub struct BufferDepositEvent {
    pub orchestrator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BufferWithdrawEvent {
    pub role_admin: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BridgeMintEvent {
    pub request_id: [u8; 32],
    pub source_chain_id: u16,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

#[event]
pub struct BridgeBurnEvent {
    pub request_id: [u8; 32],
    pub user: Pubkey,
    pub recipient: [u8; 20],  // EVM address
    pub source_chain_id: u16, // Solana chain ID
    pub destination_chain: u16,
    pub amount: u64, // Excluding fee
    pub nonce: u64,
    pub deadline: i64,
}

#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
    pub paused: bool,
}

#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

#[event]
pub struct MaxSupplyUpdatedEvent {
    pub role_admin: Pubkey,
    pub new_max_supply: u64,
}

#[event]
pub struct MinterAllowanceUpdatedEvent {
    pub role_admin: Pubkey,
    pub new_allowance: u64,
}

#[event]
pub struct OracleUpdatedEvent {
    pub role_admin: Pubkey,
    pub oracle: Pubkey,
    pub staleness_threshold: i64,
}

/// Emitted when OkuMoney price is updated directly
#[event]
pub struct OkuMPriceUpdated {
    pub old_multiplier: u64,
    pub new_multiplier: u64,
    pub timestamp: i64,
}

/// Emitted when yield is distributed across all OkuMoney holders
#[event]
pub struct YieldDistributed {
    pub yield_amount: u64,
    pub old_multiplier: u64,
    pub new_multiplier: u64,
    pub total_supply: u64,
    pub timestamp: i64,
}

/// Emitted when yield distribution slot is set (for sandwich prevention)
#[event]
pub struct YieldDistributionSlotSet {
    pub slot: u64,
}

/// Emitted when blacklist exemption is initialized
#[event]
pub struct BlacklistExemptInitialized {
    pub bridge: Pubkey,
    pub router: Pubkey,
}

#[event]
pub struct FreezeEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

#[event]
pub struct ThawEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

// ============================================================================
// Bridge Events
// ============================================================================

#[event]
pub struct BridgeInitializedEvent {
    pub bridge_admin: Pubkey,
    pub orchestrator_signer: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct ChainAddedEvent {
    pub chain_id: u16,
}

#[event]
pub struct ChainRemovedEvent {
    pub chain_id: u16,
}

#[event]
pub struct BridgeFeeUpdatedEvent {
    pub new_fee_bps: u16,
}

#[event]
pub struct FeeRecipientUpdatedEvent {
    pub new_recipient: Pubkey,
}

#[event]
pub struct BridgeLimitsUpdatedEvent {
    pub min_amount: u64,
    pub max_amount: u64,
}

#[event]
pub struct BridgePauseEvent {
    pub pauser: Pubkey,
    pub paused: bool,
}

#[event]
pub struct BridgeUnpauseEvent {
    pub unpauser: Pubkey,
}

#[event]
pub struct NonceSkippedEvent {
    pub destination_chain_id: u16,
    pub old_nonce: u64,
    pub new_nonce: u64,
}

#[event]
pub struct OrchestratorSignerUpdatedEvent {
    pub new_signer: Pubkey,
}

#[event]
pub struct BridgeAuthorityUpdatedEvent {
    pub role: BridgeAuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct RefundProcessedEvent {
    pub request_id: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BridgeDeadlineUpdatedEvent {
    pub new_deadline_secs: i64,
}
