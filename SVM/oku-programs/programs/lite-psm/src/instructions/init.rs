use anchor_lang::prelude::*;
use crate::contexts::{Initialize, SetupRedemptionQueue, SetupOkusdEscrow};
use crate::errors::OkuError;
use crate::events::InitializeEvent;

/// Initialize the PSM - Step 1
/// Creates config PDA and USDC vault
/// Call setup_redemption_queue and setup_okusd_escrow afterwards to complete initialization
/// Authority pubkeys passed as args to reduce stack usage (avoids BPF stack overflow)
pub fn initialize(
    ctx: Context<Initialize>,
    max_supply: u64,
    minter_allowance: u64,
    pauser: Pubkey,
    unpauser: Pubkey,
    freezer: Pubkey,
    unfreezer: Pubkey,
    queue_processor: Pubkey,
    buffer_depositor: Pubkey,
    buffer_withdrawer: Pubkey,
    oracle_manager: Pubkey,
    cap_manager: Pubkey,
    allowance_manager: Pubkey,
    rebaser: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;

    // Set all granular authorities (passed as args to avoid stack overflow)
    config.role_admin = ctx.accounts.role_admin.key();
    config.pauser = pauser;
    config.unpauser = unpauser;
    config.freezer = freezer;
    config.unfreezer = unfreezer;
    config.queue_processor = queue_processor;
    config.buffer_depositor = buffer_depositor;
    config.buffer_withdrawer = buffer_withdrawer;
    config.oracle_manager = oracle_manager;
    config.cap_manager = cap_manager;
    config.allowance_manager = allowance_manager;
    config.rebaser = rebaser;

    // Set token references
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.okusd_mint = ctx.accounts.okusd_mint.key();
    config.vault_usdc = ctx.accounts.vault_usdc.key();
    config.vault_okusd = Pubkey::default(); // Set in setup_okusd_escrow

    // Set limits
    config.max_supply = max_supply;
    config.minter_allowance = minter_allowance;
    config.is_paused = false;

    // Set oracle config
    config.oracle = Pubkey::default(); // Oracle disabled initially
    config.staleness_threshold = 0;
    config.current_rate_bps = 0; // Interest rate starts at 0, updated by rebaser
    config.rate_end = 0;
    config.pending_rate_bps = 0;

    emit!(InitializeEvent {
        role_admin: config.role_admin,
        usdc_mint: config.usdc_mint,
        okusd_mint: config.okusd_mint,
        max_supply,
    });

    Ok(())
}

/// Initialize the PSM - Step 2
/// Creates redemption queue PDA
/// Must be called after initialize()
pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()> {
    let queue = &mut ctx.accounts.redemption_queue;
    queue.bump = ctx.bumps.redemption_queue;
    queue.head = 0;
    queue.tail = 0;
    // entries array is automatically zero-initialized by Anchor

    Ok(())
}

/// Initialize the PSM - Step 2
/// Creates OkuUSD escrow vault for queue yield alignment
/// Must be called after initialize()
pub fn setup_okusd_escrow(ctx: Context<SetupOkusdEscrow>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Ensure escrow hasn't already been set
    require!(
        config.vault_okusd == Pubkey::default(),
        OkuError::Unauthorized
    );

    config.vault_okusd = ctx.accounts.vault_okusd.key();

    Ok(())
}
