//! One-time program setup: create the OkuM mint and the `PsmConfig` PDA and
//! assign every role.

use crate::constants::{OKU_M_METADATA_NAME, OKU_M_METADATA_SYMBOL, TOKEN_DECIMALS};
use crate::contexts::Initialize;
use crate::errors::LitePsmError;
use crate::events::InitializeEvent;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token_2022::spl_token_2022::{
    self as spl_t22,
    extension::metadata_pointer::instruction::initialize as initialize_metadata_pointer,
    extension::scaled_ui_amount::instruction::initialize as initialize_scaled_ui_amount,
    extension::ExtensionType, instruction::initialize_mint,
};
use anchor_spl::token_2022_extensions::spl_pod;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface;
use oku_shared::rate::Schedule;
use spl_token_metadata_interface::state::TokenMetadata;

/// `ScaledUiAmount` starts at 1.0 (raw == display), the canonical multiplier of
/// a halted schedule.
const INITIAL_DISPLAY_MULTIPLIER: f64 = 1.0;

/// Parameter bundle for [`initialize`]. Named fields keep the call site hard to
/// scramble. Pubkey fields are the granular authorities (`roles::AuthorityRole`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeParams {
    /// Supply cap in raw OkuM units (6 decimals).
    pub max_supply: u64,
    /// Initial `mint_oku_m` allowance in raw OkuM units (6 decimals).
    pub minter_allowance: u64,
    /// Can pause the PSM.
    pub pauser: Pubkey,
    /// Can unpause the PSM.
    pub unpauser: Pubkey,
    /// Can freeze OkuM token accounts.
    pub freezer: Pubkey,
    /// Can thaw OkuM token accounts.
    pub unfreezer: Pubkey,
    /// Can add USDC to the redemption vault.
    pub buffer_depositor: Pubkey,
    /// Can take USDC out of the redemption vault.
    pub buffer_withdrawer: Pubkey,
    /// Can change the supply cap.
    pub cap_manager: Pubkey,
    /// Can reset the mint / direct-mint / direct-burn allowances.
    pub allowance_manager: Pubkey,
    /// Sets the yield-rate schedule and the emergency multiplier override.
    pub rate_manager: Pubkey,
    /// Token-2022 metadata URI for the OkuM mint.
    pub oku_m_uri: String,
}

impl InitializeParams {
    /// The 9 role keys set at init, for validation. `direct_minter` and
    /// `direct_burner` are not here: they start disabled (zero key) and are
    /// assigned later with `set_authority`.
    fn granular_authorities(&self) -> [Pubkey; 9] {
        [
            self.pauser,
            self.unpauser,
            self.freezer,
            self.unfreezer,
            self.buffer_depositor,
            self.buffer_withdrawer,
            self.cap_manager,
            self.allowance_manager,
            self.rate_manager,
        ]
    }
}

/// Same two guards as `set_authority`: no zero pubkey (the role would be
/// silently unusable) and no collapsing a role into `role_admin` (the cold
/// meta-role stays separate from the warm operational ones).
fn validate_granular_authorities(params: &InitializeParams, role_admin: &Pubkey) -> Result<()> {
    for authority in params.granular_authorities() {
        require!(
            authority != Pubkey::default() && authority != *role_admin,
            LitePsmError::InvalidAuthority
        );
    }
    Ok(())
}

/// Create and initialize the OkuM Token-2022 mint (Anchor's `init` cannot build
/// multi-extension mints). The `PsmConfig` PDA is mint, freeze, `ScaledUiAmount`
/// and metadata authority.
fn create_oku_m_mint(accounts: &Initialize, bump: u8, uri: &str) -> Result<()> {
    let mint_key = accounts.oku_m_mint.key();
    let config_key = accounts.config.key();
    let token_2022_id = accounts.token_2022_program.key();

    let metadata = TokenMetadata {
        update_authority: spl_pod::optional_keys::OptionalNonZeroPubkey::try_from(Some(config_key))
            .map_err(|_| error!(LitePsmError::InvalidAuthority))?,
        mint: mint_key,
        name: OKU_M_METADATA_NAME.to_string(),
        symbol: OKU_M_METADATA_SYMBOL.to_string(),
        uri: uri.to_string(),
        additional_metadata: vec![],
    };
    let metadata_len = metadata.tlv_size_of().map_err(|_| LitePsmError::Overflow)?;

    // Two-step allocation: `CreateAccount` allocates only the fixed-size
    // extensions, because `InitializeMint` validates the TLV layout against the
    // account length. Lamports are funded for the FULL size, since the metadata
    // init reallocs to fit and draws on the pre-funded rent.
    let fixed_space = ExtensionType::try_calculate_account_len::<spl_t22::state::Mint>(&[
        ExtensionType::ScaledUiAmount,
        ExtensionType::MetadataPointer,
    ])
    .map_err(|_| LitePsmError::Overflow)?;
    let total_space = fixed_space
        .checked_add(metadata_len)
        .ok_or(LitePsmError::Overflow)?;
    let lamports = Rent::get()?.minimum_balance(total_space);

    invoke(
        &anchor_lang::solana_program::system_instruction::create_account(
            accounts.role_admin.key,
            &mint_key,
            lamports,
            fixed_space as u64,
            &token_2022_id,
        ),
        &[
            accounts.role_admin.to_account_info(),
            accounts.oku_m_mint.to_account_info(),
            accounts.system_program.to_account_info(),
        ],
    )?;

    // All extension inits must precede `InitializeMint`, in ascending
    // `ExtensionType` order (MetadataPointer before ScaledUiAmount).
    invoke(
        &initialize_metadata_pointer(
            &token_2022_id,
            &mint_key,
            Some(config_key),
            Some(mint_key), // the mint stores its own metadata
        )?,
        &[accounts.oku_m_mint.to_account_info()],
    )?;
    invoke(
        &initialize_scaled_ui_amount(
            &token_2022_id,
            &mint_key,
            Some(config_key),
            INITIAL_DISPLAY_MULTIPLIER,
        )?,
        &[accounts.oku_m_mint.to_account_info()],
    )?;
    // `InitializeMint` (not `InitializeMint2`): takes the Rent sysvar account.
    invoke(
        &initialize_mint(
            &token_2022_id,
            &mint_key,
            &config_key,       // mint authority
            Some(&config_key), // freeze authority
            TOKEN_DECIMALS,
        )?,
        &[
            accounts.oku_m_mint.to_account_info(),
            accounts.rent.to_account_info(),
        ],
    )?;

    // The mint authority (config PDA) must sign the metadata init.
    let bump_seed = [bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &token_2022_id,
            &mint_key,   // metadata account = mint (self)
            &config_key, // update authority
            &mint_key,
            &config_key, // mint authority
            OKU_M_METADATA_NAME.to_string(),
            OKU_M_METADATA_SYMBOL.to_string(),
            uri.to_string(),
        ),
        &[
            accounts.oku_m_mint.to_account_info(),
            accounts.config.to_account_info(),
        ],
        &[&seeds[..]],
    )?;

    Ok(())
}

/// Populate the freshly zeroed config. Direct mint/burn start disabled and
/// `pending_role_admin` empty, so unset fields rely on Anchor's zero-init.
fn write_initial_config(
    config: &mut PsmConfig,
    keys: InitKeys,
    params: &InitializeParams,
    now_ts: i64,
) {
    config.bump = keys.bump;

    config.role_admin = keys.role_admin;
    config.pauser = params.pauser;
    config.unpauser = params.unpauser;
    config.freezer = params.freezer;
    config.unfreezer = params.unfreezer;
    config.buffer_depositor = params.buffer_depositor;
    config.buffer_withdrawer = params.buffer_withdrawer;
    config.cap_manager = params.cap_manager;
    config.allowance_manager = params.allowance_manager;
    config.rate_manager = params.rate_manager;

    config.usdc_mint = keys.usdc_mint;
    config.oku_m_mint = keys.oku_m_mint;
    config.vault_usdc = keys.vault_usdc;

    config.max_supply = params.max_supply;
    config.minter_allowance = params.minter_allowance;

    // Flat and halted: a freshly deployed chain has earned nothing.
    let schedule = Schedule::halted_at(now_ts);
    config.okum_base_multiplier = schedule.base_multiplier;
    config.okum_rate_per_second = schedule.rate_per_second as u64;
    config.okum_last_accrual_time = schedule.last_accrual_time;
    config.okum_rate_end = schedule.rate_end;
    config.okum_pending_rate_per_second = schedule.pending_rate_per_second as u64;
    config.okum_pending_rate_end = schedule.pending_rate_end;

    // The mirror already reads `INITIAL_DISPLAY_MULTIPLIER`, i.e. in sync.
    config.last_display_sync_ts = schedule.last_accrual_time;
}

/// Account keys recorded in the config at init.
#[derive(Clone, Copy)]
struct InitKeys {
    bump: u8,
    role_admin: Pubkey,
    usdc_mint: Pubkey,
    oku_m_mint: Pubkey,
    vault_usdc: Pubkey,
}

/// One-time setup: validate the role keys, create the OkuM mint (with its
/// Token-2022 extensions), and write the `PsmConfig` with a halted rate schedule
/// (multiplier 1.0). The signer becomes `role_admin`.
///
/// Callable only by the program's upgrade authority (enforced on the `Initialize`
/// context, which documents the land-grab it prevents).
pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    let bump = ctx.bumps.config;
    let role_admin = ctx.accounts.role_admin.key();
    // 1. Every granular role must be a real key and not the admin itself.
    validate_granular_authorities(&params, &role_admin)?;

    // 2. Create the mint by hand (Anchor's `init` cannot add these extensions).
    create_oku_m_mint(ctx.accounts, bump, &params.oku_m_uri)?;

    // 3. Record the wiring, roles, caps and the starting schedule in the config.

    let keys = InitKeys {
        bump,
        role_admin,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        oku_m_mint: ctx.accounts.oku_m_mint.key(),
        vault_usdc: ctx.accounts.vault_usdc.key(),
    };
    let now_ts = Clock::get()?.unix_timestamp;
    write_initial_config(&mut ctx.accounts.config, keys, &params, now_ts);

    emit!(InitializeEvent {
        role_admin,
        usdc_mint: keys.usdc_mint,
        oku_m_mint: keys.oku_m_mint,
        max_supply: params.max_supply,
    });

    Ok(())
}
