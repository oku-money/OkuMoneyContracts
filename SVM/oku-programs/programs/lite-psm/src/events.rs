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

/// Emitted when the redemption-queue PDA is created. Cycle 4 (PSM-22):
/// added so the three-step init flow has full event coverage and
/// indexers can observe each setup leg landing on-chain.
#[event]
pub struct QueueInitializedEvent {
    pub redemption_queue: Pubkey,
    /// Compile-time queue capacity (`RedemptionQueue::MAX_ENTRIES`).
    pub max_entries: u32,
}

/// Emitted when the OkuMoney escrow vault is wired into config.
/// Cycle 4 (PSM-22): added so the final init step is observable.
#[event]
pub struct EscrowInitializedEvent {
    pub vault_oku_money: Pubkey,
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
    /// OkuMoney supply AFTER the mint completed. Cycle 4 (PSM-23):
    /// added for indexing parity with `YieldDistributed` /
    /// `OkuMPriceUpdated` (both of which emit `total_supply`).
    pub new_total_supply: u64,
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
    /// OkuMoney supply AFTER the burn completed. Cycle 4 (PSM-23).
    pub new_total_supply: u64,
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
    pub queue_position: u64,
    /// Total queue length after this entry.
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
    /// OkuMoney supply AFTER the per-entry burn. Cycle 4 (PSM-23):
    /// added so indexers can reconstruct supply trajectory through the
    /// queue-drain phase without summing batch events. Note that
    /// because `process_queue` emits one of these per processed entry,
    /// the value decreases monotonically across the batch.
    pub new_total_supply: u64,
}

/// Emitted when `process_queue` skips a previously-rescued entry.
/// EVM equivalent: `RedemptionSkipped(uint256 indexed index)`.
#[event]
pub struct RedemptionSkippedEvent {
    /// Absolute queue index that was skipped (already cleared by rescue).
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
    /// Bounded by `RedemptionQueue::MAX_BATCH_ENTRIES` (= 50) per call;
    /// u64 matches the queue's u64 indices.
    pub processed_count: u64,
    /// Number of cleared (rescued) entries skipped during traversal.
    pub skipped_count: u64,
}

/// Emitted when a stuck queue entry is rescued.
/// EVM equivalent: `RedemptionRescued(uint256 indexed index, address originalUser, address recipient, uint256 okuMAmount, uint256 dollarValue)`
#[event]
pub struct RedemptionRescuedEvent {
    /// Absolute index of the rescued entry.
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

/// Emitted when PsmConfig is migrated (realloc'd) to the new layout.
#[event]
pub struct PsmConfigMigratedEvent {
    pub old_len: u64,
    pub new_len: u64,
}

/// Emitted when direct-minter allowance is updated.
/// EVM equivalent: `MinterAllowanceUpdated` (for the direct-minter address)
#[event]
pub struct DirectMinterAllowanceUpdatedEvent {
    /// Caller of the update (`allowance_manager` authority).
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted when OkuMoney is minted via the permissioned direct-mint path
/// (no USDC required). EVM equivalent: the Transfer event from
/// `OkuMoney.mint(to, amount)` called by a non-PSM `OKUM_MINTER`.
#[event]
pub struct DirectMintEvent {
    /// Operator who initiated the mint
    pub direct_minter: Pubkey,
    /// Recipient of the minted OkuMoney
    pub recipient: Pubkey,
    /// OkuMoney minted (6 decimals)
    pub oku_m_amount: u64,
    /// OkuMoney price multiplier at time of mint (1e9 = $1.00)
    pub oku_m_price: u64,
    /// Dollar value of the minted amount
    pub dollar_value: u64,
    /// OkuMoney supply AFTER the mint completed
    pub new_total_supply: u64,
}

/// Emitted when OkuMoney is direct-minted and immediately wrapped into
/// usdOku in a single instruction. EVM equivalent: a hypothetical
/// `mintUsdOkuDirect` convenience path using `OkuMoney.mint` + `wrap`.
#[event]
pub struct DirectMintUsdOkuEvent {
    /// Operator who initiated the mint+wrap
    pub direct_minter: Pubkey,
    /// Recipient of the minted usdOku shares
    pub recipient: Pubkey,
    /// OkuMoney minted and wrapped (6 decimals)
    pub oku_m_amount: u64,
    /// usdOku shares minted to the recipient
    pub shares_minted: u64,
    /// OkuMoney price multiplier at time of mint (1e9 = $1.00)
    pub oku_m_price: u64,
    /// USD multiplier at time of wrap (1e9 = $1.00)
    pub usd_multiplier: u64,
    /// Dollar value of the minted amount
    pub dollar_value: u64,
    /// OkuMoney supply AFTER the mint completed
    pub new_total_supply: u64,
}

/// Emitted when direct-burner allowance is updated.
/// EVM equivalent: allowance management for the `OKUM_BURNER` address.
#[event]
pub struct DirectBurnerAllowanceUpdatedEvent {
    /// Caller of the update (`allowance_manager` authority).
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted when OkuMoney is burned via the permissioned direct-burn path
/// (no USDC payout). EVM equivalent: the Transfer-to-zero event from
/// `OkuMoney.burn(amount)` called by a non-PSM `OKUM_BURNER`.
#[event]
pub struct DirectBurnEvent {
    /// Operator who initiated the burn
    pub direct_burner: Pubkey,
    /// OkuMoney burned (6 decimals)
    pub oku_m_amount: u64,
    /// OkuMoney price multiplier at time of burn (1e9 = $1.00)
    pub oku_m_price: u64,
    /// Dollar value of the burned amount
    pub dollar_value: u64,
    /// OkuMoney supply AFTER the burn completed
    pub new_total_supply: u64,
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
