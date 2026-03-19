use crate::contexts::{BridgeOkuM, BridgeUsdOku, Initialize, MintUsdOku, RedeemUsdOku};
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

/// Bridge OkuMoney directly cross-chain (no unwrap needed)
/// Calls PSM bridge_burn directly — for users holding raw OkuMoney.
/// Matches EVM OkuBridgeRouter.bridgeOkuM()
pub fn bridge_oku_m(
    ctx: Context<BridgeOkuM>,
    oku_m_amount: u64,
    recipient: [u8; 20],
    destination_chain: u16,
) -> Result<()> {
    let is_paused = ctx.accounts.config.is_paused;
    require!(!is_paused, RouterError::Paused);
    require!(oku_m_amount > 0, RouterError::ZeroAmount);

    let bridge_burn_cpi_ctx = CpiContext::new(
        ctx.accounts.psm_program.to_account_info(),
        lite_psm::cpi::accounts::BridgeBurn {
            user: ctx.accounts.user.to_account_info(),
            bridge_config: ctx.accounts.bridge_config.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            bridge_nonce: ctx.accounts.bridge_nonce.to_account_info(),
            oku_money_mint: ctx.accounts.oku_money_mint.to_account_info(),
            user_oku_money_ata: ctx.accounts.user_oku_money_ata.to_account_info(),
            fee_recipient_ata: ctx.accounts.fee_recipient_ata.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    lite_psm::cpi::bridge_burn(
        bridge_burn_cpi_ctx,
        oku_m_amount,
        recipient,
        destination_chain,
    )?;

    emit!(BridgeOkuMEvent {
        user: ctx.accounts.user.key(),
        oku_money_amount: oku_m_amount,
        destination_chain,
        recipient,
    });

    Ok(())
}

/// Mint usdOku from USDC in one transaction
/// 1. PSM mint_oku_m: USDC -> OkuMoney
/// 2. Vault wrap: OkuMoney -> usdOku
pub fn mint_usd_oku(
    ctx: Context<MintUsdOku>,
    usdc_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    let is_paused = ctx.accounts.config.is_paused;
    require!(!is_paused, RouterError::Paused);
    require!(usdc_amount > 0, RouterError::ZeroAmount);

    // Extract AccountInfo from boxed accounts BEFORE any CPI
    let oku_money_mint_info = ctx.accounts.oku_money_mint.to_account_info();
    let user_oku_money_ata_info = ctx.accounts.user_oku_money_ata.to_account_info();
    let usd_oku_mint_info = ctx.accounts.usd_oku_mint.to_account_info();
    let user_usd_oku_ata_info = ctx.accounts.user_usd_oku_ata.to_account_info();
    let reserve_vault_info = ctx.accounts.reserve_vault.to_account_info();

    // Snapshot user's OkuMoney balance BEFORE mint
    let oku_money_balance_before = ctx.accounts.user_oku_money_ata.amount;

    // Snapshot user's usdOku balance BEFORE wrap
    let usd_oku_balance_before = ctx.accounts.user_usd_oku_ata.amount;

    // Step 1: CPI to PSM mint_oku_m — USDC -> OkuMoney
    let mint_cpi_ctx = CpiContext::new(
        ctx.accounts.psm_program.to_account_info(),
        lite_psm::cpi::accounts::MintOkuM {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
            oku_money_mint: oku_money_mint_info.clone(),
            user_usdc_ata: ctx.accounts.user_usdc_ata.to_account_info(),
            user_oku_money_ata: user_oku_money_ata_info.clone(),
            vault_usdc: ctx.accounts.vault_usdc.to_account_info(),
            price_update: ctx
                .accounts
                .price_update
                .as_ref()
                .map(|a| a.to_account_info()),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    lite_psm::cpi::mint_oku_m(mint_cpi_ctx, usdc_amount)?;

    // Reload to get actual OkuMoney received
    ctx.accounts.user_oku_money_ata.reload()?;
    let oku_money_received = ctx
        .accounts
        .user_oku_money_ata
        .amount
        .checked_sub(oku_money_balance_before)
        .ok_or(RouterError::MathError)?;

    // Step 2: CPI to vault wrap — OkuMoney -> usdOku
    let dead_shares_info = ctx
        .accounts
        .dead_shares_ata
        .as_ref()
        .map(|a| a.to_account_info());

    let wrap_cpi_ctx = CpiContext::new(
        ctx.accounts.vault_program.to_account_info(),
        oku_dollar::cpi::accounts::Wrap {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.vault_config.to_account_info(),
            oku_money_mint: oku_money_mint_info,
            usd_oku_mint: usd_oku_mint_info,
            user_oku_money_ata: user_oku_money_ata_info,
            user_usd_oku_ata: user_usd_oku_ata_info,
            reserve_vault: reserve_vault_info,
            psm_config: ctx.accounts.psm_config.to_account_info(),
            dead_shares_ata: dead_shares_info,
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    oku_dollar::cpi::wrap(wrap_cpi_ctx, oku_money_received, min_shares_out)?;

    // Reload to get actual usdOku received
    ctx.accounts.user_usd_oku_ata.reload()?;
    let usd_oku_received = ctx
        .accounts
        .user_usd_oku_ata
        .amount
        .checked_sub(usd_oku_balance_before)
        .ok_or(RouterError::MathError)?;

    emit!(MintUsdOkuEvent {
        user: ctx.accounts.user.key(),
        usdc_amount,
        oku_money_intermediate: oku_money_received,
        usd_oku_shares: usd_oku_received,
    });

    Ok(())
}

/// Redeem usdOku to USDC in one transaction
/// 1. Vault unwrap: usdOku -> OkuMoney
/// 2. PSM redeem_oku_m: OkuMoney -> USDC (instant or queued)
pub fn redeem_usd_oku(
    ctx: Context<RedeemUsdOku>,
    usd_oku_shares: u64,
    min_oku_money_out: u64,
) -> Result<()> {
    let is_paused = ctx.accounts.config.is_paused;
    require!(!is_paused, RouterError::Paused);
    require!(usd_oku_shares > 0, RouterError::ZeroAmount);

    // Extract AccountInfo from boxed accounts BEFORE any CPI
    let oku_money_mint_info = ctx.accounts.oku_money_mint.to_account_info();
    let usd_oku_mint_info = ctx.accounts.usd_oku_mint.to_account_info();
    let user_oku_money_ata_info = ctx.accounts.user_oku_money_ata.to_account_info();
    let user_usd_oku_ata_info = ctx.accounts.user_usd_oku_ata.to_account_info();
    let reserve_vault_info = ctx.accounts.reserve_vault.to_account_info();

    // Snapshot user's OkuMoney balance BEFORE unwrap
    let oku_money_balance_before = ctx.accounts.user_oku_money_ata.amount;

    // Step 1: CPI to vault unwrap — usdOku -> OkuMoney
    let unwrap_cpi_ctx = CpiContext::new(
        ctx.accounts.vault_program.to_account_info(),
        oku_dollar::cpi::accounts::Unwrap {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.vault_config.to_account_info(),
            oku_money_mint: oku_money_mint_info.clone(),
            usd_oku_mint: usd_oku_mint_info,
            user_oku_money_ata: user_oku_money_ata_info.clone(),
            user_usd_oku_ata: user_usd_oku_ata_info,
            reserve_vault: reserve_vault_info,
            psm_config: ctx.accounts.psm_config.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    oku_dollar::cpi::unwrap(unwrap_cpi_ctx, usd_oku_shares)?;

    // Reload to get actual OkuMoney received
    ctx.accounts.user_oku_money_ata.reload()?;
    let oku_money_received = ctx
        .accounts
        .user_oku_money_ata
        .amount
        .checked_sub(oku_money_balance_before)
        .ok_or(RouterError::MathError)?;

    // Slippage protection on unwrap output
    require!(
        oku_money_received >= min_oku_money_out,
        RouterError::SlippageExceeded
    );

    // Step 2: CPI to PSM redeem_oku_m — OkuMoney -> USDC (or queued)
    let redeem_cpi_ctx = CpiContext::new(
        ctx.accounts.psm_program.to_account_info(),
        lite_psm::cpi::accounts::RedeemOkuM {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            redemption_queue: ctx.accounts.redemption_queue.to_account_info(),
            usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
            oku_money_mint: oku_money_mint_info,
            user_usdc_ata: ctx.accounts.user_usdc_ata.to_account_info(),
            user_oku_money_ata: user_oku_money_ata_info,
            vault_usdc: ctx.accounts.vault_usdc.to_account_info(),
            vault_oku_money: ctx.accounts.vault_oku_money.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    lite_psm::cpi::redeem_oku_m(redeem_cpi_ctx, oku_money_received)?;

    // We can't easily determine if the redemption was instant or queued from here
    // without reading the PSM's vault_usdc balance. Emit with usdc_amount=0 and queued=false
    // as a simplification — the PSM's own events will have the details.
    emit!(RedeemUsdOkuEvent {
        user: ctx.accounts.user.key(),
        usd_oku_shares,
        oku_money_intermediate: oku_money_received,
        usdc_amount: 0,
        queued: false,
    });

    Ok(())
}
