//! LitePSM bridge instructions (burn/mint/refund).
//!
//! Custom orchestrator-signed bridge protocol (NOT Wormhole NTT — there is no
//! Guardian quorum, no VAA parsing, no NTT manager). The on-chain semantics
//! mirror the EVM-side `OkuBridge.sol`:
//!  - burn on source → emit deterministic 80-byte BridgeRequest message
//!  - signed off-chain by a single trusted orchestrator (Ed25519)
//!  - mint on destination after replay-checked PDA init + signature verify
//!  - two-step refund (initiate / confirm) gated by separate keys
//! Taken from https://github.com/anomalyco/okuMoney/blob/main/contracts/EVM/src/bridge/OkuBridge.sol
//!
//! Replay prevention uses Anchor's `init` constraint as a one-shot nonce —
//! the `ProcessedRequest` PDA cannot be created twice for the same request_id.
//! Taken from https://www.anchor-lang.com/docs/account-constraints

use crate::constants::{BRIDGE_MESSAGE_LEN, ED25519_SIGNATURE_LEN};
use crate::contexts::{
    BridgeBurn, BridgeMint, CancelRefund, ConfirmRefund, InitiateRefund,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{
    calculate_fee, check_yield_lock, oku_m_to_dollars, verify_ed25519_signature,
};
use crate::state::{BridgeRequest, PsmConfig};
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use solana_keccak_hasher::hash as keccak_hash;

/// Bridge mint (from cross-chain) - SECURE VERSION with Ed25519 signature verification
/// Verifies orchestrator signature over bridge request data
/// Prevents replay attacks via request_id tracking
pub fn bridge_mint(
    ctx: Context<BridgeMint>,
    message_bytes: Vec<u8>, // Raw serialized BridgeRequest (80 bytes)
    signature: Vec<u8>,     // Ed25519 signature (64 bytes)
    request_id: [u8; 32],   // keccak256(message_bytes) — used for PDA derivation
) -> Result<()> {
    // Validate lengths
    require!(
        message_bytes.len() == BRIDGE_MESSAGE_LEN,
        LitePsmError::InvalidMessageLength
    );
    require!(
        signature.len() == ED25519_SIGNATURE_LEN,
        LitePsmError::InvalidSignature
    );

    // Read state
    let bridge_config = &ctx.accounts.bridge_config;
    let is_bridge_paused = bridge_config.is_paused;
    let is_psm_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    let config_bump = ctx.accounts.config.bump;
    let current_supply = ctx.accounts.oku_money_mint.supply;

    // Check bridge and PSM not paused
    require!(!is_bridge_paused, LitePsmError::BridgePaused);
    require!(!is_psm_paused, LitePsmError::Paused);

    // 2b. Yield lock: block mint in same slot as yield distribution (prevents sandwich attacks)
    // Matches EVM PSM's whenYieldNotDistributing modifier on mintOkuM
    check_yield_lock(&ctx.accounts.config)?;

    // Convert signature Vec to fixed array for verification
    let signature_array: [u8; 64] = signature
        .as_slice()
        .try_into()
        .map_err(|_| LitePsmError::InvalidSignature)?;

    // Verify Ed25519 signature over raw bytes (BEFORE parsing)
    verify_ed25519_signature(
        &ctx.accounts.instruction_sysvar,
        &bridge_config.orchestrator_signer.to_bytes(),
        &message_bytes,
        &signature_array,
    )?;

    // Parse message AFTER signature verified
    let request = BridgeRequest::try_from_slice(&message_bytes)?;

    // 5b. Validate destination chain matches this chain
    require!(
        request.destination_chain_id == bridge_config.source_chain_id,
        LitePsmError::WrongDestinationChain
    );

    // 5c. Reject same-chain bridges (source == destination). The orchestrator
    // should never sign such a message, but a compromised orchestrator key
    // would otherwise be able to mint an arbitrary same-chain "request" on
    // a destination that's also the source — creating a misleading
    // ProcessedRequest record. Mirrors EVM `OkuBridge.bridgeMint`'s
    // `CannotBridgeToSelf` guard.
    require!(
        request.source_chain_id != bridge_config.source_chain_id,
        LitePsmError::WrongSourceChain
    );

    // Validate deadline
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= request.deadline,
        LitePsmError::SignatureExpired
    );

    // Validate amount (limits enforced at bridge_burn time only; not on mint
    // to prevent stranding funds when limits change between burn and mint)
    require!(request.amount > 0, LitePsmError::ZeroAmount);

    // Convert recipient bytes to Pubkey
    let recipient_pubkey = Pubkey::new_from_array(request.recipient);

    // Validate recipient matches ATA owner (wallet address, not derived ATA)
    require!(
        recipient_pubkey == ctx.accounts.recipient_oku_money_ata.owner,
        LitePsmError::InvalidRecipient
    );

    // Verify request_id matches keccak256(message_bytes)
    let computed_request_id = keccak_hash(&message_bytes).to_bytes();
    require!(
        request_id == computed_request_id,
        LitePsmError::InvalidRequestId
    );

    // Verify request not already processed (replay prevention)
    // The init constraint on processed_request will fail if request_id already exists

    // Check PSM allowance and max supply
    require!(
        request.amount <= minter_allowance,
        LitePsmError::AllowanceExceeded
    );
    require!(
        current_supply
            .checked_add(request.amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );

    // Effects-checks-interactions: decrement minter allowance BEFORE the
    // mint CPI so a re-entry through any future Token-2022 extension (e.g.,
    // a TransferHook, which is rejected at `initialize` today but defence-
    // in-depth is cheap) cannot observe a stale allowance. Mirrors the
    // pattern used by `mint_oku_m` in `psm.rs`.
    {
        let config = &mut ctx.accounts.config;
        config.minter_allowance = minter_allowance
            .checked_sub(request.amount)
            .ok_or(LitePsmError::Overflow)?;
    }

    // Mint OkuMoney to recipient
    let seeds = &[PsmConfig::SEED, &[config_bump]];
    let signer = &[&seeds[..]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                to: ctx.accounts.recipient_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        request.amount,
    )?;

    // Create ProcessedRequest PDA.
    //
    // `recipient` stores the *wallet* pubkey parsed from the signed
    // BridgeRequest (matching the emitted event and the cross-chain
    // semantics on EVM where `recipient` is the wallet address). Storing
    // the ATA address here would diverge from the event and confuse
    // indexers that read the on-chain record. The ATA is always
    // recoverable from (recipient_pubkey, oku_money_mint, Token-2022).
    let processed_request = &mut ctx.accounts.processed_request;
    processed_request.bump = ctx.bumps.processed_request;
    processed_request.request_id = request_id;
    processed_request.processed_at = clock.unix_timestamp;
    processed_request.recipient = recipient_pubkey;
    processed_request.amount = request.amount;

    // Calculate dollar value for event
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = oku_m_to_dollars(request.amount, oku_m_price)?;

    // Emit event. `recipient` is the wallet pubkey parsed from the signed
    // BridgeRequest (NOT the destination ATA address) so SVM and EVM
    // indexers see the same logical recipient. The ATA is recoverable
    // from (recipient, oku_money_mint, Token-2022) at index time.
    emit!(BridgeMintEvent {
        request_id,
        source_chain_id: request.source_chain_id,
        recipient: recipient_pubkey,
        amount: request.amount,
        nonce: request.nonce,
        dollar_value,
    });

    Ok(())
}

/// Bridge burn (to cross-chain) - SECURE VERSION with fee collection and nonce tracking
/// Burns user tokens, collects bridge fee, tracks sequential nonce, emits full metadata
pub fn bridge_burn(
    ctx: Context<BridgeBurn>,
    amount: u64,         // Total amount to deduct from user (fee deducted from this)
    recipient: [u8; 20], // EVM address on destination chain
    destination_chain_id: u16,
) -> Result<()> {
    let bridge_config = &ctx.accounts.bridge_config;
    let is_bridge_paused = bridge_config.is_paused;
    let is_psm_paused = ctx.accounts.config.is_paused;
    let config_bump = ctx.accounts.config.bump;

    // Check bridge and PSM not paused
    require!(!is_bridge_paused, LitePsmError::BridgePaused);
    require!(!is_psm_paused, LitePsmError::Paused);
    require!(amount > 0, LitePsmError::ZeroAmount);

    // Verify destination chain is supported
    require!(
        bridge_config.is_chain_supported(destination_chain_id),
        LitePsmError::UnsupportedChain
    );

    // Validate amount within limits
    require!(
        amount >= bridge_config.min_bridge_amount,
        LitePsmError::BelowMinimum
    );
    require!(
        amount <= bridge_config.max_bridge_amount,
        LitePsmError::AboveMaximum
    );

    // Calculate fee using the canonical helper.
    let fee_amount = calculate_fee(amount, bridge_config.bridge_fee_bps)?;
    let net_amount = amount.checked_sub(fee_amount).ok_or(LitePsmError::Overflow)?;
    require!(net_amount > 0, LitePsmError::ZeroAmount);

    // Burn exact amount from user (fee deducted from bridged value)
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                from: ctx.accounts.user_oku_money_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Mint fee to fee_recipient (if fee > 0 AND fee_recipient_ata is provided).
    //
    // The fee mint intentionally bypasses BOTH `minter_allowance` AND
    // `max_supply`: `bridge_burn` is a net-supply-decreasing operation
    // (burn `amount`, re-mint at most `fee_amount <= amount`), so the
    // post-instruction supply is always `<=` the pre-instruction supply.
    // Honouring `max_supply` here would create a pathological case where
    // a user at exactly `max_supply` could not bridge at all because the
    // intermediate re-mint would briefly require an allowance slot the
    // accounting model never reserves. The 100%-fee edge case
    // (`net_amount == 0`) is rejected explicitly above so the supply
    // change is always strictly negative or zero.
    //
    // When user == fee_recipient, the client should pass None for
    // fee_recipient_ata to avoid duplicate mutable account error. The fee
    // is effectively "waived" since the user already burned the full
    // amount.
    if fee_amount > 0 {
        if let Some(fee_recipient_ata) = &ctx.accounts.fee_recipient_ata {
            let seeds = &[PsmConfig::SEED, &[config_bump]];
            let signer = &[&seeds[..]];

            token_interface::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_2022_program.key(),
                    token_interface::MintTo {
                        mint: ctx.accounts.oku_money_mint.to_account_info(),
                        to: fee_recipient_ata.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                fee_amount,
            )?;
        }
        // If fee_recipient_ata is None (user == fee_recipient), fee is not minted back.
        // This is intentional - the user effectively paid the fee by burning the full amount.
    }

    // Initialize BridgeNonce if needed and get/increment nonce
    let bridge_nonce = &mut ctx.accounts.bridge_nonce;

    // Initialize if this is a new nonce account
    if !bridge_nonce.is_initialized {
        bridge_nonce.bump = ctx.bumps.bridge_nonce;
        bridge_nonce.is_initialized = true;
        bridge_nonce.destination_chain = destination_chain_id;
        bridge_nonce.next_nonce = 0;
    }

    let nonce = bridge_nonce.next_nonce;
    bridge_nonce.next_nonce = nonce.checked_add(1).ok_or(LitePsmError::Overflow)?;

    // Calculate request_id for orchestrator tracking
    let clock = Clock::get()?;
    let deadline = clock
        .unix_timestamp
        .checked_add(bridge_config.bridge_deadline_secs)
        .ok_or(LitePsmError::Overflow)?;

    let source_chain_id = ctx.accounts.bridge_config.source_chain_id;

    // Build the SVM-burn → EVM-mint message (80 bytes total).
    // Layout: source_chain_id(2) + destination_chain_id(2) + sender(32, Solana pubkey)
    //       + recipient(20, EVM address) + amount(8) + nonce(8) + deadline(8).
    // NOTE: this layout intentionally differs from
    // `state::BridgeRequest::to_message_bytes` (used for the EVM-burn → SVM-mint
    // direction, which has a 20-byte sender and 32-byte recipient). Both layouts
    // are 80 bytes, but the sender/recipient widths swap by direction. The
    // canonical TS encoder lives in `scripts/lib/bridge/message.ts`.
    let sender_bytes = ctx.accounts.user.key().to_bytes();
    let mut message = Vec::with_capacity(BRIDGE_MESSAGE_LEN);
    message.extend_from_slice(&source_chain_id.to_le_bytes());
    message.extend_from_slice(&destination_chain_id.to_le_bytes());
    message.extend_from_slice(&sender_bytes);
    message.extend_from_slice(&recipient);
    message.extend_from_slice(&net_amount.to_le_bytes());
    message.extend_from_slice(&nonce.to_le_bytes());
    message.extend_from_slice(&deadline.to_le_bytes());
    debug_assert_eq!(message.len(), BRIDGE_MESSAGE_LEN);

    let request_id = keccak_hash(&message).to_bytes();

    // Calculate dollar value for event
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = oku_m_to_dollars(net_amount, oku_m_price)?;

    // Emit event with full metadata. Both gross_amount (pre-fee, what the
    // user submitted) and amount (post-fee, what's actually bridged and
    // appears in the signed BridgeRequest) are emitted for cross-chain
    // reconciliation parity with EVM `BridgeBurn`.
    emit!(BridgeBurnEvent {
        request_id,
        user: ctx.accounts.user.key(),
        recipient,
        source_chain_id,
        destination_chain: destination_chain_id,
        gross_amount: amount,
        amount: net_amount,
        nonce,
        deadline,
        dollar_value,
        fee_amount,
    });

    Ok(())
}

// ============================================================================
// Two-Step Refund Instructions (matching EVM OkuBridge)
// ============================================================================

/// Initiate a refund (step 1 of two-step refund pattern)
/// Creates a PendingRefund PDA that must be confirmed by a different key
///
/// This prevents a single compromised key from completing refunds unilaterally.
/// Matches EVM OkuBridge.initiateRefund() pattern.
///
/// NOTE: Deliberately does NOT check pause state - refunds must work during emergencies.
/// However, this step doesn't mint tokens, so yield lock is not checked here.
pub fn initiate_refund(
    ctx: Context<InitiateRefund>,
    message_bytes: Vec<u8>,
    request_id: [u8; 32],
) -> Result<()> {
    // Validate message length
    require!(
        message_bytes.len() == BRIDGE_MESSAGE_LEN,
        LitePsmError::InvalidMessageLength
    );

    // Verify request_id matches keccak256(message_bytes)
    let computed_request_id = keccak_hash(&message_bytes).to_bytes();
    require!(
        request_id == computed_request_id,
        LitePsmError::InvalidRequestId
    );

    // Parse message bytes for SVM→EVM burn refunds.
    //
    // The length pre-check on line above guarantees each fixed-width slice
    // is in-bounds, but we still use `try_into().map_err(...)?` rather than
    // `unwrap()` so any future refactor that reorders the length guard
    // surfaces as a clean Anchor error instead of a BPF panic (which
    // returns an opaque program error with no error-code mapping).
    let source_chain_id = u16::from_le_bytes(
        message_bytes[0..2]
            .try_into()
            .map_err(|_| LitePsmError::InvalidMessageLength)?,
    );
    let sender_bytes: [u8; 32] = message_bytes[4..36]
        .try_into()
        .map_err(|_| LitePsmError::InvalidMessageLength)?;
    let amount = u64::from_le_bytes(
        message_bytes[56..64]
            .try_into()
            .map_err(|_| LitePsmError::InvalidMessageLength)?,
    );
    let deadline = i64::from_le_bytes(
        message_bytes[72..80]
            .try_into()
            .map_err(|_| LitePsmError::InvalidMessageLength)?,
    );

    // Validate this chain is the source chain
    require!(
        source_chain_id == ctx.accounts.bridge_config.source_chain_id,
        LitePsmError::WrongSourceChain
    );

    // Deadline check: refund only after mint window has closed
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > deadline,
        LitePsmError::MintWindowStillOpen
    );

    // Create PendingRefund PDA
    let pending = &mut ctx.accounts.pending_refund;
    pending.bump = ctx.bumps.pending_refund;
    pending.request_id = request_id;
    pending.recipient = Pubkey::new_from_array(sender_bytes);
    pending.amount = amount;
    pending.initiated_at = clock.unix_timestamp;
    pending.initiator = ctx.accounts.refund_initiator.key();

    emit!(RefundInitiatedEvent {
        request_id,
        recipient: pending.recipient,
        amount,
        initiator: pending.initiator,
    });

    Ok(())
}

/// Confirm a refund (step 2 of two-step refund pattern)
/// Mints tokens back to the original sender and closes the PendingRefund PDA
///
/// Must be called by a different key (refund_confirmer) than the initiator.
/// This ensures no single compromised key can complete a refund unilaterally.
///
/// Matches EVM OkuBridge.confirmRefund() pattern.
///
/// NOTE: Deliberately does NOT check pause state - refunds must work during emergencies.
/// However, yield lock IS checked to prevent sandwich attacks on the mint.
pub fn confirm_refund(ctx: Context<ConfirmRefund>, request_id: [u8; 32]) -> Result<()> {
    // Yield lock: block refund mint in same slot as yield distribution
    check_yield_lock(&ctx.accounts.config)?;

    // Read pending refund data
    let pending = &ctx.accounts.pending_refund;
    let recipient = pending.recipient;
    let amount = pending.amount;

    // Two-step refund safety: confirmer must be a different physical key
    // from the initiator that created this `PendingRefund`. The role-level
    // separation is enforced at `initialize_bridge` and `set_bridge_authority`,
    // but a careless rotation that leaves both roles holding the same key
    // would silently degrade the two-step flow into a single-step one.
    // EVM analogue: `OkuBridge.confirmRefund`'s `InitiatorCannotConfirm`.
    require!(
        ctx.accounts.refund_confirmer.key() != pending.initiator,
        LitePsmError::InitiatorCannotConfirm
    );

    // Check supply cap and minter allowance
    let current_supply = ctx.accounts.oku_money_mint.supply;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    require!(
        current_supply
            .checked_add(amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );
    require!(amount <= minter_allowance, LitePsmError::AllowanceExceeded);

    // Mint tokens back to sender
    let config_bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[config_bump]];
    let signer = &[&seeds[..]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                to: ctx.accounts.sender_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    // Decrement minter allowance
    let config = &mut ctx.accounts.config;
    config.minter_allowance = minter_allowance
        .checked_sub(amount)
        .ok_or(LitePsmError::Overflow)?;

    // Record refund in RefundedRequest PDA
    let clock = Clock::get()?;
    let refunded = &mut ctx.accounts.refunded_request;
    refunded.bump = ctx.bumps.refunded_request;
    refunded.request_id = request_id;
    refunded.refunded_at = clock.unix_timestamp;
    refunded.recipient = recipient;
    refunded.amount = amount;

    // PendingRefund is automatically closed via `close = refund_confirmer` constraint

    emit!(RefundConfirmedEvent {
        request_id,
        recipient,
        amount,
    });

    Ok(())
}

/// Cancel a pending refund.
///
/// Authorization is enforced in the context constraint: caller must be the
/// `pending_refund.initiator` (the original proposer) OR `bridge_admin`.
/// Matches EVM `OkuBridge.cancelRefund` pattern.
///
/// Reads `pending_refund.initiator` BEFORE the close-on-cancel completes so
/// the emitted event captures the full proposal-to-cancel audit trail
/// (mirrors EVM `RefundCancelled(requestId, initiator, cancelledBy)`).
pub fn cancel_refund(ctx: Context<CancelRefund>, request_id: [u8; 32]) -> Result<()> {
    let initiator = ctx.accounts.pending_refund.initiator;
    // PendingRefund is automatically closed via `close = canceller` constraint
    // at the end of this instruction.

    emit!(RefundCancelledEvent {
        request_id,
        initiator,
        canceller: ctx.accounts.canceller.key(),
    });

    Ok(())
}
