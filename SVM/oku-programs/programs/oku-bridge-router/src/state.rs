use anchor_lang::prelude::*;

/// Router configuration PDA
/// Stores role authorities and token mint references for validation
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

    // === Token References (matches EVM pattern of storing downstream contract refs) ===
    /// OkuMoney mint address (Token-2022)
    pub oku_money_mint: Pubkey,
    /// usdOku mint address (Token-2022)
    pub usd_oku_mint: Pubkey,
}

impl RouterConfig {
    pub const SEED: &'static [u8] = b"router_config";
    /// Space: 8 (discriminator) + 1 (bump) + 32*3 (authorities) + 1 (bool) + 32*2 (mints)
    /// = 8 + 1 + 96 + 1 + 64 = 170 bytes
    pub const LEN: usize = 8 + 1 + 32 * 3 + 1 + 32 * 2;
}

// Compile-time assertion: if RouterConfig layout changes, this will fail to compile
const _: () = assert!(RouterConfig::LEN == 170);
