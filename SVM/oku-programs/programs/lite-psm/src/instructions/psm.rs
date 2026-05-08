//! LitePSM user-facing instructions (mint/redeem/queue).
//!
//! The buffer-backed mint + redemption-queue lifecycle here mirrors MakerDAO's
//! `DssLitePsm`: deposit USDC → mint at peg, redeem from buffer when liquid,
//! enqueue when buffer is depleted, drain queue from a separate USDC top-up.
//! Taken from https://github.com/makerdao/dss-lite-psm/blob/master/src/DssLitePsm.sol

use crate::contexts::{
    DepositBuffer, MintOkuM, ProcessQueue, RedeemOkuM, RescueQueueEntry, WithdrawBuffer,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_oracle_reserves, check_yield_lock, dollars_to_oku_m, oku_m_to_dollars};
use crate::state::{PsmConfig, QueueEntry, RedemptionQueue};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_spl::token_interface;

/// Mint OkuMoney with USDC (price-aware)
///
/// oku_m_amount = usdc_amount * PRECISION / oku_m_price
/// When oku_m_price > PRECISION, you get fewer OkuM tokens per USDC
///
/// If oracle is configured, checks reserves before minting.
/// Blocked during same slot as yield distribution (sandwich prevention).
pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    let current_supply = ctx.accounts.oku_money_mint.supply;
    let oracle = ctx.accounts.config.oracle;

    require!(!is_paused, LitePsmError::Paused);
    require!(usdc_amount > 0, LitePsmError::ZeroAmount);

    // Read current price from config
    let oku_m_price = ctx.accounts.config.oku_m_price;

    // Calculate OkuMoney amount (price-aware): treat usdc_amount as a dollar value.
    let oku_m_amount = dollars_to_oku_m(usdc_amount, oku_m_price)?;

    // Reject zero-output mints — at high `oku_m_price`, the division can
    // truncate to zero, which would silently donate USDC to the buffer with
    // no OkuMoney minted in return. Matches EVM `LitePSM` `AmountTooSmall`.
    require!(oku_m_amount > 0, LitePsmError::AmountTooSmall);

    // Check max supply
    require!(
        current_supply
            .checked_add(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );

    // Check minter allowance
    require!(
        oku_m_amount <= minter_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Oracle check if configured (oracle != Pubkey::default()).
    // `check_oracle_reserves` reads the configured Pyth program owner, the
    // oracle feed pubkey, and the staleness threshold directly from PsmConfig
    // — refactored from the previously hardcoded Pyth program-owner constants.
    if oracle != Pubkey::default() {
        check_oracle_reserves(
            &ctx.accounts.price_update,
            &ctx.accounts.config,
            current_supply,
            oku_m_amount,
        )?;
    }

    // Effects-checks-interactions: decrement minter allowance BEFORE the mint
    // CPI so a future Token-2022 transfer-hook on OkuMoney cannot re-enter and
    // double-spend the same allowance window. Matches the same pattern used
    // throughout the bridge handlers.
    let bump = ctx.accounts.config.bump;
    ctx.accounts.config.minter_allowance = minter_allowance
        .checked_sub(oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Transfer USDC from user to vault (standard SPL)
    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // Mint OkuMoney to user (Token-2022)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Capture user key before borrows
    let user_key = ctx.accounts.user.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                to: ctx.accounts.user_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        oku_m_amount,
    )?;

    // Calculate dollar value for event
    let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    emit!(MintEvent {
        user: user_key,
        usdc_amount,
        oku_m_amount,
        dollar_value,
        oku_m_price,
    });

    Ok(())
}

/// Redeem OkuMoney for USDC (price-aware)
///
/// usdc_amount = oku_m_amount * oku_m_price / PRECISION
/// When oku_m_price > PRECISION, you get more USDC per OkuM token
///
/// Instant if buffer sufficient, otherwise queued.
/// Blocked during same slot as yield distribution (sandwich prevention).
pub fn redeem_oku_m(ctx: Context<RedeemOkuM>, oku_m_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let bump = ctx.accounts.config.bump;
    let oku_money_decimals = ctx.accounts.oku_money_mint.decimals;
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;

    require!(!is_paused, LitePsmError::Paused);
    require!(oku_m_amount > 0, LitePsmError::ZeroAmount);

    // Read current price from config
    let oku_m_price = ctx.accounts.config.oku_m_price;

    // Calculate USDC amount (price-aware): treat dollar value as USDC.
    //
    // NOTE: SVM uses 6-decimal USDC and 6-decimal OkuMoney. Unlike EVM (which
    // truncates the 18-decimal `okuMAmount` down to USDC's 6-decimal grid via
    // `usdcDecimalMultiplier`), the SVM math is already 1:1 in decimals. The
    // only zero-output path is `oku_m_amount * oku_m_price < PRECISION`, which
    // we explicitly reject below. See `EVM_VS_SVM.md` for the full divergence
    // table.
    let usdc_amount = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    // Reject zero-output redeems — at low `oku_m_amount` and unit price the
    // division can truncate to zero, which would burn OkuMoney for no USDC.
    // Mirrors the EVM `OutputBelowMinimum` revert.
    require!(usdc_amount > 0, LitePsmError::OutputBelowMinimum);

    // Check if buffer is sufficient for instant redemption
    if vault_usdc_balance >= usdc_amount {
        // Instant redemption path:
        // 1. Burn OkuMoney from user
        // 2. Transfer USDC to user

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.key(),
                token_interface::Burn {
                    mint: ctx.accounts.oku_money_mint.to_account_info(),
                    from: ctx.accounts.user_oku_money_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            oku_m_amount,
        )?;

        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
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
            oku_m_amount,
            usdc_amount,
            dollar_value: usdc_amount, // USDC is dollar-denominated
            oku_m_price,
        });
    } else {
        // Queue redemption path:
        // 1. Transfer OkuMoney to escrow
        // 2. Record entry in queue

        let queue = &mut ctx.accounts.redemption_queue;
        require!(!queue.is_full(), LitePsmError::QueueFull);

        // Transfer OkuMoney from user to escrow vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_2022_program.key(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_oku_money_ata.to_account_info(),
                    to: ctx.accounts.vault_oku_money.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.oku_money_mint.to_account_info(),
                },
            ),
            oku_m_amount,
            oku_money_decimals,
        )?;

        let clock = Clock::get()?;
        let entry = QueueEntry {
            user: ctx.accounts.user.key(),
            oku_m_amount,
            timestamp: clock.unix_timestamp,
        };

        // Insert at tail position (ring buffer: modulo into fixed array)
        let position = queue.tail % RedemptionQueue::MAX_ENTRIES as u32;
        queue.entries[position as usize] = entry;
        queue.tail = queue.tail.wrapping_add(1);

        // Update running counter
        queue.total_queued_oku_m = queue
            .total_queued_oku_m
            .checked_add(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?;

        // Calculate dollar value at time of queueing
        let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

        emit!(RedemptionQueuedEvent {
            user: ctx.accounts.user.key(),
            oku_m_amount,
            dollar_value,
            queue_position: position,
            queue_length: queue.pending_count(),
        });
    }

    Ok(())
}

/// Process redemption queue (FIFO) - supports multiple recipients
///
/// Uses current oku_m_price for all entries in the batch (cached once).
/// Recipient USDC ATAs must be passed in remaining_accounts in queue order.
///
/// NOTE: Deliberately allowed during pause - users must be able to receive queued redemptions.
pub fn process_queue<'info>(
    ctx: Context<'info, ProcessQueue<'info>>,
    max_entries: u32,
) -> Result<()> {
    let queue = &mut ctx.accounts.redemption_queue;
    let bump = ctx.accounts.config.bump;

    require!(!queue.is_empty(), LitePsmError::QueueEmpty);

    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Cache price once for batch consistency (matches EVM behavior)
    let oku_m_price = ctx.accounts.config.oku_m_price;

    let mut processed = 0u32;
    let mut payouts = 0u32; // Counts only non-skipped entries that consumed a remaining_account
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;
    let mut remaining_usdc_balance = vault_usdc_balance;

    // Clone account infos needed for CPI to avoid lifetime issues
    let vault_usdc_info = ctx.accounts.vault_usdc.to_account_info();
    let vault_oku_money_info = ctx.accounts.vault_oku_money.to_account_info();
    let config_account_info = ctx.accounts.config.to_account_info();
    let token_program_key = ctx.accounts.token_program.key();
    let token_2022_program_key = ctx.accounts.token_2022_program.key();
    let oku_money_mint_info = ctx.accounts.oku_money_mint.to_account_info();

    // Hoist `Clock::get()` out of the loop — slot/timestamp are constant across
    // the batch and the syscall is non-trivial.
    let clock = Clock::get()?;

    while processed < max_entries && !queue.is_empty() {
        let head_idx = (queue.head % RedemptionQueue::MAX_ENTRIES as u32) as usize;

        let entry = &queue.entries[head_idx];

        // Skip entries that were cleared by `rescue_queue_entry`. Without this,
        // a non-head hole produced by rescue would pin the loop on a zero-amount
        // entry whose `user == Pubkey::default()`, and the recipient-owner check
        // below would then revert the entire batch (DoS).
        //
        // Mirrors EVM `RedemptionQueue.processQueue` which `continue`s past
        // `entry.user == address(0)` and emits `RedemptionSkipped`.
        if entry.user == Pubkey::default() {
            emit!(RedemptionSkippedEvent {
                queue_index: queue.head,
            });
            queue.head = queue.head.wrapping_add(1);
            processed += 1;
            continue;
        }

        // Calculate USDC payout using current price.
        let usdc_amount = oku_m_to_dollars(entry.oku_m_amount, oku_m_price)?;

        // Reject zero-output payouts. `redeem_oku_m` rejects zero-output
        // at enqueue time, but a price drop between enqueue and process
        // could push a small entry under the truncation threshold; without
        // this check the queued OkuMoney would be burned for 0 USDC.
        require!(usdc_amount > 0, LitePsmError::OutputBelowMinimum);

        // Check if we have enough USDC
        if remaining_usdc_balance < usdc_amount {
            break; // Stop processing, not enough buffer
        }

        // Get recipient's USDC ATA from remaining_accounts
        // remaining_accounts is indexed by *payouts* (skipped entries do not
        // consume a remaining_account slot).
        let recipient_account_idx = payouts as usize;
        require!(
            recipient_account_idx < ctx.remaining_accounts.len(),
            LitePsmError::InsufficientAccounts
        );

        let recipient_usdc_ata = &ctx.remaining_accounts[recipient_account_idx];

        // Verify the account belongs to the queued user AND holds the configured USDC mint
        let account_data = recipient_usdc_ata.try_borrow_data()?;
        let parsed =
            SplTokenAccount::unpack(&account_data).map_err(|_| LitePsmError::RecipientMismatch)?;
        let token_account_owner = parsed.owner;
        let token_account_mint = parsed.mint;

        require!(
            token_account_owner == entry.user,
            LitePsmError::RecipientMismatch
        );
        require!(
            token_account_mint == ctx.accounts.config.usdc_mint,
            LitePsmError::RecipientMismatch
        );

        let user = entry.user;
        let oku_m_amount = entry.oku_m_amount;
        let entry_timestamp = entry.timestamp;

        // Drop the borrow before CPI
        drop(account_data);

        // Burn OkuMoney from escrow vault
        token_interface::burn(
            CpiContext::new_with_signer(
                token_2022_program_key,
                token_interface::Burn {
                    mint: oku_money_mint_info.clone(),
                    from: vault_oku_money_info.clone(),
                    authority: config_account_info.clone(),
                },
                signer,
            ),
            oku_m_amount,
        )?;

        // Transfer USDC to recipient
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                token_program_key,
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
            .ok_or(LitePsmError::Overflow)?;

        queue.head = queue.head.wrapping_add(1);
        processed += 1;
        payouts += 1;

        // Update running counter
        // Use checked_sub to catch any accounting bugs early rather than silently clamping
        queue.total_queued_oku_m = queue
            .total_queued_oku_m
            .checked_sub(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?;

        // Calculate dollar value at time of processing
        let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

        // Calculate wait time
        let wait_time = clock.unix_timestamp.saturating_sub(entry_timestamp);

        emit!(RedemptionProcessedEvent {
            user,
            oku_m_amount,
            dollar_value,
            usdc_amount,
            wait_time,
        });
    }

    // Emit a batch-level summary so indexers can reconcile buffer state
    // without summing per-entry events. EVM `BufferRefilled` parity.
    let skipped_count = processed.saturating_sub(payouts);
    emit!(BufferRefilledEvent {
        new_buffer_balance: remaining_usdc_balance,
        processed_count: payouts,
        skipped_count,
    });

    Ok(())
}

/// Deposit USDC buffer (buffer_depositor role)
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
    require!(amount > 0, LitePsmError::ZeroAmount);

    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.buffer_depositor_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.buffer_depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    // Reload vault balance after transfer
    ctx.accounts.vault_usdc.reload()?;
    let new_buffer_balance = ctx.accounts.vault_usdc.amount;

    emit!(BufferDepositEvent {
        orchestrator: ctx.accounts.buffer_depositor.key(),
        amount,
        new_buffer_balance,
    });

    Ok(())
}

/// Withdraw USDC from buffer (buffer_withdrawer only)
///
/// Used to reclaim excess buffer after redemptions processed.
/// Protects queued redemptions: cannot withdraw if it would strand queued entries.
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
    require!(amount > 0, LitePsmError::ZeroAmount);

    // Protect queued redemptions: sum pending entries' price-adjusted amounts as reserved USDC
    let queue = &ctx.accounts.redemption_queue;

    // Read current price from config to calculate reserved USDC
    let oku_m_price = ctx.accounts.config.oku_m_price;

    // Calculate reserved USDC from running counter (O(1) instead of iterating)
    let reserved = oku_m_to_dollars(queue.total_queued_oku_m, oku_m_price)?;

    let vault_balance = ctx.accounts.vault_usdc.amount;
    require!(
        vault_balance
            .checked_sub(amount)
            .ok_or(LitePsmError::Overflow)?
            >= reserved,
        LitePsmError::InsufficientBuffer
    );

    let bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.vault_usdc.to_account_info(),
                to: ctx.accounts.withdrawer_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    // Reload vault balance after transfer
    ctx.accounts.vault_usdc.reload()?;
    let new_buffer_balance = ctx.accounts.vault_usdc.amount;

    emit!(BufferWithdrawEvent {
        actor: ctx.accounts.buffer_withdrawer.key(),
        amount,
        new_buffer_balance,
    });

    Ok(())
}

/// Rescue a stuck queue entry — return escrowed OkuMoney to a recipient
///
/// Matches EVM's rescueQueueEntry(). The queue_processor can rescue any
/// pending entry by returning the escrowed OkuMoney (not burning it).
/// The entry is cleared and the head advances past contiguous cleared entries.
///
/// # Arguments
/// * `queue_index` - Absolute index of the entry to rescue (must be between head and tail)
pub fn rescue_queue_entry(ctx: Context<RescueQueueEntry>, queue_index: u32) -> Result<()> {
    let queue = &mut ctx.accounts.redemption_queue;
    let bump = ctx.accounts.config.bump;

    // Validate index is within pending range
    require!(
        queue_index >= queue.head && queue_index < queue.tail,
        LitePsmError::InvalidQueueIndex
    );

    let position = (queue_index % RedemptionQueue::MAX_ENTRIES as u32) as usize;
    let entry = &queue.entries[position];

    // Check entry hasn't already been cleared
    require!(
        entry.user != Pubkey::default(),
        LitePsmError::EntryAlreadyCleared
    );

    let original_user = entry.user;
    let oku_m_amount = entry.oku_m_amount;
    let oku_money_decimals = ctx.accounts.oku_money_mint.decimals;

    // Transfer OkuMoney from escrow back to recipient (not burning — user reclaims tokens)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.vault_oku_money.to_account_info(),
                to: ctx.accounts.recipient_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
                mint: ctx.accounts.oku_money_mint.to_account_info(),
            },
            signer,
        ),
        oku_m_amount,
        oku_money_decimals,
    )?;

    // Clear the entry
    let queue = &mut ctx.accounts.redemption_queue;
    queue.entries[position] = QueueEntry::default();

    // Update running counter
    // Use checked_sub to catch any accounting bugs early rather than silently clamping
    queue.total_queued_oku_m = queue
        .total_queued_oku_m
        .checked_sub(oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Advance head past contiguous cleared entries (matches EVM behavior)
    while queue.head < queue.tail {
        let head_pos = (queue.head % RedemptionQueue::MAX_ENTRIES as u32) as usize;
        if queue.entries[head_pos].user == Pubkey::default() {
            queue.head = queue.head.wrapping_add(1);
        } else {
            break;
        }
    }

    // Calculate dollar value at time of rescue
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    emit!(RedemptionRescuedEvent {
        queue_index,
        original_user,
        recipient: ctx.accounts.recipient_oku_money_ata.owner,
        oku_m_amount,
        dollar_value,
    });

    Ok(())
}
