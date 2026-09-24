//! # OkuM Lite-PSM Events
//!
//! Event definitions for the Lite-PSM program. The EVM event each one
//! corresponds to is named on the struct.
//!
//! There are no bridge events: cross-chain transfers are mediated off-chain
//! and surface on-chain as ordinary `MintEvent` / `RedeemEvent` records.

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
    pub oku_m_mint: Pubkey,
    pub max_supply: u64,
}

/// Emitted when OkuM is minted via PSM.
/// EVM equivalent: `MintNote(address indexed user, uint256 usdcAmount, uint256 rawOkuMAmount, uint256 multiplier)`
#[event]
pub struct MintEvent {
    /// User who minted
    pub user: Pubkey,
    /// USDC deposited (6 decimals)
    pub usdc_amount: u64,
    /// OkuM raw amount minted (6 decimals)
    pub raw_oku_m_amount: u64,
    /// Dollar value of the minted amount (raw_oku_m_amount * multiplier / PRECISION)
    pub dollar_value: u64,
    /// Canonical OkuM multiplier at time of mint, WAD-scaled (1e18 = $1.00).
    /// Computed from the rate schedule, NOT read from the display mirror.
    pub multiplier: u128,
    /// OkuM supply after the mint completed.
    pub new_total_supply: u64,
}

/// Emitted when OkuM is redeemed for USDC (instant redemption).
/// EVM equivalent: `RedeemNote(address indexed user, uint256 rawOkuMIn, uint256 usdcOut, uint256 multiplier)`
#[event]
pub struct RedeemEvent {
    /// User who redeemed
    pub user: Pubkey,
    /// OkuM raw amount burned (6 decimals)
    pub raw_oku_m_amount: u64,
    /// USDC received (6 decimals)
    pub usdc_amount: u64,
    /// Dollar value of the redeemed amount
    pub dollar_value: u64,
    /// Canonical OkuM multiplier at time of redeem, WAD-scaled (1e18 = $1.00).
    /// Computed from the rate schedule, NOT read from the display mirror.
    pub multiplier: u128,
    /// OkuM supply after the burn completed.
    pub new_total_supply: u64,
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

/// Emitted when direct-minter allowance is updated.
/// EVM equivalent: `MinterAllowanceUpdated` (for the direct-minter address)
#[event]
pub struct DirectMinterAllowanceUpdatedEvent {
    /// Caller of the update (`allowance_manager` authority).
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted when OkuM is minted via the permissioned direct-mint path
/// (no USDC required). EVM equivalent: the Transfer event from
/// `OkuM.mint(to, amount)` called by a non-PSM minter.
#[event]
pub struct DirectMintEvent {
    /// Operator who initiated the mint
    pub direct_minter: Pubkey,
    /// Recipient of the minted OkuM
    pub recipient: Pubkey,
    /// OkuM raw amount minted (6 decimals)
    pub raw_oku_m_amount: u64,
    /// Canonical OkuM multiplier at time of mint, WAD-scaled (1e18 = $1.00).
    pub multiplier: u128,
    /// Dollar value of the minted amount
    pub dollar_value: u64,
    /// OkuM supply AFTER the mint completed
    pub new_total_supply: u64,
}

/// Emitted when direct-burner allowance is updated.
/// EVM equivalent: allowance management for the burner address.
#[event]
pub struct DirectBurnerAllowanceUpdatedEvent {
    /// Caller of the update (`allowance_manager` authority).
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted when OkuM is burned via the permissioned direct-burn path
/// (no USDC payout). EVM equivalent: the Transfer-to-zero event from
/// `OkuM.burn(amount)` called by a non-PSM burner.
#[event]
pub struct DirectBurnEvent {
    /// Operator who initiated the burn
    pub direct_burner: Pubkey,
    /// OkuM raw amount burned (6 decimals)
    pub raw_oku_m_amount: u64,
    /// Canonical OkuM multiplier at time of burn, WAD-scaled (1e18 = $1.00).
    pub multiplier: u128,
    /// Dollar value of the burned amount
    pub dollar_value: u64,
    /// OkuM supply AFTER the burn completed
    pub new_total_supply: u64,
}

/// Emitted by the EMERGENCY multiplier override only.
///
/// Under streaming accrual this is a rare, incident-response event, not a
/// routine yield mechanism. Its presence in the log means an operator forced
/// a discrete jump and halted the schedule.
///
/// EVM equivalent: `MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply)`
#[event]
pub struct MultiplierUpdated {
    /// WAD-scaled (1e18).
    pub old_multiplier: u128,
    pub new_multiplier: u128,
    /// Total OkuM supply at time of update
    pub total_supply: u64,
    pub timestamp: i64,
}

/// Emitted when the ACTIVE per-second rate or its window changes.
///
/// There is no dollar-denominated distribution event because there is no
/// dollar-denominated instruction — the operator publishes a rate, and the
/// yield follows from it continuously.
///
/// EVM equivalent: `OkuMYieldRateUpdated`.
#[event]
pub struct YieldRateUpdated {
    /// Previous active per-second rate, WAD-scaled.
    pub old_rate: u64,
    /// New active per-second rate, WAD-scaled. `PRECISION` means halted.
    pub new_rate: u64,
    /// Absolute expiry of the new rate. `0` when halting.
    pub rate_end: i64,
    /// The multiplier snapshot taken at this write, so indexers can
    /// reconstruct `m(t)` for any `t` without replaying from genesis.
    pub base_multiplier: u128,
    pub timestamp: i64,
}

/// Emitted when the PRE-STAGED successor rate changes.
///
/// The successor activates at `rate_end` with no transaction, so this event is
/// the only on-chain record of the handover being armed. Cross-chain
/// monitoring compares these across deployments.
///
/// EVM equivalent: `NextOkuMYieldRateSet(newRate, rateEnd, pendingEndTimestamp)`.
#[event]
pub struct PendingYieldRateUpdated {
    pub old_rate: u64,
    pub new_rate: u64,
    /// The ACTIVE window's expiry — i.e. exactly when this successor takes
    /// over.
    pub rate_end: i64,
    /// Absolute expiry of the successor itself, bounding the overhang.
    pub pending_rate_end: i64,
    pub timestamp: i64,
}

/// Emitted when an armed successor is discarded or replaced before it ever
/// activated.
///
/// Without this, a chain that had a successor staged and then had it silently
/// dropped would be indistinguishable — from the event log alone — from a chain
/// that still has one armed. Since the handover itself emits nothing (it needs
/// no transaction), the arm/cancel pair is the whole audit trail.
///
/// EVM equivalent: `PendingRateCancelled`.
#[event]
pub struct PendingRateCancelled {
    pub cancelled_rate: u64,
    pub cancelled_pending_rate_end: i64,
    pub timestamp: i64,
}

/// Emitted when the wallet-facing display mirror is refreshed.
///
/// Purely informational — no economic meaning. Useful for monitoring how far
/// the display has drifted from canonical and whether the crank is alive.
#[event]
pub struct DisplayMultiplierSynced {
    /// Canonical multiplier written as immediately effective. The mirror is a
    /// pure lag — there is no pre-armed next step (see `sync_display_multiplier`).
    pub multiplier: u128,
    pub timestamp: i64,
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

/// Emitted when `update_token_metadata` rewrites the OkuM mint's
/// Token-2022 `TokenMetadata` `name`/`symbol` in place. This is the
/// on-chain identity shown by wallets and explorers (the true OkuM
/// token); the "$1-pegged usdOku" figure is a separate ScaledUiAmount
/// display value and is unaffected.
#[event]
pub struct TokenMetadataUpdatedEvent {
    pub mint: Pubkey,
    pub name: String,
    pub symbol: String,
}
