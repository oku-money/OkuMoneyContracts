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
}
