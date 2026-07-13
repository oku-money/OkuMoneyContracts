use crate::errors::LitePsmError;
use crate::state::{PsmConfig, RedemptionQueue};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

#[derive(Accounts)]
pub struct MintOkuM<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// OkuMoney mint (Token-2022). The program is extension-agnostic; the deploy
    /// script chooses which extensions (if any) are configured at mint creation.
    /// `mint::authority = config` is defense-in-depth: even if someone attempted
    /// an out-of-band mint-authority rotation (which requires a CPI signed by
    /// the current authority = config PDA, so it cannot happen without the
    /// program's consent), this constraint would catch it at deserialization.
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuMoney account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemOkuM<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Redemption queue (zero-copy ring buffer). Use `load_mut()` to enqueue,
    /// `load()` for read-only inspection. The handler is responsible for
    /// dropping the borrow before any CPI that re-borrows the account info.
    /// The `bump = redemption_queue.load()?.bump` constraint pattern is
    /// awkward in Anchor's derive; we instead use the canonical
    /// `bump` lookup (Anchor will recompute it from seeds).
    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuMoney mint (Token-2022). `mint::authority = config` is defense-in-depth
    /// (see rationale on `MintOkuM::oku_money_mint`).
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuMoney account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// PSM's OkuMoney escrow vault (for queued redemptions).
    /// Pinned to `config.vault_oku_money` so a caller cannot substitute an
    /// alternate config-owned OkuMoney ATA — without the explicit address
    /// pin, any Token-2022 OkuMoney account whose authority is the config
    /// PDA would satisfy the constraints and the user's escrowed tokens
    /// would be silently routed away from the canonical escrow.
    #[account(
        mut,
        address = config.vault_oku_money,
        token::mint = oku_money_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_oku_money: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessQueue<'info> {
    pub queue_processor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = queue_processor @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Redemption queue (zero-copy). `process_queue` uses `load()`+`load_mut()`
    /// interleaved with CPIs to advance the head ring. See `bump` note on
    /// `RedeemOkuM::redemption_queue`.
    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    /// OkuMoney mint (Token-2022) — needed for burn CPI and price reads.
    /// `mint::authority = config` is defense-in-depth (see rationale on
    /// `MintOkuM::oku_money_mint`).
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::authority = config,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// PSM's OkuMoney escrow vault - holds queued redemptions.
    /// Pinned to `config.vault_oku_money` (see rationale on `RedeemOkuM`).
    #[account(
        mut,
        address = config.vault_oku_money,
        token::mint = oku_money_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_oku_money: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    // Note: Recipient USDC ATAs are passed via remaining_accounts in queue order
}

#[derive(Accounts)]
pub struct DepositBuffer<'info> {
    pub buffer_depositor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = buffer_depositor @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Buffer depositor's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = buffer_depositor,
        associated_token::token_program = token_program,
    )]
    pub buffer_depositor_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawBuffer<'info> {
    pub buffer_withdrawer: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = buffer_withdrawer @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Redemption queue (read-only) — used to calculate reserved USDC for
    /// pending entries. `load()` only.
    #[account(
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    /// OkuMoney mint - needed to read current price for reserve calculation
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Buffer withdrawer's USDC account (destination)
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buffer_withdrawer,
    )]
    pub withdrawer_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// PSM's USDC vault (source)
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Permissionless self-rescue — any user can withdraw THEIR OWN queued
/// OkuMoney back to themselves. Cycle 4 (PSM-06): the dual to operator
/// `rescue_queue_entry`. Resolves the head-pin DoS where a frozen /
/// wrong-owner ATA on the head entry indefinitely blocks `process_queue`
/// for everyone downstream. The user whose entry is stuck can call this
/// to clear their slot, which both unblocks the queue and returns their
/// OkuMoney to a recipient ATA they control.
///
/// Constraints (vs the operator rescue below):
///   * `user` MUST be the original queued user — checked in the handler
///     against the entry's stored `user` field. No `has_one` here because
///     the user pubkey lives inside the queue zero-copy data, not on
///     `PsmConfig`.
///   * `recipient_oku_money_ata` MUST be owned by `user` — `token::authority`
///     constraint pins this.
///
/// The instruction does NOT require the queue to be at head — any
/// pending entry the user owns can be rescued. This matches the existing
/// operator rescue's permissions and lets a user unblock themselves
/// even if their entry isn't at the head.
#[derive(Accounts)]
pub struct UserSelfRescueQueueEntry<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    #[account(
        mut,
        address = config.vault_oku_money
    )]
    pub vault_oku_money: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Recipient ATA — must be owned by `user` (enforced by
    /// `token::authority = user`). Pinning the authority is what
    /// distinguishes self-rescue from the privileged operator rescue
    /// (which can target an arbitrary recipient).
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::authority = user,
        token::token_program = token_2022_program,
    )]
    pub recipient_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Rescue a stuck queue entry — return escrowed OkuMoney to an alternate recipient.
///
/// Only `queue_processor` can call. On EVM this is a separate `QUEUE_RESCUER` role;
/// the SVM side collapses both into the `queue_processor` authority for simplicity.
#[derive(Accounts)]
pub struct RescueQueueEntry<'info> {
    pub queue_processor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = queue_processor @ LitePsmError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Redemption queue (zero-copy). `rescue_queue_entry` uses `load_mut()`
    /// after the CPI to clear the entry and advance the head ring.
    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: AccountLoader<'info, RedemptionQueue>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's OkuMoney escrow vault — holds queued redemptions
    #[account(
        mut,
        address = config.vault_oku_money
    )]
    pub vault_oku_money: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Recipient's OkuMoney account (can be original user or alternate).
    /// Must hold the configured OkuMoney mint and live under the Token-2022
    /// program — without these constraints a `queue_processor` could be
    /// tricked into transferring the escrowed OkuMoney into an account on the
    /// wrong mint, surfacing only as an opaque SPL-layer error.
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::token_program = token_2022_program,
    )]
    pub recipient_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}
