//! Cross-program defense-in-depth validation helpers for the router.
//!
//! The router accepts `psm_config`, `vault_config`, etc. as raw
//! `UncheckedAccount`s because Anchor cannot natively deserialize PDAs owned
//! by other programs. The downstream `lite_psm` / `oku_dollar` CPIs validate
//! these PDAs via their own `seeds` constraints, so an attacker swapping PDAs
//! cannot bypass authorization. The helpers below add a *fast-fail* layer on
//! the router side: deserializing the inner state and asserting the
//! cross-program invariants the user expects (e.g. "this vault really points
//! at this PSM"). When the assertion fails we surface a clean `RouterError`
//! instead of a deep CPI error from inside `lite_psm`/`oku_dollar`.
//!
//! ## Design notes (Phase 8.6)
//!
//! - **No `find_program_address`.** A previous revision called
//!   `Pubkey::find_program_address` on every router CPI to confirm the
//!   account was the canonical PDA. That added ~10 K CU per check (3 checks
//!   per `bridge_usd_oku` = ~30 K CU). The owner check (`account.owner ==
//!   lite_psm::ID`) plus the discriminator check (in `try_deserialize_*`)
//!   already pin identity: there is exactly one `PsmConfig` per program
//!   because the seed is the constant `b"psm_config"`, and a discriminator-
//!   matching account owned by the right program is necessarily THE
//!   PsmConfig PDA. So the bump-search is redundant and we drop it.
//!
//! - **`try_deserialize_unchecked` over `try_deserialize`.** The strict
//!   variant asserts the entire account-data slice is consumed (no trailing
//!   bytes), which means any forward-compatible field added by a future
//!   `realloc` migration would silently break the router until it's
//!   recompiled against the new state struct. We accept the trailing bytes
//!   to keep the router robust across point releases of the underlying
//!   programs. The discriminator prefix is still checked.

use crate::errors::RouterError;
use anchor_lang::prelude::*;
use lite_psm::state::{BridgeConfig, PsmConfig};
use oku_dollar::state::OkuDollarConfig;

/// Verify a `PsmConfig` AccountInfo is the canonical PSM PDA owned by lite_psm.
pub fn verify_psm_config(psm_config_ai: &AccountInfo) -> Result<PsmConfig> {
    require!(
        psm_config_ai.owner == &lite_psm::ID,
        RouterError::InvalidPsmConfig
    );
    let data = psm_config_ai.try_borrow_data()?;
    let cfg = PsmConfig::try_deserialize_unchecked(&mut data.as_ref())
        .map_err(|_| error!(RouterError::InvalidPsmConfig))?;
    Ok(cfg)
}

/// Verify a `BridgeConfig` AccountInfo is the canonical Bridge PDA owned by lite_psm.
pub fn verify_bridge_config(bridge_config_ai: &AccountInfo) -> Result<BridgeConfig> {
    require!(
        bridge_config_ai.owner == &lite_psm::ID,
        RouterError::InvalidBridgeConfig
    );
    let data = bridge_config_ai.try_borrow_data()?;
    let cfg = BridgeConfig::try_deserialize_unchecked(&mut data.as_ref())
        .map_err(|_| error!(RouterError::InvalidBridgeConfig))?;
    Ok(cfg)
}

/// Verify an `OkuDollarConfig` AccountInfo is the canonical vault PDA AND
/// that it points at the supplied PSM config (cross-program link check).
pub fn verify_vault_config(
    vault_config_ai: &AccountInfo,
    expected_psm_config: &Pubkey,
) -> Result<OkuDollarConfig> {
    require!(
        vault_config_ai.owner == &oku_dollar::ID,
        RouterError::InvalidVaultConfig
    );
    let data = vault_config_ai.try_borrow_data()?;
    let cfg = OkuDollarConfig::try_deserialize_unchecked(&mut data.as_ref())
        .map_err(|_| error!(RouterError::InvalidVaultConfig))?;
    require!(
        cfg.psm_config == *expected_psm_config,
        RouterError::PsmVaultMismatch
    );
    Ok(cfg)
}

/// Combined assertion: read PsmConfig + BridgeConfig and verify neither is
/// paused. Returns the deserialized configs for downstream use.
pub fn verify_psm_and_bridge_not_paused(
    psm_config_ai: &AccountInfo,
    bridge_config_ai: &AccountInfo,
) -> Result<(PsmConfig, BridgeConfig)> {
    let psm = verify_psm_config(psm_config_ai)?;
    let bridge = verify_bridge_config(bridge_config_ai)?;
    require!(!psm.is_paused, RouterError::PsmPaused);
    require!(!bridge.is_paused, RouterError::BridgePaused);
    Ok((psm, bridge))
}

/// Verify PSM and Vault configs without bridge involvement (used by mint/redeem).
pub fn verify_psm_and_vault_not_paused(
    psm_config_ai: &AccountInfo,
    vault_config_ai: &AccountInfo,
) -> Result<(PsmConfig, OkuDollarConfig)> {
    let psm = verify_psm_config(psm_config_ai)?;
    let vault = verify_vault_config(vault_config_ai, &psm_config_ai.key())?;
    require!(!psm.is_paused, RouterError::PsmPaused);
    require!(!vault.is_paused, RouterError::VaultPaused);
    Ok((psm, vault))
}
