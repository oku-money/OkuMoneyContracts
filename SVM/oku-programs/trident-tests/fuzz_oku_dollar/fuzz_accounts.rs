use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub role_admin: AddressStorage,

    pub config: AddressStorage,

    pub okusd_mint: AddressStorage,

    pub wokusd_mint: AddressStorage,

    pub vault_okusd: AddressStorage,

    pub token_program: AddressStorage,

    pub token_2022_program: AddressStorage,

    pub associated_token_program: AddressStorage,

    pub system_program: AddressStorage,

    pub rent: AddressStorage,

    pub pauser: AddressStorage,

    pub unpauser: AddressStorage,

    pub user: AddressStorage,

    pub user_okusd_ata: AddressStorage,

    pub user_wokusd_ata: AddressStorage,

    pub dead_shares_ata: AddressStorage,

    /// Reserve manager / multiplier rebaser signer. Used by the
    /// `flow_update_usd_multiplier` flow added for elevated-multiplier
    /// coverage (parity with the EVM `LitePSMRebasingRedeem` suite).
    pub usd_rebaser: AddressStorage,

    /// PSM config PDA — required by the `UpdateUsdMultiplier` context to
    /// read `oku_m_price` for the collateral-ratio precheck.
    pub psm_config: AddressStorage,

    /// Reserve vault token account — passed read-only into
    /// `UpdateUsdMultiplier` for the collateral-ratio precheck.
    pub reserve_vault: AddressStorage,
}
