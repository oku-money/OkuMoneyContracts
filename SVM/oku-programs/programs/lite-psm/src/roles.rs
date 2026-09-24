//! # OkuM Lite-PSM Roles
//!
//! Authority role definitions. Modeled on OpenZeppelin's `AccessControl` (one
//! role per capability, one meta-role for granting / revoking) but encoded as
//! enum variants, since authority pubkeys are stored directly on the config
//! PDA rather than in a hash-keyed mapping.
//! Taken from https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/access/AccessControl.sol
//!
//! The EVM equivalent of each role is named on its variant below; those names
//! must stay aligned with `EVM/src/lib/Roles.sol`.
//!
//! v1 cross-chain transfers are mediated off-chain by an orchestrator
//! holding `BufferDepositor` + `Rebaser`; there is no separate bridge RBAC.

use anchor_lang::prelude::*;

/// Authority roles that can be updated via set_authority.
///
/// These roles govern PSM-specific operations.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuthorityRole {
    /// Meta role: grant/revoke all roles (cold multisig). EVM: DEFAULT_ADMIN_ROLE
    RoleAdmin,

    /// Warm Multisig - pause PSM. EVM: PSM_PAUSER
    Pauser,

    /// Cold Multisig - unpause PSM. EVM: PSM_UNPAUSER
    Unpauser,

    /// Warm Multisig - freeze accounts. EVM: OKUM_BLACKLISTER
    Freezer,

    /// Cold Multisig - thaw accounts. EVM: OKUM_UNBLACKLISTER
    Unfreezer,

    /// Orchestrator - deposit USDC buffer. EVM: PSM_BUFFER_DEPOSITOR
    BufferDepositor,

    /// Cold Multisig - withdraw buffer. EVM: PSM_BUFFER_WITHDRAWER
    BufferWithdrawer,

    /// Cold Multisig - set max supply. EVM: OKUM_CAP_MANAGER
    CapManager,

    /// Cold Multisig - reset minter / direct-minter / direct-burner
    /// allowances. EVM: OKUM_ALLOWANCE_MANAGER
    AllowanceManager,

    /// Orchestrator - update OkuM price. EVM: OKUM_REBASER
    Rebaser,

    /// Operator / fiat gateway - direct OkuM mint without USDC.
    /// EVM: `OKUM_MINTER` (granted to a non-PSM address)
    DirectMinter,

    /// Operator / bridge backend - direct OkuM burn without USDC payout,
    /// enabling SVM→EVM bridging. EVM: `OKUM_BURNER` (non-PSM address)
    DirectBurner,
}
