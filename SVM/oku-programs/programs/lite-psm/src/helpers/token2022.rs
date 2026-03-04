use anchor_lang::prelude::*;

/// CPI helper: invoke Token-2022 InterestBearingMintExtension::UpdateRate
pub fn cpi_update_token2022_rate<'info>(
    token_2022_program: &AccountInfo<'info>,
    okusd_mint: &AccountInfo<'info>,
    rate_authority: &AccountInfo<'info>,
    new_rate: i16,
) -> Result<()> {
    use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

    let mut data = Vec::with_capacity(4);
    data.push(33u8); // TokenInstruction::InterestBearingMintExtension
    data.push(1u8);  // InterestBearingMintInstruction::UpdateRate
    data.extend_from_slice(&new_rate.to_le_bytes());

    let ix = Instruction {
        program_id: token_2022_program.key(),
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(
                okusd_mint.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                rate_authority.key(),
                true,
            ),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            okusd_mint.clone(),
            rate_authority.clone(),
        ],
    )?;

    Ok(())
}
