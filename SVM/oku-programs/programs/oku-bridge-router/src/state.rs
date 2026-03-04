use anchor_lang::prelude::*;

/// Router configuration PDA
#[account]
pub struct RouterConfig {
    /// PDA bump seed
    pub bump: u8,
    /// Meta role: grant/revoke roles (cold multisig)
    pub role_admin: Pubkey,
    /// Warm Multisig - pause only
    pub pauser: Pubkey,
    /// Cold Multisig - unpause only
    pub unpauser: Pubkey,
    /// Whether the router is paused
    pub is_paused: bool,
}

impl RouterConfig {
    pub const SEED: &'static [u8] = b"router_config";
    /// Space: 8 (discriminator) + 1 (bump) + 32*3 (pubkeys) + 1 (bool)
    pub const LEN: usize = 8 + 1 + 32 * 3 + 1;
}
