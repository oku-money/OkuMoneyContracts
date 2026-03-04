use anchor_lang::prelude::*;
use crate::contexts::{Initialize, BridgeWrapped};
use crate::errors::RouterError;
use crate::events::*;

/// Initialize the bridge router config
/// Takes pauser and unpauser as args; signer becomes role_admin
pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.role_admin = ctx.accounts.role_admin.key();
    config.pauser = pauser;
    config.unpauser = unpauser;
    config.is_paused = false;

    emit!(InitializeEvent {
        role_admin: config.role_admin,
    });

    Ok(())
}

/// Bridge wOkuUSD cross-chain in one transaction
/// 1. Unwraps wOkuUSD -> OkuUSD via vault program
/// 2. Burns OkuUSD via PSM bridge_burn
pub fn bridge_wrapped(
    ctx: Context<BridgeWrapped>,
    wokusd_shares: u64,
    recipient: [u8; 20],      // EVM address on destination
    destination_chain: u16,
    min_okusd_out: u64,        // Slippage protection
) -> Result<()> {
    let is_paused = ctx.accounts.config.is_paused;
    require!(!is_paused, RouterError::Paused);
    require!(wokusd_shares > 0, RouterError::ZeroAmount);

    // Extract AccountInfo from boxed accounts BEFORE any CPI.
    // After a CPI, the BPF runtime may invalidate heap pointers inside
    // Box<InterfaceAccount>, causing access violations in subsequent CPIs.
    let okusd_mint_info = ctx.accounts.okusd_mint.to_account_info();
    let user_okusd_ata_info = ctx.accounts.user_okusd_ata.to_account_info();
    let vault_okusd_info = ctx.accounts.vault_okusd.to_account_info();

    // Snapshot user's OkuUSD balance BEFORE unwrap to compute delta
    let balance_before = ctx.accounts.user_okusd_ata.amount;

    // Step 1: Unwrap wOkuUSD -> OkuUSD via vault program CPI
    let unwrap_cpi_ctx = CpiContext::new(
        ctx.accounts.vault_program.to_account_info(),
        wokusd_vault::cpi::accounts::Unwrap {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.vault_config.to_account_info(),
            okusd_mint: okusd_mint_info.clone(),
            wokusd_mint: ctx.accounts.wokusd_mint.to_account_info(),
            user_okusd_ata: user_okusd_ata_info.clone(),
            user_wokusd_ata: ctx.accounts.user_wokusd_ata.to_account_info(),
            vault_okusd: vault_okusd_info,
            token_program: ctx.accounts.token_program.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    wokusd_vault::cpi::unwrap(unwrap_cpi_ctx, wokusd_shares)?;

    // Step 2: Bridge burn only the OkuUSD received from unwrap (not total balance)
    ctx.accounts.user_okusd_ata.reload()?;
    let okusd_received = ctx.accounts.user_okusd_ata.amount
        .checked_sub(balance_before)
        .ok_or(RouterError::MathError)?;

    // Slippage protection
    require!(okusd_received >= min_okusd_out, RouterError::SlippageExceeded);

    let bridge_burn_cpi_ctx = CpiContext::new(
        ctx.accounts.psm_program.to_account_info(),
        lite_psm::cpi::accounts::BridgeBurn {
            user: ctx.accounts.user.to_account_info(),
            bridge_config: ctx.accounts.bridge_config.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            bridge_nonce: ctx.accounts.bridge_nonce.to_account_info(),
            okusd_mint: okusd_mint_info,
            user_okusd_ata: user_okusd_ata_info,
            fee_recipient_ata: ctx.accounts.fee_recipient_ata.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    lite_psm::cpi::bridge_burn(bridge_burn_cpi_ctx, okusd_received, recipient, destination_chain)?;

    emit!(BridgeWrappedEvent {
        user: ctx.accounts.user.key(),
        wokusd_shares,
        okusd_amount: okusd_received,
        destination_chain,
        recipient,
    });

    Ok(())
}
