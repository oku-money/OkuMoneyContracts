use crate::contexts::{Initialize, SetupOkuMoneyEscrow, SetupRedemptionQueue};
use crate::errors::OkuError;
use crate::events::InitializeEvent;
use anchor_lang::prelude::*;

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
    config.oku_money_mint = ctx.accounts.oku_money_mint.key();
    config.vault_usdc = ctx.accounts.vault_usdc.key();
    config.vault_oku_money = Pubkey::default(); // Set in setup_oku_money_escrow

    // Set limits
    config.max_supply = max_supply;
    config.minter_allowance = minter_allowance;
    config.is_paused = false;

    // Set oracle config
    config.oracle = Pubkey::default(); // Oracle disabled initially
    config.staleness_threshold = 0;

    // Yield distribution lock - starts at 0 (no lock)
    config.last_yield_distribution_slot = 0;

    // OkuMoney price - starts at PRECISION (1e9 = $1.00)
    config.oku_m_price = 1_000_000_000; // PRECISION

    // Blacklist exemptions - set via initialize_blacklist_exempt
    config.blacklist_exempt_bridge = Pubkey::default();
    config.blacklist_exempt_router = Pubkey::default();

    emit!(InitializeEvent {
        role_admin: config.role_admin,
        usdc_mint: config.usdc_mint,
        oku_money_mint: config.oku_money_mint,
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

/// Initialize the PSM - Step 3
/// Creates OkuMoney escrow vault for queued redemptions
/// Must be called after initialize()
pub fn setup_oku_money_escrow(ctx: Context<SetupOkuMoneyEscrow>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Ensure escrow hasn't already been set
    require!(
        config.vault_oku_money == Pubkey::default(),
        OkuError::Unauthorized
    );

    config.vault_oku_money = ctx.accounts.vault_oku_money.key();

    Ok(())
}
