use crate::errors::OkuError;
use crate::state::{
    BridgeConfig, BridgeNonce, PendingRefund, ProcessedRequest, PsmConfig, RefundedRequest,
};
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{
    self, Mint as MintInterface, TokenAccount as TokenAccountInterface,
};
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;

#[derive(Accounts)]
#[instruction(message_bytes: Vec<u8>, signature: Vec<u8>, request_id: [u8; 32])]
pub struct BridgeMint<'info> {
    /// Payer for ProcessedRequest PDA creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Bridge configuration
    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    /// PSM configuration
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// ProcessedRequest PDA (prevents replay attacks)
    /// Seeds are derived from keccak256(message_bytes), passed as request_id
    #[account(
        init,
        payer = payer,
        space = ProcessedRequest::LEN,
        seeds = [
            ProcessedRequest::SEED,
            &request_id
        ],
        bump
    )]
    pub processed_request: Account<'info, ProcessedRequest>,

    /// OkuMoney mint (Token-2022 with Scaled UI Amount extension)
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Recipient's OkuMoney account (will validate owner in function body)
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::token_program = token_2022_program,
    )]
    pub recipient_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Instruction sysvar for Ed25519 signature verification
    /// CHECK: Verified in verify_ed25519_signature function
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, recipient: [u8; 20], destination_chain_id: u16)]
pub struct BridgeBurn<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Bridge configuration
    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Box<Account<'info, BridgeConfig>>,

    /// PSM configuration
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Bridge nonce tracker for destination chain
    #[account(
        init_if_needed,
        payer = user,
        space = BridgeNonce::LEN,
        seeds = [BridgeNonce::SEED, &destination_chain_id.to_le_bytes()],
        bump
    )]
    pub bridge_nonce: Account<'info, BridgeNonce>,

    /// OkuMoney mint (Token-2022 with Scaled UI Amount extension)
    #[account(
        mut,
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Fee recipient's OkuMoney account (optional - skip if user == fee_recipient)
    /// When user is the fee recipient, pass None to avoid duplicate mutable account error.
    /// The instruction will skip fee minting in that case (user already "paid" the fee by burning).
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::authority = bridge_config.fee_recipient,
        token::token_program = token_2022_program,
    )]
    pub fee_recipient_ata: Option<Box<InterfaceAccount<'info, TokenAccountInterface>>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Two-Step Refund Contexts (matching EVM OkuBridge)
// ============================================================================

/// Initiate a refund (step 1 of two-step refund pattern)
/// Creates a PendingRefund PDA that must be confirmed by a different key
#[derive(Accounts)]
#[instruction(message_bytes: Vec<u8>, request_id: [u8; 32])]
pub struct InitiateRefund<'info> {
    #[account(mut)]
    pub refund_initiator: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        constraint = refund_initiator.key() == bridge_config.refund_initiator @ OkuError::Unauthorized
    )]
    pub bridge_config: Box<Account<'info, BridgeConfig>>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// PendingRefund PDA - will be created
    #[account(
        init,
        payer = refund_initiator,
        space = PendingRefund::LEN,
        seeds = [PendingRefund::SEED, &request_id],
        bump
    )]
    pub pending_refund: Box<Account<'info, PendingRefund>>,

    /// ProcessedRequest PDA - must NOT exist (checked via constraint)
    /// This prevents refunding a request that was already successfully minted
    /// CHECK: We verify this account does NOT exist by checking its data length is 0
    #[account(
        seeds = [ProcessedRequest::SEED, &request_id],
        bump,
        constraint = processed_request.data_is_empty() @ OkuError::RequestAlreadyMinted
    )]
    pub processed_request: UncheckedAccount<'info>,

    /// RefundedRequest PDA - must NOT exist (checked via constraint)
    /// This prevents double-refunding a request
    /// CHECK: We verify this account does NOT exist by checking its data length is 0
    #[account(
        seeds = [RefundedRequest::SEED, &request_id],
        bump,
        constraint = refunded_request.data_is_empty() @ OkuError::RequestAlreadyRefunded
    )]
    pub refunded_request: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Confirm a refund (step 2 of two-step refund pattern)
/// Must be called by a different key than the initiator
#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct ConfirmRefund<'info> {
    #[account(mut)]
    pub refund_confirmer: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        constraint = refund_confirmer.key() == bridge_config.refund_confirmer @ OkuError::Unauthorized
    )]
    pub bridge_config: Box<Account<'info, BridgeConfig>>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// PendingRefund PDA - must exist
    #[account(
        mut,
        close = refund_confirmer,
        seeds = [PendingRefund::SEED, &request_id],
        bump = pending_refund.bump
    )]
    pub pending_refund: Box<Account<'info, PendingRefund>>,

    /// RefundedRequest PDA - will be created
    #[account(
        init,
        payer = refund_confirmer,
        space = RefundedRequest::LEN,
        seeds = [RefundedRequest::SEED, &request_id],
        bump
    )]
    pub refunded_request: Box<Account<'info, RefundedRequest>>,

    /// OkuMoney mint (Token-2022 with Scaled UI Amount extension)
    #[account(
        mut,
        constraint = oku_money_mint.key() == config.oku_money_mint
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,

    /// Sender's OkuMoney ATA - owner is validated against pending_refund.recipient
    #[account(
        mut,
        constraint = sender_oku_money_ata.owner == pending_refund.recipient @ OkuError::InvalidRecipient
    )]
    pub sender_oku_money_ata: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,

    pub token_2022_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Cancel a pending refund
/// Can be called by either refund_initiator or refund_confirmer
#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct CancelRefund<'info> {
    #[account(mut)]
    pub canceller: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        constraint = (
            canceller.key() == bridge_config.refund_initiator ||
            canceller.key() == bridge_config.refund_confirmer
        ) @ OkuError::Unauthorized
    )]
    pub bridge_config: Box<Account<'info, BridgeConfig>>,

    /// PendingRefund PDA - will be closed
    #[account(
        mut,
        close = canceller,
        seeds = [PendingRefund::SEED, &request_id],
        bump = pending_refund.bump
    )]
    pub pending_refund: Box<Account<'info, PendingRefund>>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// Legacy Single-Step Refund (deprecated, kept for migration)
// ============================================================================

/// Legacy single-step refund context
/// Deprecated: Use InitiateRefund + ConfirmRefund for new integrations
#[derive(Accounts)]
#[instruction(message_bytes: Vec<u8>, request_id: [u8; 32])]
pub struct RefundBridgeRequest<'info> {
    #[account(mut)]
    pub refund_admin: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        // Legacy: check against refund_initiator (the old refund_admin field was renamed)
        constraint = refund_admin.key() == bridge_config.refund_initiator @ OkuError::Unauthorized
    )]
    pub bridge_config: Box<Account<'info, BridgeConfig>>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        init,
        payer = refund_admin,
        space = RefundedRequest::LEN,
        seeds = [RefundedRequest::SEED, &request_id],
        bump
    )]
    pub refunded_request: Box<Account<'info, RefundedRequest>>,

    /// ProcessedRequest PDA - must NOT exist (checked via constraint)
    /// This prevents refunding a request that was already successfully minted
    /// CHECK: We verify this account does NOT exist by checking its data length is 0
    #[account(
        seeds = [ProcessedRequest::SEED, &request_id],
        bump,
        constraint = processed_request.data_is_empty() @ OkuError::RequestAlreadyMinted
    )]
    pub processed_request: UncheckedAccount<'info>,

    /// OkuMoney mint (Token-2022 with Scaled UI Amount extension)
    #[account(
        mut,
        constraint = oku_money_mint.key() == config.oku_money_mint
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,

    /// Sender's OkuMoney ATA - owner is validated in instruction body
    #[account(mut)]
    pub sender_oku_money_ata: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,

    pub token_2022_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}
