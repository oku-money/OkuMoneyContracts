# OkuMoney Protocol

Yield-bearing stablecoin infrastructure backed by US Treasury Bills.
Centralized B2B product — registered MSB, not a DeFi protocol. EVM +
SVM in parallel, off-chain orchestrator coordinating both.

> **For reviewers:** start with the per-side READMEs ([`EVM/README.md`](EVM/README.md),
> [`SVM/README.md`](SVM/README.md)), each with an "Accepted Risks" section
> covering known design decisions. Open items live in [`TRACKER.md`](TRACKER.md).

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

### EVM — two tokens, both stepwise. SVM — one token, stepwise.

**EVM is a two-token system**: **OkuM**, the fixed-balance share token with a
stepwise realized index (`M_oku`), and **USDOku**, a rebasing dollar-denominated
wrapper over it with its own *continuous* declared index (`M_usd`). **SVM stays
single-token**: **OkuM** as a Token-2022 mint with a stepwise multiplier. Both
chains' `M_oku` step the same way — discrete, orchestrator-pushed marks of
realized RWA performance — so the accrual-granularity divergence that existed in
the earlier single-token EVM design is gone. USDOku's separate continuous index
is where continuous accrual now lives, and it exists only on EVM.

| | EVM — OkuM | EVM — USDOku | SVM — OkuM |
|---|---|---|---|
| Balances | Fixed raw | Rebasing (shares × `M_usd`) | Fixed raw |
| Standard | ERC-8056 (Draft) + ERC-4626 conversion subset | ERC-20 only — **no** ERC-8056 | `ScaledUiAmount` + `MetadataPointer` + `TokenMetadata` |
| Multiplier home | `ScaledUIAmountUpgradeable` storage (`M_oku`) | separate `UsdOkuIndex` storage (`M_usd`) | `ScaledUiAmountConfig` on the mint |
| Accrual | **stepwise** (discrete marks) | **continuous** (rate + elapsed time) | **stepwise** (discrete marks) |
| Precision | 1e18 | 1e18 | 1e9 |
| Decimals | 18 | 18 | 6 |
| Chains | EVM + SVM (same mechanism) | EVM only, transitional | EVM + SVM |

```
             raw layer                          display layer
  ┌──────────────────────────────┐   ┌────────────────────────────────┐
  │ balanceOf(user) = 954.20      │ × │ uiMultiplier() = 1.048...e18    │
  │ transfer / approve / allowance│   │ M_oku — stepwise, monotone      │
  │ — fixed, stock ERC-20 —       │   └────────────────────────────────┘
  └──────────────────────────────┘                  ║
             ║                                      ▼
   DeFi prices and accounts       balanceOfUI(user) = $1,000.00
   against this   (OkuM, both chains)

  wrap/unwrap OkuM ⇄ USDOku, always at M_oku (never M_usd)
  ┌────────────────────────────────────────────────┐
  │ USDOku.balanceOf(user) = shares × M_usd         │  1 USDOku = $1.00, always
  │ rebases every block — M_usd is continuous       │  EVM only, transitional
  └────────────────────────────────────────────────┘
```

**Why not rebasing, for OkuM.** A rebasing `balanceOf` breaks AMM pools, lending
markets and anything that snapshots balances, because the number moves underneath
the integration with no transfer to observe. Fixing the raw balance and moving
growth to a display multiplier gives users the same experience without any of
that. The degradation is graceful: a wallet that has never heard of ERC-8056
shows `954.20 OkuM` rather than `$1,000.00` — a different unit count, the same
dollar value, and no false claim about what the number means.

**Why USDOku rebases anyway.** A rebasing `balanceOf()` displays correctly in
every wallet ever written, with zero integration work — ERC-8056 requires each
integrator to opt in, and adoption is still thin. USDOku trades that
AMM-hostility deliberately for universal wallet display while ERC-8056 support
catches up, and is explicitly transitional: expected to sunset once wallets
widely render ERC-8056. See [`EVM/README.md`](EVM/README.md) for the sunset path
and the solvency mechanics that bound how far USDOku's declared liability may
run ahead of OkuM's realized backing.

**Two interfaces, one number, on OkuM.** ERC-8056 is a *display* extension: it
makes no claim about value and specifies no redemption semantics. Shipping it
alone would leave integrators with a multiplier and no standard way to price
against it, so OkuM also exposes an ERC-4626 conversion-views subset (`asset`,
`totalAssets`, `convertToAssets`, `convertToShares`). It is **not** fully
ERC-4626 compliant and does not claim the interface via ERC-165 —
`deposit`/`redeem` live on the module and may queue. USDOku deliberately does
**not** implement ERC-8056: its `balanceOf` is already dollar-denominated, so a
multiplier on top would double-scale. See [`EVM/README.md`](EVM/README.md).

> **v0.3 migration note.** Prior versions ran a dual-token split economy on EVM:
> `OkuMoney` (non-rebasing, stored multiplier) plus `OkuDollar` (a rebasing vault
> holding OkuMoney as reserves), with revenue extracted from the spread between
> two independent rates. That model was collapsed into a single token,
> `OkuDollar` (`rUSDOku`), with continuous rate-based accrual and no wrap/unwrap
> step. **That single-token design has since been split back into two tokens**,
> `OkuM` and `USDOku`, this time with both `M_oku` (OkuM, both chains) and the
> wrap/unwrap step reintroduced deliberately — the two-token model expresses a
> rear-facing realized claim and a forward-facing smoothed payout as separate
> instruments, which a single multiplier cannot. The v0.2 and interim v0.3
> proxies are **retired, not upgraded** — none of the storage layouts are
> related.

**Cross-chain accrual granularity no longer diverges.** Token-2022 rejects
`ScaledUiAmount` and `InterestBearingConfig` on the same mint
([`extension/mod.rs:1365`](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs)),
so SVM's OkuM has always been stepwise by construction. EVM's OkuM is now
stepwise too — matching value at matching cadence, verified after the fact by
comparing multiplier values directly rather than relying on epoch bookkeeping
(see [Cross-chain transfers](#cross-chain-transfers-v1-off-chain-orchestrated)).
The step introduces a **local step-arbitrage surface on both chains now**,
defended by `tin + tout` fees bound to the step size — this was previously a
SVM-only concern under continuous EVM accrual. USDOku's separate `M_usd` remains
continuous and EVM-only, and needs no such defence — there is no step to hold
across.

---

## On-chain components

### EVM

```
┌──────────────────────────────────────────────────────────────────┐
│                     EVM On-Chain Contracts                        │
│                                                                   │
│   USDC ──►┌───────────────────────────────────────────┐          │
│           │                   OkuM                     │          │
│           │  ERC-20      raw, 18dp    ← ACCOUNTING     │          │
│           │  ERC-4626    conversion   ← VALUE          │          │
│           │  ERC-8056    scaled UI    ← DISPLAY        │          │
│           │  stepwise M_oku, written by setOkuMultiplier│         │
│           └──┬───────────────────┬──────────────┬──────┘          │
│              │ OKU_MINTER/BURNER │ uiMultiplier() │ wrap/unwrap   │
│              ▼                   ▼                ▼               │
│    ┌────────────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│    │ SubscriptionModule  │ │OkuMultiplier │ │  USDOkuWrapper   │ │
│    │ USDC buf, tin/tout  │ │Adapter       │ │ solvency views,  │ │
│    │ mintUsdOku/redeem-  │ │(AggregatorV3 │ │ wrap/unwrap at   │ │
│    │ UsdOku convenience  │ │ shim)        │ │ M_oku, surplus() │ │
│    └────┬────────────────┘ └──────────────┘ └────────┬─────────┘ │
│         ▼                                             ▼           │
│  ┌──────────────────┐                        ┌──────────────────┐│
│  │ RedemptionQueue   │                        │      USDOku      ││
│  └───────────────────┘                        │  rebasing, M_usd ││
│                                                │  continuous      ││
│                                                └──────────────────┘│
│  (Cross-chain transfers are orchestrator-mediated via              │
│   SubscriptionModule mint/burn on each chain — no on-chain         │
│   bridge in v1.)                                                    │
└──────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **OkuM** | The share token. Static raw balances; stepwise `M_oku` index. ERC-8056 display layer + ERC-4626 conversion views. |
| **USDOku** | Rebasing dollar wrapper. `balanceOf` = shares × continuous `M_usd`; 1 USDOku = $1 by definition. **No ERC-8056.** Transitional. |
| **USDOkuWrapper** | OkuM ↔ USDOku, always at `M_oku` (never `M_usd`). Holds the solvency views and `withdrawSurplus`. |
| **SubscriptionModule** | USDC ↔ OkuM at `M_oku`. Also `mintUsdOku` / `redeemUsdOku` — one-transaction USDC ↔ USDOku via the wrapper. Sole user-facing mint/redeem surface. |
| **RedemptionQueue** | FIFO queue when the module's buffer is insufficient. Escrows raw OkuM, which keeps appreciating while queued. |
| **OkuMultiplierAdapter** | Chainlink `AggregatorV3Interface`-compatible feed over OkuM's `uiMultiplier()`, with bounds and staleness. Reports **18** decimals, not Chainlink's usual 8. |

**Hard rule:** the multiplier is an input to *pricing*, never to *accounting*.
Every ledger in the system — balances, allowances, queue records — is raw.

### SVM

```
┌─────────────────────────────────────────────────────────────────┐
│                     SVM On-Chain (lite-psm)                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐         │
│  │  lite-psm (BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCG…) │         │
│  │  ─ mint_oku_m / redeem_oku_m (buffer-only)         │         │
│  │  ─ set_multiplier / distribute_yield               │         │
│  │  ─ mint_oku_m_direct / burn_oku_m_direct           │         │
│  └────────────────────────────────────────────────────┘         │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────┐         │
│  │  OkuM — Token-2022 mint                            │         │
│  │  Extensions: ScaledUiAmount + MetadataPointer       │         │
│  │              + TokenMetadata                        │         │
│  │  Multiplier on ScaledUiAmountConfig                 │         │
│  └────────────────────────────────────────────────────┘         │
│                                                                  │
│  PDA: psm_config (no redemption queue — buffer-only PSM)         │
│  Precision: 1e9 · MAX_MULTIPLIER: 1e15 · 6 decimals             │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **lite-psm** | Single program handling PSM (USDC ↔ OkuM, buffer-only — no redemption queue), yield distribution, and compliance. |
| **OkuM mint** | Token-2022 mint with `ScaledUiAmount` extension — multiplier on the mint is the single source of truth for pricing and UI display. |

---

## Yield accrual

### `M_oku` — stepwise, both chains

`OkuM` steps on both chains, discrete and orchestrator-pushed, from realized
RWA performance:

- **EVM:** `OkuM.setOkuMultiplier(newMultiplier)` (`OKU_RATE_SETTER`). Writes
  immediately, no scheduling. Also exposed through ERC-8056's
  pending-multiplier extension for advance-scheduled steps.
- **SVM:** `set_multiplier()` or `distribute_yield()` on `lite-psm` (`rebaser`).

Because these are genuine discrete revaluations on both chains, both retain a
same-block/same-slot sandwich fence around the write, and both auto-arm a bounded
**post-step sync window** (see
[Cross-chain transfers](#cross-chain-transfers-v1-off-chain-orchestrated))
fencing operations that price through the multiplier for a short interval after
each step. Neither chain needs a continuous-accrual sandwich guard, because
neither runs one for `M_oku` anymore.

**The step introduces local step arbitrage on both chains**, defended by
`tin + tout` fees on the module bound to the step size (`stepBps`) — see
[PSM](#psm-peg-stability-module) below.

Controls capping damage from a compromised setter key (EVM):

| Control | Value | Purpose |
|---|---|---|
| `MAX_STEP_BPS` | 2 (provisional) | Ceiling on a single mark, AND the floor under `tout` |
| `MIN_MARK_INTERVAL` | 1 hour | Minimum gap between marks — makes `MAX_STEP_BPS` a bound per unit *time*, not per call |
| `MAX_MULTIPLIER` | 1e24 | Cumulative ceiling |
| Monotonicity | `newMultiplier >= current` | The multiplier can never decrease |
| Step coverage | `tout >= MAX_STEP_BPS` | Round trip cannot extract the mark. Static, and on the EXIT leg only — the gain is realised on exit, so `tin` is irrelevant and ships at **0** (`FeeBelowStepFloor`, `StepAboveMaximum`) |
| `haltAccrual()` | `OKU_GUARDIAN`, no timelock | Freeze further steps; withhold-only, cannot reduce |

### `M_usd` — continuous, EVM-only

USDOku's separate rebase index. One setter:
`USDOku.setUsdOkuRate(ratePerSecond, endTimestamp)` (`OKU_RATE_SETTER`).

```
usdOkuIndex() = baseIndex × rpow(ratePerSecond, elapsed, 1e18) / 1e18
elapsed       = min(block.timestamp, rateEnd) − lastAccrualTime
```

The Aave liquidity-index / sDAI `chi` pattern — this is where the continuous,
rate-based accrual mechanism from the earlier single-token design now lives. It
changes every second with no transaction, so there is no block at which every
cached index is simultaneously wrong, and no step to sandwich-guard.

**Accrual halts at `rateEnd`, and that is a safety mechanism.** If the rate setter
stops functioning the index stops growing rather than accruing indefinitely
against assets that are not there. `rateEnd` is mandatory; zero or past values
are rejected.

`M_usd` is also bounded by a **solvency gap**: `setUsdOkuRate` reverts if the
liability it would project at `rateEnd` exceeds realized OkuM backing by more
than `MAX_SOLVENCY_GAP_BPS`. See [`EVM/README.md § Solvency`](EVM/README.md) for
the full mechanics.

| Control | Value | Purpose |
|---|---|---|
| `MAX_IMPLIED_APR` | 1000 bps nominal | The binding economic bound |
| `MAX_RATE_DURATION` | 30 days | Caps the exposure window of any single write |
| Monotonicity | `rate >= 1e18` | The index can never decrease |
| `MAX_SOLVENCY_GAP_BPS` | placeholder | How far declared liability may outrun realized backing |
| `haltUsdOkuAccrual()` | `OKU_GUARDIAN`, no timelock | Freeze immediately; withhold-only, cannot reduce |

Worst-case over-accrual from a compromised setter key inside one maximum-length
segment is ~0.82%.

## PSM (Peg Stability Module)

### EVM — `SubscriptionModule`: USDC ↔ OkuM at `M_oku`

Renamed from `LitePSM` — nothing here is pegged; `SubscriptionModule` is a
mint/redeem facility quoting at the current index.

```
mint:    raw  = (usdcAmount × usdcDecimalMultiplier) × PRECISION / M_oku
redeem:  usdc = (raw × M_oku / PRECISION) / usdcDecimalMultiplier
```

At `M_oku = 1.05e18`, depositing 100 USDC yields ~95.24 raw — which *displays*
as $100.00. Redeeming those 95.24 raw returns ~100 USDC.

`quoteMint` / `quoteRedeem` / `redeemableNow` are public views; a UI showing a
quote must use them rather than recomputing. `redeemUiAmount(uiAmount)` exists as
a convenience but floors the UI→raw conversion, so a true max-redeem must use
`redeem(balanceOf(user))`. See the max-send rule in
[`EVM/metadata/DISPLAY_CONVENTION.md`](EVM/metadata/DISPLAY_CONVENTION.md).

`SubscriptionModule` also exposes **`mintUsdOku` / `redeemUsdOku`** — one
transaction to go USDC ↔ USDOku, chaining through `USDOkuWrapper` internally so
users don't need three or four separate transactions to get or exit USDOku.
`quoteMintUsdOku` / `quoteRedeemUsdOku` are the corresponding views.

`tout` is a **real step-arbitrage defence**, not just a parity knob, and the
enforcement is static: `setFees` floors `tout` at `MAX_STEP_BPS` while
`setOkuMultiplier` caps a mark at `MAX_STEP_BPS`, so the exit fee always covers
the largest mark. `initialize` seeds `tout` at the floor, so there is no
uncovered window and no configuration step to forget.

**`tin` ships at 0 and has no floor.** The arbitrage gain is realised on exit, so
the exit leg alone closes it — including cross-chain, since whichever chain the
attacker exits on charges its own `tout`. Deposits stay free, which is the
point: permissionless frictionless entry is what this product offers.

**The fee is the price of discreteness.** One mark is worth `APY x interval`, so
marking more often lowers the required fee toward zero — which is why
continuously-accruing designs (Maker `chi`, Aave, Ondo's USDY oracle) need none.
Token-2022's `ScaledUiAmount` stores a *discrete* multiplier, so we cannot accrue
continuously and this fee is the exact cost of that constraint.

There is a single source of truth for the USDC binding: OkuM holds `asset()`
and `usdcDecimalMultiplier()`, and `SubscriptionModule.initialize` and
`RedemptionQueue.initialize` cross-assert against it and revert on mismatch. A
misconfigured deployment fails at init rather than pricing divergently in
production.

### SVM — direct USDC ↔ OkuM swaps (buffer-only)

```
mint_oku_m:    raw_amount = usdc_amount × PRECISION / multiplier
redeem_oku_m:  usdc_amount = raw_amount × multiplier / PRECISION
```

lite-psm provides direct `mint_oku_m` / `redeem_oku_m` instructions —
no wrapping or off-chain composition needed. `redeem_oku_m` is
**buffer-only**: it reverts with `InsufficientBuffer` if the PSM's
USDC vault can't cover the redemption. There is no redemption queue
on SVM (deliberately removed — see
[`SVM/README.md` § Why no redemption queue](SVM/README.md)).

---

## Cross-chain transfers (v1: off-chain orchestrated)

No on-chain bridging in v1. Cross-chain transfers are orchestrated
off-chain, with **different mechanics per stack**:

### EVM ↔ EVM — PSM-mediated USDC flow

1. User redeems OkuM for USDC on chain A via `SubscriptionModule.redeem`.
2. Orchestrator observes the burn, waits for finality, then performs
   an equivalent USDC-funded `SubscriptionModule.mint` on chain B crediting the
   recipient.
3. Module USDC buffers on each chain are rebalanced operationally by
   treasury.

**`SubscriptionModule.mint` is permissionless.** Any address with USDC can call
it; the orchestrator does NOT hold `OKU_MINTER`. Orchestrator key
compromise grants no special mint privilege beyond the orchestrator's
USDC custody.

**Cross-chain USDC flow conservation invariant (EVM):**

```
|USDC_redeemed_A - USDC_minted_B| ≤ 1 USDC-unit per bridge
Cumulative drift across N bridges ≤ N USDC-units
```

### SVM ↔ SVM — direct burn/mint of OkuM

SVM bridges use `burn_oku_m_direct` / `mint_oku_m_direct` —
direct burn and mint of OkuM **without a USDC intermediary**. The
orchestrator burns OkuM on the source chain and mints an equivalent
raw amount on the destination chain.

**SVM-to-SVM bridges conserve raw OkuM amounts 1:1** — no USDC
conversion, no rounding from multiplier differences.

### Cross-stack (EVM ↔ SVM)

The orchestrator handles the asymmetry between the two-token EVM
model and the single-token SVM model:

- **EVM → SVM:** redeem OkuM for USDC on EVM, then `mint_oku_m`
  on SVM (USDC-funded).
- **SVM → EVM:** `burn_oku_m_direct` on SVM, then `SubscriptionModule.mint` on
  EVM (orchestrator supplies USDC), crediting OkuM. If the recipient wants
  USDOku instead, the convenience `mintUsdOku` flow wraps through
  `USDOkuWrapper` in the same transaction.

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
| Destination module not paused | `SubscriptionModule.paused()` | `psm.account.psmConfig.fetch(...).isPaused` |
| No post-step sync window armed (either chain) | `OkuM.isSyncLocked()` | `now < psmConfig.syncLockUntilTs` |
| Multiplier values agree across chains | run `check-sync-parity.ts` — compares `OkuM.uiMultiplier()` (EVM, 1e18) against the SVM mint multiplier (1e9), scaled and compared as integers | same |
| Destination supply headroom | `OkuM.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuM.minterAllowance(module) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user token balance | `OkuM.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(module) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` (EVM↔SVM only; SVM↔SVM uses direct burn/mint) |
| Recipient ATA not frozen | `OkuM.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |

If the EVM source module's buffer is insufficient, the redeem succeeds but
the OkuM is escrowed in EVM's redemption queue. **The orchestrator
must wait for `processQueue` to pay out USDC before completing the
destination mint leg.** Poll queue state to detect (EVM only — SVM
has no redemption queue, see below):

```
EVM:  queue.queueHead() < queue.queueTail()  → entries pending
```

The orchestrator can accelerate payment by calling `depositBuffer`
to fund the queue, then `processQueue`.

> **Note:** SVM has no redemption queue at all (deliberately removed
> — see [`SVM/README.md` § Why no redemption queue](SVM/README.md)).
> `redeem_oku_m` on SVM is buffer-only: it reverts with
> `InsufficientBuffer` if the vault can't cover it — there is nothing
> to drain or poll. SVM-to-SVM bridges additionally bypass the USDC
> buffer entirely, using direct `burn_oku_m_direct` /
> `mint_oku_m_direct` to conserve raw OkuM amounts 1:1.

#### Mid-flight failure recovery

| Failure mode | Recovery |
|---|---|
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap), wait for the blocking condition to clear, retry `SubscriptionModule.mint` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain balance is already burned. |
| Source redeem was queued | Don't mint on destination until USDC is in hand. Poll queue state every ~30 s; call `depositBuffer` + `processQueue` to accelerate. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Multiplier stepping and cross-chain parity

`OkuM`'s multiplier (`uiMultiplier` EVM / `multiplier` SVM) is a **stepwise**
value on both chains now, written by `OKU_RATE_SETTER` (EVM) / `rebaser` (SVM).
A step is **not atomic across chains** — while it propagates, the two sides
price a raw token differently, so anything converting value through the
multiplier in that interval settles at a stale price on one side.

**There is no cross-chain open/close protocol and no shared epoch number.**
Each chain independently fences itself: every multiplier write (EVM
`setOkuMultiplier`, SVM `set_multiplier` / `distribute_yield`) **auto-arms** a
bounded post-step sync window on that chain alone, no separate begin/end call,
no orchestrator-assigned tick identifier written on either side.

```
EVM:  setOkuMultiplier(newMultiplier)      → arms OkuM's window automatically
SVM:  set_multiplier(new_multiplier)       → arms lite-psm's window automatically
      (or distribute_yield)
```

- **Fail-closed:** a step can never land unfenced — the write and the arm are
  the same transaction.
- **Fail-open:** each window auto-expires on its own chain at
  `MAX_SYNC_WINDOW` (15 min ceiling; ships at a 60 s default). A dead
  orchestrator delays users, never bricks redemption.
- Windows are set independently per chain and need not overlap in wall-clock
  terms beyond covering the propagation gap between the two writes.

While a chain's window is armed, operations on that chain that price through
`OkuM`'s multiplier revert: `SubscriptionModule.mint` / `redeem` /
`redeemUiAmount` / `processQueue` (EVM), `mint_oku_m` / `redeem_oku_m` (SVM),
and `USDOkuWrapper.wrap` / `unwrap` (EVM) — plus, on EVM, `USDOku.setUsdOkuRate`,
since its solvency check reads `M_oku` and would otherwise check against a
possibly-stale figure mid-step. Buffer movement, direct mint/burn bridge legs,
and the multiplier writes themselves stay open throughout.

**Verify parity with `check-sync-parity.ts` after every mark** — this replaces
the old epoch-equality check entirely. It reads `OkuM.uiMultiplier()` on EVM
(1e18) and the mint's multiplier on SVM (1e9), scales them to a common integer
unit, and compares the **values** directly:

```bash
cd SVM/oku-programs
npm run admin:check-sync-parity -- --evm=base --svm=mainnet-beta --strict
```

**Why value comparison replaced epoch comparison.** The earlier design had each
chain record an orchestrator-assigned `sync_epoch` per tick and compared those
numbers across chains. Equal epochs only ever proved both chains *wrote
something* for the same tick — never that they wrote the **same value**. That
also needed supporting machinery to mean even that much: a write-landed-in-epoch
attestation so a window couldn't be opened and closed empty, and an anti-grief
gap so windows couldn't be chained. Comparing multiplier values directly
subsumes all of it — a wrong-value write is caught, a missing write is caught,
and there is no cross-chain bookkeeping state to keep in sync or go stale.

**Failure modes.**

- **A step landed on only one chain.** `check-sync-parity.ts` reports a
  divergence directly — this is exactly the case value comparison is built to
  catch. Push the matching step on the lagging chain.
- **Window expired before the peer chain's step landed.** The liveness backstop
  fired — mint/redeem/wrap resume unaided on the chain whose window expired.
  Not a correctness problem: parity is checked after the fact regardless of
  whether either window was still armed.
- **Wrong value written.** `check-sync-parity.ts` catches this the same as a
  missing write — it compares the actual numbers, not a claim that a write
  happened. Reconcile against the intended mark and correct on whichever chain
  is wrong (monotonicity means only "step it further" is available, never
  "roll it back").

**If sequencing still diverges,** per-bridge dollar value remains conserved — the
module uses the current multiplier at redemption time on source and at mint time
on destination. The recipient may receive a slightly different raw amount;
dollar value is equivalent.

**Still wait one slot (SVM) after a write** before bridging: the same-slot
sandwich fence is independent of the sync window and remains in force.

> **The window is not a step-arbitrage defence, on either chain now.** Holding
> raw across a discrete multiplier step needs no transaction while the window is
> open, so no window length deters it. The `tin + tout` fee is the control on
> both EVM and SVM — enforced on-chain, not merely advised: a step larger than
> current fees cover is refused, and fees cannot later drop below a step already
> taken (the step-high-water-mark ratchet). This used to be an SVM-only concern
> under EVM's continuous accrual; it is now symmetric.

#### Minter allowance rotation policy

`minterAllowance` on `OkuM` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds how many raw OkuM tokens the module can mint on each chain
before an explicit refresh.

- **Testnet:** `minterAllowance == maxSupply == 1B` — effectively uncapped for dev.
- **Production:** ~ **1 % of weekly bridging volume**, rotated on a **weekly cadence** by `OKU_ALLOWANCE_MANAGER` (cold multisig). Bounds a single-week worst-case mint by a compromised module contract or orchestrator USDC custody.

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
| Orchestrator token float (EVM) | Non-zero OkuM for > 1 h between batch cycles | EVM bridges use module-mediated USDC flow |
| Queue depth (EVM only) | Oldest pending entry > 24 h unfilled | SVM has no queue — buffer depletion reverts the redeem instead |
| Module buffer | < 2 × expected daily redemption volume | Depleted buffer reverts SVM redeems with `InsufficientBuffer`; EVM redeems queue instead |
| Minter allowance | < 10 % of weekly throughput estimate | |
| Pause state | Module paused for > 15 min unexpectedly | |
| Multiplier parity | `check-sync-parity.ts --strict` reports non-zero divergence | Compares actual `M_oku` values, not epoch claims. A persistent mismatch means the two chains are pricing OkuM differently — halt cross-chain flow until resolved |
| Sync window expiry (EVM) | `SyncWindowArmed` with `isSyncLocked()` still true past its own `lockedUntil` should never happen — alert if observed | Indicates a bug in the auto-expiry logic itself, not an orchestrator failure |
| Sync window liveness (SVM) | window still locked past `MAX_SYNC_WINDOW_SECS` from arm time | Same class of check as EVM — should never fire under correct auto-expiry |
| Oversized mark refused | EVM `StepAboveMaximum` / SVM `StepAboveMax` on a multiplier write | The intended mark exceeds `MAX_STEP_BPS`. Raising fees does NOT help — the ceiling is a constant. Either the cadence has slipped and the mark must be walked over several ticks, or `MAX_STEP_BPS` is mis-sized for the published cadence |
| Fee below floor refused | EVM `FeeBelowStepFloor` / SVM `FeeBelowStepFloor` | Should be unreachable: `initialize` seeds the floor and `setFees` is the only writer. If observed, the deployed bytecode may not be the reviewed source |
| Mark too soon | EVM `MarkTooSoon` / SVM `MarkTooSoon` | The orchestrator attempted two marks inside `MIN_MARK_INTERVAL`. Benign if it is a retry; investigate if sustained, since it may indicate a loop |

SVM bridges use direct `burn_oku_m_direct` / `mint_oku_m_direct`
— there is no orchestrator token float to monitor (no USDC
intermediary). Monitor the direct minter/burner transaction success
rate instead.

All metrics on a 1-min cadence. PagerDuty for "token float" and
"queue > 24 h"; Slack warning for the rest.

#### Orchestrator security

- Orchestrator key has **NO special minting authority** on EVM.
  Compromise does not allow minting beyond the key's USDC holdings.
  On SVM, the orchestrator may hold `direct_minter` / `direct_burner`
  roles for cross-chain bridge operations (direct OkuM mint/burn).
- **EVM roles:** `OKU_RATE_SETTER`,
  `PSM_QUEUE_PROCESSOR`, `PSM_BUFFER_DEPOSITOR`.
- **SVM roles:** `rebaser`, `buffer_depositor`, `direct_minter`,
  `direct_burner`. (No queue-processor equivalent
  on SVM — no vault, no redemption queue.)
- Compromise allows multiplier manipulation and buffer drain —
  material but bounded. On EVM, compromise also allows skipping
  ahead in the redemption queue. On SVM, compromise allows direct
  OkuM mint/burn up to `minterAllowance` (no queue to skip — SVM has
  none). Cold multisig controls `*_UNPAUSER` and
  `*_BUFFER_WITHDRAWER` (more dangerous).
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
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, PSM_FEE_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, WRAPPER_ADMIN, WRAPPER_RESERVE_MANAGER | role_admin, unpauser, cap_manager, allowance_manager, buffer_withdrawer |
| Warm Multisig | all PAUSER, all BLACKLISTER, OKU_GUARDIAN | pauser, freezer |
| Orchestrator | OKU_RATE_SETTER (sets both `M_oku` and `M_usd`; each write auto-arms its own chain's post-step window — no separate begin/end call), PSM_QUEUE_PROCESSOR, PSM_BUFFER_DEPOSITOR | rebaser (each write auto-arms its own chain's post-step window — no separate begin/end call), buffer_depositor, direct_minter, direct_burner |
| Protocol contracts | `SubscriptionModule` + `USDOkuWrapper` hold `OKU_MINTER`; `SubscriptionModule` + `RedemptionQueue` + `USDOkuWrapper` hold `OKU_BURNER` | `lite-psm` holds mint authority on the OkuM Token-2022 mint |

The sync window and the fee schedule deliberately add **no new keys**. Window
control sits with the existing rate-setter/rebaser — the actor that writes the
multiplier is the one that arms its own chain's fence. Fee and window-length
setting sits with the existing cold cap-manager, as economic policy.
`PSM_FEE_MANAGER` is a separate *constant* from `OKU_CAP_MANAGER` only because
AccessControl mappings are per-contract; it is intended for the same cold key.
`WRAPPER_ADMIN` (sunset control — disables `wrap`, never `unwrap`) and
`WRAPPER_RESERVE_MANAGER` (`withdrawSurplus`) are new EVM-only roles introduced
by `USDOkuWrapper`; there is no SVM equivalent because USDOku is EVM-only.

The `BRIDGE_*`, `ROUTER_*`, and `NTT_*` roles defined in
`EVM/src/lib/Roles.sol` are reserved for future re-introduction of
OkuBridge / NTT / CCIP — not granted by v1 deploy scripts.

**Devnet/testnet delegation.** The table above is the mainnet target
model. On devnet/testnet it's common to delegate operational roles
(`direct_minter`, `direct_burner`, `rebaser`, `buffer_depositor` on
SVM) to a coworker- or CI-owned key while governance/safety roles
and `role_admin` stay with the deployer/owner — see
[`SVM/README.md § Delegated operation vs. retained ownership`](SVM/README.md)
for the full rationale and the `grant-roles.ts --delegate=<pubkey>`
tool that implements it.

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
- Configure `maxSupply` and `minterAllowance`. Raising allowance to
  the cap and minting up to it is the worst-case mint outcome.
- Drain the USDC buffer (`withdrawUsdc` / `withdraw_buffer`). On EVM,
  bounded by pending redemption-queue obligations; on SVM, bounded
  only by the vault's current balance (no queue to protect).
- On EVM only: `withdrawSurplus` from `USDOkuWrapper` — recovers issuer
  capital once realized OkuM backing overtakes USDOku's declared liability.
  Bounded by `surplus()`, which is `0` at or below full backing. No SVM
  equivalent — USDOku is EVM-only.
- On EVM only: `WRAPPER_ADMIN` can disable `wrap` (OkuM → USDOku) as sunset
  step one. `unwrap` has no disable path — deliberate, so a sunset can never
  strand a USDOku holder.
- Grant any role to any address (DEFAULT_ADMIN_ROLE / role_admin SVM).
- Unblacklist, unpause, unfreeze ATAs.
- Rotate operational authority pubkeys.

**Cannot (on-chain code prevents even at quorum):**
- Mint above `maxSupply` or `minterAllowance`.
- Set the multiplier below its current value (monotonic on both chains).
- Set `maxSupply` below current `totalSupply`.

#### Warm Multisig (lower-quorum, faster to sign)

**Can:**
- Pause all protocol contracts, halting mint / redeem / bridging.
- Blacklist any address on OkuM or USDOku (EVM).
- On SVM: freeze any OkuM ATA via Token-2022 freeze authority.

**Cannot:**
- Unpause or unblacklist (cold multisig only). Pause is a one-way
  door for the warm key.
- Access any funds or parameters.

#### Orchestrator (KMS-backed, automated)

**Can:**
- Step `M_oku` (EVM `setOkuMultiplier`, SVM `set_multiplier` / `distribute_yield`)
  (non-decreasing, bounded by `MAX_STEP_BPS` per step and `MAX_MULTIPLIER`
  cumulative). A compromised rate-setter/rebaser key can ratchet the
  multiplier toward the ceiling, inflating token dollar value beyond the
  actual T-Bill backing rate. Every write auto-arms that chain's own
  post-step sync window — no separate call needed or available.
- On EVM only: set the USDOku declared rate (`setUsdOkuRate`, bounded by
  `MAX_IMPLIED_APR`, `MAX_RATE_DURATION`, and the solvency-gap check against
  realized OkuM backing). Not applicable on SVM — no USDOku.
- Process the redemption queue (EVM only — SVM has no queue).
- Deposit USDC to the module's buffer.
- Call `mint` / `redeem` (EVM) or `mint_oku_m` /
  `redeem_oku_m` (SVM) as a normal user (**permissionless** — the
  orchestrator holds no special mint authority, only USDC custody). On EVM,
  also `mintUsdOku` / `redeemUsdOku` for the one-transaction USDOku path.
- On SVM: call `mint_oku_m_direct` / `burn_oku_m_direct` for
  cross-chain bridge operations (requires `direct_minter` /
  `direct_burner` roles).

**Cannot:**
- Mint OkuM or USDOku directly on EVM. `OKU_MINTER` is held by
  `SubscriptionModule` and `USDOkuWrapper`, not by the orchestrator key.
- Access admin parameters, role grants, upgrades.
- Drain the USDC buffer (cold-multisig BUFFER_WITHDRAWER only), or withdraw
  wrapper surplus (cold-multisig WRAPPER_RESERVE_MANAGER only, EVM).

#### Protocol contracts (SubscriptionModule, RedemptionQueue, USDOkuWrapper)

**EVM:** `SubscriptionModule` and `USDOkuWrapper` hold `OKU_MINTER`;
`SubscriptionModule`, `RedemptionQueue` and `USDOkuWrapper` hold `OKU_BURNER`.
Mint via `OkuM.mint()` during `SubscriptionModule.mint` or `USDOku.mint()`
during `USDOkuWrapper.wrap`, each gated by per-minter `minterAllowance` and its
token's `maxSupply` cap. Burn via `OkuM.burn()` / `USDOku.burn()` from inside
`SubscriptionModule.redeem`, `RedemptionQueue.processQueue`, or
`USDOkuWrapper.unwrap`.

**SVM:** lite-psm holds mint authority on the OkuM Token-2022 mint.
Minting via `mint_oku_m` / `mint_oku_m_direct` is gated by
`minterAllowance` and `maxSupply`. Burning via `redeem_oku_m` /
`burn_oku_m_direct`. `redeem_oku_m` is buffer-only — there is no
redemption queue on SVM to fall back to.

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
| Token model | **Two tokens:** OkuM (fixed-balance share, ERC-8056) + USDOku (rebasing dollar wrapper, EVM-only, no ERC-8056) | **Single token:** OkuM with the Token-2022 ScaledUiAmount extension |
| `M_oku` multiplier | Stepwise, written immediately by `setOkuMultiplier`, 1e18 precision, 18-decimal token | Stepwise, stored on the mint extension (`ScaledUiAmountConfig`), 1e9 precision, 6-decimal token |
| USDOku `M_usd` index | **EVM only.** Continuous, derived from a stored rate + elapsed time (`rpow`), 1e18 precision, separate from `M_oku` | N/A — no second token, no continuous index |
| Same-step/same-slot yield fence | Present on both write paths, matching SVM | `Clock::slot` comparison against `last_yield_distribution_slot` |
| Post-step sync window | Auto-armed by every `setOkuMultiplier` write, state on `OkuM`, gates `mint`/`redeem`/`redeemUiAmount`/`processQueue`/wrap/unwrap and `setUsdOkuRate`. No begin/end call, no epoch | Auto-armed by every `set_multiplier`/`distribute_yield` write, state on `PsmConfig`, gates `mint_oku_m`/`redeem_oku_m`. No begin/end instruction, no epoch |
| Local step arbitrage | **Real now** — closed by `tin + tout` step coverage, matching SVM | Real; closed by combined `tin + tout` step coverage |
| PSM fees | `tin`/`tout`, `tin + tout` load-bearing (step coverage), default 0 | `tin`/`tout`, combined `tin + tout` load-bearing, default 0 |
| Token standard | ERC-20 for both (OkuM raw, USDOku share-denominated rebase) | Token-2022 (OkuM with ScaledUiAmount + MetadataPointer + TokenMetadata) |
| Decimals | 18 (both tokens) | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | `SubscriptionModule.mintUsdOku`/`redeemUsdOku` — one-tx USDC ↔ USDOku via the wrapper | Direct OkuM mint/redeem on `lite-psm`; no wrapping needed |
| Redemption when buffer insufficient | Escrowed in `RedemptionQueue`, drained via `processQueue` | Reverts `InsufficientBuffer` — no queue (deliberately removed) |
| Cross-chain transfers (v1) | Off-chain orchestrator + `SubscriptionModule` mint/burn (USDC-mediated) | Off-chain orchestrator + direct burn/mint of OkuM (`burn_oku_m_direct` / `mint_oku_m_direct`) |
| Cross-chain parity check | `check-sync-parity.ts` compares `uiMultiplier()` (1e18) against SVM's mint multiplier (1e9) as scaled integers — no epoch bookkeeping | Same script, same comparison |

**Full cross-chain parity matrix** — constants, roles, pause
semantics, sandwich-fence behaviour, event schema diffs, deliberate
non-parity items — see [`SVM/README.md § EVM vs SVM — divergence
catalogue`](SVM/README.md#evm-vs-svm--divergence-catalogue).

---

## Directory structure

```
contracts/
├── README.md            # this file
├── TRACKER.md           # Open issues + follow-ups (EVM + SVM)
├── EVM/                 # Solidity contracts (Foundry + Hardhat)
│   ├── README.md        # EVM-specific deployment, contracts, runbook
│   ├── src/
│   │   ├── token/       # OkuM.sol (share token), USDOku.sol (rebasing dollar wrapper)
│   │   ├── wrapper/     # USDOkuWrapper.sol — OkuM <-> USDOku at M_oku, solvency views
│   │   ├── psm/         # SubscriptionModule.sol, RedemptionQueue.sol
│   │   ├── oracle/      # OkuMultiplierAdapter.sol
│   │   ├── interfaces/  # IOkuM.sol, IUSDOku.sol + erc8056/*
│   │   └── lib/         # Roles, Constants, MathLib, events
│   ├── test/            # Foundry + Hardhat suites
│   └── scripts/         # Deploy + operator scripts
├── SVM/                 # Anchor programs (Rust)
│   ├── README.md        # SVM-specific runbook, divergence catalogue, deployment
│   └── oku-programs/
│       ├── programs/
│       │   └── lite-psm/    # PSM (buffer-only, no queue) + yield ops + compliance + direct mint/burn
│       ├── crates/
│       │   └── oku-shared/  # Pure-Rust shared constants + math + yield lock
│       ├── tests/
│       ├── scripts/
│       ├── deployments/     # Per-network deployment records
│       └── keys/            # Local keypair directory (gitignored, see keys/README.md)
├── artifacts/           # Curated ABIs + IDLs for backend / SDK / frontend use
│   ├── evm/             # Slim Hardhat artifacts (abi + bytecode) per contract
│   ├── svm/             # Anchor IDL JSON per program
│   └── README.md        # Consumption docs for downstream services
└── addresses.json  # Canonical live deployment registry (auto-generated)
```

---

## Deployment runbook

Complete guide for deploying OkuMoney on EVM chains + Solana, and
exercising the on-chain protocol end-to-end. v1 cross-chain transfers
are off-chain orchestrator-mediated (PSM mint/burn) — there is no
on-chain bridge.

> Authoritative deployment state lives in
> [`addresses.json`](addresses.json) at the repo root,
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

Deploys MockUSDC, OkuM, SubscriptionModule, RedemptionQueue, USDOku,
USDOkuWrapper (in that order — see [Deployment ordering](EVM/README.md));
configures all roles + minter allowances (`SubscriptionModule` +
`USDOkuWrapper` hold `OKU_MINTER`; `SubscriptionModule` + `RedemptionQueue` +
`USDOkuWrapper` hold `OKU_BURNER`); verifies deployment state.
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
`"<chain>"` and to repo-root `addresses.json` under
`"evm.<chain>"`.

**SVM:**

```bash
cd SVM/oku-programs

anchor build
npm run cost                  # estimate one-time rent (program + PsmConfig + mint + ATAs)
solana airdrop 5 --url devnet # x2

# Phase 1 — deploy program .so files (writes IDs into deployments/devnet.json)
NETWORK=devnet npm run deploy:programs

# Phase 2 — create OkuM mint + initialize PSM config
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
NETWORK=devnet npm run test:onchain -- --step=redeem   # single step (mint/transfer/redeem/
                                                        # distributeYield/pause/setAuthority also available)
```

### Phase 4 — cross-chain bridge test (noBridge / PSM-mediated)

```
1. EVM source: SubscriptionModule.redeem(rawAmount) → orchestrator observes the Redeemed event + USDC outflow.
2. Destination (EVM or SVM): orchestrator deposits USDC into the destination module and calls SubscriptionModule.mint, crediting the recipient.
3. Treasury periodically tops up module USDC buffers per chain (on SVM there is no queue to drain — see [`SVM/README.md`](SVM/README.md)).
```

EVM cross-chain accounting covered by
`EVM/test/hardhat/scenarios/RealWorldUsage.ts`. Full EVM↔SVM
roundtrip bridge test:

```bash
cd SVM/oku-programs
PRIVATE_KEY=<evm-key> tsx scripts/test/bridge-svm-evm.ts \
    --evm=baseSepolia --svm=devnet --amount=5 --direction=roundtrip
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
| `MAX_STEP_BPS` | 2 (provisional) | Ceiling on a single `M_oku` mark AND the floor under `tout`. The single number defining step coverage; sized for a 6-HOURLY cadence at ~5% APY. |
| `MIN_MARK_INTERVAL` | 1 hour | Minimum wall-clock gap between marks. |
| `MAX_IMPLIED_APR` (USDOku `M_usd` only) | 1000 bps nominal | Placeholder — needs a real number. The binding economic bound on `setUsdOkuRate`. |
| `MAX_RATE_DURATION` (USDOku `M_usd` only) | 30 days | Caps the exposure window of any single rate write. |
| `MAX_SOLVENCY_GAP_BPS` (USDOku only) | placeholder | How far USDOku's declared liability may outrun realized OkuM backing. |

**SVM (`SVM/oku-programs/scripts/config/constants.ts`):**

| Parameter | Value | Notes |
|---|---|---|
| `MAX_SUPPLY` | 1 B OkuM (6 dec = 1e15 raw) | 1 B token cap. |
| `MINTER_ALLOWANCE` | 1 B OkuM | Matches EVM. **Production**: rotate weekly via `set-minter-allowance.ts`. |

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

- **EVM-specific docs:** [`EVM/README.md`](EVM/README.md) (incl. Accepted Risks)
- **SVM-specific docs:** [`SVM/README.md`](SVM/README.md) (incl. Accepted Risks)
- **Open issues:** [`TRACKER.md`](TRACKER.md)
- **Downstream SDK / backend consumption:** [`artifacts/README.md`](artifacts/README.md)
