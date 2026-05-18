//! # OkuBridgeRouter Events
//!
//! Event definitions for the OkuBridgeRouter program.
//! Aligned with EVM contract events from `OkuBridgeRouter.sol`.
//!
//! ## Note on Event Design
//!
//! The router is a convenience wrapper that composes multiple CPIs.
//! For authoritative event data (dollar_value, nonce, fee_amount), check
//! the underlying PSM and Vault events:
//! - `lite_psm::BridgeBurnEvent` - Contains nonce, fee_amount, dollar_value
//! - `oku_dollar::WrapEvent` / `UnwrapEvent` - Contains dollar_value
//! - `lite_psm::MintEvent` / `RedeemEvent` - Contains dollar_value
//!
//! The router emits its own events for convenience but they are supplementary.

use crate::roles::RouterAuthorityRole;
use anchor_lang::prelude::*;

/// Emitted when router is initialized.
#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub oku_money_mint: Pubkey,
    pub usd_oku_mint: Pubkey,
}

/// Emitted when usdOku is bridged cross-chain (unwrap + burn).
/// For authoritative bridge data (nonce, fee, dollar_value), check PSM's BridgeBurnEvent.
#[event]
pub struct BridgeUsdOkuEvent {
    /// User who initiated the bridge
    pub user: Pubkey,
    /// OkuDollar shares unwrapped
    pub usd_oku_shares: u64,
    /// OkuMoney amount after unwrap (burned for bridge)
    pub oku_m_amount: u64,
    /// Destination chain ID
    pub destination_chain: u16,
    /// Recipient on destination chain (EVM address)
    pub recipient: [u8; 20],
}

/// Emitted when OkuMoney is bridged directly cross-chain.
/// For authoritative bridge data (nonce, fee, dollar_value), check PSM's BridgeBurnEvent.
#[event]
pub struct BridgeOkuMEvent {
    /// User who initiated the bridge
    pub user: Pubkey,
    /// OkuMoney amount burned
    pub oku_m_amount: u64,
    /// Destination chain ID
    pub destination_chain: u16,
    /// Recipient on destination chain (EVM address)
    pub recipient: [u8; 20],
}

/// Emitted when usdOku is minted from USDC (PSM mint + vault wrap).
/// For authoritative mint data (dollar_value), check PSM's MintEvent and Vault's WrapEvent.
#[event]
pub struct MintUsdOkuEvent {
    /// User who minted
    pub user: Pubkey,
    /// USDC deposited (6 decimals)
    pub usdc_amount: u64,
    /// Intermediate OkuMoney amount
    pub oku_m_intermediate: u64,
    /// OkuDollar shares minted
    pub usd_oku_shares: u64,
}

/// Emitted when usdOku is redeemed for USDC (vault unwrap + PSM redeem).
///
/// NOTE: The final USDC amount and queue status are determined by the PSM,
/// not the router. Check PSM's RedeemEvent or RedemptionQueuedEvent for details.
#[event]
pub struct RedeemUsdOkuEvent {
    /// User who redeemed
    pub user: Pubkey,
    /// OkuDollar shares burned
    pub usd_oku_shares: u64,
    /// Intermediate OkuMoney amount
    pub oku_m_intermediate: u64,
}

/// Emitted when router is paused.
#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
}

/// Emitted when router is unpaused.
#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

/// Emitted when a router authority role is updated. For two-step
/// `RoleAdmin` transfers this fires only on acceptance (not on proposal).
#[event]
pub struct AuthorityUpdatedEvent {
    pub role: RouterAuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when `set_authority(RoleAdmin, ...)` proposes a two-step
/// transfer of the meta-role. Rotation is NOT yet effective.
#[event]
pub struct RoleAdminTransferProposedEvent {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// Emitted when `accept_role_admin` commits a previously-proposed transfer.
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
