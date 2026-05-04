use anchor_lang::prelude::*;

/// OkuDollar vault configuration PDA
/// Seeds: ["oku_dollar_config"]
#[account]
pub struct OkuDollarConfig {
    /// PDA bump seed
    pub bump: u8,

    // ===== Granular Authorities =====
    /// Meta role: grant/revoke roles (cold multisig)
    pub role_admin: Pubkey,
    /// Warm Multisig - pause only
    pub pauser: Pubkey,
    /// Cold Multisig - unpause only
    pub unpauser: Pubkey,
    /// Orchestrator - update USD multiplier
    pub usd_rebaser: Pubkey,
    /// Cold Multisig - deposit/withdraw reserves
    pub reserve_manager: Pubkey,

    // ===== Token References =====
    /// OkuMoney mint (Token-2022)
    pub oku_money_mint: Pubkey,
    /// usdOku mint (Token-2022) - rebasing via stored multiplier
    pub usd_oku_mint: Pubkey,
    /// Vault's OkuMoney reserve (ATA)
    pub reserve_vault: Pubkey,
    /// Reference to PSM config (for reading oku_m_price and yield lock)
    pub psm_config: Pubkey,

    // ===== USD Multiplier (Discrete Updates) =====
    /// Current USD multiplier (1e9 = $1.00)
    /// Updated discretely by USD_REBASER via update_usd_multiplier
    pub usd_multiplier: u64,
    /// Timestamp of last USD multiplier update (for audit/monitoring)
    pub usd_last_update_time: i64,

    // ===== Collateralization =====
    /// Minimum collateralization ratio (scaled by 1e9)
    /// e.g., 950_000_000 = 95%
    pub min_collateral_ratio: u64,

    /// Whether the vault is paused
    pub is_paused: bool,
}

impl OkuDollarConfig {
    pub const SEED: &'static [u8] = b"oku_dollar_config";

    /// PDA seed for the usdOku mint (rebasing share token controlled by this vault).
    pub const USD_OKU_MINT_SEED: &'static [u8] = b"usd_oku_mint";

    /// Space needed for OkuDollarConfig account
    /// 8 (discriminator) + 1 (bump) + 32*5 (authorities) + 32*4 (token refs) + 8*2 (multiplier fields) + 8 (min_collateral_ratio) + 1 (is_paused)
    /// = 8 + 1 + 160 + 128 + 16 + 8 + 1 = 322 bytes
    pub const LEN: usize = 8 + 1 + 32 * 5 + 32 * 4 + 8 * 2 + 8 + 1;
}

// Compile-time assertion: if OkuDollarConfig layout changes, this will fail to compile
const _: () = assert!(OkuDollarConfig::LEN == 322);
