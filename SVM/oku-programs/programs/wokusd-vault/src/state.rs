use anchor_lang::prelude::*;

/// Vault configuration PDA
/// Seeds: ["vault_config"]
#[account]
pub struct VaultConfig {
    /// PDA bump seed
    pub bump: u8,
    /// Admin authority (cold multisig)
    pub admin: Pubkey,
    /// OkuUSD mint (Token-2022 with Interest-Bearing extension)
    pub okusd_mint: Pubkey,
    /// wOkuUSD mint (standard SPL Token)
    pub wokusd_mint: Pubkey,
    /// Vault's OkuUSD token account (ATA)
    pub vault_okusd_ata: Pubkey,
    /// Total wOkuUSD shares outstanding
    pub total_shares: u64,
    /// Whether the vault is paused
    pub is_paused: bool,
}

impl VaultConfig {
    pub const SEED: &'static [u8] = b"vault_config";

    /// Space needed for VaultConfig account
    /// 8 (discriminator) + 1 (bump) + 32*4 (pubkeys) + 8 (total_shares) + 1 (is_paused)
    pub const LEN: usize = 8 + 1 + 32 * 4 + 8 + 1;
}
