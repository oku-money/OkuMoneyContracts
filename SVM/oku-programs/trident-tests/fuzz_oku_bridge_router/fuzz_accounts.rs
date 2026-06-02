use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub user: AddressStorage,

    pub config: AddressStorage,

    pub vault_config: AddressStorage,

    pub okusd_mint: AddressStorage,

    pub wokusd_mint: AddressStorage,

    pub user_okusd_ata: AddressStorage,

    pub user_wokusd_ata: AddressStorage,

    pub vault_okusd: AddressStorage,

    pub bridge_config: AddressStorage,

    pub psm_config: AddressStorage,

    pub bridge_nonce: AddressStorage,

    pub fee_recipient_ata: AddressStorage,

    pub vault_program: AddressStorage,

    pub psm_program: AddressStorage,

    pub token_program: AddressStorage,

    pub token_2022_program: AddressStorage,

    pub associated_token_program: AddressStorage,

    pub system_program: AddressStorage,

    pub role_admin: AddressStorage,

    pub pauser: AddressStorage,

    pub unpauser: AddressStorage,

    // -----------------------------------------------------------------------
    // Added for the elevated-multiplier redeem coverage flows
    // (`flow_redeem_usd_oku`, `flow_update_usd_multiplier`) — parity with
    // the EVM `LitePSMRebasingRedeem` post-fix fuzz suite.
    // -----------------------------------------------------------------------
    /// usdOku rebaser signer used by `flow_update_usd_multiplier`.
    pub usd_rebaser: AddressStorage,

    /// USDC mint — read by `redeem_usd_oku` (the PSM uses it for payout).
    pub usdc_mint: AddressStorage,

    /// User's USDC account — destination of the redeem payout.
    pub user_usdc_ata: AddressStorage,

    /// Reserve vault token account.
    pub reserve_vault: AddressStorage,

    /// PSM redemption queue PDA — required when the redeem path falls
    /// into the queued branch (vault USDC buffer insufficient).
    pub redemption_queue: AddressStorage,

    /// PSM USDC vault.
    pub vault_usdc: AddressStorage,

    /// PSM OkuMoney escrow.
    pub vault_oku_money: AddressStorage,
}
