//! OkuDollar core instructions.

// All CPI targets in this module are constrained by Anchor's typed
// `Program<'info, Token2022>` accounts which validate program ID at
// deserialisation. The `arbitrary_cpi` warning is a false positive
// here (see `oku-programs/audit/README.md` § Accepted Risks).
#![allow(unknown_lints, clippy::arbitrary_cpi)]

use crate::constants::{
    MAX_USD_MULTIPLIER, MINIMUM_LIQUIDITY, MIN_COLLATERAL_RATIO_FLOOR, PRECISION,
};
use crate::contexts::{
    DepositReserves, Initialize, Unwrap, UpdateUsdMultiplier, WithdrawReserves, Wrap, WrapTo,
};
use crate::errors::OkuDollarError;
use crate::events::*;
use crate::helpers::{
    calculate_collateral_ratio, check_vault_yield_lock, is_sufficiently_collateralized,
    oku_money_to_shares, oku_money_to_usd, shares_to_oku_money,
};
use crate::state::OkuDollarConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use lite_psm::helpers::mint_extensions::assert_oku_money_mint_extensions_whitelisted;
use lite_psm::helpers::yield_lock::check_yield_lock;

/// Initialize the OkuDollar vault
/// Creates config PDA, usdOku mint, and reserve vault
///
/// # Arguments
/// * `pauser` - Address that can pause the vault
/// * `unpauser` - Address that can unpause the vault
/// * `usd_rebaser` - Address that can update USD multiplier (orchestrator)
/// * `reserve_manager` - Address that can deposit/withdraw reserves
/// * `min_collateral_ratio` - Minimum collateral ratio (scaled by PRECISION)
pub fn initialize(
    ctx: Context<Initialize>,
    pauser: Pubkey,
    unpauser: Pubkey,
    usd_rebaser: Pubkey,
    reserve_manager: Pubkey,
    min_collateral_ratio: u64,
) -> Result<()> {
    // Reject zero-pubkey authorities — they would silently lock the role out
    // of any future use without offering a recovery path. Mirrors the
    // analogous guards in `lite-psm::initialize`.
    require!(pauser != Pubkey::default(), OkuDollarError::ZeroAuthority);
    require!(unpauser != Pubkey::default(), OkuDollarError::ZeroAuthority);
    require!(
        usd_rebaser != Pubkey::default(),
        OkuDollarError::ZeroAuthority
    );
    require!(
        reserve_manager != Pubkey::default(),
        OkuDollarError::ZeroAuthority
    );

    // Cross-program invariant: the vault's OkuMoney mint MUST match the
    // PSM's OkuMoney mint. Without this, a deployer could initialise the
    // vault pointing at the right `psm_config` PDA but a different
    // OkuMoney mint, which would store an inconsistent reference and
    // silently break wrap/unwrap math.
    require!(
        ctx.accounts.psm_config.oku_money_mint == ctx.accounts.oku_money_mint.key(),
        OkuDollarError::OkuMoneyMintMismatch
    );

    // Cycle 4 (OKUD-02): mirror lite-psm's Token-2022 extension allow-list
    // at the vault boundary so the two programs agree on what a clean
    // OkuMoney mint looks like. lite-psm enforces this at its own init,
    // but the vault may be initialised against a separately-deployed
    // OkuMoney mint (the PSM-side check has already fired by then on the
    // same key but defense-in-depth is cheap and consistent).
    assert_oku_money_mint_extensions_whitelisted(&ctx.accounts.oku_money_mint.to_account_info())?;

    // Cycle 4 (OKUD-01): assert the OkuMoney mint uses the protocol-wide
    // decimal scheme. All vault share math assumes 6-decimal raw tokens;
    // a mismatched mint would silently invert every wrap/unwrap by an
    // order of magnitude. The PSM hard-codes the same invariant on the
    // USDC mint at its own init.
    require!(
        ctx.accounts.oku_money_mint.decimals == oku_shared::TOKEN_DECIMALS,
        OkuDollarError::InvalidOkuMoneyDecimals
    );

    // Cycle 4 (OKUD-04, defense-in-depth): assert the PSM's `oku_m_price`
    // is initialised and non-zero. Structurally lite-psm seeds this to
    // `PRECISION` at its own init.rs (so `oku_m_price > 0` already holds
    // for any real PSM PDA), but the require pins the invariant at the
    // vault boundary and gives a clear error if anyone ever wires the
    // two programs in the wrong order.
    require!(
        ctx.accounts.psm_config.oku_m_price > 0,
        OkuDollarError::InvalidPrice
    );

    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;

    // Set granular authorities
    config.role_admin = ctx.accounts.role_admin.key();
    config.pauser = pauser;
    config.unpauser = unpauser;
    config.usd_rebaser = usd_rebaser;
    config.reserve_manager = reserve_manager;

    // Set token references
    config.oku_money_mint = ctx.accounts.oku_money_mint.key();
    config.usd_oku_mint = ctx.accounts.usd_oku_mint.key();
    config.reserve_vault = ctx.accounts.reserve_vault.key();
    config.psm_config = ctx.accounts.psm_config.key();

    // Initialize USD multiplier at 1:1 (PRECISION)
    config.usd_multiplier = PRECISION;
    let clock = Clock::get()?;
    config.usd_last_update_time = clock.unix_timestamp;
    // No yield event has occurred yet. Slot 0 is the genesis slot,
    // which is never re-encountered on a live network post-genesis.
    // Cycle 4 (OKUD-28): on a `solana-test-validator` reset slot does
    // start at 0, so a `wrap`/`unwrap` landing in slot 0 immediately
    // after init will hit the sandwich-fence. Mitigation is operational
    // (advance the validator a slot before the first user action);
    // a u64::MAX sentinel was considered but rejected because it
    // would require every `check_yield_lock_*` call site to special-
    // case the sentinel, expanding the audit surface.
    config.last_yield_distribution_slot = 0;

    // Set minimum collateral ratio (must lie in [floor, PRECISION]).
    // The upper bound matches the runtime `set_min_collateral_ratio` check;
    // mirrors EVM `OkuDollar.RatioExceedsMax` guard.
    require!(
        min_collateral_ratio >= MIN_COLLATERAL_RATIO_FLOOR,
        OkuDollarError::InvalidCollateralRatio
    );
    require!(
        min_collateral_ratio <= PRECISION,
        OkuDollarError::RatioExceedsMax
    );
    config.min_collateral_ratio = min_collateral_ratio;

    config.is_paused = false;

    // Two-step `role_admin` transfer slot — empty until
    // `set_authority(RoleAdmin, ...)` proposes a rotation.
    config.pending_role_admin = Pubkey::default();

    emit!(InitializeEvent {
        role_admin: config.role_admin,
        oku_money_mint: config.oku_money_mint,
        usd_oku_mint: config.usd_oku_mint,
        reserve_vault: config.reserve_vault,
        psm_config: config.psm_config,
        usd_multiplier: config.usd_multiplier,
        min_collateral_ratio: config.min_collateral_ratio,
    });

    Ok(())
}

/// Wrap OkuMoney -> usdOku
/// Transfers OkuMoney from user to reserve vault, mints usdOku shares to user.
///
/// Shares minted = (oku_m_amount * oku_m_price) / usd_multiplier
/// Matches EVM: sharesToMint = (actualReceived * okuMPrice) / usdMultiplier
///
/// First deposit: subtracts MINIMUM_LIQUIDITY dead shares to prevent
/// inflation attacks. `dead_shares_ata` (optional account) must be provided
/// on the first deposit — it receives the permanently-locked dead shares.
pub fn wrap(ctx: Context<Wrap>, oku_m_amount: u64, min_shares_out: u64) -> Result<u64> {
    // Yield lock: block wrap in same slot as either a PSM-side yield event
    // (`set_oku_m_price` / `distribute_yield`) OR a vault-side yield event
    // (`update_usd_multiplier`). Both are read by the wrap math, so both
    // must be fenced.
    check_yield_lock(&ctx.accounts.psm_config)?;
    check_vault_yield_lock(&ctx.accounts.config)?;

    // Read state
    let total_supply = ctx.accounts.usd_oku_mint.supply;
    let bump = ctx.accounts.config.bump;
    let usd_multiplier = ctx.accounts.config.usd_multiplier;
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;
    let decimals = ctx.accounts.oku_money_mint.decimals;

    require!(oku_m_amount > 0, OkuDollarError::ZeroAmount);

    // Calculate shares to mint based on current multiplier and price
    let shares = oku_money_to_shares(oku_m_amount, usd_multiplier, oku_m_price)?;
    require!(shares > 0, OkuDollarError::ZeroAmount);

    // Transfer OkuMoney from user to reserve vault (Token-2022)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.user_oku_money_ata.to_account_info(),
                to: ctx.accounts.reserve_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.oku_money_mint.to_account_info(),
            },
        ),
        oku_m_amount,
        decimals,
    )?;

    let seeds = &[OkuDollarConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    if total_supply == 0 {
        // First deposit — enforce minimum liquidity and mint dead shares
        require!(shares > MINIMUM_LIQUIDITY, OkuDollarError::MinimumLiquidity);

        let user_shares = shares
            .checked_sub(MINIMUM_LIQUIDITY)
            .ok_or(OkuDollarError::Overflow)?;

        // Slippage protection (on user shares after dead shares subtraction)
        require!(
            user_shares >= min_shares_out,
            OkuDollarError::SlippageExceeded
        );

        let dead_ata = ctx
            .accounts
            .dead_shares_ata
            .as_ref()
            .ok_or(OkuDollarError::MissingDeadSharesAccount)?;

        // Cycle 4 (OKUD-03): mint + token-program invariants are now
        // enforced declaratively by the `token::mint = usd_oku_mint,
        // token::token_program = token_2022_program` constraints on
        // the Wrap context (see contexts.rs). The two remaining
        // properties below (SP-owner + canonical-ATA) can't be
        // expressed via Anchor attributes alone — keep them here.

        // Verify the dead ATA is owned by the System Program (truly unrecoverable)
        require!(
            dead_ata.owner == anchor_lang::system_program::ID,
            OkuDollarError::InvalidDeadSharesOwner
        );

        // Verify the dead ATA is the canonical Associated Token Account derived
        // from (System-Program owner, usdOku mint, Token-2022 program). Without
        // this check a first depositor could split the dead supply across
        // multiple SP-owned accounts, complicating audit trails.
        let expected_dead_ata =
            anchor_spl::associated_token::get_associated_token_address_with_program_id(
                &anchor_lang::system_program::ID,
                &ctx.accounts.usd_oku_mint.key(),
                &ctx.accounts.token_2022_program.key(),
            );
        require!(
            dead_ata.key() == expected_dead_ata,
            OkuDollarError::InvalidDeadSharesAddress
        );

        // Mint user shares (Token-2022)
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.usd_oku_mint.to_account_info(),
                    to: ctx.accounts.user_usd_oku_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            user_shares,
        )?;

        // Mint dead shares (permanently locked)
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.usd_oku_mint.to_account_info(),
                    to: dead_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            MINIMUM_LIQUIDITY,
        )?;

        // Calculate dollar value
        let dollar_value = oku_money_to_usd(oku_m_amount, oku_m_price)?;

        emit!(WrapEvent {
            user: ctx.accounts.user.key(),
            receiver: ctx.accounts.user.key(),
            oku_m_amount,
            shares_minted: user_shares,
            dead_shares_minted: MINIMUM_LIQUIDITY,
            usd_multiplier,
            oku_m_price,
            dollar_value,
        });

        Ok(user_shares)
    } else {
        // Cycle 4 (OKUD-09): a `dead_shares_ata` is only meaningful on
        // the first deposit. Reject it on subsequent wraps so callers
        // can't pass arbitrary unused accounts in a slot the program
        // would otherwise ignore. Tightens the API contract.
        require!(
            ctx.accounts.dead_shares_ata.is_none(),
            OkuDollarError::UnexpectedDeadSharesAccount
        );

        // Slippage protection
        require!(shares >= min_shares_out, OkuDollarError::SlippageExceeded);

        // Subsequent deposits — direct share calculation
        // Mint usdOku shares to user (Token-2022)
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.usd_oku_mint.to_account_info(),
                    to: ctx.accounts.user_usd_oku_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        // Calculate dollar value
        let dollar_value = oku_money_to_usd(oku_m_amount, oku_m_price)?;

        emit!(WrapEvent {
            user: ctx.accounts.user.key(),
            receiver: ctx.accounts.user.key(),
            oku_m_amount,
            shares_minted: shares,
            dead_shares_minted: 0,
            usd_multiplier,
            oku_m_price,
            dollar_value,
        });

        Ok(shares)
    }
}

/// Wrap OkuMoney -> usdOku with a separate receiver.
///
/// Identical math/logic to `wrap`, but the caller provides OkuMoney and a
/// separate `receiver` gets the minted usdOku shares. Matches EVM
/// `OkuDollar.wrap(amount, receiver, minAmountOut)`.
///
/// Primary use case: CPI from lite-psm's `mint_usd_oku_direct`, where the
/// PsmConfig PDA wraps OkuMoney it just minted into usdOku for a user.
pub fn wrap_to(ctx: Context<WrapTo>, oku_m_amount: u64, min_shares_out: u64) -> Result<u64> {
    // Yield lock: block wrap in same slot as either a PSM-side yield event
    // or a vault-side yield event.
    check_yield_lock(&ctx.accounts.psm_config)?;
    check_vault_yield_lock(&ctx.accounts.config)?;

    // Read state
    let total_supply = ctx.accounts.usd_oku_mint.supply;
    let bump = ctx.accounts.config.bump;
    let usd_multiplier = ctx.accounts.config.usd_multiplier;
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;
    let decimals = ctx.accounts.oku_money_mint.decimals;

    require!(oku_m_amount > 0, OkuDollarError::ZeroAmount);

    // Calculate shares to mint based on current multiplier and price
    let shares = oku_money_to_shares(oku_m_amount, usd_multiplier, oku_m_price)?;
    require!(shares > 0, OkuDollarError::ZeroAmount);

    // Transfer OkuMoney from caller to reserve vault (Token-2022)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.caller_oku_money_ata.to_account_info(),
                to: ctx.accounts.reserve_vault.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
                mint: ctx.accounts.oku_money_mint.to_account_info(),
            },
        ),
        oku_m_amount,
        decimals,
    )?;

    let seeds = &[OkuDollarConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    let caller_key = ctx.accounts.caller.key();
    let receiver_key = ctx.accounts.receiver.key();

    if total_supply == 0 {
        // First deposit — enforce minimum liquidity and mint dead shares
        require!(shares > MINIMUM_LIQUIDITY, OkuDollarError::MinimumLiquidity);

        let user_shares = shares
            .checked_sub(MINIMUM_LIQUIDITY)
            .ok_or(OkuDollarError::Overflow)?;

        // Slippage protection (on user shares after dead shares subtraction)
        require!(
            user_shares >= min_shares_out,
            OkuDollarError::SlippageExceeded
        );

        let dead_ata = ctx
            .accounts
            .dead_shares_ata
            .as_ref()
            .ok_or(OkuDollarError::MissingDeadSharesAccount)?;

        // Verify the dead ATA is owned by the System Program (truly unrecoverable)
        require!(
            dead_ata.owner == anchor_lang::system_program::ID,
            OkuDollarError::InvalidDeadSharesOwner
        );

        // Verify the dead ATA is the canonical Associated Token Account
        let expected_dead_ata =
            anchor_spl::associated_token::get_associated_token_address_with_program_id(
                &anchor_lang::system_program::ID,
                &ctx.accounts.usd_oku_mint.key(),
                &ctx.accounts.token_2022_program.key(),
            );
        require!(
            dead_ata.key() == expected_dead_ata,
            OkuDollarError::InvalidDeadSharesAddress
        );

        // Mint user shares to receiver (Token-2022)
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.usd_oku_mint.to_account_info(),
                    to: ctx.accounts.receiver_usd_oku_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            user_shares,
        )?;

        // Mint dead shares (permanently locked)
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.usd_oku_mint.to_account_info(),
                    to: dead_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            MINIMUM_LIQUIDITY,
        )?;

        let dollar_value = oku_money_to_usd(oku_m_amount, oku_m_price)?;

        emit!(WrapEvent {
            user: caller_key,
            receiver: receiver_key,
            oku_m_amount,
            shares_minted: user_shares,
            dead_shares_minted: MINIMUM_LIQUIDITY,
            usd_multiplier,
            oku_m_price,
            dollar_value,
        });

        Ok(user_shares)
    } else {
        require!(
            ctx.accounts.dead_shares_ata.is_none(),
            OkuDollarError::UnexpectedDeadSharesAccount
        );

        // Slippage protection
        require!(shares >= min_shares_out, OkuDollarError::SlippageExceeded);

        // Mint usdOku shares to receiver (Token-2022)
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.usd_oku_mint.to_account_info(),
                    to: ctx.accounts.receiver_usd_oku_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        let dollar_value = oku_money_to_usd(oku_m_amount, oku_m_price)?;

        emit!(WrapEvent {
            user: caller_key,
            receiver: receiver_key,
            oku_m_amount,
            shares_minted: shares,
            dead_shares_minted: 0,
            usd_multiplier,
            oku_m_price,
            dollar_value,
        });

        Ok(shares)
    }
}

/// Unwrap usdOku -> OkuMoney
/// Burns usdOku shares from user, transfers OkuMoney from reserve vault to user.
///
/// OkuMoney returned = (shares * usd_multiplier) / oku_m_price
///
/// Equivalent to EVM: okuMReturned = (usdAmount * PRECISION) / okuMPrice
/// (EVM takes dollar amount as input, SVM takes shares directly)
///
/// NOTE: Unwrap is blocked when paused (matches EVM behavior).
/// Users must wait for unpause to exit.
pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()> {
    // Yield lock: block unwrap in same slot as either a PSM-side yield event
    // OR a vault-side yield event. See `wrap` above for the rationale.
    check_yield_lock(&ctx.accounts.psm_config)?;
    check_vault_yield_lock(&ctx.accounts.config)?;

    // Read state
    let bump = ctx.accounts.config.bump;
    let usd_multiplier = ctx.accounts.config.usd_multiplier;
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;
    let reserve_balance = ctx.accounts.reserve_vault.amount;
    let decimals = ctx.accounts.oku_money_mint.decimals;
    let user_shares_balance = ctx.accounts.user_usd_oku_ata.amount;

    require!(shares > 0, OkuDollarError::ZeroAmount);
    // Check against user's actual balance, not total supply
    // The burn CPI would fail anyway, but this provides a clearer error message
    require!(
        shares <= user_shares_balance,
        OkuDollarError::InsufficientShares
    );

    // Calculate OkuMoney to return based on current multiplier and price
    let oku_m_out = shares_to_oku_money(shares, usd_multiplier, oku_m_price)?;
    require!(oku_m_out > 0, OkuDollarError::ZeroAmount);

    // Safety: ensure we have enough reserves
    require!(
        oku_m_out <= reserve_balance,
        OkuDollarError::InsufficientReserves
    );

    // Burn usdOku shares from user (Token-2022)
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.usd_oku_mint.to_account_info(),
                from: ctx.accounts.user_usd_oku_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Transfer OkuMoney from reserve vault to user (Token-2022)
    let seeds = &[OkuDollarConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.reserve_vault.to_account_info(),
                to: ctx.accounts.user_oku_money_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
                mint: ctx.accounts.oku_money_mint.to_account_info(),
            },
            signer,
        ),
        oku_m_out,
        decimals,
    )?;

    // Calculate dollar value
    let dollar_value = oku_money_to_usd(oku_m_out, oku_m_price)?;

    emit!(UnwrapEvent {
        user: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        shares_burned: shares,
        oku_m_amount: oku_m_out,
        usd_multiplier,
        oku_m_price,
        dollar_value,
    });

    Ok(())
}

/// Update the USD multiplier (rebasing)
/// Called by usd_rebaser (orchestrator) to distribute yield discretely.
///
/// The new multiplier must:
/// 1. Be greater than or equal to the current multiplier (yield cannot decrease)
/// 2. Maintain sufficient collateralization after the update
///
/// # Arguments
/// * `new_usd_multiplier` - New USD multiplier (scaled by PRECISION)
pub fn update_usd_multiplier(
    ctx: Context<UpdateUsdMultiplier>,
    new_usd_multiplier: u64,
) -> Result<()> {
    // Cross-program yield-lock fence (PSM side). The collateral check
    // below reads `oku_m_price` from PSM config; if the orchestrator
    // just bumped that price in the same slot (`set_oku_m_price` /
    // `distribute_yield`), running the multiplier update in that same
    // slot would let the collateral check use the freshly-updated
    // price. Refusing same-slot operation keeps the price snapshot
    // consistent across both legs and mirrors the `check_yield_lock`
    // discipline already enforced on `wrap` / `unwrap`. The
    // orchestrator should batch its PSM price update and vault
    // multiplier update across adjacent slots.
    check_yield_lock(&ctx.accounts.psm_config)?;

    // Cycle 4 (OKUD-06): self-fence on the vault's own yield slot for
    // parity with EVM `YieldSandwichGuard`. Two `update_usd_multiplier`
    // calls in the same slot would otherwise be legal (strict-increase
    // tolerates the second), defeating the "one yield event per slot
    // per program" invariant. The same fix is mirrored on the lite-psm
    // side (see `yield_ops::set_oku_m_price` / `distribute_yield`).
    check_vault_yield_lock(&ctx.accounts.config)?;

    let config = &ctx.accounts.config;
    let old_multiplier = config.usd_multiplier;
    let min_collateral_ratio = config.min_collateral_ratio;

    // Strict increase — a no-op multiplier write would stamp the
    // sandwich-lock slot without moving any economic state, wasting the
    // lock window for the entire slot. Mirrors the EVM fix landed in the
    // the symmetric lite-psm
    // `set_oku_m_price` strict-increase guard.
    require!(
        new_usd_multiplier > old_multiplier,
        OkuDollarError::MultiplierCannotDecrease
    );

    // Math-sanity ceiling — keeps the downstream `u64 * u64 -> u128`
    // multiplications inside the overflow-safe region. Not a guard
    // against a malicious operator (out of scope per the centralized
    // trust model) but a math bound. See `MAX_USD_MULTIPLIER` in
    // `oku-shared/constants.rs`.
    require!(
        new_usd_multiplier <= MAX_USD_MULTIPLIER,
        OkuDollarError::MultiplierAboveMax
    );

    // Check collateralization after the update
    let reserve_balance = ctx.accounts.reserve_vault.amount;
    let total_supply = ctx.accounts.usd_oku_mint.supply;
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;

    // Verify the vault remains sufficiently collateralized with new multiplier
    require!(
        is_sufficiently_collateralized(
            reserve_balance,
            total_supply,
            new_usd_multiplier,
            oku_m_price,
            min_collateral_ratio,
        )?,
        OkuDollarError::InsufficientCollateral
    );

    // Cycle 4 (OKUD-14): snapshot the post-update collateral ratio for
    // the event payload so monitoring tooling doesn't have to re-derive
    // it. Uses the SAME inputs as the `is_sufficiently_collateralized`
    // check above so the emitted ratio is exactly what the require
    // just validated against.
    let new_collateralization_ratio = calculate_collateral_ratio(
        reserve_balance,
        total_supply,
        new_usd_multiplier,
        oku_m_price,
    )?;

    // Update the multiplier and stamp the yield-lock slot. Subsequent wraps
    // and unwraps in the SAME slot will be rejected by `check_vault_yield_lock`.
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;
    config.usd_multiplier = new_usd_multiplier;
    config.usd_last_update_time = clock.unix_timestamp;
    config.last_yield_distribution_slot = clock.slot;

    emit!(UsdMultiplierUpdatedEvent {
        old_multiplier,
        new_multiplier: new_usd_multiplier,
        total_supply,
        collateralization_ratio: new_collateralization_ratio,
        timestamp: config.usd_last_update_time,
    });

    Ok(())
}

/// Deposit OkuMoney reserves (reserve manager).
///
/// Allows reserve manager to add OkuMoney to the vault without minting usdOku;
/// this increases the collateralization ratio. Mirrors EVM
/// `OkuDollar.depositReserves`, which is gated by `whenNotPaused`.
///
/// The pause check now lives on the `DepositReserves` context as
/// `constraint = !config.is_paused`, matching the `Wrap`/`Unwrap` pattern
/// so the guard cannot be silently bypassed by a future handler refactor.
pub fn deposit_reserves(ctx: Context<DepositReserves>, amount: u64) -> Result<()> {
    require!(amount > 0, OkuDollarError::ZeroAmount);

    let decimals = ctx.accounts.oku_money_mint.decimals;

    // Transfer OkuMoney from reserve manager to reserve vault
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.source_ata.to_account_info(),
                to: ctx.accounts.reserve_vault.to_account_info(),
                authority: ctx.accounts.reserve_manager.to_account_info(),
                mint: ctx.accounts.oku_money_mint.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;

    // Calculate dollar value and collateralization ratio after deposit
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;
    let dollar_value = oku_money_to_usd(amount, oku_m_price)?;

    // Reload reserve vault balance after transfer
    ctx.accounts.reserve_vault.reload()?;
    let new_reserve_balance = ctx.accounts.reserve_vault.amount;
    let total_supply = ctx.accounts.usd_oku_mint.supply;
    let usd_multiplier = ctx.accounts.config.usd_multiplier;

    let collateralization_ratio = calculate_collateral_ratio(
        new_reserve_balance,
        total_supply,
        usd_multiplier,
        oku_m_price,
    )?;

    emit!(ReservesDepositedEvent {
        reserve_manager: ctx.accounts.reserve_manager.key(),
        amount,
        dollar_value,
        collateralization_ratio,
    });

    Ok(())
}

/// Withdraw OkuMoney reserves (reserve manager).
///
/// Allows reserve manager to remove excess OkuMoney from the vault. Must
/// maintain minimum collateralization ratio after withdrawal. Mirrors EVM
/// `OkuDollar.withdrawSurplus`, which is gated by `whenNotPaused` AND
/// `whenYieldNotDistributing`.
///
/// The pause check lives on the `WithdrawReserves` context as
/// `constraint = !config.is_paused`, matching the `Wrap`/`Unwrap` pattern.
///
/// Yield-lock parity (EVM `withdrawSurplus`): the post-withdrawal
/// collateralization check reads `oku_m_price` from `psm_config` AND
/// `usd_multiplier` from this vault. A same-slot `set_oku_m_price` /
/// `distribute_yield` (PSM) or `update_usd_multiplier` (vault) would shift
/// the multipliers underneath that read. Even though `reserve_manager` is
/// already a permissioned role, the lock makes the invariant explicit and
/// matches the EVM defense-in-depth posture.
pub fn withdraw_reserves(ctx: Context<WithdrawReserves>, amount: u64) -> Result<()> {
    // Dual yield-lock fence (matches `wrap` / `unwrap`).
    check_yield_lock(&ctx.accounts.psm_config)?;
    check_vault_yield_lock(&ctx.accounts.config)?;

    require!(amount > 0, OkuDollarError::ZeroAmount);

    let bump = ctx.accounts.config.bump;
    let usd_multiplier = ctx.accounts.config.usd_multiplier;
    let min_collateral_ratio = ctx.accounts.config.min_collateral_ratio;
    let reserve_balance = ctx.accounts.reserve_vault.amount;
    let total_supply = ctx.accounts.usd_oku_mint.supply;
    let oku_m_price = ctx.accounts.psm_config.oku_m_price;
    let decimals = ctx.accounts.oku_money_mint.decimals;

    require!(
        amount <= reserve_balance,
        OkuDollarError::InsufficientReserves
    );

    // Calculate new reserve balance after withdrawal
    let new_reserve_balance = reserve_balance
        .checked_sub(amount)
        .ok_or(OkuDollarError::Overflow)?;

    // Verify the vault remains sufficiently collateralized
    require!(
        is_sufficiently_collateralized(
            new_reserve_balance,
            total_supply,
            usd_multiplier,
            oku_m_price,
            min_collateral_ratio,
        )?,
        OkuDollarError::InsufficientCollateral
    );

    // Transfer OkuMoney from reserve vault to reserve manager
    let seeds = &[OkuDollarConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.reserve_vault.to_account_info(),
                to: ctx.accounts.destination_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
                mint: ctx.accounts.oku_money_mint.to_account_info(),
            },
            signer,
        ),
        amount,
        decimals,
    )?;

    // Calculate dollar value
    let dollar_value = oku_money_to_usd(amount, oku_m_price)?;

    // Reload reserve vault balance and recompute the collateral ratio from
    // ground truth. Defends against a future Token-2022 transfer-hook moving
    // a fee out-of-band, which would make the pre-CPI snapshot stale.
    ctx.accounts.reserve_vault.reload()?;
    let actual_post_balance = ctx.accounts.reserve_vault.amount;
    let collateralization_ratio = calculate_collateral_ratio(
        actual_post_balance,
        total_supply,
        usd_multiplier,
        oku_m_price,
    )?;

    emit!(ReservesWithdrawnEvent {
        reserve_manager: ctx.accounts.reserve_manager.key(),
        amount,
        dollar_value,
        collateralization_ratio,
    });

    Ok(())
}
