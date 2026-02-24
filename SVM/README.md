# OkuUSD — Solana Programs

This directory contains the Solana implementation of OkuUSD: a yield-bearing stablecoin backed 1:1 by USDC, with native interest-bearing rebasing via Token-2022.

---

## Programs

### lite-psm
The core Peg Stability Module. Accepts USDC deposits and mints OkuUSD at 1:1. Handles redemptions, cross-chain bridging, and compliance (freeze/thaw). All program authority is held by a PDA — no EOA controls minting.

### wokusd-vault
Wraps OkuUSD into wOkuUSD, a non-rebasing SPL Token for use with DEXs and protocols that don't support Token-2022. Uses a share-based vault: depositors receive shares proportional to the pool, which appreciate as the underlying OkuUSD accrues yield.

### oku-bridge-router
Convenience program that unwraps wOkuUSD and bridges the resulting OkuUSD to an EVM chain in a single transaction.

---

## How OkuUSD Rebases

OkuUSD uses Token-2022's **Interest-Bearing extension**. The stored token amount never changes — wallets automatically display a higher UI amount over time as yield accrues:

```
ui_amount = raw_amount × e^(rate × time_elapsed)
```

The interest rate is updated by the `rebaser` role (KMS-backed orchestrator key) via the `update_interest_rate` instruction, which calls the Token-2022 program directly. The current rate is also cached in `PsmConfig` for queue redemption calculations.

---

## Basic Operations

**Mint** — User deposits USDC, receives OkuUSD 1:1. If an oracle is configured, reserves are checked before minting to ensure backing.

**Redeem** — User burns OkuUSD, receives USDC 1:1. If the USDC buffer holds sufficient funds the redemption is instant. If not, the OkuUSD is held in an escrow vault (continuing to earn yield) and a queue entry is created. The orchestrator tops up the buffer and calls `process_queue` to settle pending redemptions including accrued yield.

**Wrap / Unwrap** — Users wrap OkuUSD into wOkuUSD shares for use on older protocols, and unwrap back at any time. Unwrap is always permitted even when the vault is paused.

---

## Program Architecture

### Authority Model

Both programs use **granular per-action roles** — no single admin key. Each sensitive operation has its own authority stored in the config PDA:

| Role | Program | Held By |
|------|---------|---------|
| role_admin | PSM + Vault | Cold Multisig |
| pauser | PSM + Vault | Warm Multisig |
| unpauser | PSM + Vault | Cold Multisig |
| freezer / unfreezer | PSM | Warm / Cold Multisig |
| queue_processor, buffer_depositor | PSM | Orchestrator |
| buffer_withdrawer, oracle_manager, cap_manager, allowance_manager | PSM | Cold Multisig |
| rebaser | PSM | KMS-backed orchestrator key |

### State

- **`PsmConfig`** — single PDA holding all PSM configuration and authority pubkeys
- **`RedemptionQueue`** — fixed-size circular buffer of pending redemptions (10 entries max — see Limitations)
- **`VaultConfig`** — vault configuration, tracks `total_shares` for wOkuUSD share math
- **`BridgeConfig`** — bridge configuration, chain whitelist, fee settings
- **`BridgeNonce`** — one PDA per destination chain, tracks sequential nonce
- **`ProcessedRequest`** — one PDA per processed bridge mint, prevents replay

### Initialization

PSM initialization is three steps (to avoid BPF stack overflow with large account contexts):
1. `initialize` — creates `PsmConfig` and USDC vault
2. `setup_redemption_queue` — creates the `RedemptionQueue` PDA
3. `setup_okusd_escrow` — creates the OkuUSD escrow vault for queued redemptions
4. `initialize_bridge` — creates `BridgeConfig` (separate step)

---

## Cross-Chain Bridging (OkuBridge)

The bridge uses the **OkuBridge proprietary protocol** — an orchestrator-based relay secured by Ed25519 signatures and on-chain replay prevention.

### EVM → Solana (Mint)

1. User burns OkuUSD on EVM via `bridgeOut()`
2. Orchestrator observes the event, waits for finality
3. Orchestrator signs an 80-byte `BridgeRequest` message with its Ed25519 key
4. Orchestrator submits a Solana transaction containing:
   - An `Ed25519Program` instruction at index 0 (the signed message)
   - A `bridge_mint` instruction carrying the same message bytes + signature
5. `bridge_mint` introspects the instruction sysvar, reconstructs the expected `Ed25519Program` instruction byte-for-byte, and rejects the transaction if they don't match
6. OkuUSD is minted to the recipient on Solana

### Solana → EVM (Burn)

1. User calls `bridge_burn(amount, recipient_evm_address, destination_chain_id)`
2. A bridge fee is deducted (default 0.1%), remaining tokens are burned, fee is re-minted to the fee recipient
3. A sequential nonce is assigned per destination chain (`BridgeNonce` PDA)
4. `BridgeBurnEvent` is emitted with full metadata
5. Orchestrator observes the event, waits for finality, then submits the EVM `bridgeIn()` transaction

The `oku-bridge-router` program allows wOkuUSD holders to do this in one transaction (unwrap → bridge burn).

### Bridge Security

| Mechanism | Purpose |
|-----------|---------|
| Ed25519 signature + instruction introspection | Proves orchestrator authorized the mint; forged signatures fail |
| `ProcessedRequest` PDA (init constraint) | Replay prevention — duplicate `request_id` causes account init to fail |
| Sequential nonces per destination chain | Message ordering; `skip_nonce` available for emergency recovery |
| Deadline field (1-hour default) | Expired signatures are rejected |
| Chain whitelist | Burns to unknown chains are rejected |
| Min/max amount limits | Prevents dust attacks and oversized single transactions |
| Independent bridge pause | Bridge can be halted without pausing the PSM |

---

## Critical Design Choices

**Raw amounts, not shares, are bridged.** Token-2022's Interest-Bearing extension handles rebasing natively in Solana wallets. Bridging raw amounts is correct — the EVM side tracks shares because it implements custom `balanceOf()` rebasing, but on SVM that complexity is handled by the token program itself.

**Queue entries cap at 10.** Solana's BPF stack is limited to 4KB. The initialize context has 15+ accounts; a larger fixed array overflows the stack. The queue is a safety valve for periods when the USDC buffer runs dry — it is not intended as normal operating state.

**OkuUSD escrow during queued redemptions.** Rather than burning OkuUSD immediately when a redemption is queued, the tokens are held in the PSM's escrow vault. This means users continue earning yield on their position while they wait. At `process_queue` time, the USDC payout is calculated using `current_rate_bps` and time elapsed to compensate for the accrued yield.

**No Pyth SDK dependency.** The oracle check manually parses Pyth V2 price account bytes to avoid transitive dependency conflicts. This makes the on-chain footprint smaller and eliminates a potential supply-chain risk vector.

**Ed25519 introspection, not native verification.** Rather than passing the signature to a Rust ed25519 verify function, `bridge_mint` requires an `Ed25519Program` system instruction in the same transaction and compares its data byte-for-byte against the expected instruction. This is the canonical Solana pattern for signature verification and is enforced by the runtime.

**wOkuUSD mint authority is the vault config PDA.** Users cannot receive wOkuUSD without depositing OkuUSD. There is no external minting path.

---

## Known TODOs

- `SOLANA_CHAIN_ID` in `bridge_burn` is currently a placeholder constant (`1151`). This must be set to the correct Solana chain ID before production deployment.
