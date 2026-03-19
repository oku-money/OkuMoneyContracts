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
