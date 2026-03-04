use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use crate::errors::OkuError;
use crate::state::PsmConfig;

#[derive(Accounts)]
pub struct UpdateInterestRate<'info> {
    /// Rate authority - must be the designated rate authority on the mint
    /// Rebaser role (typically orchestrator KMS-backed signer)
    #[account(
        constraint = rebaser.key() == config.rebaser @ OkuError::Unauthorized
    )]
    pub rebaser: Signer<'info>,

    /// PSM config - stores current_rate_bps for queue processing
    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, PsmConfig>,

    /// OkuUSD mint (Token-2022 with Interest Bearing extension)
    /// CHECK: Validated by Token-2022 program - must have rebaser as the rate authority
    #[account(mut, address = config.okusd_mint)]
    pub okusd_mint: UncheckedAccount<'info>,

    /// Token-2022 program
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct SetNextYieldRate<'info> {
    /// Rebaser role - only rebaser can schedule next rate
    #[account(constraint = rebaser.key() == config.rebaser @ OkuError::Unauthorized)]
    pub rebaser: Signer<'info>,

    /// PSM config - stores rate scheduling state
    #[account(mut, seeds = [PsmConfig::SEED], bump = config.bump)]
    pub config: Account<'info, PsmConfig>,
}
