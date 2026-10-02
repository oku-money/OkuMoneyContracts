# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil) for unit + invariant tests; Hardhat for fork + gas-regression tests
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`, `RedemptionQueue`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Quick Start

```bash
forge install && forge build && forge test    # 622 unit + invariant tests
npx hardhat compile && npx hardhat test       # 259 fork/integration/simulation/drill tests
```

Targeted invocations and what each suite covers: § Testing.
Every operator and deploy entry point: § npm scripts.

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
- **⚠ Comments in `src/` are address-load-bearing.** `bytecodeHash` is left at
  solc's default (`ipfs`), so the compiler appends a metadata hash — derived
  from the *source text* — to every contract's creation bytecode. Editing even
  a comment or a NatSpec line in `src/` therefore changes the initCode, which
  changes the CREATE2 address, which silently forks the fleet away from the
  already-deployed contracts and invalidates their block-explorer
  verification. Practical consequences:
  - Documentation-only changes to `src/` must be batched with a planned
    redeploy / `DEPLOYMENT_VERSION` bump, not landed opportunistically.
  - Files under `test/` are unaffected — test contracts are never deployed.
  - If this coupling is unwanted, set `settings.metadata.bytecodeHash = "none"`
    in both `hardhat.config.ts` and `foundry.toml`. That decouples comments
    from addresses permanently, but is itself an address-changing change, so it
    must also coincide with a version bump.

### Where deployed addresses live

| File | Role | Touched by |
|------|------|------------|
| [`scripts/config/addresses.json`](scripts/config/addresses.json) | **Tracked** per-network address book consumed by deploy / test scripts. Keyed `<chain>` — live deploys only. | Live deploys. |
| `scripts/config/addresses.local.json` | **Gitignored** half of the same book, keyed `fork:<chain>`. Local-fork deployments are ephemeral (the chain is discarded after the run), so they're split out and never committed. `loadAddressBook()` merges both files, so scripts see one book and need no knowledge of the split. | Every fork run. |
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

### Running a deploy

> **The step-by-step runbook — prerequisites, fork pre-flight, live deploy,
> verification smoke, mainnet ceremony — is documented once for both stacks in
> [`../README.md` § Deployment runbook](../README.md#deployment-runbook).**
> This section covers only what is specific to the EVM script's behaviour.

**Automated multi-chain pre-flight — [`scripts/deploy/dryRunForks.sh`](scripts/deploy/dryRunForks.sh):**

```bash
./scripts/deploy/dryRunForks.sh                # all 6 chains
./scripts/deploy/dryRunForks.sh sepolia base   # a subset
```

Starts a fresh fork node per chain, runs the full deploy against it, tears the
node down, and exits non-zero if any chain fails. Transcripts land in
`.dry-run-logs/`. It exercises the real script end-to-end, including the
role-matrix verification below, and writes only to the gitignored
`addresses.local.json` — so it leaves the tracked address book byte-identical
and your working tree clean.

The deploy script auto-detects the target chain from a running fork node's
`eth_chainId`, so `FORK_NETWORK` and `NETWORK=` never need to be kept in sync
across terminals.

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

The script also **verifies itself before reporting success**. After the role
grants, it re-reads the chain and asserts the complete expected matrix — all
21 role grants, both minter allowances, and every contract's presence in the
address book — throwing with an explicit list of what's missing if anything
failed. Minter allowances are checked separately from roles because
`OkuMoney.mint` gates on *both* `onlyRole(OKUM_MINTER)` and the
`minterAllowance` mapping, so a role grant without an allowance still reverts
at runtime.

> A missing grant fails the run loudly rather than warning. The expected matrix
> is exported as `expectedRoleGrants()` and asserted by
> `test/hardhat/drill/deployDrill.test.ts` against the same source of truth, so
> the test cannot drift from what the deploy actually grants.

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
| `npm run test:forge` | Foundry unit + invariant suite (622 tests) |
| `npm run test` | Full Hardhat suite (259 tests, incl. fork + drills) |
| `npm run test:unit` | Off-chain math + simulation + deploy/operator drills (221). Needs fork RPC |
| `npm run test:all` | Both |
| `npm run node` | Start `hardhat node` (default forks Sepolia; override via `FORK_NETWORK`) |
| `npm run deploy:sepolia` / `:opSepolia` / `:baseSepolia` / `:arbSepolia` / `:bscTestnet` | Live deploy to the named testnet |
| `npm run deploy:base` / `:bsc` | Live deploy to the named mainnet |
| `npm run upgrade` | Upgrade proxies on a running localhost fork (auto-detects target chain) |
| `npm run upgrade:sepolia` / `:opSepolia` / `:baseSepolia` / `:arbSepolia` / `:bscTestnet` | Live upgrade on the named testnet |
| `npm run upgrade:base` / `:bsc` | Live upgrade on the named mainnet |
| `npm run test:onchain:*` | `scripts/test/test-onchain.ts` against the named live testnet |

> The `npm run bridge:*` scripts were removed in the noBridge refactor.
> Cross-chain transfers are now PSM-mediated mint/burn coordinated off-chain.

> **Pass operator-script options as ENV VARS, not `--flags`.**
> `npx hardhat run <script>` parses argv itself and rejects any parameter it
> doesn't recognise, *before* the script executes:
>
> ```
> npx hardhat run scripts/operator/psmOps.ts --action=mintOkuM
>   -> Error HH310: Invalid param --action=mintOkuM. Command line params must be lowercase.
> npx hardhat run scripts/operator/psmOps.ts --yes-mainnet
>   -> Error HH305: Unrecognized param --yes-mainnet
> ```
>
> Position doesn't matter. Every option has a working env-var equivalent
> (`ACTION`, `AMOUNT`, `TARGET`, `YES_MAINNET`, …) — see each script's header,
> or [`scripts/utils/cli.ts`](scripts/utils/cli.ts) for the name-mapping rule.
> The `--flag` form still works if a script is invoked directly via `ts-node`.

### Operator scripts (PSM / vault / admin)

All take options as **env vars** (see the note above). All support
`DRY_RUN=true`, and `YES_MAINNET=true` is required to broadcast on a mainnet
network. All are also exported as `run*()` functions and exercised in-process
by the operator drill.

| Script | Purpose |
|---|---|
| [`scripts/operator/psmOps.ts`](scripts/operator/psmOps.ts) | PSM mint/redeem, consolidated. `ACTION=<mintOkuM\|redeemOkuM\|mintUsdOku\|redeemUsdOku\|burn>` + `AMOUNT=<units>` (USDC 6-dec, OkuM/UsdOku 18-dec). Replaces the deleted `mintOkuM.ts` / `redeemOkuM.ts` and adds `mintUsdOku`, `redeemUsdOku`, and a direct `burn` (needs `OKUM_BURNER`). `redeemOkuM` queues automatically when the PSM buffer is short. |
| [`scripts/operator/vaultOps.ts`](scripts/operator/vaultOps.ts) | OkuDollar vault operations. `ACTION=<wrap\|unwrap\|deposit\|mint\|withdraw\|redeem\|rescueDonation>` + `AMOUNT`, optional `RECEIVER` / `OWNER` / `MIN_AMOUNT_OUT`. Covers both the legacy price-aware `wrap`/`unwrap` pair and the ERC-4626 surface. |
| [`scripts/operator/depositBuffer.ts`](scripts/operator/depositBuffer.ts) / [`withdrawBuffer.ts`](scripts/operator/withdrawBuffer.ts) | PSM USDC buffer management. `AMOUNT=<6-dec USDC>`, plus `TO=0x...` for withdraw. Buffer depth determines whether redemptions settle instantly or queue. |
| [`scripts/operator/processQueue.ts`](scripts/operator/processQueue.ts) | Drain queued redemptions once the buffer is refunded. `BATCH_SIZE` (default 50), `LIMIT` (default unlimited). |
| [`scripts/operator/rescueQueueEntry.ts`](scripts/operator/rescueQueueEntry.ts) | Return a permanently-unprocessable queue entry's OkuM to an alternate recipient without burning. `INDEX` + `RECIPIENT`. Requires `QUEUE_RESCUER`. |
| [`scripts/operator/configureMinterAllowance.ts`](scripts/operator/configureMinterAllowance.ts) | Rotate a minter's allowance. `MINTER` (defaults to deployed LitePSM) + `ALLOWANCE`. Note `OkuMoney.mint` gates on **both** the `OKUM_MINTER` role *and* this allowance. |
| [`scripts/operator/setMaxSupply.ts`](scripts/operator/setMaxSupply.ts) | Raise/lower the supply cap. `MAX_SUPPLY=<18-dec>`. Requires `OKUM_CAP_MANAGER`. |
| [`scripts/operator/setOkuMMultiplier.ts`](scripts/operator/setOkuMMultiplier.ts) | **Emergency** multiplier override. `NEW_MULTIPLIER=<1e18-scaled>`. Collapses the rate schedule to halted and engages the yield-sandwich guard for the rest of the block — prefer `setOkuMYieldRate.ts` for normal operation. **Front-run risk beyond that block**: pause `psm` + `usdOku` (via `pause.ts`) before calling this, unpause after — see Accepted Risk #12. |
| [`scripts/operator/pause.ts`](scripts/operator/pause.ts) / [`unpause.ts`](scripts/operator/unpause.ts) | `TARGET=<psm\|okuM\|usdOku>`. |
| [`scripts/operator/blacklistBoth.ts`](scripts/operator/blacklistBoth.ts) | Blacklist/unblacklist an address on OkuMoney **and** OkuDollar in one run. `ACCOUNT=0x...`, `ACTION=<blacklist\|unblacklist>` (default `blacklist`). |

### Operator scripts (epoch orchestration)

The epoch pipeline is **derive once, broadcast to all** — a single
derivation produces a versioned artifact of WAD integers and absolute
timestamps, and a separate driver fans that one artifact out to every
chain. Splitting them is what guarantees each chain receives
byte-identical values.

| Script | Purpose |
|---|---|
| [`scripts/operator/deriveEpochSchedule.ts`](scripts/operator/deriveEpochSchedule.ts) | **Pure derivation, no broadcast.** `PHASE=<stage-settlement\|roll-epoch>`. Takes one reference-chain read of the current on-chain schedule plus one *global* V̄ sample (SVM-inclusive), and writes `scripts/config/epochs/<epochId>-<phase>.json` via `scripts/utils/epochArtifact.ts`. |
| [`scripts/operator/broadcastSchedule.ts`](scripts/operator/broadcastSchedule.ts) | **The orchestrator.** Reads one artifact and applies it to every participating chain — a subprocess of `applyScheduleSingleChain.ts` per EVM chain, plus SVM's own `set-yield-rate.ts --mode=atomic`. Records each chain's receipt back into the artifact, so a partial failure is resumed by re-running the same command. Writes the carry-ledger entry exactly **once**, after every chain confirms. Runs under `tsx`, not `hardhat run`. |
| [`scripts/operator/applyScheduleSingleChain.ts`](scripts/operator/applyScheduleSingleChain.ts) | Applies one artifact to whichever chain the Hardhat process is bound to. Split out because `resolveNetworkContext()` reads Hardhat's already-bound network runtime and cannot be redirected mid-process. Normally invoked by the broadcaster, not by hand. |
| [`scripts/config/epochChains.ts`](scripts/config/epochChains.ts) | Single source of truth for the participating chain set (`participatingChains()`), shared by the broadcaster and the V̄ sampler so the rate's denominator and its recipients can never diverge. Refuses any mainnet chain without an explicit `YES_MAINNET`. |
| [`scripts/config/epoch.ts`](scripts/config/epoch.ts) | The epoch grid itself: `EPOCH_LENGTH_SECONDS` (**86,400 — 24 hours**), `EPOCH_ANCHOR_UNIX` (2026-01-01T00:00:00Z), `EPOCH_GRID_TOLERANCE_SECONDS` (`length/10`). A backend constant — no contract reads it. |

### Operator scripts (yield)

| Script | Purpose |
|---|---|
| [`scripts/utils/yieldRate.ts`](scripts/utils/yieldRate.ts) | **Single source of truth** for APY ↔ per-second rate. Exports `apyToRatePerSecond`, `ratePerSecondToApy`, `realisedYieldToRatePerSecond`, `reconcileActualPayout`, `timeWeightedAverage`, `describeRate`, `describeCarry`, plus `PRECISION` / `MAX_RATE` / `SECONDS_PER_YEAR`. Every chain MUST receive a byte-identical integer; deriving from a declared APY removes the likeliest cross-chain mismatch (hand-entered 19-digit integers). `SECONDS_PER_YEAR` is **365 days exactly** — a protocol convention, not a calendar fact (SVM's Token-2022 `InterestBearingConfig` uses 365.24, one reason it is unsuitable for EVM parity). `realisedYieldToRatePerSecond` divides by a TIME-WEIGHTED AVERAGE global value across all chains, never a spot or local value — see [`docs/epoch-accounting.md`](docs/epoch-accounting.md) § "Two V's". |
| [`scripts/utils/epochDistribution.ts`](scripts/utils/epochDistribution.ts) | Base+settlement (B3) math: `distributedUsdOverWindow` (integrates dollars actually distributed from periodic value samples), `deriveSettlementRate` (closes the gap between target and measured-so-far, projecting the base window's own remaining tail). |
| [`scripts/utils/epochSchedule.ts`](scripts/utils/epochSchedule.ts) | Single entry point deriving the full `(rBase, baseEndSec, rSettle, settleEndSec)` tuple so every chain computes byte-identical values. `deriveBaseRate` / `deriveSettlementRateForEpoch` / `floatRateToBigint` / `toOnChainSchedule`. |
| [`scripts/utils/globalValue.ts`](scripts/utils/globalValue.ts) + [`scripts/operator/sampleGlobalValue.ts`](scripts/operator/sampleGlobalValue.ts) | Cross-chain `totalSupply() * okuMMultiplier()` sampler + local JSON store (REFERENCE implementation, not durable/shared — see `TRACKER.md`). `valueAt` (interpolation), `samplesInWindow`, `cumulativeDistributedUsd`. |
| [`scripts/utils/carryLedger.ts`](scripts/utils/carryLedger.ts) | Append-only local JSON ledger (REFERENCE implementation) of every epoch's rate derivation; `summarizeLedger()` computes the cumulative-conservation identity, read (diagnostic-only) by `checkMultiplierDrift.ts`. |
| [`scripts/operator/setOkuMYieldRate.ts`](scripts/operator/setOkuMYieldRate.ts) | Replaces the deleted `distributeYield.ts`. Prefers `APY=<fraction>` (raw `RATE=` supported for corrections but warned against). Default path calls `setOkuMYieldRate(rate, endTimestamp)`, requiring a future `END_TIMESTAMP` for any yielding rate; `STAGE=true PENDING_END_TIMESTAMP=<unix>` calls `setNextOkuMYieldRate(rate, pendingEndTimestamp)` — the **preferred** path, since the successor activates with no transaction at the boundary. `WITH_SUCCESSOR=true` (+ `NEXT_APY`) uses the atomic `setOkuMYieldRateWithSuccessor`. Supports `DRY_RUN=true`; `YES_MAINNET=true` required to broadcast on mainnet. |
| [`scripts/operator/checkMultiplierDrift.ts`](scripts/operator/checkMultiplierDrift.ts) | Read-only cross-chain drift monitor. Compares `okuMMultiplier()`, rate, `rateEnd`, and pending rate across chains; exits non-zero on any mismatch. `CHAINS`, `TOLERANCE_BPS` (default 1), `EXPIRY_WARN_HOURS` (default 4 — must stay well under one epoch length or it fires on every chain on every run), and `EPOCH_ANCHOR_UNIX` / `EPOCH_LENGTH_SECONDS` / `EPOCH_GRID_TOLERANCE_SECONDS` overrides for epoch-grid alignment checking (defaults come from the committed grid, so the check is ON by default). An EXPIRED rate window is now a hard failure (not a warning) — under a fixed-epoch model this is a recurring, scheduled deadline, not an edge case. Also reports the carry ledger's cumulative-conservation summary. |

**No longer present** (and no npm alias points at them):
`distributeYield.ts`, `setUsdYieldRate.ts`, `setMinCollateralRatio.ts`,
`runEpoch.ts`. The first three went with the single-multiplier refactor;
`runEpoch.ts` was superseded by the derive/broadcast split above.

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
    OkuMoney.sol            # Non-rebasing base token (OkuM). Static balances; okuMMultiplier()
                            # is COMPUTED, streaming from a rate schedule. Also implements ERC-8056.
    OkuDollar.sol           # Rebasing $1-pegged usdOku wrapping OkuM. usdMultiplier() delegates to
                            # okuMoney.okuMMultiplier() — single shared multiplier.
                            # IERC4626-interface-conformant with REBASING shares.
  psm/
    LitePSM.sol             # Multiplier-aware USDC ↔ OkuM + usdOku convenience functions.
                            # Sole user-facing mint/burn surface.
    RedemptionQueue.sol     # FIFO queue for OkuM redemptions when the PSM USDC buffer is depleted
  interfaces/
    IOkuMoney.sol           # OkuMoney interface (used by PSM, vault, mocks)
    IOkuDollar.sol          # OkuDollar vault interface
    IScaledUIAmount.sol     # ERC-8056 core + NewUIMultiplier / Conversion / Balances extensions
  lib/
    Roles.sol               # Shared RBAC role constants (prefix-namespaced)
    Constants.sol           # PRECISION, MAX_RATE, MAX_MULTIPLIER, BASIS_POINTS + terminology legend
    Errors.sol              # Shared error types (ZeroAddress, InsufficientBalance, MultiplierCannotDecrease)
    MathLib.sol             # computeMultiplier / compoundFor / rpow + conversion helpers
    ReentrancyGuardUpgradeable.sol  # OZ-5.x-compatible upgradeable reentrancy guard
                            # (OZ dropped the upgradeable variant in v5)
    YieldSandwichGuard.sol  # Shared whenYieldNotDistributing modifier (OkuDollar + LitePSM);
                            # guards the DISCRETE emergency override only
    events/
      OkuMoneyEvents.sol    # Event declarations for OkuMoney
      OkuDollarEvents.sol   # Event declarations for OkuDollar (incl. Blacklisted/Unblacklisted)
      LitePSMEvents.sol     # Event declarations for LitePSM
      RedemptionQueueEvents.sol  # Event declarations for RedemptionQueue (incl. TransferFailed skip)

test/
  mocks/                    # Test-only mocks (live under test/, never compiled into production artifacts)
    MockUSDC.sol            # 6-decimal ERC-20; used on testnets + in tests
```

> **No bridge scaffolding remains in `src/`.** There is no `src/bridge/`, no
> `IBridgeAdapter` / `IOkuBridgeNative` interface, and no `BRIDGE_*` /
> `ROUTER_*` / `NTT_*` constant in `Roles.sol` — `Roles.sol` defines exactly
> the OkuMoney / vault / PSM / queue roles listed in § Role Grants Policy.
> v1 cross-chain transfers are PSM-mediated mint/burn orchestrated off-chain;
> see [`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated).
> Should OkuBridge / NTT / CCIP be introduced, the change is **additive** —
> deploy the new proxy, grant it `OKUM_MINTER`, configure its minter
> allowance, with no modification to `OkuMoney` / `OkuDollar` / `LitePSM` /
> `RedemptionQueue`. It requires writing the interfaces and role constants
> fresh (or recovering them from pre-noBridge git history); there is no seam
> left in the tree to build on.

---

## Terminology (canonical)

[`src/lib/Constants.sol`](src/lib/Constants.sol) holds the authoritative
legend and every contract's NatSpec points at it. The three things worth
lifting out here, because they are the ones that get confused:

**One multiplier, written `m`.** `okuMMultiplier` is the dollar value of 1
OkuMoney token (starts `1e18` = $1.00, only increases) and is **computed**,
not stored — see § Streaming Accrual. `usdMultiplier` returns exactly
`okuMoney.okuMMultiplier()`; OkuDollar holds no rate state of its own.
`uiMultiplier` is the ERC-8056 alias for the same value. The rate-schedule
fields that `m` is computed from are listed once, under
§ OkuMoney.sol → Storage.

**Amounts.** `okuMAmount` is a raw OkuMoney token count (18 dec,
non-rebasing); `usdAmount` is an OkuDollar amount in dollar terms (18 dec,
rebasing); `usdcAmount` is USDC (6 dec). `usdcDecimalMultiplier` is a
per-PSM stored value (`10 ** (18 - usdcDecimals)`, computed at
`LitePSM.initialize` from the deployed USDC mint) — `1e12` on every chain
currently targeted.

**Shares — terminology hazard.** `usdShares` is OkuDollar's *internal*,
non-rebasing accounting unit, numerically identical to the raw OkuM
deposited. ERC-4626 "shares" means the *rebasing displayed balance*
(`balanceOf`, dollar-denominated). **These are different quantities** and
`convertToShares` returns the latter.

**Key formulas**
```
multiplier:              m(t)         = base × rpow(rate, t − anchor, PRECISION) / PRECISION
USDC → OkuMoney:         okuMAmount   = (usdcAmount × 1e12) × PRECISION / m
OkuMoney → USDC:         usdcAmount   = (okuMAmount × m / PRECISION) / 1e12
OkuMoney → usdOku share: shares       = okuMAmount × m / m          (= okuMAmount)
usdOku → OkuMoney:       okuMAmount   = usdAmount × PRECISION / m
```

The third formula collapsing to the identity is the algebraic consequence of
the single-multiplier design, and is why collateralization is exactly 1.0.

---

## Hardcoded Constants

Seven compile-time constants in [`src/lib/Constants.sol`](src/lib/Constants.sol),
each with its bound and its SVM-parity obligation in NatSpec. Not reproduced
here — a second copy of the values is a second thing to go stale.

The judgement a reader actually needs, and which the code does not state:
**which of these are negotiable.**

- **`PRECISION` (1e18) is not.** Changing it rewrites every multiplier path on
  both stacks and invalidates the differential corpus.
- **`OKU_M_DECIMALS` (18) is not.** It is a property of the token; changing it
  re-denominates OkuM.
- **`MAX_RATE` and `MAX_MULTIPLIER` are arbitrary**, in the precise sense that
  any number far above realistic yield trajectories would serve. They are
  sanity bounds against a compromised rebaser key and against `rpow` overflow,
  not economic parameters.
- **`MAX_RATE_WINDOW` (90 days) is load-bearing and tightly argued.** See the
  standing invariant in [`TRACKER.md`](../TRACKER.md): `rpow` overflows at ~15
  years and the failure is unrecoverable without an upgrade.
- **`MAX_USDC_DECIMALS` (18) is a deliberate forward-compat choice**, not a
  description of reality. Most USDC deployments use 6 — but BSC's canonical
  Binance-Peg USDC uses 18, which is why the PSM is decimals-agnostic rather
  than hardcoding 6.
- **`BASIS_POINTS` is unused by any contract.** It exists for SVM constant
  parity and is the residue of a fee that was never built — see the open fee
  decision in [`TRACKER.md`](../TRACKER.md).

Both stacks' constants must agree or the differential harness diverges; the
SVM mirror is `oku-shared/src/constants.rs`.

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

The single-multiplier design is a real state-space reduction — one rate
schedule instead of two, collateralization an invariant instead of a monitored
parameter, schedule storage in 2 slots, OkuMoney in 6 — but it is **not a net
line-count simplification**. `src/` sits at ~3,300 lines against ~2,850 for a
two-rate design, because this tree also carries ERC-4626 and ERC-8056
conformance plus the mandatory-bounded-window machinery those two and the
MEV-elimination goal require. Both standards are optional in isolation; they
are here for external composability and UI-multiplier discoverability, not
because the multiplier model needed them. An auditor is reviewing three
independent things at once (single multiplier, ERC-4626, ERC-8056), not one.

---

## Streaming Accrual & Cross-Chain Determinism

The multiplier streams continuously rather than moving in discrete
orchestrator-written jumps. Two properties require that:

1. **MEV.** A discrete jump is sandwichable — `mintOkuM` one block before a
   tick and `redeemOkuM` one block after captures a whole period's yield for
   ~12 seconds of capital exposure. A continuous curve has no step to straddle.
2. **Cross-chain coordination.** A discrete tick must be sequenced across all N
   chains inside a tight window, forever, and any divergence between chains is
   directly extractable by bridging between them. A shared rate schedule
   removes the per-tick simultaneity requirement entirely.

### The multiplier is computed, not stored

```solidity
function okuMMultiplier() public view returns (uint256) {
    return MathLib.computeMultiplier(
        okuMBaseMultiplier,
        okuMRatePerSecond,
        okuMLastAccrualTime,
        okuMRateEnd,
        okuMPendingRatePerSecond,
        okuMPendingRateEnd,
        block.timestamp
    );
}
```

`computeMultiplier` is a MakerDAO `chi`/DSR-style `rpow` accumulator: it compounds
the active rate from the anchor, rolls over to the pending rate at `okuMRateEnd`,
bounds that pending rate's own overhang at `okuMPendingRateEnd` (so an unattended
successor halts rather than compounding forever), and clamps at `MAX_MULTIPLIER`.
`rpow` itself is unchanged (MakerDAO `pot.sol` assembly, half-up rounding).

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

This is also why there is no on-chain `distributeYield()`. Dividing a dollar
amount by *local* `totalSupply()` is the one genuinely supply-dependent
operation in the protocol, and it produces a different multiplier delta on
every chain. Dollars→rate conversion lives off-chain in
`realisedYieldToRatePerSecond`, which divides by **global** dollar value across
all chains.

### The pre-staged successor rate

The handover fires off the **absolute `okuMRateEnd` timestamp inside the view
function, with no transaction at the boundary**. Staging transactions may land
on different chains at different times — even days apart — and the activation
is still simultaneous to the second. **This is the primitive that makes
cross-chain epoch handovers exact.** Signatures and rails: § Multiplier Model.

### Why streaming, not discrete ticks

Discrete payout — moving the multiplier once per period — is unsafe to offer
alongside a permissionless PSM. `setOkuMMultiplier` survives only as the
**emergency override**; it is not how yield is paid. The reasoning:

**The vector.** `LitePSM.mintOkuM` / `redeemOkuM` charge **no fee** (`tin`/`tout`
are both zero) and have **no cooldown** — a round-trip is instant whenever the
USDC buffer covers it. `YieldSandwichGuard` blocks exactly **one block** around a
discrete multiplier write. At 5% APY paid monthly (a 0.407% jump per tick),
depositing immediately before the tick and withdrawing immediately after
captures the whole month's yield for ~24 seconds of capital exposure:

| Capital | Profit per tick | Capital exposure |
|---|---|---|
| $1M | $4,070 | ~24 seconds |
| $10M | $40,700 | ~24 seconds |
| $100M | $407,000 | ~24 seconds |

**Who pays, by primitive — there is no third option:**
- `distributeYield(dollars)` divides by `totalSupply()` at call time. Attacker
  capital equal to honest supply **halves every honest holder's yield that
  period** — direct dilution.
- `setOkuMMultiplier(value)` moves dollar-value-per-token independent of who
  holds it. The attacker's share is **additional** — the **treasury** funds
  yield on capital that was never at risk for the period it claims to cover.

**The non-adversarial case is the sharper problem.** A holder who deposits the
day before a tick earns a full period's yield for one day of exposure. A holder
who withdraws the day before a tick earns **zero for the entire period** they
held through. Neither did anything wrong — this is the mechanic working as
designed, not an exploit. Private transaction submission does not fix it: it
conceals the timing of the tick *transaction*, not the tick *cadence*, which is
public (or trivially inferable) the moment the PSM is permissionless. Once the
cadence is known, the rational strategy is to hold only across ticks, which
doesn't get exploited so much as it makes continuous honest holding irrational.

**Mitigations considered, and why each fails or costs the product:**

| Mitigation | Outcome |
|---|---|
| Private/protected tx submission | Hides the tx, not the cadence — does not fix the structural unfairness. (Scoped to the *recurring, cadence-driven* tick this table is about. The one-off emergency override has no cadence to infer, so this rejection does not transfer to it — see Accepted Risk #12, where private submission would genuinely help, though the pause ceremony there is preferred since it needs no trust in the relay.) |
| Randomize tick timing | Attacker stays deposited across the uncertainty window; costs them opportunity cost, not the yield |
| Redemption fee (`tout`) | Must exceed the largest tick (~0.41%/mo) to close the vector — taxes every honest exit forever; moves the cliff, doesn't remove it |
| Deposit cooldown > tick period | Works, but destroys permissionless instant liquidity — i.e. the product |
| Widen the sandwich guard to N blocks | Attacker waits N blocks; bricks the PSM around every tick instead |
| Time-weighted / pro-rata accrual | This **is** streaming, reimplemented worse |
| Snapshot-based distribution | Snapshot timing becomes the new target, and breaks ERC-20 fungibility |

**The impossibility.** You cannot simultaneously have: a permissionless instant
PSM **∧** discrete (chunky) yield payout **∧** fairness to honest holders **∧**
a fungible ERC-20 balance. Something must give, and continuous streaming is the
only one of those four properties that is purely cosmetic to trade away — the
other three are the product.

**Why there is only one rate.** A second, independent UsdOku rate would be an
**unfunded promise**: if `usdRate > okuMRate`, UsdOku holders accrue faster
than the OkuM backing them 1:1 generates, and the vault drifts
undercollateralized at the treasury's expense. `minCollateralRatio`,
`depositReserves`, `withdrawSurplus` and `collateralizationRatio` would be the
machinery for tracking that gap. A single shared multiplier removes the
liability, not just the monitoring — which is why none of that machinery
exists. Both tokens are fully rear-facing off one rate; see § Rear-Facing
Epoch Accounting for how it is derived and reconciled without a second rate or
a forward-looking forecast.

**Honest costs of the streaming design**, not resolved by this section:
dollars→rate conversion happens in TypeScript (`packages/yield-tooling`,
re-exported through `scripts/utils/yieldRate.ts`), off-chain and unaudited by
Solidity tooling, rather than in on-chain arithmetic; `computeMultiplier` is a
7-argument, 3-branch function versus a single stored slot; every chain needs a
live re-arm cadence rather than set-and-forget; and it costs ~450 `src/` lines
net (see § Complexity, honestly, above). See `TRACKER.md` for open follow-ups,
including the AUM-drift reconciliation gap in the realized-yield-to-rate
conversion.

---

## Rear-Facing Epoch Accounting

Yield is **fully rear-facing**: the rate published for a fixed epoch is derived
from a PRIOR epoch's confirmed, realized off-chain proceeds. There is no
forecasting and no deliberate withholding (`conservativeFactor = 1.0`).

**No contract knows epochs exist.** The chain sees only `(rate, rateEnd)`
absolute timestamps, so epoch length and anchor are backend constants
(`scripts/config/epoch.ts`) that no contract or program reads.

The four facts a contract reader needs:

- **You cannot distribute a nominal USD amount.** A "distribute $N" primitive
  would divide by *local* `totalSupply()`, producing a different multiplier
  delta on every chain and breaking cross-chain equality. The rate is the only
  cross-chain-safe unit, which is why `setOkuMYieldRate` takes a rate and there
  is no `distributeYield()`.
- **Measurement basis and paying basis differ.** The denominator for deriving a
  rate is a time-weighted global average value (V̄) across all participating
  chains; the thing that actually appreciates is each chain's local supply.
  They do not coincide, and the residual is reconciled ex-post rather than
  predicted — see `reconcileActualPayout`.
- **A rate window must fit inside `MAX_RATE_WINDOW` (90 days).** Schedules
  longer than that must re-anchor, not open one window.
- **`setOkuMYieldRateWithSuccessor` exists for atomicity.** Writing the active
  rate and its successor in two transactions leaves a window in which the
  chains disagree.

Full model, derivation, and the simulation study that validated it:
[`docs/epoch-accounting.md`](docs/epoch-accounting.md).

---

## OkuMoney.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`, plus the four ERC-8056 interfaces.

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through multiplier appreciation, **computed continuously** from a rate schedule — see [Streaming Accrual](#streaming-accrual--cross-chain-determinism).

### Storage (ERC-7201 Namespaced)

`struct OkuMoneyStorage` in [`src/token/OkuMoney.sol`](src/token/OkuMoney.sol).
Two points that are not obvious from reading it: there is **no stored
`okuMMultiplier` slot** — six packed schedule fields replace it — and every
downcast at write time goes through `SafeCast`, so a value outside a field's
range reverts rather than silently truncating.

### Multiplier Model

`okuMMultiplier()` is a **computed view**, not a stored value.

| Function | Role | Effect |
|---|---|---|
| `setOkuMYieldRate(newRate, endTimestamp)` | `OKUM_REBASER` | Snapshots the current multiplier into `okuMBaseMultiplier`, resets `okuMLastAccrualTime` to now, sets the active rate + window, and **clears any armed pending rate**. Continuous across the write — no step, so it does NOT stamp `lastYieldDistributionBlock`. `endTimestamp` must be 0 when `newRate == PRECISION` (halting) and strictly future otherwise — every yielding rate carries a bounded window. Pause-gated for INCREASES only (`newRate > current` reverts while paused); decreases (including zeroing) remain available for incident response. |
| `setNextOkuMYieldRate(newRate, pendingEndTimestamp)` | `OKUM_REBASER` | Pre-stages the successor. Activates off the absolute `okuMRateEnd` with **no transaction at the boundary**. Requires a bounded active window (`NoRateEndSet` if `okuMRateEnd == 0`) that has not elapsed (`RateAlreadyExpired`), and `pendingEndTimestamp` strictly after `okuMRateEnd` — bounding how long the successor can compound unattended. |
| `setOkuMYieldRateWithSuccessor(newRate, endTimestamp, nextRate, nextEndTimestamp)` | `OKUM_REBASER` | Atomically composes `setOkuMYieldRate` then `setNextOkuMYieldRate` in ONE transaction — every check/event/pause-gate of both applies unchanged, in order. Exists to close the atomicity gap of calling them separately under the base+settlement epoch model (see [`docs/epoch-accounting.md`](docs/epoch-accounting.md)), where doing so twice per epoch, forever, otherwise risks landing the first call with the second failing/delayed — leaving NO successor staged and accrual silently halting at `endTimestamp`. |
| `setOkuMMultiplier(newMultiplier)` | `OKUM_REBASER` | **Emergency discrete override.** Writes `okuMBaseMultiplier = newMultiplier`, resets `okuMLastAccrualTime` to now, and collapses the rate schedule to halted (`okuMRatePerSecond`/`okuMPendingRatePerSecond` = `PRECISION`, `okuMRateEnd`/`okuMPendingRateEnd` = 0) — an operator must re-arm via `setOkuMYieldRate`. Enforces `newMultiplier > current` and `<= MAX_MULTIPLIER`. Pause-gated. Stamps `lastYieldDistributionBlock`. |

`setOkuMMultiplier` is the **sole remaining reason** `lastYieldDistributionBlock`
and `YieldSandwichGuard` / `whenYieldNotDistributing` still exist.

**There is no `distributeYield()`.** Any "distribute N dollars" primitive must
divide by *local* `totalSupply()` and therefore produces a different multiplier
delta on every chain. Dollars→rate conversion lives off-chain instead, against
a *global* value. See
[Streaming Accrual](#streaming-accrual--cross-chain-determinism).

**Rear-facing yield**: the orchestrator only ever publishes rates derived from
realized T-Bill returns — see [Rear-Facing Epoch Accounting](#rear-facing-epoch-accounting).

### ERC-8056 (Scaled UI Amount)

OkuMoney implements [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056) over the
same multiplier. Declared in `src/interfaces/IScaledUIAmount.sol`.

Four interfaces — core, the required `newUIMultiplier` extension, and the
optional conversion and balances extensions — all advertised through
`supportsInterface()`. Their literal hex IDs are pinned by
`test_InterfaceIds_MatchDocumentedHexValues` against the compiler-computed
`type(I).interfaceId`. That test looks tautological and is not:
`supportsInterface(type(I).interfaceId)` is self-referential and cannot detect
the *draft* moving its reference signatures underneath us.

> **ERC-8056 is a DRAFT standard.** The interface IDs above are taken from the
> current draft and **may change before Final**. See
> [Accepted Risks](#accepted-risks).

**Why adopt a Draft standard at all.** This is a forward-looking bet, not a
response to existing integrator demand: SVM's Token-2022 already ships a
`ScaledUiAmount` extension as a first-class primitive for exactly this
non-rebasing-token-with-appreciating-display pattern, and we expect other
EVM yield-bearing stablecoins to converge on ERC-8056 (or something
isomorphic to it) the same way. Implementing it now, while the design is
still Draft, means OkuMoney is positioned as one of the reference
implementations if/when it reaches Final, rather than retrofitting a
standard interface onto a token that predates it.

**Only OkuMoney implements ERC-8056 — OkuDollar (`usdOku`) deliberately does
not.** UsdOku shares are already denominated in dollars by construction
(`convertToShares`/`convertToAssets` are the identity at `usdMultiplier() ==
PRECISION`, and the vault's `usdMultiplier()` only moves because it
delegates to `okuMoney.okuMMultiplier()` — see below); a `uiMultiplier()` on
OkuDollar would either duplicate that or return a constant `1e18` forever,
telling an integrator nothing OkuMoney's doesn't already. The 8056 surface
belongs on the appreciating non-rebasing asset (OkuM), not on its
dollar-denominated wrapper.

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

**Integrator contract — what to expect if you only know the standard, not
OkuMoney's internals.** Deviation (1) means an 8056-only consumer cannot
event-drive its cache the way the EIP's reference implementation (discrete,
step-function multiplier) allows:

- `uiMultiplier()` / `balanceOfUI()` / `totalSupplyUI()` change **every
  second** with no corresponding event — they must be *polled*, not cached
  until the next `UIMultiplierUpdated`.
- `UIMultiplierUpdated` fires on every rate-schedule change (including
  `old == new`, see the NatSpec on the emit site in `OkuMoney.sol`) and
  signals "the trajectory changed", not "the value changed". Treat it as an
  invalidation hint for the *rate*, not as a value diff.
- The actual trajectory (new rate, window end) is on the non-standard
  `OkuMYieldRateUpdated` event. An 8056-only integrator that doesn't know
  this event still gets correct point-in-time reads from `uiMultiplier()`
  and friends — it just can't reconstruct history or predict future values
  the way an OkuMoney-aware indexer can via `OkuMYieldRateUpdated` +
  {computeMultiplier}.

**Single source of truth — the property this repo's design goal depends on.**
`toUIAmount`/`fromUIAmount`/`balanceOfUI`/`totalSupplyUI` are ERC-8056's view
of exactly the same multiplier `OkuDollar` uses to price OkuM against usdOku
shares — `uiMultiplier()` returns `okuMMultiplier()` directly, and
`OkuDollar.usdMultiplier()` is a one-line delegation to the same
`okuMoney.okuMMultiplier()` call, not an independently-tracked copy. There is
exactly one multiplier, read from exactly one place, by both surfaces. Pinned
by `test_ToUIAmount_EqualsConvertToShares_AcrossMultiplierChanges`
(`OkuDollar.t.sol`), which asserts `OkuMoney.toUIAmount(x) ==
OkuDollar.convertToShares(x)` (and the `fromUIAmount`/`convertToAssets`
inverse) directly against each other — not just that each independently
equals `okuMMultiplier()` — across a discrete override and a year of
streaming accrual, so a future change that reads the multiplier through a
different path on one side (e.g. a caching optimisation) cannot silently
diverge the two without a test failing.

### Key Implementation Notes

- `balanceOf()` is a standard ERC-20 raw token count. `okuMMultiplier()` is a
  computed view used for *pricing* by the PSM and vault — it never touches
  `balanceOf`. Minting 100 tokens at `okuMMultiplier = 1.05` creates $105.
- **`TransferValue` was REMOVED from OkuMoney.** Under streaming accrual the
  dollar value would require an `rpow` on every transfer (~5–10k gas, forever),
  and without that field the event duplicated ERC-20 `Transfer` exactly.
  Indexers derive dollar value off-chain from the rate schedule. OkuDollar
  keeps its own distinct `TransferValue`, which carries *shares* — a quantity
  `Transfer` does not expose.

### Blacklist Exemption

`blacklist()` deliberately does NOT use `whenNotPaused` — critical for the pause-to-blacklist protocol so operators can act during a paused incident.

### Role Constants

Declared once in [`src/lib/Roles.sol`](src/lib/Roles.sol), each `keccak256` of
its own name. OkuDollar deliberately reuses `OKUM_BLACKLISTER` /
`OKUM_UNBLACKLISTER` so one role name spans both tokens — but AccessControl
mappings are per-contract, so the grant must still be made on each.

Who holds what, and the blast radius of each: [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md).

---

## OkuDollar.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `YieldSandwichGuard`, `UUPSUpgradeable`.

**Concept**: Rebasing $1-pegged stablecoin wrapping OkuMoney. **Single multiplier** — `usdMultiplier()` returns exactly `okuMoney.okuMMultiplier()`; the vault holds no rate state of its own. Implements the IERC4626 surface with **rebasing** shares (see below); does not inherit OZ's `ERC4626Upgradeable`.

### Storage (ERC-7201 Namespaced)

`struct OkuDollarStorage` in [`src/token/OkuDollar.sol`](src/token/OkuDollar.sol).

**OkuDollar exposes no yield or reserve surface at all** — no
`setUsdYieldRate`, no `depositReserves` / `withdrawSurplus` /
`setMinCollateralRatio` / `collateralizationRatio()` / `surplus()`. Accrual
lives solely on OkuMoney, and collateralization is exactly 1.0 by construction,
so there is no ratio to configure or surplus to extract.

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

Signatures and full NatSpec in the source. Two things worth stating here:

- **`unwrap` rounds `sharesToBurn` UP** (`ceil`), deliberately favouring the
  vault. This is one of only three `Ceil` sites in the protocol — see
  [`src/lib/MathLib.sol`](src/lib/MathLib.sol)'s rounding-policy header.
- **`InsufficientBalance` and `InsufficientReserves` are intentionally
  distinct** — the first is a user balance check, the second a vault reserves
  check. Collapsing them would hide which side is actually short.

Both are `public` rather than `external` so the ERC-4626 entry points can call
them internally, and both carry `whenYieldNotDistributing` + `whenNotPaused` +
`nonReentrant`.

### ERC-4626 Surface

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

Declared in [`src/lib/events/OkuDollarEvents.sol`](src/lib/events/OkuDollarEvents.sol).

> **`Transfer.value` is advisory, not an accounting record.** It carries the
> effective post-rounding dollar amount, which is the closest single number to
> the value that moved — but **no** emitted value can make
> `Σ Transfer.value == Δ balanceOf` hold, because `balanceOf` floors per
> account and the two sides of a transfer need not agree. Integrators must read
> balances from `balanceOf()`. The worked counterexample is in
> `OkuDollar.transfer`'s NatSpec.

---

## LitePSM.sol

**Concept**: Multiplier-aware USDC ↔ OkuMoney swaps with usdOku convenience functions.

### OkuMoney Swap Functions

`mintOkuM(usdcAmount)` and `redeemOkuM(okuMAmount)` convert at
`okuMMultiplier()`, flooring in the protocol's favour. Conversions are
decimals-agnostic: the PSM stores a `decimalMultiplier` derived from the
collateral's own `decimals()` at init, so 6-, 8- and 18-decimal collateral all
work. At `okuMMultiplier = $1.05`, depositing 100 USDC gives ~95.24 OkuM;
redeeming 95.24 OkuM returns ~100 USDC.

**No user-supplied slippage / min-out parameter, on any of the four PSM entry
points (`mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`).** This is
deliberate, not an oversight — SVM's `lite-psm` equivalent
(`redeem_oku_m`) *does* take a `min_usdc_out` floor, and the asymmetry is
worth explaining rather than leaving a reader to assume EVM is missing a
safety check.

The guarantee rests on two properties, both of which hold today:

- **The multiplier is monotonically non-decreasing.** Rate writers floor at
  `PRECISION` (`InvalidRate`); the emergency override can only increase
  (`MultiplierCannotDecrease`). It never moves backwards between a quote and a
  transaction landing.
- **There is no fee anywhere in `LitePSM`.** Nothing mutable sits between the
  caller's input and the multiplier-derived output.

With both true, a delayed, reordered or front-run redemption pays the caller
*more*, never less, and minting preserves dollar value exactly. A min-out
parameter would have no adverse movement to bound. Pinned by
`test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier`.

Two checks that *looked* like slippage protection — `RoundTripDriftTooLarge`
and `OutputBelowMinimum` — have been removed. Neither could fire in the
deployed configuration, and the round-trip check was actively harmful at
18-decimal collateral, where its one-collateral-unit tolerance falls *below*
the truncation it measured and rejected roughly a third of ordinary mints once
the multiplier passed ~3.0. See [Accepted Risks](#accepted-risks). `OkuDollar`
keeps its own `OutputBelowMinimum` for `wrap`'s `minAmountOut`; that one is
reachable and unrelated.

**Why SVM carries the parameter and EVM doesn't.** SVM's monotonicity guards
are identical, so the guarantee holds there too — `min_usdc_out` is
defence-in-depth, not a structural need. The platform difference that makes it
*useful* there: **Solana has no view functions.** On EVM a client calls
`okuMMultiplier()` to observe pricing directly; on SVM the only way to observe
what the on-chain Rust accrual path computed is through its effect on a
state-changing instruction. `min_usdc_out` is reused for exactly that — the
devnet smoke test derives its floor from an independent TypeScript mirror and
passes it in, turning every redeem into a live Rust-vs-TS differential check
that reverts on-chain if the two disagree.

> **This analysis has one load-bearing precondition: no PSM fee.** If a fee
> lands on any of the four paths, output becomes a function of a mutable admin
> parameter and everything above stops holding. Add min-out parameters
> *before* the fee, not after. Tracked in [`TRACKER.md`](../TRACKER.md).

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

`depositBuffer` (`PSM_BUFFER_DEPOSITOR`), `withdrawUsdc`
(`PSM_BUFFER_WITHDRAWER`, with `WouldStrandQueue` protection), `processQueue`
(`PSM_QUEUE_PROCESSOR`), `pause`/`unpause`. All four also carry
`whenYieldNotDistributing` — `withdrawUsdc` because it reads the
multiplier-aware `totalQueuedUsdc()`, `processQueue` for the same reason.

### Events

Declared in [`src/lib/events/LitePSMEvents.sol`](src/lib/events/LitePSMEvents.sol).
One non-obvious shape: `redeemUsdOku` emits **only** `UsdOkuRedeemed`, with no
inner `OkuMRedeemed`; and a queued redemption emits `RedemptionQueued` instead
of `OkuMRedeemed`, not in addition to it.

---

## RedemptionQueue.sol

Stores raw OkuMoney token amounts. Since OkuMoney is non-rebasing, queued tokens don't grow in balance — but they appreciate in dollar value via `okuMMultiplier()`. At processing time, `usdcAmount = okuMAmount × okuMMultiplier() / PRECISION`, scaled to the collateral's decimals. The multiplier is cached once per batch for gas efficiency and cross-entry consistency.

`enqueue(user, okuMTokenAmount)` is record-only — the PSM transfers OkuMoney into the queue before calling. `processQueue(startIndex, endIndex)` (called by the PSM via `QUEUE_PSM`) burns OkuMoney, pulls USDC from the PSM, and pays users. `rescueQueueEntry(index, alternateRecipient)` returns OkuMoney to a stuck entry — called by `QUEUE_RESCUER`.

**Why an entry gets stuck, precisely.** Not a USDC-blacklisted recipient — `rescueQueueEntry` returns *OkuM*, and OkuM's blacklist is independent of USDC's, so a USDC-blacklisted user can still receive their OkuM back via `alternateRecipient == entry.user`. The real trigger is `entry.user` being **OkuM**-blacklisted: `OkuMoney._update` reverts `RecipientBlacklisted` on any transfer to them, including a self-return, so a genuinely different recipient is the only way to unstick that entry.

`alternateRecipient` is never checked against `entry.user` — necessarily, since that's what makes the OkuM-blacklist case rescuable at all. The same freedom means `QUEUE_RESCUER` can redirect *any* queued user's escrowed OkuM to an arbitrary address in one signature, irreversibly (`AUTHORITY-MATRIX.md` finding E24). Accepted rather than guarded in code: on the mainnet topology (`grantRolesMainnet.ts`), `QUEUE_RESCUER` and `QUEUE_UPGRADER` are co-held by the Cold Multisig, and `QUEUE_UPGRADER` can replace this contract's entire logic outright — a recipient check would constrain a key that already has a strictly larger lever. That argument holds only where the two roles are actually paired; it does not follow automatically if `QUEUE_RESCUER` is ever granted standalone (e.g. to an operational key without `QUEUE_UPGRADER`).

`processQueue` and `rescueQueueEntry` do NOT auto-advance `queueHead`. Operators (or anyone — the call is permissionless) call `advanceHead(maxSlots)` after a batch to amortize the head walk into a separate, gas-bounded transaction. `queueLength()` is an upper bound on live entries until `advanceHead` runs; redemption correctness is independent of the cursor.

### Events

Declared in [`src/lib/events/RedemptionQueueEvents.sol`](src/lib/events/RedemptionQueueEvents.sol).
Note `RedemptionSkipped(index, reason)` carries a reason code
(`AlreadyCleared` / `InsufficientFunds` / `TransferFailed`) — a skipped entry
is not a failed batch.

---

## Cross-Chain Transfers (v1: PSM-Mediated)

The full cross-chain model — including the SVM legs, the conservation
invariants, and the orchestrator's pre-flight/recovery runbook — is
documented once, in
[`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated).
EVM-side facts that belong here:

```
chain A                                       chain B
LitePSM.redeemOkuM(user, n) ─► orchestrator ─► LitePSM.mintOkuM (USDC custody)
                                              ─► OkuM credited to user on B
```

- LitePSM holds `OKUM_MINTER` on every chain — sole user-facing mint/burn surface.
- `mintOkuM` is **permissionless**; the orchestrator's only privilege on this
  path is its own USDC custody.
- The orchestrator custodies USDC and rebalances PSM buffers operationally.
- No on-chain signature verification, EIP-712 BridgeRequest, or refund flow in v1.
- No bridge scaffolding remains in `src/` — see the note under
  § Contract Structure.

---

## YieldSandwichGuard

Shared abstract at [`src/lib/YieldSandwichGuard.sol`](src/lib/YieldSandwichGuard.sol),
inherited by both `OkuDollar` and `LitePSM`. Exposes the
`whenYieldNotDistributing` modifier and the `YieldDistributionInProgress` error.

**Narrowed scope after the streaming refactor.** Continuous accrual has no
discrete step to sandwich, so normal yield operation does not engage this guard
at all — `setOkuMYieldRate` and `setNextOkuMYieldRate` deliberately do **not**
stamp `lastYieldDistributionBlock`. The guard protects **only** the discrete
emergency override `setOkuMMultiplier`, the one remaining function that creates
a discontinuity.

OkuMoney stamps `lastYieldDistributionBlock = block.number` inside
`setOkuMMultiplier` and nowhere else. Any PSM mint/redeem, vault wrap/unwrap,
`processQueue` or `withdrawUsdc` landing in that same block reverts. The lock
releases on the next block. Token transfers are unaffected.

> **This is FORWARD-ONLY. It is not a full sandwich guard.** It blocks the
> same-block backrun but not a mint one block *before* the override paired with
> a redeem one block *after* — which captures the entire discrete step on one
> block of capital exposure, for gas, with no fee anywhere to price it. See
> [Accepted Risks](#accepted-risks), "discrete-tick MEV", for the analysis and
> the operational mitigation (pause the PSM/vault around the override) that
> closes it without a code change.


---

## Role Grants Policy

Every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, rescuers, etc.) to other parties (multisigs, bots) post-deployment via `grantRoles.ts` or `grantRolesMainnet.ts`. This removes contract-specific role plumbing from deployment scripts.

`grantRoles.ts` and `grantRolesMainnet.ts` are NOT interchangeable — they implement different threat models for different environments:

| | `grantRoles.ts` | `grantRolesMainnet.ts` |
|---|---|---|
| Target | `MASTER_EOA` (single testnet operator key) | Cold Multisig / Warm Multisig / Orchestrator (3-key topology, from `MAINNET_COLD_MULTISIG` / `MAINNET_WARM_MULTISIG` / `MAINNET_ORCHESTRATOR` env vars) |
| Grants | `OKUM_REBASER`, `OKUM_MINTER`, `OKUM_BURNER` (OkuMoney) + `PSM_BUFFER_DEPOSITOR`, `PSM_QUEUE_PROCESSOR` (LitePSM), plus a `configureMinterAllowance` call so the mint grant is usable | Full production RBAC split per the table below |
| `DEFAULT_ADMIN_ROLE` / `*_UPGRADER` | Never granted — stays on the deployer | Cold Multisig only; deployer's admin is revoked as the script's final step |
| Runs on mainnet? | **Refuses unconditionally** — see its NatSpec header | Yes (its purpose) |

`grantRoles.ts` including `OKUM_MINTER`/`OKUM_BURNER` on an EOA is a **deliberate testnet-only divergence** from the "never callable by EOA" guarantee in the role table below — it exists to give a testnet operator SVM-equivalent direct-mint/burn parity (SVM has no redemption queue and must mint/burn directly; EVM's production bridge legs are USDC-collateral-mediated and don't need it). That is why the script hard-refuses to broadcast on any mainnet network rather than offering an opt-in override.

One intentional exception:
- `RedemptionQueue.QUEUE_PSM` is NOT granted at init — it is granted post-deploy to the `LitePSM` proxy address. This avoids a circular deployment dependency AND keeps admin from being able to call `enqueue` / `processQueue` directly (bypassing the PSM).

**Vault roles** (`src/lib/Roles.sol`) are `VAULT_UPGRADER`, `VAULT_PAUSER`,
`VAULT_UNPAUSER`, and `VAULT_RESCUER` (sole holder of `rescueDonation`). There
is deliberately no vault rebaser (OkuDollar has no rate of its own — accrual is
set on OkuMoney via `OKUM_REBASER`), no reserve manager and no vault admin
(collateralization is 1.0 by construction, so there is no surplus to withdraw
and no `minCollateralRatio` to configure).

### Per-role trust and blast radius

**Canonical: [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md).** It lists every
role-gated path with its guard, blast radius and reversibility, verified
against the source rather than transcribed from docs. Not duplicated here —
this table existed in four places and the copies had already drifted into
contradicting each other on whether `minterAllowance` is bounded by
`maxSupply`. It is not.

Two EVM-specific points that belong with the contracts rather than the matrix:

- **`OKUM_MINTER` is never callable by an EOA in the production model.** It is
  held by `LitePSM` and `RedemptionQueue`. `grantRoles.ts` deliberately breaks
  this on testnet to give an operator SVM-equivalent direct-mint parity, which
  is exactly why that script refuses to broadcast on any mainnet network.
- **A role grant alone does not enable minting.** `OkuMoney.mint` gates on
  *both* `onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, which
  `initialize` populates for nobody. A grant without a matching
  `configureMinterAllowance` call still reverts `ExceedsAllowance`.

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
contract. The reasoning, and the full per-tier capability model, is
[`../README.md` § Signer trust implications](../README.md#signer-trust-implications)
— industry peers rely on operational, procedural and regulatory
controls, and the cold-multisig quorum is itself the delay mechanism.

Per-role blast radius is tabulated under § Per-role trust and blast
radius above. The EVM-specific mitigations that bound a single-call
compromise:

- The discrete override `setOkuMMultiplier` stamps
  `lastYieldDistributionBlock`, and `whenYieldNotDistributing` blocks
  same-block sandwiching on every PSM + vault op that reads the
  multiplier. Streaming rate changes create no step and need no guard.
- Defence-in-depth ceilings: `MAX_MULTIPLIER = 1e24`,
  `MAX_RATE = PRECISION + 1e11`.
- Monotonic guards `MultiplierCannotDecrease`, `InvalidRate`,
  `RateAlreadyExpired` prevent backward writes.

Note that because OkuDollar delegates its multiplier, `OKUM_REBASER`
governs **both** tokens' yield from one grant.

**Operational expectation:** each operational role must rotate to a
multisig before mainnet launch.

### 2. Vault reserve-extraction opsec — STRUCTURALLY IMPOSSIBLE

A design with an independent vault rate plus a surplus-withdrawal
path admits a rate-then-withdraw sequence that extracts value just
added to the apparent reserve valuation, requiring an off-chain
key-separation control. **No such surface exists here.**
Collateralization is exactly 1.0 by construction — `usdMultiplier()`
IS `okuMoney.okuMMultiplier()`, and shares are only ever minted or
burned 1:1 against real OkuM at the same `m` — so there is no
surplus to extract and no ratio to inflate. There is no
`VAULT_REBASER`, `VAULT_RESERVE_MANAGER`, `VAULT_ADMIN`,
`depositReserves`, `withdrawSurplus`, `surplus()`,
`collateralizationRatio()`, or `minCollateralRatio` in the tree, and
no key-separation requirement.

The nearest surviving surface is `VAULT_RESCUER.rescueDonation`,
which is bounded below by `totalUsdShares` and therefore cannot reach
share backing (modulo the 1-wei accounting caveat in Risk 11).

### 3. USDC peg monitoring — off-chain (no on-chain oracle)

Both EVM and SVM handle USDC peg monitoring entirely off-chain. There
is no on-chain oracle, aggregator or circuit-breaker on either stack,
and no storage reserved for one — `LitePSM` and `RedemptionQueue`
layouts are compacted, not `__gap`-padded, so reintroducing one is a
layout-affecting change. The off-chain orchestrator monitors the peg
and pauses the PSM on a detected depeg.

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
slots that are already cleared (`user == address(0)`) **between
transactions**. Visible effect is purely on `queueLength()` accuracy. A
privileged version (e.g. `onlyRole(QUEUE_RESCUER)`) adds no security
and complicates the operator runbook; the function is gas-bounded by
`maxSlots` and emits `QueueHeadAdvanced` on any non-zero advance.

**`nonReentrant`, not merely permissionless, is what makes "only past
cleared slots" true.** `processQueue` deletes a slot (`delete
$.queue[i]`) BEFORE its external `trySafeTransferFrom` call and
restores it from memory only if that call reports failure — so for
the duration of that external call, a live entry transiently reads
`user == address(0)`, the exact sentinel `advanceHead` treats as safe
to skip past. Against a collateral token with a transfer callback that
signals failure by returning `false` rather than reverting (state
changes from a `false` return are NOT unwound, unlike a revert), a
reentrant `advanceHead` fired from inside that callback could move
`queueHead` past the transiently-cleared slot permanently —
`processQueue`'s own restore runs immediately after, but the slot is
now below `queueHead` and unreachable by every bound check in the
contract, stranding the entry's OkuM and permanently inflating
`totalQueuedUsdc()` against `withdrawUsdc`'s `WouldStrandQueue` check.
Not reachable with Circle USDC (no transfer callback) or any ERC-20
without one — but the collateral token is a deploy-time parameter
(`initialize` validates only `decimals() <= 18`), not a property either
contract can itself enforce, so `advanceHead` carries the same
`nonReentrant` guard as `processQueue` and `rescueQueueEntry`
regardless of which token is actually configured. See
`test/psm/Reentrancy.t.sol`'s `AdvanceHeadReentrancyTest`.

A related, lower-severity gap in the same no-callback assumption:
`processQueue`'s `usdcAvailable` bound is cached once before the loop
and decremented locally (gas) rather than re-read on-chain every
iteration, which is only accurate if nothing external changes the
caller's real balance/allowance mid-batch. A callback token's
recipient topping up the caller's funds mid-batch could make that
cached bound stale-LOW, causing a premature `break` — unlike the
`advanceHead` issue, this is liveness-only (a fundable entry stays
live and is reprocessable next batch; the real `trySafeTransferFrom`
call still enforces actual on-chain balance/allowance regardless of
the cache, so this can never cause an over-payment). Closed with a
lazy re-check: when the cache predicts insufficiency, re-read live
exactly once before trusting it to halt the batch — zero extra cost on
the common path (sufficient funds throughout, or a non-callback
token). See `test/psm/ProcessQueueCallbackTopUp.t.sol`.

### 7. No on-chain bridge

There is no on-chain bridge contract, adapter, interface or role
constant anywhere in `src/`, `test/`, or `scripts/`. Cross-chain
transfers are entirely orchestrator-mediated PSM mint/burn, so
replay protection, refunds and rate-limiting are off-chain
responsibilities with no on-chain enforcement. See § Cross-Chain
Transfers.

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
change `supportsInterface()` results for integrators. Adopted
deliberately, ahead of Final and ahead of confirmed integrator demand:
SVM's Token-2022 `ScaledUiAmount` extension already fills this role
there, and we expect ERC-8056 (or an equivalent) to become the EVM
convention for yield-bearing stablecoins the same way — see
[§ ERC-8056](#erc-8056-scaled-ui-amount) for the full reasoning.

**Mitigated, not eliminated:** `test_InterfaceIds_MatchDocumentedHexValues`
(`OkuMoney.t.sol`) pins all four hex values against the
compiler-computed `type(I).interfaceId`, so a signature change on
either side fails a test and names which of the three doc sites (this
entry, the interface file's NatSpec, the README table) needs
updating — it no longer relies on a human noticing before
`supportsInterface()` quietly starts returning different results than
documented. What the test cannot do is predict what the **Final**
spec's IDs will actually be; if ERC-8056 changes signature before
Final, this remains a real, if now loudly-surfaced, break for any
integrator hardcoding today's Draft IDs.

The two deviations documented under
[ERC-8056](#erc-8056-scaled-ui-amount) — emitting
`UIMultiplierUpdated` on rate-schedule changes rather than "whenever
the multiplier is changed", and returning a *projected* value from
`newUIMultiplier()` because we schedule a pending *rate* rather than
a pending *value* — are our **interpretations** of a spec written for
discrete multiplier steps. A reviewer may reasonably disagree with
either. See § ERC-8056's "Integrator contract" note for what a
standards-only consumer should actually expect from these two
deviations in practice (poll, don't cache on event; the real
trajectory is on the non-standard `OkuMYieldRateUpdated` event).

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

**This property extends to SVM**, which runs the same schedule at the
same `PRECISION = 1e18` over a line-for-line port of `MathLib.sol`.
Two SVM-specific caveats and their handling are documented in
[`SVM/README.md` § Accepted Risks](../SVM/README.md#accepted-risks):
wallet *display* still ticks (nothing prices against it), and
`Clock::unix_timestamp` can lag wall clock, so `checkMultiplierDrift.ts`
must compare at equal *chain* timestamps or it false-positives on SVM.

**Still not enforced on-chain, on either stack.** Bit-identical math
removes the likeliest source of divergence; it does not detect one.
Detection lives in two off-chain layers:

- `scripts/operator/checkMultiplierDrift.ts` now reads **SVM as well as**
  every EVM chain. Schedule-field equality is the exact,
  timestamp-independent check; the multiplier spread is reported with the
  read skew annotated, so SVM's clock lag is not mistaken for a drift.
- `test/differential/` holds the three implementations (Solidity, Rust,
  TypeScript) to a committed corpus of 3,867 vectors generated from this
  Solidity, reverts included. `npm run test:differential` from the repo
  root regenerates and replays it. A one-ulp rounding change fails ~1,200
  of them, so it detects the class of bug it exists for.

### 11. Known issues

**11a. `OkuDollar._redeemShares` floor-vs-ceil asymmetry — RESOLVED.**
A two-step third-party `withdraw` / `redeem` path (move an internal-share
amount FLOORED against `usdMultiplier`, then `unwrap`, which CEILS
`sharesToBurn`) can leave the spender one share short and revert
`InsufficientBalance` on an exact-balance redeem. Closed by burning
directly from `owner` inside a shared `_unwrap` core — a single ceil
computation against the owner's real balance, no intermediate share
move; see `unwrap` / `_unwrap` NatSpec. `_unwrap` also emits the ERC-20
`Transfer` for the burned shares and reports the true `owner` (not the
spender) in the ERC-4626 `Withdraw` event.

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

### 12. Discrete-tick MEV survives only on the emergency override

There is no discrete-tick sandwich vector on the normal yield path —
`okuMMultiplier()` streams and `setOkuMYieldRate` re-anchors to the
current value, so there is no step to straddle (§ Why streaming, not
discrete ticks). The vector survives **only** on `setOkuMMultiplier`,
the one remaining function that creates a discontinuity, which is why
`lastYieldDistributionBlock` and `whenYieldNotDistributing` are
retained (§ YieldSandwichGuard).

**Two distinct residuals, not one** — both unmitigated on-chain, for
different reasons and with different threat actors:

- **Cross-block manipulation by the override holder** (`OKUM_REBASER`):
  an insider with foreknowledge of their own upcoming call positions
  ahead of it. Not mitigated on-chain, for the same reasons given in
  Risk 1 (no timelock on privileged calls generally).
- **Third-party front-run of an honest override, by anyone watching
  the mempool** — no role required. `YieldSandwichGuard` is
  **forward-only**: `lastYieldDistributionBlock` is stamped *inside*
  `setOkuMMultiplier`, so a transaction ordered *before* it in the same
  block reads the pre-stamp value and is not blocked. Concretely: mint
  in block N ahead of a scheduled/observed override, let the override
  land, redeem in block N+1 — the guard blocks the back-run leg
  landing in the override's own block, but not a front-run mint placed
  one block earlier, nor the eventual redeem one block later. That
  combination captures the entire discrete step for one block of
  capital exposure, with no fee anywhere in the PSM to price it — the
  same economics as § Why streaming, not discrete ticks, on the one
  function that still has a step. See `YieldSandwichGuard.sol`'s
  NatSpec for the mechanism in full.

**Operational mitigation (no code change): pause around the
override.** `LitePSM` and `OkuDollar` each hold their OWN `Pausable`
state, independent of `OkuMoney`'s — `setOkuMMultiplier` is gated on
`OkuMoney`'s pause, not theirs. So:

```
1. LitePSM.pause()     (PSM_PAUSER)
   OkuDollar.pause()   (VAULT_PAUSER)
2. OkuMoney.setOkuMMultiplier(newValue)   -- OkuMoney itself need not be paused
3. LitePSM.unpause()   (PSM_UNPAUSER)
   OkuDollar.unpause() (VAULT_UNPAUSER)
```

With both mint/redeem surfaces frozen before the call and held frozen
until after it, no front-run or back-run transaction can land in
between — closing both residuals above, not just the same-block one
`YieldSandwichGuard` already handles. Cost: PSM/vault unavailability
for the ceremony's duration, and (on the mainnet role topology)
coordination across two tiers — pause sits on the Warm Multisig,
unpause on the Cold Multisig. Appropriate overhead for a function
documented as an emergency lever, not routine operation. Pinned by
`test_SetOkuMMultiplier_PauseCeremony_ClosesFrontRunWindow`
(`OkuMoney.t.sol`).

### 13. Blacklist parity with Circle FiatToken — now matched where it was gapped, by design where it isn't

The explicit goal is to match Circle FiatToken's blacklist posture — the
reference both tokens are built against (see the `OkuMoney.sol` NatSpec
citing `FiatTokenV2.sol` for the minter-allowance design, which this
section extends to blacklisting). Verified against Circle's public
source (`FiatTokenV1.sol`/`FiatTokenV2.sol`), not from memory, before
writing this entry.

**What already matched, before this pass:** `permit`/`approve` blocking
a blacklisted spender from receiving a NEW allowance; `_update`/
`_transferUsdShares` blocking a blacklisted `from`/`to` on every
transfer path; `blacklist()` working while paused (critical for the
pause-to-blacklist protocol); no retroactive allowance revocation
(Circle has none either — this is not a gap, see below); no seizure/
clawback function (Circle has none; USDT and Paxos diverge from Circle
here by adding one — we deliberately follow Circle, not them).

**What this pass closed — three real gaps, each independently
verified against Circle's source and pinned by a test that was
confirmed to fail without its corresponding fix:**

- `OkuMoney.transferFrom` / `OkuDollar.transferFrom` did not check the
  SPENDER's blacklist status — only `from`/`to`, via the transfer
  hooks. A blacklisted spender holding a pre-existing allowance (not
  revoked by `blacklist()` — see below) could move clean funds between
  clean addresses. Circle's `transferFrom` carries
  `notBlacklisted(msg.sender)` alongside `from`/`to` for exactly this
  reason. Fixed with a `transferFrom` override on OkuMoney (it had
  none — inherited OZ's unmodified) and a spender check added to
  OkuDollar's existing override. Pinned by
  `test_TransferFrom_RevertsOnBlacklistedSpender_EvenWithPriorAllowance`
  on both tokens.
- `OkuDollar._redeemShares` (the shared ERC-4626 `withdraw`/`redeem`
  path) had the identical gap: a blacklisted third-party spender
  exercising someone else's allowance was invisible to `_unwrap`'s
  `owner`/`receiver`-only check. Fixed with the same spender check,
  scoped to the allowance-spending branch (`owner != _msgSender()`) —
  redundant, and skipped, when the owner redeems their own shares.
  Pinned by
  `test_Redeem_RevertsOnBlacklistedSpender_EvenWithPriorAllowance`.
- `approve` on both tokens blocked a blacklisted spender from being
  newly approved, but not a blacklisted OWNER from newly approving —
  Circle's `approve` carries `notBlacklisted(msg.sender)` too. Fixed
  symmetrically. Pinned by `test_Approve_RevertsOnBlacklistedOwner` on
  both tokens.

**Spec-conformance fix, not a Circle-parity gap (Circle has no
ERC-4626 surface to compare against):** `maxWithdraw`/`maxRedeem`
unconditionally reported a non-zero max for a blacklisted or
paused owner whose `withdraw`/`redeem` call would unconditionally
revert — asymmetric with `maxDeposit`, which already zeroed correctly
for the same conditions on the deposit side. Fixed to mirror
`maxDeposit`'s pattern. Pinned by
`test_MaxWithdrawRedeem_ZeroForBlacklistedOwner`.

**Deliberately matched literally, despite looking like a self-brick
vector:** `mint` now also checks the MINTER's blacklist status, per
Circle's `mint` (`notBlacklisted(msg.sender)` alongside
`notBlacklisted(_to)`). This is a sharper divergence in practice than
in Circle, because Circle's minters are third-party partners while
`OKUM_MINTER` here is protocol infrastructure (`LitePSM`) — so this
check is a NEW way to brick all minting, by blacklisting the PSM
proxy, that didn't exist before this pass. Kept anyway for literal
parity with the cited reference: the role being infra today doesn't
guarantee it stays that way, the check costs one SLOAD, and the brick
requires actively blacklisting the protocol's own PSM, which should
never happen by mistake. Pinned by
`test_Mint_RevertsOnBlacklistedMinter`.

**What remains unmatched, deliberately, same as Circle:** blacklisting
still does not retroactively revoke allowances already granted before
the spender was blacklisted (`test_Approve_DoesNotRevokeExistingAllowanceOnBlacklist`
on both tokens) — this pass closes the ability to EXERCISE such an
allowance while blacklisted, not the allowance's continued existence.
If the spender is later unblacklisted, the old allowance becomes live
again with no new `approve` call required. This is Circle's own
behavior, not a gap relative to it — Circle has no mechanism to
iterate and revoke a blacklisted address's incoming allowances either
(unbounded by the number of grantors; infeasible on-chain for either
project). Equivalent mitigation on both: the compliance team can
observe `Approval` events for the blacklisted spender and have
grantors individually `approve(spender, 0)` if continued exposure is a
concern.

The invariant this pass makes true for the first time, across both
tokens: **a blacklisted address cannot successfully call any
state-changing function as sender, recipient, OR approved spender.**
Zero regressions in the pre-existing 593-test suite — nothing
previously relied on a blacklisted spender being able to move value.

### 14. Queue<->PSM wiring validation — enforced at init for new deployments; a correction to how a mismatch actually fails

`LitePSM.initialize` previously validated exactly one cross-contract edge
(`okuDollar.asset() == _okuMoney`, `AssetMismatch`). Nothing checked that
`_redemptionQueue` was configured with the same `usdc()` or `okuMoney()` as
this PSM — the requirement was prose-only, on the queue's own NatSpec.

**Fixed:** `LitePSM.initialize` now also reverts `QueueUsdcMismatch` /
`QueueOkuMoneyMismatch` if the queue passed in disagrees with either. Checked
after this PSM's own config (zero-address, `AssetMismatch`, decimals) so a
malformed `_usdc`/`_okuMoney` reports its own defect first, not a wiring
error against an unrelated queue. Safe ordering-wise: the queue is always
deployed and initialized before the PSM (every deploy script and test
fixture), and this is a read of already-set state — no circularity with the
queue's own deliberate omission of the `QUEUE_PSM` grant at its `initialize`
(that omission is about the role grant, not about reads).

**What this does NOT cover, by construction:** `initialize` runs exactly
once per proxy. It cannot protect an already-initialized queue or PSM from
being wired to each other incorrectly after the fact — e.g. a PSM proxy
*reused* via the deploy script's address-book `tryAttach` path, paired in a
later run with a *different* queue than the one it was actually initialized
against. `scripts/deploy/index.ts` now re-asserts both edges, plus that
`litePSM.redemptionQueue()` actually equals the queue address this run
resolved, inside `verifyDeployment` — covering exactly that reuse case,
independent of the init-time check. There is still no runtime (post-init)
assertion inside `processQueue` itself; closing the deploy-time gap was
judged sufficient, since a correctly-initialized pair can only diverge via a
proxy upgrade that changes the storage layout's queue/PSM references, which
is a different, already-reviewed risk category (see upgrade procedures).

**Correction to the original hypothesis for the okuMoney-mismatch case:**
the claim motivating this fix assumed a mismatched `okuMoney` would cause
`RedemptionQueue.processQueue` to silently burn "the wrong token" after
already paying out real USDC. Verified against the actual code and it does
not: `processQueue` burns via the queue's OWN wired `$.okuMoney` reference,
so a misconfigured queue calls `burn` on a token it holds neither a balance
of nor `OKUM_BURNER` on (the escrow it actually holds is whatever real token
was transferred in). That call reverts, and the revert is deliberately
unguarded (see the "DELIBERATELY UNGUARDED" comment in
`RedemptionQueue.processQueue`), so it unwinds the **entire** batch —
including the USDC transfer that executed earlier in the same call. The
failure mode is fail-closed (whole transaction reverts, nothing moves, real
escrow untouched), not silent value leakage. Pinned by
`test_ProcessQueue_MismatchedOkuMoney_RevertsEntireBatch_NoSilentCorruption`
(`RedemptionQueue.t.sol`). The USDC-mismatch case's consequence as originally
described — `usdcAvailable` reads the wrong token's balance/allowance,
collapses to zero, and every entry soft-skips via
`RedemptionSkipped(InsufficientFunds)` rather than reverting — was accurate.

**Unrelated defect found and fixed while verifying this claim:**
`scripts/operator/grantRolesMainnet.ts` asserted `OKUM_MINTER` was held by
`RedemptionQueue` before proceeding — a grant `deploy/index.ts` deliberately
never makes (`RedemptionQueue` only burns) and `verifyDeployment` asserts the
*absence* of. The mainnet RBAC ceremony script would therefore throw on
every correctly-deployed chain. Fixed: removed that check, added the
`QUEUE_PSM`-on-`RedemptionQueue` check the script's own header already
claimed to perform but never did, and corrected the header prose.

---

### 15. The PSM has no slippage protection — deliberately, and two checks that pretended otherwise have been removed

`LitePSM`'s four user entry points (`mintOkuM`, `redeemOkuM`, `mintUsdOku`,
`redeemUsdOku`) take no `minOut` / `maxIn` parameter. **This is correct, not an
omission**, and the reason is structural rather than a judgement call:

`okuMMultiplier` is **monotonically non-decreasing**. `OkuMoney._setOkuMYieldRate`
rejects any `newRate < PRECISION` (`InvalidRate`), so streaming accrual can only
compound upward or stand still; the discrete override `setOkuMMultiplier` requires
a strict increase (`MultiplierCannotDecrease`). Therefore:

- **Redeem** output is linear and increasing in the multiplier. A redemption that
  lands later than the caller expected — delayed, reordered, front-run — pays them
  **more**, never less. There is no downside for a bound to catch.
- **Mint** fixes `usdcAmount` as the input. A higher multiplier yields fewer raw
  OkuM units, each worth proportionally more, so the **dollar value received is
  invariant** to when the transaction lands.

Pinned by `test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier`.

**SVM diverges deliberately.** `lite-psm`'s `redeem_oku_m` *does* take a
`min_usdc_out`. The same monotonicity argument holds there, so it is client-side
defence-in-depth rather than a structural need; that instruction's doc comment
records the divergence from the other side.

#### What was removed, and why leaving it would have been worse

Two errors were deleted from `LitePSM` in this pass:

| Removed | Why it was not protection |
| --- | --- |
| `OutputBelowMinimum(uint256,uint256)` | Compared `usdcAmount` against a floor recomputed from `okuMAmount` truncated to `decimalMultiplier`. Both conversions are monotone non-decreasing and the truncated input is `<=` the real one, so the floor was **always** `<=` the value it gated. Unreachable at every decimal count. |
| `RoundTripDriftTooLarge(uint256,uint256)` | Tolerated one **collateral unit** of round-trip drift. Dead at 6 decimals — the tolerance ($0.000001) sits far above the sub-unit truncation it measured. **Actively harmful at 18.** |

The second one matters. At 18-decimal collateral `decimalMultiplier == 1`, so the
collateral unit *is* the dollar wei and the tolerance drops **below** the
truncation it was meant to absorb. At multiplier `m = 3.0`, `okuM = floor(V/3)` and
the round trip returns `3 * floor(V/3)`, so the drift is exactly `V mod 3` — which
is `2` for a third of all inputs, against a tolerance of `1`:

```
USDC 6dp         m = 1.00 / 1.05 / 3.00   ->  fires on   0/3000 mint amounts
collateral 18dp  m = 1.05                 ->  fires on   0/3000
collateral 18dp  m = 3.00                 ->  fires on 999/3000   <-- 1 in 3 ordinary mints revert
```

**This is not hypothetical.** BSC is a configured deployment target and its
canonical Binance-Peg USDC carries **18 decimals**, not 6
(`scripts/config/chains.ts`). Deploys there currently default to `MockUSDC` (6dp),
which is the only reason it has never fired. Until this pass the suite's sole
non-6-decimal coverage asserted that `initialize` succeeded and stopped there — no
test ever pushed a mint or redeem through the `decimalMultiplier == 1` path, which
is precisely where the defect lived.

Closed by `test_MultiDecimal_18Dec_MintSucceedsOnTruncatingAmount` and
`test_MultiDecimal_18Dec_MintSucceedsAcrossAllResidues` (both verified to fail
against the pre-removal contract with the exact predicted revert args), with
`test_MultiDecimal_8Dec_MintSucceedsAcrossAllResidues` pinning the boundary so the
18-decimal result reads as "the tolerance ran out" rather than "non-6-decimal
collateral is broken".

**Residual, accepted:** removing the mint-side check means a caller on 18-decimal
collateral now silently forfeits up to `ceil(m / PRECISION)` wei of truncation
instead of reverting. That is strictly better than reverting and it rounds to the
protocol, but it is a behavioural change rather than a pure deletion, and it is
recorded as one. `OkuDollar` keeps its own, unrelated `OutputBelowMinimum` for
`wrap`'s `minAmountOut` — that check is reachable and stays.

---

### 16. The queue's dust floor collapses at 18-decimal collateral

`LitePSM._redeemOkuMShared` gates minimum redemption size at
`okuMAmount < decimalMultiplier`, where `decimalMultiplier == 10**(18 - d)`. This
is the **queue's dust floor**: every redemption the buffer cannot cover becomes a
`QueueEntry` costing two SSTOREs to create, and full loop-body gas plus an external
`burn` for `PSM_QUEUE_PROCESSOR` to clear. Without a floor, an attacker can stuff
the queue with economically meaningless entries at the processor's expense.

The floor scales with the collateral's decimals, and **vanishes at the top end**:

| Collateral decimals | `decimalMultiplier` | Effective floor |
| --- | --- | --- |
| 6 (Circle USDC) | `1e12` | `1e12` OkuM wei ≈ **$0.000001** |
| 8 | `1e10` | ≈ $0.0000001 |
| 18 (Binance-Peg USDC) | `1` | **1 wei — no floor at all** |

At 18 decimals the only remaining gate is `usdcAmount == 0`, so a 1-wei redemption
is enqueueable. Combined with Accepted Risk #12 (round-tripping the PSM is free —
there is no fee anywhere), draining the buffer to force redemptions into the queue
and then stuffing it is cheap on an 18-decimal chain.

**Not fixed in this pass, deliberately.** The fix is an absolute minimum-redemption
parameter independent of `decimalMultiplier`, which is a new storage field, a new
admin lever and an SVM parity obligation — disproportionate to bundle into a
dead-code removal, and it interacts directly with the open fee decision (a fee
would price queue-stuffing without needing a separate floor). Tracked alongside
that decision; see `TRACKER.md`.

**Operational mitigation until then:** the risk only materialises on a chain
deployed against genuinely 18-decimal collateral. BSC deploys currently default to
`MockUSDC` (6 decimals), and flipping `SKIP_MOCK_USDC=true` there is the action
that would expose it. Treat that flag as requiring this decision to be resolved
first.

---

## Testing

**Counts (measured):** `forge test` **622**, `npx hardhat test` **259**
(of which `npm run test:unit` is **232**). Cross-stack:
`packages/yield-tooling` 3,867 differential vectors; SVM 61 Rust + 124 bankrun.

```bash
forge test --match-path "test/invariants/*"        # Invariant suite (256 runs × 500 depth by default)
forge test --match-contract OkuMoneyTest -vv       # OkuMoney unit tests (incl. rate-schedule suite)
forge test --match-contract VaultInvariants        # OkuDollar backing invariants
forge test --match-contract HandlerSanityTest      # Handler success-rate sanity checks
forge test --match-contract MathLibTest            # MathLib branch coverage (rpow, compoundFor, computeMultiplier)
forge fmt --check                                  # CI gate — formatting
forge coverage --no-match-coverage 'test/|script/' --report summary  # CI gate — 95% per-file line coverage

npx hardhat test test/hardhat/drill/*.ts           # Deploy drill + operator drill only
npx hardhat test test/hardhat/scenarios/RealWorldUsage.ts  # 365-day simulation + 7 edge cases
```

The Foundry suite is the authoritative functional coverage. The Hardhat suite covers five areas:
1. **Fork tests** (`test/hardhat/fork/`): exercise the protocol against real mainnet / Sepolia state that Foundry can't reach in CI.
2. **Happy-path integration** (`test/hardhat/happyPath/`): full deposit/yield/withdraw walk-through against the OZ upgrades plugin's real proxy machinery.
3. **Real-world scenario simulation** (`test/hardhat/scenarios/RealWorldUsage.ts`): 365-day stochastic simulation (seeded PRNG, 7 action categories, daily `evm_increaseTime` steps) plus 7 deterministic edge-case suites covering round-trips, queued redeems, multiplier divergence, blacklist/freeze, pause windows, yield-lock, and cap exhaustion.
4. **Off-chain rate/epoch math + rear-facing accounting simulation** (`test/hardhat/unit/`, `test/hardhat/simulation/`): pure-TS unit tests for `yieldRate.ts` / `epochDistribution.ts` / `epochSchedule.ts` / `globalValue.ts` / `carryLedger.ts`, plus the base+settlement accuracy simulation — see [`docs/epoch-accounting.md`](docs/epoch-accounting.md).
5. **Deploy + operator drills** (`test/hardhat/drill/`): `deployDrill.test.ts` runs the **real** `scripts/deploy/index.ts` against a local fork and asserts the resulting chain (all five proxies deployed, address book written, the complete 21-grant role matrix present, privileged roles *not* held by outsiders, and a live PSM mint succeeding). `operatorDrill.test.ts` then exercises **every operator-script lever** in-process against that same deploy, so the scripts are tested against the production role topology rather than a bespoke fixture.

> `npm run test:unit` runs groups 4 and 5 and **requires a fork RPC** — the
> drills reset and deploy against the configured fork. For the genuinely
> offline subset use
> `npx hardhat test test/hardhat/unit/*.ts test/hardhat/simulation/*.ts`.

Any new unit or invariant test should be added to the Foundry suite; Hardhat is reserved for fork-dependent, multi-contract scenario work, or off-chain script/simulation logic that has no Solidity counterpart.

---

## Forge coverage notes

Per-file coverage (`forge coverage --no-match-coverage 'test/|script/'`):

| File | Lines | Statements | Branches | Funcs |
|---|---|---|---|---|
| `src/lib/MathLib.sol` | **100 %** (53/53) | 97.47 % | 75.00 % | 100 % |
| `src/lib/ReentrancyGuardUpgradeable.sol` | **100 %** (17/17) | 100 % | 100 % | 100 % |
| `src/lib/YieldSandwichGuard.sol` | **100 %** (3/3) | 100 % | 100 % | 100 % |
| `src/psm/LitePSM.sol` | **97.92 %** (141/144) | 96.02 % | 74.07 % | 100 % |
| `src/psm/RedemptionQueue.sol` | **100 %** (106/106) | 99.25 % | 93.33 % | 100 % |
| `src/token/OkuDollar.sol` | **97.91 %** (187/191) | 95.73 % | 81.25 % | 97.78 % |
| `src/token/OkuMoney.sol` | **99.53 %** (211/212) | 99.19 % | 97.22 % | 100 % |
| **Total** | **98.90 %** (718/726) | 97.57 % | **85.48 %** | 99.32 % |

A CI gate in `.github/workflows/test.yml` fails the build if any `src/` file
or the overall total drops below **95 % line coverage**. Every file clears it;
the worst is `OkuDollar.sol` at 97.91 %.

> **Branch coverage is the weak spot and is _not_ gated.** At 85.48 % overall —
> `LitePSM.sol` 74.07 %, `MathLib.sol` 75.00 %, `OkuDollar.sol` 81.25 % — it is
> materially below the line figure. `LitePSM` being lowest is worth noting:
> `_redeemOkuMShared` is already flagged as the densest control flow in the
> suite (see § Auditor checklist), so the branchiest function is also among the
> least branch-covered. Most uncovered branches are the defensive guards listed
> below, but this is where audit attention will land. Tracked in `TRACKER.md`.

### Uncovered lines (intentional)

The remaining uncovered lines are **defensive guards unreachable from
the contracts as currently composed**. They are kept for
future-proofing against changes to dependent contracts. Driving them
in tests would require malicious mock contracts that misrepresent
the multiplier or share-conversion semantics — a test surface we
judged not worth the maintenance cost.

| Location | Code | Why unreachable today |
|---|---|---|
| `OkuDollar.sol` `_update` | `UseWrapInstead` / `UseUnwrapInstead` / `OkuDollarDoesNotUseInternalUpdate` guards | `OkuDollar` overrides `transfer` / `transferFrom` to use share-based accounting; all supply changes go through `wrap()` / `unwrap()`, which manage `usdShares` directly and never call the inherited `_mint` / `_burn`. Since nothing in the contract invokes `_mint` or `_burn`, this `pure`, unconditionally-reverting override is unreachable today — it exists purely to halt any future refactor that accidentally routes through the inherited ERC-20 `_update` hook. |

> **Three entries were deleted from this table**, not re-explained:
> `RoundTripDriftTooLarge` on `mintOkuM` and `mintUsdOku`, and
> `OutputBelowMinimum` on `_redeemOkuMShared`. They sat here for several
> revisions justified as "defensive guards unreachable today, kept for
> future-proofing" — which was half right. They were unreachable, but they
> were not defending anything: the conditions they tested are bounded by
> construction, not by an assumption about `OkuMoney` that a future change
> could break. One of them was worse than inert (Accepted Risk #15). The
> remaining `OkuDollar._update` entry is a genuine tripwire and stays — the
> distinction is that `_update` guards against a *future refactor* routing
> through an inherited hook, which is a real and recurring hazard, whereas
> the removed three guarded against arithmetic that cannot happen.

### Uncovered branches (intentional)

Branch coverage is **96.30% (130/135)** and gated at 95% in CI. The five
uncovered branches are all `revert` arms that cannot be driven from any call
path, each for a stated structural reason — not for want of a test.

| Location | Guard | Why the revert arm is unreachable |
|---|---|---|
| `LitePSM.sol:321` | `usdcAmount == 0` in `_redeemOkuMShared` | The dust floor on the line above already requires `okuMAmount >= decimalMultiplier`. Since `m >= PRECISION`, `dollarValue18 >= okuMAmount >= decimalMultiplier`, so `usdcAmount = dollarValue18 / decimalMultiplier >= 1`. Defence-in-depth against a future change to either the floor or the monotonicity guarantee. |
| `OkuDollar.sol:322` | `from == address(0)` in `_transferUsdShares` | `transferFrom` spends the allowance first, and `address(0)` can never have granted one, so the allowance check always fires earlier. The `to` half of the same pair **is** reachable and is tested. |
| `OkuDollar.sol:425`, `:426` | `UseWrapInstead` / `UseUnwrapInstead` in `_update` | Nothing in the contract invokes the inherited `_mint`/`_burn`; all supply changes go through `wrap`/`unwrap`, which manage `usdShares` directly. A tripwire for a future refactor that routes through the inherited ERC-20 hook — the one hazard in this table that is realistic, which is why it stays. |
| `OkuDollar.sol:475` | `sharesToMint == 0` in `wrap` | `wrap` rejects `okuMAmount == 0` at entry, and `sharesToMint == actualReceived`, so reaching zero requires an asset that takes a 100% transfer fee. The asset is the typed `IOkuMoney` wired at init, which is not fee-on-transfer. Kept because the balance-delta pattern exists precisely to tolerate a fee-on-transfer asset. |

The distinction worth preserving: these are guards against an **assumption about
a collaborator that a future change could break**. That is different from the
three checks deleted above, which guarded against arithmetic that cannot happen
by construction. The first kind earns its keep; the second was noise.

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
   - `test_SetNextOkuMYieldRate_RevertsWhenNoRateEnd` — halted active rate → `NoRateEndSet`.
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

Extending `MockUSDC` with `setBlocked` to drive the TransferFailed
branch surfaced a real finding: `RedemptionQueue.processQueue`'s
low-level `.call` pattern treated a `transferFrom` returning `false`
(without reverting) as success. Real Circle USDC's blacklist reverts,
so production behaviour was safe, but a non-standard ERC-20 (or future
USDC variant) returning `false` would have silently cleared queue
entries without paying users.

**Fix:** `SafeERC20.trySafeTransferFrom`, which both (a) swallows
reverts and (b) decodes the boolean return value. Tests drive both
shapes independently — revert (matches real USDC blacklist) and
return-false (hypothetical non-standard USDC). The return-false test
is the regression guard for this finding.

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
