use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
///
/// The struct enumerates the full account surface of the lite-psm program
/// (mirroring the IDL accounts catalog) so each instruction can fetch a
/// stable handle without scaffolding per-flow boilerplate. Many fields are
/// unused by today's flow set (signer-gated admin paths aren't fuzzed yet —
/// see `SVM/TRACKER.md § 🟡 Trident #[init] wiring`); the `dead_code`
/// suppression is intentional and crate-local.
#[allow(dead_code)]
#[derive(Default)]
pub struct AccountAddresses {
    pub rebaser: AddressStorage,

    pub config: AddressStorage,

    pub okusd_mint: AddressStorage,

    pub token_2022_program: AddressStorage,

    pub user: AddressStorage,

    pub user_okusd_ata: AddressStorage,

    pub system_program: AddressStorage,

    pub payer: AddressStorage,

    pub recipient_okusd_ata: AddressStorage,

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

    pub user_usdc_ata: AddressStorage,

    pub price_update: AddressStorage,

    pub pauser: AddressStorage,

    pub queue_processor: AddressStorage,

    pub redemption_queue: AddressStorage,

    pub vault_okusd: AddressStorage,

    pub sender_okusd_ata: AddressStorage,

    pub cap_manager: AddressStorage,

    pub allowance_manager: AddressStorage,

    pub oracle_manager: AddressStorage,

    pub unfreezer: AddressStorage,

    pub unpauser: AddressStorage,

    pub buffer_withdrawer: AddressStorage,

    pub withdrawer_usdc_ata: AddressStorage,
}
