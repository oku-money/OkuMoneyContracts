//! OkuBridgeRouter core instructions.

// F-02: All CPI targets in this module are constrained by Anchor's typed
// `Program<'info, T>` accounts (Token, Token2022, System) or by explicit
// `#[account(address = ...)]` constraints on `psm_program`/`vault_program`.
// The `arbitrary_cpi` warning is a false positive here.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::contexts::{BridgeOkuM, BridgeUsdOku, Initialize, MintUsdOku, RedeemUsdOku};
use crate::errors::RouterError;
use crate::events::*;
use crate::validation::{
    verify_psm_and_bridge_not_paused, verify_psm_and_vault_not_paused, verify_psm_config,
    verify_vault_config,
};
use anchor_lang::prelude::*;

/// Initialize the bridge router config.
///
/// Takes pauser and unpauser as args; signer becomes role_admin. Stores
/// mint addresses for validation (matches EVM pattern of storing downstream
/// refs) and validates zero addresses (matches EVM
/// `OkuBridgeRouter.initialize()`).
///
/// Cross-program canonical-mint check: the router stores `oku_money_mint`
/// and `usd_oku_mint` once at init and pins every subsequent CPI against
/// those stored values. If init silently accepted the wrong mint, every
/// downstream `bridge_usd_oku` / `mint_usd_oku` call would fail with an
/// opaque token-program error rather than a clean router-side rejection.
/// We therefore require the canonical PSM and vault configs at init and
/// assert the supplied mints match the configs' stored mint pubkeys.
pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
    // Validate zero addresses (matches EVM pattern)
    require!(pauser != Pubkey::default(), RouterError::InvalidAuthority);
    require!(unpauser != Pubkey::default(), RouterError::InvalidAuthority);

    // Cross-program canonical-mint validation: load PSM + vault configs and
    // verify the mints supplied here match the ones the underlying programs
    // already committed to at their own initialize time. `verify_vault_config`
    // also asserts the vault points back at this same `psm_config`.
    let psm_cfg = verify_psm_config(&ctx.accounts.psm_config.to_account_info())?;
    let vault_cfg = verify_vault_config(
        &ctx.accounts.vault_config.to_account_info(),
        &ctx.accounts.psm_config.key(),
    )?;

    let oku_money_mint = ctx.accounts.oku_money_mint.key();
    let usd_oku_mint = ctx.accounts.usd_oku_mint.key();

    require!(
        psm_cfg.oku_money_mint == oku_money_mint,
        RouterError::MintMismatch
    );
    require!(
        vault_cfg.oku_money_mint == oku_money_mint,
        RouterError::MintMismatch
    );
    require!(
        vault_cfg.usd_oku_mint == usd_oku_mint,
        RouterError::MintMismatch
    );

    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;
    config.role_admin = ctx.accounts.role_admin.key();
    config.pauser = pauser;
    config.unpauser = unpauser;
    config.is_paused = false;

    // Store mint addresses for validation in subsequent calls
    config.oku_money_mint = oku_money_mint;
    config.usd_oku_mint = usd_oku_mint;

    // Two-step `role_admin` transfer slot — empty until proposed.
    config.pending_role_admin = Pubkey::default();

    emit!(InitializeEvent {
        role_admin: config.role_admin,
        oku_money_mint: config.oku_money_mint,
        usd_oku_mint: config.usd_oku_mint,
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
    // Prevent bridging to zero address (would permanently burn funds)
    require!(recipient != [0u8; 20], RouterError::InvalidRecipient);
    // Validate destination chain is non-zero
    require!(destination_chain != 0, RouterError::InvalidDestinationChain);

    // Defense-in-depth cross-program PDA + pause checks. Fails fast with a
    // clean RouterError instead of surfacing a deep CPI error.
    let (_psm_cfg, _bridge_cfg) = verify_psm_and_bridge_not_paused(
        &ctx.accounts.psm_config.to_account_info(),
        &ctx.accounts.bridge_config.to_account_info(),
    )?;
    let _vault_cfg = verify_vault_config(
        &ctx.accounts.vault_config.to_account_info(),
        &ctx.accounts.psm_config.key(),
    )?;
    require!(!_vault_cfg.is_paused, RouterError::VaultPaused);

    // Extract AccountInfo from boxed accounts BEFORE any CPI.
    // After a CPI, the BPF runtime may invalidate heap pointers inside
    // Box<InterfaceAccount>, causing access violations in subsequent CPIs.
    let oku_money_mint_info = ctx.accounts.oku_money_mint.to_account_info();
    let user_oku_money_ata_info = ctx.accounts.user_oku_money_ata.to_account_info();

    // Snapshot user's OkuMoney balance BEFORE unwrap to compute delta
    let balance_before = ctx.accounts.user_oku_money_ata.amount;

    // Step 1: Unwrap usdOku -> OkuMoney via oku-dollar vault CPI
    // Note: psm_config is used for both vault (reads oku_m_price) and PSM (as config)
    let unwrap_cpi_ctx = CpiContext::new(
        ctx.accounts.vault_program.key(),
        oku_dollar::cpi::accounts::Unwrap {
            user: ctx.accounts.user.to_account_info(),
            config: ctx.accounts.vault_config.to_account_info(),
            oku_money_mint: oku_money_mint_info.clone(),
            usd_oku_mint: ctx.accounts.usd_oku_mint.to_account_info(),
            user_oku_money_ata: user_oku_money_ata_info.clone(),
            user_usd_oku_ata: ctx.accounts.user_usd_oku_ata.to_account_info(),
            reserve_vault: ctx.accounts.reserve_vault.to_account_info(),
            psm_config: ctx.accounts.psm_config.to_account_info(),
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
        ctx.accounts.psm_program.key(),
        lite_psm::cpi::accounts::BridgeBurn {
            user: ctx.accounts.user.to_account_info(),
            bridge_config: ctx.accounts.bridge_config.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            bridge_nonce: ctx.accounts.bridge_nonce.to_account_info(),
            oku_money_mint: oku_money_mint_info,
            user_oku_money_ata: user_oku_money_ata_info,
            fee_recipient_ata: Some(ctx.accounts.fee_recipient_ata.to_account_info()),
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
        oku_m_amount: oku_money_received,
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
    // Prevent bridging to zero address (would permanently burn funds)
    require!(recipient != [0u8; 20], RouterError::InvalidRecipient);
    // Validate destination chain is non-zero
    require!(destination_chain != 0, RouterError::InvalidDestinationChain);

    // Defense-in-depth cross-program PDA + pause checks.
    verify_psm_and_bridge_not_paused(
        &ctx.accounts.psm_config.to_account_info(),
        &ctx.accounts.bridge_config.to_account_info(),
    )?;

    let bridge_burn_cpi_ctx = CpiContext::new(
        ctx.accounts.psm_program.key(),
        lite_psm::cpi::accounts::BridgeBurn {
            user: ctx.accounts.user.to_account_info(),
            bridge_config: ctx.accounts.bridge_config.to_account_info(),
            config: ctx.accounts.psm_config.to_account_info(),
            bridge_nonce: ctx.accounts.bridge_nonce.to_account_info(),
            oku_money_mint: ctx.accounts.oku_money_mint.to_account_info(),
            user_oku_money_ata: ctx.accounts.user_oku_money_ata.to_account_info(),
            fee_recipient_ata: Some(ctx.accounts.fee_recipient_ata.to_account_info()),
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
        oku_m_amount: oku_m_amount,
        destination_chain,
        recipient,
    });

    Ok(())
}

/// Mint usdOku from USDC in one transaction
/// 1. PSM mint_oku_m: USDC -> OkuMoney
/// 2. Vault wrap: OkuMoney -> usdOku
pub fn mint_usd_oku(ctx: Context<MintUsdOku>, usdc_amount: u64, min_shares_out: u64) -> Result<()> {
    let is_paused = ctx.accounts.config.is_paused;
    require!(!is_paused, RouterError::Paused);
    require!(usdc_amount > 0, RouterError::ZeroAmount);

    // Defense-in-depth cross-program PDA + pause checks.
    verify_psm_and_vault_not_paused(
        &ctx.accounts.psm_config.to_account_info(),
        &ctx.accounts.vault_config.to_account_info(),
    )?;

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
        ctx.accounts.psm_program.key(),
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
        ctx.accounts.vault_program.key(),
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
        oku_m_intermediate: oku_money_received,
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

    // Defense-in-depth cross-program PDA + pause checks. Both the PSM and
    // the vault must be unpaused — the vault `unwrap` CPI happens first,
    // followed by PSM `redeem_oku_m`. Surfacing `PsmPaused`/`VaultPaused`
    // here is the explicit fast-fail design used by `bridge_usd_oku` and
    // `mint_usd_oku`; without these explicit checks the underlying CPI
    // would still revert but with an opaque downstream error rather than
    // a clean router-side code. (Note: PSM allows `redeem_oku_m` while the
    // bridge is paused; only the PSM-level pause matters here.)
    verify_psm_and_vault_not_paused(
        &ctx.accounts.psm_config.to_account_info(),
        &ctx.accounts.vault_config.to_account_info(),
    )?;

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
        ctx.accounts.vault_program.key(),
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
        ctx.accounts.psm_program.key(),
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

    // Note: The final USDC amount and queue status are determined by the PSM.
    // The router only emits what it can accurately determine. Check PSM events
    // (RedeemEvent or RedemptionQueuedEvent) for the final redemption details.
    emit!(RedeemUsdOkuEvent {
        user: ctx.accounts.user.key(),
        usd_oku_shares,
        oku_m_intermediate: oku_money_received,
    });

    Ok(())
}
