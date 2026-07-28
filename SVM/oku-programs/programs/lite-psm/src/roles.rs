//! # OkuM Lite-PSM Roles
//!
//! Authority role definitions for the Lite-PSM program. Modeled on
//! OpenZeppelin's `AccessControl` (one role per capability, single meta-role
//! for granting / revoking) but encoded as Rust enum variants since SVM's
//! authorization story stores authority pubkeys directly on the config PDA
//! rather than in a hash-keyed mapping.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol
//!
//! Aligned with EVM contract roles from `Roles.sol`.
//!
//! ## EVM Role Mapping
//!
//! ### PSM Roles (AuthorityRole)
//!
//! | SVM Role | EVM Equivalent | Description |
//! |----------|----------------|-------------|
//! | `RoleAdmin` | `DEFAULT_ADMIN_ROLE` | Meta role: grant/revoke all roles (cold multisig) |
//! | `Pauser` | `PSM_PAUSER` | Warm Multisig - pause PSM |
//! | `Unpauser` | `PSM_UNPAUSER` | Cold Multisig - unpause PSM |
//! | `Freezer` | `OKUM_BLACKLISTER` | Warm Multisig - freeze accounts |
//! | `Unfreezer` | `OKUM_UNBLACKLISTER` | Cold Multisig - thaw accounts |
//! | `BufferDepositor` | `PSM_BUFFER_DEPOSITOR` | Orchestrator - deposit USDC buffer |
//! | `BufferWithdrawer` | `PSM_BUFFER_WITHDRAWER` | Cold Multisig - withdraw buffer |
//! | `CapManager` | `OKUM_CAP_MANAGER` | Cold Multisig - set max supply |
//! | `AllowanceManager` | `OKUM_ALLOWANCE_MANAGER` | Cold Multisig - reset minter allowance |
//! | `Rebaser` | `OKUM_REBASER` | Orchestrator - update OkuM price |
//! | `DirectMinter` | `OKUM_MINTER` (non-PSM) | Operator - direct OkuM mint without USDC |
//! | `DirectBurner` | `OKUM_BURNER` (non-PSM) | Operator - direct OkuM burn without USDC payout |
//!
//! v1 cross-chain transfers are mediated off-chain by an orchestrator
//! holding `BufferDepositor` + `Rebaser`; there is no separate bridge RBAC.

use anchor_lang::prelude::*;

/// Authority roles that can be updated via set_authority.
///
/// These roles govern PSM-specific operations.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuthorityRole {
    /// Meta role: grant/revoke all roles (cold multisig).
    /// EVM: DEFAULT_ADMIN_ROLE
    RoleAdmin,

    /// Warm Multisig - pause PSM.
    /// EVM: PSM_PAUSER
    Pauser,

    /// Cold Multisig - unpause PSM.
    /// EVM: PSM_UNPAUSER
    Unpauser,

    /// Warm Multisig - freeze accounts.
    /// EVM: OKUM_BLACKLISTER
    Freezer,

    /// Cold Multisig - thaw accounts.
    /// EVM: OKUM_UNBLACKLISTER
    Unfreezer,

    /// Orchestrator - deposit USDC buffer.
    /// EVM: PSM_BUFFER_DEPOSITOR
    BufferDepositor,

    /// Cold Multisig - withdraw buffer.
    /// EVM: PSM_BUFFER_WITHDRAWER
    BufferWithdrawer,

    /// Cold Multisig - set max supply.
    /// EVM: OKUM_CAP_MANAGER
    CapManager,

    /// Cold Multisig - reset minter allowance.
    /// EVM: OKUM_ALLOWANCE_MANAGER
    AllowanceManager,

    /// Orchestrator - update OkuM price.
    /// EVM: OKUM_REBASER
    Rebaser,

    /// Operator / fiat gateway — can mint OkuM directly without USDC.
    /// EVM: `OKUM_MINTER` (when granted to a non-PSM address)
    DirectMinter,

    /// Operator / bridge backend — can burn OkuM directly without
    /// triggering a USDC redemption. Enables SVM→EVM bridging.
    /// EVM: `OKUM_BURNER` (when granted to a non-PSM address)
    DirectBurner,
}
