# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil) for unit + invariant tests; Hardhat for fork + gas-regression tests
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`, `RedemptionQueue`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Contracts

| Contract | Description |
|----------|-------------|
| `src/token/OkuMoney.sol` | Non-rebasing base token (OkuM) — static balance; `okuMMultiplier()` is **computed**, streaming continuously from a rate schedule. Also implements ERC-8056 (Scaled UI Amount) |
| `src/token/OkuDollar.sol` | Rebasing $1-pegged stablecoin (usdOku) wrapping OkuM. `usdMultiplier()` delegates to `okuMoney.okuMMultiplier()` — **single shared multiplier**. IERC4626-interface-conformant with rebasing shares |
| `src/psm/LitePSM.sol` | Peg Stability Module — multiplier-aware USDC ↔ OkuM + usdOku convenience functions |
| `src/psm/RedemptionQueue.sol` | FIFO queue for OkuMoney redemptions when the PSM buffer is depleted |
| `src/lib/YieldSandwichGuard.sol` | Shared abstract enforcing per-block sandwich protection around the **discrete emergency override** (`setOkuMMultiplier`) |
| `src/lib/MathLib.sol` | The single accrual function (`computeMultiplier`, `compoundFor`, `rpow`) + multiplier conversion helpers (`okuMToDollars`, `dollarsToOkuM`, `usdcToDollars`, `dollarsToUsdc`) |
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
  `RedemptionQueue`/`LitePSM` match across testnets; mainnet (real USDC)
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

> **Stale alias:** `npm run operator:distributeYield` still points at the deleted
> `scripts/operator/distributeYield.ts` and will fail. Use
> `scripts/operator/setOkuMYieldRate.ts` (below); the alias should be repointed or
> dropped from `package.json`.

### Operator scripts (yield)

| Script | Purpose |
|---|---|
| [`scripts/utils/yieldRate.ts`](scripts/utils/yieldRate.ts) | **Single source of truth** for APY ↔ per-second rate. Exports `apyToRatePerSecond`, `ratePerSecondToApy`, `realisedYieldToRatePerSecond`, `describeRate`, plus `PRECISION` / `MAX_RATE` / `SECONDS_PER_YEAR`. Every chain MUST receive a byte-identical integer; deriving from a declared APY removes the likeliest cross-chain mismatch (hand-entered 19-digit integers). `SECONDS_PER_YEAR` is **365 days exactly** — a protocol convention, not a calendar fact (SVM's Token-2022 `InterestBearingConfig` uses 365.24, one reason it is unsuitable for EVM parity). `realisedYieldToRatePerSecond` divides by **global** dollar value across all chains, never a local supply. |
| [`scripts/operator/setOkuMYieldRate.ts`](scripts/operator/setOkuMYieldRate.ts) | Replaces the deleted `distributeYield.ts`. Prefers `--apy=<fraction>` (raw `--rate` supported for corrections but warned against). Default path calls `setOkuMYieldRate(rate, endTimestamp)`, requiring a future `endTimestamp` for any yielding rate; `--stage --pendingEndTimestamp=<unix>` calls `setNextOkuMYieldRate(rate, pendingEndTimestamp)` — the **preferred** path, since the successor activates with no transaction at the boundary. Supports `DRY_RUN=true` and requires `--yes-mainnet` to broadcast on mainnet. |
| [`scripts/operator/checkMultiplierDrift.ts`](scripts/operator/checkMultiplierDrift.ts) | Read-only cross-chain drift monitor. Compares `okuMMultiplier()`, rate, `rateEnd`, and pending rate across chains; exits non-zero on any mismatch. `CHAINS`, `TOLERANCE_BPS` (default 1), `EXPIRY_WARN_HOURS` (default 48). Also warns when a rate window is about to close so the successor gets staged in time. |

**Deleted**: `scripts/operator/distributeYield.ts`,
`scripts/operator/setUsdYieldRate.ts`,
`scripts/operator/setMinCollateralRatio.ts`.

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
    OkuMoney.sol            # Non-rebasing base token (computed okuMMultiplier, continuous streaming)
    OkuDollar.sol           # Rebasing stablecoin vault (usdMultiplier delegates to OkuMoney)
  psm/
    LitePSM.sol             # USDC ↔ OkuM (multiplier-aware) + usdOku convenience functions
    RedemptionQueue.sol     # Queue for when PSM USDC buffer is insufficient
  interfaces/
    IOkuMoney.sol           # OkuMoney interface (used by PSM, vault, mocks)
    IOkuDollar.sol          # OkuDollar vault interface
    IScaledUIAmount.sol     # ERC-8056 core + NewUIMultiplier / Conversion / Balances extensions
  lib/
    Roles.sol               # Shared RBAC role constants (prefix-namespaced)
    Constants.sol           # PRECISION, MAX_RATE, MAX_MULTIPLIER, BASIS_POINTS + terminology legend
    Errors.sol              # Shared error types (ZeroAddress, InsufficientBalance, MultiplierCannotDecrease)
    SafeApprove.sol         # USDT-safe approve helpers (setExactAllowance, revokeAllowance)
    MathLib.sol             # computeMultiplier / compoundFor / rpow + conversion helpers
    ReentrancyGuardUpgradeable.sol  # OZ-5.x-compatible upgradeable reentrancy guard
    YieldSandwichGuard.sol  # Shared whenYieldNotDistributing modifier (OkuDollar + LitePSM)
    events/
      OkuMoneyEvents.sol    # Event declarations for OkuMoney
      OkuDollarEvents.sol   # Event declarations for OkuDollar (incl. Blacklisted/Unblacklisted)
      LitePSMEvents.sol     # Event declarations for LitePSM
      RedemptionQueueEvents.sol  # Event declarations for RedemptionQueue (incl. TransferFailed skip)

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

**Multipliers (dollar value per token) — a single shared value, written `m`**
- `okuMMultiplier` — dollar value of 1 OkuMoney token (starts 1e18 = $1.00, only increases).
  **Computed**, not stored: `MathLib.computeMultiplier(base, rate, anchor, rateEnd, pendingRate, block.timestamp)`.
- `usdMultiplier` — dollar value of 1 OkuDollar share. Returns exactly `okuMoney.okuMMultiplier()`.
  OkuDollar holds **no rate state of its own**.
- `uiMultiplier` — ERC-8056 alias for `okuMMultiplier()`.

**Rate-schedule fields (OkuMoney only, packed into 2 storage slots)**
- `okuMBaseMultiplier` — snapshot multiplier taken at `okuMLastAccrualTime`
- `okuMRatePerSecond` — active per-second compounding rate (`PRECISION` = no yield)
- `okuMLastAccrualTime` — timestamp the base was snapshotted at
- `okuMRateEnd` — timestamp the active rate expires (`0` only when halted — every
  yielding rate carries a mandatory bounded future window)
- `okuMPendingRatePerSecond` — successor rate; activates off `okuMRateEnd` with **no transaction at the boundary**
- `okuMPendingRateEnd` — timestamp the successor itself expires; bounds how long an
  unattended successor can compound past `okuMRateEnd` before accrual halts

**Token amounts**
- `okuMAmount` — raw OkuMoney token count (18 decimals, non-rebasing)
- `usdAmount` — OkuDollar amount in dollar terms (18 decimals, rebasing)
- `usdcAmount` — USDC amount (6 decimals)

**Shares — terminology hazard**
- `usdShares` — OkuDollar's *internal*, non-rebasing accounting unit. Under the
  single-multiplier design these are numerically identical to the raw OkuM deposited.
- ERC-4626 "shares" — the *rebasing displayed balance* (`balanceOf`, dollar-denominated).

  These are **different quantities**. `convertToShares` returns the latter.

**Conversion constants**
- `PRECISION = 1e18` — base unit for multiplier math
- `usdcDecimalMultiplier` — per-PSM stored value (`= 10 ** (18 - usdcDecimals)`),
  computed at `LitePSM.initialize` from the deployed USDC mint's `decimals()`.
  On every chain we currently target this is `1e12` (USDC has 6 decimals).
- `MAX_RATE = PRECISION + 1e11` — safety cap on `okuMRatePerSecond`
- `BASIS_POINTS = 10_000` — fee denominator

**Key formulas**
```
multiplier:              m(t)         = base × rpow(rate, t − anchor, PRECISION) / PRECISION
USDC → OkuMoney:         okuMAmount   = (usdcAmount × 1e12) × PRECISION / m
OkuMoney → USDC:         usdcAmount   = (okuMAmount × m / PRECISION) / 1e12
OkuMoney → usdOku share: shares       = okuMAmount × m / m          (= okuMAmount)
usdOku → OkuMoney:       okuMAmount   = usdAmount × PRECISION / m
```

The third formula collapsing to the identity is the algebraic consequence of the
single-multiplier design, and is why collateralization is exactly 1.0.

See [`src/lib/Constants.sol`](src/lib/Constants.sol) for the canonical version.

---

## Hardcoded Constants

All of the following are compile-time constants in [`src/lib/Constants.sol`](src/lib/Constants.sol). They cannot be changed without a contract upgrade. Where a constant is a round number or a conventional choice rather than a derived value, the rationale is noted.

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1e18` | Standard 18-decimal fixed-point base. Matches ERC-20 18-decimal convention; $1.00 = 1e18. Not arbitrary — changing it would require rewriting all multiplier math. |
| `MAX_RATE` | `PRECISION + 1e11` (~2242% APY) | Safety cap on `okuMRatePerSecond` / `okuMPendingRatePerSecond` passed to `rpow`. The value is arbitrary in the sense that any number far above realistic T-Bill yields would serve the same purpose. It is calibrated to stay well below `rpow` overflow regions while being comfortably above any plausible real-world rate. Mirrored off-chain as `MAX_RATE` in `scripts/utils/yieldRate.ts`. |
| `MAX_MULTIPLIER` | `1e24` ($1,000,000 per token) | Overflow guard on the shared multiplier, applied inside `MathLib.compoundFor` (which clamps) and by `setOkuMMultiplier` (which reverts `MultiplierTooHigh`). Chosen as a round number six orders of magnitude above the starting value of 1e18. Arbitrary — any ceiling far above realistic yield trajectories would work. Prevents a compromised rebaser key, or a long-running `MAX_RATE`, from bricking downstream multiplier math via overflow. |
| `BASIS_POINTS` | `10_000` | Universal basis-points denominator (100% = 10 000). Industry convention; not arbitrary. |
| `MIN_COLLATERAL_RATIO_FLOOR` | `9e17` (90%) | **DEAD — flagged for removal.** Referenced by nothing in `src/` since the single-multiplier refactor. `minCollateralRatio`, `setMinCollateralRatio`, `withdrawSurplus`, and the `VAULT_ADMIN` role that configured it are all gone; collateralization is exactly 1.0 by construction, so there is no ratio to floor. The constant survives only in `src/lib/Constants.sol` and its `test/shared/Constants.sol` re-export. |
| `MAX_USDC_DECIMALS` | `18` | Cap on `IERC20Metadata.decimals()` accepted at PSM init. USDC uses 6 decimals on all EVM chains; 18 is the ERC-20 max. Prevents misconfiguration with nonsensical decimal counts. Not arbitrary per se — it is the ERC-20 upper bound — but the choice to cap rather than hardcode 6 is intentional forward-compat. |

---

## Dual-Token Shared-Multiplier Model

There is **one multiplier** in the protocol. `OkuDollar.usdMultiplier()` returns
exactly `okuMoney.okuMMultiplier()`; OkuDollar holds no rate state of its own.
OkuM and usdOku therefore **necessarily earn identical yield**.

```
OkuMoney.okuMMultiplier()          ← computed from the rate schedule (OKUM_REBASER)
        │
        └─► OkuDollar.usdMultiplier()   ← delegated, no independent state
```

Protocol margin comes from the **spread between the off-chain RWA yield actually
realized and the rate published on chain**, not from an on-chain rate differential
between the two tokens.

Consequences:

- `wrap` reduces algebraically to `mulDiv(A, m, m) == A`, so internal `usdShares`
  are numerically identical to the raw OkuM deposited.
- **Collateralization is exactly 1.0 by construction** — shares are only ever
  minted or burned 1:1 against real OkuM at the same `m`. There is no
  over/under-collateralized state to reach, hence no surplus to withdraw and no
  minimum ratio to configure. The `depositReserves` / `withdrawSurplus` /
  `minCollateralRatio` machinery and the `VAULT_REBASER` / `VAULT_RESERVE_MANAGER`
  / `VAULT_ADMIN` roles were all deleted.
- The vault is **structurally immune to the ERC-4626 inflation/donation attack**,
  because conversions use `m` rather than `totalAssets/totalSupply`. The corollary
  is that donated OkuM accrues to nobody — see `rescueDonation`.

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20; the multiplier
appreciates, balances do not). OkuDollar is **rebasing** ($1-pegged; `balanceOf`
grows with `m` every second, with no transaction).

### Complexity, honestly

This pivot is a real state-space reduction (one rate schedule instead of two,
collateralization an invariant instead of a monitored parameter, schedule storage
5→2 slots, OkuMoney 9→6 storage slots) — but it is **not a net line-count
simplification**. `src/` sits at ~3,300 lines vs. the prior design's ~2,850
(+~450), because this branch also bundles in ERC-4626 and ERC-8056 conformance,
plus the mandatory-bounded-window machinery those two additions and the
MEV-elimination goal require. Both standards are optional in isolation; they
were adopted here for external composability and UI-multiplier discoverability,
not because the multiplier pivot needed them. An auditor reviewing this branch
is reviewing three changes at once (single multiplier, ERC-4626, ERC-8056), not
one.

---

## Streaming Accrual & Cross-Chain Determinism

The multiplier used to move in discrete jumps written by the orchestrator. Two
problems drove the move to continuous streaming:

1. **MEV.** A discrete jump is sandwichable. An arbitrageur could `mintOkuM` one
   block before a tick and `redeemOkuM` one block after, capturing a whole
   period's yield for ~12 seconds of capital exposure.
2. **Cross-chain coordination.** Every discrete tick had to be sequenced across
   all N chains inside a tight window, forever. Any divergence between chains was
   directly extractable by bridging between them.

### The multiplier is computed, not stored

```solidity
function okuMMultiplier() public view returns (uint256) {
    return MathLib.computeMultiplier(
        okuMBaseMultiplier,
        okuMRatePerSecond,
        okuMLastAccrualTime,
        okuMRateEnd,
        okuMPendingRatePerSecond,
        block.timestamp
    );
}
```

`computeMultiplier` is a MakerDAO `chi`/DSR-style `rpow` accumulator: it compounds
the active rate from the anchor, rolls over to the pending rate at `okuMRateEnd`,
and clamps at `MAX_MULTIPLIER`. `rpow` itself is unchanged (MakerDAO `pot.sol`
assembly, half-up rounding).

**No discrete step ⇒ nothing to sandwich.** `setOkuMYieldRate` re-anchors the base
to the *current* value, so the curve is continuous across the write; this is why
it deliberately does not stamp `lastYieldDistributionBlock`.

### Cross-chain agreement comes for free

`computeMultiplier` contains **no supply term**, and `block.timestamp` is
wall-clock on every EVM chain. So given identical schedule state, every chain
returns the identical `uint256` at the identical instant — **no messaging, no
light client, no state proofs**.

The coordination requirement drops from *per-tick* to *per-epoch*. Every window —
the active rate's `okuMRateEnd` AND a staged successor's `okuMPendingRateEnd` — is
mandatorily bounded (see `setOkuMYieldRate` / `setNextOkuMYieldRate`), so the
failure mode inverts: a missed transaction **halts accrual** (safe, recoverable)
once the bounded window elapses, rather than compounding unbounded or **causing
divergence** (extractable).

This is also why `distributeYield()` was removed. It divided a dollar amount by
*local* `totalSupply()` — the one genuinely supply-dependent path in the protocol —
so it produced a different multiplier delta on every chain. Dollars→rate conversion
moved off-chain to `scripts/utils/yieldRate.ts` (`realisedYieldToRatePerSecond`),
which divides by **global** dollar value across all chains.

### The pre-staged successor rate

`setNextOkuMYieldRate(newRate, pendingEndTimestamp)` arms `okuMPendingRatePerSecond`
and its own bounded window, `okuMPendingRateEnd` (must be strictly after the
current `okuMRateEnd`). The handover fires off the **absolute `okuMRateEnd`
timestamp inside the view function, with no transaction at the boundary**. Staging
transactions may land on different chains at different times — even days apart —
and the activation is still simultaneous to the second. This is the primitive that
makes cross-chain epoch handovers exact. `pendingEndTimestamp` bounds how long that
successor can compound unattended before accrual halts, in case the next scheduled
write is itself missed.

---

## Rear-Facing Epoch Pipeline (operational model)

Yield is **rear-facing with explicit epochs**: the protocol only ever pays out
yield that has already been earned.

The chicken-and-egg problem: epoch N's realized yield is only known *after* N
closes, but streaming it over N+1 would require the rate to be set exactly at the
N→N+1 boundary — a transaction on every chain at every boundary, reintroducing
precisely the per-tick coordination the refactor eliminated.

**Resolution: a one-epoch pipeline.**

```
epoch N      epoch N+1                    epoch N+2
├──────────┤ ├──────────────────────────┤ ├──────────────────────────┤
 yield        N's yield is measured;       N's realized yield STREAMS
 earned       rate for N+2 pre-staged
              via setNextOkuMYieldRate
              (well ahead of the boundary)
                                          ↑ zero transactions here —
                                            all chains flip bit-identically
```

Epoch N's realized yield streams during **N+2**, pre-staged via
`setNextOkuMYieldRate` well before the boundary. Because nothing is broadcast at
the boundary itself, every chain flips at the same second.

**Cost:** a two-epoch lag between earning and paying.

### Operational notes

- **Every yielding rate requires a bounded `okuMRateEnd` window.** Open-ended
  yielding rates are no longer supported — `endTimestamp = 0` is only valid when
  explicitly halting (`newRate == PRECISION`). `setNextOkuMYieldRate` additionally
  requires `pendingEndTimestamp` strictly after the current `okuMRateEnd`.
- **Re-arming an unchanged rate is exactly skew-free.** Broadcast skew `δ` between
  chains on the re-anchor path causes a permanent divergence of
  `(r_old / r_new)^δ` — which is exactly `1` when the rate does not move. The
  initial `0% → r` activation is the one genuinely skew-sensitive event.
- Rates are always **derived from a declared APY** via `scripts/utils/yieldRate.ts`
  so every chain receives a byte-identical integer.

---

## OkuMoney.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`, plus the four ERC-8056 interfaces.

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through multiplier appreciation, **computed continuously** from a rate schedule — see [Streaming Accrual](#streaming-accrual--cross-chain-determinism).

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuMoneyStorage {
    // Streaming yield schedule — the multiplier is COMPUTED from these six fields,
    // packed into 2 storage slots (uint96/uint64/uint64 | uint48/uint48/uint48).
    uint96 okuMBaseMultiplier;                  // Snapshot at okuMLastAccrualTime (starts 1e18)
    uint64 okuMRatePerSecond;                   // Active rate (PRECISION = no yield)
    uint64 okuMPendingRatePerSecond;            // Successor; activates at okuMRateEnd, no tx needed
    uint48 okuMLastAccrualTime;                 // Timestamp the base was snapshotted
    uint48 okuMRateEnd;                         // Active rate expiry (0 only when halted)
    uint48 okuMPendingRateEnd;                  // Successor's own expiry; bounds the overhang
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
    uint256 lastYieldDistributionBlock;         // Stamped ONLY by setOkuMMultiplier (emergency override)
}
```

The single `okuMMultiplier` slot was replaced by the six packed schedule fields.
`minterAllowance`, `maxSupply`, `isBlacklisted`, and `lastYieldDistributionBlock`
are unchanged. Every downcast at write time goes through `SafeCast`, so a value
outside a field's range reverts rather than silently truncating.

### Multiplier Model

`okuMMultiplier()` is a **computed view**, not a stored value.

| Function | Role | Effect |
|---|---|---|
| `setOkuMYieldRate(newRate, endTimestamp)` | `OKUM_REBASER` | Snapshots the current multiplier into `okuMBaseMultiplier`, resets `okuMLastAccrualTime` to now, sets the active rate + window, and **clears any armed pending rate**. Continuous across the write — no step, so it does NOT stamp `lastYieldDistributionBlock`. `endTimestamp` must be 0 when `newRate == PRECISION` (halting) and strictly future otherwise — every yielding rate carries a bounded window. Pause-gated for INCREASES only (`newRate > current` reverts while paused); decreases (including zeroing) remain available for incident response. |
| `setNextOkuMYieldRate(newRate, pendingEndTimestamp)` | `OKUM_REBASER` | Pre-stages the successor. Activates off the absolute `okuMRateEnd` with **no transaction at the boundary**. Requires a bounded active window (`NoRateEndSet` if `okuMRateEnd == 0`) that has not elapsed (`RateAlreadyExpired`), and `pendingEndTimestamp` strictly after `okuMRateEnd` — bounding how long the successor can compound unattended. |
| `setOkuMMultiplier(newMultiplier)` | `OKUM_REBASER` | **Emergency discrete override.** Writes `okuMBaseMultiplier = newMultiplier`, resets `okuMLastAccrualTime` to now, and collapses the rate schedule to halted (`okuMRatePerSecond`/`okuMPendingRatePerSecond` = `PRECISION`, `okuMRateEnd`/`okuMPendingRateEnd` = 0) — an operator must re-arm via `setOkuMYieldRate`. Enforces `newMultiplier > current` and `<= MAX_MULTIPLIER`. Pause-gated. Stamps `lastYieldDistributionBlock`. |

`setOkuMMultiplier` is the **sole remaining reason** `lastYieldDistributionBlock`
and `YieldSandwichGuard` / `whenYieldNotDistributing` still exist.

**`distributeYield()` was REMOVED.** It divided by *local* `totalSupply()`,
producing a different multiplier delta per chain. See
[Streaming Accrual](#streaming-accrual--cross-chain-determinism).

**Rear-facing yield**: the orchestrator only ever publishes rates derived from
realized T-Bill returns — see [Rear-Facing Epoch Pipeline](#rear-facing-epoch-pipeline-operational-model).

### IOkuMoney Interface

```solidity
interface IOkuMoney is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function okuMMultiplier() external view returns (uint256);
    function setOkuMYieldRate(uint256 newRate, uint256 endTimestamp) external;
    function setNextOkuMYieldRate(uint256 newRate, uint256 pendingEndTimestamp) external;
    function okuMRatePerSecond() external view returns (uint256);
    function okuMEffectiveRatePerSecond() external view returns (uint256);
    function okuMRateEnd() external view returns (uint256);
    function okuMPendingRatePerSecond() external view returns (uint256);
    function okuMPendingRateEnd() external view returns (uint256);
    function setOkuMMultiplier(uint256 newMultiplier) external;
    function lastYieldDistributionBlock() external view returns (uint256);
}
```

`okuMBaseMultiplier()` and `okuMLastAccrualTime()` are additionally exposed on the
contract for off-chain schedule reconstruction.

### ERC-8056 (Scaled UI Amount)

OkuMoney implements [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056) over the
same multiplier. Declared in `src/interfaces/IScaledUIAmount.sol`.

| Interface | ID | Members |
|---|---|---|
| `IScaledUIAmount` (core) | `0xa60bf13d` | `uiMultiplier()`, events `UIMultiplierUpdated` / `UIMultiplierUpdateCancelled` |
| `IScaledUIAmountNewUIMultiplier` (required ext) | `0x4bd27648` | `newUIMultiplier()`, `effectiveAt()` |
| `IScaledUIAmountConversion` (optional ext) | `0x57854fc3` | `toUIAmount()`, `fromUIAmount()` |
| `IScaledUIAmountBalances` (optional ext) | `0xd890fd71` | `balanceOfUI()`, `totalSupplyUI()` |

All four are advertised through `supportsInterface()` (ERC-165).

> **ERC-8056 is a DRAFT standard.** The interface IDs above are taken from the
> current draft and **may change before Final**. See
> [Accepted Risks](#accepted-risks).

**Two deliberate deviations**, because the EIP is shaped for discrete multiplier
steps and OkuMoney streams continuously:

1. The spec says emit `UIMultiplierUpdated` "whenever the multiplier is changed".
   Under streaming the multiplier changes **every second**, so a per-change event
   is not satisfiable. OkuMoney emits it on **rate-schedule changes only** — the
   only discrete events in the system (`setOkuMYieldRate`, `setOkuMMultiplier`).
2. `newUIMultiplier()` / `effectiveAt()` presume a scheduled *value*. OkuMoney
   schedules a pending *rate*, so `newUIMultiplier()` returns the multiplier
   **projected** to be in effect at `effectiveAt()` (= `okuMRateEnd`). With no
   window or no pending rate armed, it returns the current multiplier.

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not multiplier-adjusted).
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion).
- `okuMMultiplier()` is a computed view for pricing — used by PSM and vault, not by `balanceOf`.
- `mint()` creates raw tokens; minting 100 tokens when `okuMMultiplier = $1.05` creates $105 of value.
- The PSM handles USDC ↔ OkuMoney conversion using `okuMMultiplier()` (dollar-value aware).
- **`TransferValue` was REMOVED from OkuMoney.** Under streaming accrual the dollar
  value would require an `rpow` on every transfer (~5–10k gas, forever); without
  the dollar-value field the event duplicates ERC-20 `Transfer` exactly. Indexers
  derive dollar value off-chain from the rate schedule. (OkuDollar keeps its own
  distinct `TransferValue`, which carries *shares* — a quantity `Transfer` does
  not expose.)
- Blacklist and pause checks apply to transfers; self-burn works while paused.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20; emitted on mint/burn/transfer. |
| `OkuMYieldRateUpdated(oldRate, newRate, endTimestamp, snapshotMultiplier)` | `setOkuMYieldRate`. Snapshot included for off-chain schedule reconstruction. |
| `NextOkuMYieldRateSet(newRate, activatesAt, expiresAt)` | `setNextOkuMYieldRate`; `activatesAt` = current `okuMRateEnd`, `expiresAt` = `okuMPendingRateEnd` (bounds the overhang if left unattended). |
| `OkuMMultiplierUpdated(oldMultiplier, newMultiplier, totalSupply, blockNumber)` | `setOkuMMultiplier` **only** (the emergency override). `blockNumber` is indexed. Never emitted for streaming accrual. |
| `UIMultiplierUpdated(oldMultiplier, newMultiplier, effectiveAtTimestamp)` | ERC-8056. Emitted on rate-schedule changes and on the discrete override — see deviation (1) above. |
| `MinterAllowanceUpdated(minter, oldAllowance, newAllowance)` | Emitted by `configureMinterAllowance`. |
| `MaxSupplyUpdated(oldMaxSupply, newMaxSupply)` | Emitted by `setMaxSupply`. |
| `Blacklisted(account)` / `Unblacklisted(account)` | Blacklist state changes. |
| `Approval(owner, spender, value)` | Standard ERC-20 approval. |

Removed: `TransferValue`, `YieldDistributed`.

### Errors

New in this refactor: `InvalidRate` (rate `< PRECISION` would shrink the
multiplier), `RateTooHigh` (rate `> MAX_RATE`), `EndTimestampNotAllowed`
(halting requires `endTimestamp == 0`), `EndTimestampInPast` (a yielding rate's
`endTimestamp` must be strictly future), `PendingEndNotAfterRateEnd`
(`setNextOkuMYieldRate`'s window must extend past the active rate's), `NoRateEndSet`,
`RateAlreadyExpired`.
Removed: `YieldTooSmall`.

### Blacklist Exemption

`blacklist()` deliberately does NOT use `whenNotPaused` — critical for the pause-to-blacklist protocol so operators can act during a paused incident.

### Role Constants

```solidity
bytes32 public constant OKUM_UPGRADER          = keccak256("OKUM_UPGRADER");
bytes32 public constant OKUM_PAUSER            = keccak256("OKUM_PAUSER");
bytes32 public constant OKUM_UNPAUSER          = keccak256("OKUM_UNPAUSER");
bytes32 public constant OKUM_MINTER            = keccak256("OKUM_MINTER");
bytes32 public constant OKUM_BURNER            = keccak256("OKUM_BURNER");
bytes32 public constant OKUM_REBASER           = keccak256("OKUM_REBASER");
bytes32 public constant OKUM_BLACKLISTER       = keccak256("OKUM_BLACKLISTER");
bytes32 public constant OKUM_UNBLACKLISTER     = keccak256("OKUM_UNBLACKLISTER");
bytes32 public constant OKUM_CAP_MANAGER       = keccak256("OKUM_CAP_MANAGER");
bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");
```

See [Role Grants Policy](#role-grants-policy) below for how roles are distributed at init.

---

## OkuDollar.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `YieldSandwichGuard`, `UUPSUpgradeable`.

**Concept**: Rebasing $1-pegged stablecoin wrapping OkuMoney. **Single multiplier** — `usdMultiplier()` returns exactly `okuMoney.okuMMultiplier()`; the vault holds no rate state of its own. Implements the IERC4626 surface with **rebasing** shares (see below); does not inherit OZ's `ERC4626Upgradeable`.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuDollarStorage {
    IOkuMoney okuMoney;
    mapping(address => uint256) usdShares;   // Internal accounting unit — NOT ERC-4626 "shares"
    uint256 totalUsdShares;
    mapping(address => bool) isBlacklisted;
}
```

**Removed**: `usdBaseMultiplier`, `usdRatePerSecond`, `usdLastAccrualTime`,
`usdRateEnd`, `usdPendingRatePerSecond` (accrual lives solely on OkuMoney) and
`minCollateralRatio` (collateralization is 1.0 by construction).

`initialize()`'s signature changed accordingly — the trailing
`uint256 _minCollateralRatio` parameter was dropped.

**Removed functions**: `setUsdYieldRate`, `setNextUsdYieldRate`, `depositReserves`,
`withdrawSurplus`, `setMinCollateralRatio`, `collateralizationRatio()`,
`surplus()`, and the corresponding storage getters.

### USD Multiplier (delegated)

```solidity
function usdMultiplier() public view returns (uint256) {
    return okuMoney.okuMMultiplier();
}
```

`balanceOf(user)` returns `usdShares[user] × usdMultiplier() / PRECISION` — this
value changes every second, without any transaction, because OkuMoney's multiplier
streams. Rate scheduling is done on OkuMoney by `OKUM_REBASER`; there is no
vault-side setter.

### Wrap / Unwrap (Multiplier-Aware)

```solidity
// wrap:   sharesToMint = actualReceived × okuMMultiplier / usdMultiplier   (= actualReceived)
//         usdMinted    = sharesToMint × usdMultiplier / PRECISION
function wrap(uint256 okuMAmount, address receiver, uint256 minAmountOut)
    public returns (uint256 usdMinted);

// unwrap: okuMReturned = floor(usdAmount × PRECISION / okuMMultiplier)
//         sharesToBurn = ceil(usdAmount × PRECISION / usdMultiplier)  -- rounded UP to favour vault
function unwrap(uint256 usdAmount, address receiver)
    public returns (uint256 okuMReturned);
```

Both are now `public` (previously `external`) so the ERC-4626 entry points can
call them internally.

Both are protected by `whenYieldNotDistributing` (via `YieldSandwichGuard`),
`whenNotPaused` (full freeze), and `nonReentrant`. `unwrap` reverts with
`InsufficientBalance` if the caller's share balance is below `sharesToBurn`, or
`InsufficientReserves` if the vault's OkuMoney reserves are below `okuMReturned`.
These two errors are intentionally distinct — the first is a user balance check,
the second a reserves check.

### ERC-4626 Surface

| Group | Members |
|---|---|
| Asset / accounting | `asset()` (= OkuMoney), `totalAssets()` (= `totalOkuMReserves()`) |
| Conversion | `convertToShares`, `convertToAssets` |
| Limits | `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem` |
| Previews | `previewDeposit`, `previewMint`, `previewWithdraw`, `previewRedeem` |
| Entry points | `deposit`, `mint`, `withdraw`, `redeem` (thin wrappers over `wrap` / `unwrap`) |
| Events | `Deposit` (emitted by `wrap`), `Withdraw` (emitted by `unwrap`) |

**Deliberately does NOT inherit OZ `ERC4626Upgradeable`.** OZ's `_convertTo*`
assume a **static share balance with a floating ratio**. UsdOku shares **rebase**:
the balance grows with `m` while the price stays pinned at $1. This is the
stETH / aToken shape — Aave ships aTokens as non-4626 with a separate static
wrapper for exactly this reason. The accurate description is
**"IERC4626-interface-conformant with rebasing shares"**, not vanilla OZ 4626.

Conversions use `m` directly rather than `totalAssets / totalSupply`, which is
what makes the vault **structurally immune to the ERC-4626 inflation/donation
attack**.

> **TERMINOLOGY HAZARD.** Internal `usdShares` (the non-rebasing accounting unit)
> and ERC-4626 "shares" (the rebasing displayed balance) are **different
> quantities** in this design. `convertToShares` returns the latter.

`deposit` / `mint` carry no slippage parameter in the 4626 signature, so they pass
`minAmountOut = 0`. EOAs should prefer `wrap` directly.

### Donation Rescue (`VAULT_RESCUER`)

```solidity
function rescueDonation(uint256 amount, address receiver) external;   // VAULT_RESCUER, nonReentrant
```

The corollary of inflation-attack immunity: OkuM transferred directly to the vault
accrues to **nobody** and would otherwise be locked forever. `rescueDonation` is
the escape hatch. It cannot touch backing — `totalUsdShares` is the OkuM required
to honour every outstanding share (shares track raw OkuM 1:1), so only the excess
above that is withdrawable. Reverts `NoDonationAvailable` otherwise. Emits
`DonationRescued`.

### Pause Behavior

Pause is a **full freeze**. The following are gated behind `whenNotPaused`:

- OkuMoney: peer-to-peer `transfer` / `transferFrom` (mint also; burn is NOT gated — self-burn works while paused to support the pause-to-blacklist protocol), plus the discrete `setOkuMMultiplier` override.
- OkuDollar: `transfer` / `transferFrom`, `wrap`, `unwrap` (and therefore the 4626 entry points).
- LitePSM: `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`, `processQueue`.

**`setOkuMYieldRate` and `setNextOkuMYieldRate` are decrease-only while paused**,
not fully gated and not fully open. Both compare the new rate against
`okuMEffectiveRatePerSecond()` (not raw storage, which can be stale once a lower
pending rate has already taken over — see `MathLib.computeMultiplier`) and revert
`EnforcedPause` on any increase. Operators can still **zero the rate** (or lower
it) during a paused incident on either setter; what's blocked is staging or
activating a *higher* rate while users cannot exit to arbitrage away the eventual
unpause. Without this on `setNextOkuMYieldRate` specifically, an operator could
stage a `MAX_RATE` successor during a pause that activates at `okuMRateEnd` with
no transaction at the boundary — the same inflate-while-paused vector the gate on
the active setter closes. The discrete `setOkuMMultiplier` override remains fully
pause-gated (any change, not just increases), because it is a state effect that
must freeze alongside transfers, not a config change.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20, with the effective post-rounding dollar amount (preserves `Σ Transfer.value == Δ balanceOf`). |
| `TransferValue(from, to, shares, dollarValue)` | OkuDollar-specific; exposes share-level accounting that `Transfer` cannot. Distinct from the (now removed) OkuMoney `TransferValue`. |
| `Wrapped(user, receiver, okuMAmount, usdMinted, okuMMultiplier, usdMultiplier)` | Both multipliers snapshotted (identical under the single-multiplier design, retained for indexer compatibility). |
| `Unwrapped(user, receiver, usdAmount, okuMReturned, okuMMultiplier, usdMultiplier)` | Both multipliers snapshotted. |
| `Deposit(sender, owner, assets, shares)` | ERC-4626; emitted by `wrap`. |
| `Withdraw(sender, receiver, owner, assets, shares)` | ERC-4626; emitted by `unwrap`. |
| `DonationRescued(receiver, okuMAmount)` | `rescueDonation`. |
| `Blacklisted(account)` / `Unblacklisted(account)` | Blacklist state changes. |

Removed: `UsdYieldRateUpdated`, `NextUsdYieldRateSet`, `MinCollateralRatioUpdated`,
`ReservesDeposited`, `SurplusWithdrawn`.

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

`redeemUsdOku` has two distinct failure modes: (a) vault reserves below `okuMReturned` → `unwrap` reverts with `InsufficientReserves` → entire tx reverts; (b) vault has OkuM but PSM buffer insufficient → OkuM goes to the redemption queue.

`_redeemUsdOku` reads the **post-transfer balance delta** and passes that to
`unwrap`, rather than the caller-supplied `usdAmount`. This is required because
`OkuDollar.transferFrom` floors the share conversion while `unwrap` ceils the
share burn: at `m > 1e18` the two diverge by up to 1 share and `unwrap` would
revert `InsufficientBalance`. The same asymmetry is still open on
`OkuDollar._redeemShares` — see Accepted Risks 11a.

Every user-facing PSM function is protected by `whenYieldNotDistributing` + `whenNotPaused`.

### Admin / Operator Surface

```solidity
function depositBuffer(uint256 amount) external;                           // PSM_BUFFER_DEPOSITOR
function withdrawUsdc(address to, uint256 amount) external;                // PSM_BUFFER_WITHDRAWER — reverts with ZeroAddress on to == 0; WouldStrandQueue protection
function processQueue(uint256 startIndex, uint256 endIndex, uint256 approveAmount) external;  // PSM_QUEUE_PROCESSOR. whenNotPaused + nonReentrant.
function pause() / unpause() external;                                     // PSM_PAUSER / PSM_UNPAUSER
```

### Events

| Event | Parameters |
|---|---|
| `OkuMMinted(user, usdcAmount, okuMAmount, okuMMultiplier)` | `mintOkuM` success. |
| `OkuMRedeemed(user, okuMIn, usdcOut, okuMMultiplier)` | `redeemOkuM` instant path only. Queued path emits `RedemptionQueued` instead. |
| `UsdOkuMinted(user, usdcAmount, usdAmount, okuMMultiplier)` | `mintUsdOku` success. |
| `UsdOkuRedeemed(user, usdIn, usdcOut, okuMMultiplier)` | `redeemUsdOku` — sole event for this path; no inner `OkuMRedeemed` is emitted. |
| `BufferRefilled(newBufferBalance, processedStart, processedEnd)` | After `processQueue`. |
| `BufferDeposited(depositor, amount, newBufferBalance)` | After `depositBuffer`. |
| `BufferWithdrawn(to, amount, newBufferBalance)` | After `withdrawUsdc`. |

---

## RedemptionQueue.sol

Stores raw OkuMoney token amounts. Since OkuMoney is non-rebasing, queued tokens don't grow in balance — but they appreciate in dollar value via `okuMMultiplier()`. At processing time, `usdcAmount = okuMAmount × okuMMultiplier() / PRECISION` (scaled to 6 decimals). The multiplier is cached once per batch for gas efficiency and cross-entry consistency.

`enqueue(user, okuMTokenAmount)` is record-only — the PSM transfers OkuMoney into the queue before calling. `processQueue(startIndex, endIndex)` (called by the PSM via `QUEUE_PSM`) burns OkuMoney, pulls USDC from the PSM, and pays users. `rescueQueueEntry(index, alternateRecipient)` returns OkuMoney to a stuck entry (e.g., USDC-blacklisted recipient) — called by `QUEUE_RESCUER`.

`processQueue` and `rescueQueueEntry` do NOT auto-advance `queueHead`. Operators (or anyone — the call is permissionless) call `advanceHead(maxSlots)` after a batch to amortize the head walk into a separate, gas-bounded transaction. `queueLength()` is an upper bound on live entries until `advanceHead` runs; redemption correctness is independent of the cursor.

### Events

| Event | Parameters |
|---|---|
| `RedemptionQueued(user, okuMAmount, dollarValue, position, queueLength)` | `enqueue`. |
| `RedemptionProcessed(user, okuMAmount, dollarValue, usdcAmount, waitTime)` | `processQueue` success. |
| `RedemptionSkipped(index, reason)` | `reason` is `AlreadyCleared`, `InsufficientFunds`, or `TransferFailed`. |
| `RedemptionRescued(index, originalUser, recipient, okuMAmount, dollarValue)` | `rescueQueueEntry`. |
| `QueueHeadAdvanced(newHead, slotsAdvanced)` | `advanceHead` (only when slots were actually skipped). |

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
`OkuDollar` / `LitePSM` / `RedemptionQueue` contracts are required.

---

## YieldSandwichGuard

Shared abstract at `src/lib/YieldSandwichGuard.sol`, inherited by both `OkuDollar` and `LitePSM`. Exposes the `whenYieldNotDistributing` modifier and the `YieldDistributionInProgress` error.

> **Narrowed scope after the streaming refactor.** Continuous accrual has no
> discrete step to sandwich, so normal yield operation does not engage this guard
> at all — `setOkuMYieldRate` and `setNextOkuMYieldRate` deliberately do **not**
> stamp `lastYieldDistributionBlock`. The guard now protects **only** the discrete
> emergency override `setOkuMMultiplier`, which is the one remaining function that
> creates a discontinuity. It is retained solely for that path.

```solidity
abstract contract YieldSandwichGuard {
    error YieldDistributionInProgress();

    modifier whenYieldNotDistributing() {
        if (block.number == _yieldSandwichOkuMoney().lastYieldDistributionBlock()) {
            revert YieldDistributionInProgress();
        }
        _;
    }

    function _yieldSandwichOkuMoney() internal view virtual returns (IOkuMoney);
}
```

OkuMoney records `lastYieldDistributionBlock = block.number` inside `setOkuMMultiplier` — and nowhere else. OkuDollar and LitePSM inherit the guard and override `_yieldSandwichOkuMoney()` to return their stored `okuMoney` reference. Result: **any** PSM mint/redeem or vault wrap/unwrap that lands in the same block as a discrete override reverts with `YieldDistributionInProgress`. The lock releases automatically on the next block.

**Protected operations**:
- `LitePSM.mintOkuM` / `redeemOkuM` / `mintUsdOku` / `redeemUsdOku` (+ permit variants)
- `OkuDollar.wrap` / `unwrap`

**Unaffected**: OkuMoney transfers, OkuDollar transfers, operations in subsequent blocks.

---

## Role Grants Policy

Every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, rescuers, etc.) to other parties (multisigs, bots) post-deployment via `grantRoles.ts` or `grantRolesMainnet.ts`. This removes contract-specific role plumbing from deployment scripts.

One intentional exception:
- `RedemptionQueue.QUEUE_PSM` is NOT granted at init — it is granted post-deploy to the `LitePSM` proxy address. This avoids a circular deployment dependency AND keeps admin from being able to call `enqueue` / `processQueue` directly (bypassing the PSM).

**Vault role changes in the single-multiplier refactor** (`src/lib/Roles.sol`):

| Role | Status |
|---|---|
| `VAULT_REBASER` | **Removed.** OkuDollar has no rate of its own; accrual is set on OkuMoney via `OKUM_REBASER`. |
| `VAULT_RESERVE_MANAGER` | **Removed.** Collateralization is 1.0 by construction — no surplus to withdraw, no reserves to top up. |
| `VAULT_ADMIN` | **Removed.** No `minCollateralRatio` to configure. |
| `VAULT_RESCUER` | **Added.** Sole holder of `rescueDonation`. |

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
| `VAULT_RESCUER` | Cold Multisig | Withdraw OkuM **donated** directly to the vault | Cannot touch backing — anything at or below `totalUsdShares` is off limits (`NoDonationAvailable`). See the 1-wei-per-unwrap caveat in Accepted Risks |
| `PSM_PAUSER` / `VAULT_PAUSER` / `OKUM_PAUSER` | Warm Multisig | Halt minting, redemption, wrapping, transfers | Cannot unpause — that requires cold multisig (`*_UNPAUSER`) |
| `OKUM_BLACKLISTER` | Warm Multisig | Block any address from OkuMoney and OkuDollar operations | Cannot unblacklist (cold only); cannot access funds |
| `OKUM_REBASER` | Orchestrator | Set the shared yield-rate schedule (`setOkuMYieldRate`, `setNextOkuMYieldRate`) and the discrete emergency override (`setOkuMMultiplier`) | Rate bounded to `[PRECISION, MAX_RATE]` (`InvalidRate` / `RateTooHigh`), so it can never drive the multiplier backwards; multiplier hard capped at `MAX_MULTIPLIER` (1e24); `setOkuMMultiplier` cannot decrease (`MultiplierCannotDecrease`) and is pause-gated. **Not** bounded on-chain against other chains' schedules — see Accepted Risks |
| `PSM_QUEUE_PROCESSOR` | Orchestrator | Process queue entries — burns OkuM, pays USDC to users | Payment destination is fixed to the queue entry's `user` address; cannot reroute |
| `PSM_BUFFER_DEPOSITOR` | Orchestrator | Deposit USDC to buffer from caller's wallet | Caller must hold the USDC; no damage possible |
| `OKUM_MINTER` | LitePSM + RedemptionQueue (contracts) | Call `OkuMoney.mint()` inside swap/processQueue paths | Bounded by per-minter `minterAllowance` and global `maxSupply`; never callable by EOA |

---

## Key Invariants

Maintained by the contracts and verified by the test suites at `test/invariants/`:

**Token / multiplier**
```
balanceOf(user) == _balances[user]                              // OkuMoney: standard ERC-20
okuMMultiplier() >= previousOkuMMultiplier                      // Multiplier never decreases
okuMMultiplier() is independent of totalSupply()                // No supply term in the accrual math
usdMultiplier() == okuMoney.okuMMultiplier()                    // Single shared multiplier
totalSupply() <= maxSupply                                      // Supply cap respected
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION  // OkuDollar: share conversion
```

**Cross-chain multiplier determinism** (orchestrator-maintained, not on-chain enforced)
```
okuMMultiplier() is a pure function of (schedule state, block.timestamp)
identical schedule on chain A and chain B  =>  identical uint256 at the same instant
```
Verified operationally by `scripts/operator/checkMultiplierDrift.ts`, which
compares `okuMMultiplier()`, `okuMRatePerSecond()`, `okuMRateEnd()`, and
`okuMPendingRatePerSecond()` across every configured chain. **Nothing on-chain
enforces this** — see Accepted Risks.

**Vault**
```
totalOkuMReserves() >= totalUsdShares                           // Collateralization is exactly 1.0
reservesDollarValue + <rounding tolerance> >= totalSupply       // Dollar-denominated restatement
unwrap(wrap(okuMAmount)) >= okuMAmount - 1                      // Round-trip accuracy
totalOkuMReserves() == OkuMoney.balanceOf(address(okuDollar))   // Reserve accounting
```
Shares are only minted/burned 1:1 against real OkuM at the same `m`, so the first
line is exact by construction; the remaining content of the invariant is that no
code path can move out OkuM that backs live shares (`rescueDonation` being the one
path that touches reserves directly). The old
`invariant_CollateralizationRatio` was dropped — it asserted the identical
inequality on the identical quantities.

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

- `OKUM_REBASER`: writes the shared yield-rate schedule (`okuMBaseMultiplier`, `okuMRatePerSecond`, `okuMLastAccrualTime`, `okuMRateEnd`, `okuMPendingRatePerSecond`) and the discrete override + `lastYieldDistributionBlock`. Bounded by `MAX_RATE`, `MAX_MULTIPLIER`, and monotonic-increase invariants. Because OkuDollar delegates, this role governs **both** tokens' yield.
- `OKUM_MINTER` / `OKUM_BURNER`: bounded by per-minter allowance + global `maxSupply`. PSM and Queue are the only intended holders.
- `VAULT_RESCUER`: withdraws donated OkuM only; cannot reach share backing.
- `PSM_*` roles: queue processing, buffer custody.
- `OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER`: shared blacklist for OkuMoney + OkuDollar.

**On-chain mitigations:**

- The discrete override `setOkuMMultiplier` stamps `lastYieldDistributionBlock`; the `whenYieldNotDistributing` modifier prevents same-block sandwich attacks on every PSM + vault op that reads the multiplier. Streaming rate changes create no step and need no such guard.
- Defense-in-depth ceilings (`MAX_MULTIPLIER = 1e24`, `MAX_RATE = PRECISION + 1e11`) cap the blast radius of a single-call compromise.
- Monotonic guards (`MultiplierCannotDecrease`, `InvalidRate`, `RateAlreadyExpired`) prevent backward writes.

**Operational expectation:** each operational role must rotate to a
multisig before mainnet launch.

### 2. Vault rebaser / reserve-manager opsec — RESOLVED BY DESIGN

**Previously:** if `VAULT_REBASER` and `VAULT_RESERVE_MANAGER` were
held by the same key, that key could sequence `setUsdYieldRate` in
block N followed by `withdrawSurplus` in block N + 1 to extract value
just added to the apparent reserve dollar valuation. The mitigation
was an off-chain key-separation requirement.

**Status: structurally impossible.** Both roles were deleted in the
single-multiplier refactor, along with `VAULT_ADMIN`,
`depositReserves`, `withdrawSurplus`, `surplus()`,
`collateralizationRatio()`, and `minCollateralRatio`.
Collateralization is exactly 1.0 by construction — `usdMultiplier()`
IS `okuMoney.okuMMultiplier()`, and shares are only ever minted or
burned 1:1 against real OkuM at the same `m` — so there is no
surplus to extract and no ratio to inflate. No key separation
requirement remains.

The nearest surviving surface is `VAULT_RESCUER.rescueDonation`,
which is bounded below by `totalUsdShares` and therefore cannot reach
share backing (modulo the 1-wei accounting caveat in Risk 11).

### 3. USDC peg monitoring — off-chain (no on-chain oracle)

Both EVM and SVM handle USDC peg monitoring entirely off-chain. EVM
previously had an on-chain `OracleRelay` circuit-breaker (Chainlink
USDC/USD aggregator, gating every mint/redeem/`processQueue` path) —
this was fully removed, including the storage slots that referenced
it (`LitePSM` and `RedemptionQueue` storage layouts were compacted,
not `__gap`-padded). SVM's `lite-psm` similarly removed its Pyth
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

### 6. `RedemptionQueue.advanceHead` is permissionless

The cursor-advance maintenance function is callable by anyone. No
privileged effect — `queueHead` can only move forward, and only past
slots that are already cleared (`user == address(0)`). Visible effect
is purely on `queueLength()` accuracy. A privileged version (e.g.
`onlyRole(QUEUE_RESCUER)`) adds no security and complicates the
operator runbook; the function is gas-bounded by `maxSlots` and emits
`QueueHeadAdvanced` on any non-zero advance.

### 7. Deprecated bridge feature

The on-chain `OkuBridge` / `OkuBridgeRouter` / `NttAdapter` contracts
and all associated tests/scripts/role constants were deleted in a
pre-review cleanup. The historical implementation is preserved on a
separate git branch should it be revisited. No bridge-related code
remains in `src/`, `test/`, or `scripts/`.

### 8. Negative yield is inexpressible

The multiplier is **monotonic** — `MathLib.computeMultiplier` only
compounds rates `>= PRECISION`, `setOkuMYieldRate` rejects
`newRate < PRECISION` with `InvalidRate`, and `setOkuMMultiplier`
rejects any non-increasing value with `MultiplierCannotDecrease`.
There is no on-chain representation of a loss.

Rear-facing accounting makes this **more likely to bite** than the
old forward-looking model did: the protocol pays out only what was
already measured, so a realized loss in a closed epoch surfaces as a
concrete number rather than being smoothed away by a projection.

**Only available response:** set the rate to `PRECISION` (0% APY) via
`setOkuMYieldRate` and hold until the losses are absorbed by
subsequent positive yield. `realisedYieldToRatePerSecond` in
`scripts/utils/yieldRate.ts` throws on a negative input rather than
silently clamping, so the operator is forced to make this decision
explicitly.

### 9. ERC-8056 is a Draft standard

`src/interfaces/IScaledUIAmount.sol` implements
[ERC-8056](https://eips.ethereum.org/EIPS/eip-8056), which is a
**Draft** at time of writing. The four interface IDs
(`0xa60bf13d`, `0x4bd27648`, `0x57854fc3`, `0xd890fd71`) are taken
from the current draft and **may change before Final**, which would
change `supportsInterface()` results for integrators.

The two deviations documented under
[ERC-8056](#erc-8056-scaled-ui-amount) — emitting
`UIMultiplierUpdated` on rate-schedule changes rather than "whenever
the multiplier is changed", and returning a *projected* value from
`newUIMultiplier()` because we schedule a pending *rate* rather than
a pending *value* — are our **interpretations** of a spec written for
discrete multiplier steps. A reviewer may reasonably disagree with
either.

### 10. No on-chain enforcement of cross-chain rate equality

Each chain's `OkuMoney` deployment is fully independent. There is no
messaging, no light client, and no state proof between them. The
guarantee that every chain returns the same `okuMMultiplier()` rests
entirely on the **orchestrator pushing identical schedule state
everywhere** — nothing in `src/` can detect or reject a divergent
schedule.

**Mitigations:**

- Rates are derived from a declared APY via
  `scripts/utils/yieldRate.ts` so every chain receives a
  byte-identical integer, removing the likeliest failure mode
  (hand-entered 19-digit integers).
- `setNextOkuMYieldRate` requires no transaction at the epoch
  boundary, so the highest-risk moment for divergence has no
  broadcast to get wrong.
- `scripts/operator/checkMultiplierDrift.ts` is the detection layer:
  it compares multiplier, rate, `rateEnd`, and pending rate across
  every configured chain and exits non-zero on any mismatch.

**Divergence is one-way.** The multiplier is monotonic, so a chain
that ran hot cannot be corrected downward — the only remedy is to run
the laggards hot until they catch up.

**This "no messaging needed" property holds across EVM chains only.**
SVM's `lite-psm` still writes its multiplier in discrete ticks
(`set_multiplier` / `distribute_yield`), not from this streaming rate
schedule — porting SVM to the same model is tracked as an open item
in `TRACKER.md`. Until then, EVM↔SVM multiplier agreement (where it
matters, e.g. cross-stack bridge pricing) is an off-chain orchestrator
responsibility like every other cross-chain invariant in v1.

### 11. Known issues

**11a. `OkuDollar._redeemShares` floor-vs-ceil asymmetry — RESOLVED.**
The ERC-4626 third-party `withdraw` / `redeem` path used to move an
internal-share amount that FLOORED against `usdMultiplier`, then call
`unwrap`, which CEILS `sharesToBurn` — a mismatch that could leave the
spender one share short and revert `InsufficientBalance` on an
exact-balance redeem. Fixed by burning directly from `owner` inside a
shared `_unwrap` core (a single ceil computation against the owner's
real balance, no intermediate share move) — see `unwrap` / `_unwrap`
NatSpec. `_unwrap` also now emits the ERC-20 `Transfer` for the
burned shares and reports the true `owner` (not the spender) in the
ERC-4626 `Withdraw` event, both of which the two-step path missed.

**11b. ERC-4626 `mint()` / `withdraw()` do not guarantee exact
output.** The spec requires `mint(shares, receiver)` to mint *exactly*
`shares` and `withdraw(assets, receiver, owner)` to deliver *exactly*
`assets`. Both are thin wrappers over `wrap`/`unwrap`'s floor-rounded
conversions here, so the actual minted/withdrawn amount can differ
from the requested one by up to 1 wei in the vault's favor. Achieving
byte-exact spec conformance against a continuously-repricing,
rebasing share token would require iterative correction or ceil-
adjusted share math on every call; accepted as a rounding-direction
tradeoff (always favors the vault) rather than implemented, given the
rest of the protocol's floor-favors-vault convention. `deposit()` /
`redeem()` are exact (they pass the caller's amount straight through).

**11c. `rescueDonation` is 1-wei-per-unwrap optimistic.**
`rescueDonation` treats everything above `totalUsdShares` as
donation. The shares-track-OkuM-1:1 identity is exact only while
`wrap` / `unwrap` are the sole mutators, and `unwrap`'s ceil-burn /
floor-return asymmetry can leave reserves up to 1 wei **above**
`totalUsdShares` per unwrap. That dust is classified as rescuable
donation. Directionally safe — it favours the protocol, and the
rescuer is a trusted cold-multisig role — but the accounting is
optimistic rather than exact.

**11d. ERC-4626 `totalAssets()` includes unbacked donations.** By
spec `totalAssets()` returns everything the vault holds, including
OkuM donated directly to the contract (see 11c) that backs no share.
An integrator computing share price as `totalAssets() / totalSupply()`
— the generic ERC-4626 assumption — gets a value inflated by any
outstanding donation. This vault deliberately does NOT use that ratio
internally (conversions use the shared multiplier directly, per the
contract's own NatSpec, which is what makes it immune to the
inflation attack); external integrators relying on the generic ratio
should be aware it can diverge from the true $1.00 peg until
`rescueDonation` clears the dust.

### 12. OkuM discrete-tick MEV — structurally eliminated for normal operation

The original sandwich vector (mint one block before a discrete
multiplier jump, redeem one block after, capturing a period's yield
for ~12s of exposure) **no longer exists on the normal yield path**.
`okuMMultiplier()` streams continuously and `setOkuMYieldRate`
re-anchors to the current value, so there is no step to straddle.

The vector survives **only** on the `setOkuMMultiplier` emergency
override, which is the one remaining function that creates a
discontinuity. That is why `lastYieldDistributionBlock` and the
`whenYieldNotDistributing` guard are retained — see
[YieldSandwichGuard](#yieldsandwichguard). Same-block sandwiching of
the override is blocked; cross-block manipulation by the override
holder is not mitigated on-chain, for the same reasons given in
Risk 1.

---

## Testing

```bash
forge test                                         # All unit + invariant tests (520 total)
forge test --match-path "test/invariants/*"        # Invariant suite (256 runs × 500 depth by default)
forge test --match-contract OkuMoneyTest -vv       # OkuMoney unit tests (incl. rate-schedule suite)
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

> **Status after the streaming-accrual / single-multiplier refactor:
> 499 / 520 forge tests passing, 21 failing.** The failures are all
> **test-side fallout from the refactor**, not contract regressions, and are
> being cleaned up in a follow-up pass. They fall into three groups:
>
> 1. **`AccessControlUnauthorizedAccount(..., OKUM_REBASER)`** (18 tests, in
>    `LitePSM.t.sol` / `OkuDollar.t.sol`) — yield-lock tests reach
>    `setOkuMMultiplier` through a path whose signer no longer holds
>    `OKUM_REBASER` on OkuMoney. A grant/prank fix, not a guard defect.
> 2. **`MultiplierCannotDecrease`** (3 tests) — helpers that used to set the
>    two multipliers independently now drive a single shared, monotonic value,
>    so the "elevated usdMultiplier vs. lower okuMMultiplier" fixtures are
>    unreachable states by construction.
> 3. **Stale single-multiplier assertions** —
>    `test_UsdMultiplier_IndependentOfNotePrice` and
>    `testFuzz_OkuUsdBalanceUnchangedByNotePrice` assert *independence* between
>    `usdMultiplier()` and `okuMMultiplier()`, which is no longer a property:
>    they are the same value. These tests should be deleted, and the file
>    comment at `test/token/OkuDollar.t.sol:636` already says so.
>
> The per-file coverage table below is the **pre-refactor** baseline and has not
> been regenerated.

**Pre-refactor baseline:** **564 / 564 forge tests passing**
plus **27 / 27 hardhat tests** (fork + happy-path + scenarios). Per-file
coverage:

| File | Lines | Statements | Branches | Funcs |
|---|---|---|---|---|
| `src/lib/MathLib.sol` | **100 %** | 96 % | 40 % | 100 % |
| `src/lib/ReentrancyGuardUpgradeable.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/lib/SafeApprove.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/lib/YieldSandwichGuard.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/psm/LitePSM.sol` | **97.95 %** | 96.05 % | 73.08 % | 100 % |
| `src/psm/RedemptionQueue.sol` | **100 %** | 99.25 % | 93.33 % | 100 % |
| `src/token/OkuDollar.sol` | **98.34 %** | 97.26 % | 90.00 % | 97.50 % |
| `src/token/OkuMoney.sol` | **100 %** | 100 % | 100 % | 100 % |
| **Total** | **98.95 %** | 97.73 % | 86.32 % | 99.17 % |

A CI gate in `.github/workflows/test.yml` fails the build if any `src/` file
or the overall total drops below **95 % line coverage**. The refactor added new
surface not reflected above — `MathLib.computeMultiplier` / `compoundFor`, the
OkuMoney rate-schedule setters, the ERC-8056 views, and the OkuDollar ERC-4626
surface — so the table must be regenerated once the 21 failing tests are fixed.

### Uncovered lines (intentional)

The remaining uncovered lines are **defensive guards unreachable from
the contracts as currently composed**. They are kept for
future-proofing against changes to dependent contracts. Driving them
in tests would require malicious mock contracts that misrepresent
the multiplier or share-conversion semantics — a test surface we
judged not worth the maintenance cost.

| Location | Code | Why unreachable today |
|---|---|---|
| `LitePSM.sol` `mintOkuM` | `revert RoundTripDriftTooLarge` | The round-trip check is mathematically bounded above by `usdcAmount` for any well-behaved `okuMMultiplier()`. Defends against an OkuMoney variant whose multiplier mutates between reads inside one transaction — impossible under the current `setOkuMMultiplier` + yield-distribution-guard policy. |
| `LitePSM.sol` `_redeemOkuMShared` | `revert OutputBelowMinimum` | `usdcAmount` is computed once. The floor `okuMFloor = (okuMAmount / dm) * dm` then `minUsdcExpected` is bounded above by `usdcAmount` by construction. Defends against an OkuMoney whose multiplier shifts during the same call. |
| `LitePSM.sol` `mintUsdOku` | `revert RoundTripDriftTooLarge` | Mirror of the `mintOkuM` case for the wrap path. |
| `OkuDollar.sol` `_update` | `UseWrapInstead` / `UseUnwrapInstead` / `OkuDollarDoesNotUseInternalUpdate` guards | `OkuDollar` overrides `transfer` / `transferFrom` to use share-based accounting; all supply changes go through `wrap()` / `unwrap()`, which manage `usdShares` directly and never call the inherited `_mint` / `_burn`. Since nothing in the contract invokes `_mint` or `_burn`, this `pure`, unconditionally-reverting override is unreachable today — it exists purely to halt any future refactor that accidentally routes through the inherited ERC-20 `_update` hook. |

### Auditor checklist — sensitive functions

1. **`OkuDollar.rescueDonation` backing floor** (replaces the deleted
   `withdrawSurplus` ratio-math block — `withdrawSurplus`,
   `minCollateralRatio`, and `collateralizationRatio()` no longer exist)
   - `test_RescueDonation_OnlyVaultRescuer` — role gate.
   - `test_RescueDonation_RevertsWhenNoDonation` — `held <= totalUsdShares` → `NoDonationAvailable`.
   - `test_RescueDonation_RecoversDonatedOkuM` — donated surplus is withdrawable, backing is not.
   - `test_RescueDonation_RevertsOnZeroAmount` / `_RevertsOnZeroReceiver` — input guards.

2. **`LitePSM._redeemOkuMShared(okuMAtPsm=true)` branch**
   - `test_RedeemUsdOku_OkuMAtPsmInstant_NoOkuMRedeemedEvent` — buffer-covered redemption suppresses `OkuMRedeemed`.
   - `test_RedeemUsdOku_OkuMAtPsmQueued_OkuMRoutedToQueue` — buffer-drained redemption routes OkuM to the queue without pulling from user.

3. **`RedemptionQueue.processQueue` TransferFailed soft-skip path**
   - `test_ProcessQueue_TransferFailed_SoftSkipEmitsEvent` — blocked recipient → `RedemptionSkipped(idx, TransferFailed)`, OkuM stays in escrow, `totalQueuedOkuM` unchanged.
   - `test_ProcessQueue_TransferFailed_NextEntryStillProcesses` — interleaved blocked + clean users.
   - `test_ProcessQueue_TransferFailed_ThenRescueClearsIt` — soft-skip + `rescueQueueEntry` round trip.
   - `test_ProcessQueue_AlreadyCleared_SoftSkipEmitsEvent`, `test_ProcessQueue_InsufficientFunds_EmitsEventAndBreaks` — companion skip paths.
   - Backed by `MockUSDC.setBlocked` (`test/mocks/MockUSDC.sol`) which mirrors Circle USDC's revert-on-blacklist semantics.

4. **`OkuMoney.setNextOkuMYieldRate` boundary conditions (`block.timestamp >= okuMRateEnd`)**
   - `test_SetNextOkuMYieldRate_RevertsWhenNoRateEnd` — open-ended active rate → `NoRateEndSet`.
   - `test_SetNextOkuMYieldRate_RevertsWhenAlreadyExpired` — window elapsed → `RateAlreadyExpired`.
   - `test_SetNextOkuMYieldRate_SucceedsOneSecondBeforeEnd` — `block.timestamp == okuMRateEnd - 1` → success.
   - `test_SetNextOkuMYieldRate_ActivatesWithoutTransaction` — the cross-chain-critical property: the successor takes effect with **no transaction at the boundary**.
   - `test_RateExpiry_HaltsAccrualWhenNoPending` — expiry with no successor armed halts accrual (safe) rather than diverging.

5. **`OkuMoney.setOkuMYieldRate` continuity + non-stamping**
   - `test_SetOkuMYieldRate_SnapshotsMultiplier` — re-anchors `okuMBaseMultiplier` to the current value, so the curve is continuous across the write.
   - `test_SetOkuMYieldRate_DoesNotStampYieldBlock` — deliberately does NOT touch `lastYieldDistributionBlock` (there is no step to sandwich).
   - `test_SetOkuMYieldRate_ClearsPendingRate` — a fresh schedule supersedes any armed successor.
   - `test_SetOkuMYieldRate_DoesNotAffectBalances` / `_WorksWithZeroSupply` — the accrual math has no supply term, which is what makes it chain-agnostic.

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

### Audit finding surfaced + remediated during coverage work

While extending `MockUSDC` with `setBlocked` to drive the
TransferFailed branch, `RedemptionQueue.processQueue` previously used
the low-level `.call` pattern that treated a `transferFrom`
returning `false` (without reverting) as success. Real Circle USDC's
blacklist reverts, so production behaviour was safe, but a
non-standard ERC-20 (or future USDC variant) that returns `false`
would have silently drained queue entries without paying users.

**Fix:** replaced the raw `.call` with `SafeERC20.trySafeTransferFrom`,
which both (a) swallows reverts and (b) decodes the boolean return
value. Tests now drive both shapes independently — revert (matches
real USDC blacklist) and return-false (hypothetical non-standard
USDC). The return-false test is the regression guard for this
finding.

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
