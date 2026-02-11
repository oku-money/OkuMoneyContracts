# OkuUSD Contracts

Smart contracts for OkuUSD, a yield-bearing stablecoin backed 1:1 by US Treasury Bills.

## Overview

OkuUSD is a centralized, regulated stablecoin product operated by Oku Money (FinCEN-registered MSB). Users deposit USDC, receive OkuUSD, and earn T-Bill yield automatically through a rebasing mechanism.

**This is not a DeFi protocol.** It's institutional-grade infrastructure for delivering government yield on-chain.

## Architecture

```
                    ┌─────────────────────────┐
                    │    Off-Chain           │
                    │    Orchestrator        │
                    │    (Cloud KMS)         │
                    └───────────┬────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
   ┌─────────┐            ┌─────────┐            ┌─────────┐
   │ Ethereum│            │ Arbitrum│            │ Solana  │
   │   EVM   │            │   EVM   │            │   SVM   │
   └─────────┘            └─────────┘            └─────────┘
```

### Dual-Token Model

| Token | Type | Purpose |
|-------|------|---------|
| **OkuUSD** | Rebasing | Hold and watch your balance grow |
| **wOkuUSD** | Static (Vault) | Use in DeFi (AMMs, lending, etc.) |

Users choose based on their needs:
- **Retail**: Hold OkuUSD directly, balance increases automatically
- **DeFi**: Wrap to wOkuUSD for compatibility with Uniswap, Aave, etc.

### Core Components

| Component | Function |
|-----------|----------|
| **OkuUSD** | Rebasing token — balance grows as T-Bill yield accrues |
| **wOkuUSD** | ERC-4626 vault (EVM) / SPL vault (Solana) — static balance, growing exchange rate |
| **LitePSM** | Peg Stability Module — 1:1 USDC ↔ OkuUSD swaps |
| **OkuBridge** | Cross-chain bridge — burn on source, orchestrator signs, mint on destination |
| **OkuBridgeRouter** | Convenience wrapper for bridging wOkuUSD |

### Cross-Chain Bridging

OkuBridge is our proprietary, orchestrator-signed bridge:

```
User burns shares on source chain
        ↓
Orchestrator observes, waits for finality
        ↓
Orchestrator signs mint authorization (EIP-712)
        ↓
Orchestrator submits to destination (or user submits as fallback)
        ↓
Destination verifies signature, mints shares to recipient
```

**Key properties:**
- Bridges **shares**, not tokens (avoids rebasing issues mid-flight)
- Sequential nonces prevent replay
- Orchestrator pays destination gas by default
- User fallback with partial fee refund if orchestrator delayed

## Repository Structure

```
contracts/
├── README.md               # This file
├── CLAUDE.md               # Shared architecture & business logic
├── CLAUDE_EVM.md           # EVM implementation specifics
├── CLAUDE_SVM.md           # Solana implementation specifics
│
├── EVM/                    # Solidity contracts (Foundry)
│   ├── src/
│   │   ├── token/
│   │   │   ├── OkuUSD.sol
│   │   │   └── wOkuUSD.sol
│   │   ├── psm/
│   │   │   └── LitePSM.sol
│   │   └── bridge/
│   │       ├── OkuBridge.sol
│   │       └── OkuBridgeRouter.sol
│   ├── test/
│   ├── script/
│   └── foundry.toml
│
└── SVM/                    # Solana programs (Anchor)
    └── oku-programs/
        ├── programs/
        │   ├── lite-psm/
        │   └── wokusd-vault/
        ├── tests/
        └── Anchor.toml
```

## Implementation Differences

| Aspect | EVM | Solana |
|--------|-----|--------|
| Rebasing mechanism | Custom `balanceOf()` override | Token-2022 Interest-Bearing Extension |
| Wrapped token | ERC-4626 vault | Custom Anchor program + SPL Token |
| Blacklisting | Custom mapping | Token-2022 Freeze Authority |
| Access control | OpenZeppelin AccessControl | Config account with authority pubkeys |
| Multisig | Gnosis Safe | Squads Protocol |
| Oracle | Chainlink | Pyth Network |
| Upgradeability | TransparentUpgradeableProxy | Native program upgrade authority |

## Access Control

Granular RBAC — one role per action, multiple roles per address:

| Entity | Capabilities |
|--------|--------------|
| **Cold Multisig** | Admin, upgrades, unpause, unblacklist, supply caps |
| **Warm Multisig** | Pause, blacklist (emergency response) |
| **Orchestrator** | Rebase/rate updates, queue processing, buffer deposits |
| **Bridge Adapters** | Mint (bounded by per-adapter allowance) |

Key security properties:
- Pause and unpause are **separate roles** (compromised pauser can't undo)
- Blacklist and unblacklist are **separate roles** (deliberate recovery)
- Orchestrator **never** gets admin, upgrade, or unpause rights
- Minter allowances are **one-way decrements** (burns don't restore)

## Building

### EVM

```bash
cd EVM
forge install
forge build
forge test
```

### Solana

```bash
cd SVM/oku-programs
anchor build
anchor test
```

## Documentation

| Document | Purpose |
|----------|---------|
| `CLAUDE.md` | Shared architecture, business requirements, RBAC design |
| `CLAUDE_EVM.md` | Solidity patterns, OpenZeppelin usage, Foundry testing |
| `CLAUDE_SVM.md` | Anchor patterns, Token-2022, PDA structures |
| `OkuMoney_Technical_Architecture.docx` | Formal architecture specification |
| `OkuUSD_Decision_Matrix.docx` | Design decision rationale |

## Security

### Audits

*[To be updated after audits]*

### Bug Bounty

*[To be updated after launch]*

### Contact

Security issues: security@oku.money

## License

*[To be determined]*