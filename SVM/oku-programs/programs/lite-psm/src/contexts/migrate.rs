use crate::state::PsmConfig;
use anchor_lang::prelude::*;

/// Context for growing `PsmConfig` to its current `LEN`.
///
/// `config` is `UncheckedAccount`, not `Account<PsmConfig>`, because Anchor
/// deserializes before applying constraints: an account still at the old,
/// smaller size fails to decode against the current struct, so the typed form
/// could never reach the resize. Seeds, discriminator and authority are
/// therefore checked by hand in the instruction body.
#[derive(Accounts)]
pub struct MigrateConfigSpace<'info> {
    /// Must equal the stored `role_admin`. Verified against the raw account
    /// bytes, since the struct cannot be decoded yet.
    pub role_admin: Signer<'info>,

    /// Funds the additional rent. Separate from `role_admin` so a cold key does
    /// not have to hold SOL.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: PDA verified by seeds; discriminator and authority verified in
    /// the instruction body before any write.
    #[account(mut, seeds = [PsmConfig::SEED], bump)]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
