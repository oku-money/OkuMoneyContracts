//! # OkuMoney Lite-PSM Events
//!
//! Event definitions for the Lite-PSM program.
//! Aligned with EVM contract events from `LitePSM.sol`, `RedemptionQueue.sol`, and `OkuBridge.sol`.
//!
//! ## EVM Event Mapping
//!
//! | SVM Event | EVM Equivalent |
//! |-----------|----------------|
//! | `MintEvent` | `MintNote` |
//! | `RedeemEvent` | `RedeemNote` |
//! | `RedemptionQueuedEvent` | `RedemptionQueued` |
//! | `RedemptionProcessedEvent` | `RedemptionProcessed` |
//! | `RedemptionSkippedEvent` | `RedemptionSkipped` |
//! | `BufferRefilledEvent` | `BufferRefilled` |
//! | `RedemptionRescuedEvent` | `RedemptionRescued` |
//! | `BufferDepositEvent` | `BufferDeposited` |
//! | `BufferWithdrawEvent` | `BufferWithdrawn` |
//! | `BridgeMintEvent` | `BridgeMint` |
//! | `BridgeBurnEvent` | `BridgeBurn` |
//! | `RefundInitiatedEvent` | `RefundInitiated` |
//! | `RefundConfirmedEvent` | `RefundConfirmed` |
//! | `RefundCancelledEvent` | `RefundCancelled` |

use crate::roles::{AuthorityRole, BridgeAuthorityRole};
use anchor_lang::prelude::*;

// ============================================================================
// PSM Events
// ============================================================================

/// Emitted when PSM is initialized.
/// EVM equivalent: the `Initialized(uint64 version)` event from OZ's `Initializable`
/// (LitePSM is upgradeable; there is no Solidity constructor event).
#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub oku_money_mint: Pubkey,
    pub max_supply: u64,
}

/// Emitted when OkuMoney is minted via PSM.
/// EVM equivalent: `MintNote(address indexed user, uint256 usdcAmount, uint256 okuMAmount, uint256 okuMMultiplier)`
#[event]
pub struct MintEvent {
    /// User who minted
    pub user: Pubkey,
    /// USDC deposited (6 decimals)
    pub usdc_amount: u64,
    /// OkuMoney minted (6 decimals)
    pub oku_m_amount: u64,
    /// Dollar value of the minted amount (oku_m_amount * oku_m_price / PRECISION)
    pub dollar_value: u64,
    /// OkuMoney price multiplier at time of mint (1e9 = $1.00)
    /// EVM equivalent: okuMMultiplier
    pub oku_m_price: u64,
}

/// Emitted when OkuMoney is redeemed for USDC (instant redemption).
/// EVM equivalent: `RedeemNote(address indexed user, uint256 okuMIn, uint256 usdcOut, uint256 okuMMultiplier)`
#[event]
pub struct RedeemEvent {
    /// User who redeemed
    pub user: Pubkey,
    /// OkuMoney burned (6 decimals)
    pub oku_m_amount: u64,
    /// USDC received (6 decimals)
    pub usdc_amount: u64,
    /// Dollar value of the redeemed amount
    pub dollar_value: u64,
    /// OkuMoney price multiplier at time of redeem (1e9 = $1.00)
    /// EVM equivalent: okuMMultiplier
    pub oku_m_price: u64,
}

/// Emitted when a redemption is queued (insufficient buffer).
/// EVM equivalent: `RedemptionQueued(address indexed user, uint256 okuMAmount, uint256 dollarValue, uint256 position, uint256 queueLength)`
#[event]
pub struct RedemptionQueuedEvent {
    /// User who is owed redemption
    pub user: Pubkey,
    /// OkuMoney amount held in escrow (6 decimals)
    pub oku_m_amount: u64,
    /// Dollar value at time of queueing
    pub dollar_value: u64,
    /// Position in queue (0-indexed; absolute tail index, not ring slot).
    /// Widened from u32 to u64 in Phase 13b alongside the
    /// `RedemptionQueue::{head,tail}` widening.
    pub queue_position: u64,
    /// Total queue length after this entry. Widened to u64 in Phase 13b.
    pub queue_length: u64,
}

/// Emitted when a queued redemption is processed.
/// EVM equivalent: `RedemptionProcessed(address indexed user, uint256 okuMAmount, uint256 dollarValue, uint256 usdcAmount, uint256 waitTime)`
#[event]
pub struct RedemptionProcessedEvent {
    /// User who received redemption
    pub user: Pubkey,
    /// OkuMoney amount that was escrowed (6 decimals)
    pub oku_m_amount: u64,
    /// Dollar value at time of processing
    pub dollar_value: u64,
    /// USDC received (6 decimals)
    pub usdc_amount: u64,
    /// Time spent in queue (seconds)
    pub wait_time: i64,
}

/// Emitted when `process_queue` skips a previously-rescued entry.
/// EVM equivalent: `RedemptionSkipped(uint256 indexed index)`.
#[event]
pub struct RedemptionSkippedEvent {
    /// Absolute queue index that was skipped (already cleared by rescue).
    /// Widened from u32 to u64 in Phase 13b.
    pub queue_index: u64,
}

/// Emitted at the end of `process_queue` with batch-level summary.
///
/// EVM equivalent: `BufferRefilled(uint256 newBufferBalance,
///   uint256 processedCount, uint256 skippedCount)`. Indexers can use this
/// to reconcile buffer state after a queue drain without summing per-entry
/// `RedemptionProcessed`/`Skipped` events.
#[event]
pub struct BufferRefilledEvent {
    /// USDC vault balance after the batch completed (6 decimals).
    pub new_buffer_balance: u64,
    /// Number of entries that received a USDC payout in this batch.
    /// Widened to u64 in Phase 13b (bounded by `process_queue`'s
    /// `MAX_BATCH_ENTRIES = 50` in practice, but the type now matches the
    /// queue's u64 indices).
    pub processed_count: u64,
    /// Number of cleared (rescued) entries skipped during traversal.
    /// Widened to u64 in Phase 13b.
    pub skipped_count: u64,
}

/// Emitted when a stuck queue entry is rescued.
/// EVM equivalent: `RedemptionRescued(uint256 indexed index, address originalUser, address recipient, uint256 okuMAmount, uint256 dollarValue)`
#[event]
pub struct RedemptionRescuedEvent {
    /// Absolute index of the rescued entry. Widened from u32 to u64 in
    /// Phase 13b.
    pub queue_index: u64,
    /// Original user who was owed redemption
    pub original_user: Pubkey,
    /// Recipient who received the OkuMoney
    pub recipient: Pubkey,
    /// OkuMoney amount returned (6 decimals)
    pub oku_m_amount: u64,
    /// Dollar value at time of rescue
    pub dollar_value: u64,
}

/// Emitted when USDC is deposited into buffer.
/// EVM equivalent: `BufferDeposited(address indexed depositor, uint256 amount, uint256 newBufferBalance)`
#[event]
pub struct BufferDepositEvent {
    /// Depositor (orchestrator)
    pub orchestrator: Pubkey,
    /// Amount deposited (6 decimals)
    pub amount: u64,
    /// New buffer balance after deposit
    pub new_buffer_balance: u64,
}

/// Emitted when USDC is withdrawn from buffer.
/// EVM equivalent: `BufferWithdrawn(address indexed to, uint256 amount, uint256 newBufferBalance)`
#[event]
pub struct BufferWithdrawEvent {
    /// Withdrawer (buffer_withdrawer role)
    pub actor: Pubkey,
    /// Amount withdrawn (6 decimals)
    pub amount: u64,
    /// New buffer balance after withdrawal
    pub new_buffer_balance: u64,
}

/// Emitted when tokens are bridged from another chain (mint).
/// EVM equivalent: `BridgeMint(bytes32 indexed requestId, uint256 sourceChainId, address recipient, uint256 amount, uint256 nonce)`
#[event]
pub struct BridgeMintEvent {
    /// Unique request identifier (keccak256 hash)
    pub request_id: [u8; 32],
    /// Source chain ID (e.g., Ethereum = 1)
    pub source_chain_id: u16,
    /// Recipient on Solana
    pub recipient: Pubkey,
    /// Amount minted (6 decimals)
    pub amount: u64,
    /// Sequential nonce for ordering
    pub nonce: u64,
    /// Dollar value of minted amount
    pub dollar_value: u64,
}

/// Emitted when tokens are burned for bridging to another chain.
/// EVM equivalent: `BridgeBurn(bytes32 indexed requestId, address indexed sender,
///   bytes32 recipient, uint256 sourceChainId, uint256 destChainId,
///   uint256 grossAmount, uint256 netAmount, uint256 feeAmount, uint256 nonce,
///   uint256 deadline)`.
#[event]
pub struct BridgeBurnEvent {
    /// Unique request identifier (keccak256 hash).
    pub request_id: [u8; 32],
    /// User who burned tokens.
    pub user: Pubkey,
    /// Recipient on destination chain (EVM address, 20 bytes).
    pub recipient: [u8; 20],
    /// Source chain ID (Solana).
    pub source_chain_id: u16,
    /// Destination chain ID.
    pub destination_chain: u16,
    /// Gross amount the user submitted (pre-fee, 6 decimals). Restored for
    /// cross-chain reconciliation parity with EVM `BridgeBurn.grossAmount`.
    pub gross_amount: u64,
    /// Net amount bridged (post-fee, 6 decimals). This is the `amount` field
    /// embedded in the signed BridgeRequest message.
    pub amount: u64,
    /// Sequential nonce for ordering.
    pub nonce: u64,
    /// Request expiration timestamp.
    pub deadline: i64,
    /// Dollar value of net amount bridged.
    pub dollar_value: u64,
    /// Fee amount deducted (6 decimals).
    pub fee_amount: u64,
}

/// Emitted when PSM is paused.
/// EVM equivalent: `Paused(address account)`
#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
}

/// Emitted when PSM is unpaused.
/// EVM equivalent: `Unpaused(address account)`
#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

/// Emitted when max supply is updated.
/// EVM equivalent: `MaxSupplyUpdated(uint256 oldMaxSupply, uint256 newMaxSupply)`
#[event]
pub struct MaxSupplyUpdatedEvent {
    /// Caller of the update (`cap_manager` authority).
    pub actor: Pubkey,
    pub old_max_supply: u64,
    pub new_max_supply: u64,
}

/// Emitted when minter allowance is updated.
/// EVM equivalent: `MinterAllowanceUpdated(address indexed minter, uint256 oldAllowance, uint256 newAllowance)`
#[event]
pub struct MinterAllowanceUpdatedEvent {
    /// Caller of the update (`allowance_manager` authority).
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted when oracle configuration changes.
/// EVM equivalent: `OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled)`
#[event]
pub struct OracleUpdatedEvent {
    /// Caller of the update (`oracle_manager` authority).
    pub actor: Pubkey,
    pub oracle: Pubkey,
    pub staleness_threshold: i64,
}

/// Emitted when the accepted Pyth program owner pubkey is rotated.
/// SVM-only — no direct EVM equivalent (EVM oracle owner is implicit in the
/// AggregatorV3 interface address).
#[event]
pub struct PythProgramOwnerUpdatedEvent {
    /// Caller of the update (`oracle_manager` authority).
    pub actor: Pubkey,
    pub old_pyth_program_owner: Pubkey,
    pub new_pyth_program_owner: Pubkey,
}

/// Emitted when OkuMoney price is updated directly.
/// EVM equivalent: `OkuMMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply)`
#[event]
pub struct OkuMPriceUpdated {
    pub old_multiplier: u64,
    pub new_multiplier: u64,
    /// Total OkuMoney supply at time of update
    pub total_supply: u64,
    pub timestamp: i64,
}

/// Emitted when yield is distributed across all OkuMoney holders.
/// EVM equivalent: `YieldDistributed(uint256 yieldAmount, uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply)`
#[event]
pub struct YieldDistributed {
    /// Dollar yield distributed (6 decimals)
    pub yield_amount: u64,
    pub old_multiplier: u64,
    pub new_multiplier: u64,
    /// Total OkuMoney supply at time of distribution
    pub total_supply: u64,
    pub timestamp: i64,
}

/// Emitted when yield distribution slot is set (for sandwich prevention).
#[event]
pub struct YieldDistributionSlotSet {
    pub slot: u64,
}

/// Emitted when blacklist exemption is initialized.
#[event]
pub struct BlacklistExemptInitialized {
    pub bridge: Pubkey,
    pub router: Pubkey,
}

/// Emitted when an account is frozen.
/// EVM equivalent: `Blacklisted(address indexed account)`
#[event]
pub struct FreezeEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

/// Emitted when an account is unfrozen.
/// EVM equivalent: `Unblacklisted(address indexed account)`
#[event]
pub struct ThawEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

/// Emitted when a PSM authority role is updated.
#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

// ============================================================================
// Bridge Events
// ============================================================================

/// Emitted when bridge is initialized.
#[event]
pub struct BridgeInitializedEvent {
    pub bridge_admin: Pubkey,
    pub orchestrator_signer: Pubkey,
    pub fee_bps: u16,
}

/// Emitted when a chain is added to supported list.
/// EVM equivalent: `ChainAdded(uint256 indexed chainId)`
#[event]
pub struct ChainAddedEvent {
    pub chain_id: u16,
}

/// Emitted when a chain is removed from supported list.
/// EVM equivalent: `ChainRemoved(uint256 indexed chainId)`
#[event]
pub struct ChainRemovedEvent {
    pub chain_id: u16,
}

/// Emitted when bridge fee is updated.
/// EVM equivalent: `FeeUpdated(uint256 oldFee, uint256 newFee)`
#[event]
pub struct BridgeFeeUpdatedEvent {
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
}

/// Emitted when fee recipient is updated.
/// EVM equivalent: `FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient)`
#[event]
pub struct FeeRecipientUpdatedEvent {
    pub old_recipient: Pubkey,
    pub new_recipient: Pubkey,
}

/// Emitted when bridge limits are updated.
/// EVM equivalent: `LimitsUpdated(uint256 minAmount, uint256 maxAmount)`
#[event]
pub struct BridgeLimitsUpdatedEvent {
    pub min_amount: u64,
    pub max_amount: u64,
}

/// Emitted when bridge is paused.
#[event]
pub struct BridgePauseEvent {
    pub pauser: Pubkey,
}

/// Emitted when bridge is unpaused.
#[event]
pub struct BridgeUnpauseEvent {
    pub unpauser: Pubkey,
}

/// Emitted when a nonce is skipped (emergency recovery).
/// EVM equivalent: `NonceSkipped(uint256 indexed destChainId, uint256 skippedNonce)`
#[event]
pub struct NonceSkippedEvent {
    pub destination_chain_id: u16,
    pub old_nonce: u64,
    pub new_nonce: u64,
}

/// Emitted when orchestrator signer is updated.
/// EVM equivalent: `SignerUpdated(address indexed oldSigner, address indexed newSigner)`
#[event]
pub struct OrchestratorSignerUpdatedEvent {
    pub old_signer: Pubkey,
    pub new_signer: Pubkey,
}

/// Emitted when a bridge authority role is updated.
#[event]
pub struct BridgeAuthorityUpdatedEvent {
    pub role: BridgeAuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when bridge deadline is updated.
/// EVM equivalent: `DeadlineUpdated(uint256 oldDeadline, uint256 newDeadline)`
#[event]
pub struct BridgeDeadlineUpdatedEvent {
    pub old_deadline_secs: i64,
    pub new_deadline_secs: i64,
}

// ============================================================================
// Two-Step Refund Events (matching EVM OkuBridge)
// ============================================================================

/// Emitted when a refund is initiated (step 1 of 2).
/// EVM equivalent: `RefundInitiated(bytes32 indexed requestId, address indexed sender, uint256 amount)`
#[event]
pub struct RefundInitiatedEvent {
    /// Unique request identifier
    pub request_id: [u8; 32],
    /// Original sender who will receive the refund
    pub recipient: Pubkey,
    /// Amount to be refunded
    pub amount: u64,
    /// Who initiated the refund
    pub initiator: Pubkey,
}

/// Emitted when a refund is confirmed (step 2 of 2).
/// EVM equivalent: `RefundConfirmed(bytes32 indexed requestId, address indexed sender, uint256 amount)`
#[event]
pub struct RefundConfirmedEvent {
    /// Unique request identifier
    pub request_id: [u8; 32],
    /// Recipient who received the refund
    pub recipient: Pubkey,
    /// Amount refunded
    pub amount: u64,
}

/// Emitted when a pending refund is cancelled.
///
/// EVM equivalent: `RefundCancelled(bytes32 indexed requestId, address indexed
/// initiator, address cancelledBy)` — both the original initiator (so the
/// audit trail captures the full proposal-to-cancel lifecycle) and the
/// canceller are reported.
#[event]
pub struct RefundCancelledEvent {
    /// Unique request identifier.
    pub request_id: [u8; 32],
    /// Original initiator (the proposer recorded in `PendingRefund.initiator`).
    pub initiator: Pubkey,
    /// Who cancelled the refund.
    pub canceller: Pubkey,
}


