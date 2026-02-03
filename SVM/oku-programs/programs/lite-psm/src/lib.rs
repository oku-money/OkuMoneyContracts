use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

pub mod errors;
pub mod state;

use errors::OkuError;
use state::{PsmConfig, QueueEntry, RedemptionQueue};

declare_id!("FbYGHcN1wyXebY51vFpNmmNMuSZoXpEiEgCu3Lm9GujX");

#[program]
pub mod lite_psm {
    use super::*;

    /// Initialize the PSM - Step 1
    /// Creates config PDA, redemption queue, and USDC vault
    /// Call setup_okusd_escrow afterwards to complete initialization
    pub fn initialize(
        ctx: Context<Initialize>,
        max_supply: u64,
        minter_allowance: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;

        // Set all granular authorities
        config.admin = ctx.accounts.admin.key();
        config.psm_pauser = ctx.accounts.psm_pauser.key();
        config.psm_unpauser = ctx.accounts.psm_unpauser.key();
        config.blacklister = ctx.accounts.blacklister.key();
        config.unblacklister = ctx.accounts.unblacklister.key();
        config.queue_processor = ctx.accounts.queue_processor.key();
        config.buffer_depositor = ctx.accounts.buffer_depositor.key();
        config.buffer_withdrawer = ctx.accounts.buffer_withdrawer.key();
        config.oracle_manager = ctx.accounts.oracle_manager.key();
        config.cap_manager = ctx.accounts.cap_manager.key();
        config.allowance_manager = ctx.accounts.allowance_manager.key();
        config.rebaser = ctx.accounts.rebaser.key();

        // Set token references
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.okusd_mint = ctx.accounts.okusd_mint.key();
        config.vault_usdc_ata = ctx.accounts.vault_usdc_ata.key();
        config.vault_okusd_ata = Pubkey::default(); // Set in setup_okusd_escrow

        // Set limits
        config.max_supply = max_supply;
        config.minter_allowance = minter_allowance;
        config.is_paused = false;

        // Set oracle config
        config.oracle = Pubkey::default(); // Oracle disabled initially
        config.staleness_threshold = 0;
        config.current_rate_bps = 0; // Interest rate starts at 0, updated by rebaser

        // Initialize redemption queue
        let queue = &mut ctx.accounts.redemption_queue;
        queue.bump = ctx.bumps.redemption_queue;
        queue.head = 0;
        queue.tail = 0;
        queue.entries = Vec::with_capacity(RedemptionQueue::MAX_ENTRIES);

        emit!(InitializeEvent {
            admin: config.admin,
            usdc_mint: config.usdc_mint,
            okusd_mint: config.okusd_mint,
            max_supply,
        });

        Ok(())
    }

    /// Initialize the PSM - Step 2
    /// Creates OkuUSD escrow vault for queue yield alignment
    /// Must be called after initialize()
    pub fn setup_okusd_escrow(ctx: Context<SetupOkusdEscrow>) -> Result<()> {
        let config = &mut ctx.accounts.config;

        // Ensure escrow hasn't already been set
        require!(
            config.vault_okusd_ata == Pubkey::default(),
            OkuError::Unauthorized
        );

        config.vault_okusd_ata = ctx.accounts.vault_okusd_ata.key();

        Ok(())
    }

    /// Mint OkuUSD with USDC (1:1)
    /// If oracle is configured, checks reserves before minting
    pub fn mint(ctx: Context<MintOkusd>, usdc_amount: u64) -> Result<()> {
        // Read state first
        let is_paused = ctx.accounts.config.is_paused;
        let max_supply = ctx.accounts.config.max_supply;
        let bump = ctx.accounts.config.bump;
        let _okusd_decimals = ctx.accounts.okusd_mint.decimals;
        let _usdc_decimals = ctx.accounts.usdc_mint.decimals;
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
                    to: ctx.accounts.vault_usdc_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_amount,
        )?;

        // Mint OkuUSD to user (Token-2022)
        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

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

        emit!(MintEvent {
            user: ctx.accounts.user.key(),
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
        let vault_usdc_balance = ctx.accounts.vault_usdc_ata.amount;

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
                        from: ctx.accounts.vault_usdc_ata.to_account_info(),
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
                        to: ctx.accounts.vault_okusd_ata.to_account_info(),
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

            queue.entries.push(entry);
            let position = queue.tail;
            queue.tail = queue.tail.checked_add(1).ok_or(OkuError::Overflow)?;

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
    pub fn process_queue<'info>(ctx: Context<'_, '_, '_, 'info, ProcessQueue<'info>>, max_entries: u32) -> Result<()> {
        let queue = &mut ctx.accounts.redemption_queue;
        let bump = ctx.accounts.config.bump;
        let current_rate_bps = ctx.accounts.config.current_rate_bps;

        require!(!queue.is_empty(), OkuError::QueueEmpty);

        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        let mut processed = 0u32;
        let vault_usdc_balance = ctx.accounts.vault_usdc_ata.amount;
        let mut remaining_usdc_balance = vault_usdc_balance;

        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        // Clone account infos needed for CPI to avoid lifetime issues
        let vault_usdc_info = ctx.accounts.vault_usdc_ata.to_account_info();
        let vault_okusd_info = ctx.accounts.vault_okusd_ata.to_account_info();
        let config_account_info = ctx.accounts.config.to_account_info();
        let token_program_info = ctx.accounts.token_program.to_account_info();
        let token_2022_program_info = ctx.accounts.token_2022_program.to_account_info();
        let okusd_mint_info = ctx.accounts.okusd_mint.to_account_info();

        while processed < max_entries && !queue.is_empty() {
            let head_idx = queue.head as usize;
            if head_idx >= queue.entries.len() {
                break;
            }

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

            // Verify the account belongs to the queued user by manually parsing TokenAccount data
            // TokenAccount layout: mint (32) + owner (32) + amount (8) + ...
            let account_data = recipient_usdc_ata.try_borrow_data()?;
            require!(account_data.len() >= 72, OkuError::RecipientMismatch);

            // Owner is at offset 32 (after mint pubkey)
            let owner_bytes: [u8; 32] = account_data[32..64]
                .try_into()
                .map_err(|_| OkuError::RecipientMismatch)?;
            let token_account_owner = Pubkey::from(owner_bytes);

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

            queue.head = queue.head.checked_add(1).ok_or(OkuError::Overflow)?;
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
                    to: ctx.accounts.vault_usdc_ata.to_account_info(),
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
    pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
        require!(amount > 0, OkuError::ZeroAmount);

        let bump = ctx.accounts.config.bump;
        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.vault_usdc_ata.to_account_info(),
                    to: ctx.accounts.withdrawer_usdc_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        emit!(BufferWithdrawEvent {
            admin: ctx.accounts.buffer_withdrawer.key(),
            amount,
        });

        Ok(())
    }

    /// Bridge mint (from cross-chain)
    pub fn bridge_mint(
        ctx: Context<BridgeMint>,
        amount: u64,
        source_chain: u16,
    ) -> Result<()> {
        // Read state
        let is_paused = ctx.accounts.config.is_paused;
        let max_supply = ctx.accounts.config.max_supply;
        let minter_allowance = ctx.accounts.config.minter_allowance;
        let bump = ctx.accounts.config.bump;
        let current_supply = ctx.accounts.okusd_mint.supply;

        require!(!is_paused, OkuError::Paused);
        require!(amount > 0, OkuError::ZeroAmount);
        require!(amount <= minter_allowance, OkuError::AllowanceExceeded);
        require!(
            current_supply.checked_add(amount).ok_or(OkuError::Overflow)? <= max_supply,
            OkuError::MaxSupplyExceeded
        );

        // Mint OkuUSD to recipient
        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                    to: ctx.accounts.recipient_okusd_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        // Decrement minter allowance
        let config = &mut ctx.accounts.config;
        config.minter_allowance = minter_allowance
            .checked_sub(amount)
            .ok_or(OkuError::Overflow)?;

        emit!(BridgeMintEvent {
            recipient: ctx.accounts.recipient_okusd_ata.key(),
            amount,
            source_chain,
        });

        Ok(())
    }

    /// Bridge burn (to cross-chain)
    pub fn bridge_burn(
        ctx: Context<BridgeBurn>,
        amount: u64,
        destination_chain: u16,
    ) -> Result<()> {
        let is_paused = ctx.accounts.config.is_paused;

        require!(!is_paused, OkuError::Paused);
        require!(amount > 0, OkuError::ZeroAmount);

        // Burn OkuUSD from user
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                    from: ctx.accounts.user_okusd_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(BridgeBurnEvent {
            user: ctx.accounts.user.key(),
            amount,
            destination_chain,
        });

        Ok(())
    }

    /// Pause the PSM (emergency response)
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = true;

        emit!(PauseEvent {
            pauser: ctx.accounts.pauser.key(),
            paused: true,
        });

        Ok(())
    }

    /// Unpause the PSM (deliberate review required)
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = false;

        emit!(UnpauseEvent {
            unpauser: ctx.accounts.unpauser.key(),
        });

        Ok(())
    }

    /// Update max supply (cap_manager only)
    pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.max_supply = new_max_supply;

        emit!(MaxSupplyUpdatedEvent {
            admin: ctx.accounts.cap_manager.key(),
            new_max_supply,
        });

        Ok(())
    }

    /// Reset minter allowance (allowance_manager only)
    pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.minter_allowance = amount;

        emit!(MinterAllowanceUpdatedEvent {
            admin: ctx.accounts.allowance_manager.key(),
            new_allowance: amount,
        });

        Ok(())
    }

    /// Update oracle config (oracle_manager only)
    pub fn set_oracle(
        ctx: Context<OracleManager>,
        oracle: Pubkey,
        staleness_threshold: i64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.oracle = oracle;
        config.staleness_threshold = staleness_threshold;

        emit!(OracleUpdatedEvent {
            admin: ctx.accounts.oracle_manager.key(),
            oracle,
            staleness_threshold,
        });

        Ok(())
    }

    /// Freeze an OkuUSD token account (compliance/blacklist)
    /// Uses Token-2022 freeze authority CPI
    /// MUST work even when PSM is paused (no pause check)
    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        let bump = ctx.accounts.config.bump;
        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        // CPI to Token-2022 to freeze the account
        token_interface::freeze_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::FreezeAccount {
                    account: ctx.accounts.target_okusd_ata.to_account_info(),
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
        )?;

        emit!(FreezeEvent {
            account: ctx.accounts.target_okusd_ata.key(),
            target_owner: ctx.accounts.target_okusd_ata.owner,
        });

        Ok(())
    }

    /// Thaw a frozen OkuUSD token account
    /// Uses Token-2022 thaw authority CPI
    /// MUST work even when PSM is paused (no pause check)
    pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
        let bump = ctx.accounts.config.bump;
        let seeds = &[PsmConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        // CPI to Token-2022 to thaw the account
        token_interface::thaw_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::ThawAccount {
                    account: ctx.accounts.target_okusd_ata.to_account_info(),
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
        )?;

        emit!(ThawEvent {
            account: ctx.accounts.target_okusd_ata.key(),
            target_owner: ctx.accounts.target_okusd_ata.owner,
        });

        Ok(())
    }

    /// Update the interest rate on the OkuUSD mint (Token-2022 Interest Bearing extension)
    /// This reflects new accrued yield from T-Bill backing
    /// Rate is in basis points (e.g., 450 = 4.5% APY)
    /// Also stores the rate in config for queue processing interest calculations
    pub fn update_interest_rate(ctx: Context<UpdateInterestRate>, new_rate: i16) -> Result<()> {
        use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

        // Token-2022 instruction format for InterestBearingMintExtension::UpdateRate:
        // - Byte 0: TokenInstruction discriminator (33 = InterestBearingMintExtension)
        // - Byte 1: InterestBearingMintInstruction discriminator (1 = UpdateRate)
        // - Bytes 2-3: rate as i16 little-endian
        let mut data = Vec::with_capacity(4);
        data.push(33u8); // TokenInstruction::InterestBearingMintExtension
        data.push(1u8);  // InterestBearingMintInstruction::UpdateRate
        data.extend_from_slice(&new_rate.to_le_bytes());

        let ix = Instruction {
            program_id: ctx.accounts.token_2022_program.key(),
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.okusd_mint.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.rebaser.key(),
                    true,
                ),
            ],
            data,
        };

        // Invoke the Token-2022 program
        invoke(
            &ix,
            &[
                ctx.accounts.okusd_mint.to_account_info(),
                ctx.accounts.rebaser.to_account_info(),
            ],
        )?;

        // Also store the rate in config for queue processing interest calculations
        let config = &mut ctx.accounts.config;
        config.current_rate_bps = new_rate;

        emit!(InterestRateUpdatedEvent {
            rate_authority: ctx.accounts.rebaser.key(),
            new_rate,
        });

        Ok(())
    }
}

/// Pyth Price Account structure (partial - only fields we need)
/// See: https://docs.pyth.network/price-feeds/account-structure
/// Pyth price accounts have magic number 0xa1b2c3d4 at start
#[derive(Clone, Copy)]
#[repr(C)]
struct PythPriceData {
    /// Price value (may be negative for some feeds, but reserves should be positive)
    pub price: i64,
    /// Confidence interval
    pub conf: u64,
    /// Exponent (10^expo to get real price)
    pub expo: i32,
    /// Publish time (unix timestamp)
    pub publish_time: i64,
}

/// Check oracle reserves before minting
/// Returns Ok if reserves are sufficient, error otherwise
/// Manually parses Pyth price account to avoid SDK dependency conflicts
fn check_oracle_reserves<'info>(
    price_account_info: &Option<UncheckedAccount<'info>>,
    oracle_feed: Pubkey,
    staleness_threshold: i64,
    current_supply: u64,
    mint_amount: u64,
) -> Result<()> {
    // If oracle is configured, price_update account must be provided
    let price_account = price_account_info
        .as_ref()
        .ok_or(OkuError::OracleAccountMissing)?;

    // Verify the account key matches the expected oracle feed
    require!(
        price_account.key() == oracle_feed,
        OkuError::InvalidOracleResponse
    );

    let clock = Clock::get()?;
    let data = price_account.try_borrow_data()?;

    // Pyth price accounts have different structures for V1 vs V2
    // For simplicity, we parse the common price data fields
    // The price data typically starts after a header
    // Pyth V2 price account layout (simplified):
    // - Bytes 0-3: magic number
    // - Bytes 4-7: version
    // - ... other fields ...
    // - Price data at offset (varies by version)

    // For Pyth price accounts (not price update accounts), the structure is:
    // - 32 bytes: product_account pubkey
    // - 32 bytes: next_price_account pubkey
    // - 8 bytes: valid_slot
    // - 4 bytes: agg.price exponent
    // - 4 bytes: status
    // - 8 bytes: agg.price
    // - 8 bytes: agg.conf
    // - 8 bytes: ema price
    // - 8 bytes: ema conf
    // - 8 bytes: timestamp (publish_time)

    // For the purposes of Proof of Reserves, we expect a simple format
    // where price represents total USD value of reserves

    // Minimum data length check (price feed should have at least 200 bytes)
    require!(data.len() >= 200, OkuError::InvalidOracleResponse);

    // Read price at offset 208 (Pyth V2 price account agg.price offset)
    // and timestamp at offset 232
    let price_offset = 208usize;
    let timestamp_offset = 232usize;

    let price = i64::from_le_bytes(
        data[price_offset..price_offset + 8]
            .try_into()
            .map_err(|_| OkuError::InvalidOracleResponse)?
    );

    let publish_time = i64::from_le_bytes(
        data[timestamp_offset..timestamp_offset + 8]
            .try_into()
            .map_err(|_| OkuError::InvalidOracleResponse)?
    );

    // Check staleness
    let current_time = clock.unix_timestamp;
    let age = current_time.saturating_sub(publish_time);
    require!(age <= staleness_threshold, OkuError::StaleOracle);

    // Price represents total reserves (e.g., T-Bill NAV backing in base units)
    // Ensure reserves >= current_supply + mint_amount
    require!(price >= 0, OkuError::InvalidOracleResponse);

    let reserves = price as u64;
    let new_supply = current_supply
        .checked_add(mint_amount)
        .ok_or(OkuError::Overflow)?;

    require!(reserves >= new_supply, OkuError::InsufficientReserves);

    Ok(())
}

/// Calculate the interest-bearing value of a raw OkuUSD amount
/// Uses the Token-2022 Interest-Bearing extension formula:
/// ui_amount = raw_amount × e^(rate × time_elapsed)
///
/// For practical purposes, we use a linear approximation for small rates/times:
/// ui_amount ≈ raw_amount × (1 + rate_per_second × time_elapsed)
///
/// Where rate_per_second = rate_bps / 10000 / SECONDS_PER_YEAR
fn calculate_interest_bearing_value(
    raw_amount: u64,
    rate_bps: i16,
    time_elapsed_secs: i64,
) -> Result<u64> {
    // Handle edge cases
    if time_elapsed_secs <= 0 || rate_bps <= 0 {
        return Ok(raw_amount);
    }

    // Constants for calculation
    // SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60 = 31,557,600
    const SECONDS_PER_YEAR: u128 = 31_557_600;
    const BPS_PRECISION: u128 = 10_000; // basis points

    let raw = raw_amount as u128;
    let rate = rate_bps as u128;
    let time = time_elapsed_secs as u128;

    // Calculate: raw_amount × (1 + rate_bps × time_elapsed / (10000 × SECONDS_PER_YEAR))
    // To avoid overflow and maintain precision:
    // = raw_amount + (raw_amount × rate_bps × time_elapsed) / (10000 × SECONDS_PER_YEAR)

    let interest_numerator = raw
        .checked_mul(rate)
        .ok_or(OkuError::Overflow)?
        .checked_mul(time)
        .ok_or(OkuError::Overflow)?;

    let interest_denominator = BPS_PRECISION.checked_mul(SECONDS_PER_YEAR)
        .ok_or(OkuError::Overflow)?;

    let interest_amount = interest_numerator
        .checked_div(interest_denominator)
        .ok_or(OkuError::Overflow)?;

    let ui_amount = raw
        .checked_add(interest_amount)
        .ok_or(OkuError::Overflow)?;

    // Convert back to u64, capping at u64::MAX if overflow
    Ok(ui_amount.min(u64::MAX as u128) as u64)
}

// ============================================================================
// Instruction Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    // ===== Granular Authority Accounts =====
    /// CHECK: Authority pubkey for role assignment
    pub psm_pauser: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub psm_unpauser: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub blacklister: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub unblacklister: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub queue_processor: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub buffer_depositor: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub buffer_withdrawer: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub oracle_manager: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub cap_manager: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub allowance_manager: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub rebaser: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        space = PsmConfig::LEN,
        seeds = [PsmConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        init,
        payer = admin,
        space = RedemptionQueue::LEN,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    /// USDC mint (standard SPL)
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuUSD mint (Token-2022)
    /// PSM config PDA must be mint authority
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// PSM's USDC vault
    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub vault_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Accounts for setup_okusd_escrow instruction
/// Creates the OkuUSD escrow vault for queue yield alignment
#[derive(Accounts)]
pub struct SetupOkusdEscrow<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = admin @ OkuError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// PSM's OkuUSD escrow vault for queued redemptions
    /// Holds OkuUSD while users are in queue so they earn yield
    #[account(
        init,
        payer = admin,
        associated_token::mint = okusd_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintOkusd<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// User's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    /// User's OkuUSD account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc_ata
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    /// Pyth price account (optional - only required if oracle is configured)
    /// CHECK: Validated manually in check_oracle_reserves - verifies account key matches config.oracle
    pub price_update: Option<UncheckedAccount<'info>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Account<'info, RedemptionQueue>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// User's USDC account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    /// User's OkuUSD account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc_ata
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's OkuUSD escrow vault (for queued redemptions)
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessQueue<'info> {
    #[account(
        constraint = queue_processor.key() == config.queue_processor @ OkuError::Unauthorized
    )]
    pub queue_processor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Account<'info, RedemptionQueue>,

    /// OkuUSD mint (Token-2022) - needed for burn CPI
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc_ata
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's OkuUSD escrow vault - holds queued redemptions
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    // Note: Recipient USDC ATAs are passed via remaining_accounts in queue order
}

#[derive(Accounts)]
pub struct DepositBuffer<'info> {
    #[account(
        constraint = buffer_depositor.key() == config.buffer_depositor @ OkuError::Unauthorized
    )]
    pub buffer_depositor: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// Buffer depositor's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = buffer_depositor,
        associated_token::token_program = token_program,
    )]
    pub buffer_depositor_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc_ata
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawBuffer<'info> {
    #[account(
        constraint = buffer_withdrawer.key() == config.buffer_withdrawer @ OkuError::Unauthorized
    )]
    pub buffer_withdrawer: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// Buffer withdrawer's USDC account (destination)
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buffer_withdrawer,
    )]
    pub withdrawer_usdc_ata: Account<'info, TokenAccount>,

    /// PSM's USDC vault (source)
    #[account(
        mut,
        address = config.vault_usdc_ata
    )]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BridgeMint<'info> {
    // TODO: Replace with per-adapter MINTER roles with individual allowances
    // See CLAUDE.md: "Bridge Adapters: MINTER (each adapter individually)"
    // For now using queue_processor as temporary bridge authority
    #[account(
        constraint = bridge_minter.key() == config.queue_processor @ OkuError::Unauthorized
    )]
    pub bridge_minter: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// Recipient's OkuUSD account
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub recipient_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct BridgeBurn<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// User's OkuUSD account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.psm_pauser @ OkuError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.psm_unpauser @ OkuError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = admin.key() == config.admin @ OkuError::Unauthorized
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct CapManager<'info> {
    #[account(
        constraint = cap_manager.key() == config.cap_manager @ OkuError::Unauthorized
    )]
    pub cap_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct AllowanceManager<'info> {
    #[account(
        constraint = allowance_manager.key() == config.allowance_manager @ OkuError::Unauthorized
    )]
    pub allowance_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct OracleManager<'info> {
    #[account(
        constraint = oracle_manager.key() == config.oracle_manager @ OkuError::Unauthorized
    )]
    pub oracle_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// Blacklister authority - can freeze even when PSM is paused
    #[account(
        constraint = blacklister.key() == config.blacklister @ OkuError::Unauthorized
    )]
    pub blacklister: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// Target account to freeze
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub target_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct ThawAccount<'info> {
    /// Unblacklister authority - can thaw even when PSM is paused (requires deliberate review)
    #[account(
        constraint = unblacklister.key() == config.unblacklister @ OkuError::Unauthorized
    )]
    pub unblacklister: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// Target account to thaw
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub target_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct UpdateInterestRate<'info> {
    /// Rate authority - must be the designated rate authority on the mint
    /// Rebaser role (typically orchestrator KMS-backed signer)
    #[account(
        constraint = rebaser.key() == config.rebaser @ OkuError::Unauthorized
    )]
    pub rebaser: Signer<'info>,

    /// PSM config - stores current_rate_bps for queue processing
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022 with Interest Bearing extension)
    /// CHECK: Validated by Token-2022 program - must have rebaser as the rate authority
    #[account(mut)]
    pub okusd_mint: UncheckedAccount<'info>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct InitializeEvent {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub okusd_mint: Pubkey,
    pub max_supply: u64,
}

#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
    pub okusd_amount: u64,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub usdc_amount: u64,
}

#[event]
pub struct RedemptionQueuedEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub queue_position: u32,
}

#[event]
pub struct RedemptionProcessedEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
}

#[event]
pub struct BufferDepositEvent {
    pub orchestrator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BufferWithdrawEvent {
    pub admin: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BridgeMintEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub source_chain: u16,
}

#[event]
pub struct BridgeBurnEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub destination_chain: u16,
}

#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
    pub paused: bool,
}

#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

#[event]
pub struct MaxSupplyUpdatedEvent {
    pub admin: Pubkey,
    pub new_max_supply: u64,
}

#[event]
pub struct MinterAllowanceUpdatedEvent {
    pub admin: Pubkey,
    pub new_allowance: u64,
}

#[event]
pub struct OracleUpdatedEvent {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub staleness_threshold: i64,
}

#[event]
pub struct InterestRateUpdatedEvent {
    pub rate_authority: Pubkey,
    /// New interest rate in basis points (e.g., 450 = 4.5% APY)
    pub new_rate: i16,
}

#[event]
pub struct FreezeEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}

#[event]
pub struct ThawEvent {
    pub account: Pubkey,
    pub target_owner: Pubkey,
}
