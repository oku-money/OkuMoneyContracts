# OkuMoney Bridge Report

**Date:** April 16, 2026  
**Status:** Functional on Testnet (Sepolia <-> Solana Devnet)

## Overview

The OkuMoney bridge uses an **orchestrator-signed burn-and-mint pattern** for cross-chain transfers between EVM (Ethereum/L2s) and SVM (Solana). This document describes the current operational state, known issues, and recommended improvements.

## Architecture

```
┌─────────────────┐                              ┌─────────────────┐
│   EVM Chain     │                              │   Solana        │
│   (Sepolia)     │                              │   (Devnet)      │
├─────────────────┤                              ├─────────────────┤
│                 │    1. User burns tokens      │                 │
│  OkuBridge      │ ◄──────────────────────────► │  lite-psm       │
│  OkuBridgeRouter│    2. Event emitted          │  (bridge_burn)  │
│                 │                              │                 │
│                 │    3. Orchestrator observes  │                 │
│                 │       and signs              │                 │
│                 │                              │                 │
│                 │    4. Mint on destination    │                 │
│  bridgeMint()   │ ◄──────────────────────────► │  bridge_mint()  │
└─────────────────┘                              └─────────────────┘
```

### Key Components

| Chain | Contract/Program | Address |
|-------|-----------------|---------|
| Sepolia | OkuBridge | `0x2d690F74815203FdE6298897470050daEB49aC02` |
| Sepolia | OkuBridgeRouter | `0x27EB7e560000812C25ae668f49987cb963e5827c` |
| Sepolia | OkuMoney | `0xe548f960EbB46f9DC504e4107A552309796c863b` |
| Devnet | lite-psm | `3pi3vBj7dn98C4QbrrKD1LEFacpXBtmCzY17YR6j7wNa` |
| Devnet | OkuMoney | `5AwLddkTWsBcHBoU2cmffmYmbANqLbpoaRn9zYAF8yEm` |
| Devnet | Bridge Config | `5bEDDf1HeuEXLovkBXyMS3hJBM46duobyg7RH35Va5Rj` |

### Chain ID Mapping

The SVM uses u16 for chain IDs (max 65535), while EVM uses EIP-155 IDs which can exceed this. A mapping is required:

| Chain | Internal ID (u16) | EIP-155 ID |
|-------|------------------|------------|
| Solana Devnet | 103 | N/A |
| Solana Mainnet | 101 | N/A |
| Ethereum | 1 | 1 |
| Optimism | 10 | 10 |
| Sepolia | 111 | 11155111 |
| OP Sepolia | 420 | 11155420 |
| Arbitrum | 421 | 42161 |
| Base | 845 | 8453 |

---

## Bridge Operations

### EVM → SVM (Sepolia → Devnet)

**Conceptual Flow:**
1. User approves OkuBridgeRouter to spend OkuMoney
2. User calls `bridgeRouter.bridgeOkuM(amount, destChainId, recipientBytes32)`
3. Router calls OkuBridge which burns tokens and emits `BridgeBurn` event
4. Script parses event and writes `bridge-request.json`
5. On Solana, orchestrator constructs 80-byte message and signs with Ed25519
6. Orchestrator calls `bridge_mint` with message, signature, and request_id
7. Program verifies signature and mints tokens to recipient

**Commands:**
```bash
# 1. Burn on EVM (auto-copies bridge-request.json to SVM directory)
cd ~/gfx/okuMoney/contracts/EVM
SOLANA_RECIPIENT=<base58-pubkey> npm run bridge:burn:sepolia

# 2. Mint on SVM (within 1 hour deadline)
cd ~/gfx/okuMoney/contracts/SVM/oku-programs
npm run bridge:mint:devnet
```

**Environment Variables:**
- `SOLANA_RECIPIENT` - Destination Solana wallet (base58). Defaults to deployer wallet.

### SVM → EVM (Devnet → Sepolia)

**Conceptual Flow:**
1. User calls `bridge_burn(amount, recipient, destChainId)` on lite-psm
2. Program burns tokens, collects fee, increments nonce, emits event
3. Script constructs bridge request and writes `bridge-request.json`
4. On EVM, orchestrator constructs EIP-712 typed data and signs
5. Orchestrator calls `okuBridge.bridgeMint(request, signature)`
6. Contract verifies signature and mints tokens to recipient

**Commands:**
```bash
# 1. Burn on SVM (auto-copies bridge-request.json to EVM directory)
cd ~/gfx/okuMoney/contracts/SVM/oku-programs
EVM_RECIPIENT=<0x-address> npm run bridge:burn:devnet

# 2. Mint on EVM (within 1 hour deadline)
cd ~/gfx/okuMoney/contracts/EVM
npm run bridge:mint:sepolia
```

**Environment Variables:**
- `EVM_RECIPIENT` - Destination EVM address (0x-prefixed). Defaults to deployer wallet.

---

## Known Issues & Fixes Applied

### 1. Chain ID Mismatch (Fixed)

**Problem:** EVM emits EIP-155 chain IDs (e.g., 11155111), but SVM uses u16 internal IDs (e.g., 111). The SVM message format uses u16, causing overflow errors.

**Fix:** Added chain ID conversion functions:
- `EVM/scripts/config/chains.ts`: `getBridgeChainId()`, `getEvmChainIdFromBridge()`
- `SVM/scripts/config/constants.ts`: `eip155ToInternalChainId()`, `internalToEip155ChainId()`

### 2. Recipient Encoding (Fixed)

**Problem:** EVM burn script incorrectly encoded Solana pubkeys by treating base58 as ASCII.

**Fix:** Use `bs58.decode()` to properly convert base58 pubkey to 32 raw bytes.

### 3. Event Field Names (Fixed)

**Problem:** EVM `BridgeBurn` event uses `grossAmount`, `netAmount`, `feeAmount` but script expected `amount`.

**Fix:** Updated script to destructure correct field names.

### 4. ProcessedRequest PDA Seed (Fixed)

**Problem:** Script used `"processed_request"` as seed but program uses `"bridge_request"`.

**Fix:** Changed PDA derivation to use correct seed.

### 5. Ed25519 Private Key Length (Fixed)

**Problem:** `Ed25519Program.createInstructionWithPrivateKey` expects 64-byte secret key, not 32-byte.

**Fix:** Pass full `walletKeypair.secretKey` instead of sliced version.

### 6. Duplicate Mutable Account Error (Partially Fixed)

**Problem:** When `user == feeRecipient` (common in devnet where deployer is both), Anchor rejects the transaction due to duplicate mutable accounts.

**Temporary Fix:** Update fee recipient to a different address:
```bash
npm run fix:fee-recipient:yes
```

**Proper Fix (Requires Redeploy):** Program updated to make `fee_recipient_ata` optional. When user is the fee recipient, pass `null` and the fee is effectively waived (user already burned the full amount).

### 7. Bridge Request JSON Not Copied (Fixed)

**Problem:** Users had to manually copy `bridge-request.json` between EVM and SVM directories.

**Fix:** Both burn scripts now auto-copy to the destination chain's directory.

---

## Current Limitations

### 1. One-Hour Deadline
Bridge requests expire after 1 hour. For manual testing, this can be tight. Consider increasing to 24 hours for testnet:
- EVM: `scripts/deploy/5-configure-bridge-testnet.ts` - change `BRIDGE_DEADLINE = 86400n`
- SVM: `scripts/deploy/index.ts` - change `bridgeDeadlineSecs: new BN(86400)`

### 2. Single Orchestrator
Currently, the deployer wallet acts as the orchestrator for signing. In production:
- Use a dedicated orchestrator service
- Consider multi-sig or threshold signatures
- Implement automated event watching and relaying

### 3. Manual Relay Process
The current flow requires manual script execution. Production should have:
- Automated event listeners on both chains
- Queue-based processing with retries
- Monitoring and alerting

### 4. Fee Recipient Configuration
Devnet has `feeRecipient == deployer` which causes issues. Production should use a dedicated treasury address.

---

## Recommended Contract/Program Changes

### SVM (lite-psm) - Implemented, Needs Redeploy

1. **Optional Fee Recipient ATA** ✅ (Code done, needs deploy)
   ```rust
   // contexts/bridge.rs
   pub fee_recipient_ata: Option<Box<InterfaceAccount<'info, TokenAccountInterface>>>,
   ```
   - Allows passing `null` when user == feeRecipient
   - Fee is waived (user already burned full amount)

### SVM - Future Improvements

2. **Configurable Deadline**
   - Add admin instruction to update `bridge_deadline_secs` without redeployment
   - Currently hardcoded at initialization

3. **Fee Recipient Validation**
   - Prevent setting fee recipient to deployer/admin addresses
   - Or explicitly handle the user == feeRecipient case in program logic

### EVM (OkuBridge) - Future Improvements

1. **Chain ID Mapping Storage**
   - Store internal-to-EIP155 mapping on-chain
   - Allow admin to add new chain mappings without contract upgrade

2. **Batch Bridge Operations**
   - Allow minting multiple bridge requests in a single transaction
   - Reduces gas costs for orchestrator

3. **Event Indexing Improvements**
   - Add more indexed fields to `BridgeBurn` event for easier filtering
   - Consider adding block number to request ID calculation

---

## File Reference

### EVM Scripts
| File | Purpose |
|------|---------|
| `scripts/bridge/bridge-burn-to-solana.ts` | Burn OkuMoney on EVM, generate bridge request |
| `scripts/bridge/bridge-mint-from-solana.ts` | Mint OkuMoney on EVM from SVM burn |
| `scripts/bridge/check-bridge-state.ts` | Query bridge configuration and state |
| `scripts/config/chains.ts` | Chain ID mappings and conversions |

### SVM Scripts
| File | Purpose |
|------|---------|
| `scripts/bridge/bridge-burn-to-evm.ts` | Burn OkuMoney on SVM, generate bridge request |
| `scripts/bridge/bridge-mint-from-evm.ts` | Mint OkuMoney on SVM from EVM burn |
| `scripts/bridge/check-bridge-state.ts` | Query bridge configuration and state |
| `scripts/config/constants.ts` | Chain ID mappings and conversions |
| `scripts/deploy/fix-bridge-fee-recipient.ts` | Update fee recipient address |

### NPM Scripts
```bash
# EVM
npm run bridge:burn:sepolia      # Burn and generate request
npm run bridge:mint:sepolia      # Mint from SVM burn
npm run bridge:state:sepolia     # Check bridge state

# SVM
npm run bridge:burn:devnet       # Burn and generate request
npm run bridge:mint:devnet       # Mint from EVM burn
npm run bridge:state:devnet      # Check bridge state
npm run fix:fee-recipient:yes    # Fix fee recipient issue
```

---

## Testing Checklist

- [x] EVM → SVM bridge (Sepolia → Devnet)
- [x] SVM → EVM bridge (Devnet → Sepolia) - after fee recipient fix
- [ ] Bridge with different user and fee recipient
- [ ] Bridge expiration and refund flow
- [ ] Bridge with maximum amounts
- [ ] Bridge with minimum amounts
- [ ] Multi-hop bridge (if applicable)

---

## Security Considerations

1. **Orchestrator Key Security**: The orchestrator private key can mint unlimited tokens. Must be heavily protected.

2. **Replay Protection**: Both chains track processed request IDs to prevent replay attacks.

3. **Deadline Enforcement**: Signatures expire after the deadline to prevent stale requests.

4. **Nonce Ordering**: Sequential nonces per destination chain ensure ordering.

5. **Two-Step Refunds**: Refunds require two different keys (initiator + confirmer) to prevent single-key abuse.
