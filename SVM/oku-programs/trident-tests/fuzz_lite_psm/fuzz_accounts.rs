use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub chain_manager: AddressStorage,

    pub bridge_config: AddressStorage,

    pub rebaser: AddressStorage,

    pub config: AddressStorage,

    pub okusd_mint: AddressStorage,

    pub token_2022_program: AddressStorage,

    pub user: AddressStorage,

    pub bridge_nonce: AddressStorage,

    pub user_okusd_ata: AddressStorage,

    pub fee_recipient_ata: AddressStorage,

    pub system_program: AddressStorage,

    pub payer: AddressStorage,

    pub processed_request: AddressStorage,

    pub recipient_okusd_ata: AddressStorage,

    pub instruction_sysvar: AddressStorage,

    pub buffer_depositor: AddressStorage,

    pub buffer_depositor_usdc_ata: AddressStorage,

    pub vault_usdc: AddressStorage,

    pub usdc_mint: AddressStorage,

    pub token_program: AddressStorage,

    pub freezer: AddressStorage,

    pub target_okusd_ata: AddressStorage,

    pub role_admin: AddressStorage,

    pub associated_token_program: AddressStorage,

    pub rent: AddressStorage,

    pub bridge_admin: AddressStorage,

    pub bridge_pauser: AddressStorage,

    pub bridge_unpauser: AddressStorage,

    pub orchestrator_signer: AddressStorage,

    pub fee_recipient: AddressStorage,

    pub fee_manager: AddressStorage,

    pub nonce_admin: AddressStorage,

    pub signer_manager: AddressStorage,

    pub limits_manager: AddressStorage,

    pub user_usdc_ata: AddressStorage,

    pub price_update: AddressStorage,

    pub pauser: AddressStorage,

    pub queue_processor: AddressStorage,

    pub redemption_queue: AddressStorage,

    pub vault_okusd: AddressStorage,

    pub refund_admin: AddressStorage,

    pub refunded_request: AddressStorage,

    pub sender_okusd_ata: AddressStorage,

    pub cap_manager: AddressStorage,

    pub allowance_manager: AddressStorage,

    pub oracle_manager: AddressStorage,

    pub unfreezer: AddressStorage,

    pub unpauser: AddressStorage,

    pub buffer_withdrawer: AddressStorage,

    pub withdrawer_usdc_ata: AddressStorage,
}
