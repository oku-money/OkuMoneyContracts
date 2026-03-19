use crate::contexts::{BridgeUsdOku, Initialize};
use crate::errors::RouterError;
use crate::events::*;
use anchor_lang::prelude::*;

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

/// Bridge usdOku cross-chain in one transaction
/// 1. Unwraps usdOku -> OkuMoney via oku-dollar vault
/// 2. Burns OkuMoney via PSM bridge_burn
pub fn bridge_usd_oku(
    ctx: Context<BridgeUsdOku>,
    usd_oku_shares: u64,
    recipient: [u8; 20], // EVM address on destination
    destination_chain: u16,
    min_oku_money_out: u64, // Slippage protection
) -> Result<()> {
    let is_paused = ctx.accounts.config.is_paused;
    require!(!is_paused, RouterError::Paused);
    require!(usd_oku_shares > 0, RouterError::ZeroAmount);

    // Extract AccountInfo from boxed accounts BEFORE any CPI.
    // After a CPI, the BPF runtime may invalidate heap pointers inside
    // Box<InterfaceAccount>, causing access violations in subsequent CPIs.
    let oku_money_mint_info = ctx.accounts.oku_money_mint.to_account_info();
    let user_oku_money_ata_info = ctx.accounts.user_oku_money_ata.to_account_info();

    // Snapshot user's OkuMoney balance BEFORE unwrap to compute delta
    let balance_before = ctx.accounts.user_oku_money_ata.amount;

    // Step 1: Unwrap usdOku -> OkuMoney via oku-dollar vault CPI
    let unwrap_cpi_ctx = CpiContext::new(
        ctx.accounts.vault_program.to_account_info(),
        oku_dollar::cpi::accounts::Unwrap {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.vault_config.to_account_info(),
            oku_money_mint: oku_money_mint_info.clone(),
            usd_oku_mint: ctx.accounts.usd_oku_mint.to_account_info(),
            user_oku_money_ata: user_oku_money_ata_info.clone(),
            user_usd_oku_ata: ctx.accounts.user_usd_oku_ata.to_account_info(),
            reserve_vault: ctx.accounts.reserve_vault.to_account_info(),
            psm_config: ctx.accounts.vault_psm_config.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    oku_dollar::cpi::unwrap(unwrap_cpi_ctx, usd_oku_shares)?;

    // Step 2: Bridge burn only the OkuMoney received from unwrap (not total balance)
    ctx.accounts.user_oku_money_ata.reload()?;
    let oku_money_received = ctx
        .accounts
        .user_oku_money_ata
        .amount
        .checked_sub(balance_before)
        .ok_or(RouterError::MathError)?;

    // Slippage protection
    require!(
        oku_money_received >= min_oku_money_out,
        RouterError::SlippageExceeded
    );

    let bridge_burn_cpi_ctx = CpiContext::new(
        ctx.accounts.psm_program.to_account_info(),
        lite_psm::cpi::accounts::BridgeBurn {
            user: ctx.accounts.user.to_account_info(),
            bridge_config: ctx.accounts.bridge_config.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            bridge_nonce: ctx.accounts.bridge_nonce.to_account_info(),
            oku_money_mint: oku_money_mint_info,
            user_oku_money_ata: user_oku_money_ata_info,
            fee_recipient_ata: ctx.accounts.fee_recipient_ata.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    lite_psm::cpi::bridge_burn(
        bridge_burn_cpi_ctx,
        oku_money_received,
        recipient,
        destination_chain,
    )?;

    emit!(BridgeUsdOkuEvent {
        user: ctx.accounts.user.key(),
        usd_oku_shares,
        oku_money_amount: oku_money_received,
        destination_chain,
        recipient,
    });

    Ok(())
}
