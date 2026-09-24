use crate::contexts::MigrateConfigSpace;
use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

/// Byte offset of `role_admin` within the account: 8-byte discriminator +
/// 1-byte `bump`. Stable across the resize because fields are only ever
/// appended at the tail.
const ROLE_ADMIN_OFFSET: usize = 8 + 1;

/// Grow `PsmConfig` to the current `PsmConfig::LEN`, zeroing the new tail.
///
/// Exists because the config is a singleton PDA holding every role assignment
/// and the accrual anchor: without an in-place resize the only way to add a
/// field is to close and re-initialise, which discards all of it. The account
/// now carries tail padding (`PsmConfig::reserved`) so this should not be
/// needed again — a field appended into that padding leaves `LEN` unchanged.
///
/// Idempotent: a no-op once the account is already at `LEN`. Only ever grows.
pub fn migrate_config_space(ctx: Context<MigrateConfigSpace>) -> Result<()> {
    let info = ctx.accounts.config.to_account_info();
    let current_len = info.data_len();
    let target_len = PsmConfig::LEN;

    if current_len == target_len {
        msg!("psm_config already {} bytes; nothing to do", target_len);
        return Ok(());
    }
    // Shrinking would truncate live fields.
    require!(current_len < target_len, LitePsmError::Unauthorized);

    {
        let data = info.try_borrow_data()?;
        // Confirm this really is a PsmConfig before writing to it — the seeds
        // check proves the address, not the account type.
        require!(
            data[..8] == PsmConfig::DISCRIMINATOR[..],
            LitePsmError::Unauthorized
        );

        let mut stored = [0u8; 32];
        stored.copy_from_slice(&data[ROLE_ADMIN_OFFSET..ROLE_ADMIN_OFFSET + 32]);
        require!(
            Pubkey::new_from_array(stored) == ctx.accounts.role_admin.key(),
            LitePsmError::Unauthorized
        );
    }

    // Top up to rent exemption at the new size, then resize. `zero_init = true`
    // clears the appended region so `reserved` reads as zeros.
    let rent = Rent::get()?;
    let required = rent.minimum_balance(target_len);
    let current = info.lamports();
    if required > current {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: info.clone(),
                },
            ),
            required - current,
        )?;
    }
    info.resize(target_len)?;

    msg!("psm_config resized {} -> {} bytes", current_len, target_len);
    Ok(())
}
