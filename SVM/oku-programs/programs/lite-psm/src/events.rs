//! Events for the Lite-PSM program (IDL-visible). `EVM:` lines give the
//! counterpart event name. Cross-chain transfers are off-chain and surface as
//! ordinary `MintEvent` / `RedeemEvent` records. Amounts are 6-decimal raw
//! units; multipliers are WAD-scaled (1e18 = $1.00).

use crate::roles::AuthorityRole;
use anchor_lang::prelude::*;

/// Emitted by `initialize`. EVM: OZ `Initialized(uint64)`.
#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub oku_m_mint: Pubkey,
    pub max_supply: u64,
}

/// Emitted on a USDC-backed mint. EVM: `OkuMMinted`.
#[event]
pub struct MintEvent {
    pub user: Pubkey,
    /// USDC deposited (6 decimals)
    pub usdc_amount: u64,
    /// OkuM minted (6 decimals)
    pub raw_oku_m_amount: u64,
    /// `raw_oku_m_amount * multiplier / PRECISION`
    pub dollar_value: u64,
    /// Canonical multiplier from the rate schedule (not the display mirror)
    pub multiplier: u128,
    pub new_total_supply: u64,
}

/// Emitted on redemption. EVM: `OkuMRedeemed`.
#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    /// OkuM burned (6 decimals)
    pub raw_oku_m_amount: u64,
    /// USDC paid out (6 decimals)
    pub usdc_amount: u64,
    pub dollar_value: u64,
    /// Canonical multiplier from the rate schedule (not the display mirror)
    pub multiplier: u128,
    pub new_total_supply: u64,
}

/// Emitted on a buffer deposit. EVM: `BufferDeposited`.
#[event]
pub struct BufferDepositEvent {
    pub orchestrator: Pubkey,
    /// USDC deposited (6 decimals)
    pub amount: u64,
    pub new_buffer_balance: u64,
}

/// Emitted on a buffer withdrawal. EVM: `BufferWithdrawn`.
#[event]
pub struct BufferWithdrawEvent {
    pub actor: Pubkey,
    /// USDC withdrawn (6 decimals)
    pub amount: u64,
    pub new_buffer_balance: u64,
}

/// Emitted by `pause`. EVM: OZ `Paused`.
#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
}

/// Emitted by `unpause`. EVM: OZ `Unpaused`.
#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

/// Emitted by `set_max_supply`. EVM: `MaxSupplyUpdated`.
#[event]
pub struct MaxSupplyUpdatedEvent {
    pub actor: Pubkey,
    pub old_max_supply: u64,
    pub new_max_supply: u64,
}

/// Emitted by `set_minter_allowance`. EVM: `MinterAllowanceUpdated`.
#[event]
pub struct MinterAllowanceUpdatedEvent {
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted by `set_direct_minter_allowance`. EVM: `MinterAllowanceUpdated`.
#[event]
pub struct DirectMinterAllowanceUpdatedEvent {
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted by `mint_oku_m_direct` (no USDC). EVM: ERC-20 `Transfer` from the zero address.
#[event]
pub struct DirectMintEvent {
    pub direct_minter: Pubkey,
    pub recipient: Pubkey,
    /// OkuM minted (6 decimals)
    pub raw_oku_m_amount: u64,
    pub multiplier: u128,
    pub dollar_value: u64,
    pub new_total_supply: u64,
}

/// Emitted by `set_direct_burner_allowance`. No EVM counterpart.
#[event]
pub struct DirectBurnerAllowanceUpdatedEvent {
    pub actor: Pubkey,
    pub old_allowance: u64,
    pub new_allowance: u64,
}

/// Emitted by `burn_oku_m_direct` (no USDC payout). EVM: ERC-20 `Transfer` to the zero address.
#[event]
pub struct DirectBurnEvent {
    pub direct_burner: Pubkey,
    /// OkuM burned (6 decimals)
    pub raw_oku_m_amount: u64,
    pub multiplier: u128,
    pub dollar_value: u64,
    pub new_total_supply: u64,
}

/// Emitted by the emergency multiplier override only (a forced jump that
/// halts the schedule). EVM: `OkuMMultiplierUpdated`.
#[event]
pub struct MultiplierUpdated {
    pub old_multiplier: u128,
    pub new_multiplier: u128,
    pub total_supply: u64,
    pub timestamp: i64,
}

/// Emitted when the active rate or its window changes. EVM: `OkuMYieldRateUpdated`.
#[event]
pub struct YieldRateUpdated {
    /// Previous per-second rate, WAD-scaled
    pub old_rate: u64,
    /// New per-second rate, WAD-scaled; `PRECISION` means halted
    pub new_rate: u64,
    /// Absolute expiry of the new rate; `0` when halting
    pub rate_end: i64,
    /// Multiplier snapshot taken at this write, so indexers can reconstruct
    /// `m(t)` without replaying history
    pub base_multiplier: u128,
    pub timestamp: i64,
}

/// Emitted when the pre-staged successor rate changes. The handover itself
/// emits nothing, so this is the record of it being armed.
/// EVM: `NextOkuMYieldRateSet`.
#[event]
pub struct PendingYieldRateUpdated {
    pub old_rate: u64,
    pub new_rate: u64,
    /// Active window expiry, i.e. when the successor takes over
    pub rate_end: i64,
    /// The successor's own expiry
    pub pending_rate_end: i64,
    pub timestamp: i64,
}

/// Emitted when an armed successor is discarded or replaced before activating.
/// No EVM event of this name (EVM emits `UIMultiplierUpdateCancelled`).
#[event]
pub struct PendingRateCancelled {
    pub cancelled_rate: u64,
    pub cancelled_pending_rate_end: i64,
    pub timestamp: i64,
}

/// Emitted when the wallet display mirror is refreshed (informational only).
#[event]
pub struct DisplayMultiplierSynced {
    /// Canonical multiplier written, effective immediately
    pub multiplier: u128,
    pub timestamp: i64,
}

/// Emitted by `freeze_account`. EVM: `Blacklisted`.
#[event]
pub struct FreezeEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

/// Emitted by `thaw_account`. EVM: `Unblacklisted`.
#[event]
pub struct ThawEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

/// Emitted when a role is updated. A `RoleAdmin` rotation fires it twice:
/// at proposal (`new_authority` = pending admin) and at acceptance.
#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when `set_authority(RoleAdmin, ..)` proposes a transfer; it takes
/// effect only when the new admin calls `accept_role_admin`.
#[event]
pub struct RoleAdminTransferProposedEvent {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// Emitted by `accept_role_admin`.
#[event]
pub struct RoleAdminTransferAcceptedEvent {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// Emitted by `cancel_role_admin_transfer`.
#[event]
pub struct RoleAdminTransferCancelledEvent {
    pub current_admin: Pubkey,
    pub cancelled_pending: Pubkey,
}

/// Emitted by `update_token_metadata`.
#[event]
pub struct TokenMetadataUpdatedEvent {
    pub mint: Pubkey,
    pub name: String,
    pub symbol: String,
}
