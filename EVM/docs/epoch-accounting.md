# Rear-Facing Epoch Accounting

> Design record for the off-chain epoch/yield machinery. **No contract reads
> any of this** — the chain sees only `(rate, rateEnd)` absolute timestamps.
> Kept out of `EVM/README.md` because it documents an orchestration model and
> a simulation study, not the Solidity surface.
>
> Contract-side entry points: `OkuMoney.setOkuMYieldRate`,
> `setNextOkuMYieldRate`, `setOkuMYieldRateWithSuccessor`.
> Operator scripts: `EVM/scripts/operator/`. Math: `packages/yield-tooling/src`
> (re-exported through the `EVM/scripts/utils/` shims that the paths below name).

---

Yield is **fully rear-facing**: the rate published for a fixed epoch is
derived from a PRIOR epoch's confirmed, realized off-chain proceeds. There is
no forecasting and no deliberate withholding (`conservativeFactor = 1.0`).
The machinery below exists to convert a realized
dollar amount into a rate correctly, and to reconcile the residual that
conversion cannot avoid — not to manage a forecast.

## The pipeline

The chicken-and-egg problem: epoch N's realized yield is only known *after* N
closes, but streaming it over N+1 would require the rate to be set exactly at
the N→N+1 boundary — a transaction on every chain at every boundary, which is
precisely the per-tick coordination streaming exists to remove.

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

Because nothing is broadcast at the boundary itself, every chain flips at the
same second. **Cost:** a two-epoch lag between earning and paying — at the
adopted 24-hour grid, two days.

**Operational rails:**

- **Every yielding rate requires a bounded `okuMRateEnd` window.**
  `endTimestamp = 0` is valid only when explicitly halting
  (`newRate == PRECISION`). `setNextOkuMYieldRate` additionally requires
  `pendingEndTimestamp` strictly after the current `okuMRateEnd`.
- **Re-arming an unchanged rate is exactly skew-free.** Broadcast skew `δ`
  between chains on the re-anchor path causes a permanent divergence of
  `(r_old / r_new)^δ` — exactly `1` when the rate does not move. The initial
  `0% → r` activation is the one genuinely skew-sensitive event.
- Rates are always **derived from a declared APY**, never hand-entered, so
  every chain receives a byte-identical integer.

## Why you can't just pick a nominal USD amount to distribute

The naive design — "we earned $40,000 last epoch, so distribute exactly
$40,000 this epoch" — is **not achievable** for a fungible, streaming-accrual
token, and it's worth being precise about why, because the failure mode is
subtle rather than a missing feature.

Dollars actually distributed over an epoch is:

```
Y_dist = ∫ S(t) dm(t) = rate · V̄ · W
```

where `S(t)` is global raw OkuM supply, `m(t)` the multiplier, `V̄` the
TIME-WEIGHTED AVERAGE dollar value over the epoch (`S(t)·m(t)` integrated), and
`W` the epoch length. `rate` is fixed at epoch start (that's what makes it
pre-committable and cross-chain deterministic — see `EVM/README.md` § Streaming
Accrual & Cross-Chain Determinism). `S(t)`
is a free variable: anyone can mint or redeem through the permissionless PSM.
Two different supply paths under the identical rate produce two different
`Y_dist`. **No rate chosen in advance can guarantee a nominal dollar amount**,
because a multiplier is inherently a per-unit quantity and total = per-unit ×
units, where units are not under the protocol's control.

Four ways out exist, and three of them cost something significant:

| Approach | Hits a nominal `Y*` exactly? | Cost |
|---|---|---|
| Publish a rate, accept `Y_dist` varies with AUM | No | None — this is the adopted model |
| Adjust the rate mid-epoch via feedback | Yes | **Breaks cross-chain determinism** — every adjustment is an N-chain simultaneity event again, and it goes singular as `t → W` |
| Fix the amount, divide by supply (a discrete `distributeYield`-style tick) | Yes | **Reintroduces dilution** — the protocol has no such mechanism; a late entrant dilutes every existing holder's per-token yield |
| Per-holder equalisation (fund-industry standard for exact fixed payout) | Yes | Requires per-investor cost basis — **fundamentally incompatible with a fungible ERC-20**, where two OkuM with different entitlements would not be the same token |

Money-market funds — the closest traditional analogue — accrue at a **declared
rate**, not a fixed distributed amount, for exactly this reason. Rate-based is
the industry-standard approach for a cash-like instrument, not a compromise
particular to this protocol.
Money-market funds are also the proof that rate-based is not a downgrade: if
the desk deploys new capital promptly it is strictly **better** for holders —
capital arriving mid-epoch earns proportionally, no existing holder is diluted
by a late entrant, and the protocol stays financially square automatically as
AUM moves, which fixing the amount would not.

## The "Two V's" — measurement basis vs. paying basis

Converting realized yield into a rate requires care about WHICH average value
is the denominator. There are two conceptually different quantities, and
conflating them is the single most common way to implement this wrong:

1. **The measurement epoch's time-weighted average** (`measuredAvgValueUsd` in
   `scripts/utils/yieldRate.ts`) — integrated over the CLOSED epoch whose
   realized yield is being converted into a rate. This must be time-weighted,
   not a spot value at epoch start: if supply changes mid-epoch, a spot
   denominator mis-measures the realized rate by exactly the factor supply
    moved (a 25% AUM change mid-epoch mis-measures the rate by ~25%; see the
    "spot denominator vs time-weighted denominator" tests in
    `test/hardhat/unit/epochDistribution.test.ts`).
2. **The paying epoch's average value** — unknown at the time the rate is
   published, because it depends on future mint/redeem activity. This is NOT
   an input to the rate derivation; the rate accrues per-token, uniformly,
   regardless of how much future supply exists.

Getting (1) right makes the published number a correctly-measured REALIZED
RATE, decoupled from that epoch's own AUM path. It does **not** make future
dollars paid equal the historical realized amount — that gap is driven by (2),
specifically by how much the underlying yield rate itself moves between the
measurement epoch and the paying epoch (rate drift), not by AUM growth. Rate
drift is small because T-bill yields move slowly; AUM can move arbitrarily
fast via mint/redeem. Decoupling the published rate from supply is the
feature, not an approximation of a fixed-dollar target.

## Mechanism

`scripts/utils/yieldRate.ts::realisedYieldToRatePerSecond` takes the closed
epoch's realized yield, its own time-weighted average value, a **carried-in
balance** from the previous epoch, and an (optional, defaults to `1`)
**conservative factor**:

```
publishedUsd = realisedYieldUsd * conservativeFactor + carryInUsd
rate         = ratePerSecond such that publishedUsd compounds over the window
carryForward = (realisedYieldUsd + carryInUsd) - achievedUsd     // basis (1) only
```

`carryForward` captures `PRECISION`/`MAX_RATE` clamping and float/rpow rounding
dust — and, if `conservativeFactor < 1` is ever used, the deliberately withheld
spread — uniformly, all measured against basis (1). It does **not** capture
basis-(2) effects (actual paying-epoch AUM). There is **no on-chain "true-up"
transaction** for any of this: every correction is expressed as a later
epoch's rate being different from what it would otherwise have been.

## Closing the loop: `reconcileActualPayout`

For TRUE cumulative conservation against on-chain reality (not just internal
bookkeeping against basis (1)), `scripts/utils/yieldRate.ts` also exports
`reconcileActualPayout(targetUsd, actualPaidUsd)`. Once a paying epoch has
closed and its OWN time-weighted average value is measurable (via
`scripts/utils/globalValue.ts`), compute what the published rate ACTUALLY
delivered and feed the residual into the next epoch's `carryInUsd` instead of
(or summed with) the basis-(1)-only `carryForward`. This closes the gap driven
by rate drift between the measurement and paying epochs — the one thing
`realisedYieldToRatePerSecond` cannot know about at the time it runs.

## Cumulative conservation

Per-epoch amounts float with AUM; the ledger closes cumulatively. Because
`carryForward(i) = (realized(i) + carryIn(i)) − achieved(i)` and
`carryIn(i) = carryForward(i−1)`, summing telescopes to:

```
Σ achieved = Σ realized − outstandingCarry
```

`scripts/utils/carryLedger.ts` persists every epoch's derivation and computes
this identity via `summarizeLedger()`; `checkMultiplierDrift.ts` reports it on
every run. Entries are keyed on `epochId` and written via `upsertLedgerEntry`,
which is idempotent on a matching re-run and refuses to silently overwrite a
different recorded derivation for the same epoch label.

**The defensible accounting claim** is therefore: *cumulative distributed
tracks cumulative realized yield exactly, up to the outstanding carry balance,
which is reported* — **not** "every epoch pays its own realized amount
exactly," which the impossibility result above rules out.

## Adopted: base + settlement window (design "B3")

Splitting the epoch improves on straight rate publication with a single new
contract function (`setOkuMYieldRateWithSuccessor` — see below) and 2
transactions per epoch per chain:

```
epoch N (24h)
├───────────── base window (22.4h) ─────────────┤├ settle (1.6h) ┤
   rate r_base, targets baseWindowFraction         rate r_settle,
   of the (already cross-epoch-adjusted) target     derived from LIVE
                                                     measured data,
                                                     closes the remainder
```

The settlement fraction is `DEFAULT_SETTLEMENT_FRACTION = 1/15` and scales
with the epoch, so the split is expressed once and holds at any grid.

`r_settle` is derived and staged in the SAME atomic transaction that
re-anchors `r_base` (see `setOkuMYieldRateWithSuccessor` below), and activates
at the base-window boundary with **no transaction** (preserving cross-chain
simultaneity — see `EVM/README.md` § Streaming Accrual & Cross-Chain
Determinism). This turns the accounting error
second-order (a short-window residual, rather than the whole epoch) at the
cost of two transactions per epoch per chain.

**Two independent knobs — do not conflate them:**

1. **Cross-epoch conservatism** (`conservativeFactor` / `carryInUsd`, already
   in `yieldRate.ts`) — discount the OVERALL epoch target BEFORE either
   window runs; the withheld remainder carries to the NEXT epoch. Insurance
   against the settlement window's own forecast being wrong.
2. **Within-epoch split** (`baseWindowFraction`, `scripts/utils/epochSchedule.ts`)
   — of whatever the target is (already reflecting (1)), what fraction the
   base window alone attempts, with settlement closing the remainder using
   freshly measured data. This is what actually shrinks AUM-volatility error.

`scripts/utils/epochSchedule.ts` implements the split;
`scripts/utils/epochDistribution.ts` implements the underlying settlement-rate
derivation and the sampled-supply distribution integral; both are validated
against a real deployed contract (not just off-chain math) in
`test/hardhat/simulation/epochAccounting.simulation.ts`.

## `setOkuMYieldRateWithSuccessor` — the atomicity fix

The base+settlement model re-anchors the active rate AND stages its successor
at every boundary, twice per epoch, forever. Doing that as two separate
transactions has a real failure window: `setOkuMYieldRate` unconditionally
clears any pending rate, so if the first transaction lands and the second
fails or is delayed, the chain is left with **no successor staged** — accrual
then silently halts at `endTimestamp` until the operator notices.
`setOkuMYieldRateWithSuccessor(newRate, endTimestamp, nextRate,
nextEndTimestamp)` closes this window entirely: it is a pure composition of
`setOkuMYieldRate` followed by `setNextOkuMYieldRate` in one transaction, with
every check, event, and pause-gate behavior of both unchanged. Both writes
land or neither does.

## Simulation results

Measured against `test/hardhat/simulation/epochAccounting.simulation.ts` at the
commit that last touched this file; rerun to refresh.

The simulation runs each scenario against a real deployed `OkuMoney`, measuring
dollars ACTUALLY distributed (computed exactly from the scripted mint/burn event
history and the true rate segments — independent of the periodic-sampling
approximation the settlement derivation itself uses) against the raw target `Y*`.
**On-chain/off-chain model parity held to ~1e-7% across every normal-range
scenario** (looser, ~1e-5%, at the deliberately-extreme `MAX_RATE`-clamping
scenario — see below) — the pure-TS math in
`epochDistribution.ts`/`epochSchedule.ts` matches the real contract's `rpow`
accrual essentially exactly, so the off-chain derivation can be trusted
without re-deploying to verify each decision.

`test/hardhat/unit/epochDistribution.test.ts`'s "CORE VALIDATION" test is the
load-bearing regression guard: with **no** buffer (`conservativeFactor = 1.0`)
and flat supply, the pipeline must land within rounding of `Y*`. Without it, a
systematic over-distribution could hide behind a deliberate buffer that happens
to cancel it.

**Baseline**: 1,000,000 OkuM global supply, 3.2% realized on-chain APY (after
off-chain spread from a ~3.5% RWA return), **24-hour epoch**, 1.6-hour (1/15)
settlement window, `baseWindowFraction = 0.9`.

**The adopted `conservativeFactor` is `1.0`** — no buffer, pure rear-facing.
The scenario tables below were nonetheless *run* with a `0.97` buffer engaged,
because the buffer was the variable under study; that is why they report a
≈`-3%` floor rather than `0`. Read them as *relative* comparisons between
settings, not as the accuracy of the shipped configuration. Where a table
reports error "vs. ADJUSTED target" it has already divided that `-3%` out; where
it reports "vs. raw `Y*`" the `-3%` is still in the number and ≈`-3.00%` is that
table's no-shock baseline. Under the adopted `1.0` both collapse to the same
thing and the no-shock baseline is `0`.

**Yield level** (fixed epoch/buffer/split, moderate +20% mid-epoch volatility,
error vs. ADJUSTED target, so the buffer is divided out):

| Realized APY | Error vs adjusted target |
|---|---|
| 0.05% (very low) | −2.69% |
| 3.2% (baseline) | −2.69% |
| 15% (high) | −2.69% |
| 60% (very high) | −2.65% |
| 2000% (near `MAX_RATE`'s 2242% APY ceiling) | −2.25% |

Error is essentially **independent of yield level** across five orders of
magnitude of APY — it's driven by AUM dynamics and the buffer/split settings,
not by how large the rate itself is. A separate scenario deliberately exceeds
`MAX_RATE` (50,000% APY target) to confirm the clamp behaves correctly:
`floatRateToBigint` caps the rate rather than reverting, and the result is a
large, honestly-reported shortfall (**−55.63%** vs. raw `Y*`) rather than a
crash or silently-wrong number — the config is unreachable at that AUM, and
the mechanism says so.

**Cross-epoch buffer (`conservativeFactor`) extremes**, flat supply unless noted:

| Setting | Error vs raw `Y*` | Finding |
|---|---|---|
| **`1.0` — ADOPTED** | +1.80% (under adverse late-shock forecast) | No buffer, so nothing absorbs a bad settlement-window forecast. Accepted: variance is carried, not buffered. |
| `0.97` | **−3.00%** (exactly `-(1-0.97)`) | A buffer costs exactly what it's supposed to, no more |
| `0.5` (excessive) | **−50.00%** (exactly `-(1-0.5)`) | Permanently withholds half of every epoch's yield as carry, even at ZERO volatility — an oversized buffer has a real, ongoing cost, not just a safety margin |

The non-unity rows land almost exactly on `-(1-conservativeFactor)`,
confirming the mechanism does precisely what it is designed to do.

**`1.0` is the decision.** A `0.97` setting does not protect against the
early-shock overshoot, because a 3% margin is not meaningful mitigation against a
~28% overshoot. `conservativeFactor` smooths ordinary epoch-to-epoch variance;
it does not bound a shock. Holding permanent float for that benefit is not
worth it — variance is absorbed by the carry ledger and by PSM liquidity
instead.

**Within-epoch split (`baseWindowFraction`) extremes**, fixed +50% mid-BASE-window
shock (lands before settlement is staged), error vs. raw `Y*` (buffer still
applied, so compare against the ≈-3% baseline, not zero):

| Setting | Error vs raw `Y*` | Finding |
|---|---|---|
| TRUE feed-forward control (`noSettlement`, single rate for the whole epoch) | **+16.94%** | Honest no-B3 baseline — NOT `baseWindowFraction=1.0`, which still runs a same-rate settlement window and understates this |
| `0.9` (recommended) | +7.58% | Materially better than the true feed-forward control under IDENTICAL volatility |
| `0.3` | −3.00% | Numerically fine here — but this table alone does NOT justify preferring 0.9. See the experiment below, which does. |

**Shock inside the settlement window.** The mid-base-window shock above lands
*before* settlement is staged, so a *smaller* base commitment (0.3) means *less*
exposure to that particular disruption — it does not test whether 0.3
concentrates risk in the settlement window. The scenario that does is an
identical +50% shock landing **inside the settlement window itself**, after its
rate is already staged against a forecast that could not see the shock coming:

| Setting | Error vs raw `Y*` | Base-window exposure to the disrupted period |
|---|---|---|
| `0.3` | **+13.99%** | 70% of target committed to the settlement window |
| `0.9` | **−0.57%** | 10% of target committed to the settlement window |

**`0.9` is materially better** — this is the scenario that demonstrates the
risk (the "EXPERIMENT" test in the simulation file). The general principle: `baseWindowFraction` trades off
which window absorbs a shock's risk — a lower value shifts more target weight
onto the settlement window, which is unavoidably short and forecast-only.
`0.9` keeps that exposure small (10%) at the cost of slightly worse accuracy
under a base-window-only shock; `0.3` inverts that trade. Recommend `0.9`.

**Epoch length — a MECHANISM smoke test across scales, NOT an accuracy
comparison.** The table below confirms `setOkuMYieldRateWithSuccessor`, the
schedule derivation, and the on-chain/model parity all function correctly at
epoch lengths spanning five orders of magnitude (1 hour to 90 days). **It does
NOT demonstrate how accuracy varies with epoch length** — see the limitation
below for why the "error" column isn't a real independent measurement of that.

| Epoch length | Settlement window | Status |
|---|---|---|
| 1 hour | 4 minutes | Mechanism characterization only — 4 minutes is not an operational window |
| **1 day** | **1.6 hours** | **ADOPTED — the production grid** |
| 7 days | 11.2 hours | Mechanism characterization only |
| 30 days | 2 days | Mechanism characterization only |
| 90 days | 6 days | Mechanism characterization only |

**24 hours is the adopted production grid** (`scripts/config/epoch.ts`),
anchored at 2026-01-01T00:00:00Z so every epoch boundary is UTC midnight.
Every other row exists to prove the schedule machinery behaves correctly
across five orders of magnitude of epoch length — none of them is a live
candidate, and the "error" column is not a valid accuracy comparison between
rows (see the limitation note below).

The epoch length is purely an off-chain parameter. The on-chain guards
constrain only the maximum rate (`MAX_RATE`) and the maximum window
(`MAX_RATE_WINDOW = 90 days`); there is no minimum window on either stack, and
86,400s sits far inside the maximum. What epoch length does change is
`MAX_RATE` *headroom*: the ceiling permits ~0.8677% growth per 24h versus
~29.6% per 30 days. A realistic daily figure (5% APY ≈ 0.0137% of AUM) leaves
roughly 63x margin, but a **monthly-sized dollar target pushed through a daily
window sits at only ~2x** — the regression the `MAX_RATE headroom at a 24h epoch`
tests in `test/hardhat/unit/yieldRate.test.ts` pin.

**Known test-design limitation (unresolved):** the measured "error vs `Y*`"
figure comes out nearly identical (~2.27-2.29%) across all five lengths in this
suite. This is very likely because the mid-epoch shock's position is specified as
a *fraction* of the epoch (`atFraction: 0.4`), so its relationship to the
absolute staging lead still scales with epoch length — meaning this axis has not
demonstrated a genuine, independent accuracy-vs-length relationship either way.
Do not read the flatness as "epoch length doesn't affect accuracy"; read it as
"this specific test isn't isolated enough to say."

**The decisive constraint for epoch length is operational feasibility, not
accuracy**, regardless of the above: a 1-hour epoch leaves a 4-minute
settlement-staging window, an unrealistically tight deadline for a real
transaction to land reliably. That alone rules out sub-day epochs
independent of any accuracy question.

**Supply-path scenarios** (fixed baseline yield/buffer/split, error vs. raw
`Y*` — buffer still applied, ≈-3% is the no-shock baseline):

| Scenario | Error vs raw `Y*` |
|---|---|
| Late shock (+50% at 97% through epoch) | −0.82% |
| Flat | −3.00% |
| Ramp down (−40%) | −3.15% |
| Ramp up (+50%) | 10.38% |
| Round trip (mint then redeem, net supply unchanged) | 10.68% |
| Early shock (+50% at 5% through epoch) | **28.61%** |
| Doubling (+100% mid-epoch, extreme stress) | 37.21% |

**Multi-epoch carry threading** — the end-to-end validation of the headline
"cumulative conservation" claim, against a real deployed contract rather than
hand-fed numbers: 5 consecutive epochs with
varying supply events, carry threaded via `reconcileActualPayout`. Cumulative
distributed tracked cumulative adjusted target to within the small residual
expected from rate-drift and discretization; the outstanding carry balance
stayed bounded across epochs (observed sequence: `0.00 → -0.02 → -4.05 → 4.49
→ -0.02`), rather than growing unboundedly — confirming the carry mechanism
conserves rather than silently accumulating error. A large deliberate negative
carry-in (simulating a prior over-payment) correctly decelerates the next
epoch's base rate without breaking monotonicity.

## Finding: monotonicity means an early shock is worse than an equal-size late one

The naive intuition is backwards. A shock landing AFTER settlement is staged
seems "invisible" to the correction, so it should be the worst case — but the
simulation shows the opposite (28.61% for an early shock vs. −0.82% for the
identical late shock). The reason is monotonicity: settlement can HALT further
over-distribution (`rSettle → PRECISION`) but can **never claw back** what the
base window already distributed. An early, long-duration shock earns at
`rBase` — sized for the smaller PRE-shock supply — for nearly the whole base
window, pushing actual distribution past the target **before settlement ever
runs**; by staging time there is nothing left to correct. A late shock,
despite being genuinely invisible to the correction, simply doesn't have time
to distribute much regardless of rate. Total capital-time exposure dominates
over correctability.

**Operational implication**: monitoring should not wait for the fixed staging
instant. If `distributedSoFarUsd` (computable live from
`scripts/utils/globalValue.ts` samples via
`epochDistribution.ts::distributedUsdOverWindow`) is observed to exceed the
target well before the scheduled staging time, the operator should re-anchor
to `PRECISION` (halt) immediately via `setOkuMYieldRateWithSuccessor`, rather
than waiting. This bounds the early-shock failure mode to **detection
latency**, not epoch length. No automated alert exists: it belongs to the
backend and is out of scope for this repo.

## Steady state (conservativeFactor < 1, if ever used)

At a constant realized yield `T` per epoch and a constant `conservativeFactor
f`, withheld carry converges rather than growing unboundedly:

```
carry₀ = 0
carry₁ = T(1 − f)
carry₂ = T(1 − f)   (published = Tf + carry₁ = Tf + T(1-f) = T; fully caught up)
carry₃ = T(1 − f)
```

From epoch 2 onward the published rate equals the true realized rate; the
`T(1 − f)` buffer is permanent and would absorb a down-surprise in a later
epoch rather than the treasury doing so. See the "steady state" test in
`test/hardhat/unit/yieldRate.test.ts`.

## Buffer sizing against rate drift, not AUM

If a headroom buffer is wanted, it should be sized against **rate volatility**
(the "Two V's" gap), not AUM volatility, since a correctly time-weighted
denominator already removes the AUM term from the measurement conversion.
Illustrative, at the adopted **24-hour** grid, ~5% APY on $10M
(≈$1,370/epoch). The percentage column is epoch-length-invariant — it is just
the adverse move as a fraction of the 500 bp base rate:

| Adverse rate move over the 2-epoch measurement→paying lag | Residual | % of distribution |
|---|---|---|
| 10 bp | ~$27 | ~2% |
| 25 bp | ~$68 | ~5% |
| 50 bp | ~$137 | ~10% |
| 100 bp (stress) | ~$274 | ~20% |

The daily grid shrinks the absolute residual roughly 30x versus a monthly
epoch, *and* makes each row less likely: the measurement→paying lag is two
**days**, so a 100 bp T-bill move inside it is a far more extreme stress than
the same move across two months.

Since correction happens by publishing a slower rate later (never by moving
the multiplier backwards), a buffer is optional — it buys smoother optics, not
solvency. The adopted setting is no buffer (`conservativeFactor = 1.0`).

**Note on this table vs. the simulation results above**: this table isolates
the rate-drift residual alone (no B3, no supply shocks) — it is the error that
remains even with a perfectly time-weighted denominator and no AUM
disturbance. The simulation results above are typically larger because they
additionally stress-test AUM SHOCKS (which B3 exists to shrink, but does not
eliminate — see the monotonicity finding). The two aren't inconsistent; they
isolate different error sources.

## Monotonicity is never violated

Because `okuMMultiplier` can only hold or grow, an epoch that turns out to have
been over-published relative to what was actually realized (`carryInUsd < 0`
going into the next call) is corrected by publishing a **slower** rate next
epoch — `realisedYieldToRatePerSecond` clamps at `PRECISION` (halts, never goes
backward) if a deficit is larger than the next epoch's realized yield, and
carries the still-unpaid remainder forward again. See the
`"carries the UNPAID remainder forward"` test for the exact behavior at that
boundary.

## What this requires operationally

- **The carry balance and the V̄ sample history are both cross-chain-critical
  state**, exactly like the rate integer itself — every chain must apply the
  identical schedule derived from the identical carry/measurement basis.
  Unlike the rate, which is verifiable on-chain via `okuMRatePerSecond()`,
  neither is currently stored or exposed on-chain.
  `scripts/utils/carryLedger.ts` and `scripts/utils/globalValue.ts` /
  `scripts/operator/sampleGlobalValue.ts` are REFERENCE implementations (local
  JSON stores). A durable, shared, ideally signed store is the backend's job and
  out of scope for this repo (§ Reference implementation status).
- `conservativeFactor` (if used) is an off-chain operator decision, not a
  contract parameter — there is no on-chain enforcement that a published rate
  is in fact conservative relative to any particular realized figure.
- `checkMultiplierDrift.ts` reports the cumulative-conservation identity on
  every run once ledger entries exist, and treats an EXPIRED rate window as a
  failure (not just a warning): under a fixed-epoch model the window ends on a
  recurring, scheduled deadline, not as an edge case.
- **Two transactions per epoch per chain**, both non-time-critical within
  their window: the base-window re-anchor at epoch start, and the
  `setOkuMYieldRateWithSuccessor` re-anchor+stage call at the settlement
  staging instant, ahead of the base-window boundary.
- **No automated early-halt monitoring** exists for the "early sustained shock"
  failure mode identified in the simulation results above — an operator alert
  that watches `distributedSoFarUsd` continuously and triggers an emergency
  re-anchor to `PRECISION` before the scheduled staging time. Out of scope for
  this repo (backend).
- Before adopting a non-default `baseWindowFraction` / `conservativeFactor` /
  epoch length, re-run
  `test/hardhat/simulation/epochAccounting.simulation.ts` with those values —
  it's the fastest way to see the actual accuracy/tx-count trade-off rather
  than reasoning about it in the abstract.

## Reference implementation status

Epoch management (deriving, staging and rolling schedules, sampling V̄, the carry
ledger and its reconciliation) is the off-chain backend's job and **out of scope for
this repo and its audit**. This repo's job is to make every lever the backend needs
present and reachable on-chain. The scripts under `scripts/operator/` and
`scripts/config/`, and the local stores `carryLedger.json` and
`globalValueSamples.json`, are an internal-testing proof of concept, not a
production-representative implementation. They are hardened against the internal
review's findings P-01..P-07:

- **P-01** `sampleGlobalValueUsd` throws unless every chain in
  `expectedValueChains()` is read; samples record their chain set and
  `samplesInWindow` rejects samples taken against a different set.
- **P-02** artifacts commit a sorted `targetChains`; `broadcastSchedule.ts` uses it,
  refuses a differing `CHAINS`, and finalizes the carry ledger only when every
  committed target has an identity-bound receipt.
- **P-03** artifacts bind per-target chainId + OkuMoney address (SVM: cluster +
  program id), the reference chain's pre-state, and an expiry (`ARTIFACT_TTL_SECONDS`,
  default 24h); `applyScheduleSingleChain.ts` and the broadcaster's SVM leg refuse on
  mismatch. SVM pre-state is checked only when the SVM read env is set.
- **P-04** roll derivations record the reference `okuMMultiplier()` as the epoch's
  `epochStartMultiplier`; reconciliation uses `current / start - 1` and refuses
  entries without it. V̄ there is still a single spot sample.
- **P-05** `windowSamples` (yield-tooling) requires the window start covered
  (interpolated) and caps sample gaps (`DEFAULT_MAX_SAMPLE_GAP_SEC` = 6h);
  `distributedUsdOverWindow` and `samplesInWindow` both apply it.
- **P-06** a chain already at the artifact's target gets a `recovered` receipt (tx
  found via `NextOkuMYieldRateSet` logs, else `<already-applied>`) instead of a
  resend; artifact, sample and ledger writes are tmp+rename.
- **P-07** `checkMultiplierDrift.ts` resolves the expected fleet first and exits 2
  ("INCOMPLETE COVERAGE") if any expected chain is unreadable.

Things a contributor could not learn from the scripts alone:

- **V̄ is the denominator of the rate derivation**, so a chain silently dropping out of
  the sample set makes every derived rate come out *too high*. Completeness is
  enforced for every expected chain (EVM and SVM). SVM is expected when configured or
  `SVM_EXPECTED=true`; with neither it is excluded from V̄ (with a warning) while
  still a broadcast target. Set `SVM_EXPECTED=true` once SVM carries supply, and do
  not remove it.
- **V̄'s denominator set and the broadcast's recipient set must be the same set**
  (modulo the SVM exclusion above). `scripts/config/epochChains.ts`
  (`participatingChains()`) is the single source of truth; all call sites route
  through it, including explicit `CHAINS=` lists.
- **Env-var names at the `broadcastSchedule.ts` → subprocess boundary are generated**
  by `cli.ts`'s camelCase→SCREAMING_SNAKE transform and appear literally nowhere at
  either end, so a mismatch is only discoverable by execution. `broadcastSchedule`
  takes an injectable `SubprocessRunner` so that boundary is assertable;
  `broadcastSchedule.test.ts` pins the env every chain receives. Keep it if the
  orchestration scripts are touched.
- **SVM `set-yield-rate.ts` can crash after the write has landed.** Its
  post-submission summary evaluates the multiplier at the local clock, which on devnet
  can sit behind the on-chain anchor and throw. `broadcastSchedule.ts` then reports
  `[solana] FAILED` although the schedule is live. With the SVM read env set, a re-run
  detects the target schedule and records a `recovered` receipt instead of re-sending;
  without it, check on-chain state with `admin:read-schedule` before re-sending.
