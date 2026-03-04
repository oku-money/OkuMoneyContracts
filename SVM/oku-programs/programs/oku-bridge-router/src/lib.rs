use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod events;
pub mod roles;
pub mod contexts;
pub mod instructions;

use contexts::*;
use roles::*;

declare_id!("7DtqfP4fyShjAoM35QC9m3a9Ukh4tqcVgzTNLuyTkgE");

#[program]
pub mod oku_bridge_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        instructions::core::initialize(ctx, pauser, unpauser)
    }

    pub fn bridge_wrapped(
        ctx: Context<BridgeWrapped>,
        wokusd_shares: u64,
        recipient: [u8; 20],
        destination_chain: u16,
        min_okusd_out: u64,
    ) -> Result<()> {
        instructions::core::bridge_wrapped(ctx, wokusd_shares, recipient, destination_chain, min_okusd_out)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn set_authority(ctx: Context<SetAuthority>, role: RouterAuthorityRole, new_authority: Pubkey) -> Result<()> {
        instructions::admin::set_authority(ctx, role, new_authority)
    }
}
