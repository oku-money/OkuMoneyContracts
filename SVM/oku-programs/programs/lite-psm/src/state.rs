//! Account state definitions for the Lite-PSM program.
//!
//! Storage patterns adapted from a few upstream sources:
//! - The minter-allowance + blacklist-exempt fields on `PsmConfig` mirror
//!   Circle's FiatToken minter / blacklist controller pattern.
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/FiatTokenV2_2.sol
//!   Taken from https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/Blacklistable.sol
//! - `ProcessedRequest` / `RefundedRequest` use Anchor's `init` constraint as a
//!   one-shot replay nonce (PDA exists ⇒ already processed).
//!   Taken from https://www.anchor-lang.com/docs/account-constraints
//! - `BridgeRequest` 80-byte packed message + keccak request_id is the SVM
//!   port of the EVM-side `OkuBridge.sol` orchestrator-signed bridge protocol.
//!   See `contracts/EVM/src/bridge/OkuBridge.sol` for the source-chain side.

use crate::errors::LitePsmError;
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
    /// Bridge mint allowance remaining
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

    /// Blacklist-exempt bridge address (cannot be frozen)
    pub blacklist_exempt_bridge: Pubkey,
    /// Blacklist-exempt router address (cannot be frozen)
    pub blacklist_exempt_router: Pubkey,

    /// Pyth program owner pubkey accepted by `check_oracle_reserves`.
    /// Replaces the previously hard-coded mainnet/devnet Pyth-V2 program IDs.
    /// Set at init via `initialize(pyth_program_owner)` and rotatable via
    /// `set_pyth_program_owner` (oracle_manager-gated). A deployer can point
    /// this at the legacy Pyth program (mainnet `FsJ3...`, devnet `gSbe...`)
    /// or, after parser support is added, at the Pyth Solana Receiver
    /// (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`).
    pub pyth_program_owner: Pubkey,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned to 690 bytes by the
    /// compile-time assertion below; if a reviewer changes a field's
    /// width the assertion fires.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

// Compile-time assertion: if PsmConfig layout changes, this will fail to compile.
// (690 = 8 disc + 32*12 authorities + 32*4 token refs + 8*2 limits + 1 paused
//      + 32 oracle + 8 staleness + 8 last_yield_slot + 8 oku_m_price
//      + 32*2 blacklist_exempt + 32 pyth_program_owner + 1 bump.)
const _: () = assert!(PsmConfig::LEN == 690);

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

/// Bridge configuration PDA
/// Seeds: ["bridge_config"]
#[account]
#[derive(InitSpace)]
pub struct BridgeConfig {
    /// PDA bump seed
    pub bump: u8,

    // ===== Bridge-Specific Authorities (12 roles, separate from PSM) =====
    /// Bridge admin - manages bridge roles (meta-role)
    /// EVM: DEFAULT_ADMIN_ROLE
    pub bridge_admin: Pubkey,
    /// Bridge pauser - emergency pause
    /// EVM: BRIDGE_PAUSER
    pub bridge_pauser: Pubkey,
    /// Bridge unpauser - unpause
    /// EVM: BRIDGE_UNPAUSER
    pub bridge_unpauser: Pubkey,
    /// Orchestrator signer - Ed25519 public key for signature verification
    pub orchestrator_signer: Pubkey,
    /// Fee recipient - receives bridge fees
    pub fee_recipient: Pubkey,
    /// Chain manager - add/remove supported chains
    /// EVM: BRIDGE_CHAIN_MANAGER
    pub chain_manager: Pubkey,
    /// Fee manager - update fee configuration and fee recipient
    /// EVM: BRIDGE_FEE_MANAGER
    pub fee_manager: Pubkey,
    /// Nonce admin - emergency nonce management
    /// EVM: BRIDGE_NONCE_ADMIN
    pub nonce_admin: Pubkey,
    /// Refund initiator - initiate refunds (step 1 of two-step refund)
    /// EVM: BRIDGE_REFUND_INITIATOR
    pub refund_initiator: Pubkey,
    /// Refund confirmer - confirm refunds (step 2 of two-step refund)
    /// Must be different key than refund_initiator to prevent single-key double-mint
    /// EVM: BRIDGE_REFUND_CONFIRMER
    pub refund_confirmer: Pubkey,
    /// Signer manager - update orchestrator signer (Cold Multisig)
    /// EVM: BRIDGE_SIGNER_MANAGER
    pub signer_manager: Pubkey,
    /// Limits manager - update bridge limits and deadline (Cold Multisig)
    /// EVM: BRIDGE_LIMITS_MANAGER
    pub limits_manager: Pubkey,

    // ===== Configuration =====
    /// Bridge fee in basis points (10 = 0.1%)
    pub bridge_fee_bps: u16,
    /// Minimum bridge amount
    pub min_bridge_amount: u64,
    /// Maximum bridge amount
    pub max_bridge_amount: u64,
    /// Whether bridge is paused
    pub is_paused: bool,

    /// Configurable bridge deadline in seconds (default 3600 = 1 hour)
    pub bridge_deadline_secs: i64,

    // ===== Chain Identity =====
    /// This chain's ID (e.g., Solana), set during initialize_bridge
    pub source_chain_id: u16,

    // ===== Chain Whitelist =====
    /// Supported destination chain IDs (fixed array, max 32 chains)
    pub supported_chains: [u16; 32],
    /// Number of active chains in the array
    pub supported_chains_count: u8,
}

impl BridgeConfig {
    pub const SEED: &'static [u8] = b"bridge_config";

    /// Space needed for BridgeConfig account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned at 487 bytes by the
    /// assertion below.
    pub const LEN: usize = 8 + Self::INIT_SPACE;

    /// Check if a chain is supported
    pub fn is_chain_supported(&self, chain_id: u16) -> bool {
        self.supported_chains[..self.supported_chains_count as usize].contains(&chain_id)
    }

    /// Add a supported chain (returns error if full or already exists).
    ///
    /// Rejects:
    /// - `chain_id == 0` (reserved sentinel)
    /// - `chain_id == self.source_chain_id` (would allow self-bridging — mirrors
    ///   EVM `OkuBridge.bridgeBurn`'s `if (destChainId == block.chainid)` guard,
    ///   moved to admin-time so the runtime path doesn't need to re-check it)
    /// - duplicates
    /// - capacity overflow
    pub fn add_chain(&mut self, chain_id: u16) -> Result<()> {
        require!(chain_id != 0, LitePsmError::InvalidChainId);
        require!(
            chain_id != self.source_chain_id,
            LitePsmError::InvalidChainId
        );
        require!(
            !self.is_chain_supported(chain_id),
            LitePsmError::ChainAlreadySupported
        );
        require!(self.supported_chains_count < 32, LitePsmError::ChainListFull);

        self.supported_chains[self.supported_chains_count as usize] = chain_id;
        self.supported_chains_count += 1;
        Ok(())
    }

    /// Remove a supported chain.
    ///
    /// Uses a swap-remove (move the last element into the removed slot) since the
    /// supported-chains list is unordered — O(1) instead of an O(n) shift.
    pub fn remove_chain(&mut self, chain_id: u16) -> Result<()> {
        let count = self.supported_chains_count as usize;
        for i in 0..count {
            if self.supported_chains[i] == chain_id {
                let last = count - 1;
                self.supported_chains[i] = self.supported_chains[last];
                self.supported_chains[last] = 0;
                self.supported_chains_count -= 1;
                return Ok(());
            }
        }
        Err(error!(LitePsmError::ChainNotFound))
    }
}

/// Bridge nonce tracking PDA (one per destination chain)
/// Seeds: ["bridge_nonce", destination_chain_id.to_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct BridgeNonce {
    /// PDA bump seed
    pub bump: u8,
    /// Whether this nonce account has been initialized (avoids ambiguity with chain_id == 0)
    pub is_initialized: bool,
    /// Destination chain ID
    pub destination_chain: u16,
    /// Next sequential nonce for this destination
    pub next_nonce: u64,
}

impl BridgeNonce {
    pub const SEED: &'static [u8] = b"bridge_nonce";

    /// Space needed for BridgeNonce account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned at 20 bytes.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

/// Processed bridge request PDA (prevents replay attacks)
/// Seeds: ["bridge_request", request_id]
#[account]
#[derive(InitSpace)]
pub struct ProcessedRequest {
    /// PDA bump seed
    pub bump: u8,
    /// Request ID (keccak256 hash of request data)
    pub request_id: [u8; 32],
    /// Timestamp when processed
    pub processed_at: i64,
    /// Recipient who received tokens
    pub recipient: Pubkey,
    /// Amount minted
    pub amount: u64,
}

impl ProcessedRequest {
    pub const SEED: &'static [u8] = b"bridge_request";

    /// Space needed for ProcessedRequest account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned at 89 bytes.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

/// Refunded bridge request PDA (prevents double-refund)
/// Seeds: ["bridge_refund", request_id]
#[account]
#[derive(InitSpace)]
pub struct RefundedRequest {
    /// PDA bump seed
    pub bump: u8,
    /// Request ID (keccak256 hash of request data)
    pub request_id: [u8; 32],
    /// Timestamp when refunded
    pub refunded_at: i64,
    /// Original sender who received refund
    pub recipient: Pubkey,
    /// Amount refunded
    pub amount: u64,
}

impl RefundedRequest {
    pub const SEED: &'static [u8] = b"bridge_refund";

    /// Space needed for RefundedRequest account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned at 89 bytes.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

/// Pending refund PDA (two-step refund pattern)
/// Seeds: ["pending_refund", request_id]
///
/// This implements the EVM OkuBridge two-step refund pattern:
/// 1. RefundInitiator calls initiate_refund() to create this PDA
/// 2. RefundConfirmer (different key) calls confirm_refund() to complete
/// 3. Either party can call cancel_refund() to abort
///
/// This prevents a single compromised key from completing refunds unilaterally.
#[account]
#[derive(InitSpace)]
pub struct PendingRefund {
    /// PDA bump seed
    pub bump: u8,
    /// Request ID (keccak256 hash of original request data)
    pub request_id: [u8; 32],
    /// Original sender who will receive the refund
    pub recipient: Pubkey,
    /// Amount to be refunded
    pub amount: u64,
    /// Timestamp when refund was initiated
    pub initiated_at: i64,
    /// Who initiated the refund (for audit trail)
    pub initiator: Pubkey,
}

impl PendingRefund {
    pub const SEED: &'static [u8] = b"pending_refund";

    /// Space needed for PendingRefund account: 8 byte discriminator +
    /// `InitSpace`-derived field sum. Pinned at 121 bytes.
    pub const LEN: usize = 8 + Self::INIT_SPACE;
}

// Compile-time assertions: bridge family on-chain layout pins.
const _: () = assert!(BridgeConfig::LEN == 487);
const _: () = assert!(BridgeNonce::LEN == 20);
const _: () = assert!(ProcessedRequest::LEN == 89);
const _: () = assert!(RefundedRequest::LEN == 89);
const _: () = assert!(PendingRefund::LEN == 121);



/// EVM-burn → SVM-mint bridge request (80 bytes on the wire).
///
/// Used for signature verification and replay prevention by `bridge_mint`.
///
/// **CRITICAL — dual 80-byte layouts.** The bridge has two distinct on-wire
/// formats sharing the same total length, distinguished by direction:
///
/// ```text
///   SVM-burn → EVM-mint (built by `bridge_burn`):
///     2  source_chain_id  | 2  dest_chain_id
///    32  sender (Solana)  | 20 recipient (EVM)
///     8  amount           | 8  nonce          | 8 deadline
///
///   EVM-burn → SVM-mint (this struct, built by `to_message_bytes`):
///     2  source_chain_id  | 2  dest_chain_id
///    20  sender (EVM)     | 32 recipient (Solana)
///     8  amount           | 8  nonce          | 8 deadline
/// ```
///
/// `request_id = keccak256(message_bytes)`. The TS canonical encoder lives in
/// `scripts/lib/bridge/message.ts`. See `SVM/EVM_VS_SVM.md` for the full
/// bridge-format reference.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BridgeRequest {
    /// Source chain ID (EVM chain)
    pub source_chain_id: u16,
    /// Destination chain ID (Solana)
    pub destination_chain_id: u16,
    /// Sender address on source chain (20 bytes for EVM)
    pub sender: [u8; 20],
    /// Recipient address on destination chain (32 bytes for Solana)
    pub recipient: [u8; 32],
    /// Amount to mint (excluding fees)
    pub amount: u64,
    /// Sequential nonce for ordering
    pub nonce: u64,
    /// Request expiration timestamp
    pub deadline: i64,
}

impl BridgeRequest {
    /// Serialize to 80-byte message format for signature verification
    pub fn to_message_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(80);
        bytes.extend_from_slice(&self.source_chain_id.to_le_bytes());
        bytes.extend_from_slice(&self.destination_chain_id.to_le_bytes());
        bytes.extend_from_slice(&self.sender);
        bytes.extend_from_slice(&self.recipient);
        bytes.extend_from_slice(&self.amount.to_le_bytes());
        bytes.extend_from_slice(&self.nonce.to_le_bytes());
        bytes.extend_from_slice(&self.deadline.to_le_bytes());
        bytes
    }
}
