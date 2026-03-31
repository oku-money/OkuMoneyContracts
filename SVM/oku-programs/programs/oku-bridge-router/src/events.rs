use crate::roles::RouterAuthorityRole;
use anchor_lang::prelude::*;

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
}

#[event]
pub struct BridgeUsdOkuEvent {
    pub user: Pubkey,
    pub usd_oku_shares: u64,
    pub oku_money_amount: u64,
    pub destination_chain: u16,
    pub recipient: [u8; 20],
}

#[event]
pub struct BridgeOkuMEvent {
    pub user: Pubkey,
    pub oku_money_amount: u64,
    pub destination_chain: u16,
    pub recipient: [u8; 20],
}

#[event]
pub struct MintUsdOkuEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
    pub oku_money_intermediate: u64,
    pub usd_oku_shares: u64,
}

/// Event emitted when redeeming usdOku via the router
/// NOTE: The final USDC amount and queue status are determined by the PSM,
/// not the router. Check PSM's RedeemEvent or RedemptionQueuedEvent for details.
#[event]
pub struct RedeemUsdOkuEvent {
    pub user: Pubkey,
    pub usd_oku_shares: u64,
    pub oku_money_intermediate: u64,
    // NOTE: usdc_amount and queued fields removed because the router cannot
    // accurately determine these values. The PSM emits its own events with
    // the correct information (RedeemEvent for instant, RedemptionQueuedEvent for queued).
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
pub struct AuthorityUpdatedEvent {
    pub role: RouterAuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
