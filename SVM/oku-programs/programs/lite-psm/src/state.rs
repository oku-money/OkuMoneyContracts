use anchor_lang::prelude::*;
use crate::errors::OkuError;

/// PSM configuration PDA
/// Seeds: ["psm_config"]
#[account]
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
    /// OkuUSD mint address (Token-2022)
    pub okusd_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc: Pubkey,
    /// PSM's OkuUSD escrow vault for queued redemptions (ATA)
    /// Holds OkuUSD while users are in queue so they earn yield
    pub vault_okusd: Pubkey,

    // ===== Limits =====
    /// Maximum OkuUSD supply cap
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
    /// Current interest rate in basis points (e.g., 450 = 4.5% APY)
    /// Stored here for queue processing interest calculations
    pub current_rate_bps: i16,
    /// When current rate expires (0 = no expiry)
    pub rate_end: i64,
    /// Next rate, applied when rate_end passes (0 = none)
    pub pending_rate_bps: i16,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account
    /// 8 (discriminator) + 1 (bump) + 32*12 (authority pubkeys) + 32*4 (token pubkeys) + 8*2 (u64s) + 1 (bool) + 32 (oracle) + 8 (i64) + 2 (i16) + 8 (i64 rate_end) + 2 (i16 pending_rate_bps)
    /// = 8 + 1 + 384 + 128 + 16 + 1 + 32 + 8 + 2 + 8 + 2 = 590 bytes
    pub const LEN: usize = 8 + 1 + 32 * 12 + 32 * 4 + 8 * 2 + 1 + 32 + 8 + 2 + 8 + 2;
}

/// Redemption queue PDA
/// Seeds: ["redemption_queue"]
#[account]
pub struct RedemptionQueue {
    /// PDA bump seed
    pub bump: u8,
    /// Index of next entry to process (head of queue)
    pub head: u32,
    /// Index of next slot to write (tail of queue)
    pub tail: u32,
    /// Queue entries (fixed array for predictable sizing)
    /// Size must match MAX_ENTRIES constant below
    pub entries: [QueueEntry; 10],
}

impl RedemptionQueue {
    pub const SEED: &'static [u8] = b"redemption_queue";
    /// Maximum queue entries: 10 (limited by Solana BPF 4KB stack constraints)
    /// Note: Spec calls for 500, but Solana's 4KB BPF stack limit with complex account
    /// contexts (Initialize has 15+ accounts) constrains us to ~10 entries practically.
    /// 10 entries = 497 bytes for array, well within limits.
    /// Queue is a safety valve; if filled, operational intervention is needed (per spec).
    pub const MAX_ENTRIES: usize = 10;

    /// Space needed for RedemptionQueue account
    /// 8 (discriminator) + 1 (bump) + 4*2 (head/tail) + 48 * MAX_ENTRIES (fixed array)
    /// = 8 + 1 + 8 + 48*10 = 497 bytes
    pub const LEN: usize = 8 + 1 + 4 * 2 + QueueEntry::LEN * Self::MAX_ENTRIES;

    /// Check if the queue is full
    pub fn is_full(&self) -> bool {
        self.pending_count() >= Self::MAX_ENTRIES as u32
    }

    /// Check if the queue is empty
    pub fn is_empty(&self) -> bool {
        self.head == self.tail
    }

    /// Get number of pending entries (wrapping subtraction handles u32 overflow)
    pub fn pending_count(&self) -> u32 {
        self.tail.wrapping_sub(self.head)
    }
}

/// A single entry in the redemption queue
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct QueueEntry {
    /// User who is owed redemption
    pub user: Pubkey,
    /// OkuUSD raw amount held in escrow (stored amount, not UI amount)
    /// The actual USDC payout will be calculated at process_queue time
    /// using the interest rate and time elapsed to include accrued yield
    pub okusd_raw_amount: u64,
    /// Timestamp when queued (used for interest calculation)
    pub timestamp: i64,
}

impl QueueEntry {
    /// Space for a single queue entry: 32 + 8 + 8 = 48 bytes
    pub const LEN: usize = 32 + 8 + 8;
}

/// Bridge configuration PDA
/// Seeds: ["bridge_config"]
#[account]
pub struct BridgeConfig {
    /// PDA bump seed
    pub bump: u8,

    // ===== Bridge-Specific Authorities (8 roles, separate from PSM) =====
    /// Bridge admin - manages bridge roles
    pub bridge_admin: Pubkey,
    /// Bridge pauser - emergency pause
    pub bridge_pauser: Pubkey,
    /// Bridge unpauser - unpause
    pub bridge_unpauser: Pubkey,
    /// Orchestrator signer - Ed25519 public key for signature verification
    pub orchestrator_signer: Pubkey,
    /// Fee recipient - receives bridge fees
    pub fee_recipient: Pubkey,
    /// Chain manager - add/remove supported chains
    pub chain_manager: Pubkey,
    /// Fee manager - update fee configuration
    pub fee_manager: Pubkey,
    /// Nonce admin - emergency nonce management
    pub nonce_admin: Pubkey,

    // ===== Configuration =====
    /// Bridge fee in basis points (10 = 0.1%)
    pub bridge_fee_bps: u16,
    /// Minimum bridge amount
    pub min_bridge_amount: u64,
    /// Maximum bridge amount
    pub max_bridge_amount: u64,
    /// Whether bridge is paused
    pub is_paused: bool,

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

    /// Space needed for BridgeConfig account
    /// 8 (discriminator) + 1 (bump) + 32*8 (authority pubkeys) + 2 (fee_bps) + 8*2 (min/max amounts) + 1 (is_paused) + 2 (source_chain_id) + 2*32 (chain array) + 1 (chain count)
    /// = 8 + 1 + 256 + 2 + 16 + 1 + 2 + 64 + 1 = 351 bytes
    pub const LEN: usize = 8 + 1 + 32 * 8 + 2 + 8 * 2 + 1 + 2 + 2 * 32 + 1;

    /// Check if a chain is supported
    pub fn is_chain_supported(&self, chain_id: u16) -> bool {
        self.supported_chains[..self.supported_chains_count as usize]
            .contains(&chain_id)
    }

    /// Add a supported chain (returns error if full or already exists)
    pub fn add_chain(&mut self, chain_id: u16) -> Result<()> {
        require!(chain_id != 0, OkuError::UnsupportedChain);
        require!(!self.is_chain_supported(chain_id), OkuError::ChainAlreadySupported);
        require!(self.supported_chains_count < 32, OkuError::ChainListFull);

        self.supported_chains[self.supported_chains_count as usize] = chain_id;
        self.supported_chains_count += 1;
        Ok(())
    }

    /// Remove a supported chain
    pub fn remove_chain(&mut self, chain_id: u16) -> Result<()> {
        let count = self.supported_chains_count as usize;
        for i in 0..count {
            if self.supported_chains[i] == chain_id {
                // Shift remaining elements left
                for j in i..count - 1 {
                    self.supported_chains[j] = self.supported_chains[j + 1];
                }
                self.supported_chains[count - 1] = 0;
                self.supported_chains_count -= 1;
                return Ok(());
            }
        }
        Err(error!(OkuError::ChainNotFound))
    }
}

/// Bridge nonce tracking PDA (one per destination chain)
/// Seeds: ["bridge_nonce", destination_chain_id.to_le_bytes()]
#[account]
pub struct BridgeNonce {
    /// PDA bump seed
    pub bump: u8,
    /// Destination chain ID
    pub destination_chain: u16,
    /// Next sequential nonce for this destination
    pub next_nonce: u64,
}

impl BridgeNonce {
    pub const SEED: &'static [u8] = b"bridge_nonce";

    /// Space needed for BridgeNonce account
    /// 8 (discriminator) + 1 (bump) + 2 (chain_id) + 8 (nonce) = 19 bytes
    pub const LEN: usize = 8 + 1 + 2 + 8;
}

/// Processed bridge request PDA (prevents replay attacks)
/// Seeds: ["bridge_request", request_id]
#[account]
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

    /// Space needed for ProcessedRequest account
    /// 8 (discriminator) + 1 (bump) + 32 (request_id) + 8 (timestamp) + 32 (recipient) + 8 (amount) = 89 bytes
    pub const LEN: usize = 8 + 1 + 32 + 8 + 32 + 8;
}

/// Bridge request message format (80 bytes)
/// Used for signature verification and replay prevention
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
