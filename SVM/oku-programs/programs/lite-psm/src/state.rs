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

    /// Solana slot of last yield distribution (sandwich prevention).
    /// Operations like mint/redeem are blocked in the same slot as yield distribution.
    pub last_yield_distribution_slot: u64,

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

    // ===== Cross-chain multiplier sync window =====
    //
    // Closes the cross-chain arbitrage surface: while a multiplier tick is
    // propagating between EVM and SVM the two chains disagree on price, and
    // any conversion through the multiplier in that interval transacts at a
    // stale price on one side. Blocks exactly the price-sensitive
    // instructions (`mint_oku_m`, `redeem_oku_m`) and nothing else.
    //
    // Independent of, and additive to, `last_yield_distribution_slot`. That
    // field remains a same-slot atomic-re-entry fence measured in slots;
    // this one is a multi-second propagation window measured in wall-clock
    // seconds. Different units for different jobs — see
    // `oku_shared::sync_window` for the rationale.
    /// Unix timestamp through which the sync window is engaged (inclusive).
    /// `0` = never armed. Also serves as the anchor for the inter-window
    /// gap check, which is why `end_sync_window` truncates it to `now`
    /// rather than zeroing it.
    pub sync_lock_until_ts: i64,

    /// Orchestrator-assigned tick counter, identical on both chains for a
    /// given tick.
    ///
    /// Deliberately **not** auto-incremented on a multiplier write: EVM
    /// writes its rate roughly monthly while SVM steps daily-to-weekly, so
    /// independently-bumped counters would diverge permanently and make the
    /// parity check useless. The orchestrator assigns the number, both
    /// chains record it, and `epoch_evm == epoch_svm` becomes a meaningful
    /// externally-verifiable statement that no tick is mid-flight.
    pub sync_epoch: u64,

    /// The epoch during which a multiplier write most recently landed.
    ///
    /// `end_sync_window(N)` requires `last_write_epoch == N`, which is what
    /// stops a window being opened and closed with nothing having happened.
    /// Without it, "open, forget to write, close" leaves `sync_epoch = N`
    /// against an untouched multiplier and the cross-chain parity check
    /// reports OK — a false negative on the one check that exists.
    ///
    /// With it, `sync_epoch` means "this chain actually wrote for tick N".
    ///
    /// SVM-only concept. EVM accrues continuously and has nothing to land per
    /// tick; its role in a window is to hold still while this chain catches up.
    pub last_write_epoch: u64,

    /// Configured window length in seconds. `0` = inert (arming blocks
    /// nothing beyond the instant of the write itself), which is the
    /// initialization default so the mechanism ships audited but dormant.
    /// Bounded by `MAX_SYNC_WINDOW_SECS`.
    pub sync_window_secs: i64,

    // ===== PSM fees =====
    //
    // `tin` / `tout` from the upstream `dss-lite-psm` this PSM was modelled
    // on. `tout` is the mechanism that closes *local* step arbitrage —
    // minting at `M0`, holding across a discrete multiplier step, and
    // redeeming at `M1`. The sync window cannot address that (the attacker
    // transacts outside it); a fee exceeding the maximum step yield makes
    // the round trip unprofitable by construction.
    //
    // Both default to 0 and are bounded by `MAX_FEE_BPS`.
    /// Mint fee in basis points, charged on the USDC deposited.
    pub tin_bps: u64,

    /// Redemption fee in basis points, charged on the USDC paid out.
    /// This is the step-arbitrage control; `tin` is present for upstream
    /// parity and operator flexibility.
    pub tout_bps: u64,

    /// High-water mark of every multiplier step ever taken, in basis points,
    /// rounded up. `set_fees` refuses any `tout_bps` below it.
    ///
    /// This is the second half of the step-arbitrage invariant. The first half
    /// (`step_is_covered`, enforced at write time) stops an operator creating
    /// exposure the current fee does not cover. This half stops them *removing*
    /// coverage afterwards — otherwise "raise tout, take a big step, lower tout"
    /// hands a cheap exit to everyone who held across the step.
    ///
    /// A time-based cooldown was considered and rejected: the attacker's edge is
    /// locked in when the step lands and does not decay, and the multiplier is
    /// monotonic so waiting costs them nothing. A cooldown delays the profit
    /// rather than removing it. A high-water mark has no expiry.
    ///
    /// Less restrictive than it sounds: it pins the fee only against steps
    /// actually taken. If every step was 1.4 bps, the fee can still be lowered
    /// to 1.4 bps. Cleared only by the explicit, separately-gated
    /// `reset_step_high_water_mark`.
    pub max_step_bps: u64,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned to 618 bytes by the
    /// compile-time assertion below; if a reviewer changes a field's
    /// width the assertion fires.
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
// compile. Byte breakdown (618 total):
//
//   8   account discriminator
//   1   bump (u8)
//   512 16 pubkeys * 32:
//         12 authorities (role_admin, pauser, unpauser, freezer, unfreezer,
//            buffer_depositor, buffer_withdrawer, cap_manager,
//            allowance_manager, rebaser, direct_minter, direct_burner)
//         1  pending_role_admin
//         3  token refs (usdc_mint, oku_m_mint, vault_usdc)
//   96  12 8-byte scalars (u64/i64):
//         5 pre-existing (max_supply, minter_allowance,
//           last_yield_distribution_slot, direct_minter_allowance,
//           direct_burner_allowance)
//         4 sync window (sync_lock_until_ts, sync_epoch, last_write_epoch,
//           sync_window_secs)
//         3 fees / step coverage (tin_bps, tout_bps, max_step_bps)
//   1   is_paused (bool)
const _: () = assert!(PsmConfig::LEN == 618);
