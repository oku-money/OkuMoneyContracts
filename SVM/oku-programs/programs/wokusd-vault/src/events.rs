use anchor_lang::prelude::*;
use crate::roles::AuthorityRole;

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub okusd_mint: Pubkey,
    pub wokusd_mint: Pubkey,
}

#[event]
pub struct WrapEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct UnwrapEvent {
    pub user: Pubkey,
    pub shares_burned: u64,
    pub okusd_amount: u64,
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
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
