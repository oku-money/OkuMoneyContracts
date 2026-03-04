use anchor_lang::prelude::*;

/// Authority roles that can be updated via set_authority
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RouterAuthorityRole {
    RoleAdmin,
    Pauser,
    Unpauser,
}
