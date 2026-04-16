use crate::contexts::{
    BridgeBurn, BridgeMint, CancelRefund, ConfirmRefund, InitiateRefund, RefundBridgeRequest,
};
use crate::errors::OkuError;
use crate::events::*;
use crate::helpers::{check_yield_lock, verify_ed25519_signature, PRECISION};
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
    // 1. Validate lengths
    require!(message_bytes.len() == 80, OkuError::InvalidMessageLength);
    require!(signature.len() == 64, OkuError::InvalidSignature);

    // Read state
    let bridge_config = &ctx.accounts.bridge_config;
    let is_bridge_paused = bridge_config.is_paused;
    let is_psm_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    let config_bump = ctx.accounts.config.bump;
    let current_supply = ctx.accounts.oku_money_mint.supply;

    // 2. Check bridge and PSM not paused
    require!(!is_bridge_paused, OkuError::BridgePaused);
    require!(!is_psm_paused, OkuError::Paused);

    // 2b. Yield lock: block mint in same slot as yield distribution (prevents sandwich attacks)
    // Matches EVM PSM's whenYieldNotDistributing modifier on mintOkuM
    check_yield_lock(&ctx.accounts.config)?;

    // 3. Convert signature Vec to fixed array for verification
    let signature_array: [u8; 64] = signature
        .as_slice()
        .try_into()
        .map_err(|_| OkuError::InvalidSignature)?;

    // 4. Verify Ed25519 signature over raw bytes (BEFORE parsing)
    verify_ed25519_signature(
        &ctx.accounts.instruction_sysvar,
        &bridge_config.orchestrator_signer.to_bytes(),
        &message_bytes,
        &signature_array,
    )?;

    // 5. Parse message AFTER signature verified
    let request = BridgeRequest::try_from_slice(&message_bytes)?;

    // 5b. Validate destination chain matches this chain
    require!(
        request.destination_chain_id == bridge_config.source_chain_id,
        OkuError::WrongDestinationChain
    );

    // 6. Validate deadline
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= request.deadline,
        OkuError::SignatureExpired
    );

    // 7. Validate amount (limits enforced at bridge_burn time only; not on mint
    // to prevent stranding funds when limits change between burn and mint)
    require!(request.amount > 0, OkuError::ZeroAmount);

    // 8. Convert recipient bytes to Pubkey
    let recipient_pubkey = Pubkey::new_from_array(request.recipient);

    // 9. Validate recipient matches ATA owner (wallet address, not derived ATA)
    require!(
        recipient_pubkey == ctx.accounts.recipient_oku_money_ata.owner,
        OkuError::InvalidRecipient
    );

    // 10. Verify request_id matches keccak256(message_bytes)
    let computed_request_id = keccak_hash(&message_bytes).to_bytes();
    require!(
        request_id == computed_request_id,
        OkuError::InvalidRequestId
    );

    // 11. Verify request not already processed (replay prevention)
    // The init constraint on processed_request will fail if request_id already exists

    // 12. Check PSM allowance and max supply
    require!(
        request.amount <= minter_allowance,
        OkuError::AllowanceExceeded
    );
    require!(
        current_supply
            .checked_add(request.amount)
            .ok_or(OkuError::Overflow)?
            <= max_supply,
        OkuError::MaxSupplyExceeded
    );

    // 12. Mint OkuMoney to recipient
    let seeds = &[PsmConfig::SEED, &[config_bump]];
    let signer = &[&seeds[..]];

    // 13. Mint tokens to recipient
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

    // 14. Decrement minter allowance
    let config = &mut ctx.accounts.config;
    config.minter_allowance = minter_allowance
        .checked_sub(request.amount)
        .ok_or(OkuError::Overflow)?;

    // 15. Create ProcessedRequest PDA
    let processed_request = &mut ctx.accounts.processed_request;
    processed_request.bump = ctx.bumps.processed_request;
    processed_request.request_id = request_id;
    processed_request.processed_at = clock.unix_timestamp;
    processed_request.recipient = ctx.accounts.recipient_oku_money_ata.key();
    processed_request.amount = request.amount;

    // 16. Calculate dollar value for event
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = (request.amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(OkuError::Overflow)? as u64;

    // 17. Emit event
    emit!(BridgeMintEvent {
        request_id,
        source_chain_id: request.source_chain_id,
        recipient: ctx.accounts.recipient_oku_money_ata.key(),
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

    // 1. Check bridge and PSM not paused
    require!(!is_bridge_paused, OkuError::BridgePaused);
    require!(!is_psm_paused, OkuError::Paused);
    require!(amount > 0, OkuError::ZeroAmount);

    // 2. Verify destination chain is supported
    require!(
        bridge_config.is_chain_supported(destination_chain_id),
        OkuError::UnsupportedChain
    );

    // 3. Validate amount within limits
    require!(
        amount >= bridge_config.min_bridge_amount,
        OkuError::BelowMinimum
    );
    require!(
        amount <= bridge_config.max_bridge_amount,
        OkuError::AboveMaximum
    );

    // 4. Calculate fee
    let fee_amount = (amount as u128)
        .checked_mul(bridge_config.bridge_fee_bps as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(10000)
        .ok_or(OkuError::Overflow)? as u64;

    let net_amount = amount.checked_sub(fee_amount).ok_or(OkuError::Overflow)?;
    require!(net_amount > 0, OkuError::ZeroAmount);

    // 5. Burn exact amount from user (fee deducted from bridged value)
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

    // 6. Mint fee to fee_recipient (if fee > 0 AND fee_recipient_ata is provided)
    // Note: This fee mint intentionally bypasses minter_allowance because the
    // bridge_burn is a net-supply-decreasing operation (burn > fee re-mint).
    // When user == fee_recipient, the client should pass None for fee_recipient_ata
    // to avoid duplicate mutable account error. The fee is effectively "waived"
    // since the user already burned the full amount.
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

    // 7. Initialize BridgeNonce if needed and get/increment nonce
    let bridge_nonce = &mut ctx.accounts.bridge_nonce;

    // Initialize if this is a new nonce account
    if !bridge_nonce.is_initialized {
        bridge_nonce.bump = ctx.bumps.bridge_nonce;
        bridge_nonce.is_initialized = true;
        bridge_nonce.destination_chain = destination_chain_id;
        bridge_nonce.next_nonce = 0;
    }

    let nonce = bridge_nonce.next_nonce;
    bridge_nonce.next_nonce = nonce.checked_add(1).ok_or(OkuError::Overflow)?;

    // 8. Calculate request_id for orchestrator tracking
    let clock = Clock::get()?;
    let deadline = clock
        .unix_timestamp
        .checked_add(bridge_config.bridge_deadline_secs)
        .ok_or(OkuError::Overflow)?;

    let source_chain_id = ctx.accounts.bridge_config.source_chain_id;

    let sender_bytes = ctx.accounts.user.key().to_bytes();
    let mut message = Vec::with_capacity(2 + 2 + 32 + 20 + 8 + 8 + 8);
    message.extend_from_slice(&source_chain_id.to_le_bytes());
    message.extend_from_slice(&destination_chain_id.to_le_bytes());
    message.extend_from_slice(&sender_bytes);
    message.extend_from_slice(&recipient);
    message.extend_from_slice(&net_amount.to_le_bytes());
    message.extend_from_slice(&nonce.to_le_bytes());
    message.extend_from_slice(&deadline.to_le_bytes());

    let request_id = keccak_hash(&message).to_bytes();

    // 9. Calculate dollar value for event
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = (net_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(OkuError::Overflow)? as u64;

    // 10. Emit event with full metadata
    emit!(BridgeBurnEvent {
        request_id,
        user: ctx.accounts.user.key(),
        recipient,
        source_chain_id,
        destination_chain: destination_chain_id,
        amount: net_amount,
        nonce,
        deadline,
        dollar_value,
        fee_amount,
    });

    Ok(())
}

/// Refund a failed bridge request (refund_admin only)
/// Mints tokens back to the original sender on the source chain
/// Only callable after the mint deadline has passed (on-chain safety)
///
/// NOTE: Deliberately does NOT check pause state (matches EVM OkuBridge.confirmRefund).
/// Refunds must work during emergencies to allow users to recover funds.
/// However, yield lock IS checked to prevent sandwich attacks.
pub fn refund_bridge_request(
    ctx: Context<RefundBridgeRequest>,
    message_bytes: Vec<u8>,
    request_id: [u8; 32],
) -> Result<()> {
    // 1. Validate message length
    require!(message_bytes.len() == 80, OkuError::InvalidMessageLength);

    // 1b. Yield lock: block refund mint in same slot as yield distribution
    // Prevents sandwich attacks while still allowing refunds during pause
    check_yield_lock(&ctx.accounts.config)?;

    // 2. Verify request_id matches keccak256(message_bytes)
    let computed_request_id = keccak_hash(&message_bytes).to_bytes();
    require!(
        request_id == computed_request_id,
        OkuError::InvalidRequestId
    );

    // 3. Parse message bytes manually for SVM→EVM burn refunds
    // Message format (80 bytes): source_chain(2) + dest_chain(2) + sender(32) + recipient(20) + amount(8) + nonce(8) + deadline(8)
    // Note: BridgeRequest struct uses 20-byte sender for EVM→SVM direction, so we parse manually here
    let source_chain_id = u16::from_le_bytes(message_bytes[0..2].try_into().unwrap());
    let sender_bytes: [u8; 32] = message_bytes[4..36].try_into().unwrap();
    let amount = u64::from_le_bytes(message_bytes[56..64].try_into().unwrap());
    let deadline = i64::from_le_bytes(message_bytes[72..80].try_into().unwrap());

    // 4. Validate this chain is the source chain
    require!(
        source_chain_id == ctx.accounts.bridge_config.source_chain_id,
        OkuError::WrongSourceChain
    );

    // 5. Deadline check: refund only after mint window has closed
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > deadline,
        OkuError::MintWindowStillOpen
    );

    // 6. Validate sender_oku_money_ata owner matches the sender from the signed message
    // This prevents refund_admin from redirecting funds to an arbitrary address
    let sender_pubkey = Pubkey::new_from_array(sender_bytes);
    require!(
        ctx.accounts.sender_oku_money_ata.owner == sender_pubkey,
        OkuError::InvalidRecipient
    );

    // 7. Check supply cap and minter allowance (parity with EVM refundFailedRequest)
    let current_supply = ctx.accounts.oku_money_mint.supply;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    require!(
        current_supply
            .checked_add(amount)
            .ok_or(OkuError::Overflow)?
            <= max_supply,
        OkuError::MaxSupplyExceeded
    );
    require!(amount <= minter_allowance, OkuError::AllowanceExceeded);

    // 8. Mint tokens back to sender
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

    // 9. Decrement minter allowance (one-way: burns do NOT restore)
    let config = &mut ctx.accounts.config;
    config.minter_allowance = minter_allowance
        .checked_sub(amount)
        .ok_or(OkuError::Overflow)?;

    // 10. Record refund in PDA (init constraint prevents double-refund)
    let refunded = &mut ctx.accounts.refunded_request;
    refunded.bump = ctx.bumps.refunded_request;
    refunded.request_id = request_id;
    refunded.refunded_at = clock.unix_timestamp;
    refunded.recipient = sender_pubkey;
    refunded.amount = amount;

    emit!(RefundProcessedEvent {
        request_id,
        recipient: sender_pubkey,
        amount,
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
    // 1. Validate message length
    require!(message_bytes.len() == 80, OkuError::InvalidMessageLength);

    // 2. Verify request_id matches keccak256(message_bytes)
    let computed_request_id = keccak_hash(&message_bytes).to_bytes();
    require!(
        request_id == computed_request_id,
        OkuError::InvalidRequestId
    );

    // 3. Parse message bytes for SVM→EVM burn refunds
    let source_chain_id = u16::from_le_bytes(message_bytes[0..2].try_into().unwrap());
    let sender_bytes: [u8; 32] = message_bytes[4..36].try_into().unwrap();
    let amount = u64::from_le_bytes(message_bytes[56..64].try_into().unwrap());
    let deadline = i64::from_le_bytes(message_bytes[72..80].try_into().unwrap());

    // 4. Validate this chain is the source chain
    require!(
        source_chain_id == ctx.accounts.bridge_config.source_chain_id,
        OkuError::WrongSourceChain
    );

    // 5. Deadline check: refund only after mint window has closed
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > deadline,
        OkuError::MintWindowStillOpen
    );

    // 6. Create PendingRefund PDA
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
    // 1. Yield lock: block refund mint in same slot as yield distribution
    check_yield_lock(&ctx.accounts.config)?;

    // 2. Read pending refund data
    let pending = &ctx.accounts.pending_refund;
    let recipient = pending.recipient;
    let amount = pending.amount;

    // 3. Check supply cap and minter allowance
    let current_supply = ctx.accounts.oku_money_mint.supply;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    require!(
        current_supply
            .checked_add(amount)
            .ok_or(OkuError::Overflow)?
            <= max_supply,
        OkuError::MaxSupplyExceeded
    );
    require!(amount <= minter_allowance, OkuError::AllowanceExceeded);

    // 4. Mint tokens back to sender
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

    // 5. Decrement minter allowance
    let config = &mut ctx.accounts.config;
    config.minter_allowance = minter_allowance
        .checked_sub(amount)
        .ok_or(OkuError::Overflow)?;

    // 6. Record refund in RefundedRequest PDA
    let clock = Clock::get()?;
    let refunded = &mut ctx.accounts.refunded_request;
    refunded.bump = ctx.bumps.refunded_request;
    refunded.request_id = request_id;
    refunded.refunded_at = clock.unix_timestamp;
    refunded.recipient = recipient;
    refunded.amount = amount;

    // 7. PendingRefund is automatically closed via `close = refund_confirmer` constraint

    emit!(RefundConfirmedEvent {
        request_id,
        recipient,
        amount,
    });

    Ok(())
}

/// Cancel a pending refund
/// Can be called by either refund_initiator or refund_confirmer to abort a pending refund
///
/// Matches EVM OkuBridge.cancelRefund() pattern.
pub fn cancel_refund(ctx: Context<CancelRefund>, request_id: [u8; 32]) -> Result<()> {
    // PendingRefund is automatically closed via `close = canceller` constraint

    emit!(RefundCancelledEvent {
        request_id,
        canceller: ctx.accounts.canceller.key(),
    });

    Ok(())
}
