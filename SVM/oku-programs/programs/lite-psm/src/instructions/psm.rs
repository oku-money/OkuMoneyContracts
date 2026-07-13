//! LitePSM user-facing instructions (mint/redeem/queue).
//!
//! The buffer-backed mint + redemption-queue lifecycle here mirrors MakerDAO's
//! `DssLitePsm`: deposit USDC → mint at peg, redeem from buffer when liquid,
//! enqueue when buffer is depleted, drain queue from a separate USDC top-up.
//! Taken from https://github.com/makerdao/dss-lite-psm/blob/master/src/DssLitePsm.sol

// All CPI targets in this module are constrained by Anchor's typed
// `Program<'info, T>` accounts (Token, Token2022) which validate program
// ID at deserialization. The `arbitrary_cpi` warning is a false
// positive here (see `oku-programs/audit/README.md` § Accepted Risks).
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::contexts::{
    DepositBuffer, MintOkuM, ProcessQueue, RedeemOkuM, RescueQueueEntry, UserSelfRescueQueueEntry,
    WithdrawBuffer,
};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{
    check_yield_lock, dollars_to_oku_m, oku_m_to_dollars, oku_m_to_dollars_ceil,
};
use crate::state::{PsmConfig, QueueEntry, RedemptionQueue};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token::state::{Account as SplTokenAccount, AccountState};
use anchor_spl::token_interface;
// NOTE: We deliberately do NOT import `sol_remaining_compute_units` here.
//
// Earlier versions of this crate used it inside `process_queue` as a
// defence-in-depth early-exit when the CU budget was running low. That
// syscall is gated behind the `enable_remaining_compute_units_syscall`
// feature, which is currently INACTIVE on devnet (feature id
// 5TuppMutoyzhUSfuYdhgzD47F92GL1g89KpCZQKqedxP). The CLI's pre-deploy
// ELF validator rejects any program that imports it on a cluster where
// the feature isn't activated, with:
//   "ELF error: Unresolved symbol (sol_remaining_compute_units) ..."
//
// The static `MAX_BATCH_ENTRIES` cap below already bounds worst-case CU
// consumption: 50 entries × ~22 K CU/entry = ~1.1 M CU, well within the
// 1.4 M raised cap. The dynamic check was strictly belt-and-suspenders,
// so removing it preserves all real safety guarantees and unblocks
// devnet upgrades. If/when the feature gate activates on devnet+mainnet
// the dynamic check can be reintroduced via
// `solana_program::compute_units::sol_remaining_compute_units`.

/// Mint OkuMoney with USDC (price-aware)
///
/// oku_m_amount = usdc_amount * PRECISION / oku_m_price
/// When oku_m_price > PRECISION, you get fewer OkuM tokens per USDC
///
/// Blocked during the same slot as a yield distribution (sandwich
/// prevention).
pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    let current_supply = ctx.accounts.oku_money_mint.supply;

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

    // Effects-checks-interactions: decrement minter allowance BEFORE the mint
    // CPI so a future Token-2022 transfer-hook on OkuMoney cannot re-enter and
    // double-spend the same allowance window.
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

    // Cycle 4 (PSM-23): emit post-mint supply for indexer reconciliation.
    // `reload()` refreshes the mint account's `supply` field after the
    // mint_to CPI; without it we'd read the pre-mint cached value.
    ctx.accounts.oku_money_mint.reload()?;
    let new_total_supply = ctx.accounts.oku_money_mint.supply;

    emit!(MintEvent {
        user: user_key,
        usdc_amount,
        oku_m_amount,
        dollar_value,
        oku_m_price,
        new_total_supply,
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
    // we explicitly reject below. See `SVM/README.md` § "EVM vs SVM —
    // divergence catalogue" for the full divergence table.
    let usdc_amount = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    // Reject zero-output redeems — at low `oku_m_amount` and unit price the
    // division can truncate to zero, which would burn OkuMoney for no USDC.
    // Mirrors the EVM `OutputBelowMinimum` revert.
    require!(usdc_amount > 0, LitePsmError::OutputBelowMinimum);

    // Pre-check user balance to surface a custom error instead of the
    // opaque SPL insufficient-balance error. Cycle 4 (PSM-11): emits
    // `InsufficientUserBalance` (was misleadingly `InsufficientBuffer`).
    {
        let user_balance = ctx.accounts.user_oku_money_ata.amount;
        require!(
            user_balance >= oku_m_amount,
            LitePsmError::InsufficientUserBalance
        );
    }

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

        // Cycle 4 (PSM-23): emit post-burn supply for indexer
        // reconciliation. The OkuMoney burn happened earlier in this
        // branch (see the `token_interface::burn` call above this
        // transfer); `reload()` refreshes the cached supply.
        ctx.accounts.oku_money_mint.reload()?;
        let new_total_supply = ctx.accounts.oku_money_mint.supply;

        emit!(RedeemEvent {
            user: ctx.accounts.user.key(),
            oku_m_amount,
            usdc_amount,
            dollar_value: usdc_amount, // USDC is dollar-denominated
            oku_m_price,
            new_total_supply,
        });
    } else {
        // Queue redemption path:
        // 1. Check capacity (zero-copy read borrow, scoped)
        // 2. Transfer OkuMoney to escrow (CPI; no queue borrow held)
        // 3. Record entry in queue (zero-copy write borrow, scoped)

        // Capacity check up-front so we don't transfer-then-revert.
        {
            let queue = ctx.accounts.redemption_queue.load()?;
            require!(!queue.is_full(), LitePsmError::QueueFull);
        }

        // Transfer OkuMoney from user to escrow vault.
        // No `load_mut` held across this CPI — the AccountLoader is a runtime
        // RefCell borrow; the CPI re-borrows the same account info and would
        // panic if we still held the load.
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
        let user_key = ctx.accounts.user.key();

        // Now mutate the queue. Scoped block so the borrow drops before
        // the `emit!` (which re-reads `pending_count`).
        let (queue_position, queue_length) = {
            let mut queue = ctx.accounts.redemption_queue.load_mut()?;
            let entry = QueueEntry {
                user: user_key,
                oku_m_amount,
                timestamp: clock.unix_timestamp,
            };

            // Insert at tail position (ring buffer).
            let position = queue.tail; // absolute index for the event
            let pos_idx = RedemptionQueue::ring_index(position);
            queue.entries[pos_idx] = entry;
            // Cycle 4 (PSM-16): `checked_add(1)?` rather than
            // `wrapping_add(1)` even though u64 wrap is mathematically
            // unreachable (`~5.8e10` years at 100 enqueues/sec). The
            // checked variant makes the no-wrap invariant explicit
            // for auditors.
            queue.tail = queue.tail.checked_add(1).ok_or(LitePsmError::Overflow)?;

            // Update running counter
            queue.total_queued_oku_m = queue
                .total_queued_oku_m
                .checked_add(oku_m_amount)
                .ok_or(LitePsmError::Overflow)?;

            (position, queue.pending_count())
        };

        // Calculate dollar value at time of queueing
        let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

        emit!(RedemptionQueuedEvent {
            user: user_key,
            oku_m_amount,
            dollar_value,
            queue_position,
            queue_length,
        });
    }

    Ok(())
}

/// Process redemption queue (FIFO) - supports multiple recipients
///
/// Uses current oku_m_price for all entries in the batch (cached once).
/// Recipient USDC ATAs must be passed in remaining_accounts in queue order.
///
/// NOTE: Gated on `!is_paused` (mirrors EVM `LitePSM.processQueue`'s
/// `whenNotPaused`). Pausing the PSM halts queue drain on both sides for
/// symmetry with EVM. If in-flight obligations must be honored during a
/// pause, the operator should use `rescue_queue_entry` to return OkuM to
/// users and unpause before restarting the drain.
///
/// Deliberately does NOT call `check_yield_lock`. This matches EVM
/// `RedemptionQueue.processQueue`'s lack of the
/// `whenYieldNotDistributing` modifier. The reasoning:
///
/// - Queued entries store the raw `oku_m_amount` (token count), not the
///   USDC payout amount. Conversion uses the CURRENT `oku_m_price` at
///   process time (cached on line 299 for batch consistency).
/// - `oku_m_price` is monotonically non-decreasing
///   (`PriceCannotDecrease` is enforced in `set_oku_m_price`).
/// - A same-slot `distribute_yield` / `set_oku_m_price` therefore makes
///   queued users MORE USDC, not less. Users can only benefit from a
///   yield op landing in the same slot as `process_queue`; they cannot
///   be sandwiched out of their fair share.
///
/// The yield lock is still required for `mint_oku_m` and `redeem_oku_m`
/// (where a same-slot price bump would let the attacker mint cheaply
/// then redeem dear), but `process_queue` is paying out previously-
/// committed queue entries and has no such asymmetry.
/// Hard upper bound on entries `process_queue` will walk in a single tx.
///
/// This is the SOLE CU-budget safety: each iteration burns two CPIs
/// (Token-2022 burn + SPL transfer), a price multiply, and an AccountLoader
/// load + store, empirically ~18–22 K CU/entry. 50 entries × 22 K = 1.1 M CU,
/// well under the 1.4 M raised cap orchestrators set on this instruction.
///
/// At the 200-entry queue cap, this static ceiling also bounds the
/// `remaining_accounts` slice SDK consumers must build, giving a predictable
/// worst-case account-list size.
///
/// A dynamic `sol_remaining_compute_units()` early-exit was removed because
/// the syscall is gated behind a feature (`enable_remaining_compute_units_
/// syscall`) that is currently inactive on devnet — see the comment at the
/// top of this file. The static cap alone is sufficient for the CU-bound
/// safety property; the dynamic check was strict belt-and-suspenders.
///
/// Cycle 4 (PSM-18): the cap lives on `RedemptionQueue::MAX_BATCH_ENTRIES`
/// next to `MAX_ENTRIES`. Callers reference it via the type prefix
/// (`RedemptionQueue::MAX_BATCH_ENTRIES`); see line 413 below.
pub fn process_queue<'info>(
    ctx: Context<'info, ProcessQueue<'info>>,
    max_entries: u32,
) -> Result<()> {
    // Pause gate — mirrors EVM `LitePSM.processQueue`'s `whenNotPaused`.
    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);

    let bump = ctx.accounts.config.bump;

    // Hard-cap the batch size. See `RedemptionQueue::MAX_BATCH_ENTRIES`
    // for rationale.
    let effective_max = max_entries.min(RedemptionQueue::MAX_BATCH_ENTRIES);

    // Initial empty check (scoped borrow).
    {
        let queue = ctx.accounts.redemption_queue.load()?;
        require!(!queue.is_empty(), LitePsmError::QueueEmpty);
    }

    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Cache price once for batch consistency (matches EVM behavior)
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let configured_usdc_mint = ctx.accounts.config.usdc_mint;

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

    'batch: while processed < effective_max {
        // CU-budget safety is enforced exclusively by the static
        // `MAX_BATCH_ENTRIES` cap. See the syscall comment near the top of
        // this file for why we no longer call `sol_remaining_compute_units`.
        // 50 entries × ~22 K CU/entry ≈ 1.1 M CU, within the 1.4 M raised
        // budget that orchestrators set on this instruction.

        // Per-iteration: read head + entry under a scoped read borrow,
        // then drop the borrow before any CPI. This is the load-bearing
        // discipline that makes zero-copy + CPI loops work — the
        // `AccountLoader` borrow is a runtime `RefCell` borrow, and any
        // CPI that re-borrows the same account info panics if we still
        // hold it.
        let (head_now, entry_user, entry_oku_m, entry_ts) = {
            let queue = ctx.accounts.redemption_queue.load()?;
            if queue.is_empty() {
                break 'batch;
            }
            let head_idx = RedemptionQueue::ring_index(queue.head);
            let entry = &queue.entries[head_idx];
            (queue.head, entry.user, entry.oku_m_amount, entry.timestamp)
        };

        // Skip entries cleared by `rescue_queue_entry`. Without this, a
        // non-head hole produced by rescue would pin the loop on a
        // zero-amount entry whose `user == Pubkey::default()`, and the
        // recipient-owner check below would revert the entire batch (DoS).
        //
        // Mirrors EVM `RedemptionQueue.processQueue` which `continue`s
        // past `entry.user == address(0)` and emits `RedemptionSkipped`.
        if entry_user == Pubkey::default() {
            {
                let mut queue = ctx.accounts.redemption_queue.load_mut()?;
                queue.head = queue.head.checked_add(1).ok_or(LitePsmError::Overflow)?;
            }
            emit!(RedemptionSkippedEvent {
                queue_index: head_now,
            });
            // Counter bounded by MAX_ENTRIES (200) per batch — fits in u64.
            #[allow(clippy::arithmetic_side_effects)]
            {
                processed += 1;
            }
            continue;
        }

        // Calculate USDC payout using current price.
        let usdc_amount = oku_m_to_dollars(entry_oku_m, oku_m_price)?;

        // Check buffer; stop the batch if insufficient.
        if remaining_usdc_balance < usdc_amount {
            break 'batch;
        }

        // Get recipient's USDC ATA from remaining_accounts. remaining_accounts
        // is indexed by *payouts* (skipped entries don't consume a slot).
        let recipient_account_idx = payouts as usize;
        require!(
            recipient_account_idx < ctx.remaining_accounts.len(),
            LitePsmError::InsufficientAccounts
        );
        let recipient_usdc_ata = &ctx.remaining_accounts[recipient_account_idx];

        // Verify the account belongs to the queued user AND holds the
        // configured USDC mint AND is not frozen. SPL Token account data
        // unpack is read-only.
        //
        // If validation fails (wrong owner/mint OR frozen ATA), we soft-skip:
        // emit RedemptionSkippedEvent and break (not revert). This prevents a
        // single USDC-blacklisted/frozen recipient from reverting the whole
        // batch.
        //
        // SVM FIFO semantics: because the queue processes from head forward,
        // a stuck head entry blocks every subsequent entry in the same
        // batch. This differs from the EVM implementation which supports
        // random-access `[startIndex, endIndex]` ranges. Two unblock paths
        // exist post-cycle-4 (PSM-06):
        //
        //   * **Operator path** — `queue_processor` calls
        //     `rescue_queue_entry`, returning OkuM to any recipient.
        //     Same flow EVM uses.
        //   * **User path** — the affected user calls
        //     `user_self_rescue_queue_entry` from any wallet they
        //     control (thawed ATA on the same mint), unblocking
        //     themselves without operator action. This eliminates the
        //     head-pin DoS finding from the audit triage.
        //
        // Either path clears the slot and the next `process_queue` call
        // proceeds through the rest of the queue.
        {
            let ata_ok = match recipient_usdc_ata.try_borrow_data() {
                Ok(account_data) => match SplTokenAccount::unpack(&account_data) {
                    Ok(parsed) => {
                        parsed.owner == entry_user
                            && parsed.mint == configured_usdc_mint
                            && parsed.state != AccountState::Frozen
                    }
                    Err(_) => false,
                },
                Err(_) => false,
            };
            if !ata_ok {
                // Soft-skip: leave entry at head for rescue_queue_entry.
                emit!(RedemptionSkippedEvent {
                    queue_index: head_now,
                });
                break 'batch;
            }
        }

        // Burn OkuMoney from escrow vault. No queue borrow held.
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
            entry_oku_m,
        )?;

        // Transfer USDC to recipient. No queue borrow held.
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

        // Advance head + decrement counter under a scoped write borrow.
        {
            let mut queue = ctx.accounts.redemption_queue.load_mut()?;
            queue.head = queue.head.checked_add(1).ok_or(LitePsmError::Overflow)?;
            // checked_sub catches accounting bugs early rather than silently clamping.
            queue.total_queued_oku_m = queue
                .total_queued_oku_m
                .checked_sub(entry_oku_m)
                .ok_or(LitePsmError::Overflow)?;
        }

        // Counters bounded by MAX_ENTRIES (200) per batch — fits in u64.
        #[allow(clippy::arithmetic_side_effects)]
        {
            processed += 1;
            payouts += 1;
        }

        // Calculate dollar value at time of processing
        let dollar_value = oku_m_to_dollars(entry_oku_m, oku_m_price)?;

        // Calculate wait time
        let wait_time = clock.unix_timestamp.saturating_sub(entry_ts);

        // Cycle 4 (PSM-23): refresh the mint's `supply` field so the
        // event carries the post-burn value. `reload()` re-reads from
        // the underlying AccountInfo; safe to call here because no
        // zero-copy queue borrow is held at this point in the loop.
        ctx.accounts.oku_money_mint.reload()?;
        let new_total_supply = ctx.accounts.oku_money_mint.supply;

        emit!(RedemptionProcessedEvent {
            user: entry_user,
            oku_m_amount: entry_oku_m,
            dollar_value,
            usdc_amount,
            wait_time,
            new_total_supply,
        });
    }

    // Batch-level summary so indexers can reconcile buffer state without
    // summing per-entry events. EVM `BufferRefilled` parity.
    let skipped_count = processed.saturating_sub(payouts);
    emit!(BufferRefilledEvent {
        new_buffer_balance: remaining_usdc_balance,
        processed_count: payouts as u64,
        skipped_count: skipped_count as u64,
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
/// Gated on the yield-distribution lock for symmetry with `wrap`/`unwrap` on the
/// OkuDollar side and `withdrawSurplus` on the EVM side — a same-slot `distribute_yield`
/// or `set_oku_m_price` changes `oku_m_price`, which is read inside the reserved-USDC
/// calculation below. Defense-in-depth: the window is tiny and `buffer_withdrawer`
/// is already permissioned, but the lock makes the invariant explicit.
///
/// **Intentionally NOT pause-gated.** Mirrors EVM `LitePSM.withdrawUsdc`, which
/// has no `whenNotPaused` modifier (verified `EVM/src/psm/LitePSM.sol:540`).
/// Pause is a user-side incident lever: it blocks mints/redeems but must NOT
/// block the cold multisig from rebalancing buffer USDC during an incident
/// response. The `WouldStrandQueue`-equivalent reserved-USDC check above is
/// the only invariant that matters here, and it runs regardless of pause state.
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
    check_yield_lock(&ctx.accounts.config)?;
    require!(amount > 0, LitePsmError::ZeroAmount);

    // Protect queued redemptions: sum pending entries' price-adjusted amounts
    // as reserved USDC. Zero-copy: scope the `load()` borrow to just the read.
    let total_queued_oku_m = {
        let queue = ctx.accounts.redemption_queue.load()?;
        queue.total_queued_oku_m
    };

    // Read current price from config to calculate reserved USDC
    let oku_m_price = ctx.accounts.config.oku_m_price;

    // Calculate reserved USDC from running counter (O(1) instead of iterating).
    //
    // Cycle 4 — rounding direction (PSM-05):
    //
    // This computes `ceil(total_queued_oku_m * price / PRECISION)`. When
    // `process_queue` later pays each entry individually, it floors each
    // per-entry calculation; since `floor(a) + floor(b) <= floor(a+b)`,
    // the sum of individual payouts is bounded above by the ceiling
    // taken here, NEVER below it. The ceiling therefore over-reserves by
    // at most one lamport per call — strictly favouring queued users
    // over the buffer-withdrawer and removing the "last entries
    // unpayable" liveness window the previous floor variant carried.
    //
    // The asymmetry is the industry-standard direction: MakerDAO
    // `DssLitePsm` uses `_divup` (ceil) for the same accounting choice.
    let reserved = oku_m_to_dollars_ceil(total_queued_oku_m, oku_m_price)?;

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
pub fn rescue_queue_entry(ctx: Context<RescueQueueEntry>, queue_index: u64) -> Result<()> {
    let bump = ctx.accounts.config.bump;

    // Read + validate entry (scoped read borrow).
    let (original_user, oku_m_amount, position) = {
        let queue = ctx.accounts.redemption_queue.load()?;
        require!(
            queue_index >= queue.head && queue_index < queue.tail,
            LitePsmError::InvalidQueueIndex
        );
        let position = RedemptionQueue::ring_index(queue_index);
        let entry = &queue.entries[position];
        require!(
            entry.user != Pubkey::default(),
            LitePsmError::EntryAlreadyCleared
        );
        (entry.user, entry.oku_m_amount, position)
    };

    let oku_money_decimals = ctx.accounts.oku_money_mint.decimals;

    // Transfer OkuMoney from escrow back to recipient (not burning — user
    // reclaims tokens). No queue borrow held across the CPI.
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

    // Mutate: clear entry, decrement counter, advance head past contiguous
    // cleared entries. All purely in-account; no CPI inside the borrow.
    {
        let mut queue = ctx.accounts.redemption_queue.load_mut()?;
        queue.entries[position] = QueueEntry::default();

        // Use checked_sub to catch accounting bugs early rather than silently clamping.
        queue.total_queued_oku_m = queue
            .total_queued_oku_m
            .checked_sub(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?;

        // Advance head past contiguous cleared entries (matches EVM behavior).
        while queue.head < queue.tail {
            let head_pos = RedemptionQueue::ring_index(queue.head);
            if queue.entries[head_pos].user == Pubkey::default() {
                queue.head = queue.head.checked_add(1).ok_or(LitePsmError::Overflow)?;
            } else {
                break;
            }
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

/// Permissionless self-rescue — user reclaims their OWN queued OkuMoney.
///
/// Cycle 4 (PSM-06): the dual of `rescue_queue_entry`. Any user may
/// withdraw their queued OkuMoney back to a recipient ATA they control.
/// Resolves the head-pin DoS: a frozen / wrong-owner ATA on the head
/// entry previously blocked `process_queue` until the operator
/// intervened; now the affected user can self-unblock by calling this
/// instruction from a different (or thawed) ATA.
///
/// Key constraints (vs the operator rescue):
///   * Signer must be the entry's original queued user.
///   * Recipient ATA must be owned by that user (pinned via
///     `token::authority = user` on the context).
///   * No role check on `config` — explicitly permissionless.
///
/// # Arguments
/// * `queue_index` — absolute index of the entry to rescue
///   (`head <= queue_index < tail`).
pub fn user_self_rescue_queue_entry(
    ctx: Context<UserSelfRescueQueueEntry>,
    queue_index: u64,
) -> Result<()> {
    let bump = ctx.accounts.config.bump;
    let caller = ctx.accounts.user.key();

    // Read + validate (scoped read borrow).
    let (oku_m_amount, position) = {
        let queue = ctx.accounts.redemption_queue.load()?;
        require!(
            queue_index >= queue.head && queue_index < queue.tail,
            LitePsmError::InvalidQueueIndex
        );
        let position = RedemptionQueue::ring_index(queue_index);
        let entry = &queue.entries[position];
        require!(
            entry.user != Pubkey::default(),
            LitePsmError::EntryAlreadyCleared
        );
        // Authorization: caller must be the original queued user.
        // This is what distinguishes user-self-rescue from the
        // privileged operator path.
        require!(entry.user == caller, LitePsmError::Unauthorized);
        (entry.oku_m_amount, position)
    };

    let oku_money_decimals = ctx.accounts.oku_money_mint.decimals;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Return OkuMoney from escrow to the caller's chosen recipient ATA.
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

    // Mutate: clear entry, decrement counter, advance head over contiguous
    // cleared entries (same as `rescue_queue_entry`).
    {
        let mut queue = ctx.accounts.redemption_queue.load_mut()?;
        queue.entries[position] = QueueEntry::default();
        queue.total_queued_oku_m = queue
            .total_queued_oku_m
            .checked_sub(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?;
        while queue.head < queue.tail {
            let head_pos = RedemptionQueue::ring_index(queue.head);
            if queue.entries[head_pos].user == Pubkey::default() {
                queue.head = queue.head.checked_add(1).ok_or(LitePsmError::Overflow)?;
            } else {
                break;
            }
        }
    }

    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    emit!(RedemptionRescuedEvent {
        queue_index,
        original_user: caller,
        recipient: ctx.accounts.recipient_oku_money_ata.owner,
        oku_m_amount,
        dollar_value,
    });

    Ok(())
}
