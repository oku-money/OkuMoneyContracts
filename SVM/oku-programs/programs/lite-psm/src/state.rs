//! Account state definitions for the Lite-PSM program.
//!
//! Single-token design: the PSM deals exclusively in **OkuM** (a
//! Token-2022 mint with the `ScaledUiAmount` extension). The multiplier is
//! not stored anywhere — it is computed from the rate-schedule fields below
//! plus the clock; see `helpers::multiplier`.
//!
//! The minter-allowance + blacklist-exempt fields on `PsmConfig` follow
//! Circle's FiatToken minter / blacklist controller pattern:
//! https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2_2.sol
//! https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol

use anchor_lang::prelude::*;

/// PSM configuration PDA.
///
/// Seeds: `["psm_config"]`. The single program-wide config account: granular
/// authorities, token references, limits, and the rate schedule.
#[account]
#[derive(InitSpace)]
pub struct PsmConfig {
    /// PDA bump seed
    pub bump: u8,

    // ===== Granular Authorities - One Per Action =====
    /// Meta role: grant/revoke roles (cold multisig)
    pub role_admin: Pubkey,
    /// Warm Multisig - pause only
    pub pauser: Pubkey,
    /// Cold Multisig - unpause only
    pub unpauser: Pubkey,
    /// Warm Multisig - freeze accounts
    pub freezer: Pubkey,
    /// Cold Multisig - thaw accounts (requires deliberate review)
    pub unfreezer: Pubkey,
    /// Orchestrator - deposit USDC buffer
    pub buffer_depositor: Pubkey,
    /// Cold Multisig - withdraw buffer
    pub buffer_withdrawer: Pubkey,
    /// Cold Multisig - set max supply
    pub cap_manager: Pubkey,
    /// Cold Multisig - reset minter / direct-minter / direct-burner allowances
    pub allowance_manager: Pubkey,
    /// Orchestrator - update multiplier on the OkuM mint
    pub rebaser: Pubkey,

    // ===== Token References =====
    /// USDC mint address
    pub usdc_mint: Pubkey,
    /// OkuM mint address (Token-2022 with ScaledUiAmount extension).
    /// The multiplier for USDC ↔ OkuM conversion is computed from this
    /// account's rate-schedule fields, never read from the mint; the
    /// extension is a write-only display mirror.
    pub oku_m_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc: Pubkey,

    // ===== Limits =====
    /// Maximum OkuM supply cap (in raw token units)
    pub max_supply: u64,
    /// Mint allowance remaining (configurable cap on freshly minted OkuM
    /// between admin resets, mirroring the EVM `minterAllowance` pattern).
    pub minter_allowance: u64,
    /// Whether the PSM is paused
    pub is_paused: bool,

    /// Solana slot of the last EMERGENCY multiplier override
    /// (`set_okum_multiplier`), for sandwich prevention. PSM operations are
    /// blocked in the same slot.
    ///
    /// The multiplier advances continuously, so there is no discrete jump to
    /// sandwich; this fires ONLY on the explicit override path and is NOT
    /// stamped by the routine display sync. Mirrors EVM's
    /// `YieldSandwichGuard`, which keys on
    /// `OkuMoney.lastYieldDistributionBlock` — written only by
    /// `setOkuMMultiplier`.
    pub last_yield_distribution_slot: u64,

    // ===== Streaming accrual rate schedule =====
    //
    // The OkuM multiplier is NOT stored. It is computed from the six fields
    // below plus `Clock::unix_timestamp` via
    // `oku_shared::rate::compute_multiplier`, which has no supply term — so
    // every chain holding the same schedule returns the same value at the same
    // wall-clock second, with no messaging and no transaction at the epoch
    // boundary.
    //
    // 1:1 with the EVM `OkuMoneyStorage` accrual fields. EVM bit-packs these
    // into two slots (uint96/uint64/uint48); SVM has no equivalent pressure,
    // so each field gets its natural width.
    /// Multiplier snapshot taken at `okum_last_accrual_time`, WAD-scaled.
    /// Starts at `PRECISION`. Re-snapshotted on every schedule write so
    /// accrual is continuous across the write.
    pub okum_base_multiplier: u128,

    /// Active per-second rate, WAD-scaled. `PRECISION` means "no yield".
    pub okum_rate_per_second: u64,

    /// Timestamp `okum_base_multiplier` was snapshotted at.
    pub okum_last_accrual_time: i64,

    /// Timestamp `okum_rate_per_second` expires. `0` ONLY when halted.
    ///
    /// Every yielding rate carries a bounded window so that an unattended
    /// schedule HALTS (safe, recoverable, monotonic) rather than compounding
    /// forever, and so a rate can never end at a transaction-dependent,
    /// per-chain moment.
    pub okum_rate_end: i64,

    /// Pre-staged successor rate. Activates at `okum_rate_end` with NO
    /// transaction — which is what keeps multi-chain epoch handovers
    /// simultaneous to the second even when the staging transactions land
    /// days apart. `PRECISION` means "none armed".
    pub okum_pending_rate_per_second: u64,

    /// The successor's own expiry, bounding the overhang. `0` = none armed.
    pub okum_pending_rate_end: i64,

    /// Unix timestamp of the last `sync_display_multiplier`.
    ///
    /// Observability only: it tells an operator (and
    /// `scripts/admin/sync-display.ts`) how stale the display mirror is.
    /// Nothing on-chain reads it, so it has no influence on pricing.
    pub last_display_sync_ts: i64,

    /// Pending `role_admin` rotation target — two-step admin transfer
    /// (OpenZeppelin `Ownable2Step`). `set_authority(RoleAdmin, new_admin)`
    /// writes here only; the rotation takes effect when `new_admin` signs
    /// `accept_role_admin`, which moves the value into `role_admin` and clears
    /// this slot. Protects against a typo or stale key on the proposing side
    /// locking out the meta-role.
    ///
    /// `Pubkey::default()` means "no pending rotation".
    pub pending_role_admin: Pubkey,

    // ===== Direct Mint (fiat on-ramp) =====
    //
    // Permissioned direct OkuM mint — no on-chain USDC collateral; the fiat
    // collateral is held off-chain. Matches EVM `OkuM.mint(to, amount)` called
    // by an authorised minter role holder.
    /// Operator / fiat gateway — can mint OkuM directly without USDC.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_minter: Pubkey,

    /// Per-direct-minter allowance (separate from the USDC-backed
    /// `minter_allowance`). Decremented on each direct mint; reset by
    /// `allowance_manager` via `set_direct_minter_allowance`.
    pub direct_minter_allowance: u64,

    // ===== Direct Burn (bridge / off-ramp) =====
    //
    // Permissioned direct OkuM burn from the caller's ATA, no USDC payout.
    // Enables SVM→EVM bridging, where the KMS-backed orchestrator burns on the
    // source chain.
    /// Operator / bridge backend — can burn OkuM directly without
    /// triggering a USDC redemption.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_burner: Pubkey,

    /// Per-direct-burner allowance. Decremented on each direct burn;
    /// reset by `allowance_manager` via `set_direct_burner_allowance`.
    pub direct_burner_allowance: u64,

    /// Space for future fields, appended at the tail.
    ///
    /// The account is a singleton PDA and the program has no `realloc`
    /// instruction, so without this any new field requires closing and
    /// re-initialising the config — losing every role assignment and the
    /// accrual anchor. 128 bytes covers 4 more pubkeys or 16 more u64s at a
    /// rent cost of ~0.0009 SOL. Consume from the FRONT when adding a field
    /// and shrink the array to match, keeping `LEN` constant.
    pub reserved: [u8; 128],
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned by the compile-time assertion
    /// below; if a reviewer changes a field's width the assertion fires.
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// PDA signer seeds for CPIs signed by the config PDA.
    ///
    /// Single source of truth for the `[SEED, [bump]]` seed shape. The caller
    /// owns the 1-byte bump array and passes a reference, so no allocation or
    /// lifetime juggling is required.
    #[inline]
    pub fn signer_seeds(bump: &[u8; 1]) -> [&[u8]; 2] {
        [Self::SEED, bump]
    }
}

// Layout pin: any change to a field's width or count fails this at compile
// time. Changing it is an account-size change, so already-deployed configs
// cannot be reallocated in place. New fields are consumed from the FRONT of
// `reserved`, holding LEN constant — never by growing the account.
const _: () = assert!(PsmConfig::LEN == 754);
