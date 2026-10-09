# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity, pinned compiler and EVM version (`foundry.toml` and `hardhat.config.ts` must agree)
- **Framework**: Foundry (Forge, Cast, Anvil) for unit, fuzz, invariant, and differential-vector tests; Hardhat for fork tests, off-chain script/simulation tests, deploy/operator drills, and gas reports
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable); exact versions in `package.json` and `foundry.lock`
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Quick Start

```bash
forge install && forge build && forge test    # unit, fuzz, invariant, differential-vector tests
npx hardhat compile && npx hardhat test       # fork, integration, simulation, deploy/operator drill tests
```

CI (`.github/workflows/test.yml`) enforces >=95% line coverage on every `src/`
file and on the total, and >=94% total branch coverage, from `forge coverage`.

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
  `SKIP_MOCK_USDC=true`, so `LitePSM` matches across chains
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
| `.openzeppelin/<network>.json` | OZ upgrades plugin's per-chain proxy/impl manifest. The upgrade script validates against it and **refuses to run** if a proxy is missing (it never `forceImport`s). | Deploy script, upgrade script. |
| [`scripts/config/upgradeBaselines.json`](scripts/config/upgradeBaselines.json) | **Tracked** storage-layout baseline of the implementation behind each proxy, bound to its runtime code hash; `fork:*` keys go to the gitignored `upgradeBaselines.local.json`. An independent check on the manifest. | Deploy script, upgrade script (direct and `MODE=verify`). |
| `upgrade-proposals/<chain>/` | **Tracked** multisig upgrade proposals (`<stamp>.json`) and their Safe Transaction Builder batches (`<stamp>.safe.json`). | Upgrade script, `MODE=propose`. |

`DEPLOYMENT_VERSION` is `v0.4`. The address book, registry, and role-grant
ledger are empty until the clean-slate deploy of that version.

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

The script is **idempotent and resumable**: `tryAttach` reuses any contract
already in `addresses.json["<chain>"]` whose address still has bytecode, so a
partial deploy can simply be re-run. Transient RPC errors (nonce races,
underpriced replacements, BSC's pending-tx `BAD_DATA` quirk, timeouts) are
retried with exponential backoff inside `withRetry`, and a provider shim
(`scripts/utils/rpcCompat.ts`) normalises BSC's pending-tx shape before ethers'
strict formatter sees it.

The script also **verifies itself before reporting success**. Each contract's
`initialize` already grants the deployer (admin) its full role set, so
`configureRoles` sends only grants to other holders: `OKUM_MINTER` and
`OKUM_BURNER` to `LitePSM` (the only contract that ever holds them), then
`LitePSM`'s minter allowance. `verifyDeployment` then re-reads the chain and
asserts the complete matrix: all 26 entries of `expectedRoleGrants()` (each
tagged `initialize` or `script`) via `hasRole`, the LitePSM minter allowance, and
every contract's presence in the address book (with exactly one of `MockUSDC` /
`USDC`, matching `LitePSM.usdc()`), failing the run with an explicit
list of anything missing. The allowance is checked separately because
`OkuMoney.mint` gates on *both* `onlyRole(OKUM_MINTER)` and `minterAllowance`.

> `expectedRoleGrants()` (exported from `scripts/deploy/index.ts`) is also what
> `test/hardhat/drill/deployDrill.test.ts` asserts against, so the test cannot
> drift from the deploy. Only the grants the script itself sends (`script`, not
> `initialize`) are appended to the tracked ledger
> [`scripts/config/roleGrants.json`](scripts/config/roleGrants.json) (live chains
> only), because the contracts are not `AccessControlEnumerable` and holders
> cannot be listed on-chain; `hasRole` is the source of truth. Operational and
> mainnet role distribution is done by `scripts/operator/grantRoles.ts` /
> `grantRolesMainnet.ts`; see § Role Grants Policy.

### Upgrading deployed proxies

`scripts/upgrade/index.ts` upgrades one or more UUPS proxies (`OkuMoney`,
`OkuDollar`, `LitePSM`; always in that order) to the compiled `./src`. Header of
the script = full reference; this is the runbook.

**Modes.**

| `MODE` | Who calls `upgradeToAndCall` | Use |
|---|---|---|
| `direct` (default) | the script's signer, which must hold the `*_UPGRADER` role | testnets, where the deployer keeps its roles |
| `propose` | nobody yet: writes `upgrade-proposals/<chain>/<stamp>.json` + `<stamp>.safe.json` for `UPGRADE_SAFE` | mainnet, after `grantRolesMainnet.ts` moved the upgraders to the cold Safe |
| `verify` | — (reads the chain after the Safe executed `PROPOSAL=<stamp>.json`) | closes a `propose` run: records the upgrade and the new layout baseline |

`DRY_RUN=1` runs every pre-broadcast check and sends **nothing** (no
implementation deploy either), so it needs no `YES_MAINNET`.

**Checks, all before any upgrade transaction.** A target whose runtime code
(metadata and immutables normalised) already matches the deployed
implementation is skipped and nothing is recorded. Otherwise:

1. the storage layout is compared against the **recorded baseline** of the
   deployed implementation (`scripts/utils/upgradeBaseline.ts`), which must
   describe exactly the implementation behind the proxy (address + code hash);
2. OpenZeppelin's `validateUpgrade` runs against `.openzeppelin/<chain>.json`. A
   proxy missing from the manifest is an **error**: re-importing current source
   would record the new layout as the deployed one and make check 1/2 vacuous
   (audit U-01). Restore the manifest from git;
3. the new implementation must be initializer-locked, return the ERC-1967 slot
   from `proxiableUUID()`, compile from local source, and differ from the
   current implementation.

**After the upgrade** (direct, or `MODE=verify`): the `Upgraded` event, the
proxy slot, a block-pinned diff of `preState.ts` snapshots — every wiring,
config, schedule and role field must be unchanged unless an event that changes
it was emitted in between — and cross-contract invariants (live multiplier ==
closed form over the stored schedule, `usdMultiplier == okuMMultiplier`,
reserves >= shares, LitePSM keeps `OKUM_MINTER`/`OKUM_BURNER`). The audit
record (`addresses.json -> upgrades.<chain>`: impls, tx, block, chainId, code
hash, git commit, mode, pre/post state) and the new baseline are written
before any failure is raised, so an upgrade that landed is always recorded.

```bash
# Rehearse on a fork of the target chain (uses the live book key; records nothing).
# Impersonates UPGRADE_SAFE / ledger role holders if the dev wallet lacks the role.
FORK_NETWORK=base npm run node                                   # terminal 1
TARGETS=OkuMoney UPGRADE_SAFE=0x... npm run upgrade               # terminal 2

# Testnet (deployer holds the roles)
TARGETS=LitePSM npm run upgrade:sepolia

# Mainnet (cold Safe holds the roles)
DRY_RUN=1 MODE=propose UPGRADE_SAFE=0x... TARGETS=OkuMoney npm run upgrade:base
MODE=propose UPGRADE_SAFE=0x... TARGETS=OkuMoney YES_MAINNET=1 npm run upgrade:base
#   -> Safe UI: Transaction Builder -> import upgrade-proposals/base/<stamp>.safe.json,
#      check `to` (proxy) and the impl in `data` against <stamp>.json, sign, execute
MODE=verify PROPOSAL=upgrade-proposals/base/<stamp>.json npm run upgrade:base
```

Env vars:

| Var | Purpose |
|---|---|
| `TARGETS` | Comma-separated contract names (required, except `MODE=verify`). |
| `MODE` | `direct` (default), `propose`, `verify`. |
| `UPGRADE_SAFE` | Multisig holding the upgrader roles (`propose`; fork impersonation). |
| `PROPOSAL` | Proposal file to close (`verify`). |
| `DRY_RUN` | `1`/`true`: all checks, nothing sent. |
| `YES_MAINNET` | `1`/`true`: required to deploy/upgrade on a mainnet network. |
| `PROXY_<Name>` | Proxy address override (default: the address book). |
| `SKIP_VERIFY` | Skip explorer verification of the new implementation. |
| `SKIP_BYTECODE_CHECK` | Upgrade even if the runtime code is unchanged. |
| `LOG_CHUNK` | `eth_getLogs` block range per request (default 2000). |
| `PRIVATE_KEY` / `ETHERSCAN_API_KEY` | Signer / explorer key (Etherscan V2: one key for every chain). |
| `NETWORK`, `FORK_NETWORK`, `FORK_URL` | Chain selection (see § Quick Start). |

A migration that needs a reinitializer is not supported yet: the script always
calls `upgradeToAndCall(newImpl, "0x")`. Add a per-target calldata field when
the first one is needed. `test/hardhat/drill/upgradeDrill.test.ts` exercises
every mode against the real deploy script with V2 fixtures from
`test/mocks/UpgradeDrillMocks.sol`.

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
| `npm run operator:*` | One alias per operator script below (`package.json` lists them all). They carry no `--network`: append `-- --network <chain>`, or they run against the in-process fork |
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
> Every option has an env-var equivalent (`ACTION`, `AMOUNT`, `TARGET`,
> `YES_MAINNET`, …); see each script's header or
> [`scripts/utils/cli.ts`](scripts/utils/cli.ts) for the name-mapping rule. The
> `--flag` form still works when a script is invoked directly via `ts-node`.

### Operator scripts (PSM / vault / admin)

All take options as **env vars** (see the note above). All support
`DRY_RUN=true`, and `YES_MAINNET=true` is required to broadcast on a mainnet
network. All are also exported as `run*()` functions and exercised in-process
by the operator drill.

| Script | Purpose |
|---|---|
| [`scripts/operator/psmOps.ts`](scripts/operator/psmOps.ts) | PSM mint/redeem, consolidated. `ACTION=<mintOkuM\|redeemOkuM\|mintUsdOku\|redeemUsdOku\|burn>` + `AMOUNT=<units>` (USDC 6-dec, OkuM/UsdOku 18-dec). `burn` burns the caller's own OkuM directly (needs `OKUM_BURNER`). A redeem reverts `InsufficientBuffer` when the PSM buffer is short. |
| [`scripts/operator/vaultOps.ts`](scripts/operator/vaultOps.ts) | OkuDollar vault operations. `ACTION=<wrap\|unwrap\|deposit\|mint\|withdraw\|redeem\|rescueDonation>` + `AMOUNT`, optional `RECEIVER` / `OWNER` / `MIN_AMOUNT_OUT`. Covers both the price-aware `wrap`/`unwrap` pair and the ERC-4626 surface. |
| [`scripts/operator/depositBuffer.ts`](scripts/operator/depositBuffer.ts) / [`withdrawBuffer.ts`](scripts/operator/withdrawBuffer.ts) | PSM USDC buffer management. `AMOUNT=<6-dec USDC>`, plus `TO=0x...` for withdraw. Buffer depth caps how much can be redeemed. Both revert while the PSM is paused or in an override block. |
| [`scripts/operator/configureMinterAllowance.ts`](scripts/operator/configureMinterAllowance.ts) | Rotate a minter's allowance. `MINTER` (defaults to deployed LitePSM) + `ALLOWANCE`. Note `OkuMoney.mint` gates on **both** the `OKUM_MINTER` role *and* this allowance. |
| [`scripts/operator/setMaxSupply.ts`](scripts/operator/setMaxSupply.ts) | Raise/lower the supply cap. `MAX_SUPPLY=<18-dec>`. Requires `OKUM_CAP_MANAGER`. |
| [`scripts/operator/setOkuMMultiplier.ts`](scripts/operator/setOkuMMultiplier.ts) | **Emergency** multiplier override. `NEW_MULTIPLIER=<1e18-scaled>`. Collapses the rate schedule to halted and engages `OverrideBlockGuard` for the rest of the block — prefer `setOkuMYieldRate.ts` for normal operation. **Front-run risk beyond that block**: pause `psm` + `usdOku` (via `pause.ts`) before calling this, unpause after — see Accepted Risk #11. |
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
    OkuMoney.sol            # Non-rebasing OkuM: ERC-20, supply cap, minter allowances,
                            # blacklist, pause; ERC-8056 conversion/balances
    OkuMoneyRateSchedule.sol # Abstract base of OkuMoney: the rate schedule, okuMMultiplier()
                            # (COMPUTED), setters, emergency override, ERC-8056 scheduling
    OkuDollar.sol           # Rebasing $1-pegged usdOku wrapping OkuM; usdMultiplier() delegates
                            # to okuMoney.okuMMultiplier(). IERC4626-conformant, rebasing shares.
  psm/
    LitePSM.sol             # USDC <-> OkuM + usdOku convenience paths; sole user-facing mint/burn
  interfaces/               # IOkuMoney, IOkuDollar, IScaledUIAmount (ERC-8056 core + extensions)
  lib/
    Roles.sol               # Shared RBAC role constants
    Constants.sol           # Compile-time constants + terminology legend
    MathLib.sol             # computeMultiplier / compoundFor / rpow + conversion helpers
    ReentrancyGuardUpgradeable.sol  # OZ 5.x dropped the upgradeable variant; this replaces it
    OverrideBlockGuard.sol  # whenNoOverrideThisBlock (OkuDollar + LitePSM); emergency override only
    events/                 # One event-declaration file per contract
    errors/                 # SharedErrors (raised by several contracts) + one error file per contract

test/mocks/                 # Test-only mocks/harnesses, compiled by Hardhat but outside `src/`.
                            # MockUSDC.sol (6-decimal) is also the deploy script's testnet collateral.
```

> **There is no bridge code in `src/`.** v1 cross-chain transfers are
> PSM-mediated mint/burn orchestrated off-chain ([`../README.md` § Cross-chain
> transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated);
> Accepted Risk #6). A future on-chain bridge would be additive: a new proxy
> granted `OKUM_MINTER` plus a minter allowance, with no change to the three
> contracts.

---

## Terminology (canonical)

[`src/lib/Constants.sol`](src/lib/Constants.sol) holds the authoritative legend
and every contract's NatSpec points at it. `usdMultiplier` is exactly
`okuMoney.okuMMultiplier()`, and ERC-8056's `uiMultiplier` is an alias for the
same value (§ Streaming Accrual).

**Shares — terminology hazard.** `usdShares` is OkuDollar's *internal*,
non-rebasing accounting unit, numerically identical to the raw OkuM
deposited. ERC-4626 "shares" means the *rebasing displayed balance*
(`balanceOf`, dollar-denominated). **These are different quantities** and
`convertToShares` returns the latter.

**Key formulas** (`decimalMultiplier` = `usdcDecimalMultiplier` =
`10 ** (18 - usdcDecimals)`, fixed at `LitePSM.initialize`)
```
multiplier:              m(t)         = base × rpow(rate, t − anchor, PRECISION) / PRECISION
USDC → OkuMoney:         okuMAmount   = (usdcAmount × decimalMultiplier) × PRECISION / m
OkuMoney → USDC:         usdcAmount   = (okuMAmount × m / PRECISION) / decimalMultiplier
OkuMoney → usdOku share: shares       = okuMAmount × m / m          (= okuMAmount)
usdOku → OkuMoney:       okuMAmount   = usdAmount × PRECISION / m
```

The third formula collapsing to the identity is the algebraic consequence of
the single-multiplier design, and is why collateralization is exactly 1.0.

---

## Hardcoded Constants

[`src/lib/Constants.sol`](src/lib/Constants.sol) holds the values, each with its
bound and SVM-parity obligation in NatSpec; they are not copied here. What the
code does not state is **which are negotiable**:

- **`PRECISION` (1e18) is not.** Changing it rewrites every multiplier path on
  both stacks and invalidates the differential corpus.
- **`OKU_M_DECIMALS` (18) is not.** It is a property of the token; changing it
  re-denominates OkuM.
- **`MAX_RATE` and `MAX_MULTIPLIER` are arbitrary**, in the precise sense that
  any number far above realistic yield trajectories would serve. They are
  sanity bounds against a compromised rate manager key and against `rpow` overflow,
  not economic parameters.
- **`MAX_RATE_WINDOW` (90 days) is load-bearing and tightly argued.** See the
  standing invariant in [`TRACKER.md`](../TRACKER.md): `rpow` overflows at ~15
  years and the failure is unrecoverable without an upgrade.
- **`MAX_USDC_DECIMALS` (18) is a deliberate forward-compat choice**, not a
  description of reality. Most USDC deployments use 6 — but BSC's canonical
  Binance-Peg USDC uses 18, which is why the PSM is decimals-agnostic rather
  than hardcoding 6.

Constants mirrored on both stacks must agree or the differential harness
diverges; the SVM mirror is `SVM/oku-programs/crates/oku-shared/src/constants.rs`.

---

## Dual-Token Shared-Multiplier Model

There is **one multiplier** in the protocol. `OkuDollar.usdMultiplier()` returns
exactly `okuMoney.okuMMultiplier()`; OkuDollar holds no rate state of its own.
OkuM and usdOku therefore **necessarily earn identical yield**.

```
OkuMoney.okuMMultiplier()          ← computed from the rate schedule (OKUM_RATE_MANAGER)
        │
        └─► OkuDollar.usdMultiplier()   ← delegated, no independent state
```

Protocol margin comes from the **spread between the off-chain RWA yield actually
realized and the rate published on chain**, not from an on-chain rate differential
between the two tokens.

Consequences:

- `wrap` reduces algebraically to `mulDiv(A, m, m) == A`, so internal `usdShares`
  equal the raw OkuM deposited.
- **Collateralization is exactly 1.0 by construction**: shares are only minted or
  burned 1:1 against real OkuM at the same `m`. There is no surplus to withdraw
  and no ratio to configure, hence no vault rate manager, reserve-manager or admin
  role; `OkuDollar`'s only asset-touching role is `VAULT_RESCUER`.
- The vault is **structurally immune to the ERC-4626 inflation/donation attack**,
  because conversions use `m` rather than `totalAssets/totalSupply`. The corollary
  is that donated OkuM accrues to nobody (§ Donation Rescue).

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20; the multiplier
appreciates, balances do not). OkuDollar is **rebasing** ($1-pegged; `balanceOf`
grows with `m` every second, with no transaction).

---

## Streaming Accrual & Cross-Chain Determinism

The multiplier streams continuously rather than moving in discrete
orchestrator-written jumps, for two reasons: a continuous curve has no step to
sandwich (§ Why streaming, not discrete ticks), and a discrete tick would have to
land on all N chains inside a tight window, forever, with any divergence
extractable by bridging between them. A shared rate schedule removes the per-tick
simultaneity requirement.

### The multiplier is computed, not stored

`okuMMultiplier()` is `MathLib.computeMultiplier` evaluated at `block.timestamp`
over the packed schedule fields in `RateScheduleStorage`
([`OkuMoneyRateSchedule.sol`](src/token/OkuMoneyRateSchedule.sol)) (base, rate, anchor, rate
end, pending rate, pending rate end). It is a MakerDAO `chi`/DSR-style `rpow`
accumulator: it compounds the active rate from the anchor, rolls over to the
pending rate at `okuMRateEnd`, bounds that pending rate's own overhang at
`okuMPendingRateEnd` (so an unattended successor halts rather than compounding
forever), and clamps at `MAX_MULTIPLIER`. Branch-by-branch detail: `MathLib.sol`
NatSpec.

**No discrete step ⇒ nothing to sandwich.** `setOkuMYieldRate` re-anchors the base
to the *current* value, so the curve is continuous across the write; this is why
it deliberately does not stamp `lastOverrideBlock`.

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

This is also why there is no on-chain `distributeYield()`: dividing dollars by
*local* `totalSupply()` would give a different delta on every chain (§ Rear-Facing
Epoch Accounting).

### The pre-staged successor rate

The handover fires off the **absolute `okuMRateEnd` timestamp inside the view
function, with no transaction at the boundary**. Staging transactions may land
on different chains at different times — even days apart — and the activation
is still simultaneous to the second. **This is the primitive that makes
cross-chain epoch handovers exact.** Rules and rails: § OkuMoney.sol.

### Why streaming, not discrete ticks

Discrete payout is unsafe next to a permissionless PSM. `setOkuMMultiplier` is
only the emergency override, not how yield is paid.

**The vector.** `LitePSM` mint/redeem charge no fee and have no cooldown, and
`OverrideBlockGuard` blocks only the single block of a discrete write. At 5% APY
paid monthly (a 0.407% jump per tick), depositing just before the tick and
withdrawing just after captures the whole month's yield for ~24 seconds of
exposure: ~$4,070 per $1M, ~$407,000 per $100M, every tick.

**Who pays — there is no third option.** `distributeYield(dollars)` divides by
`totalSupply()` at call time, so attacker capital equal to honest supply halves
every honest holder's yield. `setOkuMMultiplier(value)` moves value per token
regardless of holder, so the treasury funds yield on capital never at risk.

**The non-adversarial case is sharper.** A holder who deposits the day before a
tick earns a full period for one day of exposure; one who withdraws the day
before earns nothing for the period they held through. Private submission hides
the tick transaction, not the cadence, which is public once the PSM is
permissionless, so the rational strategy becomes holding only across ticks.

| Mitigation | Outcome |
|---|---|
| Private/protected tx submission | Hides the tx, not the cadence. (The one-off emergency override has no cadence, so there it genuinely helps; the pause ceremony in Accepted Risk #11 is preferred since it needs no trust in a relay.) |
| Randomize tick timing | Costs the attacker opportunity cost, not the yield |
| Redemption fee | Must exceed the largest tick (~0.41%/mo): taxes every honest exit forever |
| Deposit cooldown > tick period | Works, but destroys instant permissionless liquidity, i.e. the product |
| Widen the guard to N blocks | Attacker waits N blocks; bricks the PSM around every tick |
| Time-weighted accrual / snapshots | The first *is* streaming; with snapshots, snapshot timing becomes the target and ERC-20 fungibility breaks |

**The impossibility.** A permissionless instant PSM, chunky yield payout,
fairness to honest holders, and fungible ERC-20 balances cannot all hold.
Continuous streaming is the only one that is purely cosmetic to trade away.

**Why only one rate.** A second, independent UsdOku rate would be an unfunded
promise: if `usdRate > okuMRate`, the vault drifts undercollateralized at the
treasury's expense. One shared multiplier removes the liability, not just its
monitoring (§ Rear-Facing Epoch Accounting).

**Costs not resolved here:** dollars→rate conversion is off-chain TypeScript
(`packages/yield-tooling`, re-exported via `scripts/utils/yieldRate.ts`) outside
Solidity tooling; `computeMultiplier` is a 7-argument, 3-branch function rather
than one stored value; every chain needs a live re-arm cadence rather than
set-and-forget.

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
  would divide by *local* `totalSupply()`, giving a different multiplier delta on
  every chain. The rate is the only cross-chain-safe unit, so `setOkuMYieldRate`
  takes a rate and there is no `distributeYield()`.
- **Measurement basis and paying basis differ.** The denominator for deriving a
  rate is a time-weighted global average value (V̄) across all participating
  chains; the thing that actually appreciates is each chain's local supply.
  They do not coincide, and the residual is reconciled ex-post rather than
  predicted — see `reconcileActualPayout`.
- **A rate window must fit inside `MAX_RATE_WINDOW` (90 days).** Schedules
  longer than that must re-anchor, not open one window.
- **`setOkuMYieldRateWithSuccessor` exists for atomicity.**
  `setOkuMYieldRate` clears any armed successor, so if the follow-up
  `setNextOkuMYieldRate` fails or is delayed, that chain halts accrual at
  `endTimestamp` while chains where it landed keep accruing: a divergence until
  repaired. The combined call lands both or neither.

Full model, derivation, and the simulation study that validated it:
[`docs/epoch-accounting.md`](docs/epoch-accounting.md).

---

## OkuMoney.sol

**Inherits**: `OkuMoneyRateSchedule` (which brings `AccessControlUpgradeable`, `PausableUpgradeable`, `IOkuMoney` and the two scheduling ERC-8056 interfaces), `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `UUPSUpgradeable`, plus the two remaining ERC-8056 interfaces.

**Concept**: Non-rebasing base token with rear-facing yield. Balances are static;
yield is the multiplier, **computed continuously** from a rate schedule (§ Streaming
Accrual).

**Layout**: the schedule lives in the abstract
[`OkuMoneyRateSchedule.sol`](src/token/OkuMoneyRateSchedule.sol) (`okuMMultiplier()`,
the rate setters, `setOkuMMultiplier`, `lastOverrideBlock`, `uiMultiplier` /
`newUIMultiplier` / `effectiveAt`) so it can be reviewed on its own. `OkuMoney.sol` holds
the ERC-20, supply cap, minter allowances, blacklist, pause and upgrade surface. Each
has its own ERC-7201 namespace (`okumoney.storage.OkuMoneyRateSchedule`,
`okumoney.storage.OkuMoney`); neither stores the multiplier itself, and every
runtime-variable downcast goes through `SafeCast`, so an out-of-range value reverts
rather than truncating.

**Rate setters** (`OKUM_RATE_MANAGER`): `setOkuMYieldRate`, `setNextOkuMYieldRate`,
and the atomic `setOkuMYieldRateWithSuccessor` stream yield; every window is
mandatorily bounded and their rules live in the NatSpec. `setOkuMMultiplier` is
the **emergency discrete override** and the sole reason
`lastOverrideBlock` and `OverrideBlockGuard` still exist. There is no
`distributeYield()` (§ Rear-Facing Epoch Accounting). Pause behaviour: § Pause
Behavior.

### ERC-8056 (Scaled UI Amount)

OkuMoney implements [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056) over the
same multiplier, advertised through `supportsInterface()`
([`src/interfaces/IScaledUIAmount.sol`](src/interfaces/IScaledUIAmount.sol)):

| Interface | ID |
|---|---|
| `IScaledUIAmount` (core) | `0xa60bf13d` |
| `IScaledUIAmountNewUIMultiplier` (required extension) | `0x4bd27648` |
| `IScaledUIAmountConversion` (optional) | `0x57854fc3` |
| `IScaledUIAmountBalances` (optional) | `0xd890fd71` |

ERC-8056 is a **Draft**; these IDs may change before Final (Accepted Risk #8).
Adopting it early is a forward-looking bet: SVM's Token-2022 ships a
`ScaledUiAmount` extension for exactly this non-rebasing,
appreciating-display pattern, and implementing now positions OkuMoney as a
reference rather than a retrofit.

**Only OkuMoney implements it; OkuDollar deliberately does not.** UsdOku shares
are already dollar-denominated, so a `uiMultiplier()` there would duplicate
OkuMoney's or return a constant `1e18`.

**Integrator contract.** The multiplier moves every second but
`UIMultiplierUpdated` fires only on rate-schedule changes (the deviations are
listed in the `IScaledUIAmount` NatSpec). A standards-only consumer must
therefore **poll** `uiMultiplier()` / `balanceOfUI()` / `totalSupplyUI()` rather
than cache until the next event, and treat the event as "the trajectory
changed", not a value diff (it can fire with `old == new`). The trajectory (rate,
window end) is on the non-standard `OkuMYieldRateUpdated`.

### Implementation notes

- **No `TransferValue` event on OkuMoney.** Under streaming accrual the dollar
  value would need an `rpow` per transfer and the event would duplicate ERC-20
  `Transfer`; indexers derive value off-chain from the rate schedule.
  OkuDollar's `TransferValue` is distinct: it carries *shares*.
- **`blacklist()` deliberately lacks `whenNotPaused`**, so operators can act
  during a paused incident (the pause-to-blacklist protocol).
- **Roles** are declared once in [`src/lib/Roles.sol`](src/lib/Roles.sol).
  OkuDollar reuses `OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER`, but AccessControl is
  per contract, so each must be granted on each token. Who holds what and the
  blast radius of each: [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md).

---

## OkuDollar.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `OverrideBlockGuard`, `UUPSUpgradeable`.

**Concept**: Rebasing $1-pegged stablecoin wrapping OkuMoney. `usdMultiplier()`
returns exactly `okuMoney.okuMMultiplier()`, so
`balanceOf(user) = usdShares[user] × usdMultiplier() / PRECISION` changes every
second with no transaction. Storage is `struct OkuDollarStorage` (ERC-7201).
There is no vault-side rate or reserve surface: yield is set on OkuMoney by
`OKUM_RATE_MANAGER`, and collateralization is 1.0 by construction.

**Blacklist.** OkuDollar keeps its own blacklist (shared
`OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER` role names, granted per contract)
**and honours OkuMoney's**: `isBlacklisted(account)` is true if either list
contains the account. It applies to `transfer`, `transferFrom` (including the
spender), `wrap`, `unwrap`, `approve`, `permit`, the ERC-4626 withdraw/redeem
paths and the `max*` views. `scripts/operator/blacklistBoth.ts` lists an address
on both tokens in one run.

### Wrap / Unwrap

- `unwrap` rounds `sharesToBurn` **up**, deliberately favouring the vault (one of
  the enumerated `Ceil` sites in the [`MathLib.sol`](src/lib/MathLib.sol) rounding-policy header).
- `InsufficientBalance` (user balance) and `InsufficientReserves` (vault reserves)
  are intentionally distinct; collapsing them would hide which side is short.
- Both are `public` so the ERC-4626 entry points can call them, and carry
  `whenNoOverrideThisBlock` + `whenNotPaused` + `nonReentrant`.

### ERC-4626 Surface

**Deliberately does NOT inherit OZ `ERC4626Upgradeable`.** Its `_convertTo*`
assume a static share balance with a floating ratio, whereas UsdOku shares
**rebase** while the price stays pinned at $1 (the stETH / aToken shape; Aave
ships aTokens as non-4626 with a static wrapper for the same reason). The
accurate description is **"IERC4626-interface-conformant with rebasing
shares"**. Conversions use `m` rather than `totalAssets / totalSupply`, which
makes the vault immune to the inflation/donation attack. `convertToShares`
returns the rebasing balance (§ Terminology). `deposit` / `mint` have no
slippage parameter in the 4626 signature and pass `minAmountOut = 0`; EOAs
should prefer `wrap`.

### Donation Rescue (`VAULT_RESCUER`)

The corollary of inflation immunity: OkuM sent directly to the vault accrues to
**nobody**. `rescueDonation(amount, receiver)` recovers it, but only the excess
above `totalUsdShares` (the OkuM backing every outstanding share), so it cannot
touch backing; otherwise `NoDonationAvailable`.

Events are declared in
[`src/lib/events/OkuDollarEvents.sol`](src/lib/events/OkuDollarEvents.sol);
ERC-4626 `Deposit` / `Withdraw` come from `IERC4626`.

---

## LitePSM.sol

**Concept**: Multiplier-aware USDC ↔ OkuMoney swaps (`mintOkuM`, `redeemOkuM`),
plus usdOku convenience paths (`mintUsdOku`, `redeemUsdOku`) that route through
the vault.

- Conversions use `okuMMultiplier()` and floor in the protocol's favour. They are
  decimals-agnostic: the PSM stores `usdcDecimalMultiplier` from the
  collateral's `decimals()` at init (at most 18). At `m = 1.05`, 100 USDC mints
  ~95.24 OkuM. An output that rounds to zero reverts `AmountTooSmall`; there is no
  other size floor.
- **Redemptions settle from the buffer or revert**
  `InsufficientBuffer(available, required)`, as SVM `lite-psm` does; operators
  keep it funded via `depositBuffer`. `redeemUsdOku` can also revert
  `InsufficientReserves` when vault reserves are below the OkuM the unwrap returns.
- **Blacklist.** `mintUsdOku` and the redeem paths revert `UserBlacklisted`
  (the UsdOku paths move OkuM through the PSM, so OkuMoney's own check never sees
  the user); `mintOkuM` is caught by `OkuMoney.mint`.
- **Guards.** `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku` and
  `depositBuffer` carry `nonReentrant` + `whenNotPaused` +
  `whenNoOverrideThisBlock`; `withdrawUsdc` carries `whenNotPaused` +
  `whenNoOverrideThisBlock` (no `nonReentrant`: no callback surface beyond a USDC
  transfer).
- **`redeemUsdOku`** passes the post-transfer balance delta to `unwrap`, not the
  caller's `usdAmount`, because `OkuDollar.transferFrom` floors the share
  conversion while `unwrap` ceils the burn (see NatSpec). It emits only
  `UsdOkuRedeemed`, with no inner `OkuMRedeemed`.

**No slippage / min-out parameter, deliberately.** The multiplier is monotonically
non-decreasing and the PSM charges no fee, so a delayed or front-run redemption
pays the caller *more*, never less, and a mint preserves dollar value; a min-out
would have nothing to bound. The precondition is **no PSM fee**: if one is ever
introduced, min-out parameters must land in the same change (Accepted Risk #13).

### Admin / Operator Surface

- `depositBuffer(amount)` (`PSM_BUFFER_DEPOSITOR`) and `withdrawUsdc(to, amount)`
  (`PSM_BUFFER_WITHDRAWER`) are both pause-gated and yield-locked, matching SVM
  `deposit_buffer` / `withdraw_buffer`. While paused the buffer can be neither
  refilled nor drained; the operator unpauses first. `withdrawUsdc` reverts
  `InsufficientBuffer` past the balance and has no solvency check against
  outstanding OkuM: the withdrawer is trusted, as on SVM.
- `pause` / `unpause` (`PSM_PAUSER` / `PSM_UNPAUSER`).

Events are declared in
[`src/lib/events/LitePSMEvents.sol`](src/lib/events/LitePSMEvents.sol).

---

## Cross-Chain Transfers (v1: PSM-Mediated)

The full model (SVM legs, conservation invariants, the orchestrator's
pre-flight/recovery runbook) is documented once in
[`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated).
EVM-side facts:

- `LitePSM` is the only `OKUM_MINTER` holder on every chain and the sole
  user-facing mint/burn surface. A transfer is `redeemOkuM` on chain A, then the
  orchestrator's `mintOkuM` on chain B against its own USDC custody.
- `mintOkuM` is **permissionless**; the orchestrator's only privilege on this
  path is that custody, and it rebalances PSM buffers operationally.
- No on-chain signature verification, EIP-712 request, or refund flow in v1.

---

## OverrideBlockGuard

Shared abstract ([`src/lib/OverrideBlockGuard.sol`](src/lib/OverrideBlockGuard.sol))
inherited by `OkuDollar` and `LitePSM`. Continuous accrual has no step to
sandwich, so it protects **only** the emergency override `setOkuMMultiplier`,
which alone stamps `lastOverrideBlock`: in that block every guarded
operation (mint/redeem, wrap/unwrap, buffer deposit/withdraw) reverts
`OverrideInProgress`; transfers are unaffected. It is **forward-only**: a mint
one block *before* the override plus a redeem one block after is not blocked.
See Accepted Risk #11 for the residual and the pause-around-the-override
mitigation.

---

## Pause Behavior

Each contract holds its own `Pausable` state, and pause is a **full freeze** of
what `whenNotPaused` gates:

- **OkuMoney**: peer-to-peer `transfer` / `transferFrom`, `mint`, and the
  `setOkuMMultiplier` override. `burn` is NOT gated (self-burn works while paused,
  supporting pause-to-blacklist), nor is `blacklist()`.
- **OkuDollar**: `transfer` / `transferFrom`, `wrap`, `unwrap` (and so the 4626
  entry points).
- **LitePSM**: `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`,
  `depositBuffer`, `withdrawUsdc`.

`setOkuMYieldRate` and `setNextOkuMYieldRate` are **decrease-only while paused**:
both compare the new rate against `okuMEffectiveRatePerSecond()` (not raw
storage) and revert `EnforcedPause` on an increase, so operators can zero or lower
the rate during an incident but cannot stage or activate a higher one while
users cannot exit.

---

## Role Grants Policy

Every contract's `initialize` grants its **full** role set to `admin` (the
deployer). The deploy script itself sends only `OKUM_MINTER` / `OKUM_BURNER` to
`LitePSM` (§ Deployment & Address Book); the admin then redistributes operational
roles to multisigs and bots via `grantRoles.ts` or `grantRolesMainnet.ts`.

**Roles are granted per contract.** OkuDollar reuses the names
`OKUM_BLACKLISTER` / `OKUM_UNBLACKLISTER` but has its own AccessControl mappings,
so each must be granted on OkuMoney **and** OkuDollar; one grant does not cover
both tokens. The vault roles are `VAULT_UPGRADER`, `VAULT_PAUSER`,
`VAULT_UNPAUSER` and `VAULT_RESCUER`; there is deliberately no vault rate manager or
reserve-manager role (§ Dual-Token Shared-Multiplier Model).

The two scripts are NOT interchangeable. They implement different threat models:

| | `grantRoles.ts` | `grantRolesMainnet.ts` |
|---|---|---|
| Target | `MASTER_EOA` (single testnet operator key) | Cold Multisig / Warm Multisig / Orchestrator (3-key topology, from `MAINNET_COLD_MULTISIG` / `MAINNET_WARM_MULTISIG` / `MAINNET_ORCHESTRATOR` env vars) |
| Grants | The operational (non-admin, non-upgrader) roles in its `ROLE_MAP`, including `OKUM_MINTER` / `OKUM_BURNER` / `OKUM_ALLOWANCE_MANAGER` / `OKUM_CAP_MANAGER`, plus a `configureMinterAllowance` call so the mint grant is usable | The production RBAC split in its `buildRoleMap` (see [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md)) |
| `DEFAULT_ADMIN_ROLE` / `*_UPGRADER` | Never granted: stays on the deployer | Cold Multisig only; deployer's admin is revoked as the script's final step |
| Runs on mainnet? | **Refuses unconditionally** (see its NatSpec header) | Yes (its purpose) |

Two EVM-specific points; the per-role blast radius is canonical in
[`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md):

- **`OKUM_MINTER` / `OKUM_BURNER` are never held by an EOA in the production
  model**: only `LitePSM` holds them. `grantRoles.ts` breaks this deliberately,
  on testnet only, to give an operator SVM-equivalent direct mint/burn; that is
  why it refuses to broadcast on any mainnet network instead of offering an
  override.
- **A role grant alone does not enable minting.** `OkuMoney.mint` gates on
  *both* `onlyRole(OKUM_MINTER)` and the `minterAllowance` mapping, which
  `initialize` populates for nobody. A grant without `configureMinterAllowance`
  still reverts `ExceedsAllowance`.

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
Verified operationally by `scripts/operator/checkMultiplierDrift.ts`; **nothing
on-chain enforces it** (Accepted Risk #9).

**Vault**
```
totalOkuMReserves() >= totalUsdShares                           // Collateralization is exactly 1.0
reservesDollarValue + <rounding tolerance> >= totalSupply       // Dollar-denominated restatement
unwrap(wrap(okuMAmount)) >= okuMAmount - 1                      // Round-trip accuracy
totalOkuMReserves() == OkuMoney.balanceOf(address(okuDollar))   // Reserve accounting
```
The first line is exact by construction; what the suite checks is that no code
path moves out OkuM that backs live shares (`rescueDonation` is the one path that
touches reserves directly).

**Minter allowance**
```
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                            // Burns don't restore allowance
```

**PSM**
```
okuMoney.balanceOf(litePsm) <= 1 wei                            // No stale OkuM held between calls
psmUsdcBalance == seed + inflows - outflows                     // USDC accounting is exact, no tolerance
```
A blacklisted user is never paid USDC, and no USDC leaves a paused PSM, whether
through a payout or `withdrawUsdc`.

---

## Accepted Risks

Known issues and design choices explicitly accepted by the protocol team, so a
reviewer does not re-cover them as new findings. Mechanisms are in the contract
NatSpec and the sections above; entries here state the risk, who bears it, and
the mitigation.

### 1. Centralized operator model — no on-chain timelock

OkuMoney v1 ships as a centralized financial product, modelled on similar
yield-bearing stablecoins (Ondo Finance, Circle USDC). No `TimelockController`
sits between the operator multisig and any contract; the cold-multisig quorum is
itself the delay mechanism. Reasoning and per-tier capabilities:
[`../README.md` § Signer trust implications](../README.md#signer-trust-implications);
per-role blast radius: [`AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md).

On-chain bounds on a single-call compromise: `MAX_MULTIPLIER` and `MAX_RATE`
ceilings; monotonic guards (`MultiplierCannotDecrease`, `InvalidRate`,
`RateAlreadyExpired`); and `whenNoOverrideThisBlock` around the emergency
override. Because OkuDollar delegates its multiplier, `OKUM_RATE_MANAGER` governs
**both** tokens' yield from one grant. Every operational role rotates to a
multisig before mainnet launch.

The rate setters and `setOkuMMultiplier` honour **OkuMoney's** pause, not the
PSM's or vault's. Incident response pauses all three contracts together (the
backend coordinates this across every chain); pausing only LitePSM leaves a
compromised `OKUM_RATE_MANAGER` able to move the multiplier.

### 2. Vault reserve-extraction opsec — STRUCTURALLY IMPOSSIBLE

No vault rate manager, reserve-manager or surplus-withdrawal surface exists, so there
is no rate-then-withdraw extraction (collateralization is 1.0 by construction;
§ Dual-Token Shared-Multiplier Model). The nearest surviving surface,
`VAULT_RESCUER.rescueDonation`, is bounded below by `totalUsdShares` and cannot
reach share backing (modulo the 1-wei caveat in 10b).

### 3. USDC peg monitoring — off-chain (no on-chain oracle)

EVM and SVM both monitor the USDC peg entirely off-chain. There is no on-chain
oracle, aggregator or circuit-breaker and no storage reserved for one. The
off-chain orchestrator watches the peg and pauses the PSM on a detected depeg.

### 4. 1-wei share dust in `OkuDollar.transfer`/`transferFrom` under inflated `usdMultiplier`

Both floor the amount-to-share conversion, so when `usdMultiplier > 1e18`
repeated calls against one permit allowance may under-consume ~1 share per call.
The drift favours the holder; integrators batching against one allowance should
budget for it. A nonzero amount that floors to zero shares reverts
`AmountTooSmall`. `Transfer.value` is advisory, not an accounting record: read
`balanceOf()` (worked counterexample in the `OkuDollar.transfer` NatSpec).

### 5. `OkuDollar._update` ERC-20 tripwires

`_update` unconditionally reverts (`UseWrapInstead` / `UseUnwrapInstead` /
`OkuDollarDoesNotUseInternalUpdate`). Nothing calls the inherited `_mint` /
`_burn`; the reverts only catch a future upgrade that routes through `_update` by
mistake, which is why those arms are uncovered (§ Forge coverage notes).

### 6. No on-chain bridge

There is no bridge contract, adapter, interface or role constant in `src/`.
Cross-chain transfers are orchestrator-mediated PSM mint/redeem, so replay
protection, refunds and rate-limiting are off-chain responsibilities
(§ Cross-Chain Transfers).

### 7. Negative yield is inexpressible

The multiplier is **monotonic**: `setOkuMYieldRate` rejects `newRate < PRECISION`
(`InvalidRate`) and `setOkuMMultiplier` rejects any non-increasing value
(`MultiplierCannotDecrease`), so a loss has no on-chain representation.
Rear-facing accounting pays out only what was already measured, so a realised
loss in a closed epoch surfaces as a concrete number.

**Only available response:** set the rate to `PRECISION` (0% APY) and hold until
later positive yield absorbs the loss. `realisedYieldToRatePerSecond`
(`packages/yield-tooling/src/yieldRate.ts`) throws on a negative realised yield
rather than clamping, so the operator must make that decision explicitly.

### 8. ERC-8056 is a Draft standard

The four interface IDs in § ERC-8056 come from the current draft and **may change
before Final**, which would change `supportsInterface()` results; an integrator
hardcoding today's IDs would break. Adopted deliberately ahead of Final (SVM's
Token-2022 `ScaledUiAmount` fills this role there). A Foundry test pins the hex
values against the compiler-computed IDs, so a local signature change fails
loudly, but nothing can predict the Final IDs. The two deviations from the
EIP (`UIMultiplierUpdated` only on rate-schedule changes; a *projected*
`newUIMultiplier()`) are our reading of a spec written for discrete steps, so
standards-only consumers should poll.

### 9. No on-chain enforcement of cross-chain rate equality

Each chain's `OkuMoney` is fully independent: no messaging, light client or state
proof. That every chain returns the same `okuMMultiplier()` rests entirely on the
**orchestrator pushing identical schedule state everywhere**; nothing in `src/`
can detect or reject a divergent schedule. The same holds on SVM, which runs the
same schedule at `PRECISION = 1e18` over a line-for-line port of `MathLib.sol`.

**Mitigations (all off-chain):**

- Rates are derived from a declared APY via `packages/yield-tooling` (re-exported
  by `scripts/utils/yieldRate.ts`), so every chain receives a byte-identical
  integer.
- `setNextOkuMYieldRate` needs no transaction at the epoch boundary, so the
  highest-risk moment has no broadcast to get wrong.
- `scripts/operator/checkMultiplierDrift.ts` compares multiplier, rate, `rateEnd`
  and pending rate across every configured EVM chain **and SVM**, exiting non-zero
  on mismatch. Schedule-field equality is the exact check; the multiplier spread
  is reported with read skew annotated, because SVM's `Clock::unix_timestamp` can
  lag wall clock (see [`SVM/README.md` § Accepted Risks](../SVM/README.md#accepted-risks)).
- `test/differential/` holds the Solidity, Rust and TypeScript implementations to
  a committed corpus generated from the Solidity (reverts included);
  `npm run test:differential` from the repo root regenerates and replays it.

**Divergence is one-way.** The multiplier is monotonic, so a chain that ran hot
cannot be corrected downward; the only remedy is to run the laggards hot until
they catch up.

### 10. Known issues

**10a. ERC-4626 `mint()` / `withdraw()` do not guarantee exact output.** The spec
requires exactly `shares` / exactly `assets`, but both are thin wrappers over
`wrap`/`unwrap`'s floor-rounded conversions, so the actual amount can differ by up
to 1 wei in the vault's favour. Exact conformance on a continuously repricing
share token would need iterative correction; accepted as a rounding-direction
tradeoff consistent with the floor-favours-vault convention. `deposit()` /
`redeem()` are exact.

**10b. `rescueDonation` is 1-wei-per-unwrap optimistic.** It treats everything
above `totalUsdShares` as donation, but `unwrap`'s ceil-burn / floor-return
asymmetry can leave reserves up to 1 wei above `totalUsdShares` per unwrap, and
that dust is rescuable. Directionally safe (it favours the protocol, and the
rescuer is a trusted cold-multisig role), but the accounting is optimistic rather
than exact.

**10c. ERC-4626 `totalAssets()` includes unbacked donations.** By spec it returns
everything the vault holds, including OkuM donated directly (see 10b) that backs no
share. An integrator computing price as `totalAssets() / totalSupply()` gets a
value inflated by any outstanding donation. The vault does not use that ratio
(conversions use the shared multiplier), so the true price stays $1.00; the ratio
re-converges once `rescueDonation` clears the dust.

**10d. LitePSM has no token-rescue path.** OkuM or UsdOku sent to the PSM directly
is recoverable only by upgrade. `redeemUsdOku` can also leave up to one internal
share of UsdOku on the PSM per call (`transferFrom` floors the shares moved, `unwrap`
ceils the shares burned). Neither affects redemptions: the PSM never reads these
balances.

### 11. Discrete-tick MEV survives only on the emergency override

There is no discrete-tick sandwich vector on the normal yield path:
`okuMMultiplier()` streams and `setOkuMYieldRate` re-anchors to the current value,
so there is no step to straddle (§ Why streaming, not discrete ticks). The vector
survives **only** on `setOkuMMultiplier`, the one function that creates a
discontinuity, which is why `lastOverrideBlock` and
`whenNoOverrideThisBlock` exist (§ OverrideBlockGuard).

**Two distinct residuals, both unmitigated on-chain:**

- **Cross-block manipulation by the override holder** (`OKUM_RATE_MANAGER`): an insider
  positions ahead of their own call. Not mitigated on-chain, for the same reason
  as Risk 1.
- **Third-party front-run of an honest override** — no role required. The guard is
  **forward-only**: the block is stamped *inside* `setOkuMMultiplier`, so a
  transaction ordered before it in the same block is not blocked. A mint in block
  N ahead of an observed override, followed by a redeem in block N+1, captures the
  whole step for one block of capital exposure, with no PSM fee to price it.

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

### 12. Blacklist parity with Circle FiatToken

The goal is Circle FiatToken's blacklist posture (`FiatTokenV1/V2.sol`), the
reference both tokens follow. Across both tokens a blacklisted address cannot
successfully call any state-changing function as sender, recipient **or approved
spender**: `approve`/`permit` (owner and spender), `transfer`, `transferFrom`
(including the spender), OkuDollar's ERC-4626 `withdraw`/`redeem` (including a
third-party spender), and `mint` (including the minter). `blacklist()` works while
paused. OkuDollar honours OkuMoney's blacklist as well as its own.
`maxDeposit`/`maxWithdraw`/`maxRedeem` report 0 for a blacklisted or paused
account. PSM behaviour: § LitePSM.sol.

**Deliberate literal matches that look like footguns.** `OkuMoney.mint` checks the
**minter's** blacklist, as Circle's does. Here `OKUM_MINTER` is protocol
infrastructure (`LitePSM`), so blacklisting the PSM proxy would brick all minting.
Kept for parity with the reference.

**Unmatched, deliberately, same as Circle.** Blacklisting does not retroactively
revoke allowances granted earlier (unbounded on-chain for either project), and
there is no seizure/clawback function (USDT and Paxos add one; Circle does not). A
blacklisted spender cannot *exercise* an old allowance, but if later unblacklisted
it is live again without a new `approve`. Mitigation: compliance watches
`Approval` events for the spender and has grantors `approve(spender, 0)` if
exposure is a concern.

### 13. The PSM has no slippage protection — deliberately

`LitePSM`'s four user entry points take no `minOut`/`maxIn`: the multiplier is
monotonically non-decreasing and the PSM charges no fee (argument and fee
precondition: § LitePSM.sol). The only residual is mint-side truncation: on
18-decimal collateral a mint forfeits up to `ceil(m / PRECISION)` wei, rounding to
the protocol. `OkuDollar.wrap`'s `minAmountOut` / `OutputBelowMinimum` is a
separate, reachable check and is unaffected.

---

## Testing

Foundry is the authoritative functional suite. Hardhat is reserved for
fork-dependent and multi-contract scenario work, and for off-chain
script/simulation logic that has no Solidity counterpart. New unit and
invariant tests belong in Foundry.

### Layout

| Directory | Purpose |
|---|---|
| `test/psm` | `LitePSM`: unit, fuzz, and reentrancy tests. |
| `test/invariants` | Stateful invariant suites (supply, vault backing, multiplier, PSM, minter allowances) and `HandlerSanity.t.sol`, which checks that the handlers actually reach their target calls. |
| `test/token` | `OkuMoney` and `OkuDollar` unit and fuzz tests, including the rate-schedule suite. |
| `test/lib` | `MathLib`, `ReentrancyGuard`, and ERC-7201 slot tests. |
| `test/differential` | Emits the cross-language corpus (`vectors.jsonl`) that the Rust and TypeScript multiplier implementations are checked against. |
| `test/hardhat/unit` | Pure-TS tests of the off-chain rate, epoch, and operator-script logic. |
| `test/hardhat/drill` | Runs the real `scripts/deploy/index.ts` against a local fork and asserts the resulting chain (deployed proxies, address book, role matrix, absence of privileged roles on outsiders, a live PSM mint); then exercises every operator-script lever in-process against that same deploy. |
| `test/hardhat/fork` | Protocol against real mainnet / Sepolia state that Foundry cannot reach in CI. |
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
forge fmt --check                                    # CI gate: formatting
forge coverage --no-match-coverage 'test/|script/' --report summary   # what CI gates on

npx hardhat test                                     # whole Hardhat suite
npm run test:unit                                    # unit + simulation + drill suites
npx hardhat test test/hardhat/drill/*.ts             # deploy drill + operator drill only
```

`npm run test:all` runs `forge test` and then `hardhat test`.

**Fork RPC.** The fork suites and the drills (which reset and deploy against
the configured fork) need an archive RPC (§ Quick Start). The genuinely offline
subset: `npx hardhat test test/hardhat/unit/*.ts test/hardhat/simulation/*.ts`.

---

## Forge coverage notes

The CI gates are defined in `.github/workflows/test.yml` (§ Quick Start). The
branch gate is on the total rather than per file because a few branches in
`src/token/OkuDollar.sol` are provably unreachable (below). Coverage figures come
from `forge coverage` on each run; none are recorded here.

### Uncovered lines and branches (intentional)

Each is a `revert` arm that no call path can drive. Line numbers are omitted
deliberately; every symbol is unique within its function. Guards that only an
internal caller could trip are tested through a harness (`test/mocks/OkuDollarHarness.sol`)
instead of being listed here.

| Location | Guard | Why unreachable |
|---|---|---|
| `OkuDollar._update` | `UseWrapInstead` / `UseUnwrapInstead` / `OkuDollarDoesNotUseInternalUpdate` | Nothing invokes the inherited `_mint` / `_burn`; the override is `pure` and unconditionally reverts (Accepted Risk #5). A tripwire against a future refactor. |
| `LitePSM.redeemUsdOku` | `received == 0` (balance delta after pulling `usdAmount` of `OkuDollar`) | `OkuDollar.transferFrom` reverts `AmountTooSmall` itself whenever the share conversion floors to zero (Accepted Risk #4), and `multiplier >= PRECISION` means a nonzero share delta implies a nonzero dollar delta. Defence-in-depth against either guard changing independently. |
| `OkuDollar.wrap` | `sharesToMint == 0` | `wrap` rejects `okuMAmount == 0` at entry and `sharesToMint == actualReceived`, so zero needs a 100 % transfer-fee asset; the typed `IOkuMoney` wired at init is not fee-on-transfer. Kept because the balance-delta pattern exists to tolerate one. |

These are guards against an assumption about a collaborator that a future change
could break. Guards against arithmetic that cannot happen by construction do not
belong here; they should be removed from `src/`.

### Where each sensitive area is tested

| Topic | Where |
|---|---|
| `OkuDollar.rescueDonation` backing floor and role gate | `test/token/OkuDollar.t.sol` |
| `OkuDollar` share rounding, blacklist, pause, wrap / unwrap | `test/token/OkuDollar.t.sol`, `test/token/OkuDollar.fuzz.t.sol` |
| `LitePSM` redeem paths (buffer-covered vs. `InsufficientBuffer`, zero-output `AmountTooSmall`, `OkuMRedeemed` suppression, multi-decimal collateral) | `test/psm/LitePSM.t.sol`, `test/psm/LitePSMRebasingRedeem.t.sol`, `test/psm/LitePSM.fuzz.t.sol` |
| `LitePSM` buffer functions are pause-gated and yield-locked | `test/psm/LitePSM.t.sol`: `test_DepositBuffer_RevertsWhenPaused`, `test_DepositBuffer_RevertsInOverrideBlock`, `test_WithdrawUSDC_RevertsWhenPaused`, `test_WithdrawUSDC_RevertsInOverrideBlock` |
| Override front-run residual and its pause ceremony (Accepted Risk #11) | `test/psm/LitePSM.t.sol`: `test_SetOkuMMultiplier_PauseCeremony_ClosesFrontRunWindow` |
| No PSM slippage parameter (Accepted Risk #13) | `test/psm/LitePSM.t.sol`: `test_NoSlippageParam_RedeemOutputIsMonotoneInMultiplier` |
| Reentrancy through the PSM | `test/psm/Reentrancy.t.sol`, `test/lib/ReentrancyGuard.t.sol` |
| `OkuMoney` rate schedule: `setOkuMYieldRate` continuity and non-stamping, `setNextOkuMYieldRate` boundaries, expiry with no successor | `test/token/OkuMoney.t.sol`, `test/token/OkuMoney.fuzz.t.sol` |
| ERC-8056 interface IDs (§ ERC-8056, Accepted Risk #8) | `test/token/OkuMoney.t.sol`: `test_InterfaceIds_MatchDocumentedHexValues` |
| Multiplier math and cross-language agreement | `test/lib/MathLib.t.sol`, `test/differential/GenerateVectors.t.sol` |
| Storage-slot derivation (ERC-7201) | `test/lib/ERC7201Slots.t.sol` |
| System-wide properties (supply, backing, multiplier, minter allowances) | `test/invariants/*` |

---

## Dependencies — pinned for audit

Exact versions live in the files, not here:

- **Solidity libraries:** `foundry.lock` pins the git commit of each `lib/`
  submodule.
- **Node packages:** `EVM/package.json` and `package-lock.json`. The
  compile-affecting packages (OpenZeppelin, Hardhat and its plugins, TypeChain,
  ethers) use exact versions; a few tooling and off-chain dependencies use ranges
  held by the lockfile.
- **Compiler settings:** `foundry.toml` and `hardhat.config.ts` set the `solc`
  version, `evm_version`, and `bytecode_hash` / `bytecodeHash` to `"none"`.

Why:

- **One OpenZeppelin release on both compile paths**, pinned exactly: the Foundry
  submodules and the Node packages must be the same release so both toolchains
  compile identical sources. The proxies are UUPS deployed through
  `@openzeppelin/hardhat-upgrades`, so an OpenZeppelin bump means re-reading its
  breaking-change notes against `src/` and re-running both suites, including the
  happy-path and deploy drill.
- **`bytecode_hash = "none"`** keeps the CREATE2 address a function of code
  semantics and the compiler only (§ Deterministic addresses). The two settings
  must agree or the toolchains produce different addresses.

### `npm audit` posture

`npm audit` reports vulnerabilities in transitive dev dependencies pulled in by
`@nomicfoundation/hardhat-toolbox` and the OpenZeppelin upgrades plugin. They are JavaScript dev
tooling only: they do not enter production bytecode.

---

## Pointers

- **Workspace overview:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **Authority matrix:** [`../AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md)
- **Epoch accounting:** [`docs/epoch-accounting.md`](docs/epoch-accounting.md)
- **SVM-side docs:** [`../SVM/README.md`](../SVM/README.md)
