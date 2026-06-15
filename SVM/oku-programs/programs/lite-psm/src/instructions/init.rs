use crate::constants::PRECISION;
use crate::contexts::{Initialize, SetupOkuMoneyEscrow, SetupRedemptionQueue};
use crate::errors::LitePsmError;
use crate::events::InitializeEvent;
use oku_shared::{ORACLE_USDC_PRICE_CEILING, ORACLE_USDC_PRICE_FLOOR};
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintRaw;

/// Initialize the PSM - Step 1
/// Creates config PDA and USDC vault.
/// Call `setup_redemption_queue` and `setup_oku_money_escrow` afterwards to complete initialization.
/// Authority pubkeys passed as args to reduce stack usage (avoids BPF stack overflow).
///
/// `oracle_relay_pyth_program_owner` is the program-owner pubkey accepted
/// by the on-chain peg-check parser. The deployer chooses this per-cluster
/// (legacy Pyth on mainnet/devnet, or any future Pyth deployment). The
/// oracle relay is otherwise left disabled at init — the operator calls
/// `set_oracle_relay_feed` and `set_oracle_relay_staleness` post-deploy to
/// wire the USDC/USD feed in. Rotate post-deploy via
/// `set_oracle_relay_pyth_program_owner`.
// F-13: 15 arguments is intentional — each maps to an independent on-chain
// authority role. Grouping into a struct would change the Anchor IDL wire
// format and break all existing callers. Suppressed.
#[allow(clippy::too_many_arguments)]
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
    oracle_relay_pyth_program_owner: Pubkey,
) -> Result<()> {
    require!(
        oracle_relay_pyth_program_owner != Pubkey::default(),
        LitePsmError::InvalidPythProgramOwner
    );

    // Phase 10: enforce the no-TransferHook invariant on the OkuMoney mint.
    //
    // The PSM's effects-checks-interactions ordering and `check_yield_lock`
    // sandwich guard both assume Token-2022 transfers/burns do NOT re-enter
    // the PSM. The `TransferHook` extension would invalidate that assumption
    // because the hook program runs mid-transfer with access to the caller's
    // accounts. Refusing it at init makes the operational discipline
    // codified into the program, removing the entire class of "deployment
    // mistakenly attached a hook" risk.
    //
    // The `mint::token_program = token_2022_program` constraint already
    // guarantees the account is a well-formed Token-2022 mint, so any
    // unpack/`get_extension_types` failure here can only be a corrupt mint
    // (which we treat as a hard reject via the same error code).
    {
        let mint_account_info = ctx.accounts.oku_money_mint.to_account_info();
        let mint_data = mint_account_info.try_borrow_data()?;
        let unpacked = StateWithExtensions::<MintRaw>::unpack(&mint_data)
            .map_err(|_| error!(LitePsmError::TransferHookNotAllowed))?;
        let extensions = unpacked
            .get_extension_types()
            .map_err(|_| error!(LitePsmError::TransferHookNotAllowed))?;
        require!(
            !extensions
                .iter()
                .any(|e| matches!(e, ExtensionType::TransferHook)),
            LitePsmError::TransferHookNotAllowed
        );
    }

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
    config.oku_money_mint = ctx.accounts.oku_money_mint.key();
    config.vault_usdc = ctx.accounts.vault_usdc.key();
    config.vault_oku_money = Pubkey::default(); // Set in setup_oku_money_escrow

    // Set limits
    config.max_supply = max_supply;
    config.minter_allowance = minter_allowance;
    config.is_paused = false;

    // Oracle relay (USDC peg circuit-breaker): disabled until the operator
    // wires the feed via `set_oracle_relay_feed`. The Pyth program-owner
    // pubkey is fixed here so the relay parser can validate feed ownership
    // the moment a feed is wired. Default the band to the protocol-wide
    // hard floor/ceiling — operators are expected to narrow this via
    // `set_oracle_relay_band` to ±3% (`[0.97e9, 1.03e9]`) before going
    // live. Same default-permissive posture EVM ships with.
    config.oracle_relay_feed = Pubkey::default();
    config.oracle_relay_pyth_program_owner = oracle_relay_pyth_program_owner;
    config.oracle_relay_staleness = 0; // 0 = relay disabled until set
    config.oracle_relay_min_price_e9 = ORACLE_USDC_PRICE_FLOOR;
    config.oracle_relay_max_price_e9 = ORACLE_USDC_PRICE_CEILING;

    // Yield distribution lock - starts at 0 (no lock)
    config.last_yield_distribution_slot = 0;

    // OkuMoney price - starts at PRECISION (1e9 = $1.00)
    config.oku_m_price = PRECISION;

    // Two-step `role_admin` transfer slot — empty until
    // `set_authority(RoleAdmin, ...)` proposes a rotation.
    config.pending_role_admin = Pubkey::default();

    emit!(InitializeEvent {
        role_admin: config.role_admin,
        usdc_mint: config.usdc_mint,
        oku_money_mint: config.oku_money_mint,
        max_supply,
    });

    Ok(())
}

/// Initialize the PSM - Step 2
/// Creates redemption queue PDA (zero-copy ring buffer, ~9.4 KB / 9 640 bytes).
///
/// Uses `load_init()` because Anchor's `init` constraint allocates and
/// zero-fills the account data; `load_init()` is the zero-copy companion
/// that validates the discriminator wasn't set yet and returns a mutable
/// `RefMut` over the freshly-zeroed bytes. The 200-entry array
/// (Phase 13b cap, capped by Solana's 10 KB single-CPI allocation budget)
/// is already zeroed; we only need to set the header.
///
/// Must be called after `initialize()`.
pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()> {
    let mut queue = ctx.accounts.redemption_queue.load_init()?;
    queue.bump = ctx.bumps.redemption_queue;
    queue.head = 0;
    queue.tail = 0;
    queue.total_queued_oku_m = 0;
    // entries array was already zero-filled by Anchor's `init` allocation.

    Ok(())
}

/// Initialize the PSM - Step 3
/// Creates OkuMoney escrow vault for queued redemptions
/// Must be called after initialize()
pub fn setup_oku_money_escrow(ctx: Context<SetupOkuMoneyEscrow>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Ensure escrow hasn't already been set
    require!(
        config.vault_oku_money == Pubkey::default(),
        LitePsmError::EscrowAlreadyInitialized
    );

    config.vault_oku_money = ctx.accounts.vault_oku_money.key();

    Ok(())
}
