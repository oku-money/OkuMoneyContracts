# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil) for unit + invariant tests; Hardhat for fork + gas-regression tests
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Contracts

| Contract | Description |
|----------|-------------|
| `src/token/OkuMoney.sol` | Non-rebasing base token (OkuM) — static balance, discrete multiplier appreciation via stored `okuMMultiplier` |
| `src/token/OkuDollar.sol` | Rebasing $1-pegged stablecoin (usdOku) — growing balance via continuous `_rpow` USD multiplier |
| `src/psm/LitePSM.sol` | Peg Stability Module — multiplier-aware USDC ↔ OkuM + usdOku convenience functions |
| `src/interfaces/erc8056/` | ERC-8056 (Scaled UI Amount) core + three extensions |
| `src/lib/MathLib.sol` | Multiplier conversion helpers (`okuMToDollars`, `dollarsToOkuM`, `usdcToDollars`, `dollarsToUsdc`, `rpow`) |
| `src/lib/Constants.sol` | Shared constants + canonical terminology legend |
| `src/lib/Roles.sol` | Shared RBAC role constants (namespaced by contract prefix) |
| `src/lib/ReentrancyGuardUpgradeable.sol` | OZ v5-compatible upgradeable reentrancy guard (OZ dropped the upgradeable variant in v5) |

## Quick Start

```bash
forge install
forge build
forge test                                    # All unit + invariant tests
forge test --match-path "test/invariants/*"   # Invariant suite only (256 runs, 500 depth)
forge test --match-contract OkuMoneyTest -vv  # Targeted

npx hardhat compile                           # Required before fork tests
npx hardhat test                              # Fork + happyPath + scenarios tests
```

## Deployment & Address Book

The unified deploy script (`scripts/deploy/index.ts`) provisions every contract
for a given chain in one run, captures addresses to a working address book, and
on live networks also mirrors them into the canonical repo-root registry.

### Deterministic addresses (CREATE2, v0.1)

Every UUPS proxy + its implementation, plus `MockUSDC`, are deployed via the
[Arachnid CREATE2 factory](https://github.com/Arachnid/deterministic-deployment-proxy)
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on every supported
chain), so the same source tree + `DEPLOYMENT_VERSION` + constructor args
produce the **same contract address on every chain**. Salt:
`keccak256("okumoney." + DEPLOYMENT_VERSION + "." + <name>)` — config in
[`scripts/config/deploymentVersion.ts`](scripts/config/deploymentVersion.ts),
helpers in [`scripts/utils/create2Deploy.ts`](scripts/utils/create2Deploy.ts).

Caveats:
- **Version semantics:** `v0.x` = pre-audit iteration (addresses may change
  across versions); `v1.0+` reserved for post-audit. Bumping
  `DEPLOYMENT_VERSION` is one-way — prior-version deploys keep their
  addresses.
- **Fallback:** if the factory isn't deployed on a target chain, the script
  warns and falls through to nonce-based CREATE (non-deterministic
  addresses). All chains in the current network list have the factory.
- **Per-chain variance:** differing constructor args (real Circle USDC on
  mainnet vs. `MockUSDC` on testnets) still produce different addresses
  where they apply. Testnets all use `MockUSDC` deterministically, so
  `LitePSM` matches across testnets; mainnet (real USDC)
  diverges — handled post-audit.

### Where deployed addresses live

| File | Role | Touched by |
|------|------|------------|
| [`scripts/config/addresses.json`](scripts/config/addresses.json) | Working per-network address book consumed by deploy / test scripts. Keyed `<chain>` for live deploys; `fork:<chain>` for local-fork runs (so fork tests never overwrite live entries). | Every script run. |
| [`../testnet-addresses.json`](../testnet-addresses.json) | Canonical, auto-synced multi-chain registry consumed by the SDK / backend / orchestrator. Includes `chainId`, `rpcUrl`, `explorer`, `contracts{}`, `deployer`. | Live deploys only — fork runs never write here. |
| `.openzeppelin/<network>.json` | OZ upgrades plugin's per-chain proxy/impl manifest. Required for `upgradeProxy` to work. | OZ upgrades plugin. |

### Configured networks

Defined in [`hardhat.config.ts`](hardhat.config.ts) and [`scripts/config/chains.ts`](scripts/config/chains.ts):

| Network key | Chain ID | Status |
|---|---|---|
| `sepolia` | 11155111 | Eth Sepolia testnet |
| `opSepolia` | 11155420 | OP Sepolia testnet |
| `baseSepolia` | 84532 | Base Sepolia testnet |
| `arbSepolia` | 421614 | Arbitrum Sepolia testnet |
| `bscTestnet` | 97 | BNB Smart Chain testnet (Chapel) |
| `mainnet` | 1 | Ethereum mainnet |
| `optimism` | 10 | Optimism mainnet |
| `arbitrum` | 42161 | Arbitrum One |
| `base` | 8453 | Base mainnet |
| `bsc` | 56 | BNB Smart Chain mainnet |

The protocol-internal `u16` "bridge chain ID" mapping table and the
`getSolanaCounterpartChainId()` helper were removed in the noBridge
refactor — no on-chain message carries a chain identifier in v1.

### Local-fork pre-flight (recommended before any live deploy)

Forks against real chain state to validate the deploy will succeed (sufficient
ETH/BNB, RPC behaves as expected) without spending real funds:

```bash
# Terminal 1: start a forked node. FORK_NETWORK selects which chain to fork.
FORK_NETWORK=base hh node            # =sepolia, =bsc, =arbitrum, =mainnet, ...

# Terminal 2: deploy + run integration test against the running fork.
hh run scripts/deploy/index.ts --network localhost     # auto-detects target chain from fork's chainId
hh run scripts/test/test-onchain.ts --network localhost
```

The deploy script auto-detects the target chain from the running node's
`eth_chainId`, so you don't need to keep `FORK_NETWORK` and `NETWORK=` in sync
across terminals. Fork-deployed addresses land under `addresses.json["fork:<chain>"]`
so they never collide with live `<chain>` entries.

### Live deploy

```bash
# .env: PRIVATE_KEY, ALCHEMY_API_KEY, ETHERSCAN_API_KEY (one Etherscan V2 key
# covers Ethereum, Optimism, Arbitrum, Base, BSC verification).
hh run scripts/deploy/index.ts --network base
hh run scripts/deploy/index.ts --network bsc
hh run scripts/deploy/index.ts --network sepolia
```

The script is **idempotent and resumable**:

- `tryAttach` reuses any contract already in `addresses.json["<chain>"]` whose
  address still has bytecode on chain — partial-deploy failures (RPC blip,
  mid-run timeout, etc.) can just be re-run; nothing redeploys unnecessarily.
- Transient RPC errors (`nonce too low`, `replacement transaction underpriced`,
  BSC's `BAD_DATA: invalid address (value="")` pending-tx quirk, network
  timeouts) are caught and retried with exponential backoff (2s → 32s, up to
  5 attempts) inside `withRetry`.
- A separate provider shim (`scripts/utils/rpcCompat.ts`) preventatively
  normalises BSC's pending-tx response shape before ethers' strict formatter
  ever sees it.

### Upgrading deployed proxies

`scripts/upgrade/index.ts` is a generic UUPS-proxy upgrade dispatcher. It
re-uses the deploy script's network resolution, signer wiring (impersonates
the dev wallet on a fork), and retry helpers, and adds:

- **Permission check** — verifies the signer holds the contract-specific
  `*_UPGRADER` role before broadcasting (auto-grants from the impersonated
  DEFAULT_ADMIN on a fork; aborts on live with a clear error).
- **Storage-layout safety** — runs OZ's `prepareUpgrade` so any layout-breaking
  change aborts the run before any upgrade tx is broadcast.

> ⚠️ **The layout check cannot see ERC-7201 struct changes.** All contracts here
> keep their state inside namespaced structs reached via `assembly`, so the
> declared layout is empty and OZ's validator reports `COMPATIBLE` no matter how
> the struct's fields are reordered or re-typed. `checkLayout.ts` is therefore
> only meaningful for *declared* variables — it is not a safety net for
> namespaced storage. Changes inside a `*Storage` struct must be reviewed by
> hand, and append-only, or the deployment must be replaced.
>
> **The continuous-yield-epoch change is layout-breaking on `OkuMoney`.**
> `OkuMoneyStorage` dropped `okuMMultiplier` and `lastYieldDistributionBlock`
> and added `currentEpoch` / `pendingEpoch` / `accrualHalted`; `LitePSMStorage`
> dropped `redemptionQueue`. Existing proxies **cannot** be upgraded in place —
> a fresh deploy (bump `DEPLOYMENT_VERSION`) is required.
- **Pre/post state diff** — snapshots invariant fields per target (see
  `scripts/upgrade/preState.ts`) and fails the run if anything diverges.
- **Audit trail** — appends each upgrade to `addresses.json -> upgrades.<bookKey>`
  with old/new impl, tx hash, signer, and ISO timestamp.

Always rehearse against a fork before touching a live deployment:

```bash
# Terminal 1: fork the target chain
FORK_NETWORK=sepolia hh node

# Terminal 2: rehearse — uses the live address book key (e.g. "sepolia"),
# upgrades the same proxies the live deploy would touch, against the fork's
# state. The deploy script's fork:<chain> namespace is intentionally skipped
# here because there are no fork-only proxies to upgrade.
TARGETS=LitePSM,OkuDollar npm run upgrade

# When the diff is clean, run for real:
TARGETS=LitePSM,OkuDollar npm run upgrade:sepolia
```

Supported targets (v1): `LitePSM`, `OkuDollar`. Extend by adding a row to
`UPGRADE_TARGETS` in `scripts/upgrade/index.ts` and a state reader in
`scripts/upgrade/preState.ts`.

Env vars:

| Var | Purpose |
|---|---|
| `TARGETS` | Comma-separated contract names to upgrade (required). |
| `NETWORK` | Override chain for live runs; auto-detected on a fork from the running node's chainId. |
| `PROXY_<Name>` | Per-target proxy address override; defaults to `addresses.json` lookup. |
| `SKIP_VERIFY` | Skip Etherscan verification of the new implementation. |

The dev wallet (`0x3CB68a6762041aA05E762814A8791CA9d98E79A0`, the deployer on
every live chain) already holds every `*_UPGRADER` role per `initialize()`'s
role-grant policy, so no out-of-band role grants are required for the
shipped deployments.

### npm scripts

| Script | Effect |
|---|---|
| `npm run compile` | `hardhat compile` (regenerates typechain) |
| `npm run typechain` | Typechain bindings only |
| `npm run test:forge` | Foundry unit + invariant suite |
| `npm run test` | Hardhat fork + gas suite |
| `npm run test:all` | Both |
| `npm run node` | Start `hardhat node` (default forks Sepolia; override via `FORK_NETWORK`) |
| `npm run deploy:sepolia` / `:opSepolia` / `:baseSepolia` / `:arbSepolia` / `:bscTestnet` | Live deploy to the named testnet |
| `npm run deploy:base` / `:bsc` | Live deploy to the named mainnet |
| `npm run upgrade` | Upgrade proxies on a running localhost fork (auto-detects target chain) |
| `npm run upgrade:sepolia` / `:opSepolia` / `:baseSepolia` / `:arbSepolia` / `:bscTestnet` | Live upgrade on the named testnet |
| `npm run upgrade:base` / `:bsc` | Live upgrade on the named mainnet |
| `npm run test:flow` / `:live` | `test-flow.ts` against a running localhost fork (or live Sepolia) |

> The `npm run bridge:*` scripts were removed in the noBridge refactor.
> Cross-chain transfers are now PSM-mediated mint/burn coordinated off-chain.

### Yield-epoch operator scripts

| Script | Purpose |
|---|---|
| `scripts/operator/startYieldEpoch.ts` | Publish a yield epoch. Replaces the former `distributeYield.ts`. |
| `scripts/operator/manageYieldEpoch.ts` | `--action status \| schedule \| cancel \| halt \| resume` |

```bash
# Publish $4,110 of realized yield streamed over 30 days
NETWORK=base npx hardhat run scripts/operator/startYieldEpoch.ts --network base \
    --amount 4110000000000000000000 --duration 2592000 --yes-mainnet

# Preview first (no broadcast) — validates the implied APR before you commit
DRY_RUN=true AMOUNT=4110000000000000000000 DURATION=2592000 NETWORK=base \
    npx hardhat run scripts/operator/startYieldEpoch.ts --network base

# Inspect epoch state; warns loudly if accrual has flatlined
NETWORK=base npx hardhat run scripts/operator/manageYieldEpoch.ts --network base \
    --action status

# Queue the next period so accrual is continuous across the boundary
NETWORK=base npx hardhat run scripts/operator/manageYieldEpoch.ts --network base \
    --action schedule --amount 4110000000000000000000 --duration 2592000 --yes-mainnet
```

`startYieldEpoch.ts` mirrors the contract's rate derivation locally and
refuses to broadcast if the implied APR would exceed
`MAX_IMPLIED_APR_BPS`, reporting the minimum legal duration instead. It
also asserts post-transaction that the multiplier did **not** move on
publication — the property that makes it unsandwichable.

**Runbook notes:**

- If a distribution is rejected for APR, **stream it over longer** —
  do not shrink the amount.
- Accrual flatlines silently past `endTime`. Either schedule the
  successor ahead of time or alert on `yieldEpochEndsAt()`.
- `--action cancel` is the only clean rollback, and only before the
  scheduled successor activates.
- `--action halt` is independent of `pause()`: use it when *backing*
  is impaired, `pause()` when the *code* is suspect, both when both.

For chains without a pre-baked npm alias (`base`, `bsc`, `arbitrum`, `optimism`,
`mainnet`):

```bash
hh run scripts/deploy/index.ts --network <chain>
NETWORK=<chain> hh run scripts/test/test-onchain.ts --network <chain>
```

## Contract Structure

```
src/
  token/
    OkuMoney.sol            # Non-rebasing base token (stored okuMMultiplier, discrete updates)
    OkuDollar.sol           # Rebasing stablecoin vault (continuous _rpow usdMultiplier)
  psm/
    LitePSM.sol             # USDC ↔ OkuM (multiplier-aware) + usdOku convenience functions
  interfaces/
    IOkuMoney.sol           # OkuMoney interface (used by PSM, vault, mocks)
    IOkuDollar.sol          # OkuDollar vault interface
  lib/
    Roles.sol               # Shared RBAC role constants (prefix-namespaced)
    Constants.sol           # PRECISION, DECIMAL_MULTIPLIER, MAX_RATE, BASIS_POINTS + terminology legend
    Errors.sol              # Shared error types (ZeroAddress, InsufficientBalance, MultiplierCannotDecrease)
    SafeApprove.sol         # USDT-safe approve helpers (setExactAllowance, revokeAllowance)
    MathLib.sol             # Multiplier math + rpow
    ReentrancyGuardUpgradeable.sol  # OZ-5.x-compatible upgradeable reentrancy guard
    events/
      OkuMoneyEvents.sol    # Event declarations for OkuMoney
      OkuDollarEvents.sol   # Event declarations for OkuDollar (incl. Blacklisted/Unblacklisted)
      LitePSMEvents.sol     # Event declarations for LitePSM

test/
  mocks/                    # Test-only mocks (live under test/, never compiled into production artifacts)
    MockUSDC.sol            # 6-decimal ERC-20; used on testnets + in tests
```

> **noBridge refactor**: `src/bridge/OkuBridge.sol`, `OkuBridgeRouter.sol`,
> `adapters/NttAdapter.sol` + `INttManager.sol`, the corresponding event
> files, the `IBridgeAdapter` / `IOkuBridgeNative` interfaces, and the
> `BRIDGE_*` / `ROUTER_*` / `NTT_*` constants in `Roles.sol` were all removed
> in a later cleanup pass — no bridge-related code or reserved role constants
> remain in `src/`. v1 cross-chain transfers are PSM-mediated mint/burn,
> orchestrated off-chain (the orchestrator custodies USDC and calls
> `LitePSM.mintOkuM` / `LitePSM.redeemOkuM` on the source/destination chains).
> Should OkuBridge / NTT / CCIP return, the upgrade is additive — deploy the
> new proxy, grant it `OKUM_MINTER`, configure its minter allowance — but it
> requires re-adding the interfaces and role constants from git history
> rather than resuming any scaffolding left in the current tree.

---

## Terminology (canonical)

Every contract's NatSpec references `src/lib/Constants.sol` for the authoritative terminology legend. Brief excerpt for quick reference:

**Multipliers (dollar value per token)**
- `okuMMultiplier` — dollar value of 1 OkuMoney token (starts 1e18 = $1.00, grows with yield, only increases)
- `usdMultiplier` — dollar value of 1 OkuDollar share (starts 1e18 = $1.00, grows via `_rpow` accrual)

**Token amounts**
- `okuMAmount` — raw OkuMoney token count (18 decimals, non-rebasing)
- `usdAmount` — OkuDollar amount in dollar terms (18 decimals, rebasing)
- `usdcAmount` — USDC amount (6 decimals)

**Conversion constants**
- `PRECISION = 1e18` — base unit for multiplier math
- `usdcDecimalMultiplier` — per-PSM stored value (`= 10 ** (18 - usdcDecimals)`),
  computed at `LitePSM.initialize` from the deployed USDC mint's `decimals()`.
  On every chain we currently target this is `1e12` (USDC has 6 decimals).
- `MAX_RATE = PRECISION + 1e11` — safety cap on vault `usdRatePerSecond`
- `BASIS_POINTS = 10_000` — fee denominator

**Key formulas**
```
USDC → OkuMoney:         okuMAmount   = (usdcAmount × 1e12) × PRECISION / okuMMultiplier
OkuMoney → USDC:         usdcAmount   = (okuMAmount × okuMMultiplier / PRECISION) / 1e12
OkuMoney → usdOku share: shares       = okuMAmount × okuMMultiplier / usdMultiplier
usdOku → OkuMoney:       okuMAmount   = usdAmount × PRECISION / okuMMultiplier
```

See [`src/lib/Constants.sol`](src/lib/Constants.sol) for the canonical version.

---

## Hardcoded Constants

All of the following are compile-time constants in [`src/lib/Constants.sol`](src/lib/Constants.sol). They cannot be changed without a contract upgrade. Where a constant is a round number or a conventional choice rather than a derived value, the rationale is noted.

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1e18` | Standard 18-decimal fixed-point base. Matches ERC-20 18-decimal convention; $1.00 = 1e18. Not arbitrary — changing it would require rewriting all multiplier math. |
| `MAX_RATE` | `PRECISION + 1e11` (~3700% APY per-second) | Safety cap on `usdRatePerSecond` passed to `rpow`. The value is arbitrary in the sense that any number far above realistic T-Bill yields would serve the same purpose. It is calibrated to stay well below `rpow` overflow regions while being comfortably above any plausible real-world rate. |
| `MAX_MULTIPLIER` | `1e24` ($1,000,000 per token) | Overflow guard on both `okuMMultiplier` and `usdMultiplier`. Chosen as a round number six orders of magnitude above the starting value of 1e18. Arbitrary — any ceiling far above realistic yield trajectories would work. Prevents a compromised rebaser key from bricking downstream multiplier math via overflow. |
| `BASIS_POINTS` | `10_000` | Universal basis-points denominator (100% = 10 000). Industry convention; not arbitrary. |
| `MIN_COLLATERAL_RATIO_FLOOR` | `9e17` (90%) | Hard floor below which `minCollateralRatio` can never be configured, regardless of the `VAULT_ADMIN` key. **The 90% value is a round-number convention** — no specific analysis of T-Bill liquidity or yield-spread dynamics was used to derive it. For a product backed by short-duration T-Bills (extremely low volatility), a tighter floor (e.g. 95–98%) would also be defensible. The floor only gates `withdrawSurplus`; it does not halt minting or unwrapping if the live ratio drifts below it. |
| `MAX_USDC_DECIMALS` | `18` | Cap on `IERC20Metadata.decimals()` accepted at PSM init. USDC uses 6 decimals on all EVM chains; 18 is the ERC-20 max. Prevents misconfiguration with nonsensical decimal counts. Not arbitrary per se — it is the ERC-20 upper bound — but the choice to cap rather than hardcode 6 is intentional forward-compat. |

---

## Dual-Token Split-Economy Model

OkuMoney and OkuDollar have **independent yield rates** controlled by separate roles:

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

OkuMoney is the solvency anchor (rear-facing, always backed). OkuDollar is the policy lever.

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20, multiplier appreciates discretely). OkuDollar is **rebasing** ($1-pegged, balance grows continuously via `_rpow`).

---

## OkuMoney.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`, plus the four ERC-8056 interfaces.

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through appreciation of `okuMMultiplier()` — the dollar value of one OkuM — which accrues **continuously** over an operator-defined epoch.

---

### Continuous yield epochs

#### Why yield streams instead of stepping

This is the single most important design decision in the contract, so it is documented at length.

`okuMMultiplier` is not a cosmetic display value. It is the **settlement price** for instant, two-way convertibility at the PSM, for `wrap`/`unwrap` at the vault, and for the vault's own solvency check. Every economic surface in the protocol reads it.

A discrete jump in a settlement price is riskless arbitrage:

```
block N-1:  attacker mints OkuM at M = 1.0000        (cheap)
block N:    operator steps M to 1.0500
block N+1:  attacker redeems OkuM at M = 1.0500      (dear)
```

The attacker captures the entire increment with **no price risk and no holding period**, funded out of the PSM buffer and diluting every honest holder. Yield is compensation for holding across *time*; a step converts it into compensation for holding across an *instant*.

Concretely, at $1M TVL / 5% APR / 30-day distribution, an attacker matching TVL took **~$2,055 per event (~$25k/yr)** — up to half of all yield — for roughly 12 seconds of capital at risk.

#### Why the old same-block fence was not enough

A previous `YieldSandwichGuard` compared `block.number` against `lastYieldDistributionBlock`. That flag was only written *inside* `distributeYield`, so within a single block:

| Order in block N | Passed the fence? |
|---|---|
| mint → **then** step | **yes** — flag still held the old block number |
| step → **then** redeem | no — this is what the fence caught |

The fence was a **backrun guard, not a frontrun guard**. It stopped the fully-atomic same-block round trip, but the profitable version spans two blocks and needed nothing more than mempool visibility of the update transaction. On a chain with a public mempool (BSC) that is commodity sandwich MEV.

Mitigations like private transaction submission, randomised timing and tight minter allowances are *compensating controls*, not fixes — they are operational assumptions an auditor will (correctly) discount. The fence has been removed along with the step it was defending.

#### The epoch model

Yield is still **discovered off-chain in chunks** — T-Bills settle periodically — and is still strictly **rear-facing**: an epoch only ever distributes what has already been realized. What changed is *delivery*.

One epoch fully describes the multiplier for all time within it:

```solidity
struct YieldEpoch {
    uint256 baseMultiplier;  // multiplier at startTime
    uint256 ratePerSecond;   // linear increment per second
    uint64  startTime;
    uint64  endTime;         // accrual FLATLINES past this
}
```

```
M(t) = baseMultiplier + ratePerSecond × (min(t, endTime) − startTime)
```

The multiplier is a **pure function of time** — no keeper, no per-block writes, and anyone can independently verify past or future values via `okuMMultiplierAt(t)`.

Accrual is **linear, not exponential**. The operator supplies a realized dollar amount and a duration; the contract derives the per-second increment. Linear is the honest shape for "distribute exactly this much over exactly this long", and it avoids the D-th root that deriving an exponential rate from a target amount would require. Over day-to-month epochs the curvature difference is negligible.

This is the same realized-lump-streamed-forward pattern as Synthetix `StakingRewards.notifyRewardAmount` and Yearn v2's `lockedProfitDegradation` (adopted there for precisely this attack), and it matches the continuous accrual `OkuDollar.usdMultiplier` already used.

#### What this fixes

Measured in `test/token/YieldSandwich.t.sol`, running the identical attack sequence:

| | Discrete step (before) | Continuous epoch (now) |
|---|---|---|
| Attacker gain, 12s round trip | **$2,055** | **$0.0095** |
| Honest holder's yield | halved by dilution | unaffected |

The residual $0.0095 is not an exploit — it matches the legitimate 12-second pro-rata share (predicted $0.009514, actual $0.009513). The attacker is simply paid correctly for twelve seconds of capital. **A 216,000× reduction.**

#### Operator API

| Function | Role | Notes |
|---|---|---|
| `startYieldEpoch(yieldAmount, duration)` | `OKUM_REBASER` | Streams `yieldAmount` over `duration`. Starts at the **current** multiplier — publishing never moves the price. Calling mid-epoch replaces the active epoch (rebasing from the current value) and discards any scheduled successor. Pause-gated. |
| `scheduleYieldEpoch(yieldAmount, duration)` | `OKUM_REBASER` | Queues a successor starting exactly when the active epoch ends, so accrual is continuous across the boundary. Requires a live (non-flatlined) epoch. Pause-gated. |
| `cancelPendingYieldEpoch()` | `OKUM_REBASER` | Revokes a scheduled successor. **The only fully clean rollback in the design.** Not pause-gated. |
| `haltAccrual()` | `OKUM_REBASER` | Freezes the multiplier at its current value and blocks new epochs. Not pause-gated. |
| `resumeAccrual()` | `OKUM_REBASER` | Lifts the halt. Does **not** restart accrual or backdate the halted interval. |

Views: `okuMMultiplier()`, `okuMMultiplierAt(t)`, `currentYieldEpoch()`, `pendingYieldEpoch()`, `yieldEpochEndsAt()`, `accrualHalted()`.

`startYieldEpoch` is still **one transaction per distribution window** — the operational cadence is unchanged.

#### Bounds

| Constant | Value | Purpose |
|---|---|---|
| `MAX_IMPLIED_APR_BPS` | `2000` (20% APR) | Caps `(Δmultiplier / startMultiplier) × (year / duration)`. |
| `MIN_EPOCH_DURATION` | `1 hour` | Defence-in-depth: a very short epoch approximates a step. |
| `MAX_EPOCH_DURATION` | `365 days` | Bounds forward commitment and keeps `rate × duration` far inside the safe region. |

`MAX_IMPLIED_APR_BPS` is the **primary on-chain defence against a mispriced or compromised rate**, because the multiplier is monotonic: yield that has already accrued cannot be clawed back. It also rejects the degenerate "stream a month's yield over an hour" case (~360,000 bps), which is arithmetically a step again — so one cap enforces both bounds.

Sizing: 4× headroom over a ~5% T-Bill trajectory. A tighter 1000 bps would reject a legitimate catch-up (two periods' yield over one period lands at ~1000 bps) on a knife edge.

> **If `startYieldEpoch` reverts with `ImpliedAprTooHigh`, stream the same amount over a LONGER duration — do not reduce the amount.** `startYieldEpoch.ts` computes the minimum legal duration for you.

#### Operational cautions

- **Flatlining is silent.** Past `endTime` with no successor scheduled, the multiplier simply stops. This is the safe default (never extrapolate unearned yield) but produces no event. **Monitor `yieldEpochEndsAt()`** — `manageYieldEpoch.ts --action status` warns when accrual has flatlined.
- **Rollback is limited.** Only a *pending* epoch can be cancelled cleanly. Once yield has accrued, monotonicity makes it permanent and `haltAccrual()` (forward-only) is the sole remaining lever.
- **`haltAccrual` is independent of `pause()`.** Bug found but backing intact → `pause()` only, so holders keep yield genuinely owed. Backing impaired → `haltAccrual()`, so obligations stop growing while transfers continue. Both → call both.
- **Supply drift.** The per-token increment is derived from `totalSupply` at publication. If supply grows during the epoch, delivered dollars slightly exceed `yieldAmount` (~$200 on a $4,110 pot at 10% growth). This is rear-facing, so it self-corrects in the next period's figure; `YieldEpochStarted` emits the supply snapshot for reconciliation.
- **No loss pass-through.** The multiplier is strictly monotonic, so a negative realized period cannot be reflected — the operator distributes nothing instead. A decrease would retroactively undercollateralize the vault and strand anyone who had already redeemed.

---

### ERC-8056 (Scaled UI Amount)

OkuMoney implements [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056) core plus all three extensions, so wallets can render dollar values natively.

**Scope note — a deliberate extension beyond the standard's stated purpose.** ERC-8056 was written for *stock splits*; its abstract calls the multiplier "a cosmetic layer ... while maintaining the underlying token economics". A 2-for-1 split is value-neutral and cannot be arbitraged. Oku uses the same multiplier as a *settlement price*, which is value-additive. That is outside the standard's design intent, and it is exactly why the multiplier must move continuously rather than in the discrete steps the EIP's own reference implementation uses. Only the interface is borrowed.

| Interface | ID | Surface |
|---|---|---|
| `IScaledUIAmount` | `0xa60bf13d` | `uiMultiplier()`, `UIMultiplierUpdated` |
| `IScaledUIAmountNewUIMultiplier` (required) | `0x4bd27648` | `newUIMultiplier()`, `effectiveAt()` |
| `IScaledUIAmountConversion` | `0x57854fc3` | `toUIAmount()`, `fromUIAmount()` |
| `IScaledUIAmountBalances` | `0xd890fd71` | `balanceOfUI()`, `totalSupplyUI()` |

All four IDs are asserted against `type(I…).interfaceId` in `test/token/ERC8056Conformance.t.sol`, so a spec revision surfaces as a test failure rather than silent non-conformance.

**Pending-multiplier mapping.** The required extension maps onto the scheduled successor epoch: `effectiveAt()` is its start time and `newUIMultiplier()` the multiplier it begins at. With no successor scheduled, both resolve to the active epoch's terminal state — the next value the multiplier is committed to reach.

**Conformance notes for integrators:**

1. `UIMultiplierUpdated` fires when the multiplier's *trajectory* changes (epoch start / schedule / halt), not on every per-second increment, which is impossible. A consumer caching on the event alone will under-report. Because the multiplier is monotonically non-decreasing, **staleness always understates and never overstates**. Read `uiMultiplier()` for a live value.
2. `TransferWithUIAmount` (OPTIONAL in the spec) is **not** emitted. `TransferValue(from, to, amount, dollarValue)` carries identical information and predates the standard; emitting both would double-log every transfer.
3. `fromUIAmount(toUIAmount(x))` can return `x - 1` — both directions floor. **A max-send MUST be computed from the raw `balanceOf`, never by round-tripping.**

---

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuMoneyStorage {
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
    YieldEpoch currentEpoch;   // active accrual segment
    YieldEpoch pendingEpoch;   // scheduled successor (endTime == 0 => none)
    bool accrualHalted;        // guardian latch, independent of Pausable
}
```

`okuMMultiplier` is no longer stored — it is derived from `currentEpoch` / `pendingEpoch`.

### IOkuMoney Interface

```solidity
interface IOkuMoney is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function okuMMultiplier() external view returns (uint256);
    function okuMMultiplierAt(uint256 t) external view returns (uint256);
    function startYieldEpoch(uint256 yieldAmount, uint256 duration) external;
    function yieldEpochEndsAt() external view returns (uint256);
}
```

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not multiplier-adjusted).
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion).
- `okuMMultiplier()` is a **computed view** advancing every second while an epoch is live; it is consumed by the PSM and vault for pricing, never by `balanceOf`.
- `mint()` creates raw tokens; minting 100 tokens when `okuMMultiplier = $1.05` creates $105 of value.
- `TransferValue` is emitted alongside the standard `Transfer` with the dollar-denominated amount.
- Blacklist and pause checks apply to transfers; self-burn works while paused.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20; emitted on mint/burn/transfer. |
| `TransferValue(from, to, amount, dollarValue)` | Alongside `Transfer`; `dollarValue = amount × okuMMultiplier / PRECISION`. |
| `YieldEpochStarted(yieldAmount, startMultiplier, endMultiplier, ratePerSecond, totalSupply, startTime, endTime)` | Emitted by `startYieldEpoch`. `totalSupply` is the snapshot used to derive the per-token increment. |
| `YieldEpochScheduled(yieldAmount, ratePerSecond, totalSupply, startTime, endTime)` | Emitted by `scheduleYieldEpoch`. |
| `YieldEpochCancelled(startTime, endTime)` | Emitted by `cancelPendingYieldEpoch`. |
| `AccrualHalted(frozenMultiplier, hadPendingEpoch)` | Emitted by `haltAccrual`. |
| `AccrualResumed(currentMultiplier)` | Emitted by `resumeAccrual`. |
| `UIMultiplierUpdated(oldMultiplier, newMultiplier, effectiveAtTimestamp)` | ERC-8056; emitted on every trajectory change. |
| `MinterAllowanceUpdated(minter, oldAllowance, newAllowance)` | Emitted by `configureMinterAllowance`. |
| `MaxSupplyUpdated(oldMaxSupply, newMaxSupply)` | Emitted by `setMaxSupply`. |
| `Blacklisted(account)` / `Unblacklisted(account)` | Blacklist state changes. |
| `Approval(owner, spender, value)` | Standard ERC-20 approval. |

### Blacklist Exemption

`blacklist()` deliberately does NOT use `whenNotPaused` — critical for the pause-to-blacklist protocol so operators can act during a paused incident.

### Role Constants

```solidity
bytes32 public constant OKUM_UPGRADER          = keccak256("OKUM_UPGRADER");
bytes32 public constant OKUM_PAUSER            = keccak256("OKUM_PAUSER");
bytes32 public constant OKUM_UNPAUSER          = keccak256("OKUM_UNPAUSER");
bytes32 public constant OKUM_MINTER            = keccak256("OKUM_MINTER");
bytes32 public constant OKUM_REBASER           = keccak256("OKUM_REBASER");
bytes32 public constant OKUM_BLACKLISTER       = keccak256("OKUM_BLACKLISTER");
bytes32 public constant OKUM_UNBLACKLISTER     = keccak256("OKUM_UNBLACKLISTER");
bytes32 public constant OKUM_CAP_MANAGER       = keccak256("OKUM_CAP_MANAGER");
bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");
```

See [Role Grants Policy](#role-grants-policy) below for how roles are distributed at init.

---

## OkuDollar.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `UUPSUpgradeable`.

**Concept**: Rebasing $1-pegged stablecoin with an independent yield rate. Holds OkuMoney as reserves. Has its own USD shares mapping and its own **continuous** `_rpow` multiplier, decoupled from OkuMoney's multiplier. NOT an ERC-4626 vault — a custom rebasing token with reserve management.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuDollarStorage {
    IOkuMoney okuMoney;
    mapping(address => uint256) usdShares;
    uint256 totalUsdShares;
    uint256 usdBaseMultiplier;        // Last snapshot (starts 1e18)
    uint256 usdRatePerSecond;         // Compound rate (1e18 = no yield)
    uint256 usdLastAccrualTime;
    uint256 usdRateEnd;               // When current rate expires (0 = no expiry)
    uint256 usdPendingRatePerSecond;  // Next rate (activates at usdRateEnd)
    uint256 minCollateralRatio;       // e.g. 95e16 = 95%
}
```

### USD Multiplier (Continuous `_rpow` Streaming)

```
usdMultiplier() = usdBaseMultiplier × _rpow(usdRatePerSecond, elapsed, PRECISION) / PRECISION
```

Unlike OkuMoney (stored discrete multiplier), OkuDollar uses continuous `_rpow` accrual. `balanceOf(user)` returns `usdShares[user] × usdMultiplier() / PRECISION` — this value changes every second without any transaction.

**Rate scheduling**: Head-to-tail chaining via `setUsdYieldRate(rate, endTimestamp)` and `setNextUsdYieldRate(rate)` (rejects if the current `usdRateEnd` has already elapsed — `RateAlreadyExpired`).

### Wrap / Unwrap (Multiplier-Aware)

```solidity
// wrap:   sharesToMint = actualReceived × okuMMultiplier / usdMultiplier
//         usdMinted    = sharesToMint × usdMultiplier / PRECISION
function wrap(uint256 okuMAmount, address receiver, uint256 minAmountOut)
    external returns (uint256 usdMinted);

// unwrap: okuMReturned = usdAmount × PRECISION / okuMMultiplier
//         sharesToBurn = ceil(usdAmount × PRECISION / usdMultiplier)  -- rounded UP to favour vault
function unwrap(uint256 usdAmount, address receiver)
    external returns (uint256 okuMReturned);
```

Both are protected by `whenNotPaused` (full freeze) and `nonReentrant`. `unwrap` reverts with `InsufficientBalance` if the caller's share balance is below `sharesToBurn`, or `InsufficientReserves` if the vault's OkuMoney reserves are below `okuMReturned`. These two errors are intentionally distinct — the first is a user balance check, the second is a vault-collateralization check.

### Reserve Management (`VAULT_RESERVE_MANAGER`)

```solidity
function depositReserves(uint256 okuMAmount) external;   // Top up, no shares minted. whenNotPaused.
function withdrawSurplus(uint256 okuMAmount) external;   // Extract, enforces minCollateralRatio. whenNotPaused.
```

### Collateralization (Multiplier-Aware)

```
collateralizationRatio = (OkuMoney.balanceOf(this) × okuMMultiplier / PRECISION) × PRECISION / totalSupply()
```

Numerator is dollar value of reserves. Denominator (`totalSupply()`) is dollar value of obligations (shares × multiplier). `surplus()` returns extractable OkuM tokens (0 if undercollateralized), computed as `max(0, reservesDollarValue - obligations) × PRECISION / okuMMultiplier`.

### Pause Behavior

Pause is a **full freeze**. The following are gated behind `whenNotPaused`:

- OkuMoney: peer-to-peer `transfer` / `transferFrom` (mint also; burn is NOT gated — self-burn works while paused to support the pause-to-blacklist protocol).
- OkuDollar: `transfer` / `transferFrom`, `wrap`, `unwrap`, `depositReserves`, `withdrawSurplus`.
- LitePSM: `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`.

**Intentionally NOT pause-gated**: the vault's yield-rate setters (`setUsdYieldRate`, `setNextUsdYieldRate`) and `setMinCollateralRatio` — these are admin emergency levers that must remain callable during a pause.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20, with the caller-specified amount (NOT share-reconverted — avoids 1-wei drift). |
| `TransferValue(from, to, shares, dollarValue)` | Emitted alongside `Transfer`, exposing the share-level accounting. |
| `Wrapped(user, receiver, okuMAmount, usdMinted, okuMMultiplier, usdMultiplier)` | Both multipliers snapshotted for rate reconstruction. |
| `Unwrapped(user, receiver, usdAmount, okuMReturned, okuMMultiplier, usdMultiplier)` | Both multipliers snapshotted. |
| `UsdYieldRateUpdated(oldRatePerSecond, newRatePerSecond, endTimestamp, snapshotMultiplier)` | Rate change with snapshot for off-chain reconstruction. |
| `NextUsdYieldRateSet(newRatePerSecond, activatesAt)` | Pending rate staged. |
| `MinCollateralRatioUpdated(oldRatio, newRatio)` | Collateralization floor changed. |
| `ReservesDeposited(depositor, okuMAmount, dollarValue, collateralizationRatio)` | Reserve top-up with post-deposit ratio. |
| `SurplusWithdrawn(to, okuMAmount, dollarValue, collateralizationRatio)` | Revenue extraction with post-withdrawal ratio. |

---

## LitePSM.sol

**Concept**: Multiplier-aware USDC ↔ OkuMoney swaps with usdOku convenience functions.

### OkuMoney Swap Functions

```solidity
// okuMAmount = usdcValue18 × PRECISION / okuMMultiplier()
function mintOkuM(uint256 usdcAmount) external;

// usdcAmount = okuMAmount × okuMMultiplier() / PRECISION (scaled to 6 decimals)
function redeemOkuM(uint256 okuMAmount) external;
```

At `okuMMultiplier = $1.05`: depositing 100 USDC gives ~95.24 OkuM; redeeming 95.24 OkuM returns ~100 USDC.

### Convenience Functions (usdOku ↔ USDC via Vault)

```solidity
function mintUsdOku(uint256 usdcAmount) external;           // USDC → mint OkuM → wrap → usdOku to user
function redeemUsdOku(uint256 usdAmount) external;          // usdOku → unwrap → redeem → USDC to user
```

**Redemption is buffer-only.** If the USDC buffer cannot cover a redemption the call reverts with `InsufficientBuffer` — nothing is escrowed and the user keeps their OkuM. There is no redemption queue; operators keep the buffer topped up via `depositBuffer`. This mirrors the SVM side (see `SVM/README.md § Why no redemption queue`) and how stablecoin issuers generally operate, and it removes the queue-management roles, capacity SLAs and stuck-entry rescue path from the operational surface.

`redeemUsdOku` therefore has two distinct failure modes: (a) vault undercollateralized → `unwrap` reverts with `InsufficientReserves`; (b) buffer insufficient → `InsufficientBuffer`. Both revert the whole transaction.

Every user-facing PSM function is protected by `whenNotPaused` + `nonReentrant`. There is **no** same-block yield fence: `okuMMultiplier()` accrues continuously and never steps, so there is no discontinuity for a same-block transaction to straddle. See [Continuous yield epochs](#continuous-yield-epochs).

### Admin / Operator Surface

```solidity
function depositBuffer(uint256 amount) external;                           // PSM_BUFFER_DEPOSITOR
function withdrawUsdc(address to, uint256 amount) external;                // PSM_BUFFER_WITHDRAWER — reverts with ZeroAddress on to == 0
function pause() / unpause() external;                                     // PSM_PAUSER / PSM_UNPAUSER
```

### Events

| Event | Parameters |
|---|---|
| `OkuMMinted(user, usdcAmount, okuMAmount, okuMMultiplier)` | `mintOkuM` success. |
| `OkuMRedeemed(user, okuMIn, usdcOut, okuMMultiplier)` | `redeemOkuM` success. |
| `UsdOkuMinted(user, usdcAmount, usdAmount, okuMMultiplier)` | `mintUsdOku` success. |
| `UsdOkuRedeemed(user, usdIn, usdcOut, okuMMultiplier)` | `redeemUsdOku` — sole event for this path; no inner `OkuMRedeemed` is emitted. |
| `BufferDeposited(depositor, amount, newBufferBalance)` | After `depositBuffer`. |
| `BufferWithdrawn(to, amount, newBufferBalance)` | After `withdrawUsdc`. |

---

## Cross-Chain Transfers (v1: noBridge / PSM-Mediated)

The EVM side ships without on-chain bridging in v1. Cross-chain transfers are
PSM-mediated mint/burn coordinated by the off-chain orchestrator:

```
chain A                                       chain B
LitePSM.redeemOkuM(user, n) ─► orchestrator ─► LitePSM.mintOkuM (USDC custody)
                                              ─► OkuM credited to user on B
```

- LitePSM holds `OKUM_MINTER` on every chain — sole user-facing mint/burn surface.
- The orchestrator custodies USDC and rebalances PSM buffers operationally.
- No on-chain signature verification, EIP-712 BridgeRequest, or refund flow in v1.

### If OkuBridge / NTT / CCIP return

Deleted in the noBridge refactor (no longer present anywhere in `src/`):
`OkuBridge.sol`, `OkuBridgeRouter.sol`, `NttAdapter.sol`, `INttManager.sol`,
the bridge event files, the `IOkuBridgeNative` / `IBridgeAdapter` interfaces,
the `BRIDGE_*` / `ROUTER_*` / `NTT_*` role constants in `Roles.sol`, the
bridge test suite, and the `scripts/bridge/` flow. A pre-noBridge git history
retains the full implementation if it ever needs to be restored — there is
no scaffolding left in the current tree to build on top of.

When OkuBridge / NTT / CCIP return, the upgrade is additive: reintroduce the
interfaces/roles from history, deploy the new proxy, grant it `OKUM_MINTER`,
configure its minter allowance. No changes to the existing `OkuMoney` /
`OkuDollar` / `LitePSM` contracts are required.

---

## Yield-sandwich defence (historical: `YieldSandwichGuard`)

`src/lib/YieldSandwichGuard.sol` **has been removed**, along with `OkuMoney.lastYieldDistributionBlock`, `setOkuMMultiplier` and `distributeYield`.

**Why it existed.** `okuMMultiplier` used to be written as a discrete step. The guard reverted any PSM mint/redeem or vault wrap/unwrap landing in the same block as that write.

**Why it was insufficient.** It compared `block.number` against `lastYieldDistributionBlock`, a flag written *inside* `distributeYield`. A mint ordered *before* the step in the same block read the stale value and passed; the redeem then simply waited for the next block. It was a **backrun guard, not a frontrun guard**, and the profitable round trip spans two blocks.

**Why it is now unnecessary.** `okuMMultiplier()` accrues continuously over an epoch and starts each epoch *at the prevailing value*. There is no discontinuity anywhere on the timeline, so there is nothing for any transaction — same-block or otherwise — to straddle. Keeping the guard would have cost an external call on every PSM operation to protect against an instant that no longer exists.

This also retires the guard's second consumer, `OkuDollar.withdrawSurplus`. That was a *privileged-operator* protection: a rebaser could step the multiplier and withdraw against the inflated collateral ratio in the same block. With continuous accrual the ratio drifts smoothly and yield timing cannot move it measurably within one block.

See [Continuous yield epochs](#continuous-yield-epochs) for the full argument, and `test/token/YieldSandwich.t.sol` for the regression suite that runs the original attack and shows it is no longer profitable.

---

## Role Grants Policy

Every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, reserve managers, etc.) to other parties (multisigs, bots) post-deployment via `grantRoles.ts` or `grantRolesMainnet.ts`. This removes contract-specific role plumbing from deployment scripts.

One intentional exception:

### Per-role trust and blast radius

The production role assignment and what each tier can and cannot do — see
`README.md § Signer trust implications` for the full model that applies to
both EVM and SVM. EVM-specific notes:

| Role | Held by | What it can do | What on-chain code prevents |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Cold Multisig | Grant/revoke any role; effectively controls everything | Nothing — this is the meta-role. Quorum breach = system compromise |
| `OKUM_UPGRADER` / `VAULT_UPGRADER` / `PSM_UPGRADER` / `QUEUE_UPGRADER` | Cold Multisig | Replace any contract's logic via UUPS `_authorizeUpgrade`; new logic could do anything | Nothing — upgrade is unconditional once authorized. Mitigated by: every upgrade is tested on a fork and diff-reviewed before mainnet execution |
| `OKUM_ALLOWANCE_MANAGER` | Cold Multisig | Set any address's `minterAllowance` to any value | Cannot set above `maxSupply`; minting still requires `OKUM_MINTER` (held by contracts, not EOAs) |
| `OKUM_CAP_MANAGER` | Cold Multisig | Set `maxSupply` | Cannot set below current `totalSupply()` |
| `PSM_BUFFER_WITHDRAWER` | Cold Multisig | Drain PSM USDC buffer | Cannot withdraw below amount needed to cover pending queue obligations (`queueObligation`) |
| `VAULT_RESERVE_MANAGER` | Cold Multisig | Withdraw OkuMoney surplus from vault | Cannot push vault below `minCollateralRatio` (90% floor enforced post-withdrawal) |
| `VAULT_ADMIN` | Cold Multisig | Set `minCollateralRatio` | Cannot set below `MIN_COLLATERAL_RATIO_FLOOR` (90%); live-health gate rejects if existing positions would breach the new floor |
| `PSM_PAUSER` / `VAULT_PAUSER` / `OKUM_PAUSER` | Warm Multisig | Halt minting, redemption, wrapping, transfers | Cannot unpause — that requires cold multisig (`*_UNPAUSER`) |
| `OKUM_BLACKLISTER` | Warm Multisig | Block any address from OkuMoney and OkuDollar operations | Cannot unblacklist (cold only); cannot access funds |
| `OKUM_REBASER` | Orchestrator | Publish/schedule yield epochs; halt or resume accrual | Cannot decrease the multiplier; each epoch bounded by `MAX_IMPLIED_APR_BPS` (20% APR) and `MIN`/`MAX_EPOCH_DURATION`; hard capped at `MAX_MULTIPLIER` (1e24) |
| `VAULT_REBASER` | Orchestrator | Set the `usdMultiplier` accrual rate | Cannot decrease the multiplier; bounded by `MAX_RATE` and `MAX_MULTIPLIER` |
| `PSM_BUFFER_DEPOSITOR` | Orchestrator | Deposit USDC to buffer from caller's wallet | Caller must hold the USDC; no damage possible |
| `OKUM_MINTER` | LitePSM (contract) | Call `OkuMoney.mint()` inside swap paths | Bounded by per-minter `minterAllowance` and global `maxSupply`; never callable by EOA |

---

## Key Invariants

Maintained by the contracts and verified by the test suites at `test/invariants/`:

**Token / multiplier**
```
balanceOf(user) == _balances[user]                              // OkuMoney: standard ERC-20
okuMMultiplier() >= previousOkuMMultiplier                      // Multiplier never decreases
totalSupply() <= maxSupply                                      // Supply cap respected
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION  // OkuDollar: share conversion
```

**Vault**
```
collateralizationRatio >= minCollateralRatio (after withdrawSurplus)
reservesDollarValue + <100 wei rounding> >= totalSupply         // Vault-backed within tolerance
unwrap(wrap(okuMAmount)) >= okuMAmount - 1                      // Round-trip accuracy
totalOkuMReserves() == OkuMoney.balanceOf(address(okuDollar))   // Reserve accounting
```

**Minter allowance**
```
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                            // Burns don't restore allowance
```

**PSM**
```
okuMoney.balanceOf(litePsm) <= 1 wei                            // No stale OkuM held between calls
redemptionQueue.totalQueuedOkuM == okuMoney.balanceOf(queue)    // Queue backed exactly by its OkuM
psmUsdcOutflow <= seededBuffer + trackedDeposits + tolerance    // USDC outflow bounded by inflow
```

---

## Accepted Risks

Known issues and design choices explicitly accepted by the protocol
team. A third-party reviewer or auditor should be aware of these so
the same ground isn't re-covered as a new finding.

### 1. Centralized operator model — no on-chain timelock

OkuMoney v1 ships as a centralized financial product, modelled on
similar yield-bearing stablecoins (Ondo Finance, Circle USDC). No
`TimelockController` sits between the operator multisig and any
contract.

**Scope of operator powers:**

- `OKUM_REBASER`: publishes yield epochs (`startYieldEpoch` / `scheduleYieldEpoch`) and can freeze accrual (`haltAccrual`). Bounded by `MAX_IMPLIED_APR_BPS` (20% APR), `MIN`/`MAX_EPOCH_DURATION`, `MAX_MULTIPLIER`, and monotonicity.
- `VAULT_REBASER`: writes USD yield rate. Bounded by `MAX_RATE` and `MAX_MULTIPLIER`.
- `VAULT_RESERVE_MANAGER`: deposits / withdraws OkuMoney from vault reserves. Withdrawals gated by a `minCollateralRatio` post-condition.
- `OKUM_MINTER` / `OKUM_BURNER`: bounded by per-minter allowance + global `maxSupply`. The PSM is the only intended holder.
- `PSM_*` roles: buffer custody and pause control.
- `OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER`: shared blacklist for OkuMoney + OkuDollar.

**On-chain mitigations:**

- `okuMMultiplier()` is monotonically non-decreasing and moves continuously — never in steps — so no PSM or vault operation can be sandwiched around a yield update.
- Defense-in-depth ceilings (`MAX_MULTIPLIER = 1e24`, `MAX_RATE = PRECISION + 1e11`) cap the blast radius of a single-call compromise.
- Monotonic guards (`MultiplierCannotDecrease`, `RateAlreadyExpired`) prevent backward writes.

**Operational expectation:** each operational role must rotate to a
multisig before mainnet launch. `VAULT_REBASER` and
`VAULT_RESERVE_MANAGER` must be held by separate keys / multisigs
(see Risk 2).

### 2. `VAULT_REBASER` + `VAULT_RESERVE_MANAGER` cross-block opsec

**Issue:** if both roles are held by the same key, that key can
sequence `setUsdYieldRate` (or a yield epoch) in block N followed by
`withdrawSurplus` in block N + 1 to extract value just added to the
apparent reserve dollar valuation.

**On-chain mitigation:** both multipliers now move continuously, so
neither can be jumped immediately before a withdrawal — the
collateral ratio drifts smoothly and yield timing cannot move it
measurably within a block. The `MAX_IMPLIED_APR_BPS` cap additionally
bounds how fast `okuMMultiplier` can be driven at all. Slow
cross-block manipulation is still NOT fully mitigated on-chain —
closing it would require either a timelock (rejected, see Risk 1) or
stale-multiplier checks that themselves depend on the same
compromised key.

**Off-chain mitigation:** the two roles MUST be held by separate
keys / multisigs, both rotated to multisigs before mainnet.
Documented in NatSpec on `OkuDollar.withdrawSurplus`.

### 3. USDC peg monitoring — off-chain (no on-chain oracle)

Both EVM and SVM handle USDC peg monitoring entirely off-chain. EVM
previously had an on-chain `OracleRelay` circuit-breaker (Chainlink
USDC/USD aggregator, gating every mint/redeem path) — this was fully
removed, including the storage slots that referenced it (the
`LitePSM` storage layout was compacted, not `__gap`-padded). SVM's `lite-psm` similarly removed its Pyth
oracle relay. Both chains now converge on the same model: the
off-chain orchestrator monitors the peg and pauses the PSM on a
detected depeg.

### 4. 1-wei share dust in `OkuDollar.transferFrom` under inflated `usdMultiplier`

**Issue:** `OkuDollar` accounts in shares but exposes a
dollar-denominated ERC-20 interface. `transferFrom(amount)` floors
the share conversion. When `usdMultiplier > 1e18`, multiple
sequential `transferFrom` calls against a single permit-approved
allowance may under-consume shares by ~1 share per call due to floor
truncation.

**Status:** documented in NatSpec on `OkuDollar.permit`. The 1-wei
drift always favours the holder, never the protocol. The `Transfer`
event's emitted `value` matches the post-rounding share-converted
amount, preserving the ERC-20 invariant `Σ Transfer.value == Δ
balanceOf`. Integrators planning batched `transferFrom` against a
single permit allowance should account for the sub-call dust.

### 5. `OkuDollar._update` ERC-20 tripwires

`OkuDollar` overrides `transfer` / `transferFrom` to use share-based
accounting, bypassing the inherited `ERC20Upgradeable._update`. The
`_update` override unconditionally reverts (with diagnostic
sub-errors for mint/burn) to ensure all supply changes go through
`wrap()` / `unwrap()`, which manage `usdShares` directly. These are
defensive forward-compat sentinels — the inherited `_mint`/`_burn`
are not called anywhere in `OkuDollar` today. The reverts exist only
to catch a future bug where an upgrade accidentally routes through
`_update`.

### 6. Yield already accrued cannot be reversed

`okuMMultiplier` is strictly monotonic, so a mispriced yield epoch can
only be stopped going forward, never unwound. The recovery ladder is:

| Situation | Recovery |
|---|---|
| Epoch scheduled, not yet started | `cancelPendingYieldEpoch()` — fully clean, zero economic impact |
| Epoch currently streaming | `haltAccrual()` — stops forward accrual only |
| Yield already accrued | **Not recoverable** |

Reversing accrued yield would retroactively undercollateralize the
vault and strand anyone who had already redeemed at the higher value,
so the exposure from a bad rate is bounded by
`badRate × timeToDetect × supply`.

**On-chain mitigation:** `MAX_IMPLIED_APR_BPS` (20% APR) caps how far
a single epoch can move the multiplier, making it the primary defence
against a mispriced or compromised rate. `MIN_EPOCH_DURATION`
prevents an epoch so short it is effectively a step.

**Operational expectation:** monitor `yieldEpochEndsAt()` and alert on
unexpected `YieldEpochStarted` events; the shorter the detection
window, the smaller the unrecoverable amount.

A related consequence: **losses cannot be passed through.** A negative
realized period is handled by distributing nothing, not by lowering
the multiplier. Genuine principal impairment is an off-chain solvency
event.

### 7. Deprecated bridge feature

The on-chain `OkuBridge` / `OkuBridgeRouter` / `NttAdapter` contracts
and all associated tests/scripts/role constants were deleted in a
pre-review cleanup. The historical implementation is preserved on a
separate git branch should it be revisited. No bridge-related code
remains in `src/`, `test/`, or `scripts/`.

---

## Testing

```bash
forge test                                         # All unit + invariant tests (503 total)
forge test --match-path "test/invariants/*"        # Invariant suite (256 runs × 500 depth by default)
forge test --match-contract OkuMoneyTest -vv       # OkuMoney unit tests
forge test --match-contract VaultInvariants        # OkuDollar backing invariants
forge test --match-contract HandlerSanityTest      # Handler success-rate sanity checks

npx hardhat compile                                # Regenerates typechain before fork tests
npx hardhat test                                   # Fork + happyPath + scenarios
npx hardhat test test/hardhat/scenarios/RealWorldUsage.ts  # 365-day simulation + 7 edge cases
```

The Foundry suite is the authoritative functional coverage. The Hardhat suite exists for three specific purposes:
1. **Fork tests** (`test/hardhat/fork/`): exercise the protocol against real mainnet / Sepolia state that Foundry can't reach in CI.
2. **Happy-path integration** (`test/hardhat/happyPath/`): full deposit/yield/withdraw walk-through against the OZ upgrades plugin's real proxy machinery.
3. **Real-world scenario simulation** (`test/hardhat/scenarios/RealWorldUsage.ts`): 365-day stochastic simulation (seeded PRNG, 7 action categories, daily `evm_increaseTime` steps) plus 7 deterministic edge-case suites covering round-trips, queued redeems, multiplier divergence, blacklist/freeze, pause windows, yield-lock, and cap exhaustion.

Any new unit or invariant test should be added to the Foundry suite; Hardhat is reserved for fork-dependent or multi-contract scenario work.

---

## Forge coverage notes

**Current baseline:** **503 / 503 forge tests passing** plus **27 / 27
hardhat tests** (fork + happy-path + scenarios). Per-file coverage:

| File | Lines | Statements | Branches | Funcs |
|---|---|---|---|---|
| `src/lib/MathLib.sol` | **100 %** | 96.00 % | 40.00 % | 100 % |
| `src/lib/ReentrancyGuardUpgradeable.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/lib/SafeApprove.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/psm/LitePSM.sol` | **97.56 %** | 95.48 % | 69.57 % | 100 % |
| `src/token/OkuDollar.sol` | **98.33 %** | 97.25 % | 90.00 % | 97.44 % |
| `src/token/OkuMoney.sol` | **97.51 %** | 97.51 % | 90.91 % | 95.24 % |
| **Total** | **98.06 %** | 96.93 % | 83.93 % | 97.39 % |

A CI gate in `.github/workflows/test.yml` fails the build if any `src/` file
or the overall total drops below **95 % line coverage**.

The test count fell from 564 because the redemption-queue suites
(~1,900 LOC) were deleted with the contract, and the same-block
yield-fence tests were replaced by continuity assertions. Two new
suites were added in their place:

- `test/token/YieldSandwich.t.sol` — runs the original cross-block
  sandwich attack and demonstrates it is no longer profitable
  (216,000× reduction; see [Continuous yield epochs](#continuous-yield-epochs)).
- `test/token/ERC8056Conformance.t.sol` — asserts all four interface
  IDs against the published EIP literals, plus precision, ERC-165
  detection, raw-amount ERC-20 semantics and event emission.

### Uncovered lines (intentional)

The remaining uncovered lines are **defensive guards unreachable from
the contracts as currently composed**. They are kept for
future-proofing against changes to dependent contracts. Driving them
in tests would require malicious mock contracts that misrepresent
the multiplier or share-conversion semantics — a test surface we
judged not worth the maintenance cost.

| Location | Code | Why unreachable today |
|---|---|---|
| `LitePSM.sol` `mintOkuM` | `revert RoundTripDriftTooLarge` | The round-trip check is mathematically bounded above by `usdcAmount` for any well-behaved `okuMMultiplier()`. Defends against an OkuMoney variant whose multiplier mutates between reads inside one transaction — impossible under the current epoch model, where `okuMMultiplier()` is a monotonic function of `block.timestamp` and therefore constant within a transaction. |
| `LitePSM.sol` `_redeemOkuMShared` | `revert OutputBelowMinimum` | `usdcAmount` is computed once. The floor `okuMFloor = (okuMAmount / dm) * dm` then `minUsdcExpected` is bounded above by `usdcAmount` by construction. Defends against an OkuMoney whose multiplier shifts during the same call. |
| `LitePSM.sol` `mintUsdOku` | `revert RoundTripDriftTooLarge` | Mirror of the `mintOkuM` case for the wrap path. |
| `OkuDollar.sol` `_update` | `UseWrapInstead` / `UseUnwrapInstead` / `OkuDollarDoesNotUseInternalUpdate` guards | `OkuDollar` overrides `transfer` / `transferFrom` to use share-based accounting; all supply changes go through `wrap()` / `unwrap()`, which manage `usdShares` directly and never call the inherited `_mint` / `_burn`. Since nothing in the contract invokes `_mint` or `_burn`, this `pure`, unconditionally-reverting override is unreachable today — it exists purely to halt any future refactor that accidentally routes through the inherited ERC-20 `_update` hook. |

### Auditor checklist — sensitive functions

1. **`OkuDollar.withdrawSurplus` post-withdrawal ratio math**
   - `test_WithdrawSurplus_SucceedsAtExactFloor` — `postRatio == minCollateralRatio` (inclusive).
   - `test_WithdrawSurplus_OneWeiBelowFloor_Reverts` — `postRatio == minCollateralRatio - 1 wei` → `BelowMinimumCollateral`.
   - `test_WithdrawSurplus_ZeroObligations_UsesInfiniteRatio` — `obligations == 0` → `type(uint256).max`.
   - `test_WithdrawSurplus_EventPostRatioMatchesView` — post-tx ratio observable matches `collateralizationRatio()`.

2. **`LitePSM._redeemOkuMShared(okuMAtPsm=true)` branch**
   - `test_RedeemUsdOku_OkuMAtPsmInstant_NoOkuMRedeemedEvent` — buffer-covered redemption suppresses `OkuMRedeemed`.
   - Buffer-only: a redemption the buffer cannot cover reverts with `InsufficientBuffer`, so this is the only success path through the branch.

3. **Yield epoch accrual and bounds** (`test/token/OkuMoney.t.sol`, `OkuMoney.fuzz.t.sol`)
   - `test_StartYieldEpoch_DoesNotStepTheMultiplier` — the core anti-sandwich property.
   - `test_StartYieldEpoch_AccruesLinearlyOverTime` — equal increments per quarter-epoch.
   - `test_StartYieldEpoch_FlatlinesPastEndTime` — a missed renewal freezes rather than extrapolates.
   - `testFuzz_AcceptedEpochsRespectAprCap` — any accepted epoch respects `MAX_IMPLIED_APR_BPS`.
   - `testFuzz_DeliveredYieldNeverExceedsRequested` — truncation always favours the protocol.
   - `test_CancelPendingYieldEpoch_RevertsOnceActive` — accrued yield cannot be retroactively removed.
   - `test_HaltAccrual_WorksWhilePaused` / `test_ResumeAccrual_DoesNotBackdate` — the halt lever is independent of pause and cannot backdate.

4. **`setNextUsdYieldRate` boundary conditions (`block.timestamp >= usdRateEnd`)**
   - `test_SetNextUsdYieldRate_RevertAtExactEndBoundary` — `block.timestamp == usdRateEnd` → `RateAlreadyExpired`.
   - `test_SetNextUsdYieldRate_RevertOneSecondPastEnd` — `block.timestamp == usdRateEnd + 1` → `RateAlreadyExpired`.
   - `test_SetNextUsdYieldRate_SucceedsOneSecondBeforeEnd` — `block.timestamp == usdRateEnd - 1` → success.

### Test harnesses

Two test-only harness contracts expose `internal` library surface for
last-mile branches:

- `test/mocks/MathLibHarness.sol` — exposes `MathLib.rpow` so the
  `x == 0` and `mul`-overflow branches of MakerDAO's `rpow` assembly
  are reachable from Solidity.
- `test/mocks/ReentrancyGuardHarness.sol` — exposes `nonReentrant`
  so the `ReentrancyGuardReentrantCall` revert can be driven
  directly.

Neither is in any production import path.

---

## Dependencies — pinned for audit

All `^` ranges in `package.json` have been replaced with exact
versions, and the Foundry submodule pins in `foundry.lock` are
aligned with the Node-side OpenZeppelin packages so both compile
paths (Foundry, Hardhat) produce bytecode against identical sources.

### Solidity sources

| Library | Version | Source |
|---|---|---|
| `solc` (compiler) | `0.8.28` | `foundry.toml`, `hardhat.config.ts` |
| `@openzeppelin/contracts` | `5.6.1` | `package.json` (Hardhat path) |
| `@openzeppelin/contracts-upgradeable` | `5.6.1` | `package.json` (Hardhat path) |
| `lib/openzeppelin-contracts` | `v5.6.1` @ `5fd1781b1454fd1ef8e722282f86f9293cacf256` | `foundry.lock` (Foundry path) |
| `lib/openzeppelin-contracts-upgradeable` | `v5.6.1` @ `7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf` | `foundry.lock` (Foundry path) |
| `lib/forge-std` | `v1.12.0` @ `7117c90c8cf6c68e5acce4f09a6b24715cea4de6` | `foundry.lock` |

Both compile paths build against **OpenZeppelin v5.6.1**. The prior
drift (Foundry on 5.5.0, Hardhat resolving to 5.4.0 from `^5.4.0`)
is closed.

### Node tooling

Pinned exactly in `EVM/package.json`:

| Package | Version |
|---|---|
| `@nomicfoundation/hardhat-toolbox` | `6.1.2` |
| `@openzeppelin/hardhat-upgrades` | `3.9.0` |
| `@typechain/ethers-v6` | `0.5.1` |
| `@typechain/hardhat` | `9.1.0` |
| `ethers` | `6.16.0` |
| `hardhat` | `2.28.6` |
| `hardhat-deploy` | `0.12.4` |
| `hardhat-deploy-ethers` | `0.4.2` |
| `typechain` | `8.3.2` |
| `typescript` | `5.6.3` |
| `ts-node` | `10.9.2` |
| `chai` | `4.5.0` |
| `dotenv` | `17.2.3` |
| `bs58` | `6.0.0` |

### OpenZeppelin 5.4 → 5.6.1 breaking-change review (audit-relevant)

The following 5.6.0 breaking changes were reviewed against the
OkuMoney contracts; **none affect us**:

- `Strings.escapeJSON` escape-range expansion — not used.
- `ERC1155` single-element batch transfer callback change — not used.
- `ERC1967Proxy` / `TransparentUpgradeableProxy` mandate initialization
  during construction — we deploy UUPS proxies via
  `@openzeppelin/hardhat-upgrades`, which always calls `initialize`
  as part of `deployProxy`. Verified via the Hardhat integration
  suite.
- `ERC721` / `ERC1155` operator allowance changes — neither standard
  is used.
- `RLP` `encode(bytes32)` fixed-size change — not used.
- `ERC4337Utils` / `WebAuthn` / `Memory` API changes —
  account-abstraction and webauthn modules not used.
- `Math`, `SafeERC20`, `AccessControl`, `Pausable`, `ERC20*`,
  `UUPSUpgradeable`, `Initializable` — no behavioural changes
  between 5.4 and 5.6.1 affecting our call sites. Storage layouts
  within `5.x` are guaranteed compatible by the OpenZeppelin release
  process.

### `npm audit` posture

`npm audit` reports vulnerabilities in transitive dev dependencies
pulled in by `hardhat-deploy` and `@nomicfoundation/hardhat-toolbox`.
These do NOT enter production bytecode — JavaScript dev tooling
only — and have no impact on the audited Solidity contracts. Listed
for transparency.

---

## Pointers

- **Workspace overview:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **Accepted risks:** see "Accepted Risks" above
- **SVM-side docs:** [`../SVM/README.md`](../SVM/README.md)
