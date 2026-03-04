use anchor_lang::prelude::*;
use crate::roles::RouterAuthorityRole;

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
}

#[event]
pub struct BridgeWrappedEvent {
    pub user: Pubkey,
    pub wokusd_shares: u64,
    pub okusd_amount: u64,
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
