# Bridge Router Needs Update

The `oku-bridge-router` program needs to be updated to match the new secure `bridge_burn` signature in `lite-psm`.

## Changes Required:

The `bridge_burn` function now requires:
- `recipient: [u8; 20]` - EVM address parameter
- Additional accounts: `bridge_config`, `bridge_nonce`, `fee_recipient_ata`, `system_program`

This router program is outside the scope of the current SVM bridge security implementation.
It should be updated or deprecated in favor of direct bridge_burn calls.

## Temporary Fix:

The program has been temporarily updated to compile, but proper integration with the secure bridge requires:
1. Passing recipient EVM address from the user
2. Including all required bridge accounts
3. Proper fee handling
