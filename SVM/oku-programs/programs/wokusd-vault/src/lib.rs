use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod events;
pub mod roles;
pub mod helpers;
pub mod contexts;
pub mod instructions;

use contexts::*;
use roles::*;

declare_id!("BjjK75Vxj6zsC49qYfcVYFPLqyXXkcaFzacTXwohmfVC");

#[program]
pub mod wokusd_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        instructions::core::initialize(ctx, pauser, unpauser)
    }

    pub fn wrap(ctx: Context<Wrap>, okusd_amount: u64) -> Result<()> {
        instructions::core::wrap(ctx, okusd_amount)
    }

    pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()> {
        instructions::core::unwrap(ctx, shares)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn set_authority(ctx: Context<SetAuthority>, role: AuthorityRole, new_authority: Pubkey) -> Result<()> {
        instructions::admin::set_authority(ctx, role, new_authority)
    }
}
