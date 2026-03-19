use crate::contexts::{DepositBuffer, MintOkuM, ProcessQueue, RedeemOkuM, RescueQueueEntry, WithdrawBuffer};
use crate::errors::OkuError;
use crate::events::*;
use crate::helpers::{check_oracle_reserves, check_yield_lock, PRECISION};
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
    let bump = ctx.accounts.config.bump;
    let current_supply = ctx.accounts.oku_money_mint.supply;
    let oracle = ctx.accounts.config.oracle;
    let staleness_threshold = ctx.accounts.config.staleness_threshold;

    require!(!is_paused, OkuError::Paused);
    require!(usdc_amount > 0, OkuError::ZeroAmount);

    // Read current price from config
    let oku_m_price = ctx.accounts.config.oku_m_price;

    // Calculate OkuMoney amount (price-aware)
    // oku_m_amount = usdc_amount * PRECISION / oku_m_price
    let oku_m_amount = (usdc_amount as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(oku_m_price as u128)
        .ok_or(OkuError::Overflow)? as u64;

    // Check max supply
    require!(
        current_supply
            .checked_add(oku_m_amount)
            .ok_or(OkuError::Overflow)?
            <= max_supply,
        OkuError::MaxSupplyExceeded
    );

    // Check minter allowance
    require!(
        oku_m_amount <= minter_allowance,
        OkuError::AllowanceExceeded
    );

    // Oracle check if configured (oracle != Pubkey::default())
    if oracle != Pubkey::default() {
        check_oracle_reserves(
            &ctx.accounts.price_update,
            oracle,
            staleness_threshold,
            current_supply,
            oku_m_amount,
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

    // Mint OkuMoney to user (Token-2022)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Capture user key before mutable borrow
    let user_key = ctx.accounts.user.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                to: ctx.accounts.user_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        oku_m_amount,
    )?;

    // Decrement minter allowance (one-way: burns do NOT restore)
    let config = &mut ctx.accounts.config;
    config.minter_allowance = minter_allowance
        .checked_sub(oku_m_amount)
        .ok_or(OkuError::Overflow)?;

    // Calculate dollar value for event
    let dollar_value = (oku_m_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(OkuError::Overflow)? as u64;

    emit!(MintEvent {
        user: user_key,
        usdc_amount,
        oku_m_amount,
        dollar_value,
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

    require!(!is_paused, OkuError::Paused);
    require!(oku_m_amount > 0, OkuError::ZeroAmount);

    // Read current price from config
    let oku_m_price = ctx.accounts.config.oku_m_price;

    // Calculate USDC amount (price-aware)
    // usdc_amount = oku_m_amount * oku_m_price / PRECISION
    let usdc_amount = (oku_m_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(OkuError::Overflow)? as u64;

    // Check if buffer is sufficient for instant redemption
    if vault_usdc_balance >= usdc_amount {
        // Instant redemption path:
        // 1. Burn OkuMoney from user
        // 2. Transfer USDC to user

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
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
            oku_m_amount,
            usdc_amount,
            dollar_value: usdc_amount, // USDC is dollar-denominated
        });
    } else {
        // Queue redemption path:
        // 1. Transfer OkuMoney to escrow
        // 2. Record entry in queue

        let queue = &mut ctx.accounts.redemption_queue;
        require!(!queue.is_full(), OkuError::QueueFull);

        // Transfer OkuMoney from user to escrow vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
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

        emit!(RedemptionQueuedEvent {
            user: ctx.accounts.user.key(),
            oku_m_amount,
            queue_position: position,
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
    ctx: Context<'_, '_, '_, 'info, ProcessQueue<'info>>,
    max_entries: u32,
) -> Result<()> {
    let queue = &mut ctx.accounts.redemption_queue;
    let bump = ctx.accounts.config.bump;

    require!(!queue.is_empty(), OkuError::QueueEmpty);

    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Cache price once for batch consistency (matches EVM behavior)
    let oku_m_price = ctx.accounts.config.oku_m_price;

    let mut processed = 0u32;
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;
    let mut remaining_usdc_balance = vault_usdc_balance;

    // Clone account infos needed for CPI to avoid lifetime issues
    let vault_usdc_info = ctx.accounts.vault_usdc.to_account_info();
    let vault_oku_money_info = ctx.accounts.vault_oku_money.to_account_info();
    let config_account_info = ctx.accounts.config.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();
    let token_2022_program_info = ctx.accounts.token_2022_program.to_account_info();
    let oku_money_mint_info = ctx.accounts.oku_money_mint.to_account_info();

    while processed < max_entries && !queue.is_empty() {
        let head_idx = (queue.head % RedemptionQueue::MAX_ENTRIES as u32) as usize;

        let entry = &queue.entries[head_idx];

        // Calculate USDC payout using current price
        // usdc_amount = oku_m_amount * oku_m_price / PRECISION
        let usdc_amount = (entry.oku_m_amount as u128)
            .checked_mul(oku_m_price as u128)
            .ok_or(OkuError::Overflow)?
            .checked_div(PRECISION as u128)
            .ok_or(OkuError::Overflow)? as u64;

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
        let parsed =
            SplTokenAccount::unpack(&account_data).map_err(|_| OkuError::RecipientMismatch)?;
        let token_account_owner = parsed.owner;

        require!(
            token_account_owner == entry.user,
            OkuError::RecipientMismatch
        );

        let user = entry.user;
        let oku_m_amount = entry.oku_m_amount;

        // Drop the borrow before CPI
        drop(account_data);

        // Burn OkuMoney from escrow vault
        token_interface::burn(
            CpiContext::new_with_signer(
                token_2022_program_info.clone(),
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

        emit!(RedemptionProcessedEvent { user, usdc_amount });
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
///
/// Used to reclaim excess buffer after redemptions processed.
/// Protects queued redemptions: cannot withdraw if it would strand queued entries.
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
    require!(amount > 0, OkuError::ZeroAmount);

    // Protect queued redemptions: sum pending entries' price-adjusted amounts as reserved USDC
    let queue = &ctx.accounts.redemption_queue;

    // Read current price from config to calculate reserved USDC
    let oku_m_price = ctx.accounts.config.oku_m_price;

    let mut reserved: u64 = 0;
    let pending = queue.pending_count();
    for i in 0..pending {
        let idx = ((queue.head.wrapping_add(i)) % RedemptionQueue::MAX_ENTRIES as u32) as usize;
        let entry = &queue.entries[idx];

        // Calculate USDC value of this entry at current price
        let usdc_value = (entry.oku_m_amount as u128)
            .checked_mul(oku_m_price as u128)
            .ok_or(OkuError::Overflow)?
            .checked_div(PRECISION as u128)
            .ok_or(OkuError::Overflow)? as u64;

        reserved = reserved.checked_add(usdc_value).ok_or(OkuError::Overflow)?;
    }

    let vault_balance = ctx.accounts.vault_usdc.amount;
    require!(
        vault_balance
            .checked_sub(amount)
            .ok_or(OkuError::Overflow)?
            >= reserved,
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
        OkuError::InvalidQueueIndex
    );

    let position = (queue_index % RedemptionQueue::MAX_ENTRIES as u32) as usize;
    let entry = &queue.entries[position];

    // Check entry hasn't already been cleared
    require!(
        entry.user != Pubkey::default(),
        OkuError::EntryAlreadyCleared
    );

    let original_user = entry.user;
    let oku_m_amount = entry.oku_m_amount;
    let oku_money_decimals = ctx.accounts.oku_money_mint.decimals;

    // Transfer OkuMoney from escrow back to recipient (not burning — user reclaims tokens)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
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

    // Advance head past contiguous cleared entries (matches EVM behavior)
    while queue.head < queue.tail {
        let head_pos = (queue.head % RedemptionQueue::MAX_ENTRIES as u32) as usize;
        if queue.entries[head_pos].user == Pubkey::default() {
            queue.head = queue.head.wrapping_add(1);
        } else {
            break;
        }
    }

    emit!(RedemptionRescuedEvent {
        queue_index,
        original_user,
        recipient: ctx.accounts.recipient_oku_money_ata.owner,
        oku_m_amount,
    });

    Ok(())
}
