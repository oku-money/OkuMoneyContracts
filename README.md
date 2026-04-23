# OkuMoney Protocol

Yield-bearing stablecoin infrastructure backed by US Treasury Bills. Centralized B2B product — registered MSB, not a DeFi protocol.

## Design Philosophy

**Off-chain orchestrator architecture** for maximum operational agility:
- **Orchestrator**: Coordinates all protocol operations. Never stores private keys — constructs payloads and requests Cloud KMS signatures.
- **Direct Chain Operations**: Interacts directly with contracts via KMS-signed transactions.
- **Trust Model**: Openly centralized product for safe government yield. Users trust Oku Money to manage RWA backing and operate infrastructure responsibly.
- **Legal Framework**: Registered with FinCEN as an MSB. Licensed as a money transmitter in states where we onboard users.

## Architecture

```
                    ┌─────────────────────────┐
                    │    Off-Chain             │
                    │    Orchestrator          │
                    │    (Cloud KMS)           │
                    └───────────┬──────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
   ┌─────────┐            ┌─────────┐            ┌─────────┐
   │ Ethereum│            │ Arbitrum│            │ Solana  │
   │   EVM   │            │   EVM   │            │   SVM   │
   └─────────┘            └─────────┘            └─────────┘
```

## Dual-Token Split-Economy Model

Two tokens with independent economics, deployed on every chain:

| Token | Type | Yield | Purpose |
|-------|------|-------|---------|
| **OkuMoney (OkuM)** | Non-rebasing | Rear-facing (realized T-Bill returns) | DeFi, bridging, protocol integrations |
| **OkuDollar (usdOku)** | Rebasing ($1 peg) | Forward-facing (policy rate set by Oku) | Retail UX, "balance grows" experience |

**OkuMoney** is the solvency anchor — it only distributes yield that has already been earned. `balanceOf()` returns a static raw token count. Price appreciation is tracked separately via `okuMPrice()`, a stored value updated discretely by the orchestrator.

**OkuDollar** is a policy lever — Oku sets the yield rate independently. `balanceOf()` grows every second on EVM (continuous `_rpow` streaming) or updates discretely on SVM. OkuDollar holds OkuMoney as reserves. The spread between the two rates determines collateralization and protocol revenue.

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

## On-Chain Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        On-Chain Contracts                        │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
│  │  OkuMoney    │◄──┤  OkuDollar   │   │   LitePSM    │        │
│  │  (Non-Rebase)│   │  (Rebasing)  │   │  (USDC ↔ OkuM│        │
│  │  okuMPrice() │   │  Vault       │   │  price-aware) │        │
│  └──────┬───────┘   └──────────────┘   └──────────────┘        │
│         │                                                        │
│  ┌──────▼──────────────────────────────────────────┐            │
│  │               OkuBridge + Router                 │            │
│  │  (Burn/mint across chains, raw OkuM amounts)     │            │
│  └──────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|-----------|----------|
| **OkuMoney** | Non-rebasing base token — static balance, price appreciates via stored `okuMPrice` |
| **OkuDollar** | Rebasing $1-pegged stablecoin — balance grows, backed by OkuMoney reserves |
| **LitePSM** | Peg Stability Module — price-aware USDC ↔ OkuM, convenience usdOku functions |
| **RedemptionQueue** | FIFO queue when PSM buffer is insufficient |
| **OkuBridge** | Cross-chain bridge — orchestrator-signed burn/mint (raw OkuMoney amounts) |
| **OkuBridgeRouter** | User entry point for bridging OkuMoney and OkuDollar |

## Yield Distribution & Sandwich Prevention

OkuMoney price is updated discretely by the orchestrator via `distributeYield()` or `setOkuMPrice()`. To prevent sandwich attacks around these discrete price updates, a single-block lock is enforced:

- Both write functions set `lastYieldDistributionBlock` (EVM) / `last_yield_distribution_slot` (SVM)
- PSM and vault operations revert if executed in the same block/slot as a price update
- The lock auto-releases in subsequent blocks/slots
- No backend changes needed — protection is automatic

## PSM (Peg Stability Module)

Price-aware USDC ↔ OkuMoney swaps:

```
mintOkuM:      okuMAmount = usdcValue × PRECISION / okuMPrice()
redeemOkuM:    usdcAmount = okuMAmount × okuMPrice() / PRECISION
```

Convenience functions route through the vault for single-transaction usdOku ↔ USDC:

```
mintUsdOku:    USDC → PSM mints OkuM → wraps into vault → usdOku to user
redeemUsdOku:  usdOku → unwrap to OkuM → redeem for USDC (or queue if buffer empty)
```

## Cross-Chain Bridging

OkuBridge is a proprietary orchestrator-signed bridge. No third-party bridge dependencies for core protocol.

- Bridge transports raw OkuMoney amounts — no share conversion needed
- Subtractive fee model: fee deducted from bridged amount, collected on source chain
- EVM: ECDSA via EIP-712 | SVM: Ed25519 via instruction introspection
- Sequential nonces per destination, replay prevention via request ID tracking

The OkuBridgeRouter normalizes tokens: `bridgeUsdOku` unwraps to OkuMoney before bridging.

## RBAC (Role-Based Access Control)

One role per action. No role performs more than one function.

| Entity | Roles |
|--------|-------|
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, ORACLE_MANAGER, RESERVE_MANAGER, bridge admin roles |
| Warm Multisig | all PAUSER, all BLACKLISTER, BRIDGE_PAUSER |
| Orchestrator | OKUM_REBASER, VAULT_REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR, BRIDGE_FEE_MANAGER |
| OkuBridge | OKUM_MINTER (bridge contract on each chain) |
| LitePSM | OKUM_MINTER |
| OkuBridgeRouter | OKUM_MINTER (adapter path only, EVM) |

## EVM vs SVM Implementation Differences

| Aspect | EVM | SVM |
|--------|-----|-----|
| Language | Solidity 0.8.28 | Rust (Anchor 1.0.0) |
| OkuMoney price | Stored `uint256`, 18 decimals | Stored `u64`, 9-decimal precision (6-decimal token) |
| OkuDollar multiplier | Continuous `_rpow` streaming | Discrete orchestrator-driven updates |
| Yield lock | `block.number` comparison | `Clock::slot` comparison |
| Signature scheme | ECDSA (EIP-712) | Ed25519 (instruction introspection) |
| Token standard | ERC-20 (custom rebasing for OkuDollar) | Token-2022 (both tokens) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | On OkuBridgeRouter program (CPI coordination) |
| Bridge refund | Two-step (initiator + confirmer) | Single-step (refund admin, after deadline) |

## Directory Structure

```
contracts/
  EVM/                  # Solidity contracts (Foundry + Hardhat)
    src/
      token/            # OkuMoney.sol, OkuDollar.sol
      psm/              # LitePSM.sol, RedemptionQueue.sol
      bridge/           # OkuBridge.sol, OkuBridgeRouter.sol, adapters/
      interfaces/       # IOkuMoney.sol, IOkuDollar.sol
      lib/              # Roles.sol, Constants.sol, MathLib.sol
    test/
    scripts/

  SVM/                  # Anchor programs (Rust)
    oku-programs/
      programs/
        lite-psm/       # PSM + bridge + queue + yield ops
        oku-dollar/     # Rebasing vault
        oku-bridge-router/ # Convenience bridging + usdOku flows
      tests/
      scripts/
      deployments/      # Per-network deployment records (devnet.json, etc.)

  artifacts/            # Curated ABIs + IDLs for backend / SDK / frontend use
    evm/                # Slim Hardhat artifacts (abi + bytecode) per contract
    svm/                # Anchor IDL JSON per program
    README.md           # Consumption docs for downstream services

  testnet-addresses.json  # Canonical live deployment registry (auto-generated)
```

See `EVM/README.md` and `SVM/README.md` for chain-specific documentation, and `artifacts/README.md` for downstream-consumption docs.