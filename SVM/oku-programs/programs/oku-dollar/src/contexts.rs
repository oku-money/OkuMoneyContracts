use crate::errors::OkuDollarError;
use crate::state::OkuDollarConfig;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

// Import PsmConfig from lite-psm for cross-program reads
use lite_psm::state::PsmConfig;

/// Initialize the OkuDollar vault
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = OkuDollarConfig::LEN,
        seeds = [OkuDollarConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    /// Mint authority must be the config PDA
    #[account(
        init,
        payer = role_admin,
        mint::decimals = oku_money_mint.decimals,
        mint::authority = config,
        mint::token_program = token_2022_program,
        seeds = [OkuDollarConfig::USD_OKU_MINT_SEED],
        bump
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = oku_money_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price). The deserialized type pins this
    /// to lite-psm's `PsmConfig`, and the seeds constraint pins it to the canonical
    /// `psm_config` PDA — so the deployer cannot point the vault at an arbitrary account.
    #[account(
        seeds = [PsmConfig::SEED],
        bump = psm_config.bump,
        seeds::program = lite_psm::ID
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Rent sysvar is read internally by Anchor's `init` /
    // `associated_token::*` constraints since Solana v1.8; not in the
    // account list.
}

/// Wrap OkuMoney into usdOku
#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // Config is read-only in wrap (only reads bump, usd_multiplier)
    // Not marking as mut saves ~2000 CU on serialization
    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        constraint = !config.is_paused @ OkuDollarError::VaultPaused
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney token account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku token account (init_if_needed)
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    /// Dead-shares ATA — only required on the first deposit
    /// (`total_supply == 0`). This is a usdOku ATA owned by the System
    /// Program where `MINIMUM_LIQUIDITY` shares are permanently locked
    /// to defeat the first-depositor inflation attack.
    ///
    /// Cycle 4 (OKUD-03): `token::mint` + `token::token_program` moved
    /// onto the context so Anchor enforces them declaratively (visible
    /// in IDL, can't be silently bypassed by a future handler refactor).
    /// The two remaining invariants — SP-owner + canonical-ATA — still
    /// live in the handler because Anchor doesn't have a single
    /// attribute that expresses "owner = system_program AND address ==
    /// canonical ATA derivation for (mint, system_program, Token2022)".
    /// See `instructions::core::wrap` for the handler-side validation.
    #[account(
        mut,
        token::mint = usd_oku_mint,
        token::token_program = token_2022_program,
    )]
    pub dead_shares_ata: Option<Box<InterfaceAccount<'info, TokenAccountInterface>>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Wrap OkuMoney into usdOku — with a separate receiver.
///
/// Like `Wrap`, but the caller provides OkuMoney and a separate `receiver`
/// gets the minted usdOku shares. Matches EVM `OkuDollar.wrap(amount,
/// receiver, minAmountOut)` where the caller and receiver may differ.
///
/// Primary use case: CPI from lite-psm's `mint_usd_oku_direct` instruction,
/// where the PsmConfig PDA mints OkuMoney to its own ATA and then wraps it
/// into usdOku for a user in a single instruction.
#[derive(Accounts)]
pub struct WrapTo<'info> {
    /// Payer for any ATA initialisation. Typically the operator submitting
    /// the transaction. Must be a signer so Anchor can debit lamports for
    /// `init_if_needed`.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Caller who owns the OkuMoney being wrapped. May be a PDA (via CPI
    /// with `invoke_signed`). Distinct from `payer` so a PDA can be the
    /// transfer authority without needing lamports.
    /// CHECK: Validated as transfer authority on `caller_oku_money_ata`.
    pub caller: Signer<'info>,

    /// Receiver of the minted usdOku shares. Does NOT need to sign —
    /// matches EVM `wrap(amount, receiver, min)`.
    /// CHECK: Used only as the ATA authority for `receiver_usd_oku_ata`.
    pub receiver: UncheckedAccount<'info>,

    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        constraint = !config.is_paused @ OkuDollarError::VaultPaused
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Caller's OkuMoney token account (source of OkuMoney).
    /// Constrained to `caller` as authority so only the caller (or a PDA
    /// signing via CPI) can authorise the transfer.
    #[account(
        mut,
        token::mint = oku_money_mint,
        token::authority = caller,
        token::token_program = token_2022_program,
    )]
    pub caller_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Receiver's usdOku token account (destination of minted shares).
    /// `init_if_needed` so the receiver doesn't need a pre-existing ATA.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = receiver,
        associated_token::token_program = token_2022_program,
    )]
    pub receiver_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    /// Dead-shares ATA — only required on the first deposit
    /// (`total_supply == 0`). See `Wrap` context for full documentation.
    #[account(
        mut,
        token::mint = usd_oku_mint,
        token::token_program = token_2022_program,
    )]
    pub dead_shares_ata: Option<Box<InterfaceAccount<'info, TokenAccountInterface>>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Unwrap usdOku back to OkuMoney
#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // Config is read-only in unwrap (only reads bump, usd_multiplier)
    // Not marking as mut saves ~2000 CU on serialization
    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        // Note: Unwrap blocked when paused (matches EVM behavior)
        constraint = !config.is_paused @ OkuDollarError::VaultPaused
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (Token-2022)
    #[account(
        mut,
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// User's OkuMoney token account (init_if_needed)
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = oku_money_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_oku_money_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's usdOku token account
    #[account(
        mut,
        associated_token::mint = usd_oku_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_usd_oku_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Update the USD multiplier (rebasing)
///
/// NOTE: No pause check - matches EVM OkuDollar.updateUsdMultiplier()
/// Rebasing must remain available during emergencies to update the price
/// multiplier (e.g., to reflect accrued yield or respond to market conditions)
#[derive(Accounts)]
pub struct UpdateUsdMultiplier<'info> {
    #[account(
        constraint = usd_rebaser.key() == config.usd_rebaser @ OkuDollarError::Unauthorized
    )]
    pub usd_rebaser: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// Reserve vault to check collateralization
    #[account(
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// usdOku mint to check total supply
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM config account (for reading oku_m_price for collateral check)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Deposit reserves (reserve manager)
///
/// NOTE: No pause check - matches EVM OkuDollar.depositReserves()
/// Reserve deposits must remain available during emergencies to add collateral
/// (e.g., to restore solvency or respond to a crisis)
#[derive(Accounts)]
pub struct DepositReserves<'info> {
    #[account(
        constraint = reserve_manager.key() == config.reserve_manager @ OkuDollarError::Unauthorized
    )]
    pub reserve_manager: Signer<'info>,

    /// Vault config — pause check enforced at the constraint level
    /// (instead of inside the handler body) so any future refactor that
    /// reorders the handler's prelude cannot accidentally skip it. The
    /// `Wrap` / `Unwrap` contexts use the same pattern.
    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        constraint = !config.is_paused @ OkuDollarError::VaultPaused,
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// usdOku mint (for reading total supply for collateralization calculation)
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Reserve manager's OkuMoney source account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = reserve_manager,
        associated_token::token_program = token_2022_program,
    )]
    pub source_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config account (for reading oku_m_price)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Withdraw reserves (reserve manager)
///
/// Pause-gated: the handler used to do the pause check inline. We've moved
/// the check into the Anchor `constraint =` attribute so it cannot be
/// silently skipped by a future refactor. (The stale comment above
/// claiming "No pause check" referred to a pre-Phase-13 design — the
/// current behaviour matches EVM `OkuDollar.withdrawSurplus` which is
/// `whenNotPaused`.)
#[derive(Accounts)]
pub struct WithdrawReserves<'info> {
    #[account(
        constraint = reserve_manager.key() == config.reserve_manager @ OkuDollarError::Unauthorized
    )]
    pub reserve_manager: Signer<'info>,

    #[account(
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
        constraint = !config.is_paused @ OkuDollarError::VaultPaused,
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// OkuMoney mint (Token-2022)
    #[account(
        address = config.oku_money_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_money_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Reserve manager's OkuMoney destination account
    #[account(
        mut,
        associated_token::mint = oku_money_mint,
        associated_token::authority = reserve_manager,
        associated_token::token_program = token_2022_program,
    )]
    pub destination_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Vault's OkuMoney reserve account
    #[account(
        mut,
        address = config.reserve_vault
    )]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// usdOku mint to check total supply for collateral ratio
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// PSM config account (for reading oku_m_price for collateral check)
    #[account(
        address = config.psm_config
    )]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Pause the vault (pauser only)
#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.pauser @ OkuDollarError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Unpause the vault (unpauser only)
#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.unpauser @ OkuDollarError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Set authority roles (role_admin only)
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(
        constraint = role_admin.key() == config.role_admin @ OkuDollarError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Step 2 of the two-step `RoleAdmin` transfer (Ownable2Step-style).
///
/// Signed by the proposed `pending_role_admin` rather than the current
/// `role_admin`. The pending-pubkey match is asserted in the handler so we
/// can return a descriptive `NotPendingRoleAdmin` error.
#[derive(Accounts)]
pub struct AcceptRoleAdmin<'info> {
    /// Proposed new role admin — must match `config.pending_role_admin`.
    pub new_role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,
}

/// Set minimum collateral ratio (role_admin only).
///
/// Carries the live reserve / supply / PSM-price accounts so the handler
/// can assert that *the current vault still satisfies the new ratio*
/// before persisting it. Without this check, raising the floor above the
/// live ratio would silently brick `update_usd_multiplier` and
/// `withdraw_reserves` until the operator deposited additional reserves.
/// Operational expectation: if you need to raise the floor and the vault
/// is currently below the proposed value, call `deposit_reserves` first.
#[derive(Accounts)]
pub struct SetMinCollateralRatio<'info> {
    #[account(
        constraint = role_admin.key() == config.role_admin @ OkuDollarError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [OkuDollarConfig::SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, OkuDollarConfig>>,

    /// usdOku mint — read for `supply` (the obligations leg of the ratio).
    #[account(
        address = config.usd_oku_mint,
        mint::token_program = token_2022_program
    )]
    pub usd_oku_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// Vault's OkuMoney reserve account — read for `amount` (the assets
    /// leg of the ratio).
    #[account(address = config.reserve_vault)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// PSM config — read for `oku_m_price` (translates reserve OkuMoney
    /// into dollar terms for the ratio computation).
    #[account(address = config.psm_config)]
    pub psm_config: Box<Account<'info, PsmConfig>>,

    pub token_2022_program: Program<'info, Token2022>,
}
