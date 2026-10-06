# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity, pinned compiler and EVM version (`foundry.toml` and `hardhat.config.ts` must agree)
- **Framework**: Foundry (Forge, Cast, Anvil) for unit, fuzz, invariant, and differential-vector tests; Hardhat for fork tests, off-chain script/simulation tests, deploy/operator drills, and gas reports
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable); exact versions in `package.json` and `foundry.lock`
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`, `RedemptionQueue`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Quick Start

```bash
forge install && forge build && forge test    # unit, fuzz, invariant, differential-vector tests
npx hardhat compile && npx hardhat test       # fork, integration, simulation, deploy/operator drill tests
```

CI (`.github/workflows/test.yml`) enforces >=95% line coverage on every `src/`
file and on the total, and >=95% total branch coverage, from `forge coverage`.

Targeted invocations and what each suite covers: § Testing.
Every operator and deploy entry point: § npm scripts.

**RPC and fork configuration.** [`scripts/config/rpc.ts`](scripts/config/rpc.ts)
is the single resolver for every RPC URL (Hardhat config, scripts, and tests all
use it). Keys come from the environment (`.env` is loaded by
`hardhat.config.ts`); never commit or paste them.

- **Live networks:** explicit `<CHAIN>_RPC_URL` > Ankr (`ANKR_FREEMIUM_API_KEY`)
  > Alchemy (`ALCHEMY_API_KEY`) > public node. Ankr slugs exist for `mainnet`,
  `sepolia`, `arbitrum`, `arbSepolia`, `base`, `baseSepolia`, `bsc`, and
  `bscTestnet`; **Optimism is deliberately excluded** because the freemium key
  is rejected there, so it falls through to Alchemy or public.
- **Forks:** `FORK_URL` > Ankr > Alchemy > explicit chain URL > public node.
  Archive providers rank above the chain URL because the latter is usually a
  plain public node that cannot serve a pinned block.
- **Fork block:** the mainnet fork block is pinned (`PINNED_FORK_BLOCKS` in
  `rpc.ts`; override with `FORK_BLOCK_NUMBER`) when an archive endpoint is
  available (`FORK_URL`, Ankr, or Alchemy). Otherwise it forks latest, and
  the Hardhat fork helper warns that the run is not deterministic.
- **CI** needs the `ANKR_FREEMIUM_API_KEY` repository secret so the Hardhat job
  gets the pinned mainnet fork.

## Deployment & Address Book

The unified deploy script (`scripts/deploy/index.ts`) provisions every contract
for a given chain in one run, captures addresses to a working address book, and
on live networks also mirrors them into the canonical repo-root registry.

### Deterministic addresses (CREATE2)

Every UUPS proxy + its implementation, plus `MockUSDC`, are deployed via the
[Arachnid CREATE2 factory](https://github.com/Arachnid/deterministic-deployment-proxy)
(address in `CREATE2_FACTORY`; it exists on every chain we deploy to), so the
same compiled code + `DEPLOYMENT_VERSION` + constructor args produce the
**same contract address on every chain**. Salt:
`keccak256("okumoney." + DEPLOYMENT_VERSION + "." + <name>)` — the version
constant and factory live in
[`scripts/config/deploymentVersion.ts`](scripts/config/deploymentVersion.ts),
helpers in [`scripts/utils/create2Deploy.ts`](scripts/utils/create2Deploy.ts).

Caveats:
- **Version semantics:** `v0.x` = pre-audit iteration (addresses may change
  across versions); `v1.0+` reserved for post-audit. Bumping
  `DEPLOYMENT_VERSION` is one-way — prior-version deploys keep their
  addresses.
- **Fallback:** if the factory isn't deployed on a target chain, the script
  warns and falls through to nonce-based CREATE (non-deterministic
  addresses).
- **Per-chain variance:** differing constructor args (a real collateral token
  vs. `MockUSDC`) produce different addresses for the contracts that take
  them. The deploy script deploys `MockUSDC` deterministically unless
  `SKIP_MOCK_USDC=true`, so `RedemptionQueue`/`LitePSM` match across chains
  that share it; a chain pointed at a real USDC address diverges.
- **Comments do not move addresses.** `foundry.toml` (`bytecode_hash = "none"`)
  and `hardhat.config.ts` (`metadata.bytecodeHash: "none"`) both omit the
  source-text metadata hash from creation bytecode, so editing a comment or
  NatSpec line in `src/` leaves the initCode, and therefore the CREATE2
  address, unchanged. Addresses change only with code semantics, the compiler
  or optimizer settings, constructor args, or `DEPLOYMENT_VERSION`. The two
  `bytecodeHash` settings must stay in sync: if the toolchains disagree they
  compile the same source to different addresses.

### Where deployed addresses live

| File | Role | Touched by |
|------|------|------------|
| [`scripts/config/addresses.json`](scripts/config/addresses.json) | **Tracked** per-network address book consumed by deploy / test scripts. Keyed `<chain>` — live deploys only. | Live deploys. |
| `scripts/config/addresses.local.json` | **Gitignored** half of the same book, keyed `fork:<chain>`. Local-fork deployments are ephemeral (the chain is discarded after the run), so they're split out and never committed. `loadAddressBook()` merges both files, so scripts see one book and need no knowledge of the split. | Every fork run. |
| [`../testnet-addresses.json`](../testnet-addresses.json) | Canonical, auto-synced multi-chain registry consumed by the SDK / backend / orchestrator. Includes `chainId`, `rpcUrl`, `explorer`, `contracts{}`, `deployer`. | Live deploys only — fork runs never write here. |
| `.openzeppelin/<network>.json` | OZ upgrades plugin's per-chain proxy/impl manifest. Required for `upgradeProxy` to work. | OZ upgrades plugin. |

### Configured networks

The network keys (Hardhat `--network` names), chain IDs, per-chain collateral
token addresses, and explorers are defined in
[`scripts/config/chains.ts`](scripts/config/chains.ts) (the source of truth),
with the matching network entries in [`hardhat.config.ts`](hardhat.config.ts).
RPC URLs resolve through [`scripts/config/rpc.ts`](scripts/config/rpc.ts) — see
§ Quick Start. No on-chain message carries a chain identifier in v1.

### Running a deploy

> **The step-by-step runbook — prerequisites, fork pre-flight, live deploy,
> verification smoke, mainnet ceremony — is documented once for both stacks in
> [`../README.md` § Deployment runbook](../README.md#deployment-runbook).**
> This section covers only what is specific to the EVM script's behaviour.

**Automated multi-chain pre-flight — [`scripts/deploy/dryRunForks.sh`](scripts/deploy/dryRunForks.sh):**

```bash
./scripts/deploy/dryRunForks.sh                # the script's default chain list
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
  5 retries) inside `withRetry`.
- A separate provider shim (`scripts/utils/rpcCompat.ts`) preventatively
  normalises BSC's pending-tx response shape before ethers' strict formatter
  ever sees it.

The script also **verifies itself before reporting success**. After the role
grants, it re-reads the chain and asserts the complete expected matrix — every
grant in `expectedRoleGrants()`, the LitePSM minter allowance, the queue/PSM
wiring, and every contract's presence in the address book — throwing with an
explicit list of what's missing if anything failed. Minter allowances are
checked separately from roles because `OkuMoney.mint` gates on *both*
`onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, so a role grant
without an allowance still reverts at runtime. Only `LitePSM` holds
`OKUM_MINTER` and a minter allowance; `RedemptionQueue` holds `OKUM_BURNER` only,
and the verification step fails the deploy if the queue has either a minter
role or a non-zero allowance.

> A missing grant fails the run loudly rather than warning. The expected matrix
> is exported as `expectedRoleGrants()` in `scripts/deploy/index.ts` and asserted
> by `test/hardhat/drill/deployDrill.test.ts` against the same source of truth,
> so the test cannot drift from what the deploy actually grants. Each confirmed
> grant is appended to the tracked ledger
> [`scripts/config/roleGrants.json`](scripts/config/roleGrants.json) (live
> chains only), because the contracts are not `AccessControlEnumerable` and
> holders cannot be listed on-chain. The operational and mainnet role
> distribution is done by `scripts/operator/grantRoles.ts` /
> `grantRolesMainnet.ts`; see § Role Grants Policy.

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

Supported targets are the keys of `UPGRADE_TARGETS` in
`scripts/upgrade/index.ts` (one per upgradeable contract). Extend by adding a
row there and a state reader in `scripts/upgrade/preState.ts`. A target whose
locally compiled runtime bytecode (metadata-stripped) already matches the
on-chain implementation is skipped as a no-op.

Env vars:

| Var | Purpose |
|---|---|
| `TARGETS` | Comma-separated contract names to upgrade (required). |
| `NETWORK` | Override chain for live runs; auto-detected on a fork from the running node's chainId. |
| `PROXY_<Name>` | Per-target proxy address override; defaults to `addresses.json` lookup. |
| `SKIP_VERIFY` | Skip Etherscan verification of the new implementation. |
| `SKIP_BYTECODE_CHECK` | Upgrade even when the bytecode already matches the on-chain implementation. |
| `DRY_RUN` / `YES_MAINNET` | Simulate without broadcasting / required to broadcast on a mainnet network. |

Each contract's `initialize()` grants `DEFAULT_ADMIN_ROLE` and its
`*_UPGRADER` role to the `_admin` it is given, which the deploy script sets to
the deployer. A deployer-signed upgrade therefore needs no out-of-band role
grants unless that role was later moved (see § Role Grants Policy).

### npm scripts

| Script | Effect |
|---|---|
| `npm run compile` | `hardhat compile` (regenerates typechain) |
| `npm run typechain` | Typechain bindings only |
| `npm run test:forge` | Foundry suite (unit, fuzz, invariant, differential vectors) |
| `npm run test` | Full Hardhat suite (fork, off-chain scripts, simulation, drills) |
| `npm run test:unit` | Hardhat `unit/`, `simulation/`, and `drill/` directories only. Still needs a fork RPC (see § Quick Start) |
| `npm run test:all` | Both |
| `npm run node` | Start `hardhat node` (default forks Sepolia; override via `FORK_NETWORK`) |
| `npm run deploy:sepolia` / `:opSepolia` / `:baseSepolia` / `:arbSepolia` / `:bscTestnet` | Live deploy to the named testnet |
| `npm run deploy:base` / `:bsc` | Live deploy to the named mainnet |
| `npm run upgrade` | Upgrade proxies on a running localhost fork (auto-detects target chain) |
| `npm run upgrade:sepolia` / `:opSepolia` / `:baseSepolia` / `:arbSepolia` / `:bscTestnet` | Live upgrade on the named testnet |
| `npm run upgrade:base` / `:bsc` | Live upgrade on the named mainnet |
| `npm run test:onchain:*` | `scripts/test/test-onchain.ts` against the named live testnet |
| `npm run verify:<chain>` | Explorer verification of a deployed chain (`scripts/deploy/verify.ts`); aliases exist for the chains listed in `package.json` |
| `npm run operator:*` | One alias per operator script below (`package.json` lists them all) |
| `npm run test:gas` | Hardhat suite with the gas reporter on |
| `npm run typecheck` / `npm run export-abis` | `tsc --noEmit` / regenerate the ABI artifacts CI checks for drift |

> There are no `bridge:*` scripts: cross-chain transfers are PSM-mediated
> mint/burn coordinated off-chain.

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
| [`scripts/operator/psmOps.ts`](scripts/operator/psmOps.ts) | PSM mint/redeem, consolidated. `ACTION=<mintOkuM\|redeemOkuM\|mintUsdOku\|redeemUsdOku\|burn>` + `AMOUNT=<units>` (USDC 6-dec, OkuM/UsdOku 18-dec). `burn` burns the caller's own OkuM directly (needs `OKUM_BURNER`). A redeem queues automatically when the PSM buffer is short. |
| [`scripts/operator/vaultOps.ts`](scripts/operator/vaultOps.ts) | OkuDollar vault operations. `ACTION=<wrap\|unwrap\|deposit\|mint\|withdraw\|redeem\|rescueDonation>` + `AMOUNT`, optional `RECEIVER` / `OWNER` / `MIN_AMOUNT_OUT`. Covers both the price-aware `wrap`/`unwrap` pair and the ERC-4626 surface. |
| [`scripts/operator/depositBuffer.ts`](scripts/operator/depositBuffer.ts) / [`withdrawBuffer.ts`](scripts/operator/withdrawBuffer.ts) | PSM USDC buffer management. `AMOUNT=<6-dec USDC>`, plus `TO=0x...` for withdraw. Buffer depth determines whether redemptions settle instantly or queue. |
| [`scripts/operator/processQueue.ts`](scripts/operator/processQueue.ts) | Drain queued redemptions once the buffer is refunded. `BATCH_SIZE` (entries per call; default 50), `LIMIT` (maximum batches; default 1000). |
| [`scripts/operator/rescueQueueEntry.ts`](scripts/operator/rescueQueueEntry.ts) | Return a permanently-unprocessable queue entry's OkuM to an alternate recipient without burning. `INDEX` + `RECIPIENT`. Requires `QUEUE_RESCUER`. |
| [`scripts/operator/configureMinterAllowance.ts`](scripts/operator/configureMinterAllowance.ts) | Rotate a minter's allowance. `MINTER` (defaults to deployed LitePSM) + `ALLOWANCE`. Note `OkuMoney.mint` gates on **both** the `OKUM_MINTER` role *and* this allowance. |
| [`scripts/operator/setMaxSupply.ts`](scripts/operator/setMaxSupply.ts) | Raise/lower the supply cap. `MAX_SUPPLY=<18-dec>`. Requires `OKUM_CAP_MANAGER`. |
| [`scripts/operator/setOkuMMultiplier.ts`](scripts/operator/setOkuMMultiplier.ts) | **Emergency** multiplier override. `NEW_MULTIPLIER=<1e18-scaled>`. Collapses the rate schedule to halted and engages `OverrideBlockGuard` for the rest of the block — prefer `setOkuMYieldRate.ts` for normal operation. **Front-run risk beyond that block**: pause `psm` + `usdOku` (via `pause.ts`) before calling this, unpause after — see Accepted Risk #12. |
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
| [`scripts/operator/broadcastSchedule.ts`](scripts/operator/broadcastSchedule.ts) | **The orchestrator.** Reads one artifact and applies it to every participating chain — a subprocess of `applyScheduleSingleChain.ts` per EVM chain, plus SVM's own `set-yield-rate.ts --mode=atomic`. Records each chain's receipt back into the artifact, so a partial failure is resumed by re-running the same command. For the `roll-epoch` phase it writes the carry-ledger entry exactly **once**, after every chain confirms. Runs under `tsx`, not `hardhat run`. |
| [`scripts/operator/applyScheduleSingleChain.ts`](scripts/operator/applyScheduleSingleChain.ts) | Applies one artifact to whichever chain the Hardhat process is bound to. Split out because `resolveNetworkContext()` reads Hardhat's already-bound network runtime and cannot be redirected mid-process. Normally invoked by the broadcaster, not by hand. |
| [`scripts/config/epochChains.ts`](scripts/config/epochChains.ts) | Single source of truth for the participating chain set (`participatingChains()`), shared by the broadcaster and the V̄ sampler so the rate's denominator and its recipients can never diverge. Refuses any mainnet chain without an explicit `YES_MAINNET`. |
| [`scripts/config/epoch.ts`](scripts/config/epoch.ts) | The epoch grid itself (values live in the file): `EPOCH_LENGTH_SECONDS`, `EPOCH_ANCHOR_UNIX`, `EPOCH_GRID_TOLERANCE_SECONDS`. A backend constant — no contract reads it. |

### Operator scripts (yield)

| Script | Purpose |
|---|---|
| [`scripts/utils/yieldRate.ts`](scripts/utils/yieldRate.ts) | **Single source of truth** for APY ↔ per-second rate (a re-export of `packages/yield-tooling`, as are `epochDistribution.ts` and `epochSchedule.ts` below). Exports `apyToRatePerSecond`, `ratePerSecondToApy`, `realisedYieldToRatePerSecond`, `reconcileActualPayout`, `timeWeightedAverage`, `describeRate`, `describeCarry`, plus `PRECISION` / `MAX_RATE` / `SECONDS_PER_YEAR`. Every chain MUST receive a byte-identical integer; deriving from a declared APY removes the likeliest cross-chain mismatch (hand-entered 19-digit integers). `SECONDS_PER_YEAR` is **365 days exactly** — a protocol convention, not a calendar fact (SVM's Token-2022 `InterestBearingConfig` uses 365.24, one reason it is unsuitable for EVM parity). `realisedYieldToRatePerSecond` divides by a TIME-WEIGHTED AVERAGE global value across all chains, never a spot or local value — see [`docs/epoch-accounting.md`](docs/epoch-accounting.md) § "Two V's". |
| [`scripts/utils/epochDistribution.ts`](scripts/utils/epochDistribution.ts) | Base+settlement (B3) math: `distributedUsdOverWindow` (integrates dollars actually distributed from periodic value samples), `deriveSettlementRate` (closes the gap between target and measured-so-far, projecting the base window's own remaining tail). |
| [`scripts/utils/epochSchedule.ts`](scripts/utils/epochSchedule.ts) | Single entry point deriving the full `(rBase, baseEndSec, rSettle, settleEndSec)` tuple so every chain computes byte-identical values. `deriveBaseRate` / `deriveSettlementRateForEpoch` / `floatRateToBigint` / `toOnChainSchedule`. |
| [`scripts/utils/globalValue.ts`](scripts/utils/globalValue.ts) + [`scripts/operator/sampleGlobalValue.ts`](scripts/operator/sampleGlobalValue.ts) | Cross-chain `totalSupply() * okuMMultiplier()` sampler + local JSON store (a reference implementation, not a shared store). `valueAt` (interpolation), `samplesInWindow`, `cumulativeDistributedUsd`. |
| [`scripts/utils/carryLedger.ts`](scripts/utils/carryLedger.ts) | Append-only local JSON ledger (a reference implementation) of every epoch's rate derivation; `summarizeLedger()` computes the cumulative-conservation identity, read (diagnostic-only) by `checkMultiplierDrift.ts`. |
| [`scripts/operator/setOkuMYieldRate.ts`](scripts/operator/setOkuMYieldRate.ts) | Sets the streaming rate. Prefers `APY=<fraction>` (raw `RATE=` supported for corrections but warned against). `WITH_SUCCESSOR=true` (+ `NEXT_APY`, `PENDING_END_TIMESTAMP`) uses the atomic `setOkuMYieldRateWithSuccessor` — the **preferred** path, and what the epoch pipeline uses, because re-anchoring and staging in two transactions can leave no successor armed. `STAGE=true PENDING_END_TIMESTAMP=<unix>` calls `setNextOkuMYieldRate(rate, pendingEndTimestamp)` to pre-stage only; the successor activates with no transaction at the boundary. The default path calls `setOkuMYieldRate(rate, endTimestamp)` and requires a future `END_TIMESTAMP` for any yielding rate. Supports `DRY_RUN=true`; `YES_MAINNET=true` required to broadcast on mainnet. |
| [`scripts/operator/checkMultiplierDrift.ts`](scripts/operator/checkMultiplierDrift.ts) | Read-only cross-chain drift monitor. Compares `okuMMultiplier()`, rate, `rateEnd`, and pending rate across chains; exits non-zero on any mismatch. `CHAINS`, `TOLERANCE_BPS` (default 1), `EXPIRY_WARN_HOURS` (default 4 — must stay well under one epoch length or it fires on every chain on every run), and `EPOCH_ANCHOR_UNIX` / `EPOCH_LENGTH_SECONDS` / `EPOCH_GRID_TOLERANCE_SECONDS` overrides for epoch-grid alignment checking (defaults come from the committed grid, so the check is ON by default). An EXPIRED rate window is a hard failure (not a warning) — under a fixed-epoch model this is a recurring, scheduled deadline, not an edge case. Also reports the carry ledger's cumulative-conservation summary. |

For chains without a matching alias in `package.json` (e.g. `mainnet`,
`optimism`, `arbitrum`):

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
    Constants.sol           # Shared compile-time constants + terminology legend
    Errors.sol              # Error types shared by more than one contract
    MathLib.sol             # computeMultiplier / compoundFor / rpow + conversion helpers
    ReentrancyGuardUpgradeable.sol  # OZ-5.x-compatible upgradeable reentrancy guard
                            # (OZ dropped the upgradeable variant in v5)
    OverrideBlockGuard.sol  # Shared whenNoOverrideThisBlock modifier (OkuDollar + LitePSM);
                            # guards the DISCRETE emergency override only
    events/                 # One event-declaration file per contract (OkuMoney, OkuDollar,
                            # LitePSM, RedemptionQueue)

test/
  mocks/                    # Test-only mocks and harnesses. Compiled by Hardhat (see
                            # hardhat.config.ts) but outside `src/`, so never in production
                            # artifacts. MockUSDC.sol (6-decimal ERC-20) is also what the
                            # deploy script deploys as testnet collateral.
```

> **There is no bridge code in `src/`.** `Roles.sol` defines only the
> OkuMoney / vault / PSM / queue roles listed in § Role Grants Policy. v1
> cross-chain transfers are PSM-mediated mint/burn orchestrated off-chain; see
> [`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated)
> and Accepted Risk #7. A future on-chain bridge would be **additive**: deploy
> the new proxy, grant it `OKUM_MINTER`, and configure its minter allowance,
> with no modification to `OkuMoney` / `OkuDollar` / `LitePSM` /
> `RedemptionQueue`. Its interfaces and role constants would be written fresh.

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
stored value on both `LitePSM` and `RedemptionQueue`
(`10 ** (18 - usdcDecimals)`, computed at `initialize` from the configured
collateral token) — `1e12` for 6-decimal USDC, `1` for 18-decimal collateral.

**Shares — terminology hazard.** `usdShares` is OkuDollar's *internal*,
non-rebasing accounting unit, numerically identical to the raw OkuM
deposited. ERC-4626 "shares" means the *rebasing displayed balance*
(`balanceOf`, dollar-denominated). **These are different quantities** and
`convertToShares` returns the latter.

**Key formulas**
```
multiplier:              m(t)         = base × rpow(rate, t − anchor, PRECISION) / PRECISION
USDC → OkuMoney:         okuMAmount   = (usdcAmount × decimalMultiplier) × PRECISION / m
OkuMoney → USDC:         usdcAmount   = (okuMAmount × m / PRECISION) / decimalMultiplier
OkuMoney → usdOku share: shares       = okuMAmount × m / m          (= okuMAmount)
usdOku → OkuMoney:       okuMAmount   = usdAmount × PRECISION / m
```

(`decimalMultiplier` is `usdcDecimalMultiplier`, above.) The third formula collapsing to the identity is the algebraic consequence of
the single-multiplier design, and is why collateralization is exactly 1.0.

---

## Hardcoded Constants

The compile-time constants live in [`src/lib/Constants.sol`](src/lib/Constants.sol),
each with its bound and its SVM-parity obligation in NatSpec. The full set is
not reproduced here — a second copy of the values is a second thing to go
stale.

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
- **`MIN_REDEMPTION_OKUM` is a fixed constant, not a parameter.** It is the
  absolute dust floor on a redemption, needed because `usdcDecimalMultiplier`
  collapses to 1 (no floor) at 18-decimal collateral; as a constant it needs no
  admin lever and no storage on the UUPS proxies. See `LitePSM.sol` NatSpec.

The constants mirrored on both stacks must agree or the differential harness diverges; the
SVM mirror is `SVM/oku-programs/crates/oku-shared/src/constants.rs`.

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
  minimum ratio to configure. There is no `depositReserves` / `withdrawSurplus` /
  `minCollateralRatio` machinery and no vault rebaser, reserve-manager, or
  admin role: `OkuDollar`'s only asset-touching role is `VAULT_RESCUER`.
- The vault is **structurally immune to the ERC-4626 inflation/donation attack**,
  because conversions use `m` rather than `totalAssets/totalSupply`. The corollary
  is that donated OkuM accrues to nobody — see `rescueDonation`.

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20; the multiplier
appreciates, balances do not). OkuDollar is **rebasing** ($1-pegged; `balanceOf`
grows with `m` every second, with no transaction).

### Complexity, honestly

The single-multiplier design is a real state-space reduction — one rate
schedule instead of two, collateralization an invariant instead of a monitored
parameter, a compact packed rate-schedule struct — but it is **not a net
code-size simplification** relative to a two-rate design, because this tree
also carries ERC-4626 and ERC-8056 conformance plus the
mandatory-bounded-window machinery that streaming accrual and the
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
    OkuMoneyStorage storage $ = _getOkuMoneyStorage();
    return MathLib.computeMultiplier(
        $.okuMBaseMultiplier,
        $.okuMRatePerSecond,
        $.okuMLastAccrualTime,
        $.okuMRateEnd,
        $.okuMPendingRatePerSecond,
        $.okuMPendingRateEnd,
        block.timestamp
    );
}
```

`computeMultiplier` is a MakerDAO `chi`/DSR-style `rpow` accumulator: it compounds
the active rate from the anchor, rolls over to the pending rate at `okuMRateEnd`,
bounds that pending rate's own overhang at `okuMPendingRateEnd` (so an unattended
successor halts rather than compounding forever), and clamps at `MAX_MULTIPLIER`.
`rpow` is MakerDAO's `pot.sol` assembly (half-up rounding). Branch-by-branch
detail: `MathLib.sol` NatSpec.

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
alongside a permissionless PSM. `setOkuMMultiplier` is only the
**emergency override**; it is not how yield is paid. The reasoning:

**The vector.** `LitePSM.mintOkuM` / `redeemOkuM` charge **no fee** (the PSM has
no `tin`/`tout`-style parameter) and have **no cooldown** — a round-trip is
instant whenever the USDC buffer covers it. `OverrideBlockGuard` blocks only the
**single block** in which a discrete multiplier write lands. At 5% APY paid
monthly (a 0.407% jump per tick), depositing immediately before the tick and
withdrawing immediately after captures the whole month's yield for ~24 seconds
of capital exposure:

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
| Redemption fee (a `tout`-style parameter) | Must exceed the largest tick (~0.41%/mo) to close the vector — taxes every honest exit forever; moves the cliff, doesn't remove it |
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
7-argument, 3-branch function versus a single stored value; every chain needs a
live re-arm cadence rather than set-and-forget; and it adds code relative to a
discrete tick (see § Complexity, honestly, above).

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
`okuMMultiplier` slot** — the packed schedule fields replace it — and every
runtime-variable downcast at write time goes through `SafeCast`, so a value
outside a field's range reverts rather than silently truncating.

### Multiplier Model

`okuMMultiplier()` is a **computed view**, not a stored value.

| Function | Role | Effect |
|---|---|---|
| `setOkuMYieldRate(newRate, endTimestamp)` | `OKUM_REBASER` | Snapshots the current multiplier into `okuMBaseMultiplier`, resets `okuMLastAccrualTime` to now, sets the active rate + window, and **clears any armed pending rate**. Continuous across the write — no step, so it does NOT stamp `lastYieldDistributionBlock`. `endTimestamp` must be 0 when `newRate == PRECISION` (halting) and strictly future otherwise (within `MAX_RATE_WINDOW`) — every yielding rate carries a bounded window. Pause-gated for INCREASES only (`newRate > current` reverts while paused); decreases (including zeroing) remain available for incident response. |
| `setNextOkuMYieldRate(newRate, pendingEndTimestamp)` | `OKUM_REBASER` | Pre-stages the successor. Activates off the absolute `okuMRateEnd` with **no transaction at the boundary**. Requires a bounded active window (`NoRateEndSet` if `okuMRateEnd == 0`) that has not elapsed (`RateAlreadyExpired`), and `pendingEndTimestamp` strictly after `okuMRateEnd` (successor window also within `MAX_RATE_WINDOW`) — bounding how long the successor can compound unattended. Pause-gated for increases only, like `setOkuMYieldRate`. |
| `setOkuMYieldRateWithSuccessor(newRate, endTimestamp, nextRate, nextEndTimestamp)` | `OKUM_REBASER` | Atomically composes `setOkuMYieldRate` then `setNextOkuMYieldRate` in ONE transaction — every check/event/pause-gate of both applies unchanged, in order. Exists to close the atomicity gap of calling them separately under the base+settlement epoch model (see [`docs/epoch-accounting.md`](docs/epoch-accounting.md)), where doing so twice per epoch, forever, otherwise risks landing the first call with the second failing/delayed — leaving NO successor staged and accrual silently halting at `endTimestamp`. |
| `setOkuMMultiplier(newMultiplier)` | `OKUM_REBASER` | **Emergency discrete override.** Writes `okuMBaseMultiplier = newMultiplier`, resets `okuMLastAccrualTime` to now, and collapses the rate schedule to halted (`okuMRatePerSecond`/`okuMPendingRatePerSecond` = `PRECISION`, `okuMRateEnd`/`okuMPendingRateEnd` = 0) — an operator must re-arm via `setOkuMYieldRate`. Enforces `newMultiplier > current` and `<= MAX_MULTIPLIER`. Pause-gated. Stamps `lastYieldDistributionBlock`. |

`setOkuMMultiplier` is the **sole remaining reason** `lastYieldDistributionBlock`
and `OverrideBlockGuard` / `whenNoOverrideThisBlock` still exist.

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
`supportsInterface()`. Their literal hex IDs are pinned in `test/token/OkuMoney.t.sol`
against the compiler-computed `type(I).interfaceId`, because
`supportsInterface(type(I).interfaceId)` alone is self-referential and cannot
detect the *draft* moving its reference signatures underneath us.

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
exactly one multiplier, read from exactly one place, by both surfaces. The
OkuMoney-vs-OkuDollar conversion equivalence is tested directly in
`test/token/OkuDollar.t.sol`, so a change that reads the multiplier through a
different path on one side cannot silently diverge the two.

### Key Implementation Notes

- `balanceOf()` is a standard ERC-20 raw token count. `okuMMultiplier()` is a
  computed view used for *pricing* by the PSM and vault — it never touches
  `balanceOf`. Minting 100 tokens at `okuMMultiplier = 1.05` creates $105.
- **OkuMoney emits no `TransferValue` event.** Under streaming accrual the
  dollar value would require an `rpow` on every transfer, and the event would
  duplicate ERC-20 `Transfer` exactly. Indexers derive dollar value off-chain
  from the rate schedule. OkuDollar's `TransferValue` is distinct: it carries
  *shares*, a quantity `Transfer` does not expose.

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

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `OverrideBlockGuard`, `UUPSUpgradeable`.

**Concept**: Rebasing $1-pegged stablecoin wrapping OkuMoney. **Single multiplier** — `usdMultiplier()` returns exactly `okuMoney.okuMMultiplier()`; the vault holds no rate state of its own. Implements the IERC4626 surface with **rebasing** shares (see below); does not inherit OZ's `ERC4626Upgradeable`.

### Storage (ERC-7201 Namespaced)

`struct OkuDollarStorage` in [`src/token/OkuDollar.sol`](src/token/OkuDollar.sol).

**OkuDollar has no yield-rate or reserve-management surface.** Accrual lives
solely on OkuMoney, and collateralization is exactly 1.0 by construction, so
there is no ratio to configure or surplus to extract.

**Blacklist.** OkuDollar keeps its own blacklist (managed with the shared
`OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER` roles) **and honours OkuMoney's**:
`isBlacklisted(account)` is true if either list contains the account. The
combined check applies to `transfer`, `transferFrom` (including the spender),
`wrap`, `unwrap`, `approve`, `permit`, the ERC-4626 withdraw/redeem paths and
the `max*` views. `scripts/operator/blacklistBoth.ts` remains a convenience for
listing an address on both tokens.

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
  vault. It is one of a small, enumerated set of `Ceil` sites — see
  [`src/lib/MathLib.sol`](src/lib/MathLib.sol)'s rounding-policy header.
- **`InsufficientBalance` and `InsufficientReserves` are intentionally
  distinct** — the first is a user balance check, the second a vault reserves
  check. Collapsing them would hide which side is actually short.

Both are `public` rather than `external` so the ERC-4626 entry points can call
them internally, and both carry `whenNoOverrideThisBlock` + `whenNotPaused` +
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
- LitePSM: `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`, `withdrawUsdc`, `processQueue` (and the `processQueue_` leg of `depositBuffer`). `LitePSM.processQueue` also reverts `OkuMoneyPaused` while OkuMoney is paused.
- Not gated: `RedemptionQueue.cancelQueueEntry` and `rescueQueueEntry` (they return OkuM only; OkuMoney's own pause/blacklist rules still apply), and a plain `depositBuffer`.

**`setOkuMYieldRate` and `setNextOkuMYieldRate` are decrease-only while paused**:
both compare the new rate against `okuMEffectiveRatePerSecond()` (not raw
storage) and revert `EnforcedPause` on any increase, so operators can still zero
or lower the rate during an incident but cannot stage or activate a higher rate
while users cannot exit. The discrete `setOkuMMultiplier` override is fully
pause-gated (any change). See the NatSpec in `OkuMoney.sol`.

### Events

Declared in [`src/lib/events/OkuDollarEvents.sol`](src/lib/events/OkuDollarEvents.sol):
`TransferValue(from, to, shares, dollarValue)`,
`Wrapped(user, receiver, okuMAmount, usdMinted, okuMMultiplier, usdMultiplier)`,
`Unwrapped(user, receiver, usdAmount, okuMReturned, okuMMultiplier, usdMultiplier)`,
`DonationRescued(receiver, okuMAmount)`, `Blacklisted(account)`,
`Unblacklisted(account)`. ERC-4626 `Deposit` / `Withdraw` come from the inherited
`IERC4626`.

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
collateral's own `decimals()` at init (any collateral with at most 18 decimals).
At `okuMMultiplier = $1.05`, depositing 100 USDC gives ~95.24 OkuM; redeeming
95.24 OkuM returns ~100 USDC.

Redemptions below `max(decimalMultiplier, MIN_REDEMPTION_OKUM)` revert
`BelowMinimumRedemption` (anti-dust for queue entries; at 18-decimal collateral
`decimalMultiplier` collapses to 1, so the constant floor applies). This is a
size floor, not a price check.

**No slippage / min-out parameter on any of the four PSM entry points
(`mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`) — deliberately.** The
multiplier is monotonically non-decreasing (`InvalidRate`,
`MultiplierCannotDecrease`) and the PSM charges no fee, so a delayed, reordered
or front-run redemption pays the caller *more*, never less, and a mint preserves
dollar value; a min-out would have nothing to bound. The precondition is **no PSM
fee**: if a fee is ever introduced, min-out parameters must land in the same
change. SVM's `redeem_oku_m` takes `min_usdc_out` only as client-side
defence-in-depth (Solana has no view functions). See the `redeemOkuM` NatSpec in
[`src/psm/LitePSM.sol`](src/psm/LitePSM.sol); tests in `test/psm/LitePSM.t.sol`.

### Convenience Functions (usdOku ↔ USDC via Vault)

```solidity
function mintUsdOku(uint256 usdcAmount) external;                          // USDC → mint OkuM → wrap → usdOku to user
function redeemUsdOku(uint256 usdAmount) external returns (uint256 usdcOut); // usdOku → unwrap → redeem → USDC to user
```

**Instant vs. queued.** An instant redemption is paid only from USDC *above*
`totalQueuedUsdc()` (the queue's reserve), so the public cannot overtake queued
claims; otherwise the OkuM goes to the [RedemptionQueue](#redemptionqueuesol)
and the call returns `0`. `redeemOkuM` and `redeemUsdOku` return the USDC paid
immediately; `0` means queued — a successful call, not a failure. The backend
can process any queue range via `processQueue` (see below).

`redeemUsdOku` has a second, distinct failure mode: vault reserves below
`okuMReturned` make `unwrap` revert `InsufficientReserves`, reverting the whole
transaction.

**Blacklist.** OkuMoney-blacklisted users cannot `mintUsdOku`, redeem (instant
or queued) or be enqueued: `mintUsdOku` and the redeem paths revert
`UserBlacklisted` (the UsdOku paths move OkuM through the PSM, so OkuMoney's own
check never sees the user), and `mintOkuM` is caught by `OkuMoney.mint`.

`_redeemUsdOku` passes the **post-transfer balance delta** to `unwrap` rather than
the caller-supplied `usdAmount`, because `OkuDollar.transferFrom` floors the share
conversion while `unwrap` ceils the share burn; see the NatSpec.

Every user-facing PSM function carries `whenNoOverrideThisBlock` + `whenNotPaused`.

### Admin / Operator Surface

- `depositBuffer(amount, processQueue_, start, end, approveAmount)`
  (`PSM_BUFFER_DEPOSITOR`): a plain deposit is ungated by pause and the override
  guard. With `processQueue_` it also requires `PSM_QUEUE_PROCESSOR` and obeys PSM
  pause and the same-block override guard.
- `withdrawUsdc(to, amount)` (`PSM_BUFFER_WITHDRAWER`): `whenNotPaused` and
  `whenNoOverrideThisBlock`; reverts `WouldStrandQueue` if the remaining balance
  would fall below `totalQueuedUsdc()`.
- `processQueue(start, end, approveAmount)` (`PSM_QUEUE_PROCESSOR`): `whenNotPaused`
  and `whenNoOverrideThisBlock`; also reverts `OkuMoneyPaused` while OkuMoney is
  paused (`OkuMoney.burn` is not pause-gated). `start > queueHead` skips a stuck
  head. Emits `QueueProcessed`.
- `pause` / `unpause` (`PSM_PAUSER` / `PSM_UNPAUSER`).

### Events

Declared in [`src/lib/events/LitePSMEvents.sol`](src/lib/events/LitePSMEvents.sol):
`OkuMMinted`, `OkuMRedeemed`, `UsdOkuMinted`, `UsdOkuRedeemed`,
`QueueProcessed(newBufferBalance, processedStart, processedEnd)`,
`BufferDeposited(depositor, amount, newBufferBalance)`,
`BufferWithdrawn(to, amount, newBufferBalance)`.

One non-obvious shape: `redeemUsdOku` emits **only** `UsdOkuRedeemed` (no inner
`OkuMRedeemed`), and a queued redemption emits `RedemptionQueued` (from the queue)
instead of `OkuMRedeemed`. The return value is the simpler paid-vs-queued signal.

---

## RedemptionQueue.sol

FIFO queue for redemptions the PSM buffer cannot pay instantly. Entries store raw
OkuM amounts (OkuM is non-rebasing); they appreciate in dollar value through
`okuMMultiplier()`, which `processQueue` reads once per batch to pay
`okuMAmount × okuMMultiplier() / PRECISION` in collateral decimals. A
`QueueEntry` is two storage slots (`address user` + `uint96 timestamp`;
`uint256 okuMAmount`).

**Roles.** The queue holds `OKUM_BURNER` only — no `OKUM_MINTER`, no minter
allowance. `QUEUE_PSM` is held only by the `LitePSM` proxy; `QUEUE_RESCUER` and
`QUEUE_UPGRADER` are operator roles. Pause lives at the PSM layer (the queue has
no pause state of its own).

**Functions** (full semantics in the [`RedemptionQueue.sol`](src/psm/RedemptionQueue.sol) NatSpec):
- `enqueue(user, amount)` (`QUEUE_PSM`): record-only (the PSM transfers the OkuM
  first); reverts `UserBlacklisted` for an OkuM-blacklisted user.
- `processQueue(start, end)` (`QUEUE_PSM`, reached via `LitePSM.processQueue`):
  burns OkuM and pays USDC pulled from the PSM. Bad entries are soft-skipped with
  `RedemptionSkipped(index, reason)`; a skipped entry is not a failed batch.
- `cancelQueueEntry(index)`: permissionless self-cancel returning OkuM only to
  `entry.user`; not PSM-pause-gated, OkuMoney's own pause/blacklist rules apply.
  The backend cancels on a user's behalf with `rescueQueueEntry(index, entry.user)`.
- `rescueQueueEntry(index, recipient)` (`QUEUE_RESCUER`): returns the OkuM of an
  entry stuck on a USDC-side failure (`TransferFailed`, e.g. Circle-blacklisted
  recipient) and serves backend cancellation. Not PSM-pause-gated.
- `releaseFrozenEntry(index, recipient)` (`QUEUE_RESCUER`): resolves a frozen entry.
- `rescueExcessOkuM(to)` (`QUEUE_RESCUER`): sweeps only OkuM above live plus frozen
  escrow (`totalQueuedOkuM + totalFrozenOkuM`).
- `advanceHead(maxSlots)`: permissionless, gas-bounded head maintenance; `processQueue`
  and `rescueQueueEntry` do not advance `queueHead`, `queueLength()` is an upper
  bound until it runs, and redemption correctness does not depend on the cursor.

**Queue rules.**
- *Reserve:* instant redemption is paid only from USDC above `totalQueuedUsdc()`, so
  the public cannot overtake queued claims. The backend can process any range via
  `LitePSM.processQueue(start, end, approveAmount)`; `start > queueHead` skips a
  stuck head.
- *Blacklist:* OkuMoney-blacklisted users cannot mint UsdOku, redeem (instant or
  queued) or enqueue. A user blacklisted **while queued** is **frozen** by
  `processQueue`: not paid, not burned, moved out of the live queue and out of
  `totalQueuedOkuM` into a frozen record keyed by original index
  (`totalFrozenOkuM`). `QUEUE_RESCUER` resolves it with `releaseFrozenEntry`.
- *Stuck on USDC:* an entry that keeps failing the USDC transfer keeps counting
  toward `totalQueuedUsdc()` (the reserve) until rescued — deliberate.
- *Redirect power:* `rescueQueueEntry` and `releaseFrozenEntry` do not constrain
  `recipient` (necessarily, so a blacklisted user's entry is still resolvable), so
  `QUEUE_RESCUER` can redirect any queued user's OkuM. Accepted; see
  `AUTHORITY-MATRIX.md` E24/E29 and the `rescueQueueEntry` NatSpec for why the
  argument depends on how the role is granted.
- *Dust floor:* the PSM's `MIN_REDEMPTION_OKUM` floor applies to every queued
  amount, including 18-decimal collateral (see the LitePSM section).

### Events

Declared in [`src/lib/events/RedemptionQueueEvents.sol`](src/lib/events/RedemptionQueueEvents.sol):
`RedemptionQueued`, `RedemptionProcessed`, `RedemptionSkipped(index, reason)`,
`RedemptionRescued`, `RedemptionFrozen(index, user, okuMAmount)`,
`FrozenRedemptionReleased(index, originalUser, recipient, okuMAmount)`,
`RedemptionCancelled(index, user, okuMAmount)`,
`ExcessOkuMRescued(to, amount)`, `QueueHeadAdvanced(newHead, slotsAdvanced)`.
The skip `reason` is one of `AlreadyCleared`, `InsufficientFunds`,
`TransferFailed`, `Blacklisted`.

---

## Cross-Chain Transfers (v1: PSM-Mediated)

The full cross-chain model — including the SVM legs, the conservation
invariants, and the orchestrator's pre-flight/recovery runbook — is
documented once, in
[`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated).
EVM-side facts that belong here:

```
chain A                                              chain B
user calls LitePSM.redeemOkuM(n) ─► orchestrator ─► LitePSM.mintOkuM (USDC custody)
                                                   ─► OkuM credited to user on B
```

- LitePSM is the only `OKUM_MINTER` holder on every chain and the sole user-facing
  mint/burn surface (`RedemptionQueue` holds `OKUM_BURNER` only).
- `mintOkuM` is **permissionless**; the orchestrator's only privilege on this
  path is its own USDC custody.
- The orchestrator custodies USDC and rebalances PSM buffers operationally.
- No on-chain signature verification, EIP-712 BridgeRequest, or refund flow in v1.
- No bridge scaffolding remains in `src/` — see the note under
  § Contract Structure.

---

## OverrideBlockGuard

Shared abstract at [`src/lib/OverrideBlockGuard.sol`](src/lib/OverrideBlockGuard.sol),
inherited by both `OkuDollar` and `LitePSM`. Exposes the
`whenNoOverrideThisBlock` modifier and the `OverrideInProgress` error.

Continuous accrual has no discrete step to sandwich, so the guard protects
**only** the emergency override `setOkuMMultiplier`, which alone stamps
`lastYieldDistributionBlock`. In that block, every guarded PSM/vault operation
(mint/redeem, wrap/unwrap, `processQueue`, `withdrawUsdc`) reverts
`OverrideInProgress`; token transfers are unaffected. See the
[`OverrideBlockGuard.sol`](src/lib/OverrideBlockGuard.sol) NatSpec.

> **Forward-only, not a full sandwich guard.** It does not stop a mint one block
> *before* the override paired with a redeem one block *after*. See
> [Accepted Risks](#accepted-risks), "discrete-tick MEV", for the analysis and the
> operational mitigation (pause the PSM/vault around the override).


---

## Role Grants Policy

Every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, rescuers, etc.) to other parties (multisigs, bots) post-deployment via `grantRoles.ts` or `grantRolesMainnet.ts`. This removes contract-specific role plumbing from deployment scripts.

`grantRoles.ts` and `grantRolesMainnet.ts` are NOT interchangeable — they implement different threat models for different environments:

| | `grantRoles.ts` | `grantRolesMainnet.ts` |
|---|---|---|
| Target | `MASTER_EOA` (single testnet operator key) | Cold Multisig / Warm Multisig / Orchestrator (3-key topology, from `MAINNET_COLD_MULTISIG` / `MAINNET_WARM_MULTISIG` / `MAINNET_ORCHESTRATOR` env vars) |
| Grants | The operational (non-admin, non-upgrader) roles in its `ROLE_MAP`, including `OKUM_MINTER` / `OKUM_BURNER` / `OKUM_ALLOWANCE_MANAGER` / `OKUM_CAP_MANAGER`, plus a `configureMinterAllowance` call so the mint grant is usable | The production RBAC split in its `buildRoleMap` (see [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md)) |
| `DEFAULT_ADMIN_ROLE` / `*_UPGRADER` | Never granted — stays on the deployer | Cold Multisig only; deployer's admin is revoked as the script's final step |
| Runs on mainnet? | **Refuses unconditionally** — see its NatSpec header | Yes (its purpose) |

`grantRoles.ts` including `OKUM_MINTER`/`OKUM_BURNER` on an EOA is a **deliberate testnet-only divergence** from the production model (below), where no EOA holds them — it exists to give a testnet operator SVM-equivalent direct-mint/burn parity (SVM has no redemption queue and must mint/burn directly; EVM's production bridge legs are USDC-collateral-mediated and don't need it). That is why the script hard-refuses to broadcast on any mainnet network rather than offering an opt-in override.

One intentional exception:
- `RedemptionQueue.QUEUE_PSM` is NOT granted at init — it is granted post-deploy to the `LitePSM` proxy address. This avoids a circular deployment dependency AND keeps admin from being able to call `enqueue` / `processQueue` directly (bypassing the PSM).

**Vault roles** (`src/lib/Roles.sol`) are `VAULT_UPGRADER`, `VAULT_PAUSER`,
`VAULT_UNPAUSER`, and `VAULT_RESCUER` (sole holder of `rescueDonation`). There
is deliberately no vault rebaser (OkuDollar has no rate of its own — accrual is
set on OkuMoney via `OKUM_REBASER`) and no reserve-manager or vault-admin role
(collateralization is 1.0 by construction, so there is nothing to manage).

### Per-role trust and blast radius

**Canonical: [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md).** It lists every
role-gated path with its guard, blast radius and reversibility, verified
against the source rather than transcribed from docs. It is not duplicated here.

Two EVM-specific points that belong with the contracts rather than the matrix:

- **`OKUM_MINTER` is never held by an EOA in the production model.** Only
  `LitePSM` holds it; `RedemptionQueue` holds `OKUM_BURNER` only (no minter role,
  no allowance). `grantRoles.ts` deliberately breaks this on testnet, which is why
  that script refuses to broadcast on any mainnet network.
- **A role grant alone does not enable minting.** `OkuMoney.mint` gates on
  *both* `onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, which
  `initialize` populates for nobody. A grant without a matching
  `configureMinterAllowance` call still reverts `ExceedsAllowance`.

---

## Key Invariants

Maintained by the contracts and exercised by the invariant suites in `test/invariants/` (plus the fuzz suites under `test/token/` and `test/psm/`):

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
path that touches reserves directly).

**Minter allowance**
```
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                            // Burns don't restore allowance
```

**PSM**
```
okuMoney.balanceOf(litePsm) <= 1 wei                            // No stale OkuM held between calls
okuMoney.balanceOf(queue) == totalQueuedOkuM + totalFrozenOkuM  // Queue backed exactly by live + frozen escrow
                             (+ unswept direct donations)       //   (excess is swept only via rescueExcessOkuM)
totalQueuedOkuM == sum of live entries in [queueHead, queueTail)
psmUsdcBalance == seed + inflows - outflows                     // USDC accounting is exact, no tolerance
```
A blacklisted user is never paid USDC, and no USDC leaves a paused PSM through a
payout path.

---

## Accepted Risks

Known issues and design choices explicitly accepted by the protocol team, so a
reviewer does not re-cover them as new findings. Mechanisms are documented in
the contract NatSpec and the sections above; entries here state the risk, who
bears it, and the mitigation.

### 1. Centralized operator model — no on-chain timelock

OkuMoney v1 ships as a centralized financial product, modelled on similar
yield-bearing stablecoins (Ondo Finance, Circle USDC). No `TimelockController`
sits between the operator multisig and any contract; the cold-multisig quorum is
itself the delay mechanism. The reasoning and per-tier capability model are in
[`../README.md` § Signer trust implications](../README.md#signer-trust-implications);
per-role blast radius is in
[`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md) and § Per-role trust and blast
radius above.

On-chain bounds on a single-call compromise: ceilings `MAX_MULTIPLIER = 1e24`
and `MAX_RATE = PRECISION + 1e11`; monotonic guards (`MultiplierCannotDecrease`,
`InvalidRate`, `RateAlreadyExpired`); and `whenNoOverrideThisBlock` around the
emergency override (§ OverrideBlockGuard). Because OkuDollar delegates its
multiplier, `OKUM_REBASER` governs **both** tokens' yield from one grant.

**Operational expectation:** every operational role rotates to a multisig before
mainnet launch.

### 2. Vault reserve-extraction opsec — STRUCTURALLY IMPOSSIBLE

A vault with an independent rate plus a surplus-withdrawal path would admit a
rate-then-withdraw extraction that needs off-chain key separation. **No such
surface exists here.** Collateralization is exactly 1.0 by construction:
`usdMultiplier()` is `okuMoney.okuMMultiplier()` and shares are only minted or
burned 1:1 against real OkuM at the same `m`, so there is no surplus to extract
and no ratio to inflate (no vault rebaser, reserve-manager or admin role exists).

The nearest surviving surface is `VAULT_RESCUER.rescueDonation`, bounded below
by `totalUsdShares`, so it cannot reach share backing (modulo the 1-wei caveat
in 11c).

### 3. USDC peg monitoring — off-chain (no on-chain oracle)

EVM and SVM both monitor the USDC peg entirely off-chain. There is no on-chain
oracle, aggregator or circuit-breaker and no storage reserved for one. The
off-chain orchestrator watches the peg and pauses the PSM on a detected depeg.

### 4. 1-wei share dust in `OkuDollar.transfer`/`transferFrom` under inflated `usdMultiplier`, and the zero-share boundary now reverts

`OkuDollar` accounts in shares behind a dollar-denominated ERC-20 interface, and
`transfer`/`transferFrom(amount)` floor the share conversion. When
`usdMultiplier > 1e18`, repeated calls against a single permit allowance may
under-consume ~1 share per call. The drift always favours the holder, never the
protocol; it is documented on the `OkuDollar.permit` NatSpec, and integrators
batching against one allowance should budget for it.

`Transfer.value` does **not** satisfy `Σ Transfer.value == Δ balanceOf`:
`balanceOf` floors per account, so no single emitted value can report both
sides. Integrators must read `balanceOf()`, not event values (see the
`OkuDollar.transfer` NatSpec for the worked counterexample).

A nonzero `amount` whose share conversion floors to zero reverts
`AmountTooSmall` in both `transfer` and `transferFrom`; `amount == 0` remains
the EIP-20 no-op. Tests: `test/token/OkuDollar.t.sol`.

### 5. `OkuDollar._update` ERC-20 tripwires

`OkuDollar` overrides `transfer`/`transferFrom` for share-based accounting,
bypassing the inherited `ERC20Upgradeable._update`. The `_update` override
unconditionally reverts (with `UseWrapInstead` / `UseUnwrapInstead` for
mint/burn) so all supply changes go through `wrap()` / `unwrap()`. These are
forward-compat sentinels: the inherited `_mint`/`_burn` are not called anywhere
today, and the reverts exist only to catch a future upgrade that routes through
`_update` by mistake.

### 6. `RedemptionQueue.advanceHead` is permissionless

Anyone may call the gas-bounded cursor-advance. It has no privileged effect:
`queueHead` only moves forward, only past slots already cleared
(`user == address(0)`) between transactions, and the visible effect is
`queueLength()` accuracy. A role-gated version would add no security and
complicate the runbook.

`advanceHead` carries `nonReentrant` (shared with `processQueue` and
`rescueQueueEntry`) because `processQueue` transiently clears a live slot across
its external transfer; a reentrant `advanceHead` from a callback collateral
token could otherwise strand the entry below `queueHead`. Likewise
`processQueue` re-validates its cached `usdcAvailable` live once before halting
a batch, so a callback top-up cannot cause a premature stop. Both are defence in
depth for a non-Circle collateral token: Circle USDC has no transfer callback,
and the collateral token is a deploy parameter the contracts cannot verify
(`initialize` checks only `decimals() <= 18`). See the `advanceHead` and
`processQueue` NatSpec, `test/psm/Reentrancy.t.sol` and
`test/psm/ProcessQueueCallbackTopUp.t.sol`. Queue ordering, reserve, freeze and
rescue behaviour are documented once in § RedemptionQueue.sol.

### 7. No on-chain bridge

There is no on-chain bridge contract, adapter, interface or role constant in
`src/`. Cross-chain transfers are orchestrator-mediated PSM mint/redeem, so
replay protection, refunds and rate-limiting are off-chain responsibilities. See
§ Cross-Chain Transfers.

### 8. Negative yield is inexpressible

The multiplier is **monotonic**: `setOkuMYieldRate` rejects `newRate < PRECISION`
(`InvalidRate`) and `setOkuMMultiplier` rejects any non-increasing value
(`MultiplierCannotDecrease`), so a loss has no on-chain representation. Rear-facing
accounting pays out only what was already measured, so a realised loss in a
closed epoch surfaces as a concrete number rather than being smoothed away.

**Only available response:** set the rate to `PRECISION` (0% APY) via
`setOkuMYieldRate` and hold until later positive yield absorbs the loss.
`realisedYieldToRatePerSecond` (`packages/yield-tooling/src/yieldRate.ts`)
throws on a negative realised yield rather than clamping, so the operator must
make that decision explicitly.

### 9. ERC-8056 is a Draft standard

`src/interfaces/IScaledUIAmount.sol` implements
[ERC-8056](https://eips.ethereum.org/EIPS/eip-8056), a **Draft**. Its four
interface IDs (`0xa60bf13d`, `0x4bd27648`, `0x57854fc3`, `0xd890fd71`) come from
the current draft and **may change before Final**, which would change
`supportsInterface()` results for integrators. Adopted deliberately ahead of
Final (SVM's Token-2022 `ScaledUiAmount` fills this role there); see
[§ ERC-8056](#erc-8056-scaled-ui-amount).

**Mitigated, not eliminated:** `test_InterfaceIds_MatchDocumentedHexValues`
(`test/token/OkuMoney.t.sol`) pins the hex values against the compiler-computed
`type(I).interfaceId`, so a signature change fails a test and names the doc
sites to update. It cannot predict the Final IDs; an integrator hardcoding
today's Draft IDs would still break if they change.

The two deviations documented under § ERC-8056 (emitting `UIMultiplierUpdated`
on rate-schedule changes, and a *projected* `newUIMultiplier()`) are our
interpretation of a spec written for discrete steps. A standards-only consumer
should poll rather than cache on events; see § ERC-8056's "Integrator contract"
note.

### 10. No on-chain enforcement of cross-chain rate equality

Each chain's `OkuMoney` is fully independent: no messaging, light client or
state proof. That every chain returns the same `okuMMultiplier()` rests entirely
on the **orchestrator pushing identical schedule state everywhere**; nothing in
`src/` can detect or reject a divergent schedule. The same holds on SVM, which
runs the same schedule at `PRECISION = 1e18` over a line-for-line port of
`MathLib.sol`.

**Mitigations (all off-chain):**

- Rates are derived from a declared APY via `packages/yield-tooling` (re-exported
  by `scripts/utils/yieldRate.ts`), so every chain receives a byte-identical
  integer.
- `setNextOkuMYieldRate` needs no transaction at the epoch boundary, so the
  highest-risk moment has no broadcast to get wrong.
- `scripts/operator/checkMultiplierDrift.ts` compares multiplier, rate,
  `rateEnd` and pending rate across every configured EVM chain **and SVM**,
  exiting non-zero on mismatch. Schedule-field equality is the exact check; the
  multiplier spread is reported with read skew annotated, because SVM's
  `Clock::unix_timestamp` can lag wall clock (see
  [`SVM/README.md` § Accepted Risks](../SVM/README.md#accepted-risks)).
- `test/differential/` holds the Solidity, Rust and TypeScript implementations to
  a committed corpus generated from the Solidity (reverts included);
  `npm run test:differential` from the repo root regenerates and replays it.

**Divergence is one-way.** The multiplier is monotonic, so a chain that ran hot
cannot be corrected downward; the only remedy is to run the laggards hot until
they catch up.

### 11. Known issues

**11a. `OkuDollar._redeemShares` floor-vs-ceil asymmetry — Resolved:** third-party
`withdraw`/`redeem` burn directly from `owner` through the shared `_unwrap` core
(one ceil computation against the owner's real balance); see the `_unwrap`
NatSpec.

**11b. ERC-4626 `mint()` / `withdraw()` do not guarantee exact output.** The spec
requires exactly `shares` / exactly `assets`, but both are thin wrappers over
`wrap`/`unwrap`'s floor-rounded conversions, so the actual amount can differ by
up to 1 wei in the vault's favour. Exact conformance on a continuously
repricing share token would need iterative correction; accepted as a
rounding-direction tradeoff consistent with the protocol's floor-favours-vault
convention. `deposit()` / `redeem()` are exact.

**11c. `rescueDonation` is 1-wei-per-unwrap optimistic.** It treats everything
above `totalUsdShares` as donation. `unwrap`'s ceil-burn / floor-return
asymmetry can leave reserves up to 1 wei above `totalUsdShares` per unwrap, and
that dust is rescuable. Directionally safe (it favours the protocol, and the
rescuer is a trusted cold-multisig role), but the accounting is optimistic
rather than exact.

**11d. ERC-4626 `totalAssets()` includes unbacked donations.** By spec it returns
everything the vault holds, including OkuM donated directly (see 11c) that backs
no share. An integrator computing share price as `totalAssets() / totalSupply()`
gets a value inflated by any outstanding donation. The vault does not use that
ratio internally (conversions use the shared multiplier, which is what makes it
immune to the inflation attack), so the true price stays $1.00; the ratio
re-converges once `rescueDonation` clears the dust.

### 12. Discrete-tick MEV survives only on the emergency override

There is no discrete-tick sandwich vector on the normal yield path:
`okuMMultiplier()` streams and `setOkuMYieldRate` re-anchors to the current
value, so there is no step to straddle (§ Why streaming, not discrete ticks).
The vector survives **only** on `setOkuMMultiplier`, the one function that
creates a discontinuity, which is why `lastYieldDistributionBlock` and
`whenNoOverrideThisBlock` exist (§ OverrideBlockGuard).

**Two distinct residuals, both unmitigated on-chain:**

- **Cross-block manipulation by the override holder** (`OKUM_REBASER`): an
  insider positions ahead of their own call. Not mitigated on-chain, for the same
  reason as Risk 1.
- **Third-party front-run of an honest override** — no role required.
  `OverrideBlockGuard` is **forward-only**: the block is stamped *inside*
  `setOkuMMultiplier`, so a transaction ordered before it in the same block is
  not blocked. A mint in block N ahead of an observed override, followed by a
  redeem in block N+1, captures the whole step for one block of capital exposure,
  with no PSM fee to price it. See the `OverrideBlockGuard.sol` NatSpec.

**Operational mitigation (no code change): pause around the override.**
`LitePSM` and `OkuDollar` hold their own `Pausable` state, independent of
`OkuMoney`'s (`setOkuMMultiplier` itself requires `OkuMoney` to be *unpaused*):

```
1. LitePSM.pause()     (PSM_PAUSER)
   OkuDollar.pause()   (VAULT_PAUSER)
2. OkuMoney.setOkuMMultiplier(newValue)
3. LitePSM.unpause()   (PSM_UNPAUSER)
   OkuDollar.unpause() (VAULT_UNPAUSER)
```

With both surfaces frozen before the call and until after it, neither residual
can land. Cost: PSM/vault unavailability for the ceremony, and on the mainnet
topology coordination across tiers (pause on the Warm Multisig, unpause on the
Cold Multisig). Appropriate for an emergency lever, not routine operation.
Pinned by `test_SetOkuMMultiplier_PauseCeremony_ClosesFrontRunWindow`
(`test/psm/LitePSM.t.sol`).

### 13. Blacklist parity with Circle FiatToken — now matched where it was gapped, by design where it isn't

The goal is to match Circle FiatToken's blacklist posture (`FiatTokenV1/V2.sol`),
the reference both tokens follow. Across both tokens, a blacklisted address
cannot successfully call any state-changing function as sender, recipient **or
approved spender**: `approve`/`permit` (owner and spender), `transfer`,
`transferFrom` (including the spender), OkuDollar's ERC-4626
`withdraw`/`redeem` (including a third-party spender), and `mint` (including the
minter). `blacklist()` works while paused. OkuDollar honours OkuMoney's
blacklist as well as its own. `maxDeposit`/`maxWithdraw`/`maxRedeem` report 0 for
a blacklisted or paused account. Tests: `test/token/`.

**Deliberate literal matches that look like footguns.** `OkuMoney.mint` checks the
**minter's** blacklist, as Circle's does. Here `OKUM_MINTER` is protocol
infrastructure (`LitePSM`), so blacklisting the PSM proxy would brick all
minting. Kept for parity with the reference; it costs one SLOAD and requires
actively blacklisting the protocol's own PSM.

**Unmatched, deliberately, same as Circle.** Blacklisting does not retroactively
revoke allowances granted earlier (revoking incoming allowances is unbounded
on-chain for either project), and there is no seizure/clawback function (USDT and
Paxos add one; Circle does not). A blacklisted spender cannot *exercise* an old
allowance, but if later unblacklisted it is live again without a new `approve`.
Mitigation: compliance watches `Approval` events for the spender and has grantors
`approve(spender, 0)` if exposure is a concern.

Queue and PSM blacklist behaviour (blacklisted users cannot mint UsdOku, redeem
or enqueue; a user blacklisted while queued is frozen, not paid) is documented
in § LitePSM.sol and § RedemptionQueue.sol.

### 14. Queue<->PSM wiring validation — enforced at init for new deployments; a correction to how a mismatch actually fails

`LitePSM.initialize` reverts `QueueUsdcMismatch` / `QueueOkuMoneyMismatch` if the
queue it is given disagrees with the PSM's `usdc()` or `okuMoney()` (after the
PSM's own config checks, so a malformed `_usdc`/`_okuMoney` reports itself
first).

**Not covered by construction:** `initialize` runs once per proxy, so it cannot
protect an already-initialized pair wired incorrectly afterwards, e.g. a PSM
proxy reused via the deploy script's address-book `tryAttach` path against a
different queue. `scripts/deploy/index.ts` `verifyDeployment` re-asserts
`litePSM.redemptionQueue()`, `usdc()` and `okuMoney()` for that case. There is no
runtime assertion inside `processQueue`; a correctly initialized pair can only
diverge via a proxy upgrade, which is a separate, reviewed risk category.

**How a mismatch actually fails (fail-closed, no silent leakage):**

- *`okuMoney` mismatch:* `processQueue` burns through the queue's own wired
  `okuMoney`, a token it holds neither a balance of nor `OKUM_BURNER` on. The
  `burn` is deliberately unguarded (see the "DELIBERATELY UNGUARDED" comment in
  `RedemptionQueue.processQueue`), so the whole batch reverts, including the
  earlier USDC transfer. Pinned by
  `test_ProcessQueue_MismatchedOkuMoney_RevertsEntireBatch_NoSilentCorruption`
  (`test/psm/RedemptionQueue.t.sol`).
- *`usdc` mismatch:* `usdcAvailable` reads the wrong token, collapses to zero, and
  every entry soft-skips with `RedemptionSkipped(InsufficientFunds)`.

### 15. The PSM has no slippage protection — deliberately

`LitePSM`'s four user entry points take no `minOut`/`maxIn`, by design: the
multiplier is monotonically non-decreasing and the PSM charges no fee. The
argument, its fee precondition, and the SVM `min_usdc_out` divergence are in
§ LitePSM.sol ("No slippage / min-out parameter"); the test is
`test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier`
(`test/psm/LitePSM.t.sol`).

Only the mint-side truncation residual lives here: on 18-decimal collateral a
mint forfeits up to `ceil(m / PRECISION)` wei of truncation, rounding to the
protocol. `OkuDollar.wrap`'s `minAmountOut` / `OutputBelowMinimum` is a separate,
reachable check and is unaffected.

### 16. The queue's dust floor collapsed at 18-decimal collateral — CLOSED

Resolved: `LitePSM._redeemOkuMShared` gates redemption at
`okuMAmount < max(decimalMultiplier, Constants.MIN_REDEMPTION_OKUM)` with
`MIN_REDEMPTION_OKUM = 1e12`, reverting `BelowMinimumRedemption`, so 18-decimal
collateral keeps the same real floor as 6-decimal (see § LitePSM.sol). It guards
the queue against dust-entry griefing at the processor's expense. A constant
avoids a new storage slot on the UUPS proxy and an admin lever. SVM needs no
equivalent: `lite-psm` requires 6-decimal USDC and has no redemption queue.
Tests: `test_MultiDecimal_18Dec_*` in `test/psm/LitePSM.t.sol`.

---

## Testing

Foundry is the authoritative functional suite. Hardhat is reserved for
fork-dependent and multi-contract scenario work, and for off-chain
script/simulation logic that has no Solidity counterpart. New unit and
invariant tests belong in Foundry.

### Layout

| Directory | Purpose |
|---|---|
| `test/psm` | `LitePSM` and `RedemptionQueue`: unit, fuzz, spec, and reentrancy tests. `QueueSpec.t.sol` is the product-level queue spec, written from intended behaviour rather than from the implementation. |
| `test/invariants` | Stateful invariant suites (supply, vault backing, multiplier, PSM, minter allowances) and `HandlerSanity.t.sol`, which checks that the handlers actually reach their target calls. |
| `test/token` | `OkuMoney` and `OkuDollar` unit and fuzz tests, including the rate-schedule suite. |
| `test/lib` | `MathLib`, `ReentrancyGuard`, and ERC-7201 slot tests. |
| `test/differential` | Emits the cross-language corpus (`vectors.jsonl`) that the Rust and TypeScript multiplier implementations are checked against. |
| `test/hardhat/unit` | Pure-TS tests of the off-chain rate, epoch, and operator-script logic. |
| `test/hardhat/drill` | Runs the real `scripts/deploy/index.ts` against a local fork and asserts the resulting chain (deployed proxies, address book, role matrix, absence of privileged roles on outsiders, a live PSM mint); then exercises every operator-script lever in-process against that same deploy. |
| `test/hardhat/fork` | Protocol against real mainnet / Sepolia state that Foundry cannot reach in CI. `RedemptionQueueCircle.ts` is the real-Circle-USDC queue suite (including Circle's blacklist semantics). |
| `test/hardhat/happyPath` | Deposit / yield / withdraw walk-through through the OZ upgrades plugin's real proxy machinery. |
| `test/hardhat/scenarios` | Deterministic dual-chain edge cases (`RealWorldUsage.ts`). |
| `test/hardhat/simulation` | Rear-facing epoch-accounting accuracy simulation; see [`docs/epoch-accounting.md`](docs/epoch-accounting.md). |

`test/mocks` holds shared mocks and the two test-only harnesses
(`MathLibHarness.sol`, `ReentrancyGuardHarness.sol`) that expose `internal`
library surface for direct testing. Neither is in any production import path.

### Running

```bash
forge test                                           # whole Foundry suite
forge test --match-path "test/invariants/*"          # invariant suite only
forge test --match-contract QueueSpecTest            # product-level queue spec
forge fmt --check                                    # CI gate: formatting
forge coverage --no-match-coverage 'test/|script/' --report summary   # what CI gates on

npx hardhat test                                     # whole Hardhat suite
npm run test:unit                                    # unit + simulation + drill suites
npx hardhat test test/hardhat/drill/*.ts             # deploy drill + operator drill only
npx hardhat test test/hardhat/fork/RedemptionQueueCircle.ts   # real-Circle-USDC queue suite
```

`npm run test:all` runs `forge test` and then `hardhat test`.

**Fork RPC.** The fork suites, and the drills (which reset and deploy against
the configured fork), need an archive RPC. See "RPC and fork configuration" in
Quick Start: setting `ANKR_FREEMIUM_API_KEY` enables the pinned mainnet fork
block, otherwise the run forks latest and is not deterministic. For the
genuinely offline subset use
`npx hardhat test test/hardhat/unit/*.ts test/hardhat/simulation/*.ts`.

**Coverage gates.** `.github/workflows/test.yml` fails the build unless every
`src/` file and the total reach >= 95 % line coverage, and the total reaches
>= 95 % branch coverage.

---

## Forge coverage notes

The CI coverage gates are defined in `.github/workflows/test.yml` (see
Testing). The branch gate is on the total rather than per file because a few
branches in `src/token/OkuDollar.sol` are provably unreachable (listed below),
which would otherwise force a permanent per-file exception. Coverage figures
are produced by `forge coverage` on each run; none are recorded here.

### Uncovered lines (intentional)

| Location | Code | Why unreachable |
|---|---|---|
| `OkuDollar._update` | `OkuDollarDoesNotUseInternalUpdate` revert | `OkuDollar` overrides `transfer` / `transferFrom` to use share-based accounting, and all supply changes go through `wrap()` / `unwrap()`, which manage `usdShares` directly and never call the inherited `_mint` / `_burn`. The override is `pure` and unconditionally reverts; it exists to halt a future refactor that routes through the inherited ERC-20 `_update` hook. |

### Uncovered branches (intentional)

The branches below are `revert` arms that cannot be driven from any call path,
each for a stated structural reason. Line numbers are omitted deliberately;
every symbol is unique within its function.

| Location | Guard | Why the revert arm is unreachable |
|---|---|---|
| `LitePSM._redeemUsdOku` | `received == 0` (balance-delta check after pulling `usdAmount` of `OkuDollar`) | `OkuDollar.transferFrom` reverts `AmountTooSmall` itself whenever the share conversion would floor to zero (see Accepted Risk #4), so a zero-value transfer cannot complete and return control here. Because `balanceOf` converts shares back to dollars via `shares * multiplier / PRECISION` and `multiplier >= PRECISION`, any nonzero share delta already implies a nonzero dollar delta. Defence-in-depth against either guard changing independently. |
| `OkuDollar._transferUsdShares` | `from == address(0)` | `transfer` passes `msg.sender`; `transferFrom` spends the allowance first, and `address(0)` can never have granted one, so the allowance check always fires earlier. The `to` half of the same pair is reachable and is tested. |
| `OkuDollar._update` | `UseWrapInstead` / `UseUnwrapInstead` | Nothing in the contract invokes the inherited `_mint` / `_burn`; see the entry above. A tripwire against a future refactor that routes through the inherited ERC-20 hook. |
| `OkuDollar.wrap` | `sharesToMint == 0` | `wrap` rejects `okuMAmount == 0` at entry, and `sharesToMint == actualReceived`, so reaching zero requires an asset that takes a 100 % transfer fee. The asset is the typed `IOkuMoney` wired at init, which is not fee-on-transfer. Kept because the balance-delta pattern exists precisely to tolerate a fee-on-transfer asset. |

These are guards against an assumption about a collaborator that a future
change could break. Guards against arithmetic that cannot happen by
construction do not belong in this table; they should be removed from `src/`
rather than documented here.

### Where each sensitive area is tested

| Topic | File |
|---|---|
| `OkuDollar.rescueDonation` backing floor and role gate | `test/token/OkuDollar.t.sol` |
| `OkuDollar` share rounding, blacklist, pause, wrap / unwrap | `test/token/OkuDollar.t.sol`, `test/token/OkuDollar.fuzz.t.sol` |
| `LitePSM` redeem paths (buffer-covered vs. queued, `OkuMRedeemed` suppression, multi-decimal collateral) | `test/psm/LitePSM.t.sol`, `test/psm/LitePSMRebasingRedeem.t.sol`, `test/psm/LitePSM.fuzz.t.sol` |
| `RedemptionQueue.processQueue` soft-skip paths (`TransferFailed`, return-false USDC, already-cleared, insufficient funds), `rescueQueueEntry` | `test/psm/RedemptionQueue.t.sol` (backed by `MockUSDC.setBlocked` in `test/mocks/MockUSDC.sol`, which mirrors Circle USDC's revert-on-blacklist) |
| Queue ordering, blacklist, pause, processing-time payout semantics | `test/psm/QueueSpec.t.sol`; against real Circle USDC: `test/hardhat/fork/RedemptionQueueCircle.ts` |
| Reentrancy through the queue and PSM | `test/psm/Reentrancy.t.sol`, `test/lib/ReentrancyGuard.t.sol` |
| `OkuMoney` rate schedule: `setOkuMYieldRate` continuity and non-stamping, `setNextOkuMYieldRate` boundaries, expiry with no successor | `test/token/OkuMoney.t.sol`, `test/token/OkuMoney.fuzz.t.sol` |
| Multiplier math and cross-language agreement | `test/lib/MathLib.t.sol`, `test/differential/GenerateVectors.t.sol` |
| Storage-slot derivation (ERC-7201) | `test/lib/ERC7201Slots.t.sol` |
| System-wide properties (supply, backing, multiplier, minter allowances) | `test/invariants/*` |

---

## Dependencies — pinned for audit

Exact versions are recorded in the files below, not in this README:

- **Solidity libraries (Foundry path):** `foundry.lock` pins the git commit of
  each submodule under `lib/`.
- **Node packages (Hardhat path):** `EVM/package.json` and
  `EVM/package-lock.json`. The compile-affecting packages (OpenZeppelin,
  Hardhat and its plugins, TypeChain, ethers) use exact versions with no
  range; a few tooling and off-chain dependencies use ranges and are held by
  the lockfile.
- **Compiler settings:** `foundry.toml` and `hardhat.config.ts` set the `solc`
  version, `evm_version`, and `bytecode_hash` / `bytecodeHash` to `"none"`.

Reasons for the policy:

- **One OpenZeppelin release on both compile paths.** The Foundry submodules
  and the Node OpenZeppelin packages must be the same release so Foundry and
  Hardhat produce bytecode from identical sources.
- **OpenZeppelin is pinned exactly, not by range.** The proxies are UUPS
  deployed through `@openzeppelin/hardhat-upgrades`, which always calls
  `initialize` during `deployProxy` and validates upgrade safety. Changing the
  OpenZeppelin version therefore means re-reading its breaking-change notes
  against the call sites in `src/` and re-running both suites, including the
  Hardhat happy-path and deploy drill.
- **`bytecode_hash = "none"`.** At solc's default the metadata hash is derived
  from the source text, comments included, so editing a NatSpec line would
  change initCode and therefore every CREATE2 address. With `"none"` the
  address depends only on code semantics and the pinned compiler. The
  Foundry and Hardhat settings must agree, or the two toolchains compile the
  same source to different addresses. See "Deterministic addresses (CREATE2)".

### `npm audit` posture

`npm audit` reports vulnerabilities in transitive dev dependencies pulled in
by `hardhat-deploy` and `@nomicfoundation/hardhat-toolbox`. These are
JavaScript dev tooling only: they do not enter production bytecode and do not
affect the audited Solidity contracts.

---

## Pointers

- **Workspace overview:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **Authority matrix:** [`../AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md)
- **Accepted risks:** see "Accepted Risks" above
- **Epoch accounting:** [`docs/epoch-accounting.md`](docs/epoch-accounting.md)
- **SVM-side docs:** [`../SVM/README.md`](../SVM/README.md)
