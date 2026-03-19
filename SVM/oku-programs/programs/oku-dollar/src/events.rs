use crate::roles::AuthorityRole;
use anchor_lang::prelude::*;

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

#[event]
pub struct WrapEvent {
    pub user: Pubkey,
    pub oku_m_amount: u64,
    pub shares_minted: u64,
    pub usd_multiplier: u64,
}

#[event]
pub struct UnwrapEvent {
    pub user: Pubkey,
    pub shares_burned: u64,
    pub oku_m_amount: u64,
    pub usd_multiplier: u64,
}

#[event]
pub struct ReservesDepositedEvent {
    pub reserve_manager: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ReservesWithdrawnEvent {
    pub reserve_manager: Pubkey,
    pub amount: u64,
}

#[event]
pub struct UsdMultiplierUpdatedEvent {
    pub old_multiplier: u64,
    pub new_multiplier: u64,
    pub timestamp: i64,
}

#[event]
pub struct MinCollateralRatioUpdatedEvent {
    pub old_ratio: u64,
    pub new_ratio: u64,
}

#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
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
