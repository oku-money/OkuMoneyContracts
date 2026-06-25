use crate::constants::PRECISION;
use crate::contexts::{Initialize, SetupOkuMoneyEscrow, SetupRedemptionQueue};
use crate::errors::LitePsmError;
use crate::events::{EscrowInitializedEvent, InitializeEvent, QueueInitializedEvent};
use crate::helpers::mint_extensions::assert_oku_money_mint_extensions_whitelisted;
use crate::state::RedemptionQueue;
use anchor_lang::prelude::*;
use oku_shared::{ORACLE_USDC_PRICE_CEILING, ORACLE_USDC_PRICE_FLOOR};

/// Parameter bundle for [`initialize`]. Cycle 4 (PSM-17): collapses
/// the 15-argument instruction signature into a single struct so the
/// IDL slot is self-documenting and the call site is harder to
/// scramble (every field is named, not positional). Anchor borsh-
/// encodes the struct in a single byte run, so the wire format is
/// equivalent in size and shape to the prior positional args; only
/// the IDL changes (and only additively from the client's
/// perspective once the new struct is in their generated types).
///
/// All `*` pubkey fields are the granular on-chain authorities; see
/// `roles::AuthorityRole` for the role catalogue and
/// `audit/SVM/README.md` § "Trust model" for the warm-vs-cold matrix.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeParams {
    // ----- Supply / capacity -----
    pub max_supply: u64,
    pub minter_allowance: u64,
    // ----- Granular authorities -----
    pub pauser: Pubkey,
    pub unpauser: Pubkey,
    pub freezer: Pubkey,
    pub unfreezer: Pubkey,
    pub queue_processor: Pubkey,
    pub buffer_depositor: Pubkey,
    pub buffer_withdrawer: Pubkey,
    pub oracle_manager: Pubkey,
    pub cap_manager: Pubkey,
    pub allowance_manager: Pubkey,
    pub rebaser: Pubkey,
    // ----- Oracle relay -----
    /// Program-owner pubkey accepted by the on-chain peg-check parser.
    /// Deployer chooses per-cluster (legacy Pyth mainnet/devnet, or a
    /// future Pyth deployment). The relay is otherwise disabled at
    /// init — operators call `set_oracle_relay_feed` /
    /// `set_oracle_relay_staleness` post-deploy.
    pub oracle_relay_pyth_program_owner: Pubkey,
}

/// Initialize the PSM — step 1.
///
/// Creates config PDA and USDC vault. Call `setup_redemption_queue`
/// and `setup_oku_money_escrow` afterwards to complete initialization.
/// Authority pubkeys are bundled into [`InitializeParams`] to keep the
/// IDL slot self-documenting (cycle 4 / PSM-17).
pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    require!(
        params.oracle_relay_pyth_program_owner != Pubkey::default(),
        LitePsmError::InvalidPythProgramOwner
    );

    // Cycle 4 (PSM-13): enforce the Token-2022 extension allow-list on
    // the OkuMoney mint. Replaces the cycle-3 TransferHook-only check
    // with a positive allow-list (only InterestBearingConfig / metadata /
    // close-authority are tolerated). Single source of truth lives in
    // `helpers::mint_extensions` and is also called from
    // `oku-dollar::initialize`.
    assert_oku_money_mint_extensions_whitelisted(&ctx.accounts.oku_money_mint.to_account_info())?;

    let config = &mut ctx.accounts.config;
    config.bump = ctx.bumps.config;

    // Set all granular authorities from the params struct.
    config.role_admin = ctx.accounts.role_admin.key();
    config.pauser = params.pauser;
    config.unpauser = params.unpauser;
    config.freezer = params.freezer;
    config.unfreezer = params.unfreezer;
    config.queue_processor = params.queue_processor;
    config.buffer_depositor = params.buffer_depositor;
    config.buffer_withdrawer = params.buffer_withdrawer;
    config.oracle_manager = params.oracle_manager;
    config.cap_manager = params.cap_manager;
    config.allowance_manager = params.allowance_manager;
    config.rebaser = params.rebaser;

    // Set token references
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.oku_money_mint = ctx.accounts.oku_money_mint.key();
    config.vault_usdc = ctx.accounts.vault_usdc.key();
    config.vault_oku_money = Pubkey::default(); // Set in setup_oku_money_escrow

    // Set limits
    config.max_supply = params.max_supply;
    config.minter_allowance = params.minter_allowance;
    config.is_paused = false;

    // Oracle relay (USDC peg circuit-breaker). Disabled until the
    // operator wires the feed via `set_oracle_relay_feed`. The Pyth
    // program-owner pubkey is fixed here so the relay parser can
    // validate feed ownership the moment a feed is wired.
    //
    // Defaults:
    //   * `oracle_relay_feed = Pubkey::default()` is the kill-switch
    //     sentinel — the only field that gates whether the relay is
    //     consumed at all (mirrors EVM `setOracleRelay(address(0))`).
    //   * `oracle_relay_staleness = ORACLE_MAX_STALENESS_SECS` (7 days).
    //     Cycle 4 (PSM-08): previously initialised to 0, which conflicted
    //     with the setter's `[ORACLE_MIN, ORACLE_MAX]` range — an
    //     operator who called `set_oracle_relay_feed` before
    //     `set_oracle_relay_staleness` would brick every mint/redeem
    //     until staleness was raised. The max default lets the relay
    //     function the moment a feed is wired; operators tighten as
    //     part of go-live hardening.
    //   * Band defaults to the protocol-wide hard floor/ceiling
    //     (`±5%`). Operators narrow this to ±3% (`[0.97e9, 1.03e9]`)
    //     before going live. Same default-permissive posture EVM
    //     ships with.
    config.oracle_relay_feed = Pubkey::default();
    config.oracle_relay_pyth_program_owner = params.oracle_relay_pyth_program_owner;
    config.oracle_relay_staleness = oku_shared::ORACLE_MAX_STALENESS_SECS;
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
        max_supply: params.max_supply,
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
/// The 200-entry array is already zeroed; we only need to set the header.
///
/// Must be called after `initialize()`.
pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()> {
    {
        let mut queue = ctx.accounts.redemption_queue.load_init()?;
        queue.bump = ctx.bumps.redemption_queue;
        queue.head = 0;
        queue.tail = 0;
        queue.total_queued_oku_m = 0;
        // entries array was already zero-filled by Anchor's `init` allocation.
    }

    emit!(QueueInitializedEvent {
        redemption_queue: ctx.accounts.redemption_queue.key(),
        // `MAX_ENTRIES` is a `const usize` (currently 200); the cast is
        // safe because it's pinned at compile time and fits in u32.
        #[allow(clippy::cast_possible_truncation)]
        max_entries: RedemptionQueue::MAX_ENTRIES as u32,
    });

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

    emit!(EscrowInitializedEvent {
        vault_oku_money: config.vault_oku_money,
    });

    Ok(())
}
