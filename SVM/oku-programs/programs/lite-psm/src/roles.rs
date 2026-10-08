//! Authority roles, stored as pubkeys on `PsmConfig`. Each variant names its EVM
//! role; keep aligned with `EVM/src/lib/Roles.sol`.

use anchor_lang::prelude::*;

/// Roles settable via `set_authority`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuthorityRole {
    /// Cold – rotates all roles (two-step). EVM: DEFAULT_ADMIN_ROLE
    RoleAdmin,
    /// Warm – pause. EVM: PSM_PAUSER
    Pauser,
    /// Cold – unpause. EVM: PSM_UNPAUSER
    Unpauser,
    /// Warm – freeze accounts. EVM: OKUM_BLACKLISTER
    Freezer,
    /// Cold – thaw accounts. EVM: OKUM_UNBLACKLISTER
    Unfreezer,
    /// Orchestrator – deposit buffer. EVM: PSM_BUFFER_DEPOSITOR
    BufferDepositor,
    /// Cold – withdraw buffer. EVM: PSM_BUFFER_WITHDRAWER
    BufferWithdrawer,
    /// Cold – set max supply. EVM: OKUM_CAP_MANAGER
    CapManager,
    /// Cold – set minter, direct-minter and direct-burner allowances. EVM: OKUM_ALLOWANCE_MANAGER
    AllowanceManager,
    /// Orchestrator – set rate schedule / multiplier override (display sync is permissionless). EVM: OKUM_RATE_MANAGER
    RateManager,
    /// Fiat gateway – direct mint without USDC. EVM: OKUM_MINTER
    DirectMinter,
    /// Bridge backend – direct burn without USDC payout. EVM: OKUM_BURNER
    DirectBurner,
}
