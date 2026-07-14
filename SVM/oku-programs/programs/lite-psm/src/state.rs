//! Account state definitions for the Lite-PSM program.
//!
//! Single-token design: the PSM deals exclusively in **usdOku** (a
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
/// Seeds: `["psm_config_v5"]`. Migration history (seed-rotation log) is
/// tracked in `SVM/README.md` § "PDA seed history"; the `_v5` suffix
/// marks the single-token (usdOku) layout with ScaledUiAmount.
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
    /// Orchestrator - process redemption queue
    pub queue_processor: Pubkey,
    /// Orchestrator - deposit USDC buffer
    pub buffer_depositor: Pubkey,
    /// Cold Multisig - withdraw buffer
    pub buffer_withdrawer: Pubkey,
    /// Cold Multisig - set max supply
    pub cap_manager: Pubkey,
    /// Cold Multisig - reset minter allowance
    pub allowance_manager: Pubkey,
    /// Orchestrator - update multiplier on the usdOku mint
    pub rebaser: Pubkey,

    // ===== Token References =====
    /// USDC mint address
    pub usdc_mint: Pubkey,
    /// usdOku mint address (Token-2022 with ScaledUiAmount extension).
    /// The multiplier for USDC ↔ usdOku conversion is read from the
    /// mint's ScaledUiAmountConfig extension, not stored on PsmConfig.
    pub usd_oku_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc: Pubkey,
    /// PSM's usdOku escrow vault for queued redemptions (ATA).
    /// Holds raw usdOku while users are in queue.
    pub vault_usd_oku: Pubkey,

    // ===== Limits =====
    /// Maximum usdOku supply cap (in raw token units)
    pub max_supply: u64,
    /// Mint allowance remaining (configurable cap on freshly minted usdOku
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
    // Permissioned direct usdOku mint path — no USDC collateral required
    // on-chain. Matches EVM `usdOku.mint(to, amount)` called by an
    // authorised minter role holder. The fiat collateral is held off-chain.
    /// Operator / fiat gateway — can mint usdOku directly without USDC.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_minter: Pubkey,

    /// Per-direct-minter allowance (separate from the USDC-backed
    /// `minter_allowance`). Decremented on each direct mint; reset by
    /// `allowance_manager` via `set_direct_minter_allowance`.
    pub direct_minter_allowance: u64,

    // ===== Direct Burn (bridge / off-ramp) =====
    //
    // Permissioned direct usdOku burn path — burns usdOku from the
    // caller's ATA without USDC payout. Enables SVM→EVM bridging
    // where the KMS-backed orchestrator burns on the source chain.
    /// Operator / bridge backend — can burn usdOku directly without
    /// triggering a USDC redemption.
    /// `Pubkey::default()` means "not configured / disabled".
    pub direct_burner: Pubkey,

    /// Per-direct-burner allowance. Decremented on each direct burn;
    /// reset by `allowance_manager` via `set_direct_burner_allowance`.
    pub direct_burner_allowance: u64,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config_v5";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned to 626 bytes by the
    /// compile-time assertion below; if a reviewer changes a field's
    /// width the assertion fires.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

// Compile-time assertion: if PsmConfig layout changes, this will fail to compile.
// (626 = 8 disc + 1 bump + 32*11 authorities (352)
//      + 32*2 token mints (usdc_mint + usd_oku_mint = 64)
//      + 32*2 vaults (vault_usdc + vault_usd_oku = 64)
//      + 8 max_supply + 8 minter_allowance + 1 is_paused
//      + 8 last_yield_distribution_slot
//      + 32 pending_role_admin
//      + 32 direct_minter + 8 direct_minter_allowance
//      + 32 direct_burner + 8 direct_burner_allowance.)
const _: () = assert!(PsmConfig::LEN == 626);

/// Redemption queue PDA — zero-copy ring buffer.
///
/// Uses `#[account(zero_copy)]` rather than `#[account]` so the 200-entry
/// array isn't Borsh-deserialised into a stack frame on every handler
/// entry. `AccountLoader<RedemptionQueue>` is the canonical access path;
/// `load_init` for `setup_redemption_queue`, `load` / `load_mut`
/// elsewhere with the borrow strictly scoped before any CPI.
///
/// **Why 200 entries.** Solana caps CPI-driven account allocations at
/// `MAX_PERMITTED_DATA_INCREASE = 10_240` bytes per call (Anchor's `init`
/// constraint goes through `system_program::create_account`). 200
/// entries × 48 B = 9 600 B fits with 600 B of headroom; a single-step
/// `setup_redemption_queue` would otherwise require a `init + realloc +
/// realloc` flow. See `SVM/README.md` § "EVM vs SVM — divergence
/// catalogue" for the EVM divergence note.
///
/// Wire layout (`#[repr(C)]`, packed to native alignment):
///
/// ```text
///   8   Anchor discriminator
///   1   bump
///   7   _pad0  (align head to 8)
///   8   head
///   8   tail
///   8   total_queued_usd_oku
///  48 * 200   entries
/// ```
///
/// Total: 8 + 1 + 7 + 8 + 8 + 8 + 9_600 = **9 640** bytes. See the
/// compile-time `assert!` below.
///
/// Field-access rules:
/// - Use `AccountLoader<RedemptionQueue>` in contexts, never
///   `Account<RedemptionQueue>` — the latter would attempt to Borsh-deserialize
///   the whole struct into a stack frame and overflow.
/// - `load()` for read-only, `load_mut()` for read-write. Drop the borrow
///   before any CPI that re-borrows the account info (the borrow is a
///   runtime `RefCell` borrow under the hood).
/// - `load_init()` only at the one `init`-constraint site
///   (`setup_redemption_queue`).
///
/// Seeds: `["redemption_queue_v3"]`. Rotation history tracked in
/// `SVM/README.md` § "PDA seed history".
#[account(zero_copy)]
#[repr(C)]
pub struct RedemptionQueue {
    /// PDA bump seed
    pub bump: u8,
    /// Padding so `head` lands on an 8-byte boundary. Reserved; do not use.
    pub _pad0: [u8; 7],
    /// Index of next entry to process (head of queue). u64 so the
    /// absolute counter is effectively unbounded
    /// (~5.8 × 10¹⁰ years at 100 enqueues/sec); ring-buffer position
    /// is `RedemptionQueue::ring_index(head)`.
    pub head: u64,
    /// Index of next slot to write (tail of queue).
    pub tail: u64,
    /// Running total of raw usdOku held in escrow (updated on
    /// enqueue/process/rescue).
    pub total_queued_usd_oku: u64,
    /// Ring-buffer entries. Index into via
    /// `entries[(head_or_tail % MAX_ENTRIES) as usize]`.
    pub entries: [QueueEntry; RedemptionQueue::MAX_ENTRIES],
}

impl RedemptionQueue {
    pub const SEED: &'static [u8] = b"redemption_queue_v3";

    /// Maximum queue entries: 200.
    ///
    /// 200 × 48 B = 9 600 B of array, which fits inside Solana's
    /// `MAX_PERMITTED_DATA_INCREASE = 10_240` CPI allocation cap with
    /// 600 B headroom. Account rent at this size is ~0.067 SOL, paid
    /// once at `setup_redemption_queue` by the deployer keypair.
    pub const MAX_ENTRIES: usize = 200;

    /// Account size (8-byte Anchor discriminator + struct size).
    ///
    /// The `assert!` below pins the value at the Rust-tracked figure 24_040
    /// and will hard-fail to compile if a field-type change drifts the
    /// layout. The TS-side mirror lives in `scripts/lib/account-sizes.ts`.
    pub const LEN: usize = 8 + core::mem::size_of::<Self>();

    /// Check if the queue is full
    pub fn is_full(&self) -> bool {
        self.pending_count() >= Self::MAX_ENTRIES as u64
    }

    /// Check if the queue is empty
    pub fn is_empty(&self) -> bool {
        self.head == self.tail
    }

    /// Get number of pending entries (wrapping subtraction handles u64 overflow).
    pub fn pending_count(&self) -> u64 {
        self.tail.wrapping_sub(self.head)
    }

    /// Per-batch processing cap. Larger values risk exceeding the
    /// Solana CU budget on a single `process_queue` call; the previous
    /// cap of 50 was chosen empirically.
    ///
    /// Cycle 4 (PSM-18): moved onto the impl block from a free `pub
    /// const` in `instructions::psm`; lives next to `MAX_ENTRIES` so a
    /// reviewer reading `state.rs` sees both queue-shape constants at
    /// once.
    pub const MAX_BATCH_ENTRIES: u32 = 50;

    /// Cycle 4 (PSM-30): canonical helper for the `abs_index → ring
    /// slot` modulo + cast pattern. Replaces ~4 inline
    /// `#[allow(clippy::cast_possible_truncation)]` blocks across
    /// the instruction module. Safe because the result is bounded by
    /// `MAX_ENTRIES` (= 200), well below `usize::MAX` on BPF (64-bit
    /// platform).
    #[allow(clippy::arithmetic_side_effects, clippy::cast_possible_truncation)]
    #[inline]
    pub const fn ring_index(abs_index: u64) -> usize {
        (abs_index % Self::MAX_ENTRIES as u64) as usize
    }
}

/// A single entry in the redemption queue.
///
/// `#[zero_copy]` is Anchor's marker for inner types embedded in
/// `#[account(zero_copy)]` accounts — derives `Pod` + `Zeroable` and
/// registers the type with the IDL. `#[repr(C)]` has no implicit
/// padding here (`Pubkey` is align-1, `u64`/`i64` align-8); the layout
/// is pinned to 48 bytes by the `assert!` below.
#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct QueueEntry {
    /// User who is owed redemption
    pub user: Pubkey,
    /// Raw usdOku amount held in escrow.
    /// The actual USDC payout is calculated at `process_queue` time using
    /// the multiplier from the usdOku mint's ScaledUiAmountConfig extension.
    pub raw_usd_oku_amount: u64,
    /// Timestamp when queued (kept for audit trail)
    pub timestamp: i64,
}

impl QueueEntry {
    /// Space for a single queue entry (no account discriminator — inner
    /// type only): `32 user + 8 raw_usd_oku_amount + 8 timestamp = 48 bytes`.
    pub const LEN: usize = core::mem::size_of::<Self>();
}

// Compile-time assertions: lock the on-chain layout for the queue family.
// Any field-type drift will fail to compile here with a clear pointer back.
const _: () = assert!(QueueEntry::LEN == 48);
const _: () = assert!(core::mem::size_of::<RedemptionQueue>() == 9_632);
const _: () = assert!(RedemptionQueue::LEN == 9_640);
// 9_640 is comfortably under Solana's `MAX_PERMITTED_DATA_INCREASE = 10_240`
// CPI-allocation cap, so `setup_redemption_queue` can allocate in one shot.

// Cycle 4 (PSM-20): historical "bridge state removed" note moved out
// of source. See `lib.rs` for the orchestrator-bridge model and
// `SVM/README.md` § "PDA seed history" for the on-chain removal
// history.
