use crate::errors::OkuError;
use anchor_lang::prelude::*;

/// Verify Ed25519 signature via instruction introspection
/// Solana's Ed25519Program must be called in the same transaction with signature data
/// This function verifies that signature check was performed correctly
/// Production pattern: Don't parse - construct expected instruction and compare
pub fn verify_ed25519_signature<'info>(
    instructions_sysvar: &AccountInfo<'info>,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    use anchor_lang::solana_program::{
        ed25519_program, sysvar::instructions::load_instruction_at_checked,
    };

    // 1. Load what was actually passed (index 0 = first ix in tx)
    let actual_ix = load_instruction_at_checked(0, instructions_sysvar)
        .map_err(|_| OkuError::InvalidSignature)?;

    // 2. Verify program ID matches Ed25519Program
    require!(
        actual_ix.program_id == ed25519_program::ID,
        OkuError::InvalidSignature
    );

    // 3. Build expected instruction data manually
    let expected_data =
        build_ed25519_instruction_data(expected_pubkey, expected_message, signature);

    // 4. Byte-for-byte comparison
    // If orchestrator signed different message or used different key, bytes won't match
    require!(actual_ix.data == expected_data, OkuError::InvalidSignature);

    Ok(())
}

/// Build Ed25519 instruction data that matches TypeScript's Ed25519Program.createInstructionWithPublicKey
pub fn build_ed25519_instruction_data(
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Vec<u8> {
    // Ed25519 instruction format (single signature, all data inline):
    // Header: 16 bytes, then PUBLIC KEY FIRST (32), signature (64), message (variable)
    // This matches TypeScript's Ed25519Program.createInstructionWithPublicKey

    let pubkey_offset: u16 = 16;
    let signature_offset: u16 = 16 + 32;
    let message_offset: u16 = 16 + 32 + 64;
    let message_size: u16 = message.len() as u16;

    let mut data = Vec::with_capacity(112 + message.len());

    // Header
    data.push(1); // num_signatures
    data.push(0); // padding
    data.extend_from_slice(&signature_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // sig in this ix
    data.extend_from_slice(&pubkey_offset.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // pubkey in this ix
    data.extend_from_slice(&message_offset.to_le_bytes());
    data.extend_from_slice(&message_size.to_le_bytes());
    data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // message in this ix

    // Payload: pubkey FIRST, then signature, then message
    data.extend_from_slice(pubkey);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);

    data
}
