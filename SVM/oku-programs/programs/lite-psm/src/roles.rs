//! # OkuMoney Lite-PSM Roles
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
//! | `QueueProcessor` | `PSM_QUEUE_PROCESSOR` | Orchestrator - process redemption queue |
//! | `BufferDepositor` | `PSM_BUFFER_DEPOSITOR` | Orchestrator - deposit USDC buffer |
//! | `BufferWithdrawer` | `PSM_BUFFER_WITHDRAWER` | Cold Multisig - withdraw buffer |
//! | `OracleManager` | `PSM_ORACLE_MANAGER` | Cold Multisig - configure oracle |
//! | `CapManager` | `OKUM_CAP_MANAGER` | Cold Multisig - set max supply |
//! | `AllowanceManager` | `OKUM_ALLOWANCE_MANAGER` | Cold Multisig - reset minter allowance |
//! | `Rebaser` | `OKUM_REBASER` | Orchestrator - update OkuMoney price |
//!
//! ### Bridge Roles (BridgeAuthorityRole)
//!
//! | SVM Role | EVM Equivalent | Description |
//! |----------|----------------|-------------|
//! | `BridgeAdmin` | `DEFAULT_ADMIN_ROLE` | Meta role: manage bridge roles |
//! | `BridgePauser` | `BRIDGE_PAUSER` | Emergency pause |
//! | `BridgeUnpauser` | `BRIDGE_UNPAUSER` | Unpause |
//! | `OrchestratorSigner` | N/A (stored as address) | Ed25519 key for signature verification |
//! | `FeeRecipient` | N/A (stored as address) | Receives bridge fees |
//! | `ChainManager` | `BRIDGE_CHAIN_MANAGER` | Add/remove supported chains |
//! | `FeeManager` | `BRIDGE_FEE_MANAGER` | Update fee configuration |
//! | `NonceAdmin` | `BRIDGE_NONCE_ADMIN` | Emergency nonce management |
//! | `RefundInitiator` | `BRIDGE_REFUND_INITIATOR` | Initiate refunds (step 1) |
//! | `RefundConfirmer` | `BRIDGE_REFUND_CONFIRMER` | Confirm refunds (step 2) |
//! | `SignerManager` | `BRIDGE_SIGNER_MANAGER` | Update orchestrator signer (Cold Multisig) |
//! | `LimitsManager` | `BRIDGE_LIMITS_MANAGER` | Update limits and deadline (Cold Multisig) |

use anchor_lang::prelude::*;

/// Bridge authority roles that can be updated via set_bridge_authority.
///
/// These roles are separate from PSM roles and govern bridge-specific operations.
/// The two-step refund pattern uses `RefundInitiator` and `RefundConfirmer` to
/// prevent single-key double-mint attacks.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BridgeAuthorityRole {
    /// Meta role: manage bridge roles.
    /// EVM: DEFAULT_ADMIN_ROLE
    BridgeAdmin,

    /// Emergency pause.
    /// EVM: BRIDGE_PAUSER
    BridgePauser,

    /// Unpause.
    /// EVM: BRIDGE_UNPAUSER
    BridgeUnpauser,

    /// Ed25519 public key for signature verification.
    /// Not a role in EVM (stored as state variable).
    OrchestratorSigner,

    /// Receives bridge fees.
    /// Not a role in EVM (stored as state variable).
    FeeRecipient,

    /// Add/remove supported chains.
    /// EVM: BRIDGE_CHAIN_MANAGER
    ChainManager,

    /// Update fee configuration.
    /// EVM: BRIDGE_FEE_MANAGER
    FeeManager,

    /// Emergency nonce management.
    /// EVM: BRIDGE_NONCE_ADMIN
    NonceAdmin,

    /// Initiate refunds (step 1 of two-step refund).
    /// EVM: BRIDGE_REFUND_INITIATOR
    RefundInitiator,

    /// Confirm refunds (step 2 of two-step refund).
    /// Must be different key than RefundInitiator.
    /// EVM: BRIDGE_REFUND_CONFIRMER
    RefundConfirmer,

    /// Update orchestrator signer (Cold Multisig).
    /// EVM: BRIDGE_SIGNER_MANAGER
    SignerManager,

    /// Update bridge limits and deadline (Cold Multisig).
    /// EVM: BRIDGE_LIMITS_MANAGER
    LimitsManager,
}

/// Authority roles that can be updated via set_authority.
///
/// These roles govern PSM-specific operations separate from bridge roles.
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

    /// Orchestrator - process redemption queue.
    /// EVM: PSM_QUEUE_PROCESSOR
    QueueProcessor,

    /// Orchestrator - deposit USDC buffer.
    /// EVM: PSM_BUFFER_DEPOSITOR
    BufferDepositor,

    /// Cold Multisig - withdraw buffer.
    /// EVM: PSM_BUFFER_WITHDRAWER
    BufferWithdrawer,

    /// Cold Multisig - configure oracle.
    /// EVM: PSM_ORACLE_MANAGER
    OracleManager,

    /// Cold Multisig - set max supply.
    /// EVM: OKUM_CAP_MANAGER
    CapManager,

    /// Cold Multisig - reset minter allowance.
    /// EVM: OKUM_ALLOWANCE_MANAGER
    AllowanceManager,

    /// Orchestrator - update OkuMoney price.
    /// EVM: OKUM_REBASER
    Rebaser,
}
