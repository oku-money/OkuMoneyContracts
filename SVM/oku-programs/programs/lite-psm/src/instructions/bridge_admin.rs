use crate::contexts::{
    BridgeAdmin, BridgeChainManager, BridgeFeeManager, BridgeLimitsManager, BridgeNonceAdmin,
    BridgePause, BridgeSignerManager, BridgeUnpause, InitializeBridge,
};
use crate::errors::OkuError;
use crate::events::*;
use crate::roles::BridgeAuthorityRole;
use anchor_lang::prelude::*;

/// Initialize the bridge configuration
/// Sets up all bridge authorities and default configuration
pub fn initialize_bridge(ctx: Context<InitializeBridge>, source_chain_id: u16) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.bump = ctx.bumps.bridge_config;

    // Set all bridge authorities
    config.bridge_admin = ctx.accounts.bridge_admin.key();
    config.bridge_pauser = ctx.accounts.bridge_pauser.key();
    config.bridge_unpauser = ctx.accounts.bridge_unpauser.key();
    config.orchestrator_signer = ctx.accounts.orchestrator_signer.key();
    config.fee_recipient = ctx.accounts.fee_recipient.key();
    config.chain_manager = ctx.accounts.chain_manager.key();
    config.fee_manager = ctx.accounts.fee_manager.key();
    config.nonce_admin = ctx.accounts.nonce_admin.key();
    // Two-step refund: initiator and confirmer must be different keys
    // Default both to bridge_admin; operator should update before production use
    config.refund_initiator = ctx.accounts.bridge_admin.key();
    config.refund_confirmer = ctx.accounts.bridge_admin.key();
    config.signer_manager = ctx.accounts.signer_manager.key();
    config.limits_manager = ctx.accounts.limits_manager.key();

    // Set default configuration
    config.bridge_fee_bps = 10; // 0.1% default fee
    config.min_bridge_amount = 1_000_000; // 1 token (assuming 6 decimals)
    config.max_bridge_amount = 1_000_000_000_000; // 1,000,000 tokens
    config.is_paused = false;
    config.bridge_deadline_secs = 3600; // default 1 hour

    // Set source chain identity
    config.source_chain_id = source_chain_id;

    // Initialize empty chain whitelist
    config.supported_chains = [0u16; 32];
    config.supported_chains_count = 0;

    emit!(BridgeInitializedEvent {
        bridge_admin: config.bridge_admin,
        orchestrator_signer: config.orchestrator_signer,
        fee_bps: config.bridge_fee_bps,
    });

    Ok(())
}

/// Add a supported destination chain
pub fn add_supported_chain(ctx: Context<BridgeChainManager>, chain_id: u16) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.add_chain(chain_id)?;

    emit!(ChainAddedEvent { chain_id });

    Ok(())
}

/// Remove a supported destination chain
pub fn remove_supported_chain(ctx: Context<BridgeChainManager>, chain_id: u16) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.remove_chain(chain_id)?;

    emit!(ChainRemovedEvent { chain_id });

    Ok(())
}

/// Update bridge fee (in basis points, max 10000 = 100%)
pub fn update_bridge_fee(ctx: Context<BridgeFeeManager>, new_fee_bps: u16) -> Result<()> {
    require!(new_fee_bps <= 10000, OkuError::InvalidFeeBps);

    let config = &mut ctx.accounts.bridge_config;
    let old_fee_bps = config.bridge_fee_bps;
    config.bridge_fee_bps = new_fee_bps;

    emit!(BridgeFeeUpdatedEvent {
        old_fee_bps,
        new_fee_bps,
    });

    Ok(())
}

/// Update fee recipient address
/// Matches EVM OkuBridge.updateFeeRecipient() which validates zero address
pub fn update_fee_recipient(ctx: Context<BridgeFeeManager>, new_recipient: Pubkey) -> Result<()> {
    // Reject zero address to prevent accidental lockout (matches EVM)
    require!(
        new_recipient != Pubkey::default(),
        OkuError::InvalidRecipient
    );

    let config = &mut ctx.accounts.bridge_config;
    let old_recipient = config.fee_recipient;
    config.fee_recipient = new_recipient;

    emit!(FeeRecipientUpdatedEvent {
        old_recipient,
        new_recipient,
    });

    Ok(())
}

/// Update bridge amount limits
pub fn update_bridge_limits(
    ctx: Context<BridgeLimitsManager>,
    min_amount: u64,
    max_amount: u64,
) -> Result<()> {
    require!(min_amount <= max_amount, OkuError::BelowMinimum);

    let config = &mut ctx.accounts.bridge_config;
    config.min_bridge_amount = min_amount;
    config.max_bridge_amount = max_amount;

    emit!(BridgeLimitsUpdatedEvent {
        min_amount,
        max_amount,
    });

    Ok(())
}

/// Pause bridge operations (emergency)
pub fn pause_bridge(ctx: Context<BridgePause>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.is_paused = true;

    emit!(BridgePauseEvent {
        pauser: ctx.accounts.bridge_pauser.key(),
        paused: true,
    });

    Ok(())
}

/// Unpause bridge operations
pub fn unpause_bridge(ctx: Context<BridgeUnpause>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    config.is_paused = false;

    emit!(BridgeUnpauseEvent {
        unpauser: ctx.accounts.bridge_unpauser.key(),
    });

    Ok(())
}

/// Skip nonce for a destination chain (emergency recovery)
pub fn skip_nonce(
    ctx: Context<BridgeNonceAdmin>,
    destination_chain_id: u16,
    new_nonce: u64,
) -> Result<()> {
    let bridge_nonce = &mut ctx.accounts.bridge_nonce;

    // Initialize if needed
    if !bridge_nonce.is_initialized {
        bridge_nonce.bump = ctx.bumps.bridge_nonce;
        bridge_nonce.is_initialized = true;
        bridge_nonce.destination_chain = destination_chain_id;
    }

    let old_nonce = bridge_nonce.next_nonce;
    require!(new_nonce > old_nonce, OkuError::BelowMinimum);
    bridge_nonce.next_nonce = new_nonce;

    emit!(NonceSkippedEvent {
        destination_chain_id,
        old_nonce,
        new_nonce,
    });

    Ok(())
}

/// Update the bridge deadline for new requests
pub fn update_bridge_deadline(ctx: Context<BridgeLimitsManager>, new_deadline: i64) -> Result<()> {
    require!(new_deadline > 0, OkuError::InvalidDeadline);

    let config = &mut ctx.accounts.bridge_config;
    let old_deadline_secs = config.bridge_deadline_secs;
    config.bridge_deadline_secs = new_deadline;

    emit!(BridgeDeadlineUpdatedEvent {
        old_deadline_secs,
        new_deadline_secs: new_deadline,
    });

    Ok(())
}

/// Update orchestrator signer public key
/// Matches EVM OkuBridge.updateAuthorizedSigner() which validates zero address
pub fn update_orchestrator_signer(
    ctx: Context<BridgeSignerManager>,
    new_signer: Pubkey,
) -> Result<()> {
    // Reject zero address to prevent accidental lockout (matches EVM)
    require!(new_signer != Pubkey::default(), OkuError::InvalidRecipient);

    let config = &mut ctx.accounts.bridge_config;
    let old_signer = config.orchestrator_signer;
    config.orchestrator_signer = new_signer;

    emit!(OrchestratorSignerUpdatedEvent {
        old_signer,
        new_signer,
    });

    Ok(())
}

/// Update a specific bridge authority role
/// Only bridge_admin can call this function
pub fn set_bridge_authority(
    ctx: Context<BridgeAdmin>,
    role: BridgeAuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    // Reject zero address to prevent accidental lockout
    require!(
        new_authority != Pubkey::default(),
        OkuError::InvalidRecipient
    );

    let config = &mut ctx.accounts.bridge_config;
    let old_authority = match role {
        BridgeAuthorityRole::BridgeAdmin => {
            let old = config.bridge_admin;
            config.bridge_admin = new_authority;
            old
        }
        BridgeAuthorityRole::BridgePauser => {
            let old = config.bridge_pauser;
            config.bridge_pauser = new_authority;
            old
        }
        BridgeAuthorityRole::BridgeUnpauser => {
            let old = config.bridge_unpauser;
            config.bridge_unpauser = new_authority;
            old
        }
        BridgeAuthorityRole::OrchestratorSigner => {
            let old = config.orchestrator_signer;
            config.orchestrator_signer = new_authority;
            old
        }
        BridgeAuthorityRole::FeeRecipient => {
            let old = config.fee_recipient;
            config.fee_recipient = new_authority;
            old
        }
        BridgeAuthorityRole::ChainManager => {
            let old = config.chain_manager;
            config.chain_manager = new_authority;
            old
        }
        BridgeAuthorityRole::FeeManager => {
            let old = config.fee_manager;
            config.fee_manager = new_authority;
            old
        }
        BridgeAuthorityRole::NonceAdmin => {
            let old = config.nonce_admin;
            config.nonce_admin = new_authority;
            old
        }
        BridgeAuthorityRole::RefundInitiator => {
            let old = config.refund_initiator;
            config.refund_initiator = new_authority;
            old
        }
        BridgeAuthorityRole::RefundConfirmer => {
            let old = config.refund_confirmer;
            config.refund_confirmer = new_authority;
            old
        }
        BridgeAuthorityRole::SignerManager => {
            let old = config.signer_manager;
            config.signer_manager = new_authority;
            old
        }
        BridgeAuthorityRole::LimitsManager => {
            let old = config.limits_manager;
            config.limits_manager = new_authority;
            old
        }
    };

    emit!(BridgeAuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}
