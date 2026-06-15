use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
///
/// Many fields are unused by today's flow set (signer-gated admin paths
/// aren't fuzzed yet); the `dead_code` suppression is intentional and
/// crate-local. Mirrors the layout of `fuzz_lite_psm/fuzz_accounts.rs`.
#[allow(dead_code)]
#[derive(Default)]
pub struct AccountAddresses {
    pub role_admin: AddressStorage,

    pub config: AddressStorage,

    /// USDC SPL mint (legacy Token program, 6 decimals). Added in
    /// cycle 3 — required by `#[init]` to bootstrap the lite-psm side
    /// of the workspace (oku-dollar's `Initialize` ix has an `address =
    /// psm_config.usdc_mint` constraint on the PSM config it reads).
    pub usdc_mint: AddressStorage,

    /// OkuMoney Token-2022 mint. Originally named `okusd_mint` in the
    /// pre-rename scaffold; kept for backwards compatibility with the
    /// existing flows.
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
