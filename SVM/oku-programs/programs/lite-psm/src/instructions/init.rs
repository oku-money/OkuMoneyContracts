use crate::constants::PRECISION;
use crate::contexts::{Initialize, SetupOkuMoneyEscrow, SetupRedemptionQueue};
use crate::errors::LitePsmError;
use crate::events::{EscrowInitializedEvent, InitializeEvent, QueueInitializedEvent};
use crate::helpers::mint_extensions::assert_oku_money_mint_extensions_whitelisted;
use crate::helpers::read_oku_m_price;
use crate::state::RedemptionQueue;
use anchor_lang::prelude::*;

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
    pub cap_manager: Pubkey,
    pub allowance_manager: Pubkey,
    pub rebaser: Pubkey,
}

/// Initialize the PSM — step 1.
///
/// Creates config PDA and USDC vault. Call `setup_redemption_queue`
/// and `setup_oku_money_escrow` afterwards to complete initialization.
/// Authority pubkeys are bundled into [`InitializeParams`] to keep the
/// IDL slot self-documenting (cycle 4 / PSM-17).
pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    // Enforce the Token-2022 extension allow-list on the OkuMoney mint.
    // Single source of truth lives in `helpers::mint_extensions` and is
    // also called from `oku-dollar::initialize`.
    assert_oku_money_mint_extensions_whitelisted(&ctx.accounts.oku_money_mint.to_account_info())?;

    // Validate that the OkuMoney mint has the ScaledUiAmountConfig
    // extension initialized with a valid price (>= PRECISION = $1.00).
    let initial_price = read_oku_m_price(&ctx.accounts.oku_money_mint.to_account_info())?;
    require!(initial_price >= PRECISION, LitePsmError::InvalidPrice);

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

    // Yield distribution lock - starts at 0 (no lock)
    config.last_yield_distribution_slot = 0;

    // OkuMoney price is stored on the mint's ScaledUiAmountConfig extension
    // (validated above). No PDA field needed.

    // Two-step `role_admin` transfer slot — empty until
    // `set_authority(RoleAdmin, ...)` proposes a rotation.
    config.pending_role_admin = Pubkey::default();

    // Direct mint — disabled by default. Operator configures via
    // `set_authority(DirectMinter, ...)` + `set_direct_minter_allowance`.
    config.direct_minter = Pubkey::default();
    config.direct_minter_allowance = 0;

    // Direct burn — disabled by default. Operator configures via
    // `set_authority(DirectBurner, ...)` + `set_direct_burner_allowance`.
    config.direct_burner = Pubkey::default();
    config.direct_burner_allowance = 0;

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
