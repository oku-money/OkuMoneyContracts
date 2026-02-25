use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface},
};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;

pub mod errors;
pub mod state;

use errors::OkuError;
use state::{BridgeConfig, BridgeNonce, BridgeRequest, ProcessedRequest, PsmConfig, QueueEntry, RedemptionQueue};

declare_id!("AhKZ4TT5W4mnvR3CsX1t9ymQmZx4535AN9SsrThu6C1T");

#[program]
pub mod lite_psm {
    use super::*;

    /// Initialize the PSM - Step 1
    /// Creates config PDA and USDC vault
    /// Call setup_redemption_queue and setup_okusd_escrow afterwards to complete initialization
    /// Authority pubkeys passed as args to reduce stack usage (avoids BPF stack overflow)
    pub fn initialize(
        ctx: Context<Initialize>,
        max_supply: u64,
        minter_allowance: u64,
        pauser: Pubkey,
        unpauser: Pubkey,
        freezer: Pubkey,
        unfreezer: Pubkey,
        queue_processor: Pubkey,
        buffer_depositor: Pubkey,
        buffer_withdrawer: Pubkey,
        oracle_manager: Pubkey,
        cap_manager: Pubkey,
        allowance_manager: Pubkey,
        rebaser: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;

        // Set all granular authorities (passed as args to avoid stack overflow)
        config.role_admin = ctx.accounts.role_admin.key();
        config.pauser = pauser;
        config.unpauser = unpauser;
        config.freezer = freezer;
        config.unfreezer = unfreezer;
        config.queue_processor = queue_processor;
        config.buffer_depositor = buffer_depositor;
        config.buffer_withdrawer = buffer_withdrawer;
        config.oracle_manager = oracle_manager;
        config.cap_manager = cap_manager;
        config.allowance_manager = allowance_manager;
        config.rebaser = rebaser;

        // Set token references
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.okusd_mint = ctx.accounts.okusd_mint.key();
        config.vault_usdc = ctx.accounts.vault_usdc.key();
        config.vault_okusd = Pubkey::default(); // Set in setup_okusd_escrow

        // Set limits
        config.max_supply = max_supply;
        config.minter_allowance = minter_allowance;
        config.is_paused = false;

        // Set oracle config
        config.oracle = Pubkey::default(); // Oracle disabled initially
        config.staleness_threshold = 0;
        config.current_rate_bps = 0; // Interest rate starts at 0, updated by rebaser

        emit!(InitializeEvent {
            role_admin: config.role_admin,
            usdc_mint: config.usdc_mint,
            okusd_mint: config.okusd_mint,
            max_supply,
        });

        Ok(())
    }

    /// Initialize the PSM - Step 2
    /// Creates redemption queue PDA
    /// Must be called after initialize()
    pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()> {
        let queue = &mut ctx.accounts.redemption_queue;
        queue.bump = ctx.bumps.redemption_queue;
        queue.head = 0;
        queue.tail = 0;
        // entries array is automatically zero-initialized by Anchor

        Ok(())
    }

    /// Initialize the PSM - Step 2
    /// Creates OkuUSD escrow vault for queue yield alignment
    /// Must be called after initialize()
    pub fn setup_okusd_escrow(ctx: Context<SetupOkusdEscrow>) -> Result<()> {
        let config = &mut ctx.accounts.config;

        // Ensure escrow hasn't already been set
        require!(
            config.vault_okusd == Pubkey::default(),
            OkuError::Unauthorized
        );

        config.vault_okusd = ctx.accounts.vault_okusd.key();

        Ok(())
    }

    /// Mint OkuUSD with USDC (1:1)
    /// If oracle is configured, checks reserves before minting
    pub fn mint(ctx: Context<MintOkusd>, usdc_amount: u64) -> Result<()> {
        // Read state first
        let is_paused = ctx.accounts.config.is_paused;
        let max_supply = ctx.accounts.config.max_supply;
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
    pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
        require!(amount > 0, OkuError::ZeroAmount);

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

    /// Bridge mint (from cross-chain) - SECURE VERSION with Ed25519 signature verification
    /// Verifies orchestrator signature over bridge request data
    /// Prevents replay attacks via request_id tracking
    pub fn bridge_mint(
        ctx: Context<BridgeMint>,
        message_bytes: Vec<u8>,    // Raw serialized BridgeRequest (80 bytes)
        signature: Vec<u8>,         // Ed25519 signature (64 bytes)
        request_id: [u8; 32],      // keccak256(message_bytes) — used for PDA derivation
    ) -> Result<()> {
        // 1. Validate lengths
        require!(message_bytes.len() == 80, OkuError::InvalidMessageLength);
        require!(signature.len() == 64, OkuError::InvalidSignature);

        // Read state
        let bridge_config = &ctx.accounts.bridge_config;
        let is_bridge_paused = bridge_config.is_paused;
        let is_psm_paused = ctx.accounts.config.is_paused;
        let max_supply = ctx.accounts.config.max_supply;
        let minter_allowance = ctx.accounts.config.minter_allowance;
        let config_bump = ctx.accounts.config.bump;
        let current_supply = ctx.accounts.okusd_mint.supply;

        // 2. Check bridge and PSM not paused
        require!(!is_bridge_paused, OkuError::BridgePaused);
        require!(!is_psm_paused, OkuError::Paused);

        // 3. Convert signature Vec to fixed array for verification
        let signature_array: [u8; 64] = signature.as_slice()
            .try_into()
            .map_err(|_| OkuError::InvalidSignature)?;

        // 4. Verify Ed25519 signature over raw bytes (BEFORE parsing)
        verify_ed25519_signature(
            &ctx.accounts.instruction_sysvar,
            &bridge_config.orchestrator_signer.to_bytes(),
            &message_bytes,
            &signature_array,
        )?;

        // 5. Parse message AFTER signature verified
        let request = BridgeRequest::try_from_slice(&message_bytes)?;

        // 6. Validate deadline
        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= request.deadline, OkuError::SignatureExpired);

        // 7. Validate amount
        require!(request.amount > 0, OkuError::ZeroAmount);
        require!(
            request.amount >= bridge_config.min_bridge_amount,
            OkuError::BelowMinimum
        );
        require!(
            request.amount <= bridge_config.max_bridge_amount,
            OkuError::AboveMaximum
        );

        // 8. Convert recipient bytes to Pubkey
        let recipient_pubkey = Pubkey::new_from_array(request.recipient);

        // 9. Validate recipient matches passed account (SECURITY FIX)
        require!(
            recipient_pubkey == ctx.accounts.recipient_okusd_ata.key(),
            OkuError::InvalidRecipient
        );

        // 10. Verify request_id matches keccak256(message_bytes)
        let computed_request_id = anchor_lang::solana_program::keccak::hash(&message_bytes).to_bytes();
        require!(request_id == computed_request_id, OkuError::InvalidRequestId);

        // 11. Verify request not already processed (replay prevention)
        // The init constraint on processed_request will fail if request_id already exists

        // 12. Check PSM allowance and max supply
        require!(request.amount <= minter_allowance, OkuError::AllowanceExceeded);
        require!(
            current_supply.checked_add(request.amount).ok_or(OkuError::Overflow)? <= max_supply,
            OkuError::MaxSupplyExceeded
        );

        // 12. Mint OkuUSD to recipient
        let seeds = &[PsmConfig::SEED, &[config_bump]];
        let signer = &[&seeds[..]];

        // 13. Mint tokens to recipient
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
            request.amount,
        )?;

        // 14. Decrement minter allowance
        let config = &mut ctx.accounts.config;
        config.minter_allowance = minter_allowance
            .checked_sub(request.amount)
            .ok_or(OkuError::Overflow)?;

        // 15. Create ProcessedRequest PDA
        let processed_request = &mut ctx.accounts.processed_request;
        processed_request.bump = ctx.bumps.processed_request;
        processed_request.request_id = request_id;
        processed_request.processed_at = clock.unix_timestamp;
        processed_request.recipient = ctx.accounts.recipient_okusd_ata.key();
        processed_request.amount = request.amount;

        // 16. Emit event
        emit!(BridgeMintEvent {
            request_id,
            source_chain_id: request.source_chain_id,
            recipient: ctx.accounts.recipient_okusd_ata.key(),
            amount: request.amount,
            nonce: request.nonce,
        });

        Ok(())
    }

    /// Bridge burn (to cross-chain) - SECURE VERSION with fee collection and nonce tracking
    /// Burns user tokens, collects bridge fee, tracks sequential nonce, emits full metadata
    pub fn bridge_burn(
        ctx: Context<BridgeBurn>,
        amount: u64,              // Total amount to deduct from user (fee deducted from this)
        recipient: [u8; 20],      // EVM address on destination chain
        destination_chain_id: u16,
    ) -> Result<()> {
        let bridge_config = &ctx.accounts.bridge_config;
        let is_bridge_paused = bridge_config.is_paused;
        let is_psm_paused = ctx.accounts.config.is_paused;
        let config_bump = ctx.accounts.config.bump;

        // 1. Check bridge and PSM not paused
        require!(!is_bridge_paused, OkuError::BridgePaused);
        require!(!is_psm_paused, OkuError::Paused);
        require!(amount > 0, OkuError::ZeroAmount);

        // 2. Verify destination chain is supported
        require!(
            bridge_config.is_chain_supported(destination_chain_id),
            OkuError::UnsupportedChain
        );

        // 3. Validate amount within limits
        require!(
            amount >= bridge_config.min_bridge_amount,
            OkuError::BelowMinimum
        );
        require!(
            amount <= bridge_config.max_bridge_amount,
            OkuError::AboveMaximum
        );

        // 4. Calculate fee
        let fee_amount = (amount as u128)
            .checked_mul(bridge_config.bridge_fee_bps as u128)
            .ok_or(OkuError::Overflow)?
            .checked_div(10000)
            .ok_or(OkuError::Overflow)? as u64;

        let net_amount = amount.checked_sub(fee_amount).ok_or(OkuError::Overflow)?;
        require!(net_amount > 0, OkuError::ZeroAmount);

        // 5. Burn exact amount from user (fee deducted from bridged value)
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

        // 6. Mint fee to fee_recipient (if fee > 0)
        if fee_amount > 0 {
            let seeds = &[PsmConfig::SEED, &[config_bump]];
            let signer = &[&seeds[..]];

            token_interface::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_2022_program.to_account_info(),
                    token_interface::MintTo {
                        mint: ctx.accounts.okusd_mint.to_account_info(),
                        to: ctx.accounts.fee_recipient_ata.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                fee_amount,
            )?;
        }

        // 7. Initialize BridgeNonce if needed and get/increment nonce
        let bridge_nonce = &mut ctx.accounts.bridge_nonce;

        // Initialize if this is a new nonce account
        if bridge_nonce.destination_chain == 0 {
            bridge_nonce.bump = ctx.bumps.bridge_nonce;
            bridge_nonce.destination_chain = destination_chain_id;
            bridge_nonce.next_nonce = 0;
        }

        let nonce = bridge_nonce.next_nonce;
        bridge_nonce.next_nonce = nonce.checked_add(1).ok_or(OkuError::Overflow)?;

        // 8. Calculate request_id for orchestrator tracking
        let clock = Clock::get()?;
        let deadline = clock.unix_timestamp.checked_add(3600).ok_or(OkuError::Overflow)?; // 1 hour deadline

        let source_chain_id = ctx.accounts.bridge_config.source_chain_id;

        let sender_bytes = ctx.accounts.user.key().to_bytes();
        let mut message = Vec::with_capacity(2 + 2 + 32 + 20 + 8 + 8 + 8);
        message.extend_from_slice(&source_chain_id.to_le_bytes());
        message.extend_from_slice(&destination_chain_id.to_le_bytes());
        message.extend_from_slice(&sender_bytes);
        message.extend_from_slice(&recipient);
        message.extend_from_slice(&net_amount.to_le_bytes());
        message.extend_from_slice(&nonce.to_le_bytes());
        message.extend_from_slice(&deadline.to_le_bytes());

        let request_id = anchor_lang::solana_program::keccak::hash(&message).to_bytes();

        // 9. Emit event with full metadata
        emit!(BridgeBurnEvent {
            request_id,
            user: ctx.accounts.user.key(),
            recipient,
            source_chain_id,
            destination_chain: destination_chain_id,
            amount: net_amount,
            nonce,
            deadline,
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
            role_admin: ctx.accounts.cap_manager.key(),
            new_max_supply,
        });

        Ok(())
    }

    /// Reset minter allowance (allowance_manager only)
    pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.minter_allowance = amount;

        emit!(MinterAllowanceUpdatedEvent {
            role_admin: ctx.accounts.allowance_manager.key(),
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
            role_admin: ctx.accounts.oracle_manager.key(),
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

    // ============================================================================
    // Bridge Configuration & Admin Functions
    // ============================================================================

    /// Initialize the bridge configuration
    /// Sets up all bridge authorities and default configuration
    pub fn initialize_bridge(ctx: Context<InitializeBridge>, source_chain_id: u16) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.bump = ctx.bumps.bridge_config;

        // Set all bridge authorities
        config.bridge_admin = ctx.accounts.bridge_admin.key();
        config.bridge_pauser = ctx.accounts.bridge_pauser.key();
        config.bridge_unpauser = ctx.accounts.bridge_unpauser.key();
        config.orchestrator_signer = ctx.accounts.orchestrator_signer.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.chain_manager = ctx.accounts.chain_manager.key();
        config.fee_manager = ctx.accounts.fee_manager.key();
        config.nonce_admin = ctx.accounts.nonce_admin.key();

        // Set default configuration
        config.bridge_fee_bps = 10; // 0.1% default fee
        config.min_bridge_amount = 1_000_000; // 1 token (assuming 6 decimals)
        config.max_bridge_amount = 1_000_000_000_000; // 1,000,000 tokens
        config.is_paused = false;

        // Set source chain identity
        config.source_chain_id = source_chain_id;

        // Initialize empty chain whitelist
        config.supported_chains = [0u16; 32];
        config.supported_chains_count = 0;

        emit!(BridgeInitializedEvent {
            bridge_admin: config.bridge_admin,
            orchestrator_signer: config.orchestrator_signer,
            fee_bps: config.bridge_fee_bps,
        });

        Ok(())
    }

    /// Add a supported destination chain
    pub fn add_supported_chain(
        ctx: Context<BridgeChainManager>,
        chain_id: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.add_chain(chain_id)?;

        emit!(ChainAddedEvent { chain_id });

        Ok(())
    }

    /// Remove a supported destination chain
    pub fn remove_supported_chain(
        ctx: Context<BridgeChainManager>,
        chain_id: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.remove_chain(chain_id)?;

        emit!(ChainRemovedEvent { chain_id });

        Ok(())
    }

    /// Update bridge fee (in basis points, max 10000 = 100%)
    pub fn update_bridge_fee(ctx: Context<BridgeFeeManager>, new_fee_bps: u16) -> Result<()> {
        require!(new_fee_bps <= 10000, OkuError::Overflow);

        let config = &mut ctx.accounts.bridge_config;
        config.bridge_fee_bps = new_fee_bps;

        emit!(BridgeFeeUpdatedEvent { new_fee_bps });

        Ok(())
    }

    /// Update fee recipient address
    pub fn update_fee_recipient(
        ctx: Context<BridgeAdmin>,
        new_recipient: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.fee_recipient = new_recipient;

        emit!(FeeRecipientUpdatedEvent { new_recipient });

        Ok(())
    }

    /// Update bridge amount limits
    pub fn update_bridge_limits(
        ctx: Context<BridgeAdmin>,
        min_amount: u64,
        max_amount: u64,
    ) -> Result<()> {
        require!(min_amount <= max_amount, OkuError::BelowMinimum);

        let config = &mut ctx.accounts.bridge_config;
        config.min_bridge_amount = min_amount;
        config.max_bridge_amount = max_amount;

        emit!(BridgeLimitsUpdatedEvent {
            min_amount,
            max_amount,
        });

        Ok(())
    }

    /// Pause bridge operations (emergency)
    pub fn pause_bridge(ctx: Context<BridgePause>) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.is_paused = true;

        emit!(BridgePauseEvent {
            pauser: ctx.accounts.bridge_pauser.key(),
            paused: true,
        });

        Ok(())
    }

    /// Unpause bridge operations
    pub fn unpause_bridge(ctx: Context<BridgeUnpause>) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.is_paused = false;

        emit!(BridgeUnpauseEvent {
            unpauser: ctx.accounts.bridge_unpauser.key(),
        });

        Ok(())
    }

    /// Skip nonce for a destination chain (emergency recovery)
    pub fn skip_nonce(
        ctx: Context<BridgeNonceAdmin>,
        destination_chain_id: u16,
        new_nonce: u64,
    ) -> Result<()> {
        let bridge_nonce = &mut ctx.accounts.bridge_nonce;

        // Initialize if needed
        if bridge_nonce.destination_chain == 0 {
            bridge_nonce.bump = ctx.bumps.bridge_nonce;
            bridge_nonce.destination_chain = destination_chain_id;
        }

        let old_nonce = bridge_nonce.next_nonce;
        bridge_nonce.next_nonce = new_nonce;

        emit!(NonceSkippedEvent {
            destination_chain_id,
            old_nonce,
            new_nonce,
        });

        Ok(())
    }

    /// Update orchestrator signer public key
    pub fn update_orchestrator_signer(
        ctx: Context<BridgeAdmin>,
        new_signer: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.bridge_config;
        config.orchestrator_signer = new_signer;

        emit!(OrchestratorSignerUpdatedEvent { new_signer });

        Ok(())
    }

    /// Update a specific authority role
    /// Only role_admin can call this function
    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: AuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let old_authority = match role {
            AuthorityRole::RoleAdmin => {
                let old = config.role_admin;
                config.role_admin = new_authority;
                old
            }
            AuthorityRole::Pauser => {
                let old = config.pauser;
                config.pauser = new_authority;
                old
            }
            AuthorityRole::Unpauser => {
                let old = config.unpauser;
                config.unpauser = new_authority;
                old
            }
            AuthorityRole::Freezer => {
                let old = config.freezer;
                config.freezer = new_authority;
                old
            }
            AuthorityRole::Unfreezer => {
                let old = config.unfreezer;
                config.unfreezer = new_authority;
                old
            }
            AuthorityRole::QueueProcessor => {
                let old = config.queue_processor;
                config.queue_processor = new_authority;
                old
            }
            AuthorityRole::BufferDepositor => {
                let old = config.buffer_depositor;
                config.buffer_depositor = new_authority;
                old
            }
            AuthorityRole::BufferWithdrawer => {
                let old = config.buffer_withdrawer;
                config.buffer_withdrawer = new_authority;
                old
            }
            AuthorityRole::OracleManager => {
                let old = config.oracle_manager;
                config.oracle_manager = new_authority;
                old
            }
            AuthorityRole::CapManager => {
                let old = config.cap_manager;
                config.cap_manager = new_authority;
                old
            }
            AuthorityRole::AllowanceManager => {
                let old = config.allowance_manager;
                config.allowance_manager = new_authority;
                old
            }
            AuthorityRole::Rebaser => {
                let old = config.rebaser;
                config.rebaser = new_authority;
                old
            }
        };

        emit!(AuthorityUpdatedEvent {
            role,
            old_authority,
            new_authority,
        });

        Ok(())
    }
}

/// Authority roles that can be updated via set_authority
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityRole {
    RoleAdmin,
    Pauser,
    Unpauser,
    Freezer,
    Unfreezer,
    QueueProcessor,
    BufferDepositor,
    BufferWithdrawer,
    OracleManager,
    CapManager,
    AllowanceManager,
    Rebaser,
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

/// Verify Ed25519 signature via instruction introspection
/// Solana's Ed25519Program must be called in the same transaction with signature data
/// This function verifies that signature check was performed correctly
/// Verify Ed25519 signature via instruction introspection
/// Production pattern: Don't parse - construct expected instruction and compare
fn verify_ed25519_signature<'info>(
    instructions_sysvar: &AccountInfo<'info>,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    use anchor_lang::solana_program::{
        ed25519_program,
        sysvar::instructions::load_instruction_at_checked,
    };

    // 1. Load what was actually passed (index 0 = first ix in tx)
    let actual_ix = load_instruction_at_checked(0, instructions_sysvar)
        .map_err(|_| OkuError::InvalidSignature)?;

    // 2. Verify program ID matches Ed25519Program
    require!(
        actual_ix.program_id == ed25519_program::ID,
        OkuError::InvalidSignature
    );

    // 3. Build expected instruction data manually
    let expected_data = build_ed25519_instruction_data(
        expected_pubkey,
        expected_message,
        signature,
    );

    // 4. Byte-for-byte comparison
    // If orchestrator signed different message or used different key, bytes won't match
    require!(
        actual_ix.data == expected_data,
        OkuError::InvalidSignature
    );

    Ok(())
}

/// Build Ed25519 instruction data that matches TypeScript's Ed25519Program.createInstructionWithPublicKey
fn build_ed25519_instruction_data(
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Vec<u8> {
    // Ed25519 instruction format (single signature, all data inline):
    // Header: 16 bytes, then PUBLIC KEY FIRST (32), signature (64), message (variable)
    // This matches TypeScript's Ed25519Program.createInstructionWithPublicKey

    let pubkey_offset: u16 = 16;
    let signature_offset: u16 = 16 + 32;
    let message_offset: u16 = 16 + 32 + 64;
    let message_size: u16 = message.len() as u16;

    let mut data = Vec::with_capacity(112 + message.len());

    // Header
    data.push(1);                                           // num_signatures
    data.push(0);                                           // padding
    data.extend_from_slice(&signature_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes());       // sig in this ix
    data.extend_from_slice(&pubkey_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes());       // pubkey in this ix
    data.extend_from_slice(&message_offset.to_le_bytes());
    data.extend_from_slice(&message_size.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes());       // message in this ix

    // Payload: pubkey FIRST, then signature, then message
    data.extend_from_slice(pubkey);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);

    data
}

// ============================================================================
// Instruction Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = PsmConfig::LEN,
        seeds = [PsmConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint (standard SPL)
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuUSD mint (Token-2022)
    /// PSM config PDA must be mint authority
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's USDC vault
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetupRedemptionQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// PSM config must exist (initialize was called)
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        init,
        payer = payer,
        space = RedemptionQueue::LEN,
        seeds = [RedemptionQueue::SEED],
        bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    pub system_program: Program<'info, System>,
}

/// Accounts for setup_okusd_escrow instruction
/// Creates the OkuUSD escrow vault for queue yield alignment
#[derive(Accounts)]
pub struct SetupOkusdEscrow<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = role_admin @ OkuError::Unauthorized
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's OkuUSD escrow vault for queued redemptions
    /// Holds OkuUSD while users are in queue so they earn yield
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = okusd_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
    pub config: Box<Account<'info, PsmConfig>>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuUSD account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

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
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    /// USDC mint
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's USDC account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// User's OkuUSD account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// PSM's OkuUSD escrow vault (for queued redemptions)
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
    pub config: Box<Account<'info, PsmConfig>>,

    #[account(
        mut,
        seeds = [RedemptionQueue::SEED],
        bump = redemption_queue.bump
    )]
    pub redemption_queue: Box<Account<'info, RedemptionQueue>>,

    /// OkuUSD mint (Token-2022) - needed for burn CPI
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM's USDC vault
    #[account(
        mut,
        address = config.vault_usdc
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// PSM's OkuUSD escrow vault - holds queued redemptions
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = config,
        token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
    pub config: Box<Account<'info, PsmConfig>>,

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
        address = config.vault_usdc
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

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
    pub config: Box<Account<'info, PsmConfig>>,

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
        address = config.vault_usdc
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(message_bytes: Vec<u8>, signature: Vec<u8>, request_id: [u8; 32])]
pub struct BridgeMint<'info> {
    /// Payer for ProcessedRequest PDA creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Bridge configuration
    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    /// PSM configuration
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// ProcessedRequest PDA (prevents replay attacks)
    /// Seeds are derived from keccak256(message_bytes), passed as request_id
    #[account(
        init,
        payer = payer,
        space = ProcessedRequest::LEN,
        seeds = [
            ProcessedRequest::SEED,
            &request_id
        ],
        bump
    )]
    pub processed_request: Account<'info, ProcessedRequest>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Recipient's OkuUSD account (will validate owner in function body)
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub recipient_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Instruction sysvar for Ed25519 signature verification
    /// CHECK: Verified in verify_ed25519_signature function
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: AccountInfo<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, recipient: [u8; 20], destination_chain_id: u16)]
pub struct BridgeBurn<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Bridge configuration
    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Box<Account<'info, BridgeConfig>>,

    /// PSM configuration
    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// Bridge nonce tracker for destination chain
    #[account(
        init_if_needed,
        payer = user,
        space = BridgeNonce::LEN,
        seeds = [BridgeNonce::SEED, &destination_chain_id.to_le_bytes()],
        bump
    )]
    pub bridge_nonce: Account<'info, BridgeNonce>,

    /// OkuUSD mint (Token-2022)
    #[account(
        mut,
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuUSD account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Fee recipient's OkuUSD account
    #[account(
        mut,
        token::mint = okusd_mint,
        token::authority = bridge_config.fee_recipient,
        token::token_program = token_2022_program,
    )]
    pub fee_recipient_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut)]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = pauser @ OkuError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(mut)]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = unpauser @ OkuError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = role_admin.key() == config.role_admin @ OkuError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct CapManager<'info> {
    #[account(mut)]
    pub cap_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = cap_manager @ OkuError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct AllowanceManager<'info> {
    #[account(mut)]
    pub allowance_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = allowance_manager @ OkuError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct OracleManager<'info> {
    #[account(mut)]
    pub oracle_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = oracle_manager @ OkuError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// Blacklister authority - can freeze even when PSM is paused
    #[account(
        constraint = freezer.key() == config.freezer @ OkuError::Unauthorized
    )]
    pub freezer: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Target account to freeze
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub target_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct ThawAccount<'info> {
    /// Unblacklister authority - can thaw even when PSM is paused (requires deliberate review)
    #[account(
        constraint = unfreezer.key() == config.unfreezer @ OkuError::Unauthorized
    )]
    pub unfreezer: Signer<'info>,

    #[account(
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, PsmConfig>>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Target account to thaw
    #[account(
        mut,
        token::mint = okusd_mint,
        token::token_program = token_2022_program,
    )]
    pub target_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// Role admin - only role_admin can update authorities
    #[account(
        constraint = role_admin.key() == config.role_admin @ OkuError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    /// PSM config
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,
}

// ============================================================================
// Bridge Instruction Accounts
// ============================================================================

#[derive(Accounts)]
pub struct InitializeBridge<'info> {
    #[account(mut)]
    pub bridge_admin: Signer<'info>,

    /// CHECK: Authority pubkey for role assignment
    pub bridge_pauser: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub bridge_unpauser: UncheckedAccount<'info>,
    /// CHECK: Ed25519 public key for orchestrator signature verification
    pub orchestrator_signer: UncheckedAccount<'info>,
    /// CHECK: Fee recipient pubkey
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: Chain manager pubkey
    pub chain_manager: UncheckedAccount<'info>,
    /// CHECK: Fee manager pubkey
    pub fee_manager: UncheckedAccount<'info>,
    /// CHECK: Nonce admin pubkey
    pub nonce_admin: UncheckedAccount<'info>,

    #[account(
        init,
        payer = bridge_admin,
        space = BridgeConfig::LEN,
        seeds = [BridgeConfig::SEED],
        bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BridgeChainManager<'info> {
    #[account(
        constraint = chain_manager.key() == bridge_config.chain_manager @ OkuError::Unauthorized
    )]
    pub chain_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeFeeManager<'info> {
    #[account(
        constraint = fee_manager.key() == bridge_config.fee_manager @ OkuError::Unauthorized
    )]
    pub fee_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeAdmin<'info> {
    #[account(
        constraint = bridge_admin.key() == bridge_config.bridge_admin @ OkuError::Unauthorized
    )]
    pub bridge_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgePause<'info> {
    #[account(
        constraint = bridge_pauser.key() == bridge_config.bridge_pauser @ OkuError::Unauthorized
    )]
    pub bridge_pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeUnpause<'info> {
    #[account(
        constraint = bridge_unpauser.key() == bridge_config.bridge_unpauser @ OkuError::Unauthorized
    )]
    pub bridge_unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
#[instruction(destination_chain_id: u16)]
pub struct BridgeNonceAdmin<'info> {
    #[account(mut)]
    pub nonce_admin: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        constraint = nonce_admin.key() == bridge_config.nonce_admin @ OkuError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init_if_needed,
        payer = nonce_admin,
        space = BridgeNonce::LEN,
        seeds = [BridgeNonce::SEED, &destination_chain_id.to_le_bytes()],
        bump
    )]
    pub bridge_nonce: Account<'info, BridgeNonce>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
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
    pub role_admin: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BridgeMintEvent {
    pub request_id: [u8; 32],
    pub source_chain_id: u16,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

#[event]
pub struct BridgeBurnEvent {
    pub request_id: [u8; 32],
    pub user: Pubkey,
    pub recipient: [u8; 20],       // EVM address
    pub source_chain_id: u16,       // Solana chain ID
    pub destination_chain: u16,
    pub amount: u64,                // Excluding fee
    pub nonce: u64,
    pub deadline: i64,
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
    pub role_admin: Pubkey,
    pub new_max_supply: u64,
}

#[event]
pub struct MinterAllowanceUpdatedEvent {
    pub role_admin: Pubkey,
    pub new_allowance: u64,
}

#[event]
pub struct OracleUpdatedEvent {
    pub role_admin: Pubkey,
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

#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

// ============================================================================
// Bridge Events
// ============================================================================

#[event]
pub struct BridgeInitializedEvent {
    pub bridge_admin: Pubkey,
    pub orchestrator_signer: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct ChainAddedEvent {
    pub chain_id: u16,
}

#[event]
pub struct ChainRemovedEvent {
    pub chain_id: u16,
}

#[event]
pub struct BridgeFeeUpdatedEvent {
    pub new_fee_bps: u16,
}

#[event]
pub struct FeeRecipientUpdatedEvent {
    pub new_recipient: Pubkey,
}

#[event]
pub struct BridgeLimitsUpdatedEvent {
    pub min_amount: u64,
    pub max_amount: u64,
}

#[event]
pub struct BridgePauseEvent {
    pub pauser: Pubkey,
    pub paused: bool,
}

#[event]
pub struct BridgeUnpauseEvent {
    pub unpauser: Pubkey,
}

#[event]
pub struct NonceSkippedEvent {
    pub destination_chain_id: u16,
    pub old_nonce: u64,
    pub new_nonce: u64,
}

#[event]
pub struct OrchestratorSignerUpdatedEvent {
    pub new_signer: Pubkey,
}
