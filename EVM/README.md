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
| `src/oracle/OracleRelay.sol` | USDC peg circuit-breaker — wraps a Chainlink USDC/USD aggregator, validates round/freshness/in-band, normalizes to 1e18 |
| `src/oracle/IOracleRelay.sol` | Consumer interface (`checkUsdcPeg`, `getUsdcPrice`) used by LitePSM and RedemptionQueue |
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
npx hardhat test                              # Fork + happyPath + scenarios tests
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
    RedemptionQueue.sol     # Queue for when PSM USDC buffer is insufficient
  oracle/
    OracleRelay.sol         # USDC peg circuit-breaker (UUPS proxy) consumed by LitePSM/Queue
    IOracleRelay.sol        # checkUsdcPeg() / getUsdcPrice() consumer surface
  interfaces/
    IOkuMoney.sol           # OkuMoney interface (used by PSM, vault, mocks)
    IOkuDollar.sol          # OkuDollar vault interface
    IAggregatorV3.sol       # Chainlink AggregatorV3 subset consumed by OracleRelay
  lib/
    Roles.sol               # Shared RBAC role constants (prefix-namespaced)
    Constants.sol           # PRECISION, DECIMAL_MULTIPLIER, MAX_RATE, BASIS_POINTS + terminology legend
    Errors.sol              # Shared error types (ZeroAddress, InsufficientBalance, MultiplierCannotDecrease)
    SafeApprove.sol         # USDT-safe approve helpers (setExactAllowance, revokeAllowance)
    MathLib.sol             # Multiplier math + rpow
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

### USDC Peg Circuit-Breaker (`OracleRelay`)

`LitePSM` and `RedemptionQueue` consume a separate `OracleRelay` proxy (`src/oracle/OracleRelay.sol`) that wraps a Chainlink USDC/USD aggregator. Every mint, redeem, and `processQueue` path calls `oracleRelay.checkUsdcPeg()` (when wired) and reverts on:

- Incomplete round (`answeredInRound < roundId`) → `IncompleteOracleRound`.
- Malformed timestamps (`updatedAt == 0`, `startedAt == 0`, or `startedAt > updatedAt`) → `InvalidOracleResponse`.
- Stale data (`block.timestamp - updatedAt >= stalenessThreshold`) → `StaleOracleData`.
- Non-positive answer → `NonPositiveAnswer`.
- Normalized price outside the configured band → `PriceOutOfBand`.

`setOracleRelay(address)` (gated on `PSM_ORACLE_MANAGER` / `QUEUE_ORACLE_MANAGER`) wires a relay onto the consumer. Passing `address(0)` disables the peg check — operational kill switch for incident response.

The relay's own configuration setters (`setPriceFeed`, `setStalenessThreshold`, `setPriceBand`) are gated on the relay-side roles `RELAY_FEED_MANAGER` and `RELAY_CONFIG_MANAGER`. Hardcoded defense-in-depth bounds (`ORACLE_USDC_PRICE_FLOOR = 0.95e18`, `ORACLE_USDC_PRICE_CEILING = 1.05e18`, `ORACLE_MIN_STALENESS = 60s`, `ORACLE_MAX_STALENESS = 7 days`) prevent operator misconfiguration.

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
| `OracleRelayUpdated(oldRelay, newRelay)` | `setOracleRelay`. address(0) disables the peg check. |
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

Every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, reserve managers, etc.) to other parties (multisigs, bots) post-deployment via `grantRoles.ts` or `grantRolesMainnet.ts`. This removes contract-specific role plumbing from deployment scripts.

One intentional exception:
- `RedemptionQueue.QUEUE_PSM` is NOT granted at init — it is granted post-deploy to the `LitePSM` proxy address. This avoids a circular deployment dependency AND keeps admin from being able to call `enqueue` / `processQueue` directly (bypassing the PSM).

### Per-role trust and blast radius

The production role assignment and what each tier can and cannot do — see
`README.md § Signer trust implications` for the full model that applies to
both EVM and SVM. EVM-specific notes:

| Role | Held by | What it can do | What on-chain code prevents |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Cold Multisig | Grant/revoke any role; effectively controls everything | Nothing — this is the meta-role. Quorum breach = system compromise |
| `OKUM_UPGRADER` / `VAULT_UPGRADER` / `PSM_UPGRADER` / `QUEUE_UPGRADER` / `RELAY_UPGRADER` | Cold Multisig | Replace any contract's logic via UUPS `_authorizeUpgrade`; new logic could do anything | Nothing — upgrade is unconditional once authorized. Mitigated by: every upgrade is tested on a fork and diff-reviewed before mainnet execution |
| `OKUM_ALLOWANCE_MANAGER` | Cold Multisig | Set any address's `minterAllowance` to any value | Cannot set above `maxSupply`; minting still requires `OKUM_MINTER` (held by contracts, not EOAs) |
| `OKUM_CAP_MANAGER` | Cold Multisig | Set `maxSupply` | Cannot set below current `totalSupply()` |
| `PSM_ORACLE_MANAGER` / `QUEUE_ORACLE_MANAGER` | Cold Multisig | Wire (or unwire) the `OracleRelay` peg-check contract onto LitePSM / RedemptionQueue | `address(0)` disables the peg check entirely (operational kill switch); pointed at a non-zero address, every mint/redeem/`processQueue` gates on `relay.checkUsdcPeg()` |
| `RELAY_FEED_MANAGER` | Cold Multisig | Rotate the Chainlink USDC/USD aggregator wrapped by `OracleRelay` | Rejects `address(0)` and feeds reporting `> MAX_FEED_DECIMALS` (18) |
| `RELAY_CONFIG_MANAGER` | Cold Multisig | Set the staleness threshold and the in-band price window on the relay | Staleness bounded `[60s, 7d]`; band bounded by `[0.95e18, 1.05e18]` (`ORACLE_USDC_PRICE_FLOOR`/`CEILING`) and `min < max` |
| `PSM_BUFFER_WITHDRAWER` | Cold Multisig | Drain PSM USDC buffer | Cannot withdraw below amount needed to cover pending queue obligations (`queueObligation`) |
| `VAULT_RESERVE_MANAGER` | Cold Multisig | Withdraw OkuMoney surplus from vault | Cannot push vault below `minCollateralRatio` (90% floor enforced post-withdrawal) |
| `VAULT_ADMIN` | Cold Multisig | Set `minCollateralRatio` | Cannot set below `MIN_COLLATERAL_RATIO_FLOOR` (90%); live-health gate rejects if existing positions would breach the new floor |
| `PSM_PAUSER` / `VAULT_PAUSER` / `OKUM_PAUSER` | Warm Multisig | Halt minting, redemption, wrapping, transfers | Cannot unpause — that requires cold multisig (`*_UNPAUSER`) |
| `OKUM_BLACKLISTER` | Warm Multisig | Block any address from OkuMoney and OkuDollar operations | Cannot unblacklist (cold only); cannot access funds |
| `OKUM_REBASER` / `VAULT_REBASER` | Orchestrator | Bump `okuMMultiplier` and `usdMultiplier` | Cannot decrease either multiplier; hard capped at `MAX_MULTIPLIER` (1e24) |
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

## Testing

```bash
forge test                                         # All unit + invariant tests (481 total)
forge test --match-path "test/invariants/*"        # Invariant suite (256 runs × 500 depth by default)
forge test --match-contract OkuMoneyTest -vv       # OkuMoney unit tests
forge test --match-contract VaultInvariants        # OkuDollar backing invariants
forge test --match-contract HandlerSanityTest      # Handler success-rate sanity checks

npx hardhat compile                                # Regenerates typechain before fork tests
npx hardhat test                                   # Fork + happyPath + scenarios
npx hardhat test test/hardhat/scenarios/RealWorldUsage.ts  # 365-day simulation + 8 edge cases
```

The Foundry suite is the authoritative functional coverage. The Hardhat suite exists for three specific purposes:
1. **Fork tests** (`test/hardhat/fork/`): exercise the protocol against real mainnet / Sepolia state that Foundry can't reach in CI.
2. **Happy-path integration** (`test/hardhat/happyPath/`): full deposit/yield/withdraw walk-through against the OZ upgrades plugin's real proxy machinery.
3. **Real-world scenario simulation** (`test/hardhat/scenarios/RealWorldUsage.ts`): 365-day stochastic simulation (seeded PRNG, 7 action categories, daily `evm_increaseTime` steps) plus 8 deterministic edge-case suites covering round-trips, queued redeems, multiplier divergence, blacklist/freeze, pause windows, oracle staleness, yield-lock, and cap exhaustion.

Any new unit or invariant test should be added to the Foundry suite; Hardhat is reserved for fork-dependent or multi-contract scenario work.

---

## Forge coverage notes

**Cycle 4 baseline:** **577 / 577 forge tests passing** (unit + fuzz +
invariants + fork + happy-path). Coverage held at the cycle-3 totals:

| File | Lines | Statements | Branches | Funcs |
|---|---|---|---|---|
| `src/lib/MathLib.sol` | **100 %** | 96 % | 40 % | 100 % |
| `src/lib/ReentrancyGuardUpgradeable.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/lib/SafeApprove.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/lib/YieldSandwichGuard.sol` | **100 %** | 100 % | 100 % | 100 % |
| `src/psm/LitePSM.sol` | **98.43 %** | 93.51 % | 57.14 % | 100 % |
| `src/psm/RedemptionQueue.sol` | **100 %** | 96.09 % | 66.67 % | 100 % |
| `src/token/OkuDollar.sol` | **98.30 %** | 94.79 % | 75.51 % | 97.56 % |
| `src/token/OkuMoney.sol` | **100 %** | 97.58 % | 83.33 % | 100 % |
| **Total** | **99.00 %** | 95.22 % | 69.35 % | 99.23 % |

A CI gate in `.github/workflows/test.yml` fails the build if any `src/` file
or the overall total drops below **95 % line coverage**.

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
| `OkuDollar.sol` `_update` | `UseWrapInstead` / `UseUnwrapInstead` guards | `OkuDollar` overrides `transfer` / `transferFrom` to use share-based accounting, so the inherited ERC20 `_update` hook is only reachable via the inherited `_mint` / `_burn` — which the contract never calls. The guards halt any future refactor that accidentally invokes `_mint` or `_burn`. |

### Auditor checklist — sensitive functions

1. **`OkuDollar.withdrawSurplus` post-withdrawal ratio math**
   - `test_WithdrawSurplus_SucceedsAtExactFloor` — `postRatio == minCollateralRatio` (inclusive).
   - `test_WithdrawSurplus_OneWeiBelowFloor_Reverts` — `postRatio == minCollateralRatio - 1 wei` → `BelowMinimumCollateral`.
   - `test_WithdrawSurplus_ZeroObligations_UsesInfiniteRatio` — `obligations == 0` → `type(uint256).max`.
   - `test_WithdrawSurplus_EventPostRatioMatchesView` — post-tx ratio observable matches `collateralizationRatio()`.

2. **`LitePSM._redeemOkuMShared(okuMAtPsm=true)` branch**
   - `test_RedeemUsdOku_OkuMAtPsmInstant_NoOkuMRedeemedEvent` — buffer-covered redemption suppresses `OkuMRedeemed`.
   - `test_RedeemUsdOku_OkuMAtPsmQueued_OkuMRoutedToQueue` — buffer-drained redemption routes OkuM to the queue without pulling from user.

3. **`RedemptionQueue.processQueue` TransferFailed soft-skip path**
   - `test_ProcessQueue_TransferFailed_SoftSkipEmitsEvent` — blocked recipient → `RedemptionSkipped(idx, TransferFailed)`, OkuM stays in escrow, `totalQueuedOkuM` unchanged.
   - `test_ProcessQueue_TransferFailed_NextEntryStillProcesses` — interleaved blocked + clean users.
   - `test_ProcessQueue_TransferFailed_ThenRescueClearsIt` — soft-skip + `rescueQueueEntry` round trip.
   - `test_ProcessQueue_AlreadyCleared_SoftSkipEmitsEvent`, `test_ProcessQueue_InsufficientFunds_EmitsEventAndBreaks` — companion skip paths.
   - Backed by `MockUSDC.setBlocked` (`test/mocks/MockUSDC.sol`) which mirrors Circle USDC's revert-on-blacklist semantics.

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

- **Workspace overview + cross-chain parity matrix:** [`../../audit/README.md`](../../audit/README.md)
- **Open issues:** [`TRACKER.md`](TRACKER.md)
- **In-repo audit package** (accepted risks, slither triage, captured tool snapshots): [`audit/README.md`](audit/README.md)
- **Self-audit toolkit:** [`../../audit/EVM/README.md`](../../audit/EVM/README.md)
- **SVM-side docs:** [`../SVM/README.md`](../SVM/README.md)
