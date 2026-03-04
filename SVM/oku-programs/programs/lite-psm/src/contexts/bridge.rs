use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface};
use crate::errors::OkuError;
use crate::state::{BridgeConfig, BridgeNonce, PsmConfig, ProcessedRequest, RefundedRequest};

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

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Recipient's OkuUSD account (will validate owner in function body)
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub recipient_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Instruction sysvar for Ed25519 signature verification
    /// CHECK: Verified in verify_ed25519_signature function
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: AccountInfo<'info>,

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

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuUSD account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Fee recipient's OkuUSD account
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = bridge_config.fee_recipient,
        token::token_program = token_2022_program,
    )]
    pub fee_recipient_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_bytes: Vec<u8>, request_id: [u8; 32])]
pub struct RefundBridgeRequest<'info> {
    #[account(mut)]
    pub refund_admin: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        constraint = refund_admin.key() == bridge_config.refund_admin @ OkuError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        init,
        payer = refund_admin,
        space = RefundedRequest::LEN,
        seeds = [RefundedRequest::SEED, &request_id],
        bump
    )]
    pub refunded_request: Account<'info, RefundedRequest>,

    #[account(
        mut,
        constraint = okusd_mint.key() == config.okusd_mint
    )]
    pub okusd_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// Sender's OkuUSD ATA — owner is validated in instruction body
    #[account(mut)]
    pub sender_okusd_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub token_2022_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}
