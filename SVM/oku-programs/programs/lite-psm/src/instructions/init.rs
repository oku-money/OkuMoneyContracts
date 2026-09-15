use crate::constants::{OKU_M_METADATA_NAME, OKU_M_METADATA_SYMBOL};
use crate::contexts::Initialize;
use crate::errors::LitePsmError;
use crate::events::InitializeEvent;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::spl_token_2022::{
    extension::metadata_pointer::instruction::initialize as initialize_metadata_pointer,
    extension::scaled_ui_amount::instruction::initialize as initialize_scaled_ui_amount,
    instruction::initialize_mint,
};
use anchor_spl::token_2022_extensions::spl_pod;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface;
use spl_token_metadata_interface::state::TokenMetadata;

/// Parameter bundle for [`initialize`]. Bundling the initialization
/// arguments into a single named struct keeps the IDL self-documenting
/// and the call site hard to scramble (every field is named, not
/// positional).
///
/// The pubkey fields are the granular on-chain authorities; see
/// `roles::AuthorityRole` for the role catalogue and `SVM/README.md`
/// § "Authority model" for the warm-vs-cold matrix.
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
    pub buffer_depositor: Pubkey,
    pub buffer_withdrawer: Pubkey,
    pub cap_manager: Pubkey,
    pub allowance_manager: Pubkey,
    pub rebaser: Pubkey,
    // ----- OkuM mint metadata -----
    pub oku_m_uri: String,
}

/// Initialize the PSM.
///
/// Creates config PDA, USDC vault, and the OkuM mint (Token-2022 with
/// ScaledUiAmount + MetadataPointer + TokenMetadata extensions).
///
/// The OkuM mint is created in this instruction via CPIs because
/// Anchor's `init` macro doesn't support multi-extension Token-2022
/// mints. The deployer passes a fresh keypair as `oku_m_mint`
/// (Signer); the instruction issues CreateAccount + extension init +
/// InitializeMint + metadata init CPIs. The PsmConfig PDA is the
/// mint authority, freeze authority, and ScaledUiAmount authority.
///
/// Authority pubkeys are bundled into [`InitializeParams`] to keep the
/// IDL self-documenting.
pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    // Capture keys before taking the mutable borrow on config, so we
    // can still call `ctx.accounts.config.to_account_info()` for CPIs.
    let bump = ctx.bumps.config;
    let mint_key = ctx.accounts.oku_m_mint.key();
    let config_key = ctx.accounts.config.key();
    let token_2022_id = ctx.accounts.token_2022_program.key();

    // Compute required space for the mint account with extensions:
    //   Base mint + ScaledUiAmount + MetadataPointer + TokenMetadata
    let metadata = TokenMetadata {
        update_authority: spl_pod::optional_keys::OptionalNonZeroPubkey::try_from(Some(config_key))
            .map_err(|_| error!(LitePsmError::InvalidAuthority))?,
        mint: mint_key,
        // On-chain identity is the base OkuM ("OkuMoney") token — the true,
        // value-appreciating, T-Bill-backed token. Wallets and block
        // explorers display THESE values for the mint and for transfers.
        // The "$1-pegged usdOku" figure is a display-layer value produced
        // by the ScaledUiAmount extension (raw_amount * multiplier), not
        // the on-chain symbol. Strings mirror EVM `OkuMoney`/`OkuM`; kept
        // in a single constant (see constants.rs) so this and the metadata
        // -init CPI below cannot drift on a rename.
        name: OKU_M_METADATA_NAME.to_string(),
        symbol: OKU_M_METADATA_SYMBOL.to_string(),
        uri: params.oku_m_uri.clone(),
        additional_metadata: vec![],
    };
    let metadata_len = metadata.tlv_size_of().map_err(|_| LitePsmError::Overflow)?;

    use anchor_spl::token_2022::spl_token_2022 as spl_t22;

    // Mint account space allocation (two-step pattern for Token-2022
    // mints with variable-length extensions like TokenMetadata):
    //
    //   1. `CreateAccount` with space for the base mint + fixed-size
    //      extensions only (ScaledUiAmount + MetadataPointer).
    //      Token-2022's `InitializeMint` validates the TLV layout is
    //      consistent with the account length, so extra uninitialized
    //      bytes would cause `InvalidAccountData`.
    //
    //   2. Fund with enough lamports for the FULL final size (including
    //      the variable-length TokenMetadata). Token-2022's metadata
    //      init instruction reallocs the account to fit the metadata
    //      TLV, and the pre-funded lamports cover the additional rent.
    //
    // This is the standard pattern for Token-2022 mints with metadata.
    // See: https://solana.com/docs/tokens/extensions/metadata-pointer
    let fixed_space =
        spl_t22::extension::ExtensionType::try_calculate_account_len::<spl_t22::state::Mint>(&[
            spl_t22::extension::ExtensionType::ScaledUiAmount,
            spl_t22::extension::ExtensionType::MetadataPointer,
        ])
        .map_err(|_| LitePsmError::Overflow)?;

    let total_space = fixed_space
        .checked_add(metadata_len)
        .ok_or(LitePsmError::Overflow)?;
    let rent = Rent::get()?;
    // NOTE: CreateAccount uses `fixed_space` for the initial account
    // length, but lamports cover `total_space` for post-realloc rent.
    let lamports = rent.minimum_balance(total_space);
    let space = fixed_space;

    // CreateAccount
    invoke(
        &anchor_lang::solana_program::system_instruction::create_account(
            ctx.accounts.role_admin.key,
            &mint_key,
            lamports,
            space as u64,
            &token_2022_id,
        ),
        &[
            ctx.accounts.role_admin.to_account_info(),
            ctx.accounts.oku_m_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Initialize extensions. Order matters: all extension inits must
    // come before InitializeMint2. MetadataPointer before ScaledUiAmount
    // so extensions are laid out in ascending ExtensionType order.
    // InitializeMetadataPointer — point to self (mint stores its own metadata)
    invoke(
        &initialize_metadata_pointer(
            &token_2022_id,
            &mint_key,
            Some(config_key), // authority
            Some(mint_key),   // metadata address = self
        )?,
        &[ctx.accounts.oku_m_mint.to_account_info()],
    )?;
    // InitializeScaledUiAmountConfig — multiplier starts at 1.0
    // (ScaledUiAmount uses f64; 1.0 means raw == display).
    invoke(
        &initialize_scaled_ui_amount(
            &token_2022_id,
            &mint_key,
            Some(config_key), // authority = config PDA
            1.0_f64,          // initial multiplier
        )?,
        &[ctx.accounts.oku_m_mint.to_account_info()],
    )?;
    // InitializeMint — decimals 6, authorities = config PDA
    // Uses InitializeMint (not InitializeMint2) which also takes the
    // Rent sysvar account -- needed for extension-bearing mints.
    invoke(
        &initialize_mint(
            &token_2022_id,
            &mint_key,
            &config_key,       // mint authority
            Some(&config_key), // freeze authority
            6,                 // decimals
        )?,
        &[
            ctx.accounts.oku_m_mint.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
    )?;
    // Initialize token metadata (name, symbol, uri).
    // The mint authority (config PDA) must sign this CPI because
    // Token-2022 requires the mint authority to authorize metadata init.
    let bump_seed = [bump];
    let seeds = PsmConfig::signer_seeds(&bump_seed);
    let signer_seeds = &[&seeds[..]];
    anchor_lang::solana_program::program::invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &token_2022_id,
            &mint_key,   // metadata account = mint (self)
            &config_key, // update authority
            &mint_key,   // mint
            &config_key, // mint authority
            // On-chain OkuM identity — see the TokenMetadata block above and
            // OKU_M_METADATA_* in constants.rs (single source of truth).
            OKU_M_METADATA_NAME.to_string(),
            OKU_M_METADATA_SYMBOL.to_string(),
            params.oku_m_uri.clone(),
        ),
        &[
            ctx.accounts.oku_m_mint.to_account_info(),
            ctx.accounts.config.to_account_info(),
        ],
        signer_seeds,
    )?;

    // ---------------------------------------------------------------
    // 2. Validate + populate PsmConfig fields.
    // ---------------------------------------------------------------
    let role_admin_key = ctx.accounts.role_admin.key();

    // Validate the 9 granular authorities before writing any of them.
    // Mirrors `set_authority`'s two guards (`psm_admin.rs`):
    //   1. Reject the zero pubkey — a deploy-script typo/omission must
    //      not silently seat a role at `Pubkey::default()`, which would
    //      make that role permanently unusable (e.g. a zero `freezer`
    //      quietly removes an incident-response lever with no on-chain
    //      signal, since `has_one` constraints simply never match).
    //   2. Reject collapsing a granular authority into `role_admin` —
    //      the cold-multisig meta-role must stay separate from the warm
    //      operational roles, same separation-of-duties rationale as
    //      `set_authority` (`psm_admin.rs:221-224`). `role_admin` itself
    //      is exempt (it is a `Signer` account, inherently non-default).
    let granular_authorities = [
        params.pauser,
        params.unpauser,
        params.freezer,
        params.unfreezer,
        params.buffer_depositor,
        params.buffer_withdrawer,
        params.cap_manager,
        params.allowance_manager,
        params.rebaser,
    ];
    for authority in granular_authorities {
        require!(
            authority != Pubkey::default(),
            LitePsmError::InvalidAuthority
        );
        require!(authority != role_admin_key, LitePsmError::InvalidAuthority);
    }

    let config = &mut ctx.accounts.config;
    config.bump = bump;

    // Set all granular authorities from the params struct.
    config.role_admin = role_admin_key;
    config.pauser = params.pauser;
    config.unpauser = params.unpauser;
    config.freezer = params.freezer;
    config.unfreezer = params.unfreezer;
    config.buffer_depositor = params.buffer_depositor;
    config.buffer_withdrawer = params.buffer_withdrawer;
    config.cap_manager = params.cap_manager;
    config.allowance_manager = params.allowance_manager;
    config.rebaser = params.rebaser;

    // Set token references
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.oku_m_mint = mint_key;
    config.vault_usdc = ctx.accounts.vault_usdc.key();

    // Set limits
    config.max_supply = params.max_supply;
    config.minter_allowance = params.minter_allowance;
    config.is_paused = false;

    // Sandwich lock — starts at 0 (no lock). Only the emergency multiplier
    // override ever stamps this under streaming accrual.
    config.last_yield_distribution_slot = 0;

    // Rate schedule — flat and HALTED. The multiplier reads 1.0 and does not
    // move until the operator publishes a rate, which is the correct initial
    // state: a freshly deployed chain has earned nothing.
    //
    // Mirrors `EVM/src/token/OkuMoney.sol:195-199`.
    let init_schedule = oku_shared::rate::Schedule::halted_at(Clock::get()?.unix_timestamp);
    config.okum_base_multiplier = init_schedule.base_multiplier;
    config.okum_rate_per_second = init_schedule.rate_per_second as u64;
    config.okum_last_accrual_time = init_schedule.last_accrual_time;
    config.okum_rate_end = init_schedule.rate_end;
    config.okum_pending_rate_per_second = init_schedule.pending_rate_per_second as u64;
    config.okum_pending_rate_end = init_schedule.pending_rate_end;

    // Display mirror starts in sync: the extension is initialized to 1.0
    // above, which is exactly the canonical multiplier of a halted schedule.
    config.last_display_sync_ts = init_schedule.last_accrual_time;

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
        oku_m_mint: config.oku_m_mint,
        max_supply: params.max_supply,
    });

    Ok(())
}
