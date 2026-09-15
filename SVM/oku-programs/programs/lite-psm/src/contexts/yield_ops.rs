use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint as MintInterface;

/// Context shared by all three rate-schedule writers
/// (`set_okum_yield_rate`, `set_next_okum_yield_rate`,
/// `set_okum_yield_rate_with_successor`).
///
/// Note what is absent: **the mint**. The rate schedule lives entirely on
/// `PsmConfig`, and changing it writes nothing to the token. That is the
/// structural difference from the old discrete model, where every yield
/// operation had to CPI into Token-2022. It also means these instructions
/// cannot fail on a token-program error, which matters because they are the
/// ones that must land reliably at epoch boundaries.
#[derive(Accounts)]
pub struct SetYieldRate<'info> {
    /// Rebaser role — the single authority over yield on both stacks.
    /// EVM mirror: `Roles.OKUM_REBASER`.
    pub rebaser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,
}

/// Context for the emergency multiplier override.
///
/// The mint is MUTABLE because this instruction force-syncs the display
/// mirror rather than waiting for the next crank. That is not an
/// optimisation — it closes a real inversion of the mirror's safety
/// invariant. An earlier sync may have pre-armed a step computed under the
/// old, still-running schedule; the override halts that schedule, so the
/// outstanding pre-armed value can exceed the new canonical multiplier. The
/// strict-increase check guards against the CURRENT canonical value, not
/// against an already-armed future one. Writing the display immediately (with
/// no pre-arm) overwrites the stale step and collapses the window to zero.
#[derive(Accounts)]
pub struct SetOkuMMultiplier<'info> {
    pub rebaser: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
        has_one = rebaser @ LitePsmError::Unauthorized
    )]
    pub config: Account<'info, PsmConfig>,

    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}

/// Context for the permissionless display-mirror crank.
///
/// **No signer constraint by design.** The value written is a pure function of
/// `PsmConfig` and the clock, so the caller chooses nothing; the `PsmConfig`
/// PDA — not the caller — signs the CPI to Token-2022. Gating this on the
/// rebaser would make wallet display freshness depend on operator liveness
/// while adding no security.
#[derive(Accounts)]
pub struct SyncDisplayMultiplier<'info> {
    /// Anyone. Pays the transaction fee; gains nothing else.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [PsmConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, PsmConfig>,

    /// Mutable: the `UpdateMultiplier` CPI writes the extension.
    #[account(
        mut,
        address = config.oku_m_mint,
        mint::token_program = token_2022_program
    )]
    pub oku_m_mint: InterfaceAccount<'info, MintInterface>,

    pub token_2022_program: Program<'info, Token2022>,
}
