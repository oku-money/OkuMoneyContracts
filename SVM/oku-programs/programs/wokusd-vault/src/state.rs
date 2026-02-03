use anchor_lang::prelude::*;

/// Vault configuration PDA
/// Seeds: ["vault_config"]
#[account]
pub struct VaultConfig {
    /// PDA bump seed
    pub bump: u8,

    // ===== Granular Authorities =====
    /// Meta role: grant/revoke roles (cold multisig)
    pub role_admin: Pubkey,
    /// Warm Multisig - pause only
    pub pauser: Pubkey,
    /// Cold Multisig - unpause only
    pub unpauser: Pubkey,

    // ===== Token References =====
    /// OkuUSD mint (Token-2022 with Interest-Bearing extension)
    pub okusd_mint: Pubkey,
    /// wOkuUSD mint (standard SPL Token)
    pub wokusd_mint: Pubkey,
    /// Vault's OkuUSD token account (ATA)
    pub vault_okusd: Pubkey,

    /// Total wOkuUSD shares outstanding
    pub total_shares: u64,
    /// Whether the vault is paused
    pub is_paused: bool,
}

impl VaultConfig {
    pub const SEED: &'static [u8] = b"vault_config";

    /// Space needed for VaultConfig account
    /// 8 (discriminator) + 1 (bump) + 32*6 (pubkeys: role_admin, pauser, unpauser, okusd_mint, wokusd_mint, vault_okusd) + 8 (total_shares) + 1 (is_paused)
    /// = 8 + 1 + 192 + 8 + 1 = 210 bytes
    pub const LEN: usize = 8 + 1 + 32 * 6 + 8 + 1;
}
