use anchor_lang::prelude::*;

/// PSM configuration PDA
/// Seeds: ["psm_config"]
#[account]
pub struct PsmConfig {
    /// PDA bump seed
    pub bump: u8,
    /// Admin authority (cold multisig)
    pub admin: Pubkey,
    /// Pauser authority (warm multisig)
    pub pauser: Pubkey,
    /// Orchestrator authority (KMS-backed signer)
    pub orchestrator: Pubkey,
    /// USDC mint address
    pub usdc_mint: Pubkey,
    /// OkuUSD mint address (Token-2022)
    pub okusd_mint: Pubkey,
    /// PSM's USDC buffer vault (ATA)
    pub vault_usdc_ata: Pubkey,
    /// PSM's OkuUSD escrow vault for queued redemptions (ATA)
    /// Holds OkuUSD while users are in queue so they earn yield
    pub vault_okusd_ata: Pubkey,
    /// Maximum OkuUSD supply cap
    pub max_supply: u64,
    /// Bridge mint allowance remaining
    pub minter_allowance: u64,
    /// Whether the PSM is paused
    pub is_paused: bool,
    /// Pyth oracle feed (or Pubkey::default() if disabled)
    pub oracle: Pubkey,
    /// Maximum oracle staleness in seconds
    pub staleness_threshold: i64,
    /// Current interest rate in basis points (e.g., 450 = 4.5% APY)
    /// Stored here for queue processing interest calculations
    pub current_rate_bps: i16,
}

impl PsmConfig {
    pub const SEED: &'static [u8] = b"psm_config";

    /// Space needed for PsmConfig account
    /// 8 (discriminator) + 1 (bump) + 32*7 (pubkeys) + 8*2 (u64s) + 1 (bool) + 32 (oracle) + 8 (i64) + 2 (i16)
    pub const LEN: usize = 8 + 1 + 32 * 7 + 8 * 2 + 1 + 32 + 8 + 2;
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
    /// Queue entries (max 100 entries to fit Solana's realloc limit)
    pub entries: Vec<QueueEntry>,
}

impl RedemptionQueue {
    pub const SEED: &'static [u8] = b"redemption_queue";
    // Limited to 100 entries to stay under Solana's 10KB realloc limit
    // (8 header + 1 bump + 8 head/tail + 4 vec_len + 48*100 entries = 4,821 bytes)
    // For production, consider zero-copy accounts or pagination for larger queues
    pub const MAX_ENTRIES: usize = 100;

    /// Space needed for RedemptionQueue account
    /// 8 (discriminator) + 1 (bump) + 4*2 (head/tail) + 4 (vec len) + 48 * MAX_ENTRIES (entries)
    pub const LEN: usize = 8 + 1 + 4 * 2 + 4 + QueueEntry::LEN * Self::MAX_ENTRIES;

    /// Check if the queue is full
    pub fn is_full(&self) -> bool {
        self.entries.len() >= Self::MAX_ENTRIES
    }

    /// Check if the queue is empty
    pub fn is_empty(&self) -> bool {
        self.head >= self.tail
    }

    /// Get number of pending entries
    pub fn pending_count(&self) -> u32 {
        if self.tail > self.head {
            self.tail - self.head
        } else {
            0
        }
    }
}

/// A single entry in the redemption queue
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
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
