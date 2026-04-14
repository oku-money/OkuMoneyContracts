//! # OkuDollar Roles
//!
//! Authority role definitions for the OkuDollar vault program.
//! Aligned with EVM contract roles from `Roles.sol`.
//!
//! ## EVM Role Mapping
//!
//! | SVM Role | EVM Equivalent | Description |
//! |----------|----------------|-------------|
//! | `RoleAdmin` | `DEFAULT_ADMIN_ROLE` | Meta role: grant/revoke all roles (cold multisig) |
//! | `Pauser` | `VAULT_PAUSER` | Warm Multisig - pause vault |
//! | `Unpauser` | `VAULT_UNPAUSER` | Cold Multisig - unpause vault |
//! | `UsdRebaser` | `VAULT_REBASER` | Orchestrator - update USD multiplier |
//! | `ReserveManager` | `VAULT_RESERVE_MANAGER` | Cold Multisig - deposit/withdraw reserves |

use anchor_lang::prelude::*;

/// Authority roles that can be updated via set_authority.
///
/// These roles govern OkuDollar vault operations.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuthorityRole {
    /// Meta role: grant/revoke all roles (cold multisig).
    /// EVM: DEFAULT_ADMIN_ROLE
    RoleAdmin,

    /// Warm Multisig - pause vault.
    /// EVM: VAULT_PAUSER
    Pauser,

    /// Cold Multisig - unpause vault.
    /// EVM: VAULT_UNPAUSER
    Unpauser,

    /// Orchestrator - update USD multiplier.
    /// EVM: VAULT_REBASER
    UsdRebaser,

    /// Cold Multisig - deposit/withdraw reserves.
    /// EVM: VAULT_RESERVE_MANAGER
    ReserveManager,
}
