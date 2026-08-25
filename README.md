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

### Both chains — single token, scaled display

One token per chain. Raw balances are static; yield accrues in a **multiplier**
that scales the *displayed* amount. Same construction on both sides — ERC-8056
on EVM, Token-2022 `ScaledUiAmount` on SVM.

| | EVM | SVM |
|---|---|---|
| Token | **OkuDollar** (`rUSDOku`) | **OkuM** (Token-2022 mint) |
| Standard | ERC-8056 (Draft) + ERC-4626 conversion subset | `ScaledUiAmount` + `MetadataPointer` + `TokenMetadata` |
| Multiplier home | `ScaledUIAmountUpgradeable` storage | `ScaledUiAmountConfig` on the mint |
| Accrual | **continuous** (rate + elapsed time) | **stepwise** (discrete pushes) |
| Precision | 1e18 | 1e9 |
| Decimals | 18 | 6 |

```
             raw layer                          display layer
  ┌──────────────────────────────┐   ┌────────────────────────────────┐
  │ balanceOf(user) = 954.20      │ × │ uiMultiplier() = 1.048...e18    │
  │ transfer / approve / allowance│   │ (continuous, monotone)          │
  │ — fixed, stock ERC-20 —       │   └────────────────────────────────┘
  └──────────────────────────────┘                  ║
             ║                                      ▼
   DeFi prices and accounts       balanceOfUI(user) = $1,000.00
   against this
```

**Why not rebasing.** A rebasing `balanceOf` breaks AMM pools, lending markets
and anything that snapshots balances, because the number moves underneath the
integration with no transfer to observe. Fixing the raw balance and moving growth
to a display multiplier gives users the same experience without any of that. The
degradation is graceful: a wallet that has never heard of ERC-8056 shows
`954.20 rUSDOku` rather than `$1,000.00` — a different unit count, the same
dollar value, and no false claim about what the number means.

**Two interfaces, one number.** ERC-8056 is a *display* extension: it makes no
claim about value and specifies no redemption semantics. Shipping it alone would
leave integrators with a multiplier and no standard way to price against it, so
the EVM token also exposes the ERC-4626 conversion views (`asset`, `totalAssets`,
`convertToAssets`, `convertToShares`). It is **not** fully ERC-4626 compliant and
does not claim the interface via ERC-165 — `deposit`/`redeem` live on the PSM and
may queue. See [`EVM/README.md`](EVM/README.md).

> **v0.3 migration note.** Prior versions ran a dual-token split economy on EVM:
> `OkuMoney` (non-rebasing, stored multiplier) plus `OkuDollar` (a rebasing vault
> holding OkuMoney as reserves), with revenue extracted from the spread between
> two independent rates. That model is gone. `OkuMoney`, the share ledger,
> wrap/unwrap, and the collateralization machinery were all deleted; `OkuDollar`
> is now the single token and carries the `rUSDOku` ticker. The v0.2 proxies are
> **retired, not upgraded** — the storage layouts are unrelated.

**Cross-chain accrual granularity diverges, deliberately.** Token-2022 rejects
`ScaledUiAmount` and `InterestBearingConfig` on the same mint
([`extension/mod.rs:1365`](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs)),
so the Solana side is stepwise by construction. EVM accrues continuously because
a discrete revaluation creates a single block at which every cached multiplier in
every integration is simultaneously wrong. The two chains therefore share an
interface but not a trajectory: multipliers diverge within a step interval by up
to one step's yield. The orchestrator publishes the acceptable skew; a small
standing cross-chain arbitrage cost is accepted.

---

## On-chain components

### EVM

```
┌──────────────────────────────────────────────────────────────────┐
│                     EVM On-Chain Contracts                        │
│                                                                   │
│   USDC ──►┌───────────────────────────────────────────┐          │
│           │            OkuDollar (rUSDOku)             │          │
│           │  ERC-20      raw, 18dp    ← ACCOUNTING     │          │
│           │  ERC-4626    conversion   ← VALUE          │          │
│           │  ERC-8056    scaled UI    ← DISPLAY        │          │
│           │  continuous rate-based multiplier          │          │
│           └──┬─────────────────────────────┬──────────┘          │
│              │ OKU_MINTER / OKU_BURNER     │ uiMultiplier()      │
│              ▼                             ▼                     │
│       ┌──────────┐  QUEUE_PSM  ┌──────────────────────┐         │
│       │ LitePSM  │◄───────────►│ OkuMultiplierAdapter │         │
│       │ USDC buf │             │ (AggregatorV3 shim)  │         │
│       └────┬─────┘             └──────────────────────┘         │
│            ▼                                                      │
│     ┌──────────────────┐                                         │
│     │ RedemptionQueue  │                                         │
│     └──────────────────┘                                         │
│                                                                   │
│  (Cross-chain transfers are orchestrator-mediated via PSM         │
│   mint/burn on each chain — no on-chain bridge in v1.)            │
└──────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **OkuDollar** (`rUSDOku`) | The token. Static raw balances; yield in a continuous UI multiplier. ERC-8056 display layer + ERC-4626 conversion views. |
| **LitePSM** | Peg Stability Module — USDC ↔ rUSDOku at the multiplier. Sole user-facing mint/redeem surface. |
| **RedemptionQueue** | FIFO queue when the PSM buffer is insufficient. Escrows raw tokens, which keep appreciating while queued. |
| **OkuMultiplierAdapter** | Chainlink `AggregatorV3Interface`-compatible feed over `uiMultiplier()`, with bounds and staleness. Reports **18** decimals, not Chainlink's usual 8. |

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

### EVM — continuous, rate-based

One setter: `OkuDollar.setYieldRate(ratePerSecond, endTimestamp)` (`OKU_RATE_SETTER`).

```
uiMultiplier() = baseMultiplier × rpow(ratePerSecond, elapsed, 1e18) / 1e18
elapsed        = min(block.timestamp, rateEnd) − lastAccrualTime
```

The Aave liquidity-index / sDAI `chi` pattern. It changes every second with no
transaction, so there is no block at which every cached multiplier is
simultaneously wrong — and therefore **no sandwich guard, no announcement window,
and no forward pricing** anywhere in the EVM stack. Removing that machinery is
the main practical dividend of going continuous.

**Accrual halts at `rateEnd`, and that is a safety mechanism.** If the rate setter
stops functioning the multiplier stops growing rather than accruing indefinitely
against assets that are not there. `rateEnd` is mandatory; zero or past values are
rejected. The operational consequence is that a missed renewal freezes yield until
someone acts, and because the APR cap also binds the catch-up rate, a long outage
cannot be fully compensated afterwards.

**The setter is an oracle write.** The moment a lending market prices off
`uiMultiplier()`, a wrong value mints borrowing power directly, and
`totalAssets()` is derived from the multiplier rather than measured — so there is
no on-chain referent to catch a mistake. Bounds:

| Control | Value | Purpose |
|---|---|---|
| `MAX_IMPLIED_APR` | 1000 bps nominal | The binding economic bound |
| `MAX_RATE_DURATION` | 30 days | Caps the exposure window of any single write |
| Monotonicity | `rate >= 1e18` | The multiplier can never decrease |
| `MAX_MULTIPLIER` | 1e24 | Checked against the value *projected to* `rateEnd` |
| `haltAccrual()` | `OKU_GUARDIAN`, no timelock | Freeze immediately; withhold-only, cannot reduce |

Worst-case over-accrual from a compromised setter key inside one maximum-length
segment is ~0.82%.

### SVM — discrete, pushed

`set_multiplier()` or `distribute_yield()` on lite-psm (`rebaser`). Because these
*are* discrete revaluations, the SVM side retains the single-slot sandwich fence:
both write paths stamp `last_yield_distribution_slot`, and PSM operations revert
in the same slot. EVM no longer needs the equivalent and has dropped it.

## PSM (Peg Stability Module)

### EVM — USDC ↔ rUSDOku at the multiplier

```
mint:    raw  = (usdcAmount × usdcDecimalMultiplier) × PRECISION / uiMultiplier()
redeem:  usdc = (raw × uiMultiplier() / PRECISION) / usdcDecimalMultiplier
```

At a multiplier of 1.05, depositing 100 USDC yields ~95.24 raw — which *displays*
as $100.00. Redeeming those 95.24 raw returns ~100 USDC.

`quoteMint` / `quoteRedeem` / `redeemableNow` are public views; a UI showing a
quote must use them rather than recomputing. `redeemUiAmount(uiAmount)` exists as
a convenience but floors the UI→raw conversion, so a true max-redeem must use
`redeem(balanceOf(user))`. See the max-send rule in
[`EVM/metadata/DISPLAY_CONVENTION.md`](EVM/metadata/DISPLAY_CONVENTION.md).

There is a single source of truth for the USDC binding: the token holds `asset()`
and `usdcDecimalMultiplier()`, and both `LitePSM.initialize` and
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

1. User redeems OkuM for USDC on chain A via `LitePSM.redeem`.
2. Orchestrator observes the burn, waits for finality, then performs
   an equivalent USDC-funded `LitePSM.mint` on chain B crediting the
   recipient.
3. PSM USDC buffers on each chain are rebalanced operationally by
   treasury.

**`LitePSM.mint` is permissionless.** Any address with USDC can call it;
the orchestrator does NOT hold `OKU_MINTER`. Orchestrator key
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
- **SVM → EVM:** `burn_oku_m_direct` on SVM, then `LitePSM.mint` on
  EVM (orchestrator supplies USDC). There is only one EVM token now,
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
| No sync window open (either chain) | `OkuDollar.isSyncLocked()` | `now < psmConfig.syncLockUntilTs` |
| Sync epochs agree across chains | `OkuDollar.syncEpoch()` | `psmConfig.syncEpoch` — or just run `check-sync-parity.ts` |
| Destination supply headroom | `OkuDollar.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuDollar.minterAllowance(psm) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user token balance | `OkuDollar.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(psm) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` (EVM↔SVM only; SVM↔SVM uses direct burn/mint) |
| Recipient ATA not frozen | `OkuDollar.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |

If the EVM source PSM buffer is insufficient, the redeem succeeds but
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
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap), wait for the blocking condition to clear, retry `LitePSM.mint` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain balance is already burned. |
| Source redeem was queued | Don't mint on destination until USDC is in hand. Poll queue state every ~30 s; call `depositBuffer` + `processQueue` to accelerate. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Multiplier-tick sequencing across chains

The multiplier (`uiMultiplier` EVM / `multiplier` SVM) is updated by
`OKU_RATE_SETTER` (EVM, as a rate) / `rebaser` (SVM, as a step).

A tick is **not atomic across chains**. While it propagates, the two sides price a
raw token differently, so anything converting value through the multiplier in that
interval settles at a stale price on one side. This is now an enforced protocol
rather than a timing convention.

**The three-step tick. Same `epoch` number on every chain.**

```
1. OPEN     EVM:  beginSyncWindow.ts --epoch=N
            SVM:  sync-window.ts --begin --epoch=N

2. WRITE    EVM:  setYieldRate.ts          (optional - accrual is continuous)
            SVM:  set-multiplier.ts        (REQUIRED - see below)

3. CLOSE    EVM:  endSyncWindow.ts --epoch=N
            SVM:  sync-window.ts --end --epoch=N
```

**Step 2 is mandatory on SVM.** `end_sync_window` refuses to close a window in
which no multiplier write landed (`NoWriteInEpoch`), so `sync_epoch` cannot
advance against an untouched multiplier. That is what makes epoch parity a real
completion check rather than a claim. EVM has no such requirement — accrual there
is continuous, so nothing needs to land per tick; its role in the window is to
hold still while SVM catches up.

**SVM will refuse a step larger than `tout` covers.** If `set-multiplier.ts`
fails with `StepExceedsFeeCoverage`, the fee is too small for the step — either
raise `tout` (`set-fees.ts`) or take a smaller step. With `tout = 0` no step is
possible at all. A single step can never exceed 1%, so catching up a long outage
takes several ticks.

Between step 1 and step 3, `mint` / `redeem` / `redeemUiAmount` / `processQueue`
(EVM) and `mint_oku_m` / `redeem_oku_m` (SVM) revert. Buffer movement, the direct
mint/burn bridge legs, and the multiplier writes themselves stay open — the gating
rule is *gated iff the instruction prices through the multiplier*.

**Verify with `check-sync-parity.ts` before step 1 and after step 3.** Neither
chain can observe the other, so epoch equality read from outside is the only
available proof that a tick completed symmetrically:

```bash
cd SVM/oku-programs
npm run admin:check-sync-parity -- --evm=base --svm=mainnet-beta --strict
```

**Failure modes.**

- **Forgot step 3.** The window auto-expires after `syncWindowDuration()`
  (≤ `MAX_SYNC_WINDOW`, 15 min). Users are delayed, never stranded. The absence of
  a `SyncWindowClosed` event before expiry is the alarm.
- **Step 2 landed on only some chains.** Epochs will agree (step 1 set them) but the
  multipliers diverge persistently. `check-sync-parity.ts` cannot detect this —
  reconcile against the intended rate directly, and re-run step 2 on the missing chain.
- **Crashed between 1 and 2.** Window expires, nothing was written, epochs still
  agree. Safe: retry the whole tick with `epoch = N+1`.
- **Gap not elapsed.** `beginSyncWindow` reverts with `SyncWindowGapNotElapsed`.
  `MIN_SYNC_WINDOW_GAP` (6 h) bounds the duty cycle to guarantee a ≥96% availability
  floor; a tick cadence tighter than that is not supported by design.
- **Step refused.** `StepExceedsFeeCoverage` on SVM — the fee does not cover the
  step. Raise `tout` first, or split the move across several ticks.
- **Close refused.** `NoWriteInEpoch` on SVM — the window was opened but step 2
  never landed. Complete the write, or let the window expire and retry the whole
  tick at `epoch = N+1`.

**If sequencing still diverges,** per-bridge dollar value remains conserved — the
PSM uses the current multiplier at redemption time on source and at mint time on
destination. The recipient may receive a slightly different raw amount; dollar
value is equivalent.

**Still wait one slot (SVM) after a write** before bridging: the same-slot
`YieldDistributionInProgress` fence is independent of the sync window and remains
in force.

> **The window is not a step-arbitrage defence.** Holding raw across a discrete
> multiplier step needs no transaction while the window is open, so no window
> length deters it. On SVM the `tout` fee is the control — and it is now enforced
> on-chain, not merely advised: a step larger than `tout` covers is refused, and
> `tout` cannot later drop below a step already taken. On EVM continuous accrual
> means there is no step to hold across. Do not substitute one mechanism for the
> other.

#### Minter allowance rotation policy

`minterAllowance` on `OkuDollar` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds how many raw OkuM tokens the PSM can mint on each chain
before an explicit refresh.

- **Testnet:** `minterAllowance == maxSupply == 1B` — effectively uncapped for dev.
- **Production:** ~ **1 % of weekly bridging volume**, rotated on a **weekly cadence** by `OKU_ALLOWANCE_MANAGER` (cold multisig). Bounds a single-week worst-case mint by a compromised PSM contract or orchestrator USDC custody.

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
| Queue depth (EVM only) | Oldest pending entry > 24 h unfilled | SVM has no queue — buffer depletion reverts the redeem instead |
| PSM buffer | < 2 × expected daily redemption volume | Depleted buffer reverts SVM redeems with `InsufficientBuffer`; EVM redeems queue instead |
| Minter allowance | < 10 % of weekly throughput estimate | |
| Pause state | PSM paused for > 15 min unexpectedly | |
| Sync epoch parity | `syncEpoch()_evm != sync_epoch_svm` for > 5 min | A tick did not complete symmetrically; the chains may be pricing differently. Run `check-sync-parity.ts --strict`. |
| Sync window expiry | `SyncWindowOpened` with no matching `SyncWindowClosed` before `lockedUntil` | The liveness backstop fired instead of the happy path — usually an orchestrator death mid-tick |
| Unexpected auto-arm | `SyncWindowOpened` with `autoArmed = true` | Multiplier written without running the tick protocol. Fail-closed worked, but the runbook was skipped |
| `tout` vs cadence (SVM) | `set_multiplier` failing `StepExceedsFeeCoverage` | The fee no longer covers the intended step — rebasing is blocked until `tout` is raised. Fail-closed, but it stops yield accruing |
| Step high-water reset (SVM) | any `StepHighWaterMarkReset` event | Cold multisig cleared the floor under `tout`, reopening historical step exposure. Should be rare and deliberate |
| Sync close refused (SVM) | any `NoWriteInEpoch` | A window was opened without a multiplier write landing — the tick protocol was run out of order |

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
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, PSM_FEE_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, RESERVE_MANAGER | role_admin, unpauser, cap_manager, allowance_manager, buffer_withdrawer |
| Warm Multisig | all PAUSER, all BLACKLISTER | pauser, freezer |
| Orchestrator | OKU_RATE_SETTER (incl. `begin`/`endSyncWindow`), PSM_QUEUE_PROCESSOR, PSM_BUFFER_DEPOSITOR | rebaser (incl. `begin`/`end_sync_window`), buffer_depositor, direct_minter, direct_burner |

The sync window and the fee schedule deliberately add **no new keys**. Window
control sits with the existing rate-setter/rebaser — the actor that writes the
multiplier is the one that knows when a tick has landed everywhere. Fee and
window-length setting sits with the existing cold cap-manager, as economic policy.
`PSM_FEE_MANAGER` is a separate *constant* from `OKU_CAP_MANAGER` only because
AccessControl mappings are per-contract; it is intended for the same cold key.
| LitePSM | OKU_MINTER, OKU_BURNER | Mint authority on the OkuM Token-2022 mint |
| RedemptionQueue | OKU_BURNER | no SVM equivalent — redemption queue removed entirely, buffer-only PSM |

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
- Extract protocol revenue. On EVM this is now purely off-chain: the vault
  and `withdrawSurplus` are gone, so the orchestrator sets a rate that already
  accounts for the protocol take (matching the SVM model).
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
- Blacklist any address on OkuDollar (EVM).
- On SVM: freeze any OkuM ATA via Token-2022 freeze authority.

**Cannot:**
- Unpause or unblacklist (cold multisig only). Pause is a one-way
  door for the warm key.
- Access any funds or parameters.

#### Orchestrator (KMS-backed, automated)

**Can:**
- Set the accrual rate (EVM `setYieldRate`) / push the multiplier (SVM `set_multiplier`)
  (non-decreasing, bounded by `MAX_MULTIPLIER`). A compromised
  rebaser key can ratchet the multiplier toward the ceiling,
  inflating token dollar value beyond the actual T-Bill backing rate.
- Raise the EVM accrual rate (bounded by `MAX_IMPLIED_APR` and `MAX_RATE_DURATION`).
  An extreme bump would push the vault toward the
  reserves. (Not applicable on SVM — no vault.)
- Process the redemption queue (EVM only — SVM has no queue).
- Deposit USDC to the PSM buffer.
- Call `mint` / `redeem` (EVM) or `mint_oku_m` /
  `redeem_oku_m` (SVM) as a normal user (**permissionless** — the
  orchestrator holds no special mint authority, only USDC custody).
- On SVM: call `mint_oku_m_direct` / `burn_oku_m_direct` for
  cross-chain bridge operations (requires `direct_minter` /
  `direct_burner` roles).

**Cannot:**
- Mint rUSDOku directly on EVM. `OKU_MINTER` is held by the PSM /
  RedemptionQueue contracts.
- Access admin parameters, role grants, upgrades.
- Drain the USDC buffer (cold-multisig BUFFER_WITHDRAWER only).

#### Protocol contracts (LitePSM, RedemptionQueue)

**EVM:** Hold `OKU_MINTER` / `OKU_BURNER`. Mint via
`OkuDollar.mint()` only during `LitePSM.mint`, gated by
per-minter `minterAllowance` and the global `maxSupply` cap. Burn
(cycle-4 split role) only via `OkuMoney.burn()` from inside
`LitePSM.redeem` / `RedemptionQueue.processQueue`.

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
| Token model | Single-token: OkuDollar (`rUSDOku`) with the ERC-8056 ScaledUIAmount extension | Single-token: OkuM with the Token-2022 ScaledUiAmount extension |
| Multiplier | Continuous, derived from a stored rate + elapsed time (`rpow`), 1e18 precision, 18-decimal token | Discrete, stored on the mint extension (`ScaledUiAmountConfig`), 1e9 precision, 6-decimal token |
| OkuDollar multiplier | Continuous `_rpow` streaming | N/A — single-token model; multiplier serves as both pricing and UI display |
| Same-slot yield fence | none — continuous accrual has no distribution tx to co-locate with | `Clock::slot` comparison against `last_yield_distribution_slot` |
| Cross-chain sync window | `block.timestamp`, state on `OkuDollar`, gates `mint`/`redeem`/`redeemUiAmount`/`processQueue` | `Clock::unix_timestamp`, state on `PsmConfig`, gates `mint_oku_m`/`redeem_oku_m` |
| Local step arbitrage | none possible — accrual is continuous | real; closed by `tout`, not by the window |
| PSM fees | `tin`/`tout` for parity, default 0 | `tin`/`tout`, `tout` load-bearing, default 0 |
| Token standard | ERC-20 (custom rebasing for OkuDollar) | Token-2022 (OkuM with ScaledUiAmount + MetadataPointer + TokenMetadata) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | Direct OkuM mint/redeem on the PSM; no wrapping needed |
| Redemption when buffer insufficient | Escrowed in `RedemptionQueue`, drained via `processQueue` | Reverts `InsufficientBuffer` — no queue (deliberately removed) |
| Cross-chain transfers (v1) | Off-chain orchestrator + LitePSM mint/burn (USDC-mediated) | Off-chain orchestrator + direct burn/mint of OkuM (`burn_oku_m_direct` / `mint_oku_m_direct`) |

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
│   │   ├── token/       # OkuDollar.sol (rUSDOku)
│   │   ├── psm/         # LitePSM.sol, RedemptionQueue.sol
│   │   ├── interfaces/  # IOkuDollar.sol + erc8056/*
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

Deploys MockUSDC, OkuMoney, OkuDollar, RedemptionQueue, LitePSM;
configures all roles + minter allowances (LitePSM + RedemptionQueue
hold `OKU_MINTER` / `OKU_BURNER`); verifies deployment state.
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
1. EVM source: LitePSM.redeem(rawAmount) → orchestrator observes the Redeemed event + USDC outflow.
2. Destination (EVM or SVM): orchestrator deposits USDC into the destination PSM and calls LitePSM.mint, crediting the recipient.
3. Treasury periodically tops up PSM USDC buffers per chain (on SVM there is no queue to drain — see [`SVM/README.md`](SVM/README.md)).
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
| `MAX_IMPLIED_APR` | 1000 bps nominal | Placeholder — needs a real number. The binding economic bound on the rate setter. |
| `MAX_RATE_DURATION` | 30 days | Caps the exposure window of any single rate write. |

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
