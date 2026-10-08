//! Account state for the Lite-PSM program (IDL-visible).
//!
//! The OkuM multiplier is not stored; it is computed from the rate-schedule
//! fields plus the clock (see `helpers::multiplier`).

use anchor_lang::prelude::*;

/// PSM configuration PDA, seeds `["psm_config"]`: authorities, token
/// references, limits and the rate schedule.
#[account]
#[derive(InitSpace)]
pub struct PsmConfig {
    /// PDA bump, stored so signer seeds need no re-derivation
    pub bump: u8,

    // ===== Granular authorities, one per action =====
    /// Grants/revokes all roles
    pub role_admin: Pubkey,
    /// Pause only
    pub pauser: Pubkey,
    /// Unpause only
    pub unpauser: Pubkey,
    /// Freeze accounts
    pub freezer: Pubkey,
    /// Thaw accounts
    pub unfreezer: Pubkey,
    /// Deposit USDC buffer
    pub buffer_depositor: Pubkey,
    /// Withdraw USDC buffer
    pub buffer_withdrawer: Pubkey,
    /// Set max supply
    pub cap_manager: Pubkey,
    /// Reset minter / direct-minter / direct-burner allowances
    pub allowance_manager: Pubkey,
    /// Sets the rate schedule and emergency multiplier override (display
    /// sync is permissionless)
    pub rate_manager: Pubkey,

    // ===== Token references =====
    /// USDC mint (standard SPL Token, `USDC_DECIMALS` decimals)
    pub usdc_mint: Pubkey,
    /// Token-2022 mint with `ScaledUiAmount`; that extension is a write-only
    /// display mirror, never read for pricing
    pub oku_m_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc: Pubkey,

    // ===== Limits =====
    /// Supply cap in raw OkuM units (6 decimals)
    pub max_supply: u64,
    /// Remaining mint allowance (6 decimals), reset by `allowance_manager`
    pub minter_allowance: u64,
    /// Set by `pause`, cleared by `unpause`; blocks every value-moving path
    pub is_paused: bool,

    /// Slot of the last emergency override (`set_okum_multiplier`); user
    /// operations are blocked in that slot.
    pub last_override_slot: u64,

    // ===== Streaming accrual rate schedule (see `oku_shared::rate`) =====
    /// Multiplier snapshot at `okum_last_accrual_time`, WAD-scaled. Starts at
    /// `PRECISION`; re-snapshotted on every schedule write.
    pub okum_base_multiplier: u128,

    /// Active per-second rate, WAD-scaled. `PRECISION` means no yield.
    pub okum_rate_per_second: u64,

    /// Timestamp `okum_base_multiplier` was snapshotted at.
    pub okum_last_accrual_time: i64,

    /// Expiry of `okum_rate_per_second`. `0` only when halted; every yielding
    /// rate has a bounded window so an unattended schedule halts.
    pub okum_rate_end: i64,

    /// Pre-staged successor rate, active from `okum_rate_end` with no
    /// transaction. `PRECISION` means none armed.
    pub okum_pending_rate_per_second: u64,

    /// Successor's own expiry. `0` = none armed.
    pub okum_pending_rate_end: i64,

    /// Unix time of the last `sync_display_multiplier`. Observability only.
    pub last_display_sync_ts: i64,

    /// Pending `role_admin` target of the two-step rotation (set by
    /// `set_authority(RoleAdmin, ..)`, committed by `accept_role_admin`).
    /// `Pubkey::default()` = no pending rotation.
    pub pending_role_admin: Pubkey,

    // ===== Direct mint (fiat on-ramp) =====
    /// `Pubkey::default()` = disabled
    pub direct_minter: Pubkey,
    /// Direct-mint allowance (6 decimals), separate from `minter_allowance`
    pub direct_minter_allowance: u64,

    // ===== Direct burn (bridge / off-ramp) =====
    /// `Pubkey::default()` = disabled
    pub direct_burner: Pubkey,
    /// Direct-burn allowance (6 decimals)
    pub direct_burner_allowance: u64,

    /// Reserved tail for future fields; consume from the front and shrink the
    /// array so `LEN` stays constant (there is no `realloc` instruction).
    pub reserved: [u8; 128],
}

impl PsmConfig {
    /// PDA seed of the singleton config account.
    pub const SEED: &'static [u8] = b"psm_config";

    /// 8-byte discriminator + `InitSpace`.
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// Signer seeds `[SEED, bump]` for CPIs signed by the config PDA.
    #[inline]
    pub fn signer_seeds(bump: &[u8; 1]) -> [&[u8]; 2] {
        [Self::SEED, bump]
    }
}

// Layout pin: a size change cannot be applied to deployed configs in place.
const _: () = assert!(PsmConfig::LEN == 754);
