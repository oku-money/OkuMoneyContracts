use anchor_lang::prelude::*;

pub mod contexts;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod roles;
pub mod state;

use contexts::*;
use roles::*;

declare_id!("7DtqfP4fyShjAoM35QC9m3a9Ukh4tqcVgzTNLuyTkgE");

#[program]
pub mod oku_bridge_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        instructions::core::initialize(ctx, pauser, unpauser)
    }

    /// Bridge usdOku cross-chain in one transaction
    /// 1. Unwraps usdOku -> OkuMoney via oku-dollar vault
    /// 2. Burns OkuMoney via PSM bridge_burn
    pub fn bridge_usd_oku(
        ctx: Context<BridgeUsdOku>,
        usd_oku_shares: u64,
        recipient: [u8; 20],
        destination_chain: u16,
        min_oku_money_out: u64,
    ) -> Result<()> {
        instructions::core::bridge_usd_oku(
            ctx,
            usd_oku_shares,
            recipient,
            destination_chain,
            min_oku_money_out,
        )
    }

    /// Bridge OkuMoney directly cross-chain
    /// Calls PSM bridge_burn directly — no vault unwrap needed
    pub fn bridge_oku_m(
        ctx: Context<BridgeOkuM>,
        oku_m_amount: u64,
        recipient: [u8; 20],
        destination_chain: u16,
    ) -> Result<()> {
        instructions::core::bridge_oku_m(ctx, oku_m_amount, recipient, destination_chain)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: RouterAuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_authority(ctx, role, new_authority)
    }
}
