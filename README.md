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

**OkuMoney** is the solvency anchor — it only distributes yield that has already been earned. `balanceOf()` returns a static raw token count. Price appreciation is tracked separately via `okuMMultiplier()` (EVM) / `PsmConfig.oku_m_price` (SVM), a stored value updated discretely by the orchestrator.

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
│  ┌────────────────┐ ┌──────────────┐   ┌──────────────┐        │
│  │  OkuMoney      │◄┤  OkuDollar   │   │   LitePSM    │        │
│  │  (Non-Rebase)  │ │  (Rebasing)  │   │  (USDC ↔ OkuM│        │
│  │ okuMMultiplier │ │  Vault       │   │  price-aware) │        │
│  └────────────────┘ └──────────────┘   └──────────────┘        │
│                                                                  │
│  (Cross-chain transfers are orchestrator-mediated via PSM        │
│   mint/burn on each chain — no on-chain bridge in v1.)           │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|-----------|----------|
| **OkuMoney** | Non-rebasing base token — static balance, price appreciates via stored `okuMMultiplier` |
| **OkuDollar** | Rebasing $1-pegged stablecoin — balance grows, backed by OkuMoney reserves |
| **LitePSM** | Peg Stability Module — price-aware USDC ↔ OkuM. Sole user-facing mint/burn surface. EVM adds `mintUsdOku` / `redeemUsdOku` convenience flows; SVM composes these off-chain in the SDK. |
| **RedemptionQueue** | FIFO queue when PSM buffer is insufficient |

## Yield Distribution & Sandwich Prevention

OkuMoney's multiplier is updated discretely by the orchestrator via `distributeYield()` or `setOkuMMultiplier()`. To prevent sandwich attacks around these discrete updates, a single-block lock is enforced:

- Both write functions set `lastYieldDistributionBlock` (EVM) / `last_yield_distribution_slot` (SVM)
- PSM and vault operations revert if executed in the same block/slot as a multiplier update
- The lock auto-releases in subsequent blocks/slots
- No backend changes needed — protection is automatic

## PSM (Peg Stability Module)

Price-aware USDC ↔ OkuMoney swaps:

```
mintOkuM:      okuMAmount = usdcValue × PRECISION / okuMMultiplier()
redeemOkuM:    usdcAmount = okuMAmount × okuMMultiplier() / PRECISION
```

On EVM, LitePSM ships convenience functions that route through the vault
for single-transaction usdOku ↔ USDC:

```
mintUsdOku:    USDC → PSM mints OkuM → wraps into vault → usdOku to user
redeemUsdOku:  usdOku → unwrap to OkuM → redeem for USDC (or queue if buffer empty)
```

On SVM these compositions live in the off-chain SDK (multi-instruction
client-side builds), since the `oku-bridge-router` convenience program
was removed in the noBridge refactor.

## Cross-Chain Transfers (v1: PSM-Mediated, Off-Chain Orchestrated)

Both EVM and SVM ship without an on-chain bridge. Cross-chain transfers
are orchestrated off-chain through PSM mint/burn on each chain:

1. User redeems OkuM for USDC on chain A via `LitePSM.redeemOkuM` (EVM)
   / `lite_psm::redeem_oku_m` (SVM) — or sends USDC to the orchestrator's
   off-chain rail directly.
2. Orchestrator observes the burn / off-chain instruction, waits for
   finality, then performs an equivalent USDC-funded `mintOkuM` /
   `mint_oku_m` on chain B crediting the recipient.
3. PSM USDC buffers on each chain are rebalanced operationally by treasury.

LitePSM (EVM) / lite-psm (SVM) holds the OkuMoney mint authority on every
chain — it is the sole user-facing mint/burn surface in v1.

**`mintOkuM` is permissionless.** Any address with USDC can call it; the
orchestrator does NOT hold `OKUM_MINTER`. Orchestrator key compromise grants
no special mint privilege beyond the orchestrator's USDC custody.

**Cross-chain USDC flow conservation invariant:**

```
|USDC_redeemed_A - USDC_minted_B| ≤ 1 USDC-unit per bridge
Cumulative drift across N bridges ≤ N USDC-units
```

Tested by `EVM/test/hardhat/crossChain/OrchestratorPsmBridging.ts § WS3.3` and
`SVM/oku-programs/tests/bankrun/crossChainBridging.ts`.

See [`docs/orchestrator-runbook.md`](docs/orchestrator-runbook.md) for
operational procedures (preflight checklist, failure recovery, multiplier
sequencing, minterAllowance rotation policy, and monitoring SLAs).

OkuBridge (proprietary burn-and-mint) and third-party rails (NTT, CCIP)
are planned post-launch and will be introduced as additive components:

- **EVM** retains role constants (`BRIDGE_*`, `ROUTER_*`, `NTT_*`) and
  integration interfaces (`IOkuBridgeNative`, `IBridgeAdapter`) in the
  tree as reserved seams so re-introduction does not require modifying
  existing contracts.
- **SVM** has no reserved enum variants — a future on-chain bridge will
  ship as a brand-new program granted `OKUM_MINTER` via PSM, the same
  additive shape as the EVM path.

## RBAC (Role-Based Access Control)

One role per action. No role performs more than one function.

| Entity | Roles |
|--------|-------|
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, ORACLE_MANAGER, RESERVE_MANAGER |
| Warm Multisig | all PAUSER, all BLACKLISTER |
| Orchestrator | OKUM_REBASER, VAULT_REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR |
| LitePSM | OKUM_MINTER |
| RedemptionQueue | OKUM_MINTER |

The `BRIDGE_*`, `ROUTER_*`, and `NTT_*` roles defined in `Roles.sol` are
reserved for the future re-introduction of OkuBridge / NTT / CCIP. They are
not granted by the v1 deploy scripts.

## EVM vs SVM Implementation Differences

| Aspect | EVM | SVM |
|--------|-----|-----|
| Language | Solidity 0.8.28 | Rust (Anchor 1.0.0) |
| OkuMoney multiplier | Stored `uint256`, 18 decimals (`okuMMultiplier`) | Stored `u64`, 9-decimal precision (`PsmConfig.oku_m_price`, 6-decimal token) |
| OkuDollar multiplier | Continuous `_rpow` streaming | Discrete orchestrator-driven updates |
| Yield lock | `block.number` comparison | `Clock::slot` comparison |
| Token standard | ERC-20 (custom rebasing for OkuDollar) | Token-2022 (both tokens) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | Composed off-chain by the SDK from raw PSM / vault instructions |
| Cross-chain transfers (v1 noBridge) | Off-chain orchestrator + LitePSM mint/burn | Off-chain orchestrator + lite-psm mint/burn |

## Directory Structure

```
contracts/
  EVM/                  # Solidity contracts (Foundry + Hardhat)
    src/
      token/            # OkuMoney.sol, OkuDollar.sol
      psm/              # LitePSM.sol, RedemptionQueue.sol
      bridge/adapters/  # IBridgeAdapter.sol (reserved interface only)
      interfaces/       # IOkuMoney.sol, IOkuDollar.sol, IOkuBridgeNative.sol (reserved)
      lib/              # Roles.sol, Constants.sol, MathLib.sol
    test/
    scripts/

  SVM/                  # Anchor programs (Rust)
    oku-programs/
      programs/
        lite-psm/       # PSM + queue + yield ops + compliance
        oku-dollar/     # Rebasing vault
      crates/
        oku-shared/     # Pure-Rust shared constants + math (no anchor / no solana deps)
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