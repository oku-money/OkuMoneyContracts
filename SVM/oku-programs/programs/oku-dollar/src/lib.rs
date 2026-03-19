use anchor_lang::prelude::*;

pub mod contexts;
pub mod errors;
pub mod events;
pub mod helpers;
pub mod instructions;
pub mod roles;
pub mod state;

use contexts::*;
use roles::*;

declare_id!("BjjK75Vxj6zsC49qYfcVYFPLqyXXkcaFzacTXwohmfVC");

#[program]
pub mod oku_dollar {
    use super::*;

    /// Initialize the OkuDollar vault
    /// Creates config PDA, usdOku mint, and reserve vault
    pub fn initialize(
        ctx: Context<Initialize>,
        pauser: Pubkey,
        unpauser: Pubkey,
        usd_rebaser: Pubkey,
        reserve_manager: Pubkey,
        min_collateral_ratio: u64,
    ) -> Result<()> {
        instructions::core::initialize(
            ctx,
            pauser,
            unpauser,
            usd_rebaser,
            reserve_manager,
            min_collateral_ratio,
        )
    }

    /// Wrap OkuMoney -> usdOku
    /// Deposits OkuMoney and mints usdOku shares
    pub fn wrap(ctx: Context<Wrap>, oku_m_amount: u64, min_shares_out: u64) -> Result<()> {
        instructions::core::wrap(ctx, oku_m_amount, min_shares_out)
    }

    /// Unwrap usdOku -> OkuMoney
    /// Burns usdOku shares and returns OkuMoney
    pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()> {
        instructions::core::unwrap(ctx, shares)
    }

    /// Update the USD multiplier (rebasing)
    /// Called by usd_rebaser (orchestrator) to distribute yield
    pub fn update_usd_multiplier(
        ctx: Context<UpdateUsdMultiplier>,
        new_usd_multiplier: u64,
    ) -> Result<()> {
        instructions::core::update_usd_multiplier(ctx, new_usd_multiplier)
    }

    /// Deposit OkuMoney reserves
    /// Called by reserve_manager to add collateral
    pub fn deposit_reserves(ctx: Context<DepositReserves>, amount: u64) -> Result<()> {
        instructions::core::deposit_reserves(ctx, amount)
    }

    /// Withdraw OkuMoney reserves
    /// Called by reserve_manager to remove excess collateral
    pub fn withdraw_reserves(ctx: Context<WithdrawReserves>, amount: u64) -> Result<()> {
        instructions::core::withdraw_reserves(ctx, amount)
    }

    /// Pause the vault (emergency)
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause the vault
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Update an authority role
    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: AuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_authority(ctx, role, new_authority)
    }

    /// Set the minimum collateral ratio
    pub fn set_min_collateral_ratio(
        ctx: Context<SetMinCollateralRatio>,
        new_min_collateral_ratio: u64,
    ) -> Result<()> {
        instructions::admin::set_min_collateral_ratio(ctx, new_min_collateral_ratio)
    }
}
