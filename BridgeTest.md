# OkuMoney Testnet Deployment & Bridge Testing Plan

> **Goal**: Bidirectional EVM ↔ SVM bridge using native OkuBridge only.
> No third-party adapters (NTT, CCIP) in scope — those come later.

---

## Chain ID Convention

Solana has no native EVM-style numeric chain ID — clusters are identified by genesis hash. Cross-chain protocols each define their own numbering (Wormhole uses `1`, CCIP uses uint64 selectors, etc.). OkuMoney adopts the **Ankr convention** as protocol-internal chain identifiers:

| Network | Chain ID | Notes |
|---|---|---|
| Solana Mainnet Beta | `101` | Production |
| Solana Testnet | `102` | Validator stress-testing (not used by us) |
| Solana Devnet | `103` | Development / testnet deployments |
| EVM chains | EIP-155 IDs | e.g. OP Sepolia = `11155420`, Optimism = `10` |

These are **OkuMoney protocol-internal identifiers**, not a universal standard. They appear in bridge messages, `BridgeConfig` state, and `supportedChains` mappings on both EVM and SVM.

### Codebase update required

The existing SVM test suite uses a placeholder `SOLANA_CHAIN_ID = 1151` (in `tests/bridge_security.ts` and likely in `scripts/config/constants.ts`). This must be updated to `103` (devnet) before testnet deployment. Similarly, the `initializeBridge(SOLANA_CHAIN_ID)` call in `003-initialize-psm.ts` and any hardcoded references in the EVM test suite (`ARBITRUM_CHAIN_ID`, `OPTIMISM_CHAIN_ID` in bridge tests) should be reviewed for consistency.

---

## Phase 0: Cleanup — Remove Stale `./bridge` and `./EVM/BridgeTest`

### What's stale

The repo has two legacy bridge artifacts from the pre-refactor era:

**`./bridge/`** (project root) — Old README referencing OkuUSD shares-based bridging, orchestrator listener snippets, and admin examples. All of this predates the dual-token split. The bridge no longer operates on shares; it passes raw OkuMoney token amounts. This folder has no scripts or code that would be useful going forward.

**`./EVM/BridgeTest/`** — Standalone hardhat project with `BridgeToken`, `NttBridgeAdapter`, `OFTBridgeAdapter`, and their mocks. This was a proof-of-concept for third-party adapter integration. It uses its own token contract (not OkuMoney), its own deploy scripts (`hardhat-deploy` style), and is completely disconnected from the current contract set. Third-party adapters are out of scope for this phase.

### Actions

1. **Delete `./bridge/`** entirely.
2. **Delete `./EVM/BridgeTest/`** entirely.
3. Clean up any root-level references to these folders (check root `README.md`, `.gitignore`, any CI configs).
4. Commit: `chore: remove stale bridge and BridgeTest folders`

### What we keep

- `./EVM/src/bridge/` — Production OkuBridge + OkuBridgeRouter contracts (current, tested).
- `./EVM/test/bridge/` — Foundry + Hardhat tests for the above.
- `./SVM/oku-programs/programs/lite-psm/src/instructions/bridge.rs` — SVM bridge_mint / bridge_burn.
- `./SVM/oku-programs/programs/oku-bridge-router/` — SVM convenience bridge + usdOku flows.
- `./SVM/oku-programs/tests/bridge_security.ts` — SVM bridge test suite.

---

## Phase 1: Update EVM Deploy Scripts

The existing `./EVM/scripts/deploy/` pipeline (steps 0–4) still references the old contract names from before the dual-token refactor. The structure is solid, but the names and init params need updating.

### 1.1 Contract name mapping

| Old (in scripts) | New (in contracts) | Notes |
|---|---|---|
| `OkuUSD` | `OkuMoney` | Non-rebasing, `okuMPrice()` |
| `wOkuUSD` | `OkuDollar` | Rebasing vault, `usdMultiplier()` |
| `OkuBridgeRouter` init args | Updated | Now takes `(usdOku, okuMoney, okuBridge, admin)` |

### 1.2 Script updates needed

**`1-deploy-core.ts`** — Rename OkuUSD → OkuMoney, wOkuUSD → OkuDollar. Update factory names, init args, and address book keys. OkuDollar init takes the OkuMoney address (not the other way around). RedemptionQueue takes OkuMoney address.

**`2-deploy-psm.ts`** — LitePSM init now takes both OkuMoney and OkuDollar addresses. Update `loadAddress()` calls.

**`3-deploy-bridge.ts`** — OkuBridge init takes `(okuMoney, supportedChains, orchestratorSigner, feeRecipient, admin)`. OkuBridgeRouter init takes `(usdOku, okuMoney, okuBridge, admin)`. Remove references to `wOkuUSD`. The existing script also needs to add the SVM chain ID to `supportedChains` (use `103` for Solana Devnet — see Chain ID Convention below).

**`4-configure-roles.ts`** — Update role grants for the new RBAC structure:
- OkuMoney: Grant `OKUM_MINTER` to LitePSM, OkuBridge, and OkuBridgeRouter (adapter path).
- OkuMoney: Grant `OKUM_REBASER` to deployer (for testnet orchestrator simulation).
- OkuDollar: Grant `VAULT_REBASER` to deployer.
- OkuBridge: Grant `BRIDGE_SIGNER_MANAGER`, `BRIDGE_FEE_MANAGER` to deployer.
- OkuBridge: Set minter allowance on OkuMoney for OkuBridge.
- OkuBridge: Add SVM chain ID (`103`) as supported destination.

**`config/addresses.json`** — Update key names (okuMoney, okuDollar, okuBridge, okuBridgeRouter, litePSM, redemptionQueue).

**`config/chains.ts`** — Add OP Sepolia testnet config if not present. Add Solana Devnet as a "destination" entry (chain ID `103`, not a hardhat network — just a config constant for bridge scripts).

### 1.3 New script: `5-configure-bridge-testnet.ts`

Testnet-specific bridge configuration that wouldn't run in production:

- Set bridge fee to 10 bps (0.1%).
- Set min/max bridge amounts to permissive testnet values.
- Set the orchestrator signer to the deployer's address (we'll sign manually in scripts).
- Set fee recipient to the deployer.
- Log the full config for verification.

### 1.4 Deployment target

**OP Sepolia** (chain ID 11155420). This is the primary EVM testnet. We use a single L2 testnet — no need for a second EVM chain since the counterparty is Solana Devnet.

---

## Phase 2: SVM Devnet Deployment

The SVM deploy pipeline (`./SVM/oku-programs/scripts/deploy/001–007`) is already structured and working for localnet. Devnet deployment needs minor config adjustments.

### 2.1 Pre-deployment checklist

- [ ] `Anchor.toml` — Verify `[programs.devnet]` program IDs match keypairs in `target/deploy/`.
- [ ] Ensure deployer wallet has sufficient devnet SOL (`solana airdrop 5` × several times).
- [ ] Create USDC mock mint for devnet (or use an existing devnet USDC if available).
- [ ] Create OkuMoney mint (Token-2022 with Freeze extension) and transfer mint+freeze authority to PSM PDA after initialization.

### 2.2 Deployment sequence

Run the existing numbered scripts in order:

```
001-deploy-tokens.ts     # Create OkuMoney + usdOku mints (Token-2022)
002-deploy-programs.ts   # anchor deploy (lite-psm, oku-dollar, oku-bridge-router)
003-initialize-psm.ts    # PSM config, redemption queue, bridge config, authorities
004-initialize-vault.ts  # OkuDollar vault config, link to OkuMoney
005-initialize-bridge.ts # Bridge config: fee, limits, supported chains, orchestrator
006-initialize-router.ts # Router config: link PSM + vault programs
007-verify-deployment.ts # Read all PDAs and confirm state
```

### 2.3 Bridge-specific config (step 005)

- `source_chain_id`: `103` (Solana Devnet)
- Supported destination chains: Add EVM testnet chain ID (`11155420` for OP Sepolia)
- Bridge orchestrator: Set to the deployer keypair (Ed25519 — same key signs `bridge_mint` messages)
- Fee: 10 bps
- Min bridge: 1 OkuM (1_000_000 raw, 6 decimals)
- Max bridge: 100,000 OkuM

### 2.4 Post-deployment

- Record all deployed addresses (program IDs, mints, PDAs) in `./SVM/oku-programs/deployments/devnet.json` (the existing addressBook utility handles this).
- Transfer program upgrade authorities to the deployer for testnet (no Squads needed on devnet).

---

## Phase 3: Shared Testnet Address Registry

Create a lightweight top-level config that both sub-repos reference.

### `./testnet-addresses.json`

```json
{
  "evm": {
    "network": "op-sepolia",
    "chainId": 11155420,
    "rpcUrl": "${OP_SEPOLIA_RPC_URL}",
    "contracts": {
      "okuMoney": "",
      "okuDollar": "",
      "litePSM": "",
      "redemptionQueue": "",
      "okuBridge": "",
      "okuBridgeRouter": "",
      "mockUSDC": ""
    },
    "orchestrator": ""
  },
  "svm": {
    "network": "devnet",
    "chainId": 103,
    "rpcUrl": "https://api.devnet.solana.com",
    "programs": {
      "litePsm": "",
      "okuDollar": "",
      "okuBridgeRouter": ""
    },
    "mints": {
      "okuMoney": "",
      "usdOku": "",
      "usdc": ""
    },
    "pdas": {
      "psmConfig": "",
      "bridgeConfig": "",
      "vaultConfig": "",
      "routerConfig": ""
    },
    "orchestrator": ""
  }
}
```

Both EVM and SVM bridge scripts import this file to resolve cross-chain addresses. Populate after Phases 1 and 2.

---

## Phase 4: EVM Bridge Testing Scripts

All scripts go in `./EVM/scripts/bridge/`. These are hardhat scripts, run manually.

### 4.1 `bridge-burn-to-solana.ts` — EVM → SVM (source side)

**What it does**: Calls `OkuBridgeRouter.bridgeOkuM()` to burn OkuMoney on EVM and emit a `BridgeBurn` event destined for Solana.

**Flow**:
1. Load testnet addresses from `../../testnet-addresses.json`.
2. Mint some OkuMoney via LitePSM (deposit MockUSDC → get OkuMoney).
3. Approve OkuBridgeRouter to spend OkuMoney.
4. Call `bridgeRouter.bridgeOkuM(amount, svmChainId, recipientBytes32)`.
   - `recipientBytes32`: The Solana recipient wallet pubkey, left-padded to 32 bytes.
5. Parse the `BridgeBurn` event from the tx receipt.
6. Log the `requestId`, `nonce`, `amount`, `sender`, `recipient`, `deadline`.
7. Write a `bridge-request.json` file with all fields needed for the SVM mint side.

**Decimal note**: The EVM bridge burns 18-decimal OkuMoney. The orchestrator (Phase 5 scripts) must convert to 6-decimal for SVM minting. This conversion happens in the relay script, not in the contracts.

### 4.2 `bridge-mint-from-solana.ts` — SVM → EVM (destination side)

**What it does**: Given a bridge request originating from Solana, constructs and submits a `bridgeMint()` call on the EVM OkuBridge.

**Flow**:
1. Read bridge request params (from a `bridge-request.json` or CLI args): `sourceChainId`, `destChainId`, `sender`, `recipient`, `amount`, `nonce`, `deadline`.
2. Construct the EIP-712 `BridgeRequest` typed data.
3. Sign with the deployer's private key (acting as orchestrator).
4. Call `okuBridge.bridgeMint(request, signature)`.
5. Verify recipient's OkuMoney balance increased by `amount`.
6. Log success.

**Decimal note**: The `amount` in the EIP-712 message is in 18-decimal (EVM-native). The relay script (Phase 5) converts the 6-decimal SVM burn amount to 18-decimal before constructing this message.

### 4.3 `bridge-usdoku-to-solana.ts` — EVM → SVM via OkuDollar

Same as 4.1 but uses `bridgeRouter.bridgeUsdOku(usdAmount, svmChainId, recipientBytes32)`:
1. Mint OkuMoney → wrap to OkuDollar.
2. Approve OkuBridgeRouter for OkuDollar.
3. Router unwraps OkuDollar → OkuMoney → OkuBridge.bridgeBurn().
4. Parse event, write request file.

### 4.4 `check-bridge-state.ts` — Read-only diagnostics

Queries and logs:
- OkuBridge: supported chains, fee, min/max, authorized signer, nonces per chain, paused state.
- Recent `BridgeBurn` / `BridgeMint` events.
- Pending refund requests.

---

## Phase 5: SVM Bridge Testing Scripts

All scripts go in `./SVM/oku-programs/scripts/bridge/`. These are tsx scripts using Anchor + web3.js.

### 5.1 `bridge-burn-to-evm.ts` — SVM → EVM (source side)

**What it does**: Calls `bridge_burn` on the lite-psm program to burn OkuMoney on Solana and emit a bridge event destined for EVM.

**Flow**:
1. Load testnet addresses from `../../testnet-addresses.json`.
2. Mint some OkuMoney via PSM (`mint_oku_m` with devnet USDC).
3. Build `bridge_burn` transaction:
   - `amount`: raw 6-decimal amount.
   - `recipient`: EVM address as `[u8; 20]`.
   - `destination_chain_id`: `11155420` (OP Sepolia).
4. Send and confirm.
5. Parse the `BridgeBurn` event from tx logs.
6. Log `nonce`, `amount`, `requestId`.
7. Write `bridge-request.json` with all fields needed for EVM mint side.

### 5.2 `bridge-mint-from-evm.ts` — EVM → SVM (destination side)

**What it does**: Given a bridge request originating from EVM, constructs and submits a `bridge_mint` call on Solana.

**Flow**:
1. Read bridge request params from `bridge-request.json` or CLI args.
2. Construct the 80-byte bridge message:
   ```
   [source_chain_id: u16 LE]
   [dest_chain_id: u16 LE]
   [sender: 20 bytes (EVM address)]
   [recipient: 32 bytes (Solana wallet pubkey)]
   [amount: u64 LE (6-decimal)]
   [nonce: u64 LE]
   [deadline: i64 LE]
   ```
3. Sign the message with Ed25519 (deployer keypair acting as orchestrator).
4. Build transaction with `Ed25519Program.createInstructionWithPrivateKey()` as instruction 0, followed by `bridge_mint`.
5. Derive the `ProcessedRequest` PDA from `keccak256(message)` — ensure it doesn't already exist (replay check).
6. Send and confirm.
7. Verify recipient ATA balance increased.

### 5.3 `bridge-usdoku-to-evm.ts` — SVM → EVM via OkuDollar

Uses the `bridge_usd_oku` convenience instruction on oku-bridge-router:
1. Mint OkuMoney → wrap to usdOku via vault.
2. Call `bridge_usd_oku(amount, recipient, destination_chain_id)`.
3. Router CPI: unwrap usdOku → OkuMoney → `bridge_burn`.
4. Parse event, write request file.

### 5.4 `check-bridge-state.ts` — Read-only diagnostics

Queries and logs:
- BridgeConfig PDA: fee, min/max, orchestrator, supported chains, paused.
- BridgeNonce PDA for each supported chain.
- Recent bridge events from tx history.

---

## Phase 6: Manual Relay Scripts (Orchestrator Simulation)

These scripts simulate what the production orchestrator will do. They read a `bridge-request.json` produced by a source-side burn script and submit the corresponding mint on the destination.

### 6.1 `./EVM/scripts/bridge/relay-from-solana.ts`

1. Read SVM burn event data from `bridge-request.json`.
2. **Decimal conversion**: Multiply 6-decimal SVM amount by `1e12` to get 18-decimal EVM amount.
3. Construct EIP-712 `BridgeRequest` struct.
4. Sign with deployer key (ECDSA).
5. Submit `okuBridge.bridgeMint(request, signature)` on OP Sepolia.
6. Log result.

### 6.2 `./SVM/oku-programs/scripts/bridge/relay-from-evm.ts`

1. Read EVM burn event data from `bridge-request.json`.
2. **Decimal conversion**: Divide 18-decimal EVM amount by `1e12` to get 6-decimal SVM amount. (Floor division — dust stays on source chain.)
3. **Fee handling**: The fee was already deducted on the source chain. The `bridgedAmount` (post-fee) from the EVM `BridgeBurn` event is what gets minted on SVM.
4. Construct 80-byte message.
5. Sign with deployer keypair (Ed25519).
6. Build tx: Ed25519 instruction + `bridge_mint`.
7. Submit on Devnet.
8. Log result.

### Key invariant: amount reconciliation

```
EVM burn:  amount_18 (18 decimals) → fee deducted on-chain → net_18 emitted in event
Relay:     net_6 = net_18 / 1e12  (floor)
SVM mint:  net_6 minted to recipient

SVM burn:  amount_6 (6 decimals) → fee deducted on-chain → net_6 emitted in event
Relay:     net_18 = net_6 * 1e12
EVM mint:  net_18 minted to recipient
```

Fees are always deducted on the source chain. The relay script converts the **post-fee** amount. No double-fee.

---

## Phase 7: End-to-End Bridge Test Runbook

### Test 1: EVM → SVM (OkuMoney direct)

```bash
# Terminal 1 (EVM)
cd EVM
NETWORK=op-sepolia npx hardhat run scripts/bridge/bridge-burn-to-solana.ts --network op-sepolia
# → produces bridge-request.json

# Terminal 2 (SVM)
cd SVM/oku-programs
NETWORK=devnet tsx scripts/bridge/relay-from-evm.ts --request ../../EVM/bridge-request.json
# → mints OkuMoney on Solana Devnet

# Verify
NETWORK=devnet tsx scripts/bridge/check-bridge-state.ts
```

**Expected outcome**: Recipient's Solana ATA has `floor(net_18 / 1e12)` OkuMoney tokens (6 decimals). ProcessedRequest PDA exists with correct amount.

### Test 2: SVM → EVM (OkuMoney direct)

```bash
# Terminal 1 (SVM)
cd SVM/oku-programs
NETWORK=devnet tsx scripts/bridge/bridge-burn-to-evm.ts
# → produces bridge-request.json

# Terminal 2 (EVM)
cd EVM
NETWORK=op-sepolia npx hardhat run scripts/bridge/relay-from-solana.ts --network op-sepolia \
  --request ../SVM/oku-programs/bridge-request.json
# → mints OkuMoney on OP Sepolia

# Verify
NETWORK=op-sepolia npx hardhat run scripts/bridge/check-bridge-state.ts --network op-sepolia
```

**Expected outcome**: Recipient's EVM address has `net_6 * 1e12` OkuMoney tokens (18 decimals). Nonce incremented on SVM BridgeNonce PDA.

### Test 3: Round-trip (EVM → SVM → EVM)

Run Test 1, then bridge the received SVM tokens back via Test 2. Verify final EVM balance accounts for two fee deductions and any floor-division dust loss.

**Dust loss bound**: At most 1 unit of 6-decimal precision per direction = at most `2e12` wei (18-decimal) lost over a round trip. This is < $0.000001 at any reasonable OkuM price.

### Test 4: OkuDollar path (EVM → SVM)

```bash
cd EVM
NETWORK=op-sepolia npx hardhat run scripts/bridge/bridge-usdoku-to-solana.ts --network op-sepolia
# Router unwraps OkuDollar → OkuMoney → bridge burn
# → produces bridge-request.json (same format — it's OkuMoney by the time it hits the bridge)

cd SVM/oku-programs
NETWORK=devnet tsx scripts/bridge/relay-from-evm.ts --request ../../EVM/bridge-request.json
```

### Test 5: Refund flow

Intentionally let a bridge request expire (set a short deadline), then test the refund mechanism:
- **EVM**: Two-step — `BRIDGE_REFUND_INITIATOR` calls `initiateRefund()`, then `BRIDGE_REFUND_CONFIRMER` calls `confirmRefund()`.
- **SVM**: Single-step — refund admin calls `refund_bridge_request()` after deadline passes.

---

## Phase 8: Cleanup and Documentation

### 8.1 Update root README

Add a "Testnet Deployment" section pointing to `testnet-addresses.json` and this plan document.

### 8.2 EVM scripts README

Update `./EVM/scripts/README.md` to:
- Reflect renamed contracts (OkuMoney, OkuDollar).
- Document the new `scripts/bridge/` directory.
- Add bridge testing commands to the quick-start section.

### 8.3 SVM scripts README

Add `scripts/bridge/` documentation to `./SVM/oku-programs/scripts/` (or the SVM README).

### 8.4 Update deploy script naming (EVM)

The existing scripts reference the pre-refactor names throughout. Beyond the functional changes in Phase 1, update all user-facing strings (logger messages, comments, variable names) to use the current naming consistently.

---

## Summary: File Tree After Completion

```
contracts/
├── testnet-addresses.json          # Shared cross-chain address registry
├── testnet-bridge-plan.md          # This document
│
├── EVM/
│   ├── scripts/
│   │   ├── deploy/
│   │   │   ├── 0-deploy-mock-usdc.ts
│   │   │   ├── 1-deploy-core.ts          # Updated: OkuMoney + OkuDollar
│   │   │   ├── 2-deploy-psm.ts           # Updated: both token addresses
│   │   │   ├── 3-deploy-bridge.ts        # Updated: OkuBridge + Router
│   │   │   ├── 4-configure-roles.ts      # Updated: new RBAC roles
│   │   │   └── 5-configure-bridge-testnet.ts  # NEW
│   │   ├── bridge/                        # NEW
│   │   │   ├── bridge-burn-to-solana.ts
│   │   │   ├── bridge-usdoku-to-solana.ts
│   │   │   ├── bridge-mint-from-solana.ts
│   │   │   ├── relay-from-solana.ts
│   │   │   └── check-bridge-state.ts
│   │   └── ...existing...
│   └── ...
│
├── SVM/
│   └── oku-programs/
│       ├── scripts/
│       │   ├── deploy/
│       │   │   └── ...existing 001–007...
│       │   ├── bridge/                    # NEW
│       │   │   ├── bridge-burn-to-evm.ts
│       │   │   ├── bridge-usdoku-to-evm.ts
│       │   │   ├── bridge-mint-from-evm.ts
│       │   │   ├── relay-from-evm.ts
│       │   │   └── check-bridge-state.ts
│       │   └── ...existing...
│       └── ...
│
├── bridge/           # DELETED
└── EVM/BridgeTest/   # DELETED
```

---

## Execution Order

| Step | Phase | Description | Depends on |
|------|-------|-------------|------------|
| 1 | 0 | Delete `./bridge/` and `./EVM/BridgeTest/` | — |
| 2 | 1 | Update EVM deploy scripts (rename + fix init params) | Step 1 |
| 3 | 1 | Deploy EVM contracts to OP Sepolia | Step 2 |
| 4 | 2 | Deploy SVM programs to Solana Devnet | — (parallel with 2–3) |
| 5 | 3 | Populate `testnet-addresses.json` | Steps 3 + 4 |
| 6 | 4 | Write EVM bridge scripts | Step 5 |
| 7 | 5 | Write SVM bridge scripts | Step 5 |
| 8 | 6 | Write relay scripts (both sides) | Steps 6 + 7 |
| 9 | 7 | Run end-to-end tests | Step 8 |
| 10 | 8 | Update docs | Step 9 |