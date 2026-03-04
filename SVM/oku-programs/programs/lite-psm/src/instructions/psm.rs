use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_spl::token_interface;
use crate::contexts::{MintOkusd, Redeem, ProcessQueue, DepositBuffer, WithdrawBuffer};
use crate::errors::OkuError;
use crate::events::*;
use crate::helpers::{check_oracle_reserves, calculate_interest_bearing_value};
use crate::state::{PsmConfig, RedemptionQueue, QueueEntry};

/// Mint OkuUSD with USDC (1:1)
/// If oracle is configured, checks reserves before minting
pub fn mint(ctx: Context<MintOkusd>, usdc_amount: u64) -> Result<()> {
    // Read state first
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    let bump = ctx.accounts.config.bump;
    let current_supply = ctx.accounts.okusd_mint.supply;
    let oracle = ctx.accounts.config.oracle;
    let staleness_threshold = ctx.accounts.config.staleness_threshold;

    require!(!is_paused, OkuError::Paused);
    require!(usdc_amount > 0, OkuError::ZeroAmount);

    // Calculate OkuUSD amount (1:1, adjusting for decimal differences if any)
    let okusd_amount = usdc_amount; // Assuming same decimals

    // Check max supply
    require!(
        current_supply.checked_add(okusd_amount).ok_or(OkuError::Overflow)? <= max_supply,
        OkuError::MaxSupplyExceeded
    );

    // Check minter allowance
    require!(okusd_amount <= minter_allowance, OkuError::AllowanceExceeded);

    // Oracle check if configured (oracle != Pubkey::default())
    if oracle != Pubkey::default() {
        check_oracle_reserves(
            &ctx.accounts.price_update,
            oracle,
            staleness_threshold,
            current_supply,
            okusd_amount,
        )?;
    }

    // Transfer USDC from user to vault (standard SPL)
    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // Mint OkuUSD to user (Token-2022)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Capture user key before mutable borrow
    let user_key = ctx.accounts.user.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_interface::MintTo {
                mint: ctx.accounts.okusd_mint.to_account_info(),
                to: ctx.accounts.user_okusd_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        okusd_amount,
    )?;

    // Decrement minter allowance (one-way: burns do NOT restore)
    let config = &mut ctx.accounts.config;
    config.minter_allowance = minter_allowance
        .checked_sub(okusd_amount)
        .ok_or(OkuError::Overflow)?;

    emit!(MintEvent {
        user: user_key,
        usdc_amount,
        okusd_amount,
    });

    Ok(())
}

/// Redeem OkuUSD for USDC (instant if buffer sufficient, otherwise queued)
/// When queued, OkuUSD is held in escrow to earn yield while waiting
pub fn redeem(ctx: Context<Redeem>, okusd_amount: u64) -> Result<()> {
    // Read state first
    let is_paused = ctx.accounts.config.is_paused;
    let bump = ctx.accounts.config.bump;
    let okusd_decimals = ctx.accounts.okusd_mint.decimals;
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;

    require!(!is_paused, OkuError::Paused);
    require!(okusd_amount > 0, OkuError::ZeroAmount);

    // Calculate USDC amount (1:1 with OkuUSD, both have same decimals)
    let usdc_amount = okusd_amount;

    // Check if buffer is sufficient for instant redemption
    if vault_usdc_balance >= usdc_amount {
        // Instant redemption path:
        // 1. Burn OkuUSD from user
        // 2. Transfer USDC to user

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                    from: ctx.accounts.user_okusd_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            okusd_amount,
        )?;

        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    to: ctx.accounts.user_usdc_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            usdc_amount,
        )?;

        emit!(RedeemEvent {
            user: ctx.accounts.user.key(),
            okusd_amount,
            usdc_amount,
        });
    } else {
        // Queue redemption path:
        // 1. Transfer OkuUSD to escrow (NOT burn - so it earns yield while queued)
        // 2. Record entry in queue with timestamp for interest calculation

        let queue = &mut ctx.accounts.redemption_queue;
        require!(!queue.is_full(), OkuError::QueueFull);

        // Transfer OkuUSD from user to escrow vault (yield accrues while in escrow)
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_okusd_ata.to_account_info(),
                    to: ctx.accounts.vault_okusd.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                },
            ),
            okusd_amount,
            okusd_decimals,
        )?;

        let clock = Clock::get()?;
        let entry = QueueEntry {
            user: ctx.accounts.user.key(),
            okusd_raw_amount: okusd_amount,
            timestamp: clock.unix_timestamp,
        };

        // Insert at tail position (ring buffer: modulo into fixed array)
        let position = queue.tail % RedemptionQueue::MAX_ENTRIES as u32;
        queue.entries[position as usize] = entry;
        queue.tail = queue.tail.wrapping_add(1);

        emit!(RedemptionQueuedEvent {
            user: ctx.accounts.user.key(),
            okusd_amount,
            queue_position: position,
        });
    }

    Ok(())
}

/// Process redemption queue (FIFO) - supports multiple recipients
/// Recipient USDC ATAs must be passed in remaining_accounts in queue order
/// Burns OkuUSD from escrow (including accrued yield) and transfers equivalent USDC
/// NOTE: Deliberately allowed during pause — users must be able to receive queued redemptions
pub fn process_queue<'info>(ctx: Context<'_, '_, '_, 'info, ProcessQueue<'info>>, max_entries: u32) -> Result<()> {
    let queue = &mut ctx.accounts.redemption_queue;
    let bump = ctx.accounts.config.bump;
    let current_rate_bps = ctx.accounts.config.current_rate_bps;

    require!(!queue.is_empty(), OkuError::QueueEmpty);

    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    let mut processed = 0u32;
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;
    let mut remaining_usdc_balance = vault_usdc_balance;

    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Clone account infos needed for CPI to avoid lifetime issues
    let vault_usdc_info = ctx.accounts.vault_usdc.to_account_info();
    let vault_okusd_info = ctx.accounts.vault_okusd.to_account_info();
    let config_account_info = ctx.accounts.config.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();
    let token_2022_program_info = ctx.accounts.token_2022_program.to_account_info();
    let okusd_mint_info = ctx.accounts.okusd_mint.to_account_info();

    while processed < max_entries && !queue.is_empty() {
        let head_idx = (queue.head % RedemptionQueue::MAX_ENTRIES as u32) as usize;

        let entry = &queue.entries[head_idx];

        // Calculate interest-bearing value (OkuUSD amount including accrued yield)
        // Formula: ui_amount = raw_amount × (1 + rate × time_elapsed / seconds_per_year)
        let time_elapsed = current_time.saturating_sub(entry.timestamp);
        let usdc_amount = calculate_interest_bearing_value(
            entry.okusd_raw_amount,
            current_rate_bps,
            time_elapsed,
        )?;

        // Check if we have enough USDC
        if remaining_usdc_balance < usdc_amount {
            break; // Stop processing, not enough buffer
        }

        // Get recipient's USDC ATA from remaining_accounts
        let recipient_account_idx = processed as usize;
        require!(
            recipient_account_idx < ctx.remaining_accounts.len(),
            OkuError::InsufficientAccounts
        );

        let recipient_usdc_ata = &ctx.remaining_accounts[recipient_account_idx];

        // Verify the account belongs to the queued user
        let account_data = recipient_usdc_ata.try_borrow_data()?;
        let parsed = SplTokenAccount::unpack(&account_data)
            .map_err(|_| OkuError::RecipientMismatch)?;
        let token_account_owner = parsed.owner;

        require!(
            token_account_owner == entry.user,
            OkuError::RecipientMismatch
        );

        let user = entry.user;
        let okusd_raw_amount = entry.okusd_raw_amount;

        // Drop the borrow before CPI
        drop(account_data);

        // Burn OkuUSD from escrow vault (the raw amount that was stored)
        token_interface::burn(
            CpiContext::new_with_signer(
                token_2022_program_info.clone(),
                token_interface::Burn {
                    mint: okusd_mint_info.clone(),
                    from: vault_okusd_info.clone(),
                    authority: config_account_info.clone(),
                },
                signer,
            ),
            okusd_raw_amount,
        )?;

        // Transfer USDC to recipient (amount includes yield accrued while queued)
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                token_program_info.clone(),
                anchor_spl::token::Transfer {
                    from: vault_usdc_info.clone(),
                    to: recipient_usdc_ata.clone(),
                    authority: config_account_info.clone(),
                },
                signer,
            ),
            usdc_amount,
        )?;

        remaining_usdc_balance = remaining_usdc_balance
            .checked_sub(usdc_amount)
            .ok_or(OkuError::Overflow)?;

        queue.head = queue.head.wrapping_add(1);
        processed += 1;

        emit!(RedemptionProcessedEvent {
            user,
            usdc_amount,
        });
    }

    Ok(())
}

/// Deposit USDC buffer (buffer_depositor role)
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
    require!(amount > 0, OkuError::ZeroAmount);

    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.buffer_depositor_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.buffer_depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(BufferDepositEvent {
        orchestrator: ctx.accounts.buffer_depositor.key(),
        amount,
    });

    Ok(())
}

/// Withdraw USDC from buffer (buffer_withdrawer only)
/// Used to reclaim excess buffer after redemptions processed
/// Protects queued redemptions: cannot withdraw if it would strand queued entries
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
    require!(amount > 0, OkuError::ZeroAmount);

    // Protect queued redemptions: sum pending entries' interest-adjusted amounts as reserved USDC
    // process_queue() pays interest-adjusted values, so we must reserve the same
    let queue = &ctx.accounts.redemption_queue;
    let current_rate_bps = ctx.accounts.config.current_rate_bps;
    let clock = Clock::get()?;
    let mut reserved: u64 = 0;
    let pending = queue.pending_count();
    for i in 0..pending {
        let idx = ((queue.head.wrapping_add(i)) % RedemptionQueue::MAX_ENTRIES as u32) as usize;
        let entry = &queue.entries[idx];
        let time_elapsed = clock.unix_timestamp.saturating_sub(entry.timestamp);
        let adjusted = calculate_interest_bearing_value(
            entry.okusd_raw_amount, current_rate_bps, time_elapsed,
        )?;
        reserved = reserved
            .checked_add(adjusted)
            .ok_or(OkuError::Overflow)?;
    }
    let vault_balance = ctx.accounts.vault_usdc.amount;
    require!(
        vault_balance.checked_sub(amount).ok_or(OkuError::Overflow)? >= reserved,
        OkuError::InsufficientBuffer
    );

    let bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.vault_usdc.to_account_info(),
                to: ctx.accounts.withdrawer_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    emit!(BufferWithdrawEvent {
        role_admin: ctx.accounts.buffer_withdrawer.key(),
        amount,
    });

    Ok(())
}
