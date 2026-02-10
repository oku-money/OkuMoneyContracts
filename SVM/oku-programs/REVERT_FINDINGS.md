# Revert Attempt - Key Findings

## Summary

We reverted to the original CLAUDE.md design and confirmed:
1. **The original design HAS a security flaw** (InvalidRequestId error)
2. **Our diagnosis was correct** - the recipient account needs explicit validation
3. **Anchor has serialization issues** with `[u8; 32]` parameters (truncates last 8 bytes)

## What We Discovered

### Original CLAUDE.md Issue (Confirmed)
```
Error: InvalidRequestId (0x1784 / 6020)
Location: programs/lite-psm/src/lib.rs:518
```

The constraint:
```rust
#[account(
    mut,
    token::mint = okusd_mint,
    token::token_program = token_2022_program,
)]
pub recipient_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>
```

**Problem**: Only validates mint and program, NOT the specific address.
**Attack**: Someone could pass a different ATA (with same mint) and steal funds.

### Attempted Fixes & Results

**Attempt 1: `recipient_owner: Pubkey`**
- Pass the wallet owner, validate ATA belongs to it
- **Failed**: Pubkey deserialization corrupts the value
- TypeScript sends: `3g9iB8mCsibUwWKYfkL4vSpm9CCqH4viLbUk9M22sVhV`
- Rust receives: Different address entirely

**Attempt 2: `recipient_ata: [u8; 32]`**
- Pass ATA address as byte array
- **Failed**: Anchor truncates last 8 bytes during serialization
- First 24 bytes: ✅ Correct
- Last 8 bytes: ❌ Become zeros or garbage

**Debug Evidence:**
```
Actual:    [9, 93, 60, ..., 5, 17, 35, 79, 46, 200, 161, 215]
Parameter: [9, 93, 60, ..., 50, 139, 137, 119, 176, 11, 23, 0, 0, 0, 0, 0]
                                            └─ Last 8 bytes corrupted
```

## Conclusion

1. **CLAUDE.md needs updating** - the design has a real security issue
2. **Anchor limitation discovered** - cannot reliably pass `[u8; 32]` parameters
3. **Next steps**: Either find Anchor workaround or use alternative validation approach

The revert experiment was valuable - it confirmed our analysis and revealed Anchor's limitations.
