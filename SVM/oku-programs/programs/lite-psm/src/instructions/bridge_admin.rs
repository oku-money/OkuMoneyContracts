use crate::constants::{
    BASIS_POINTS, BRIDGE_DEADLINE_MAX_SECS, BRIDGE_DEADLINE_MIN_SECS, MAX_NONCE_SKIP,
};
use crate::contexts::{
    BridgeAdmin, BridgeChainManager, BridgeFeeManager, BridgeLimitsManager, BridgeNonceAdmin,
    BridgePause, BridgeSignerManager, BridgeUnpause, InitializeBridge,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::roles::BridgeAuthorityRole;
use anchor_lang::prelude::*;

/// Bridge initialization parameters.
///
/// Bundled into a single Borsh struct so `initialize_bridge` stays under
/// Anchor's instruction-arg limits and so the deploy-time defaults are
/// caller-supplied (not hardcoded inside the handler). Mirrors EVM's
/// `OkuBridge.InitConfig` struct.
///
/// Two-step refund roles (`refund_initiator`, `refund_confirmer`) are required
/// init args and validated to differ from each other AND from `bridge_admin`.
/// This enforces key separation at deploy time so a single compromised key
/// cannot complete the full refund flow unilaterally.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BridgeInitConfig {
    /// Source chain identifier (e.g. SOLANA_DEVNET_CHAIN_ID = 103).
    pub source_chain_id: u16,
    /// Bridge fee in basis points. Must be <= `BASIS_POINTS` (10_000).
    pub bridge_fee_bps: u16,
    /// Minimum allowed bridge amount.
    pub min_bridge_amount: u64,
    /// Maximum allowed bridge amount. Must be >= `min_bridge_amount`.
    pub max_bridge_amount: u64,
    /// Bridge request deadline in seconds. Bounded by
    /// `BRIDGE_DEADLINE_MIN_SECS` / `BRIDGE_DEADLINE_MAX_SECS`.
    pub bridge_deadline_secs: i64,
    /// Refund initiator. Must differ from `refund_confirmer` and `bridge_admin`.
    pub refund_initiator: Pubkey,
    /// Refund confirmer. Must differ from `refund_initiator` and `bridge_admin`.
    pub refund_confirmer: Pubkey,
}

/// Initialize the bridge configuration
/// Sets up all bridge authorities and caller-supplied defaults.
pub fn initialize_bridge(
    ctx: Context<InitializeBridge>,
    config_args: BridgeInitConfig,
) -> Result<()> {
    let bridge_admin_key = ctx.accounts.bridge_admin.key();

    // ===== Validate caller-supplied defaults =====
    require!(
        config_args.bridge_fee_bps as u64 <= BASIS_POINTS,
        LitePsmError::InvalidFeeBps
    );
    require!(
        config_args.min_bridge_amount <= config_args.max_bridge_amount,
        LitePsmError::InvalidLimits
    );
    require!(
        config_args.bridge_deadline_secs >= BRIDGE_DEADLINE_MIN_SECS
            && config_args.bridge_deadline_secs <= BRIDGE_DEADLINE_MAX_SECS,
        LitePsmError::InvalidDeadline
    );

    // Refund roles: must be distinct from each other AND from bridge_admin.
    // Forces key separation at deploy time (mirrors EVM OkuBridge initialize).
    require!(
        config_args.refund_initiator != Pubkey::default(),
        LitePsmError::InvalidAuthority
    );
    require!(
        config_args.refund_confirmer != Pubkey::default(),
        LitePsmError::InvalidAuthority
    );
    require!(
        config_args.refund_initiator != config_args.refund_confirmer,
        LitePsmError::RefundRolesNotSeparated
    );
    require!(
        config_args.refund_initiator != bridge_admin_key,
        LitePsmError::RefundRolesNotSeparated
    );
    require!(
        config_args.refund_confirmer != bridge_admin_key,
        LitePsmError::RefundRolesNotSeparated
    );

    let config = &mut ctx.accounts.bridge_config;
    config.bump = ctx.bumps.bridge_config;

    // ===== Set all bridge authorities =====
    config.bridge_admin = bridge_admin_key;
    config.bridge_pauser = ctx.accounts.bridge_pauser.key();
    config.bridge_unpauser = ctx.accounts.bridge_unpauser.key();
    config.orchestrator_signer = ctx.accounts.orchestrator_signer.key();
    config.fee_recipient = ctx.accounts.fee_recipient.key();
    config.chain_manager = ctx.accounts.chain_manager.key();
    config.fee_manager = ctx.accounts.fee_manager.key();
    config.nonce_admin = ctx.accounts.nonce_admin.key();
    config.refund_initiator = config_args.refund_initiator;
    config.refund_confirmer = config_args.refund_confirmer;
    config.signer_manager = ctx.accounts.signer_manager.key();
    config.limits_manager = ctx.accounts.limits_manager.key();

    // ===== Caller-supplied configuration =====
    config.bridge_fee_bps = config_args.bridge_fee_bps;
    config.min_bridge_amount = config_args.min_bridge_amount;
    config.max_bridge_amount = config_args.max_bridge_amount;
    config.is_paused = false;
    config.bridge_deadline_secs = config_args.bridge_deadline_secs;

    // Set source chain identity
    config.source_chain_id = config_args.source_chain_id;

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
    require!(
        new_fee_bps as u64 <= BASIS_POINTS,
        LitePsmError::InvalidFeeBps
    );

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
        LitePsmError::InvalidRecipient
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
    require!(min_amount <= max_amount, LitePsmError::InvalidLimits);

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
    require!(!config.is_paused, LitePsmError::AlreadyPaused);
    config.is_paused = true;

    emit!(BridgePauseEvent {
        pauser: ctx.accounts.bridge_pauser.key(),
    });

    Ok(())
}

/// Unpause bridge operations
pub fn unpause_bridge(ctx: Context<BridgeUnpause>) -> Result<()> {
    let config = &mut ctx.accounts.bridge_config;
    require!(config.is_paused, LitePsmError::NotPaused);
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
    require!(new_nonce > old_nonce, LitePsmError::NonceNotMonotonic);
    // Cap the per-call delta so a fat-finger can't push next_nonce near
    // u64::MAX (which would risk overflow in bridge_burn's nonce++).
    require!(
        new_nonce.saturating_sub(old_nonce) <= MAX_NONCE_SKIP,
        LitePsmError::NonceSkipTooLarge
    );
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
    require!(
        new_deadline >= BRIDGE_DEADLINE_MIN_SECS && new_deadline <= BRIDGE_DEADLINE_MAX_SECS,
        LitePsmError::InvalidDeadline
    );

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
    require!(
        new_signer != Pubkey::default(),
        LitePsmError::InvalidAuthority
    );

    let config = &mut ctx.accounts.bridge_config;
    let old_signer = config.orchestrator_signer;
    config.orchestrator_signer = new_signer;

    emit!(OrchestratorSignerUpdatedEvent {
        old_signer,
        new_signer,
    });

    Ok(())
}

/// Update a specific bridge authority role.
///
/// Only `bridge_admin` can call this. The `OrchestratorSigner` and
/// `FeeRecipient` arms are deliberately rejected here because they
/// represent config pubkeys (not authorization gates) and have dedicated
/// rotation instructions (`update_orchestrator_signer`, gated by
/// `signer_manager`; `update_fee_recipient`, gated by `fee_manager`).
/// Routing those rotations through this function would let `bridge_admin`
/// bypass the per-config-pubkey gate, which is a privilege-escalation
/// vector.
pub fn set_bridge_authority(
    ctx: Context<BridgeAdmin>,
    role: BridgeAuthorityRole,
    new_authority: Pubkey,
) -> Result<()> {
    // Reject zero address to prevent accidental lockout
    require!(
        new_authority != Pubkey::default(),
        LitePsmError::InvalidAuthority
    );

    // Refuse the privilege-escalation arms — see fn-level doc.
    require!(
        !matches!(
            role,
            BridgeAuthorityRole::OrchestratorSigner | BridgeAuthorityRole::FeeRecipient
        ),
        LitePsmError::UseDedicatedRotation
    );

    let config = &mut ctx.accounts.bridge_config;

    // Dispatch on the role enum via the same one-line pattern used by
    // `set_authority` in `psm_admin.rs`. The `OrchestratorSigner |
    // FeeRecipient` arm is already rejected by the `require!` above;
    // the explicit `unreachable!` arm exists only for Rust's
    // exhaustiveness check and would only fire if someone removed the
    // privilege-escalation guard.
    macro_rules! rotate_role {
        ( $( $variant:ident => $field:ident ),+ $(,)? ) => {
            match role {
                $(
                    BridgeAuthorityRole::$variant => {
                        let old = config.$field;
                        config.$field = new_authority;
                        old
                    }
                ),+
                BridgeAuthorityRole::OrchestratorSigner
                | BridgeAuthorityRole::FeeRecipient => {
                    unreachable!("rejected above by the UseDedicatedRotation guard");
                }
            }
        };
    }
    let old_authority = rotate_role! {
        BridgeAdmin       => bridge_admin,
        BridgePauser      => bridge_pauser,
        BridgeUnpauser    => bridge_unpauser,
        ChainManager      => chain_manager,
        FeeManager        => fee_manager,
        NonceAdmin        => nonce_admin,
        RefundInitiator   => refund_initiator,
        RefundConfirmer   => refund_confirmer,
        SignerManager     => signer_manager,
        LimitsManager     => limits_manager,
    };

    // Enforce the cross-role invariant: refund_initiator, refund_confirmer,
    // and bridge_admin must remain three distinct keys after any rotation.
    // `initialize_bridge` already validates this at init time; this re-check
    // is for `set_bridge_authority`. Without it a careless rotation of
    // RefundInitiator → current RefundConfirmer would silently degrade the
    // two-step refund flow into a single-step one.
    require!(
        config.refund_initiator != config.refund_confirmer
            && config.refund_initiator != config.bridge_admin
            && config.refund_confirmer != config.bridge_admin,
        LitePsmError::RefundRolesNotSeparated
    );

    emit!(BridgeAuthorityUpdatedEvent {
        role,
        old_authority,
        new_authority,
    });

    Ok(())
}
