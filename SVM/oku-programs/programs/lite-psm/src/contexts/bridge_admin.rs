use crate::errors::LitePsmError;
use crate::state::{BridgeConfig, BridgeNonce};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeBridge<'info> {
    #[account(mut)]
    pub bridge_admin: Signer<'info>,

    /// CHECK: Authority pubkey for role assignment
    pub bridge_pauser: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub bridge_unpauser: UncheckedAccount<'info>,
    /// CHECK: Ed25519 public key for orchestrator signature verification
    pub orchestrator_signer: UncheckedAccount<'info>,
    /// CHECK: Fee recipient pubkey
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: Chain manager pubkey
    pub chain_manager: UncheckedAccount<'info>,
    /// CHECK: Fee manager pubkey
    pub fee_manager: UncheckedAccount<'info>,
    /// CHECK: Nonce admin pubkey
    pub nonce_admin: UncheckedAccount<'info>,
    /// CHECK: Signer manager pubkey
    pub signer_manager: UncheckedAccount<'info>,
    /// CHECK: Limits manager pubkey
    pub limits_manager: UncheckedAccount<'info>,

    #[account(
        init,
        payer = bridge_admin,
        space = BridgeConfig::LEN,
        seeds = [BridgeConfig::SEED],
        bump
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BridgeChainManager<'info> {
    pub chain_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = chain_manager @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeFeeManager<'info> {
    pub fee_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = fee_manager @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeSignerManager<'info> {
    pub signer_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = signer_manager @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeLimitsManager<'info> {
    pub limits_manager: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = limits_manager @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeAdmin<'info> {
    pub bridge_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = bridge_admin @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgePause<'info> {
    pub bridge_pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = bridge_pauser @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
pub struct BridgeUnpause<'info> {
    pub bridge_unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = bridge_unpauser @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,
}

#[derive(Accounts)]
#[instruction(destination_chain_id: u16)]
pub struct BridgeNonceAdmin<'info> {
    #[account(mut)]
    pub nonce_admin: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = bridge_config.bump,
        has_one = nonce_admin @ LitePsmError::Unauthorized
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init_if_needed,
        payer = nonce_admin,
        space = BridgeNonce::LEN,
        seeds = [BridgeNonce::SEED, &destination_chain_id.to_le_bytes()],
        bump
    )]
    pub bridge_nonce: Account<'info, BridgeNonce>,

    pub system_program: Program<'info, System>,
}
