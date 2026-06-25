//! # OkuDollar Events
//!
//! Event definitions for the OkuDollar vault program.
//! Aligned with EVM contract events from `OkuDollar.sol`.
//!
//! ## EVM Event Mapping
//!
//! | SVM Event | EVM Equivalent |
//! |-----------|----------------|
//! | `WrapEvent` | `Wrapped` |
//! | `UnwrapEvent` | `Unwrapped` |
//! | `UsdMultiplierUpdatedEvent` | `UsdRebaseEvent` |
//! | `ReservesDepositedEvent` | `ReservesDeposited` |
//! | `ReservesWithdrawnEvent` | `SurplusWithdrawn` |

use crate::roles::AuthorityRole;
use anchor_lang::prelude::*;

/// Emitted when OkuDollar vault is initialized.
#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub oku_money_mint: Pubkey,
    pub usd_oku_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub psm_config: Pubkey,
    pub usd_multiplier: u64,
    pub min_collateral_ratio: u64,
}

/// Emitted when OkuMoney is wrapped into OkuDollar.
/// EVM equivalent: `Wrapped(address indexed user, address indexed receiver, uint256 okuMAmount, uint256 usdMinted, uint256 okuMMultiplier, uint256 usdMultiplier)`
#[event]
pub struct WrapEvent {
    /// User who initiated the wrap
    pub user: Pubkey,
    /// Receiver of the OkuDollar shares (may differ from user)
    pub receiver: Pubkey,
    /// OkuMoney deposited (6 decimals)
    pub oku_m_amount: u64,
    /// OkuDollar shares minted to the user (6 decimals). Cycle 4
    /// (OKUD-13): does NOT include the `dead_shares_minted` quantity
    /// on the first deposit — see that field for the inflation-defence
    /// allocation.
    pub shares_minted: u64,
    /// Dead-shares minted to the System-Program-owned ATA on the FIRST
    /// deposit (cycle 4 / OKUD-13). Always `0` on subsequent deposits.
    /// `MINIMUM_LIQUIDITY` on the first deposit. Off-chain indexers
    /// reconstructing `usd_oku_mint.supply` must sum `shares_minted +
    /// dead_shares_minted` across all WrapEvents.
    pub dead_shares_minted: u64,
    /// USD multiplier at time of wrap (1e9 = $1.00)
    pub usd_multiplier: u64,
    /// OkuMoney price at time of wrap (1e9 = $1.00)
    pub oku_m_price: u64,
    /// Dollar value of the wrapped amount
    pub dollar_value: u64,
}

/// Emitted when OkuDollar is unwrapped back to OkuMoney.
/// EVM equivalent: `Unwrapped(address indexed user, address indexed receiver, uint256 usdAmount, uint256 okuMReturned, uint256 okuMMultiplier, uint256 usdMultiplier)`
#[event]
pub struct UnwrapEvent {
    /// User who initiated the unwrap
    pub user: Pubkey,
    /// Receiver of the OkuMoney (may differ from user)
    pub receiver: Pubkey,
    /// OkuDollar shares burned (6 decimals)
    pub shares_burned: u64,
    /// OkuMoney returned (6 decimals)
    pub oku_m_amount: u64,
    /// USD multiplier at time of unwrap (1e9 = $1.00)
    pub usd_multiplier: u64,
    /// OkuMoney price at time of unwrap (1e9 = $1.00)
    pub oku_m_price: u64,
    /// Dollar value of the unwrapped amount
    pub dollar_value: u64,
}

/// Emitted when reserves are deposited without minting shares.
/// EVM equivalent: `ReservesDeposited(address indexed depositor, uint256 okuMAmount, uint256 dollarValue, uint256 collateralizationRatio)`
#[event]
pub struct ReservesDepositedEvent {
    /// Reserve manager who deposited
    pub reserve_manager: Pubkey,
    /// OkuMoney deposited (6 decimals)
    pub amount: u64,
    /// Dollar value of deposit at current oku_m_price
    pub dollar_value: u64,
    /// Collateralization ratio after deposit (scaled by PRECISION, 1e9 = 100%)
    pub collateralization_ratio: u64,
}

/// Emitted when surplus reserves are withdrawn.
/// EVM equivalent: `SurplusWithdrawn(address indexed to, uint256 okuMAmount, uint256 dollarValue, uint256 collateralizationRatio)`
#[event]
pub struct ReservesWithdrawnEvent {
    /// Reserve manager who withdrew
    pub reserve_manager: Pubkey,
    /// OkuMoney withdrawn (6 decimals)
    pub amount: u64,
    /// Dollar value of withdrawal at current oku_m_price
    pub dollar_value: u64,
    /// Collateralization ratio after withdrawal (scaled by PRECISION, 1e9 = 100%)
    pub collateralization_ratio: u64,
}

/// Emitted when USD multiplier is updated.
/// EVM equivalent: `UsdRebaseEvent(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply)`
#[event]
pub struct UsdMultiplierUpdatedEvent {
    pub old_multiplier: u64,
    pub new_multiplier: u64,
    /// Total OkuDollar supply at time of update
    pub total_supply: u64,
    /// Collateralization ratio AFTER the update (scaled by `PRECISION`,
    /// `1e9 = 100 %`). Cycle 4 (OKUD-14): added so monitoring tooling
    /// doesn't have to re-derive the value off-chain. Parity with
    /// `ReservesDepositedEvent` / `ReservesWithdrawnEvent`.
    pub collateralization_ratio: u64,
    pub timestamp: i64,
}

/// Emitted when minimum collateral ratio is updated.
/// EVM equivalent: `MinCollateralRatioUpdated(uint256 oldRatio, uint256 newRatio)`
#[event]
pub struct MinCollateralRatioUpdatedEvent {
    pub old_ratio: u64,
    pub new_ratio: u64,
}

/// Emitted when vault is paused.
#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
}

/// Emitted when vault is unpaused.
#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

/// Emitted when a vault authority role is updated. For two-step
/// `RoleAdmin` transfers this fires only on acceptance (not on proposal).
#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when `set_authority(RoleAdmin, ...)` proposes a two-step
/// transfer of the meta-role. Rotation is NOT yet effective — the new
/// admin must sign `accept_role_admin` to commit it.
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
