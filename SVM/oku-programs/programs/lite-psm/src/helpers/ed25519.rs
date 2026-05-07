//! Ed25519 signature verification via instruction introspection.
//!
//! The instruction-data format encoded in `build_ed25519_instruction_data` is
//! the wire format expected by Solana's Ed25519 precompile, mirroring
//! `solana-sdk`'s `ed25519_instruction.rs` and the TypeScript SDK's
//! `Ed25519Program.createInstructionWithPublicKey`. We reconstruct the
//! expected bytes and compare them against the actual instruction at the
//! introspected index instead of parsing — same trick used by Wormhole / Mayan
//! / Pyth-receiver bridges to verify off-chain signers without trusting
//! a parser.
//!
//! Taken from https://github.com/anza-xyz/agave/blob/master/sdk/src/ed25519_instruction.rs
//! Taken from https://docs.solana.com/developing/runtime-facilities/programs#ed25519-program

use crate::constants::ED25519_INSTRUCTION_SCAN_LIMIT;
use crate::errors::LitePsmError;
use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;

/// Ed25519 program ID - standard Solana precompile
pub const ED25519_PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Verify Ed25519 signature via instruction introspection
/// Solana's Ed25519Program must be called in the same transaction with signature data
/// This function verifies that signature check was performed correctly
/// Production pattern: Don't parse - construct expected instruction and compare
///
/// SECURITY: This function searches through all instructions in the transaction
/// to find the Ed25519 program instruction, rather than hardcoding an index.
/// This handles variable transaction layouts (e.g., compute budget instructions).
pub fn verify_ed25519_signature<'info>(
    instructions_sysvar: &AccountInfo<'info>,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    // Build expected instruction data first
    let expected_data =
        build_ed25519_instruction_data(expected_pubkey, expected_message, signature);

    // Search through instructions to find the Ed25519 program instruction.
    // We check indices 0..ED25519_INSTRUCTION_SCAN_LIMIT which covers all
    // reasonable transaction layouts (compute budget + priority fee +
    // ed25519 + our instruction + versioned lookups + extras).
    let mut found_valid_signature = false;

    for ix_index in 0..(ED25519_INSTRUCTION_SCAN_LIMIT as i16) {
        // Try to load instruction at this index
        // Use get_instruction_relative with offset from current instruction
        let ix_result = load_instruction_at_checked(ix_index as usize, instructions_sysvar);

        let actual_ix = match ix_result {
            Ok(ix) => ix,
            Err(_) => break, // No more instructions
        };

        // Check if this is an Ed25519 program instruction
        if actual_ix.program_id == ED25519_PROGRAM_ID {
            // Verify the instruction data matches what we expect
            if actual_ix.data == expected_data {
                found_valid_signature = true;
                break;
            }
            // If it's an Ed25519 instruction but data doesn't match,
            // continue searching (there might be multiple Ed25519 instructions)
        }
    }

    require!(found_valid_signature, LitePsmError::InvalidSignature);

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
