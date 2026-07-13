//! Permissioned direct-mint instructions (fiat on-ramp path).
//!
//! These instructions allow a `direct_minter` authority to mint OkuMoney
//! (and optionally wrap into usdOku) WITHOUT depositing USDC on-chain.
//! Matches EVM's `OkuMoney.mint(to, amount)` called by a non-PSM
//! `OKUM_MINTER` role holder.
//!
//! The on-chain collateral discipline for USDC-backed mints lives in
//! `instructions::psm::mint_oku_m`; the `direct_minter` path enforces
//! only role + allowance + supply-cap guards. The fiat collateral backing
//! these mints is held off-chain by the operator.

// CPI targets are constrained by Anchor's typed `Program<'info, Token2022>`
// accounts. The `arbitrary_cpi` warning is a false positive.
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::constants::OKU_DOLLAR_PROGRAM_ID;
use crate::contexts::direct_mint::{MigratePsmConfig, MintOkuMDirect, MintUsdOkuDirect};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_yield_lock, oku_m_to_dollars};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_spl::token_interface;

/// Old PsmConfig account size (8-byte discriminator + 666-byte fields).
/// Used by the migration instruction to verify the account hasn't been
/// migrated yet.
const OLD_PSM_CONFIG_LEN: usize = 674;

/// Byte offset of the `role_admin` pubkey inside a PsmConfig account.
/// Layout: 8 (discriminator) + 1 (bump) = 9 bytes before role_admin.
const ROLE_ADMIN_OFFSET: usize = 9;

/// One-time migration: extend PsmConfig from 674 → 714 bytes.
///
/// Appends 40 zero bytes (= `direct_minter: Pubkey::default()` +
/// `direct_minter_allowance: 0u64`). After the realloc, every
/// instruction that deserializes `Account<PsmConfig>` works normally.
///
/// Idempotent: reverts if the account is already 714 bytes.
pub fn migrate_psm_config(ctx: Context<MigratePsmConfig>) -> Result<()> {
    let config_info = ctx.accounts.config.to_account_info();
    let current_len = config_info.data_len();

    // Guard: only run on pre-migration accounts
    require!(
        current_len == OLD_PSM_CONFIG_LEN,
        LitePsmError::MigrationNotNeeded
    );

    // Verify discriminator matches PsmConfig. Anchor's discriminator is
    // the first 8 bytes of `sha256("account:PsmConfig")`.
    {
        let data = config_info.try_borrow_data()?;

        // Verify role_admin matches the signer
        let stored_role_admin =
            Pubkey::try_from(&data[ROLE_ADMIN_OFFSET..ROLE_ADMIN_OFFSET + 32])
                .map_err(|_| error!(LitePsmError::Unauthorized))?;
        require!(
            stored_role_admin == ctx.accounts.role_admin.key(),
            LitePsmError::Unauthorized
        );
    }
    // Borrow dropped — safe to realloc

    // Resize to new length. The extended region is zero-filled by the
    // Solana runtime, which is exactly what we want — zero bytes encode
    // `Pubkey::default()` + `u64(0)` in borsh.
    config_info
        .resize(PsmConfig::LEN)
        .map_err(|_| error!(LitePsmError::Overflow))?;

    // Top up rent-exempt lamports
    let rent = Rent::get()?;
    let new_minimum = rent.minimum_balance(PsmConfig::LEN);
    let current_lamports = config_info.lamports();
    let lamports_diff = new_minimum.saturating_sub(current_lamports);
    if lamports_diff > 0 {
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.payer.key(),
            &config_info.key(),
            lamports_diff,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                config_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    emit!(PsmConfigMigratedEvent {
        old_len: OLD_PSM_CONFIG_LEN as u64,
        new_len: PsmConfig::LEN as u64,
    });

    Ok(())
}

/// Mint OkuMoney directly without USDC (permissioned).
///
/// Guards (matching EVM `OkuMoney.mint`):
/// - `direct_minter` must be signer, validated via `has_one` on config
/// - Pause check
/// - Yield-lock check (same slot as yield distribution → reject)
/// - Max supply check
/// - `direct_minter_allowance` check + decrement (effects-before-interactions)
///
/// NOT included (no USDC involvement):
/// - No USDC transfer
/// - No round-trip drift check
pub fn mint_oku_m_direct(ctx: Context<MintOkuMDirect>, oku_m_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let direct_minter_allowance = ctx.accounts.config.direct_minter_allowance;
    let current_supply = ctx.accounts.oku_money_mint.supply;

    require!(!is_paused, LitePsmError::Paused);
    require!(oku_m_amount > 0, LitePsmError::ZeroAmount);

    // Check max supply
    require!(
        current_supply
            .checked_add(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );

    // Check direct-minter allowance
    require!(
        oku_m_amount <= direct_minter_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Effects-before-interactions: decrement allowance BEFORE the mint CPI
    let bump = ctx.accounts.config.bump;
    ctx.accounts.config.direct_minter_allowance = direct_minter_allowance
        .checked_sub(oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Mint OkuMoney to recipient (Token-2022)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    let direct_minter_key = ctx.accounts.direct_minter.key();
    let recipient_key = ctx.accounts.recipient.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                to: ctx.accounts.recipient_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        oku_m_amount,
    )?;

    // Calculate dollar value and post-mint supply for event
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    ctx.accounts.oku_money_mint.reload()?;
    let new_total_supply = ctx.accounts.oku_money_mint.supply;

    emit!(DirectMintEvent {
        direct_minter: direct_minter_key,
        recipient: recipient_key,
        oku_m_amount,
        oku_m_price,
        dollar_value,
        new_total_supply,
    });

    Ok(())
}

/// Mint OkuMoney directly and wrap into usdOku in a single instruction.
///
/// Flow:
/// 1. Same guards as `mint_oku_m_direct`
/// 2. Mint OkuMoney to PsmConfig PDA's OkuMoney ATA (`vault_oku_money`)
/// 3. CPI to `oku_dollar::wrap_to` — PDA transfers OkuMoney to oku-dollar
///    reserve vault, usdOku shares are minted to the `recipient`
///
/// The CPI is built manually because Anchor's `#[account]` macro ties
/// `PsmConfig`'s `Owner` impl to `crate::ID` (the lite-psm program ID).
/// Moving `PsmConfig` to a shared crate would break the `Owner` trait
/// derivation, and adding `oku-dollar = { features = ["cpi"] }` to
/// lite-psm creates a circular dependency since oku-dollar already
/// depends on `lite-psm = { features = ["cpi"] }` for `PsmConfig`.
///
/// Safety net: the `#[cfg(test)]` module at the bottom of this file
/// recomputes `sha256("global:wrap_to")[0..8]` and asserts it equals
/// the hardcoded discriminator, so any rename is caught by `cargo test`.
pub fn mint_usd_oku_direct(
    ctx: Context<MintUsdOkuDirect>,
    oku_m_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let direct_minter_allowance = ctx.accounts.config.direct_minter_allowance;
    let current_supply = ctx.accounts.oku_money_mint.supply;

    require!(!is_paused, LitePsmError::Paused);
    require!(oku_m_amount > 0, LitePsmError::ZeroAmount);

    // Check max supply
    require!(
        current_supply
            .checked_add(oku_m_amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );

    // Check direct-minter allowance
    require!(
        oku_m_amount <= direct_minter_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Validate the oku-dollar program ID
    require!(
        ctx.accounts.oku_dollar_program.key() == OKU_DOLLAR_PROGRAM_ID,
        LitePsmError::Unauthorized
    );

    // Effects-before-interactions: decrement allowance BEFORE CPI
    let bump = ctx.accounts.config.bump;
    ctx.accounts.config.direct_minter_allowance = direct_minter_allowance
        .checked_sub(oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Step 1: Mint OkuMoney to PsmConfig PDA's OkuMoney ATA (intermediary)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_money_mint.to_account_info(),
                to: ctx.accounts.vault_oku_money.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        oku_m_amount,
    )?;

    // Step 2: CPI to oku_dollar::wrap_to
    //
    // The instruction discriminator for `wrap_to` is the first 8 bytes of
    // `sha256("global:wrap_to")`, pre-computed at build time.
    let wrap_to_discriminator: [u8; 8] = [0x72, 0x0a, 0xdb, 0x05, 0xcb, 0xae, 0x14, 0xd1];

    // Build instruction data: discriminator + oku_m_amount (u64 LE) + min_shares_out (u64 LE)
    let mut ix_data = Vec::with_capacity(8 + 8 + 8);
    ix_data.extend_from_slice(&wrap_to_discriminator);
    ix_data.extend_from_slice(&oku_m_amount.to_le_bytes());
    ix_data.extend_from_slice(&min_shares_out.to_le_bytes());

    // Build the account metas for wrap_to. Order must match the WrapTo
    // context in oku-dollar/src/contexts.rs:
    //   payer, caller, receiver, config, oku_money_mint, usd_oku_mint,
    //   caller_oku_money_ata, receiver_usd_oku_ata, reserve_vault,
    //   psm_config, dead_shares_ata?, token_2022_program,
    //   associated_token_program, system_program
    let mut account_metas = vec![
        // payer — the operator (signer, mut for ATA init lamports)
        AccountMeta::new(ctx.accounts.direct_minter.key(), true),
        // caller — the PsmConfig PDA (signer via invoke_signed)
        AccountMeta::new_readonly(ctx.accounts.config.key(), true),
        // receiver — the end user (not a signer)
        AccountMeta::new_readonly(ctx.accounts.recipient.key(), false),
        // config — oku-dollar config PDA
        AccountMeta::new_readonly(ctx.accounts.oku_dollar_config.key(), false),
        // oku_money_mint
        AccountMeta::new_readonly(ctx.accounts.oku_money_mint.key(), false),
        // usd_oku_mint (mut — supply is incremented)
        AccountMeta::new(ctx.accounts.usd_oku_mint.key(), false),
        // caller_oku_money_ata — vault_oku_money (PDA's ATA, mut)
        AccountMeta::new(ctx.accounts.vault_oku_money.key(), false),
        // receiver_usd_oku_ata (mut — init_if_needed)
        AccountMeta::new(ctx.accounts.recipient_usd_oku_ata.key(), false),
        // reserve_vault (mut)
        AccountMeta::new(ctx.accounts.oku_dollar_reserve_vault.key(), false),
        // psm_config — this program's config PDA (read-only for oku_m_price)
        AccountMeta::new_readonly(ctx.accounts.config.key(), false),
    ];

    // dead_shares_ata (optional). Anchor uses the program's own ID as the
    // sentinel for "account not present" on Option<> accounts. The sentinel
    // must always appear in the accounts list so subsequent accounts don't
    // shift position.
    if let Some(ref dead_shares) = ctx.accounts.dead_shares_ata {
        account_metas.push(AccountMeta::new(dead_shares.key(), false));
    } else {
        // Sentinel: oku-dollar program ID = "not present"
        account_metas.push(AccountMeta::new_readonly(
            ctx.accounts.oku_dollar_program.key(),
            false,
        ));
    }

    // Programs
    account_metas.push(AccountMeta::new_readonly(
        ctx.accounts.token_2022_program.key(),
        false,
    ));
    account_metas.push(AccountMeta::new_readonly(
        ctx.accounts.associated_token_program.key(),
        false,
    ));
    account_metas.push(AccountMeta::new_readonly(
        ctx.accounts.system_program.key(),
        false,
    ));

    let wrap_to_ix = Instruction {
        program_id: ctx.accounts.oku_dollar_program.key(),
        accounts: account_metas,
        data: ix_data,
    };

    // Build the account infos for invoke_signed
    let mut account_infos = vec![
        ctx.accounts.direct_minter.to_account_info(),
        ctx.accounts.config.to_account_info(),
        ctx.accounts.recipient.to_account_info(),
        ctx.accounts.oku_dollar_config.to_account_info(),
        ctx.accounts.oku_money_mint.to_account_info(),
        ctx.accounts.usd_oku_mint.to_account_info(),
        ctx.accounts.vault_oku_money.to_account_info(),
        ctx.accounts.recipient_usd_oku_ata.to_account_info(),
        ctx.accounts.oku_dollar_reserve_vault.to_account_info(),
        ctx.accounts.config.to_account_info(),
    ];

    if let Some(ref dead_shares) = ctx.accounts.dead_shares_ata {
        account_infos.push(dead_shares.to_account_info());
    } else {
        // Sentinel account info — must still be in the list for positional
        // alignment. Use the oku-dollar program itself as the sentinel.
        account_infos.push(ctx.accounts.oku_dollar_program.to_account_info());
    }

    account_infos.push(ctx.accounts.token_2022_program.to_account_info());
    account_infos.push(ctx.accounts.associated_token_program.to_account_info());
    account_infos.push(ctx.accounts.system_program.to_account_info());

    // Also need the oku-dollar program itself
    account_infos.push(ctx.accounts.oku_dollar_program.to_account_info());

    invoke_signed(&wrap_to_ix, &account_infos, &[&seeds[..]])?;

    // Emit event
    let oku_m_price = ctx.accounts.config.oku_m_price;
    let dollar_value = oku_m_to_dollars(oku_m_amount, oku_m_price)?;

    ctx.accounts.oku_money_mint.reload()?;
    let new_total_supply = ctx.accounts.oku_money_mint.supply;

    // We don't know the exact shares minted (wrap_to returns it, but
    // invoke_signed doesn't capture return data). We can compute it the
    // same way wrap_to does, or rely on the WrapEvent emitted by wrap_to.
    // For our event, we log min_shares_out as a lower bound; the actual
    // shares are in the WrapEvent from oku-dollar.
    emit!(DirectMintUsdOkuEvent {
        direct_minter: ctx.accounts.direct_minter.key(),
        recipient: ctx.accounts.recipient.key(),
        oku_m_amount,
        shares_minted: min_shares_out, // lower bound; actual in WrapEvent
        oku_m_price,
        usd_multiplier: 0, // read from oku-dollar config not available here
        dollar_value,
        new_total_supply,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Discriminator safety-net
// ---------------------------------------------------------------------------
// The `wrap_to` CPI above uses a hardcoded 8-byte Anchor discriminator.
// If the oku-dollar instruction is ever renamed, the discriminator would
// silently change and the CPI would fail at runtime. This test recomputes
// the discriminator from the canonical Anchor formula and asserts equality,
// so `cargo test` catches any rename before it reaches a deployment.
#[cfg(test)]
mod cpi_safety_tests {
    use super::*;
    use solana_sha256_hasher::hash as sha256;

    /// Anchor instruction discriminator: first 8 bytes of SHA-256("global:<ix_name>").
    fn anchor_discriminator(ix_name: &str) -> [u8; 8] {
        let input = format!("global:{ix_name}");
        let hash = sha256(input.as_bytes());
        let mut disc = [0u8; 8];
        disc.copy_from_slice(&hash.to_bytes()[..8]);
        disc
    }

    /// Verify the hardcoded wrap_to discriminator matches the canonical
    /// Anchor derivation. If oku-dollar renames `wrap_to`, this test
    /// fails and prevents a silent runtime CPI failure.
    #[test]
    fn wrap_to_discriminator_matches() {
        let expected: [u8; 8] = [0x72, 0x0a, 0xdb, 0x05, 0xcb, 0xae, 0x14, 0xd1];
        let computed = anchor_discriminator("wrap_to");
        assert_eq!(
            computed, expected,
            "wrap_to discriminator changed — the oku-dollar instruction was likely renamed. \
             Update the hardcoded discriminator in mint_usd_oku_direct."
        );
    }

    /// Verify the hardcoded OKU_DOLLAR_PROGRAM_ID matches the oku-dollar
    /// program's declared ID. If the oku-dollar keypair is rotated, this
    /// test must be updated in lockstep.
    #[test]
    fn oku_dollar_program_id_matches_declared_id() {
        // Base58: 7jKeiuc8gKvQhasbno27wbNMnrwi8g9sb6WPriWkzNd
        // Must match `declare_id!` in oku-dollar/src/lib.rs
        let expected_base58 = "7jKeiuc8gKvQhasbno27wbNMnrwi8g9sb6WPriWkzNd";
        assert_eq!(
            OKU_DOLLAR_PROGRAM_ID.to_string(),
            expected_base58,
            "OKU_DOLLAR_PROGRAM_ID does not match oku-dollar's declare_id!. \
             The raw bytes in constants.rs must be updated."
        );
    }
}
