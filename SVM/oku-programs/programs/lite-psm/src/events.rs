//! # OkuMoney Lite-PSM Events
//!
//! Event definitions for the Lite-PSM program.
//! Aligned with EVM contract events from `LitePSM.sol` and `RedemptionQueue.sol`.
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
//!
//! Bridge events (BridgeMintEvent, BridgeBurnEvent, refund events, bridge
//! admin events) were removed in the noBridge refactor. v1 cross-chain
//! transfers are mediated off-chain and surface on-chain as ordinary
//! `MintEvent` / `RedeemEvent` records.

use crate::roles::AuthorityRole;
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

/// Emitted when the oracle relay feed pubkey is rotated.
/// EVM equivalent: `PriceFeedUpdated(address indexed oldFeed, address indexed newFeed, uint8 feedDecimals)`
/// (SVM uses Pyth `expo` rather than `decimals`, so the third field is omitted —
/// `expo` is read fresh on every consumer call.)
#[event]
pub struct OracleRelayFeedUpdatedEvent {
    /// Caller of the update (`oracle_manager` authority).
    pub actor: Pubkey,
    pub old_feed: Pubkey,
    pub new_feed: Pubkey,
}

/// Emitted when the relay staleness threshold is rotated.
/// EVM equivalent: `StalenessThresholdUpdated(uint256 oldSeconds, uint256 newSeconds)`
#[event]
pub struct OracleRelayStalenessUpdatedEvent {
    pub actor: Pubkey,
    pub old_staleness: i64,
    pub new_staleness: i64,
}

/// Emitted when the in-band peg window is rotated.
/// EVM equivalent: `PriceBandUpdated(uint256 oldMin, uint256 oldMax, uint256 newMin, uint256 newMax)`
#[event]
pub struct OracleRelayBandUpdatedEvent {
    pub actor: Pubkey,
    pub old_min_e9: u64,
    pub old_max_e9: u64,
    pub new_min_e9: u64,
    pub new_max_e9: u64,
}

/// Emitted when the accepted Pyth program owner pubkey is rotated.
/// SVM-only — no direct EVM equivalent (Chainlink AggregatorV3 owner is
/// implicit in the feed address). Kept as the migration hook for future
/// Pyth Solana Receiver support.
#[event]
pub struct OracleRelayPythProgramOwnerUpdatedEvent {
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
///
/// For `RoleAdmin` rotations this fires twice: once at proposal time
/// (`new_authority` = the *pending* admin, surfaced via
/// `RoleAdminTransferProposed` for indexers that want to distinguish the
/// two phases) and a second time on acceptance (`old_authority` = previous
/// admin, `new_authority` = newly accepted admin).
#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when `set_authority(RoleAdmin, ...)` proposes a two-step
/// transfer of the meta-role. The rotation has NOT taken effect — the new
/// admin must still sign `accept_role_admin` to commit it.
#[event]
pub struct RoleAdminTransferProposedEvent {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// Emitted when `accept_role_admin` completes a previously-proposed
/// two-step transfer.
#[event]
pub struct RoleAdminTransferAcceptedEvent {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// Emitted when `cancel_role_admin_transfer` clears an in-flight proposal.
#[event]
pub struct RoleAdminTransferCancelledEvent {
    pub current_admin: Pubkey,
    pub cancelled_pending: Pubkey,
}
