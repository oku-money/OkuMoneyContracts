//! Account state definitions for the Lite-PSM program.
//!
//! Storage patterns adapted from a few upstream sources:
//! - The minter-allowance + blacklist-exempt fields on `PsmConfig` mirror
//!   Circle's FiatToken minter / blacklist controller pattern.
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2_2.sol
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol

use anchor_lang::prelude::*;

/// PSM configuration PDA
/// Seeds: ["psm_config"]
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
    /// Cold Multisig - configure oracle
    pub oracle_manager: Pubkey,
    /// Cold Multisig - set max supply
    pub cap_manager: Pubkey,
    /// Cold Multisig - reset minter allowance
    pub allowance_manager: Pubkey,
    /// Orchestrator - update interest rate
    pub rebaser: Pubkey,

    // ===== Token References =====
    /// USDC mint address
    pub usdc_mint: Pubkey,
    /// OkuMoney mint address (Token-2022 with InterestBearingConfig extension).
    /// The extension is informational only — economic price comes from
    /// `oku_m_price` on this account, not from the mint's interest accrual.
    pub oku_money_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc: Pubkey,
    /// PSM's OkuMoney escrow vault for queued redemptions (ATA)
    /// Holds OkuMoney while users are in queue (yield comes from price appreciation)
    pub vault_oku_money: Pubkey,

    // ===== Limits =====
    /// Maximum OkuMoney supply cap
    pub max_supply: u64,
    /// Mint allowance remaining (configurable cap on freshly minted OkuMoney
    /// between admin resets, mirroring the EVM `minterAllowance` pattern).
    pub minter_allowance: u64,
    /// Whether the PSM is paused
    pub is_paused: bool,

    // ===== Oracle =====
    /// Pyth oracle feed (or Pubkey::default() if disabled)
    pub oracle: Pubkey,
    /// Maximum oracle staleness in seconds
    pub staleness_threshold: i64,
    /// Solana slot of last yield distribution (sandwich prevention)
    /// Operations like mint/redeem are blocked in the same slot as yield distribution
    pub last_yield_distribution_slot: u64,

    // ===== OkuMoney Price =====
    /// Current OkuMoney price multiplier (1e9 = $1.00)
    /// Updated by set_oku_m_price() or distribute_yield()
    /// Matches EVM's okuMPrice() storage pattern
    pub oku_m_price: u64,

    /// Pyth program owner pubkey accepted by `check_oracle_reserves`.
    /// Replaces the previously hard-coded mainnet/devnet Pyth-V2 program IDs.
    /// Set at init via `initialize(pyth_program_owner)` and rotatable via
    /// `set_pyth_program_owner` (oracle_manager-gated). A deployer can point
    /// this at the legacy Pyth program (mainnet `FsJ3...`, devnet `gSbe...`)
    /// or, after parser support is added, at the Pyth Solana Receiver
    /// (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`).
    pub pyth_program_owner: Pubkey,

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
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned to 658 bytes by the
    /// compile-time assertion below; if a reviewer changes a field's
    /// width the assertion fires.
    ///
    /// noBridge phase C: shrank from 722 → 658 after removing the two
    /// `blacklist_exempt_*` Pubkey slots (−64 bytes).
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

// Compile-time assertion: if PsmConfig layout changes, this will fail to compile.
// (658 = 8 disc + 32*12 authorities + 32*4 token refs + 8*2 limits + 1 paused
//      + 32 oracle + 8 staleness + 8 last_yield_slot + 8 oku_m_price
//      + 32 pyth_program_owner + 32 pending_role_admin + 1 bump.)
const _: () = assert!(PsmConfig::LEN == 658);

/// Redemption queue PDA — zero-copy ring buffer.
///
/// Phase 13b: moved from `#[account]` (Borsh-deserialized into a stack frame
/// on every handler entry) to `#[account(zero_copy)]` (byte-indexed directly
/// out of account data, no stack pressure). This is what unblocks the
/// `MAX_ENTRIES` bump from 10 to 200; the previous cap was a BPF stack
/// constraint, not an account-size constraint.
///
/// **Why 200 and not 500.** The original Phase 13b plan targeted 500
/// entries. Solana's runtime caps CPI-driven account allocations at
/// `MAX_PERMITTED_DATA_INCREASE = 10_240` bytes per call — and Anchor's
/// `init` constraint goes through a `system_program::create_account` CPI
/// for the allocation. A 500-entry queue would be ~24 KB and require a
/// multi-step `init + realloc + realloc` deploy flow. 200 entries fits
/// into the 10 KB single-CPI budget with 600 bytes of headroom, keeps
/// the single-step `setup_redemption_queue` flow, and is still a 20×
/// improvement over the pre-Phase-13b cap of 10. See
/// `SVM/EVM_VS_SVM.md` for the divergence note.
///
/// Wire layout (`#[repr(C)]`, packed to native alignment):
///
/// ```text
///   8   Anchor discriminator
///   1   bump
///   7   _pad0  (align head to 8)
///   8   head
///   8   tail
///   8   total_queued_oku_m
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
/// Seeds: `["redemption_queue"]`.
#[account(zero_copy)]
#[repr(C)]
pub struct RedemptionQueue {
    /// PDA bump seed
    pub bump: u8,
    /// Padding so `head` lands on an 8-byte boundary. Reserved; do not use.
    pub _pad0: [u8; 7],
    /// Index of next entry to process (head of queue).
    ///
    /// Widened from `u32` (Phase 13a) to `u64` (Phase 13b). At 500 entries
    /// the previous u32 head/tail would wrap after ~4.3B enqueues — fine
    /// in practice but uncomfortably finite. `u64` is effectively unbounded
    /// (~5.8e10 years at 100 enqueues/sec).
    pub head: u64,
    /// Index of next slot to write (tail of queue). See `head` for the u64
    /// rationale.
    pub tail: u64,
    /// Running total of OkuMoney held in escrow (updated on
    /// enqueue/process/rescue).
    pub total_queued_oku_m: u64,
    /// Ring-buffer entries. Index into via
    /// `entries[(head_or_tail % MAX_ENTRIES) as usize]`.
    pub entries: [QueueEntry; RedemptionQueue::MAX_ENTRIES],
}

impl RedemptionQueue {
    pub const SEED: &'static [u8] = b"redemption_queue";

    /// Maximum queue entries: 200 (Phase 13b).
    ///
    /// Before Phase 13b this was 10 (BPF stack limit on the old
    /// `Account<RedemptionQueue>` deserialization path). The zero-copy
    /// migration eliminated the stack constraint; 200 is the largest
    /// value that fits in a single-CPI `system_program::create_account`
    /// allocation, given Solana's `MAX_PERMITTED_DATA_INCREASE = 10_240`
    /// cap on CPI-driven allocations / reallocs.
    ///
    /// 200 entries × 48 bytes = 9 600 bytes of array. Account rent at
    /// this size is ~0.067 SOL, paid once at `setup_redemption_queue`
    /// time by the deployer keypair.
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
}

/// A single entry in the redemption queue.
///
/// `#[zero_copy]` (no `unsafe`) is Anchor's marker for inner types embedded
/// in `#[account(zero_copy)]` accounts. It derives the bytemuck `Pod` +
/// `Zeroable` impls and registers the type with Anchor's IDL build so the
/// generated TS client can decode it. `#[repr(C)]` is required and has no
/// implicit padding here (`Pubkey` is align-1, `u64`/`i64` align-8; natural
/// C layout aligns correctly to 48 bytes — pinned by the assert below).
#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct QueueEntry {
    /// User who is owed redemption
    pub user: Pubkey,
    /// OkuMoney amount held in escrow.
    /// The actual USDC payout is calculated at `process_queue` time using
    /// the current `oku_m_price` multiplier.
    pub oku_m_amount: u64,
    /// Timestamp when queued (kept for audit trail)
    pub timestamp: i64,
}

impl QueueEntry {
    /// Space for a single queue entry (no account discriminator — inner
    /// type only): `32 user + 8 oku_m_amount + 8 timestamp = 48 bytes`.
    pub const LEN: usize = core::mem::size_of::<Self>();
}

// Compile-time assertions: lock the on-chain layout for the queue family.
// Any field-type drift will fail to compile here with a clear pointer back.
const _: () = assert!(QueueEntry::LEN == 48);
const _: () = assert!(core::mem::size_of::<RedemptionQueue>() == 9_632);
const _: () = assert!(RedemptionQueue::LEN == 9_640);
// 9_640 is comfortably under Solana's `MAX_PERMITTED_DATA_INCREASE = 10_240`
// CPI-allocation cap, so `setup_redemption_queue` can allocate in one shot.

// === Bridge state removed in noBridge refactor (phase B) ===
//
// `BridgeConfig`, `BridgeNonce`, `ProcessedRequest`, `RefundedRequest`,
// `PendingRefund`, and the on-wire `BridgeRequest` packed message used to
// live here. They have been deleted; v1 cross-chain transfers are handled
// off-chain by an orchestrator calling `mint_oku_m` / `redeem_oku_m` on
// each side. See the crate-level docs in `lib.rs` for the model.
