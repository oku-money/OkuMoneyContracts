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

## Token model

### EVM — dual-token split-economy

Two tokens with independent economics:

| Token | Type | Yield | Purpose |
|---|---|---|---|
| **OkuMoney (OkuM)** | Non-rebasing | Rear-facing (realized T-Bill returns) | DeFi, bridging, protocol integrations |
| **OkuDollar (usdOku)** | Rebasing ($1 peg) | Forward-facing (policy rate set by Oku) | Retail UX, "balance grows" experience |

**OkuMoney** is the solvency anchor — it only distributes yield
already earned. `balanceOf()` returns a static raw token count.
Price appreciation is tracked separately via `okuMMultiplier()`, a
stored value updated discretely by the orchestrator.

**OkuDollar** is a policy lever — Oku sets the yield rate
independently. `balanceOf()` grows every second via continuous
`_rpow` streaming. OkuDollar holds OkuMoney as reserves. The spread
between the two rates determines collateralization and protocol
revenue.

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

### SVM — single-token model

A single token: **usdOku** ("OkuDollar"), a Token-2022 mint
(`App49HmtSBMwh42tUpZT7gSbEbq7HiA6QED2BBnXtzxo`) with
`ScaledUiAmount` + `MetadataPointer` + `TokenMetadata` extensions.

There is no OkuMoney token on SVM. The **multiplier** lives directly
on the mint extension (`ScaledUiAmountConfig`) and is the single
source of truth — it determines both the raw-to-UI scaling and the
USDC conversion rate in the PSM. Revenue extraction happens off-chain
before yield distribution (the orchestrator sets the multiplier to a
value that already accounts for the protocol take).

---

## On-chain components

### EVM

```
┌─────────────────────────────────────────────────────────────────┐
│                     EVM On-Chain Contracts                        │
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
| **LitePSM** | Peg Stability Module — price-aware USDC ↔ OkuM. Sole user-facing mint/burn surface. Ships `mintUsdOku` / `redeemUsdOku` convenience flows that route through the vault. |
| **RedemptionQueue** | FIFO queue when PSM buffer is insufficient. |

### SVM

```
┌─────────────────────────────────────────────────────────────────┐
│                     SVM On-Chain (lite-psm)                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐         │
│  │  lite-psm (App49HmtSBMwh42tUpZT7gSbEbq7HiA6QED…) │         │
│  │  ─ mint_usd_oku / redeem_usd_oku                  │         │
│  │  ─ set_multiplier / distribute_yield               │         │
│  │  ─ mint_usd_oku_direct / burn_usd_oku_direct       │         │
│  └────────────────────────────────────────────────────┘         │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────┐         │
│  │  usdOku — Token-2022 mint                          │         │
│  │  Extensions: ScaledUiAmount + MetadataPointer       │         │
│  │              + TokenMetadata                        │         │
│  │  Multiplier on ScaledUiAmountConfig                 │         │
│  └────────────────────────────────────────────────────┘         │
│                                                                  │
│  PDAs: psm_config_v5, redemption_queue_v3                        │
│  Precision: 1e9 · MAX_MULTIPLIER: 1e15 · 6 decimals             │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **lite-psm** | Single program handling PSM (USDC ↔ usdOku), yield distribution, compliance, oracle relay, and redemption queue. |
| **usdOku mint** | Token-2022 mint with `ScaledUiAmount` extension — multiplier on the mint is the single source of truth for pricing and UI display. |

---

## Yield distribution & sandwich prevention

The multiplier is updated discretely by the orchestrator:

- **EVM:** `distributeYield()` or `setOkuMMultiplier()` on OkuMoney.
- **SVM:** `set_multiplier()` or `distribute_yield()` on lite-psm.

To prevent sandwich attacks around discrete updates, a single-block
lock is enforced:

- Both write functions set `lastYieldDistributionBlock` (EVM) /
  `last_yield_distribution_slot` (SVM).
- PSM and vault operations revert if executed in the same block/slot
  as a multiplier update.
- The lock auto-releases in subsequent blocks/slots — no backend
  changes needed.

On EVM, OkuDollar uses the same fence on its own `usd_multiplier`
updates (cycle 4 / OKUD-06). SVM has no separate OkuDollar — the
single multiplier fence on lite-psm covers all operations.

---

## PSM (Peg Stability Module)

### EVM — price-aware USDC ↔ OkuMoney swaps

```
mintOkuM:      okuMAmount = usdcValue × PRECISION / okuMMultiplier()
redeemOkuM:    usdcAmount = okuMAmount × okuMMultiplier() / PRECISION
```

LitePSM ships convenience functions that route through the vault for
single-transaction usdOku ↔ USDC:

```
mintUsdOku:    USDC → PSM mints OkuM → wraps into vault → usdOku to user
redeemUsdOku:  usdOku → unwrap to OkuM → redeem for USDC (or queue if buffer empty)
```

### SVM — direct USDC ↔ usdOku swaps

```
mint_usd_oku:    raw_amount = usdc_amount × PRECISION / multiplier
redeem_usd_oku:  usdc_amount = raw_amount × multiplier / PRECISION
```

lite-psm provides direct `mint_usd_oku` / `redeem_usd_oku`
instructions — no wrapping or off-chain composition needed.

---

## Cross-chain transfers (v1: off-chain orchestrated)

No on-chain bridging in v1. Cross-chain transfers are orchestrated
off-chain, with **different mechanics per stack**:

### EVM ↔ EVM — PSM-mediated USDC flow

1. User redeems OkuM for USDC on chain A via `LitePSM.redeemOkuM`.
2. Orchestrator observes the burn, waits for finality, then performs
   an equivalent USDC-funded `mintOkuM` on chain B crediting the
   recipient.
3. PSM USDC buffers on each chain are rebalanced operationally by
   treasury.

**`mintOkuM` is permissionless.** Any address with USDC can call it;
the orchestrator does NOT hold `OKUM_MINTER`. Orchestrator key
compromise grants no special mint privilege beyond the orchestrator's
USDC custody.

**Cross-chain USDC flow conservation invariant (EVM):**

```
|USDC_redeemed_A - USDC_minted_B| ≤ 1 USDC-unit per bridge
Cumulative drift across N bridges ≤ N USDC-units
```

### SVM ↔ SVM — direct burn/mint of usdOku

SVM bridges use `burn_usd_oku_direct` / `mint_usd_oku_direct` —
direct burn and mint of usdOku **without a USDC intermediary**. The
orchestrator burns usdOku on the source chain and mints an equivalent
raw amount on the destination chain.

**SVM-to-SVM bridges conserve raw usdOku amounts 1:1** — no USDC
conversion, no rounding from multiplier differences.

### Cross-stack (EVM ↔ SVM)

The orchestrator handles the asymmetry between the two-token EVM
model and the single-token SVM model:

- **EVM → SVM:** redeem OkuM for USDC on EVM, then `mint_usd_oku`
  on SVM (USDC-funded).
- **SVM → EVM:** `burn_usd_oku_direct` on SVM, then `mintOkuM` on
  EVM (orchestrator supplies USDC). If the user wants usdOku on EVM,
  the convenience `mintUsdOku` flow wraps through the vault.

Tested by `EVM/test/hardhat/scenarios/RealWorldUsage.ts`
(cross-chain bridge scenarios) and
`SVM/oku-programs/tests/bankrun/crossChainBridging.ts`.

### Future bridging

OkuBridge (proprietary burn-and-mint) and third-party rails (NTT,
CCIP) are planned post-launch and will be introduced as additive
components:

- **EVM** retains role constants (`BRIDGE_*`, `ROUTER_*`, `NTT_*`)
  and integration interfaces (`IOkuBridgeNative`, `IBridgeAdapter`)
  in the tree as reserved seams so re-introduction does not require
  modifying existing contracts.
- **SVM** has no reserved enum variants — a future on-chain bridge
  will ship as a brand-new program granted minter authority via PSM,
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
| Source user token balance | `OkuMoney.balanceOf(user) >= bridgeAmount` | `getAccount(userUsdOkuAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(psm) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` (EVM↔SVM only; SVM↔SVM uses direct burn/mint) |
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

> **Note:** SVM-to-SVM bridges do not use the queue or USDC buffer —
> they use direct `burn_usd_oku_direct` / `mint_usd_oku_direct` and
> conserve raw usdOku amounts 1:1.

#### Mid-flight failure recovery

| Failure mode | Recovery |
|---|---|
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap / oracle), wait for the blocking condition to clear, retry `mintOkuM` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain OkuM is already burned. |
| Source redeem was queued | Don't mint on destination until USDC is in hand. Poll queue state every ~30 s; call `depositBuffer` + `processQueue` to accelerate. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Multiplier-tick sequencing across chains

The multiplier (`okuMMultiplier` EVM / `multiplier` SVM) is updated
discretely by `OKUM_REBASER`. To prevent chain divergence from
causing accounting errors:

1. Fire `setOkuMMultiplier` (EVM) / `set_multiplier` (SVM) on **all
   chains in the same off-chain batch**, within one slot/block of
   each other.
2. If sequencing diverges, **per-bridge dollar value is still
   conserved** — the PSM uses the current multiplier at redemption
   time on source and at mint time on destination. The recipient
   may receive a slightly different raw token amount; dollar value
   is equivalent.
3. After a price tick, wait one slot (SVM) / one block (EVM) before
   bridging to avoid `YieldDistributionInProgress`.

#### Minter allowance rotation policy

`minterAllowance` on `OkuMoney` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds how many tokens (OkuM on EVM, usdOku on SVM) the PSM
can mint before an explicit refresh.

- **Testnet:** `minterAllowance == maxSupply == 1B` — effectively uncapped for dev.
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

| Metric | Alert threshold | Notes |
|---|---|---|
| Orchestrator token float (EVM) | Non-zero OkuM for > 1 h between batch cycles | EVM bridges use PSM-mediated USDC flow |
| Queue depth | Oldest pending entry > 24 h unfilled | |
| Oracle staleness | `updatedAt` within 80 % of `stalenessThreshold` | |
| PSM buffer | < 2 × expected daily redemption volume | |
| Minter allowance | < 10 % of weekly throughput estimate | |
| Pause state | PSM paused for > 15 min unexpectedly | |

SVM bridges use direct `burn_usd_oku_direct` / `mint_usd_oku_direct`
— there is no orchestrator token float to monitor (no USDC
intermediary). Monitor the direct minter/burner transaction success
rate instead.

All metrics on a 1-min cadence. PagerDuty for "token float" and
"queue > 24 h"; Slack warning for the rest.

#### Orchestrator security

- Orchestrator key has **NO special minting authority** on EVM.
  Compromise does not allow minting beyond the key's USDC holdings.
  On SVM, the orchestrator may hold `direct_minter` / `direct_burner`
  roles for cross-chain bridge operations (direct usdOku mint/burn).
- **EVM roles:** `OKUM_REBASER`, `VAULT_REBASER`,
  `PSM_QUEUE_PROCESSOR`, `PSM_BUFFER_DEPOSITOR`.
- **SVM roles:** `OKUM_REBASER`, `PSM_QUEUE_PROCESSOR`,
  `PSM_BUFFER_DEPOSITOR`, `direct_minter`, `direct_burner`.
  (`VAULT_REBASER` does not exist on SVM — no vault.)
- Compromise allows multiplier manipulation, buffer drain, queue
  skipping — material but bounded. On SVM, compromise also allows
  direct usdOku mint/burn up to `minterAllowance`. Cold multisig
  controls `*_UNPAUSER` and `*_BUFFER_WITHDRAWER` (more dangerous).
- Rotate the orchestrator key immediately on suspected compromise.
  Pausing both PSMs (warm multisig) is the emergency lever.
- **No two concurrent orchestrator instances** should process the
  same user bridge request. Off-chain dedup (nonces, event-ID
  tracking) is the orchestrator's responsibility.

---

## RBAC (role-based access control)

One role per action. No role performs more than one function.

| Entity | EVM Roles | SVM Roles |
|---|---|---|
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, ORACLE_MANAGER, RESERVE_MANAGER | ADMIN, UNPAUSER, CAP_MANAGER, ALLOWANCE_MANAGER, BUFFER_WITHDRAWER, ORACLE_MANAGER |
| Warm Multisig | all PAUSER, all BLACKLISTER | PAUSER, BLACKLISTER (freeze authority) |
| Orchestrator | OKUM_REBASER, VAULT_REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR | OKUM_REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR, direct_minter, direct_burner |
| LitePSM | OKUM_MINTER, OKUM_BURNER (cycle 4: split on EVM) | Mint authority on usdOku Token-2022 mint |
| RedemptionQueue | OKUM_BURNER (cycle 4) | (integrated into lite-psm) |

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
- Set `okuMMultiplier` (EVM) / `multiplier` (SVM) below current (monotonic).
- Set `usdMultiplier` below current (EVM only — SVM has no vault).
- Push the vault below `minCollateralRatio` via surplus withdrawal (EVM only).
- Set `maxSupply` below current `totalSupply`.
- Set staleness threshold outside `[60 s, 7 days]`.
- Set `minCollateralRatio` below the 90 % hard floor (EVM only).

#### Warm Multisig (lower-quorum, faster to sign)

**Can:**
- Pause all protocol contracts, halting mint / redeem / bridging.
- Blacklist any address on OkuMoney and OkuDollar (EVM).
- On SVM: freeze any usdOku ATA via Token-2022 freeze authority.

**Cannot:**
- Unpause or unblacklist (cold multisig only). Pause is a one-way
  door for the warm key.
- Access any funds or parameters.

#### Orchestrator (KMS-backed, automated)

**Can:**
- Update `okuMMultiplier` (EVM) / `multiplier` (SVM)
  (non-decreasing, bounded by `MAX_MULTIPLIER`). A compromised
  rebaser key can ratchet the multiplier toward the ceiling,
  inflating token dollar value beyond the actual T-Bill backing rate.
- Update `usdMultiplier` on EVM (bounded by `MAX_USD_MULTIPLIER`).
  An extreme bump would push the vault toward the
  `minCollateralRatio` floor, requiring Oku to deposit more
  reserves. (Not applicable on SVM — no vault.)
- Process the redemption queue.
- Deposit USDC to the PSM buffer.
- Call `mintOkuM` / `redeemOkuM` (EVM) or `mint_usd_oku` /
  `redeem_usd_oku` (SVM) as a normal user (**permissionless** — the
  orchestrator holds no special mint authority, only USDC custody).
- On SVM: call `mint_usd_oku_direct` / `burn_usd_oku_direct` for
  cross-chain bridge operations (requires `direct_minter` /
  `direct_burner` roles).

**Cannot:**
- Mint OkuM directly on EVM. `OKUM_MINTER` is held by the PSM /
  RedemptionQueue contracts.
- Access admin parameters, role grants, upgrades.
- Drain the USDC buffer (cold-multisig BUFFER_WITHDRAWER only).

#### Protocol contracts (LitePSM, RedemptionQueue)

**EVM:** Hold `OKUM_MINTER` / `OKUM_BURNER`. Mint via
`OkuMoney.mint()` only during `mintOkuM` / `processQueue`, gated by
per-minter `minterAllowance` and the global `maxSupply` cap. Burn
(cycle-4 split role) only via `OkuMoney.burn()` from inside
`redeemOkuM` / `processQueue`.

**SVM:** lite-psm holds mint authority on the usdOku Token-2022 mint.
Minting via `mint_usd_oku` / `mint_usd_oku_direct` is gated by
`minterAllowance` and `maxSupply`. Burning via `redeem_usd_oku` /
`burn_usd_oku_direct`.

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
| Token model | Dual-token: OkuMoney (non-rebasing) + OkuDollar (rebasing) | Single-token: usdOku with ScaledUiAmount extension |
| Multiplier | Stored `uint256`, 18 decimals (`okuMMultiplier`) + continuous `_rpow` for OkuDollar | Multiplier on mint extension (ScaledUiAmountConfig), 1e9 precision, 6-decimal token |
| OkuDollar multiplier | Continuous `_rpow` streaming | N/A — single-token model; multiplier serves as both pricing and UI display |
| Yield lock | `block.number` comparison | `Clock::slot` comparison |
| Token standard | ERC-20 (custom rebasing for OkuDollar) | Token-2022 (usdOku with ScaledUiAmount + MetadataPointer + TokenMetadata) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | Direct usdOku mint/redeem on the PSM; no wrapping needed |
| Cross-chain transfers (v1) | Off-chain orchestrator + LitePSM mint/burn (USDC-mediated) | Off-chain orchestrator + direct burn/mint of usdOku (`burn_usd_oku_direct` / `mint_usd_oku_direct`) |

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
│       │   └── lite-psm/    # PSM + queue + yield ops + compliance + oracle relay + direct mint/burn
│       ├── crates/
│       │   └── oku-shared/  # Pure-Rust shared constants + math + yield lock
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

# Phase 2 — create usdOku mint + initialize PSM config
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
| `MAX_SUPPLY` | 1 B usdOku (6 dec = 1e15 raw) | 1 B token cap. |
| `MINTER_ALLOWANCE` | 1 B usdOku | Matches EVM. **Production**: rotate weekly via `set-minter-allowance.ts`. |
| `ORACLE_STALENESS_THRESHOLD` | 3 600 s | 1-hour Pyth window. |

### Mainnet ceremony

**EVM RBAC routing** — after live deploy, run `grantRolesMainnet.ts`:

```bash
MAINNET_COLD_MULTISIG=0x... MAINNET_WARM_MULTISIG=0x... MAINNET_ORCHESTRATOR=0x... \
  npx hardhat run scripts/operator/grantRolesMainnet.ts --network base --yes-mainnet
```

**SVM upgrade authority transfer** — after live deploy:

```bash
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
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
