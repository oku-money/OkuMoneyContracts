# OkuMoney Protocol

Yield-bearing stablecoin infrastructure backed by US Treasury Bills.
Centralized B2B product — registered MSB, not a DeFi protocol. EVM +
SVM in parallel, off-chain orchestrator coordinating both.

> **For auditors:** start with the per-side READMEs ([`EVM/README.md`](EVM/README.md),
> [`SVM/README.md`](SVM/README.md)) and the in-repo audit packages
> ([`EVM/audit/README.md`](EVM/audit/README.md),
> [`SVM/oku-programs/audit/README.md`](SVM/oku-programs/audit/README.md)).
> Open items live in [`TRACKER.md`](TRACKER.md).

---

## Design philosophy

**Off-chain orchestrator architecture** for maximum operational
agility:

- **Orchestrator** coordinates all protocol operations. Never stores
  private keys — constructs payloads and requests Cloud KMS signatures.
- **Direct chain operations** — interacts directly with contracts via
  KMS-signed transactions.
- **Trust model** — openly centralized product for safe government
  yield. Users trust Oku Money to manage RWA backing and operate
  infrastructure responsibly.
- **Legal framework** — registered with FinCEN as an MSB. Licensed
  as a money transmitter in states where we onboard users.

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

---

## Dual-token split-economy model

Two tokens with independent economics, deployed on every chain:

| Token | Type | Yield | Purpose |
|---|---|---|---|
| **OkuMoney (OkuM)** | Non-rebasing | Rear-facing (realized T-Bill returns) | DeFi, bridging, protocol integrations |
| **OkuDollar (usdOku)** | Rebasing ($1 peg) | Forward-facing (policy rate set by Oku) | Retail UX, "balance grows" experience |

**OkuMoney** is the solvency anchor — it only distributes yield
already earned. `balanceOf()` returns a static raw token count.
Price appreciation is tracked separately via `okuMMultiplier()` (EVM)
/ `PsmConfig.oku_m_price` (SVM), a stored value updated discretely
by the orchestrator.

**OkuDollar** is a policy lever — Oku sets the yield rate
independently. On EVM, `balanceOf()` grows every second via
continuous `_rpow` streaming; on SVM it updates discretely (Solana
has no continuous-accrual token extension). OkuDollar holds OkuMoney
as reserves. The spread between the two rates determines
collateralization and protocol revenue.

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

---

## On-chain components

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
|---|---|
| **OkuMoney** | Non-rebasing base token — static balance, price appreciates via stored `okuMMultiplier`. |
| **OkuDollar** | Rebasing $1-pegged stablecoin — balance grows, backed by OkuMoney reserves. |
| **LitePSM** | Peg Stability Module — price-aware USDC ↔ OkuM. Sole user-facing mint/burn surface. EVM adds `mintUsdOku` / `redeemUsdOku` convenience flows; SVM composes these off-chain in the SDK. |
| **RedemptionQueue** | FIFO queue when PSM buffer is insufficient. |

---

## Yield distribution & sandwich prevention

OkuMoney's multiplier is updated discretely by the orchestrator via
`distributeYield()` or `setOkuMMultiplier()`. To prevent sandwich
attacks around discrete updates, a single-block lock is enforced:

- Both write functions set `lastYieldDistributionBlock` (EVM) /
  `last_yield_distribution_slot` (SVM).
- PSM and vault operations revert if executed in the same block/slot
  as a multiplier update.
- The lock auto-releases in subsequent blocks/slots — no backend
  changes needed.

OkuDollar uses the same fence on its own `usd_multiplier` updates
(cycle 4 / OKUD-06 added the self-fence on SVM).

---

## PSM (Peg Stability Module)

Price-aware USDC ↔ OkuMoney swaps:

```
mintOkuM:      okuMAmount = usdcValue × PRECISION / okuMMultiplier()
redeemOkuM:    usdcAmount = okuMAmount × okuMMultiplier() / PRECISION
```

On EVM, LitePSM ships convenience functions that route through the
vault for single-transaction usdOku ↔ USDC:

```
mintUsdOku:    USDC → PSM mints OkuM → wraps into vault → usdOku to user
redeemUsdOku:  usdOku → unwrap to OkuM → redeem for USDC (or queue if buffer empty)
```

On SVM these compositions live in the off-chain SDK (multi-instruction
client-side builds), since the `oku-bridge-router` convenience program
was removed in the noBridge refactor.

---

## Cross-chain transfers (v1: PSM-mediated, off-chain orchestrated)

Both EVM and SVM ship without on-chain bridging in v1. Cross-chain
transfers are orchestrated off-chain through PSM mint/burn on each
chain:

1. User redeems OkuM for USDC on chain A via `LitePSM.redeemOkuM`
   (EVM) / `lite_psm::redeem_oku_m` (SVM) — or sends USDC to the
   orchestrator's off-chain rail directly.
2. Orchestrator observes the burn / off-chain instruction, waits for
   finality, then performs an equivalent USDC-funded `mintOkuM` /
   `mint_oku_m` on chain B crediting the recipient.
3. PSM USDC buffers on each chain are rebalanced operationally by
   treasury.

LitePSM (EVM) / lite-psm (SVM) holds the OkuMoney mint authority on
every chain — it is the sole user-facing mint/burn surface in v1.

**`mintOkuM` is permissionless.** Any address with USDC can call it;
the orchestrator does NOT hold `OKUM_MINTER`. Orchestrator key
compromise grants no special mint privilege beyond the orchestrator's
USDC custody.

**Cross-chain USDC flow conservation invariant:**

```
|USDC_redeemed_A - USDC_minted_B| ≤ 1 USDC-unit per bridge
Cumulative drift across N bridges ≤ N USDC-units
```

Tested by `EVM/test/hardhat/scenarios/RealWorldUsage.ts`
(cross-chain bridge scenarios) and
`SVM/oku-programs/tests/bankrun/crossChainBridging.ts`.

OkuBridge (proprietary burn-and-mint) and third-party rails (NTT,
CCIP) are planned post-launch and will be introduced as additive
components:

- **EVM** retains role constants (`BRIDGE_*`, `ROUTER_*`, `NTT_*`)
  and integration interfaces (`IOkuBridgeNative`, `IBridgeAdapter`)
  in the tree as reserved seams so re-introduction does not require
  modifying existing contracts.
- **SVM** has no reserved enum variants — a future on-chain bridge
  will ship as a brand-new program granted `OKUM_MINTER` via PSM,
  the same additive shape as the EVM path.

### Orchestrator runbook

The orchestrator coordinates every cross-chain bridge. The operating
procedures below were previously in a standalone `docs/orchestrator-runbook.md`
and are consolidated here.

#### Pre-flight checklist (per bridge)

Verify on **both source and destination chains** before submitting:

| Check | EVM | SVM |
|---|---|---|
| Destination PSM not paused | `LitePSM.paused()` | `psm.account.psmConfig.fetch(...).isPaused` |
| Destination supply headroom | `OkuMoney.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuMoney.minterAllowance(psm) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user OkuM balance | `OkuMoney.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMoneyAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(psm) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` |
| Recipient ATA not frozen | `OkuMoney.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |
| Oracle peg-band fresh (if wired) | `OracleRelay.checkUsdcPeg()` | `helpers::oracle_relay::check_usdc_peg` |

If source PSM buffer is insufficient, the redeem succeeds but the
OkuM is escrowed in the redemption queue. **The orchestrator must
wait for `processQueue` to pay out USDC before completing the
destination mint leg.** Poll queue state to detect:

```
EVM:  queue.queueHead() < queue.queueTail()  → entries pending
SVM:  redemptionQueue.head < redemptionQueue.tail  → entries pending
```

The orchestrator can accelerate payment by calling `depositBuffer`
to fund the queue, then `processQueue`.

#### Mid-flight failure recovery

| Failure mode | Recovery |
|---|---|
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap / oracle), wait for the blocking condition to clear, retry `mintOkuM` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain OkuM is already burned. |
| Source redeem was queued | Don't mint on destination until USDC is in hand. Poll queue state every ~30 s; call `depositBuffer` + `processQueue` to accelerate. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Multiplier-tick sequencing across chains

The OkuM price (`okuMMultiplier` EVM / `oku_m_price` SVM) is updated
discretely by `OKUM_REBASER`. To prevent chain divergence from
causing accounting errors:

1. Fire `setOkuMMultiplier` / `set_oku_m_price` on **all chains in
   the same off-chain batch**, within one slot/block of each other.
2. If sequencing diverges, **per-bridge dollar value is still
   conserved** — the PSM uses the current multiplier at redemption
   time on source and at mint time on destination. The recipient
   may receive a slightly different raw OkuM amount; dollar value
   is equivalent.
3. After a price tick, wait one slot (SVM) / one block (EVM) before
   bridging to avoid `YieldDistributionInProgress`.

#### Minter allowance rotation policy

`minterAllowance` on `OkuMoney` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds how many OkuM the PSM can mint before an explicit
refresh.

- **Testnet:** `minterAllowance == maxSupply == 1B OkuM` — effectively uncapped for dev.
- **Production:** ~ **1 % of weekly bridging volume**, rotated on a **weekly cadence** by `OKUM_ALLOWANCE_MANAGER` (cold multisig). Bounds a single-week worst-case mint by a compromised PSM contract or orchestrator USDC custody.

EVM rotation:

```bash
NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts \
  --network base --minter <psm-address> --allowance 10000000000000000000000000 --yes-mainnet
```

SVM rotation:

```bash
NETWORK=mainnet-beta tsx scripts/admin/set-minter-allowance.ts \
  --amount=10000000 --yes-i-mean-it-on-mainnet
```

Monitoring alerts: `minterAllowance < 10 %` of weekly throughput; or
not rotated in > 7 days.

#### Monitoring SLAs

| Metric | Alert threshold |
|---|---|
| Orchestrator OkuM float | Non-zero for > 1 h between batch cycles |
| Queue depth | Oldest pending entry > 24 h unfilled |
| Oracle staleness | `updatedAt` within 80 % of `stalenessThreshold` |
| PSM buffer | < 2 × expected daily redemption volume |
| Minter allowance | < 10 % of weekly throughput estimate |
| Pause state | PSM paused for > 15 min unexpectedly |

All metrics on a 1-min cadence. PagerDuty for "OkuM float" and
"queue > 24 h"; Slack warning for the rest.

#### Orchestrator security

- Orchestrator key has **NO special minting authority**. Compromise
  does not allow minting beyond the key's USDC holdings.
- Orchestrator holds operational roles: `OKUM_REBASER`,
  `VAULT_REBASER`, `PSM_QUEUE_PROCESSOR`, `PSM_BUFFER_DEPOSITOR`.
  Compromise allows multiplier manipulation, buffer drain, queue
  skipping — material but bounded. Cold multisig controls
  `*_UNPAUSER` and `*_BUFFER_WITHDRAWER` (more dangerous).
- Rotate the orchestrator key immediately on suspected compromise.
  Pausing both PSMs (warm multisig) is the emergency lever.
- **No two concurrent orchestrator instances** should process the
  same user bridge request. Off-chain dedup (nonces, event-ID
  tracking) is the orchestrator's responsibility.

---

## RBAC (role-based access control)

One role per action. No role performs more than one function.

| Entity | Roles |
|---|---|
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, ORACLE_MANAGER, RESERVE_MANAGER |
| Warm Multisig | all PAUSER, all BLACKLISTER |
| Orchestrator | OKUM_REBASER, VAULT_REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR |
| LitePSM | OKUM_MINTER, OKUM_BURNER (cycle 4: split on EVM) |
| RedemptionQueue | OKUM_BURNER (cycle 4) |

The `BRIDGE_*`, `ROUTER_*`, and `NTT_*` roles defined in
`EVM/src/lib/Roles.sol` are reserved for future re-introduction of
OkuBridge / NTT / CCIP — not granted by v1 deploy scripts.

### Signer trust implications

okuMoney is a **centralized financial product**. Users trust Oku
Money as an institution — the same way they trust Circle for USDC or
Paxos for PYUSD. On-chain RBAC enforces *separation of duties within
the company*, not protection *against* the company.

#### Cold Multisig (Squads / Safe, hardware-backed quorum)

**Can:**
- Upgrade any contract (EVM: UUPS `_authorizeUpgrade`; SVM: BPF
  program upgrade authority). A malicious or erroneous upgrade can
  replace all logic — the highest-impact key.
- Set the oracle feed address and staleness parameters. A swap to
  an attacker-controlled feed could allow unbacked mints up to
  `maxSupply`.
- Configure `maxSupply` and `minterAllowance`. Raising allowance to
  the cap and minting up to it is the worst-case mint outcome.
- Drain the USDC buffer (`withdrawUsdc` / `withdraw_buffer`) down
  to the amount needed to cover pending queue obligations.
- Withdraw OkuMoney surplus from the vault (`withdrawSurplus` /
  `withdraw_reserves`) down to the `minCollateralRatio` floor.
- Grant any role to any address (DEFAULT_ADMIN_ROLE / role_admin SVM).
- Unblacklist, unpause, unfreeze ATAs.
- Rotate operational authority pubkeys.

**Cannot (on-chain code prevents even at quorum):**
- Mint above `maxSupply` or `minterAllowance`.
- Set `okuMMultiplier` / `oku_m_price` below current (monotonic).
- Set `usdMultiplier` / `usd_multiplier` below current.
- Push the vault below `minCollateralRatio` via surplus withdrawal.
- Set `maxSupply` below current `totalSupply`.
- Set staleness threshold outside `[60 s, 7 days]`.
- Set `minCollateralRatio` below the 90 % hard floor.

#### Warm Multisig (lower-quorum, faster to sign)

**Can:**
- Pause all protocol contracts, halting mint / redeem / bridging.
- Blacklist any address on OkuMoney and OkuDollar.
- On SVM: freeze any OkuMoney ATA via Token-2022 freeze authority.

**Cannot:**
- Unpause or unblacklist (cold multisig only). Pause is a one-way
  door for the warm key.
- Access any funds or parameters.

#### Orchestrator (KMS-backed, automated)

**Can:**
- Update `okuMMultiplier` / `oku_m_price` (non-decreasing, bounded
  by `MAX_MULTIPLIER`). A compromised rebaser key can ratchet the
  multiplier toward the ceiling, inflating OkuM's dollar value
  beyond the actual T-Bill backing rate.
- Update `usdMultiplier` / `usd_multiplier` similarly (bounded by
  `MAX_USD_MULTIPLIER`). An extreme bump would push the vault
  toward the `minCollateralRatio` floor, requiring Oku to deposit
  more reserves.
- Process the redemption queue.
- Deposit USDC to the PSM buffer.
- Call `mintOkuM` / `redeemOkuM` as a normal user
  (**permissionless** — the orchestrator holds no special mint
  authority, only USDC custody).

**Cannot:**
- Mint OkuM directly. `OKUM_MINTER` is held by the PSM /
  RedemptionQueue contracts.
- Access admin parameters, role grants, upgrades.
- Drain the USDC buffer (cold-multisig BUFFER_WITHDRAWER only).

#### Protocol contracts (LitePSM, RedemptionQueue)

Hold `OKUM_MINTER` / `OKUM_BURNER`. Mint via `OkuMoney.mint()` only
during `mintOkuM` / `processQueue`, gated by per-minter
`minterAllowance` and the global `maxSupply` cap. Burn (cycle-4
split role) only via `OkuMoney.burn()` from inside `redeemOkuM` /
`processQueue`.

**On timelocks:** okuMoney is centralized US-regulated, not
decentralized. Industry peers (USDC, USDT, USDP, PYUSD, FDUSD) do
not use on-chain timelocks; they rely on operational, procedural,
and regulatory controls. Trust is anchored in Oku Money as a legal
entity, its MSB registration, and its internal control framework —
not in on-chain delay mechanics. The cold-multisig quorum
requirement is itself the delay mechanism. **Timelocks are not pursued.**

---

## EVM vs SVM at a glance

| Aspect | EVM | SVM |
|---|---|---|
| Language | Solidity 0.8.28 | Rust (Anchor 1.0.2) |
| OkuMoney multiplier | Stored `uint256`, 18 decimals (`okuMMultiplier`) | Stored `u64`, 1e9 precision (`PsmConfig.oku_m_price`, 6-decimal token) |
| OkuDollar multiplier | Continuous `_rpow` streaming | Discrete orchestrator-driven updates |
| Yield lock | `block.number` comparison | `Clock::slot` comparison |
| Token standard | ERC-20 (custom rebasing for OkuDollar) | Token-2022 (both tokens) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | Composed off-chain by the SDK |
| Cross-chain transfers (v1) | Off-chain orchestrator + LitePSM mint/burn | Off-chain orchestrator + lite-psm mint/burn |

**Full cross-chain parity matrix** — constants, roles, pause
semantics, sandwich-fence behaviour, event schema diffs, deliberate
non-parity items — see [`EVM/audit/README.md`](EVM/audit/README.md)
and [`SVM/oku-programs/audit/README.md`](SVM/oku-programs/audit/README.md).

---

## Directory structure

```
contracts/
├── README.md            # this file
├── TRACKER.md           # Open issues + follow-ups (EVM + SVM)
├── EVM/                 # Solidity contracts (Foundry + Hardhat)
│   ├── README.md        # EVM-specific deployment, contracts, runbook
│   ├── src/
│   │   ├── token/       # OkuMoney.sol, OkuDollar.sol
│   │   ├── psm/         # LitePSM.sol, RedemptionQueue.sol
│   │   ├── oracle/      # OracleRelay.sol, IOracleRelay.sol
│   │   ├── interfaces/  # IOkuMoney.sol, IOkuDollar.sol, IOkuBridgeNative.sol (reserved)
│   │   └── lib/         # Roles, Constants, MathLib, events
│   ├── test/            # Foundry + Hardhat suites
│   ├── scripts/         # Deploy + operator scripts
│   └── audit/           # In-repo audit package (accepted risks, snapshots)
├── SVM/                 # Anchor programs (Rust)
│   ├── README.md        # SVM-specific runbook, divergence catalogue, deployment
│   └── oku-programs/
│       ├── programs/
│       │   ├── lite-psm/    # PSM + queue + yield ops + compliance + oracle relay
│       │   └── oku-dollar/  # Rebasing vault
│       ├── crates/
│       │   └── oku-shared/  # Pure-Rust shared constants + math + vault math + yield lock
│       ├── tests/
│       ├── scripts/
│       ├── deployments/     # Per-network deployment records
│       ├── audit/           # In-repo audit package
│       └── keys/            # Local keypair directory (gitignored, see keys/README.md)
├── artifacts/           # Curated ABIs + IDLs for backend / SDK / frontend use
│   ├── evm/             # Slim Hardhat artifacts (abi + bytecode) per contract
│   ├── svm/             # Anchor IDL JSON per program
│   └── README.md        # Consumption docs for downstream services
└── testnet-addresses.json  # Canonical live deployment registry (auto-generated)
```

---

## Deployment runbook

Complete guide for deploying OkuMoney on EVM chains + Solana, and
exercising the on-chain protocol end-to-end. v1 cross-chain transfers
are off-chain orchestrator-mediated (PSM mint/burn) — there is no
on-chain bridge.

> Authoritative deployment state lives in
> [`testnet-addresses.json`](testnet-addresses.json) at the repo root,
> auto-synced by every successful live EVM deploy. Do NOT hand-edit;
> rerun the deploy script to refresh.
>
> Per-chain working address book is at
> [`EVM/scripts/config/addresses.json`](EVM/scripts/config/addresses.json)
> (live `<chain>` keys + `fork:<chain>` namespaces for local-fork runs).

### Prerequisites

**EVM:**
```bash
cd EVM
cp .env.example .env
# PRIVATE_KEY=<deployer key>
# ALCHEMY_API_KEY=<covers Eth/OP/Arb/Base/BSC/Sepolia>
# ETHERSCAN_API_KEY=<single Etherscan V2 key — covers all of the above for verification>
npm install && npx hardhat compile
```

**SVM:**
```bash
cd SVM/oku-programs
cp .env.example .env
solana config set --url devnet
solana-keygen new --outfile ~/.config/solana/id.json   # if needed
npm install && anchor build
```

**(Optional) Surfpool** for SVM local-fork testing:
```bash
curl -sL https://run.surfpool.run/ | bash
```

### Phase 1 — local-fork pre-flight (recommended)

Validates the deploy will succeed against real chain state before
spending real funds. Catches funding shortfalls, RPC quirks, gas
estimation issues.

**EVM local fork** (auto-detects target chain from running node's `eth_chainId`):

```bash
cd EVM

# Terminal 1 — fork target chain (default: sepolia)
FORK_NETWORK=base hh node            # =sepolia, =opSepolia, =mainnet, =optimism, =arbitrum, =base, =bsc

# Terminal 2 — deploy + integration test against the fork
hh run scripts/deploy/index.ts --network localhost
hh run scripts/test/test-onchain.ts --network localhost
```

Deploys MockUSDC, OkuMoney, OkuDollar, RedemptionQueue, LitePSM;
configures all roles + minter allowances (LitePSM + RedemptionQueue
hold `OKUM_MINTER` / `OKUM_BURNER`); verifies deployment state.
Fork-deployed addresses land under `addresses.json["fork:<chain>"]`
so they never collide with live entries.

**SVM local fork (Surfpool):**

```bash
cd SVM/oku-programs
surfpool start --rpc-url https://api.devnet.solana.com   # terminal 1
# Two-phase deploy against the surfpool fork (terminal 2):
NETWORK=devnet-fork npm run deploy:programs:devnet-fork
NETWORK=devnet-fork npm run deploy:init:devnet-fork
NETWORK=devnet-fork npm run test:onchain:fork
```

### Phase 2 — live deploy

**EVM:**

```bash
cd EVM

# Per-network shortcuts (defined in package.json):
npm run deploy:sepolia        # Eth Sepolia
npm run deploy:opSepolia      # OP Sepolia
npm run deploy:baseSepolia    # Base Sepolia
npm run deploy:bscTestnet     # BSC testnet (Chapel)
npm run deploy:base           # Base mainnet
npm run deploy:bsc            # BSC mainnet

# Chains without a pre-baked alias:
hh run scripts/deploy/index.ts --network <chain>
```

The script is **idempotent and resumable**: already-deployed
contracts are reused via the `tryAttach` bytecode check; transient
RPC errors are absorbed by `withRetry` (exponential backoff, up to
5 attempts). Partial-deploy failures: just rerun.

Addresses written to `EVM/scripts/config/addresses.json` under
`"<chain>"` and to repo-root `testnet-addresses.json` under
`"evm.<chain>"`.

**SVM:**

```bash
cd SVM/oku-programs

anchor build
npm run cost                  # estimate one-time rent (~0.067 SOL queue alone)
solana airdrop 5 --url devnet # x2

# Phase 1 — deploy program .so files (writes IDs into deployments/devnet.json)
NETWORK=devnet npm run deploy:programs

# Phase 2 — create tokens + initialize PSM and OkuDollar vault
NETWORK=devnet npm run deploy:init
```

`deploy:programs` prints the freshly-deployed program IDs and the
exact lines to paste into `[programs.devnet]` (or `[programs.mainnet]`).
`[programs.devnet]` and `[programs.localnet]` are kept SEPARATE on
purpose — preserves the option to rotate one cluster without
touching the other. Until `Anchor.toml` matches, the
`[addressBook] WARNING:` block fires on every admin script.

**Stale `deployments/devnet.json` recovery:** if program IDs in the
file no longer match `Anchor.toml`, rent-reclaim old programs
before redeploying:

```bash
NETWORK=devnet npm run admin:close-programs -- --dry-run   # plan
NETWORK=devnet npm run admin:close-programs                # execute
rm deployments/devnet.json
NETWORK=devnet npm run deploy:programs
NETWORK=devnet npm run deploy:init
```

By default this reads program IDs from `deployments/<network>.json::programs.*`,
verifies the deployer wallet is the upgrade authority, captures
rent, and runs `solana program close` with deployer as recipient.
Refuses IDs currently in `Anchor.toml [programs.<network>]` unless
`--allow-anchor-toml-ids` is passed AND
`target/deploy/<program>-keypair.json` is rotated afterwards.

### Phase 3 — verification smoke

**EVM:**

```bash
cd EVM
npx hardhat test                              # in-process happy-path
NETWORK=sepolia npm run test:flow:live        # live round-trip + balance check
```

**SVM:**

```bash
cd SVM/oku-programs
NETWORK=devnet npm run test:onchain           # ~30 s end-to-end smoke
NETWORK=devnet npm run test:onchain -- --step=queueRedeem   # single step
```

### Phase 4 — cross-chain bridge test (noBridge / PSM-mediated)

```
1. EVM source: LitePSM.redeemOkuM(amount) → orchestrator observes the OkuMRedeemed event + USDC outflow.
2. Destination (EVM or SVM): orchestrator deposits USDC into the destination PSM and calls LitePSM.mintOkuM, crediting OkuM to recipient.
3. Treasury periodically tops up / drains PSM USDC buffers per chain.
```

EVM cross-chain accounting covered by
`EVM/test/hardhat/scenarios/RealWorldUsage.ts`. SVM queue
drain validated by:

```bash
cd SVM/oku-programs
NETWORK=devnet npm run test:onchain -- --step=queueRedeem
# or directly:
NETWORK=devnet npm run admin:process-queue                # drain to empty
NETWORK=devnet npm run admin:process-queue -- --max=25
NETWORK=devnet npm run admin:process-queue -- --dry-run
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Sender doesn't have enough funds` | Top up dev wallet on target chain. The pre-flight fork shows the *real* funding shortfall before you spend live ETH. |
| `nonce too low` / `replacement transaction underpriced` | RPC nonce-cache race. `withRetry` should absorb it; if persistent, switch RPC (`BASE_RPC_URL` / `BSC_RPC_URL`) or wait. |
| `BAD_DATA: invalid address (value="")` | BSC pending-tx quirk. `scripts/utils/rpcCompat.ts` normalises it preventatively. |
| `Chain ID mismatch: local node reports chainId X, but NETWORK=Y expects Z` | Restart `hh node` with `FORK_NETWORK=Y`, OR unset `NETWORK` so the script auto-detects. |

### Initial deploy parameters (testnet defaults)

**EVM (`EVM/scripts/deploy/index.ts`):**

| Parameter | Value | Notes |
|---|---|---|
| `maxSupply` | 1 B OkuM (1e27 raw) | 1 B token cap. |
| `minterAllowance` | 1 B OkuM | Matches `maxSupply` (effectively uncapped on testnet). **Production**: 1 % of weekly bridging volume, weekly rotation. |
| `psmStalenessThreshold` | 3 600 s | 1-hour Chainlink staleness window. |
| `minCollateralRatio` | 100 % (1e18) | Full backing at deploy; lowerable post-deploy. |

**SVM (`SVM/oku-programs/scripts/config/constants.ts`):**

| Parameter | Value | Notes |
|---|---|---|
| `MAX_SUPPLY` | 1 B OkuM (6 dec = 1e15 raw) | 1 B token cap. |
| `MINTER_ALLOWANCE` | 1 B OkuM | Matches EVM. **Production**: rotate weekly via `set-minter-allowance.ts`. |
| `ORACLE_STALENESS_THRESHOLD` | 3 600 s | 1-hour Pyth window. |
| `minCollateralRatio` | 100 % (1e9) | Full backing; lowerable post-deploy. |

### Mainnet ceremony

**EVM RBAC routing** — after live deploy, run `grantRolesMainnet.ts`:

```bash
MAINNET_COLD_MULTISIG=0x... MAINNET_WARM_MULTISIG=0x... MAINNET_ORCHESTRATOR=0x... \
  npx hardhat run scripts/operator/grantRolesMainnet.ts --network base --yes-mainnet
```

**SVM upgrade authority transfer** — after live deploy:

```bash
solana program set-upgrade-authority <LITE_PSM_PROGRAM>   --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

See `SVM/oku-programs/scripts/admin/set-upgrade-authority.ts`.

### Security notes

1. **Testnet uses deployer as orchestrator** for convenience. Production MUST use a separate KMS-backed orchestrator key.
2. **Never commit `.env` files** or private keys to git.
3. **RPC reliability** — Alchemy preferred for live runs; public RPCs can lag on nonce / mempool state.
4. **No on-chain bridge in v1.** Cross-chain replay/refund protection is the orchestrator's responsibility — the protocol surface is just PSM mint/burn.

### Chain ID reference

EVM chain IDs follow EIP-155. SVM chain identifiers (Ankr convention)
are protocol-internal — they appear only in deployment registry
metadata after the noBridge refactor.

| Network | EIP-155 / chain ID | Type |
|---|---|---|
| Solana Mainnet | 101 | Ankr convention |
| Solana Devnet | 103 | Ankr convention |
| Ethereum | 1 | EIP-155 |
| Optimism | 10 | EIP-155 |
| BSC | 56 | EIP-155 |
| Base | 8453 | EIP-155 |
| Arbitrum One | 42161 | EIP-155 |
| Eth Sepolia | 11155111 | EIP-155 |
| OP Sepolia | 11155420 | EIP-155 |
| Base Sepolia | 84532 | EIP-155 |
| BSC Testnet (Chapel) | 97 | EIP-155 |

---

## Pointers

- **EVM-specific docs:** [`EVM/README.md`](EVM/README.md)
- **SVM-specific docs:** [`SVM/README.md`](SVM/README.md)
- **Open issues:** [`TRACKER.md`](TRACKER.md)
- **In-repo audit packages:** [`EVM/audit/README.md`](EVM/audit/README.md), [`SVM/oku-programs/audit/README.md`](SVM/oku-programs/audit/README.md)
- **Downstream SDK / backend consumption:** [`artifacts/README.md`](artifacts/README.md)
