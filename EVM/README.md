# OkuUSD EVM Contracts

Solidity smart contracts for OkuUSD — a yield-bearing stablecoin backed 1:1 by US Treasury Bills.

See [`CLAUDE.md`](./CLAUDE.md) for full technical documentation (architecture, storage layouts, role definitions, testing guidance).

## Contracts

| Contract | Description |
|----------|-------------|
| `OkuUSD.sol` | Rebasing ERC-20 stablecoin |
| `wOkuUSD.sol` | ERC-4626 non-rebasing vault wrapper |
| `LitePSM.sol` | Peg Stability Module — 1:1 USDC ↔ OkuUSD |
| `OkuBridge.sol` | Native cross-chain bridge (burn/mint with EIP-712 orchestrator signatures) |
| `OkuBridgeRouter.sol` | User entry point for bridging OkuUSD and wOkuUSD |
| `NttAdapter.sol` | Wormhole NTT bridge adapter (third-party adapter path) |

## Quick Start

```bash
# Install dependencies
forge install

# Build
forge build

# Run all tests
forge test

# Run specific contract tests
forge test --match-contract OkuUSDTest -vv
forge test --match-contract OkuBridgeTest -vv
forge test --match-contract OkuBridgeRouterTest -vv
```

## Hardhat (Fork Tests)

```bash
npm install
npx hardhat test
```

## Stack

- **Solidity** 0.8.28 / EVM Cancun
- **Foundry** (Forge, Cast, Anvil)
- **OpenZeppelin Contracts** v5 (Upgradeable)
- **Proxy Pattern**: TransparentUpgradeableProxy (token/PSM) / UUPS (bridge contracts)
