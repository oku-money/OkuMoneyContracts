# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil) for unit + invariant tests; Hardhat for fork + gas-regression tests
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`, `RedemptionQueue`)
- **Oracle**: Chainlink `AggregatorV3` (subset interface at `src/interfaces/IAggregatorV3.sol`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Contracts

| Contract | Description |
|----------|-------------|
| `src/token/OkuMoney.sol` | Non-rebasing base token (OkuM) — static balance, discrete multiplier appreciation via stored `okuMMultiplier` |
| `src/token/OkuDollar.sol` | Rebasing $1-pegged stablecoin (usdOku) — growing balance via continuous `_rpow` USD multiplier |
| `src/psm/LitePSM.sol` | Peg Stability Module — multiplier-aware USDC ↔ OkuM + usdOku convenience functions |
| `src/psm/RedemptionQueue.sol` | FIFO queue for OkuMoney redemptions when the PSM buffer is depleted |
| `src/lib/YieldSandwichGuard.sol` | Shared abstract enforcing per-block sandwich protection around yield distribution |
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
npx hardhat test                              # Fork + happyPath + crossChain tests
```

## Deployment & Address Book

The unified deploy script (`scripts/deploy/index.ts`) provisions every contract
for a given chain in one run, captures addresses to a working address book, and
on live networks also mirrors them into the canonical repo-root registry.

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
hh run scripts/interactions/test-flow.ts --network localhost
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
| `npm run deploy:sepolia` / `:opSepolia` / `:baseSepolia` / `:bscTestnet` | Live deploy to the named testnet |
| `npm run deploy:base` / `:bsc` | Live deploy to the named mainnet |
| `npm run upgrade` | Upgrade proxies on a running localhost fork (auto-detects target chain) |
| `npm run upgrade:sepolia` / `:opSepolia` / `:baseSepolia` / `:bscTestnet` | Live upgrade on the named testnet |
| `npm run upgrade:base` / `:bsc` | Live upgrade on the named mainnet |
| `npm run test:flow` / `:live` | `test-flow.ts` against a running localhost fork (or live Sepolia) |

> The `npm run bridge:*` scripts were removed in the noBridge refactor.
> Cross-chain transfers are now PSM-mediated mint/burn coordinated off-chain.

For chains without a pre-baked npm alias (`base`, `bsc`, `arbitrum`, `optimism`,
`mainnet`):

```bash
hh run scripts/deploy/index.ts --network <chain>
NETWORK=<chain> hh run scripts/interactions/test-flow.ts --network <chain>
```

## Contract Structure

```
src/
  token/
    OkuMoney.sol            # Non-rebasing base token (stored okuMMultiplier, discrete updates)
    OkuDollar.sol           # Rebasing stablecoin vault (continuous _rpow usdMultiplier)
  psm/
    LitePSM.sol             # USDC ↔ OkuM (multiplier-aware) + usdOku convenience functions
    RedemptionQueue.sol     # Queue for when PSM USDC buffer is insufficient
  bridge/
    adapters/
      IBridgeAdapter.sol    # RESERVED: canonical interface for third-party adapters
                            # (NTT / CCIP). No implementation in v1; see noBridge notes.
  interfaces/
    IOkuMoney.sol           # OkuMoney interface (used by PSM, vault, mocks)
    IOkuDollar.sol          # OkuDollar vault interface
    IOkuBridgeNative.sol    # RESERVED: OkuBridge subset surface; no consumer in v1.
    IAggregatorV3.sol       # Chainlink PoR oracle subset used by LitePSM
  lib/
    Roles.sol               # Shared RBAC role constants (prefix-namespaced)
    Constants.sol           # PRECISION, DECIMAL_MULTIPLIER, MAX_RATE, BASIS_POINTS + terminology legend
    MathLib.sol             # Multiplier math + rpow
    ReentrancyGuardUpgradeable.sol  # OZ-5.x-compatible upgradeable reentrancy guard
    YieldSandwichGuard.sol  # Shared whenYieldNotDistributing modifier (OkuDollar + LitePSM)

test/
  mocks/                    # Test-only mocks (live under test/, never compiled into production artifacts)
    MockUSDC.sol            # 6-decimal ERC-20; used on testnets + in tests
```

> **noBridge refactor**: `src/bridge/OkuBridge.sol`, `OkuBridgeRouter.sol`,
> `adapters/NttAdapter.sol` + `INttManager.sol`, and the corresponding event
> files were removed. v1 cross-chain transfers are PSM-mediated mint/burn,
> orchestrated off-chain (the orchestrator custodies USDC and calls
> `LitePSM.mintOkuM` / `LitePSM.redeemOkuM` on the source/destination chains).
> The retained `IBridgeAdapter` and `IOkuBridgeNative` interfaces plus the
> `BRIDGE_*` / `ROUTER_*` / `NTT_*` constants in `Roles.sol` are reserved seams
> for future re-introduction of OkuBridge / NTT / CCIP; those will arrive as
> contract additions, not modifications to the existing suite.

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
| `ORACLE_MIN_STALENESS` | `60` seconds | Lower bound on the configurable Chainlink PoR staleness threshold. Prevents an operator from setting a window so tight that routine block-time jitter causes every mint to revert. 60 s is below any realistic Chainlink update interval; the exact value is arbitrary within that constraint. |
| `ORACLE_MAX_STALENESS` | `7 days` | Upper bound on the configurable staleness threshold. Prevents operator misconfiguration that would make the oracle check a no-op. 7 days is a conventional "obviously too stale" sentinel; any value of hours-to-weeks would serve the same purpose. |
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

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`.

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through multiplier appreciation tracked by a stored `okuMMultiplier` value, updated discretely by the orchestrator.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuMoneyStorage {
    uint256 okuMMultiplier;                     // Stored dollar value per token (starts 1e18, only increases)
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
    uint256 lastYieldDistributionBlock;         // Sandwich attack prevention
}
```

### Multiplier Model

`okuMMultiplier()` is a **stored value** — not a computed view. There is no `_rpow`, no `ratePerSecond`, no rate scheduling on OkuMoney. The multiplier is written discretely by the orchestrator via two functions:

- `setOkuMMultiplier(newMultiplier)` — OKUM_REBASER. Direct override, enforces `newMultiplier >= current`.
- `distributeYield(yieldAmount)` — OKUM_REBASER. Dollar-denominated: `newMultiplier = oldMultiplier + (yieldAmount × PRECISION / totalSupply)`. E.g., $1000 yield on 10000 tokens → +$0.10/token.

Both set `lastYieldDistributionBlock = block.number` (sandwich prevention — see [YieldSandwichGuard](#yieldsandwichguard)).

**Rear-facing yield**: The orchestrator feeds realized T-Bill returns. January's actual yield gets distributed in February via `distributeYield()`. OkuMoney only ever distributes what was already earned — the multiplier reflects reality, never a projection.

### IOkuMoney Interface

```solidity
interface IOkuMoney {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function okuMMultiplier() external view returns (uint256);
    function setOkuMMultiplier(uint256 newMultiplier) external;
    function distributeYield(uint256 yieldAmount) external;
    function lastYieldDistributionBlock() external view returns (uint256);
}
```

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not multiplier-adjusted).
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion).
- `okuMMultiplier()` is a stored value for pricing — used by PSM and vault, not by `balanceOf`.
- `mint()` creates raw tokens; minting 100 tokens when `okuMMultiplier = $1.05` creates $105 of value.
- The PSM handles USDC ↔ OkuMoney conversion using `okuMMultiplier()` (dollar-value aware).
- `TransferValue` event emitted alongside the standard `Transfer` with the dollar-denominated amount.
- Blacklist and pause checks apply to transfers; self-burn works while paused.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20; emitted on mint/burn/transfer. |
| `TransferValue(from, to, amount, dollarValue)` | Alongside `Transfer`; `dollarValue = amount × okuMMultiplier / PRECISION`. |
| `OkuMMultiplierUpdated(oldMultiplier, newMultiplier, totalSupply)` | Emitted by `setOkuMMultiplier` and `distributeYield`. |
| `YieldDistributed(yieldAmount, oldMultiplier, newMultiplier, totalSupply)` | Emitted by `distributeYield` only; `yieldAmount` is the dollar input. |
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

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `YieldSandwichGuard`, `UUPSUpgradeable`.

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

Both are protected by `whenYieldNotDistributing` (via `YieldSandwichGuard`) and `whenNotPaused` (full freeze). `unwrap` reverts with `InsufficientBalance` if the caller's share balance is below `sharesToBurn`, or `InsufficientReserves` if the vault's OkuMoney reserves are below `okuMReturned`. These two errors are intentionally distinct — the first is a user balance check, the second is a vault-collateralization check.

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
- LitePSM: `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`, `redeemOkuMWithPermit`, `redeemUsdOkuWithPermit`, `processQueue`.

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
function redeemOkuMWithPermit(uint256 okuMAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
```

At `okuMMultiplier = $1.05`: depositing 100 USDC gives ~95.24 OkuM; redeeming 95.24 OkuM returns ~100 USDC.

### Convenience Functions (usdOku ↔ USDC via Vault)

```solidity
function mintUsdOku(uint256 usdcAmount) external;           // USDC → mint OkuM → wrap → usdOku to user
function redeemUsdOku(uint256 usdAmount) external;          // usdOku → unwrap → redeem → USDC to user
function redeemUsdOkuWithPermit(...) external;              // Permit variant
```

`redeemUsdOku` has two distinct failure modes: (a) vault undercollateralized → `unwrap` reverts with `InsufficientReserves` → entire tx reverts; (b) vault has OkuM but PSM buffer insufficient → OkuM goes to the redemption queue.

Every user-facing PSM function is protected by `whenYieldNotDistributing` + `whenNotPaused`.

### Oracle Configuration

`configureOracle(oracle, stalenessThreshold, enabled)` — `PSM_ORACLE_MANAGER`:
- Reverts with `ZeroAddress` if `enabled && oracle == 0` (prevents silent bypass via mis-config).
- Reverts with `InvalidStaleness(provided, min, max)` if `stalenessThreshold` is outside `[ORACLE_MIN_STALENESS=60, ORACLE_MAX_STALENESS=7 days]`.

Runtime oracle check (on `mintOkuM` / `mintUsdOku` when enabled):
- `answeredInRound < roundId` → `IncompleteOracleRound`.
- `block.timestamp - updatedAt >= stalenessThreshold` → `StaleOracleData`.
- `answer < 0` → `InvalidOracleResponse`.
- `reserves < totalSupply + mintAmount` → `ExceedsReserves(newSupply, reserves)`.

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
| `OracleConfigured(oracle, stalenessThreshold, enabled)` | `configureOracle`. |
| `BufferRefilled(newBufferBalance, processedStart, processedEnd)` | After `processQueue`. |
| `BufferDeposited(depositor, amount, newBufferBalance)` | After `depositBuffer`. |
| `BufferWithdrawn(to, amount, newBufferBalance)` | After `withdrawUsdc`. |

---

## RedemptionQueue.sol

Stores raw OkuMoney token amounts. Since OkuMoney is non-rebasing, queued tokens don't grow in balance — but they appreciate in dollar value via `okuMMultiplier()`. At processing time, `usdcAmount = okuMAmount × okuMMultiplier() / PRECISION` (scaled to 6 decimals). The multiplier is cached once per batch for gas efficiency and cross-entry consistency.

`enqueue(user, okuMTokenAmount)` is record-only — the PSM transfers OkuMoney into the queue before calling. `processQueue(startIndex, endIndex)` (called by the PSM via `QUEUE_PSM`) burns OkuMoney, pulls USDC from the PSM, and pays users. `rescueQueueEntry(index, alternateRecipient)` returns OkuMoney to a stuck entry (e.g., USDC-blacklisted recipient) — called by `QUEUE_RESCUER`.

### Events

| Event | Parameters |
|---|---|
| `RedemptionQueued(user, okuMAmount, dollarValue, position, queueLength)` | `enqueue`. |
| `RedemptionProcessed(user, okuMAmount, dollarValue, usdcAmount, waitTime)` | `processQueue` success. |
| `RedemptionSkipped(index, reason)` | `reason` is `AlreadyCleared` or `InsufficientFunds`. |
| `RedemptionRescued(index, originalUser, recipient, okuMAmount, dollarValue)` | `rescueQueueEntry`. |

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

### Reserved seams (for future OkuBridge / NTT / CCIP)

Deleted in the noBridge refactor: `OkuBridge.sol`, `OkuBridgeRouter.sol`,
`NttAdapter.sol`, `INttManager.sol`, the bridge event files, the bridge test
suite, and the `scripts/bridge/` flow. The master branch retains the full
implementation if it ever needs to be restored.

Retained as forward-compatibility scaffolding:

- `src/interfaces/IOkuBridgeNative.sol` — OkuBridge subset surface.
- `src/bridge/adapters/IBridgeAdapter.sol` — third-party adapter interface.
- `BRIDGE_*`, `ROUTER_*`, `NTT_*` constants in `src/lib/Roles.sol`.

When OkuBridge / NTT / CCIP return, the upgrade is additive: deploy the new
proxy, grant it `OKUM_MINTER`, configure its minter allowance. No changes to
the existing `OkuMoney` / `OkuDollar` / `LitePSM` / `RedemptionQueue`
contracts are required.

---

## YieldSandwichGuard

Shared abstract at `src/lib/YieldSandwichGuard.sol`, inherited by both `OkuDollar` and `LitePSM`. Exposes the `whenYieldNotDistributing` modifier and the `YieldDistributionInProgress` error.

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

OkuMoney records `lastYieldDistributionBlock = block.number` inside `setOkuMMultiplier` and `distributeYield`. OkuDollar and LitePSM inherit the guard and override `_yieldSandwichOkuMoney()` to return their stored `okuMoney` reference. Result: **any** PSM mint/redeem or vault wrap/unwrap that lands in the same block as a yield distribution reverts with `YieldDistributionInProgress`. The lock releases automatically on the next block.

**Protected operations**:
- `LitePSM.mintOkuM` / `redeemOkuM` / `mintUsdOku` / `redeemUsdOku` (+ permit variants)
- `OkuDollar.wrap` / `unwrap`

**Unaffected**: OkuMoney transfers, OkuDollar transfers, operations in subsequent blocks.

---

## Role Grants Policy

As of Phase 4, every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, reserve managers, refund confirmers, etc.) to other parties (multisigs, bots, bridge contracts) post-deployment. This removes contract-specific role plumbing from deployment scripts.

One intentional exception:
- `RedemptionQueue.QUEUE_PSM` is NOT granted at init — it is granted post-deploy to the `LitePSM` proxy address. This avoids a circular deployment dependency AND keeps admin from being able to call `enqueue` / `processQueue` directly (bypassing the PSM).

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

> Bridge invariants (nonce monotonicity, processed/refunded set disjointness,
> fee-accounting equality, value conservation) were verified by the Foundry
> invariant suite while `OkuBridge` was deployed; they were removed in the
> noBridge refactor. They will return alongside the future OkuBridge / NTT
> / CCIP work.

---

## Testing

```bash
forge test                                         # All unit + invariant tests
forge test --match-path "test/invariants/*"        # Invariant suite (256 runs × 500 depth by default)
forge test --match-contract OkuMoneyTest -vv       # OkuMoney unit tests
forge test --match-contract VaultInvariants        # OkuDollar backing invariants
forge test --match-contract HandlerSanityTest      # Handler success-rate sanity checks

npx hardhat compile                                # Regenerates typechain before fork tests
npx hardhat test                                   # Fork + happyPath + crossChain tests
npx hardhat test test/hardhat/crossChain/OrchestratorPsmBridging.ts  # Single file
```

The Foundry suite is the authoritative functional coverage (447 tests across 15 test suites). The Hardhat suite (24 tests across 5 test files) exists for three specific purposes only:
1. **Fork tests** (`test/hardhat/fork/`): exercise the protocol against real mainnet / Sepolia state that Foundry can't easily reach in CI.
2. **Happy-path integration** (`test/hardhat/happyPath/`): full deposit/yield/withdraw walk-through against the OZ upgrades plugin's real proxy machinery.
3. **Cross-chain accounting** (`test/hardhat/crossChain/OrchestratorPsmBridging.ts`): two-PSM noBridge orchestrator-mediated transfer (added in the noBridge refactor).

Any non-fork functional test should be added to the Foundry suite.
