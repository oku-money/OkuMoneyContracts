use anchor_lang::prelude::*;

/// Router configuration PDA
/// Stores role authorities and token mint references for validation
#[account]
#[derive(InitSpace)]
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
    /// Space: 8 byte discriminator + `InitSpace`-derived field sum.
    /// Pinned at 170 bytes by the assertion below.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

// Compile-time assertion: if RouterConfig layout changes, this will fail to compile
const _: () = assert!(RouterConfig::LEN == 170);
