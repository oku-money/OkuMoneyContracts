//! # OkuM Lite-PSM
//!
//! SVM port of the EVM `LitePSM`; see SVM/README.md, "EVM vs SVM — divergence
//! catalogue", for deliberate differences. Cross-chain transfers are an
//! off-chain orchestrator holding the operational roles; there is no on-chain
//! bridge program.

#![forbid(unsafe_code)]
// Every CPI target is a typed `Program<'info, T>` (checked against `T::id()`),
// so `arbitrary_cpi` is a false positive here.
#![allow(unknown_lints, clippy::arbitrary_cpi)]
// Anchor's `#[program]` glue trips this inside macro-generated code.
#![allow(clippy::diverging_sub_expression)]
// `target_os = "solana"` comes from the entrypoint's panic handler.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod contexts;
pub mod errors;
pub mod events;
pub mod helpers;
pub mod instructions;
pub mod roles;
pub mod state;

use contexts::*;
use roles::*;

declare_id!("4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "OkuMoney Lite-PSM",
    project_url: "https://github.com/anomalyco/okuMoney",
    contacts: "uri:https://github.com/anomalyco/okuMoney/security/advisories/new",
    policy: "https://github.com/anomalyco/okuMoney/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/anomalyco/okuMoney"
}

#[program]
pub mod lite_psm {
    use super::*;

    /// One-time setup, callable only by the program's upgrade authority. Creates
    /// the config PDA, the USDC vault and the OkuM Token-2022 mint.
    pub fn initialize(
        ctx: Context<Initialize>,
        params: instructions::init::InitializeParams,
    ) -> Result<()> {
        instructions::init::initialize(ctx, params)
    }

    /// Mint OkuM for USDC at the canonical multiplier:
    /// `raw_oku_m = usdc_amount * PRECISION / multiplier`, rounded down.
    pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
        instructions::psm::mint_oku_m(ctx, usdc_amount)
    }

    /// Mint OkuM without USDC (`direct_minter` only; fiat on-ramp). Consumes the
    /// direct-minter allowance and respects the supply cap.
    pub fn mint_oku_m_direct(ctx: Context<MintOkuMDirect>, raw_amount: u64) -> Result<()> {
        instructions::direct_mint::mint_oku_m_direct(ctx, raw_amount)
    }

    /// Burn the caller's OkuM without a USDC payout (`direct_burner` only; the
    /// SVM->EVM bridge leg). Consumes the direct-burner allowance.
    pub fn burn_oku_m_direct(ctx: Context<BurnOkuMDirect>, raw_amount: u64) -> Result<()> {
        instructions::direct_burn::burn_oku_m_direct(ctx, raw_amount)
    }

    /// Redeem OkuM for USDC from the buffer:
    /// `usdc_amount = raw_oku_m_amount * multiplier / PRECISION`, rounded down.
    /// Reverts with `SlippageExceeded` below `min_usdc_out` (`0` disables).
    pub fn redeem_oku_m(
        ctx: Context<RedeemOkuM>,
        raw_oku_m_amount: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        instructions::psm::redeem_oku_m(ctx, raw_oku_m_amount, min_usdc_out)
    }

    /// Add USDC to the redemption buffer (`buffer_depositor` only). Blocked while
    /// paused and in the slot of a multiplier override.
    pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
        instructions::psm::deposit_buffer(ctx, amount)
    }

    /// Remove USDC from the buffer (`buffer_withdrawer` only). Blocked while
    /// paused and in the slot of a multiplier override.
    pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
        instructions::psm::withdraw_buffer(ctx, amount)
    }

    /// Pause mint, redeem, direct mint/burn and buffer moves (`pauser` only).
    /// Freeze/thaw and rate decreases stay available.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::psm_admin::pause(ctx)
    }

    /// Resume operation (`unpauser` only).
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::psm_admin::unpause(ctx)
    }

    /// Set the supply cap in raw OkuM units (`cap_manager` only). Cannot be set
    /// below current supply.
    pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()> {
        instructions::psm_admin::set_max_supply(ctx, new_max_supply)
    }

    /// Reset the `mint_oku_m` allowance in raw OkuM units (`allowance_manager` only).
    pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        instructions::psm_admin::set_minter_allowance(ctx, amount)
    }

    /// Reset the `mint_oku_m_direct` allowance in raw OkuM units
    /// (`allowance_manager` only).
    pub fn set_direct_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        instructions::psm_admin::set_direct_minter_allowance(ctx, amount)
    }

    /// Reset the `burn_oku_m_direct` allowance in raw OkuM units
    /// (`allowance_manager` only).
    pub fn set_direct_burner_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()> {
        instructions::psm_admin::set_direct_burner_allowance(ctx, amount)
    }

    /// Freeze an OkuM token account (`freezer` only). Works while paused.
    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::psm_admin::freeze_account(ctx)
    }

    /// Thaw an OkuM token account (`unfreezer` only). Works while paused.
    pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
        instructions::psm_admin::thaw_account(ctx)
    }

    /// Replace the authority for `role` (`role_admin` only). For `RoleAdmin` this
    /// only proposes the new admin; it takes effect on `accept_role_admin`.
    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: AuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::psm_admin::set_authority(ctx, role, new_authority)
    }

    /// Complete a `RoleAdmin` rotation; signed by the proposed admin.
    pub fn accept_role_admin(ctx: Context<AcceptRoleAdmin>) -> Result<()> {
        instructions::psm_admin::accept_role_admin(ctx)
    }

    /// Withdraw a pending `RoleAdmin` proposal (`role_admin` only).
    pub fn cancel_role_admin_transfer(ctx: Context<SetAuthority>) -> Result<()> {
        instructions::psm_admin::cancel_role_admin_transfer(ctx)
    }

    /// Reset the mint's Token-2022 name/symbol to the canonical OkuM identity
    /// (`role_admin` only). The "usdOku" dollar view is the display multiplier
    /// and is unaffected.
    pub fn update_token_metadata(ctx: Context<UpdateTokenMetadata>) -> Result<()> {
        instructions::psm_admin::update_token_metadata(ctx)
    }

    /// Set the active per-second rate and its window (`rebaser` only). Re-anchors
    /// the base multiplier and clears any staged successor. `end_timestamp` must
    /// be `0` for a halt (`PRECISION`) and in the future otherwise.
    pub fn set_okum_yield_rate(
        ctx: Context<SetYieldRate>,
        new_rate: u64,
        end_timestamp: i64,
    ) -> Result<()> {
        instructions::yield_ops::set_okum_yield_rate(ctx, new_rate, end_timestamp)
    }

    /// Stage the successor rate that takes over at the current `okum_rate_end`
    /// with no transaction at the boundary (`rebaser` only).
    pub fn set_next_okum_yield_rate(
        ctx: Context<SetYieldRate>,
        new_rate: u64,
        pending_end_timestamp: i64,
    ) -> Result<()> {
        instructions::yield_ops::set_next_okum_yield_rate(ctx, new_rate, pending_end_timestamp)
    }

    /// Set the active rate and stage its successor atomically (`rebaser` only);
    /// the epoch orchestrator's instruction.
    pub fn set_okum_yield_rate_with_successor(
        ctx: Context<SetYieldRate>,
        new_rate: u64,
        end_timestamp: i64,
        next_rate: u64,
        next_end_timestamp: i64,
    ) -> Result<()> {
        instructions::yield_ops::set_okum_yield_rate_with_successor(
            ctx,
            new_rate,
            end_timestamp,
            next_rate,
            next_end_timestamp,
        )
    }

    /// EMERGENCY (`rebaser` only): force the multiplier (WAD-scaled) to a strictly
    /// higher value and halt accrual. The only instruction that engages the
    /// same-slot yield lock.
    pub fn set_okum_multiplier(
        ctx: Context<SetOkuMMultiplier>,
        new_multiplier: u128,
    ) -> Result<()> {
        instructions::yield_ops::set_okum_multiplier(ctx, new_multiplier)
    }

    /// Refresh the wallet-facing `ScaledUiAmount` mirror to the current canonical
    /// multiplier. Permissionless: the value is fully determined on-chain.
    pub fn sync_display_multiplier(ctx: Context<SyncDisplayMultiplier>) -> Result<()> {
        instructions::yield_ops::sync_display_multiplier(ctx)
    }
}
