//! # OkuBridgeRouter Roles
//!
//! Authority role definitions for the OkuBridgeRouter program.
//! Aligned with EVM contract roles from `Roles.sol`.
//!
//! ## EVM Role Mapping
//!
//! | SVM Role | EVM Equivalent | Description |
//! |----------|----------------|-------------|
//! | `RoleAdmin` | `DEFAULT_ADMIN_ROLE` | Meta role: grant/revoke all roles |
//! | `Pauser` | `ROUTER_PAUSER` | Warm Multisig - pause router |
//! | `Unpauser` | `ROUTER_UNPAUSER` | Cold Multisig - unpause router |

use anchor_lang::prelude::*;

/// Authority roles that can be updated via set_authority.
///
/// These roles govern OkuBridgeRouter operations.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouterAuthorityRole {
    /// Meta role: grant/revoke all roles.
    /// EVM: DEFAULT_ADMIN_ROLE
    RoleAdmin,

    /// Warm Multisig - pause router.
    /// EVM: ROUTER_PAUSER
    Pauser,

    /// Cold Multisig - unpause router.
    /// EVM: ROUTER_UNPAUSER
    Unpauser,
}
