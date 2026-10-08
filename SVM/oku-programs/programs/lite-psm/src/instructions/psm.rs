//! LitePSM user-facing instructions (mint/redeem/buffer), modelled on MakerDAO's
//! `DssLitePsm`: deposit USDC, mint at peg, redeem from the buffer when liquid.

use crate::constants::USDC_DECIMALS;
use crate::contexts::{DepositBuffer, MintOkuM, RedeemOkuM, WithdrawBuffer};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{
    check_supply_cap, check_yield_lock, check_yield_lock_with_clock, consume_allowance,
    dollars_to_raw, multiplier, raw_to_dollars,
};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

// Display freshness is the permissionless crank's job: a sync here costs ~31k CU
// on a hot path. An idle PSM shows a stale-LOW wallet balance; pricing never
// reads the mirror.

/// Take `usdc_amount` USDC from the user into the vault and mint them the
/// equivalent OkuM: `usdc * PRECISION / multiplier`, rounded down.
///
/// Prices at the canonical multiplier (never the lagging `ScaledUiAmount`
/// mirror). A zero-output mint is rejected so USDC is never donated to the buffer.
pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
    // Guards: not in an override slot, not paused, non-zero input.
    let clock = Clock::get()?;
    check_yield_lock_with_clock(&ctx.accounts.config, &clock)?;

    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(usdc_amount > 0, LitePsmError::ZeroAmount);

    // Price: how much OkuM the USDC buys at the current multiplier.
    let multiplier = multiplier::at(&ctx.accounts.config, clock.unix_timestamp)?;
    let raw_oku_m_amount = dollars_to_raw(usdc_amount, multiplier)?;
    require!(raw_oku_m_amount > 0, LitePsmError::AmountTooSmall);

    // The mint amount is exactly `raw_oku_m_amount`, so the post-mint supply is
    // computed rather than re-unpacking the mint. Revisit if an extension could
    // change `supply` independently of this CPI (none in the init extension set).
    let new_total_supply = check_supply_cap(
        ctx.accounts.oku_m_mint.supply,
        raw_oku_m_amount,
        ctx.accounts.config.max_supply,
    )?;
    // The PSM's own mint allowance is drawn down per mint (reset by the
    // allowance manager), bounding total PSM issuance.
    consume_allowance(&mut ctx.accounts.config.minter_allowance, raw_oku_m_amount)?;

    // 1. User pays USDC into the vault. `transfer_checked` validates mint and decimals, so a wrong-mint or
    // wrong-decimals account cannot stand in for the USDC leg.
    anchor_spl::token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            anchor_spl::token::TransferChecked {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
        USDC_DECIMALS,
    )?;

    // 2. Mint the OkuM to the user; the config PDA is the mint authority and signs.
    let bump_seed = [ctx.accounts.config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_m_mint.to_account_info(),
                to: ctx.accounts.user_oku_m_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        raw_oku_m_amount,
    )?;

    emit!(MintEvent {
        user: ctx.accounts.user.key(),
        usdc_amount,
        raw_oku_m_amount,
        dollar_value: raw_to_dollars(raw_oku_m_amount, multiplier)?,
        multiplier,
        new_total_supply,
    });

    Ok(())
}

/// Burn `raw_oku_m_amount` of the user's OkuM and pay them USDC from the vault:
/// `raw * multiplier / PRECISION`, rounded down. Fails with
/// `InsufficientBuffer` if the vault cannot cover it (top up with
/// `deposit_buffer`; nothing is stuck).
///
/// `min_usdc_out` is a client-side guard (`0` skips it). The EVM PSM has no
/// slippage parameter.
pub fn redeem_oku_m(
    ctx: Context<RedeemOkuM>,
    raw_oku_m_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    check_yield_lock_with_clock(&ctx.accounts.config, &clock)?;

    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(raw_oku_m_amount > 0, LitePsmError::ZeroAmount);

    // Price: USDC owed for the OkuM at the current multiplier.
    let multiplier = multiplier::at(&ctx.accounts.config, clock.unix_timestamp)?;
    // No zero-output check: multiplier >= PRECISION and OkuM/USDC share 6 decimals, so usdc_amount >= raw_oku_m_amount > 0.
    let usdc_amount = raw_to_dollars(raw_oku_m_amount, multiplier)?;
    require!(usdc_amount >= min_usdc_out, LitePsmError::SlippageExceeded);

    // Custom error instead of the opaque SPL insufficient-funds one.
    require!(
        ctx.accounts.user_oku_m_ata.amount >= raw_oku_m_amount,
        LitePsmError::InsufficientUserBalance
    );
    require!(
        ctx.accounts.vault_usdc.amount >= usdc_amount,
        LitePsmError::InsufficientBuffer
    );

    // Post-burn supply is computed for the same reason as in `mint_oku_m`.
    let new_total_supply = ctx
        .accounts
        .oku_m_mint
        .supply
        .checked_sub(raw_oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // 1. Burn the user's OkuM (the user signs as token-account owner).
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.oku_m_mint.to_account_info(),
                from: ctx.accounts.user_oku_m_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        raw_oku_m_amount,
    )?;

    // 2. Pay USDC from the vault; the config PDA owns the vault and signs.
    let bump_seed = [ctx.accounts.config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

    anchor_spl::token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            anchor_spl::token::TransferChecked {
                from: ctx.accounts.vault_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.user_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        usdc_amount,
        USDC_DECIMALS,
    )?;

    // A redeem pays out at exactly the dollar value, so `dollar_value == usdc_amount`.
    emit!(RedeemEvent {
        user: ctx.accounts.user.key(),
        raw_oku_m_amount,
        usdc_amount,
        dollar_value: usdc_amount,
        multiplier,
        new_total_supply,
    });

    Ok(())
}

/// Move `amount` USDC from the `buffer_depositor`'s account into the vault,
/// topping up the liquidity redemptions are paid from. Mints nothing.
/// Blocked while paused and in the slot of a multiplier override.
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
    check_yield_lock(&ctx.accounts.config)?;
    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(amount > 0, LitePsmError::ZeroAmount);

    anchor_spl::token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            anchor_spl::token::TransferChecked {
                from: ctx.accounts.buffer_depositor_usdc_ata.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.buffer_depositor.to_account_info(),
            },
        ),
        amount,
        USDC_DECIMALS,
    )?;

    // The account was deserialized before the transfer; re-read it so the
    // event reports the balance after the deposit.
    ctx.accounts.vault_usdc.reload()?;
    let new_buffer_balance = ctx.accounts.vault_usdc.amount;

    emit!(BufferDepositEvent {
        depositor: ctx.accounts.buffer_depositor.key(),
        amount,
        new_buffer_balance,
    });

    Ok(())
}

/// Move `amount` USDC out of the vault to the `buffer_withdrawer`'s account.
/// A trusted role: there is no solvency check against outstanding OkuM, only
/// against the vault balance. Blocked while paused and in the slot of a
/// multiplier override.
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
    check_yield_lock(&ctx.accounts.config)?;
    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(amount > 0, LitePsmError::ZeroAmount);

    // Our own error instead of the opaque SPL insufficient-funds one.
    let vault_balance = ctx.accounts.vault_usdc.amount;
    require!(vault_balance >= amount, LitePsmError::InsufficientBuffer);

    // The config PDA owns the vault, so it signs the transfer out.
    let bump_seed = [ctx.accounts.config.bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer = &[&seeds[..]];

    anchor_spl::token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            anchor_spl::token::TransferChecked {
                from: ctx.accounts.vault_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.withdrawer_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        amount,
        USDC_DECIMALS,
    )?;

    // Re-read the vault so the event reports the post-withdrawal balance.
    ctx.accounts.vault_usdc.reload()?;
    let new_buffer_balance = ctx.accounts.vault_usdc.amount;

    emit!(BufferWithdrawEvent {
        actor: ctx.accounts.buffer_withdrawer.key(),
        amount,
        new_buffer_balance,
    });

    Ok(())
}
