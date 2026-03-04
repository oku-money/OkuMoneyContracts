use anchor_lang::prelude::*;

/// Bridge authority roles that can be updated via set_bridge_authority
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BridgeAuthorityRole {
    BridgeAdmin,
    BridgePauser,
    BridgeUnpauser,
    OrchestratorSigner,
    FeeRecipient,
    ChainManager,
    FeeManager,
    NonceAdmin,
    RefundAdmin,
    SignerManager,
    LimitsManager,
}

/// Authority roles that can be updated via set_authority
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityRole {
    RoleAdmin,
    Pauser,
    Unpauser,
    Freezer,
    Unfreezer,
    QueueProcessor,
    BufferDepositor,
    BufferWithdrawer,
    OracleManager,
    CapManager,
    AllowanceManager,
    Rebaser,
}
