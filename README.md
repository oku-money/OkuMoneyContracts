# OkuUSD Contracts

Smart contracts for OkuUSD, a yield-bearing stablecoin backed 1:1 by US Treasury Bills, operated by Oku Money (FinCEN-registered MSB).

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

## Core Components

| Component | Function |
|-----------|----------|
| **OkuUSD** | Rebasing token — balance grows as T-Bill yield accrues |
| **wOkuUSD** | ERC-4626 vault (EVM) / SPL vault (Solana) — static balance, growing exchange rate |
| **LitePSM** | Peg Stability Module — 1:1 USDC ↔ OkuUSD swaps |
| **OkuBridge** | Cross-chain bridge — orchestrator-signed burn/mint |
| **OkuBridgeRouter** | User entry point for bridging OkuUSD and wOkuUSD |

## Repository Structure

```
contracts/
├── README.md               # This file
├── CLAUDE.md               # Shared architecture & business logic
│
├── EVM/                    # Solidity contracts (Foundry)
│   ├── CLAUDE.md           # EVM implementation specifics
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
    ├── CLAUDE.md           # Solana implementation specifics
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
| Upgradeability | TransparentUpgradeableProxy / UUPS | Native program upgrade authority |

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
| `EVM/CLAUDE.md` | EVM Solidity patterns, OpenZeppelin usage, Foundry testing |
| `SVM/CLAUDE.md` | Solana/Anchor patterns, Token-2022, PDA structures |
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
