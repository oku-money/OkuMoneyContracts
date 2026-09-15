//! Account state definitions for the Lite-PSM program.
//!
//! Single-token design: the PSM deals exclusively in **OkuM** (a
//! Token-2022 mint with the `ScaledUiAmount` extension). The multiplier
//! that converts raw token amounts to dollar-display values lives on the
//! mint itself, not in PsmConfig.
//!
//! Storage patterns adapted from a few upstream sources:
//! - The minter-allowance + blacklist-exempt fields on `PsmConfig` mirror
//!   Circle's FiatToken minter / blacklist controller pattern.
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2_2.sol
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol

use anchor_lang::prelude::*;

/// PSM configuration PDA.
///
/// Seeds: `["psm_config"]`. This is the single, program-wide config
/// account; it holds the granular authorities, token references, limits,
/// and the yield-distribution slot.
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
    /// The multiplier for USDC ↔ OkuM conversion is read from the
    /// mint's ScaledUiAmountConfig extension, not stored on PsmConfig.
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
    /// Under streaming accrual the multiplier advances continuously, so there
    /// is no discrete jump for a searcher to sandwich — that is the entire
    /// point of the model. This lock therefore fires ONLY on the explicit
    /// override path, and in particular is NOT stamped by the routine display
    /// sync. Mirrors EVM, where `YieldSandwichGuard` keys on
    /// `lastYieldDistributionBlock`, which only `setOkuMMultiplier` writes
    /// (`EVM/src/token/OkuMoney.sol:107`, `EVM/src/lib/YieldSandwichGuard.sol:21-26`).
    pub last_yield_distribution_slot: u64,

    // ===== Streaming accrual rate schedule =====
    //
    // The OkuM multiplier is NOT stored. It is computed on read from the six
    // fields below plus `Clock::unix_timestamp`, via
    // `oku_shared::rate::compute_multiplier`. Because the function has no
    // supply term, every chain holding the same schedule returns the same
    // value at the same wall-clock second — with no messaging, and with no
    // transaction at the epoch boundary.
    //
    // 1:1 with the EVM accrual storage at `EVM/src/token/OkuMoney.sol:78-96`.
    // EVM bit-packs these into two slots (uint96/uint64/uint48); SVM has no
    // equivalent pressure, so each field gets its natural width.
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
    /// Display-only bookkeeping: drives the staleness threshold for the
    /// opportunistic piggyback sync on PSM instructions. Has no influence on
    /// pricing — the canonical multiplier is always computed fresh.
    pub last_display_sync_ts: i64,

    /// Pending `role_admin` rotation target — the two-step admin-transfer
    /// model (OpenZeppelin `Ownable2Step` pattern). `set_authority(RoleAdmin,
    /// new_admin)` writes to this slot only; the rotation does NOT take
    /// effect until `new_admin` signs `accept_role_admin`, which moves the
    /// value into `role_admin` and clears the slot. This protects the
    /// protocol from a typo or stale key on the proposing side silently
    /// locking out the meta-role.
    ///
    /// `Pubkey::default()` means "no pending rotation".
    pub pending_role_admin: Pubkey,

    // ===== Direct Mint (fiat on-ramp) =====
    //
    // Permissioned direct OkuM mint path — no USDC collateral required
    // on-chain. Matches EVM `OkuM.mint(to, amount)` called by an
    // authorised minter role holder. The fiat collateral is held off-chain.
    /// Operator / fiat gateway — can mint OkuM directly without USDC.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_minter: Pubkey,

    /// Per-direct-minter allowance (separate from the USDC-backed
    /// `minter_allowance`). Decremented on each direct mint; reset by
    /// `allowance_manager` via `set_direct_minter_allowance`.
    pub direct_minter_allowance: u64,

    // ===== Direct Burn (bridge / off-ramp) =====
    //
    // Permissioned direct OkuM burn path — burns OkuM from the
    // caller's ATA without USDC payout. Enables SVM→EVM bridging
    // where the KMS-backed orchestrator burns on the source chain.
    /// Operator / bridge backend — can burn OkuM directly without
    /// triggering a USDC redemption.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_burner: Pubkey,

    /// Per-direct-burner allowance. Decremented on each direct burn;
    /// reset by `allowance_manager` via `set_direct_burner_allowance`.
    pub direct_burner_allowance: u64,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned by the compile-time assertion
    /// below; if a reviewer changes a field's width the assertion fires.
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// PDA signer seeds for CPIs signed by the config PDA.
    ///
    /// Single source of truth for the `[SEED, [bump]]` seed shape that every
    /// PDA-signed CPI in this program needs. The caller owns the 1-byte bump
    /// array and passes a reference, so no allocation or lifetime juggling is
    /// required:
    ///
    /// ```ignore
    /// let bump = [ctx.accounts.config.bump];
    /// let seeds = PsmConfig::signer_seeds(&bump);
    /// let signer = &[&seeds[..]];
    /// // ... CpiContext::new_with_signer(..., signer)
    /// ```
    #[inline]
    pub fn signer_seeds(bump: &[u8; 1]) -> [&[u8]; 2] {
        [Self::SEED, bump]
    }
}

// Compile-time assertion: if the PsmConfig layout changes, this fails to
// compile. Byte breakdown (626 total):
//
//   8   account discriminator
//   1   bump (u8)
//   512 16 pubkeys * 32:
//         12 authorities (role_admin, pauser, unpauser, freezer, unfreezer,
//            buffer_depositor, buffer_withdrawer, cap_manager,
//            allowance_manager, rebaser, direct_minter, direct_burner)
//         1  pending_role_admin
//         3  token refs (usdc_mint, oku_m_mint, vault_usdc)
//   40  5 u64 * 8 (max_supply, minter_allowance, last_yield_distribution_slot,
//         direct_minter_allowance, direct_burner_allowance)
//   1   is_paused (bool)
//  --- streaming accrual (added with the rate-schedule port) ---
//   16  okum_base_multiplier (u128)
//   16  2 u64 * 8 (okum_rate_per_second, okum_pending_rate_per_second)
//   32  4 i64 * 8 (okum_last_accrual_time, okum_rate_end,
//         okum_pending_rate_end, last_display_sync_ts)
//
// The 562 -> 626 growth means existing accounts cannot be reallocated in
// place. SVM is devnet-only (`deployments/` has no mainnet entry), so this
// is a fresh deploy — already tracked in TRACKER.md and SVM/DECISIONS.md D-07.
const _: () = assert!(PsmConfig::LEN == 626);
