# OkuMoney — Design Decisions Log

Decisions governing the streaming-accrual model across both stacks: what was
decided, why, what is deliberately still open, and what we are knowingly
living with.

Originated as the working log for porting EVM's streaming rate schedule to SVM
(`TRACKER.md` § "EVM/SVM yield-model divergence", now resolved). It has since
become the single place where the yield design is finalised, so it also carries
the cross-stack and off-chain decisions that used to live only in `TRACKER.md`.

**Status key**

| | |
|---|---|
| `DECIDED` | Settled and implemented |
| `RESOLVED` | Settled by the governing principle below; no further input needed |
| `OPEN` | Needs a human decision before the design is final |
| `ACCEPTED` | A divergence or limitation we are knowingly living with |
| `REJECTED` | Considered and deliberately not done |

---

## Governing principle

> **This protocol is not decentralised and not permissionless.** There is no
> advantage to on-chain logic that could equally live off-chain. Prefer backend
> control of the levers; offload compute off-chain wherever it is possible to
> do so.

This is the rule that settles most of the open questions below, and it is
applied explicitly rather than implicitly — each entry marked `RESOLVED` names
it.

### The decision rule

Blanket "move everything off-chain" is too coarse, because some on-chain logic
is not there for decentralisation reasons. The operative test:

> Keep logic on-chain only if it protects against **(a) key compromise**,
> **(b) violation of a maths invariant the pricing depends on**, or **(c)**
> something that **must be atomic with a user transaction**.
> Everything else belongs to the backend.

In a trusted model the residual on-chain surface should be justified by
*key-compromise resistance*, not by decentralisation. See
[Part 3](#part-3--on-chain-surface-deliberately-retained) for what survives that
test and why.

---

## Index

| # | Decision | Status |
|---|---|---|
| [D-17](#d-17--backend-signed-multiplier-quotes--rejected) | Backend-signed multiplier quotes | `REJECTED` |
| [D-18](#d-18--canonical-multiplier-computed-on-chain-scaleduiamount-as-display-mirror--decided) | Computed multiplier; ScaledUiAmount as display mirror | `DECIDED` |
| [D-19](#d-19--precision-1e9--1e18--decided) | `PRECISION` 1e9 → 1e18 | `DECIDED` |
| [D-20](#d-20--full-256-bit-mul_div-over-the-split-numerator-trick--decided) | Full 256-bit `mul_div` | `DECIDED` |
| [D-21](#d-21--scope-yield-model-only--decided) | Scope: yield model only | `DECIDED` |
| [D-01](#d-01--max_accrual_window-on-chain--resolved-no) | `MAX_ACCRUAL_WINDOW` on-chain | `RESOLVED` (no) |
| [D-22](#d-22--on-chain-epoch-grid-validation--resolved-no) | On-chain epoch-grid validation | `RESOLVED` (no) |
| [D-12](#d-12--integrator-access-to-the-canonical-multiplier--resolved) | Integrator multiplier access | `RESOLVED` |
| [D-23](#d-23--epoch-length-and-anchor--open) | Epoch length + anchor | `OPEN` |
| [D-24](#d-24--conservativefactor--open) | `conservativeFactor` | `OPEN` |
| [D-25](#d-25--early-shock-detection--automation-posture--open) | Early-shock monitor automation | `OPEN` |
| [D-26](#d-26--carry-ledger--v-store-durability--open-mainnet-blocker) | Carry ledger + V̄ durability | `OPEN` |
| [D-27](#d-27--v-sampling-cadence--svm-environment-wiring--open) | V̄ cadence + SVM env wiring | `OPEN` |
| [D-16](#d-16--display-freshness-depends-entirely-on-the-crank--accepted-interval-open) | Display crank dependency + interval | `ACCEPTED` / interval `OPEN` |
| [D-02](#d-02--token-2022-update_multiplier-future-timestamp-semantics--decided) | Token-2022 future-timestamp semantics | `DECIDED` |
| [D-03](#d-03--solana-clock-lag-vs-evm-blocktimestamp--accepted-handled) | Solana clock lag | `ACCEPTED` |
| [D-04](#d-04--rpow-overflow-threshold-differs-in-the-far-tail--accepted) | `rpow` far-tail threshold | `ACCEPTED` |
| [D-05](#d-05--cross-language-differential-harness--decided) | Differential harness | `DECIDED` |
| [D-06](#d-06--mul_div_ceil-has-no-on-chain-caller--accepted) | `mul_div_ceil` unused | `ACCEPTED` |
| [D-07](#d-07--svm-needs-a-fresh-redeploy--deferred) | SVM fresh redeploy | `DEFERRED` |
| [D-08](#d-08--pre-existing-svm-defects--mostly-resolved) | Pre-existing SVM defects | mostly resolved |
| [D-09](#d-09--seconds_per_year-convention--resolved) | `SECONDS_PER_YEAR` convention | `RESOLVED` |
| [D-10](#d-10--display-could-read-above-canonical-after-an-emergency-override--fixed) | Display above canonical on override | `FIXED` |
| [D-11](#d-11--piggyback-sync-swallowed-errors--obsolete) | Piggyback swallowed errors | `OBSOLETE` |
| [D-13](#d-13--test-bankrun-did-not-rebuild-the-program--fixed) | Bankrun stale-binary trap | `FIXED` |
| [D-14](#d-14--tsc---noemit-does-not-pass-on-the-svm-test-suite--open) | SVM `tsc` failures | `OPEN` |
| [D-15](#d-15--compute-budget--fixed) | Compute budget | `FIXED` |

---

# Part 1 — Architecture decided and implemented

## D-17 · Backend-signed multiplier quotes — `REJECTED`

The governing principle, applied naively, suggests removing `rpow` from the
program entirely: the backend signs `(multiplier, timestamp)`, the user passes
it in, and the program verifies the signature. That would cut the hot path from
~80k CU to ~5k and give the backend total control.

**Rejected**, for reasons unrelated to decentralisation:

- **It reintroduces MEV in a worse form.** A quote valid for *N* seconds is a
  free option: hold it, submit when favourable, discard otherwise. The current
  design has no discrete tick to straddle at all. This would give back exactly
  what the streaming refactor was built to remove, and more.
- **It makes every mint and redeem depend on backend liveness.** Today the PSM
  keeps functioning if the backend is down — a meaningful property for a
  stablecoin redemption path, and one that matters precisely on the day
  everything else is going wrong.
- **Larger audit surface, not smaller.** Replay protection, quote expiry and
  nonce handling are more subtle than the arithmetic they replace.

The motivation the principle is reaching for — compute cost — does not apply
here: 80,883 CU against a 200,000 limit costs essentially nothing (D-15).

**The general point:** the multiplier is on-chain because of rule **(c)** — the
PSM must price atomically inside the user's own transaction, and a Solana
instruction cannot call out to a backend mid-execution. It is not on-chain for
decentralisation reasons, and it is not a candidate for offloading.

---

## D-18 · Canonical multiplier computed on-chain; ScaledUiAmount as display mirror — `DECIDED`

The multiplier is never stored. It is a pure function of the six-field rate
schedule on `PsmConfig` plus `Clock::unix_timestamp`, computed on read.

The Token-2022 `ScaledUiAmount` extension is a **write-only display mirror**:
the program pushes to it for wallets and never reads it back. Nothing prices
against it.

Forced by two Token-2022 constraints:

- `ScaledUiAmountConfig::current_multiplier()` is a step function with exactly
  one pre-armable future step. It cannot stream.
- `InterestBearingConfig`, which *can* accrue continuously, is **mutually
  exclusive** with it on-chain
  (`spl-token-2022-interface-2.1.0/src/extension/mod.rs:1359-1361`) and would
  cost the bounded rate window, the pre-staged successor, and the ability to
  re-anchor — three correctness properties traded for one cosmetic one.

Display therefore lags canonical by up to one sync interval, always **low**,
never high, so a redeem always pays at least what the wallet showed.

---

## D-19 · `PRECISION` 1e9 → 1e18 — `DECIDED`

Forced, not chosen. One ulp of a per-second rate at 1e9 is **3.20385% APY** — the
smallest expressible non-zero yield exceeds 3%, so the rate schedule is
literally inexpressible at that scale.

1e18 additionally makes `PRECISION`, `MAX_RATE`, `MAX_MULTIPLIER` and the `rpow`
rounding byte-identical to EVM, which is what lets one broadcast schedule
produce the same multiplier everywhere with no messaging.

Cost: every multiplier-bearing value widened `u64` → `u128`, and multiplier math
needs a 256-bit intermediate (D-20).

---

## D-20 · Full 256-bit `mul_div` over the split-numerator trick — `DECIDED`

The split-numerator identity (`a = q·WAD + r ⇒ a·b/WAD = q·b + r·b/WAD`) is exact
and cheap, but caps out around 777 days at `MAX_RATE` and requires a reachability
argument maintained in perpetuity.

Chose `full_mul` + small-divisor long division instead — the same decomposition
OpenZeppelin's `Math.mulDiv` implements. Because `PRECISION = 1e18 < 2^60` the
divisor fits a `u64`, so this is small-divisor division, **not** general bignum
division (no Knuth-D, no reciprocal estimation, no correction loop). Exact over
the entire `u128 × u128` domain with no domain caveat.

A narrow fast path was added later for compute reasons (D-15); it is provably
identical, not an approximation.

---

## D-21 · Scope: yield model only — `DECIDED`

SVM remains single-token. No `OkuDollar`, no `RedemptionQueue`. Deliberate, per
the earlier Track C decision; this refactor did not revisit it.

---

## D-02 · Token-2022 `update_multiplier` future-timestamp semantics — `DECIDED`

**Verified empirically** against the real `spl_token_2022.so` dump in
`tests/bankrun/display-mirror.ts`. After the two-CPI sync the extension holds:

```
multiplier    = 1.0                 <- first CPI, effective immediately
newMultiplier = 1.0000057924871757  <- second CPI, pre-armed
effectiveTs   = t0 + 60
```

The processor **does** resolve the standing `multiplier` field to
`current_multiplier(now)` before overwriting `new_multiplier`, and preserves the
immediate write.

`sync_display_multiplier` keeps the two-CPI form regardless: correct under
either semantics, costs one extra CPI per minute, and does not depend on an
undocumented processor detail that a future Token-2022 release could change.

**Optimisation available, not taken:** the first CPI could now be dropped. Not
worth coupling to the detail.

---

## D-05 · Cross-language differential harness — `DECIDED`

`compute_multiplier` exists three times — Solidity, Rust, TypeScript — and
**nothing on-chain on either stack can detect a divergence between them**. Each
deployment is independent, with no messaging, no light client, no state proof.
Before this harness they were kept in agreement by code review, which is not a
control.

`EVM/test/differential/GenerateVectors.t.sol` drives the existing
`MathLibHarness` over a structured grid — every `computeMultiplier` branch, both
window boundaries sampled at ±1, `MAX_RATE`, the `MAX_MULTIPLIER` clamp,
`elapsed == 0`, halted, `anchor > rateEnd`, zero base — plus 400 seeded fuzz
cases and four deliberate revert cases. Output: `vectors.jsonl` (committed).

Replayed by:
- `SVM/oku-programs/crates/oku-shared/tests/differential.rs`
- `packages/yield-tooling/test/differential.test.ts`

**3,290 vectors, 4 of them reverts, all three implementations agreeing exactly.**
Reverts are checked as strictly as values — "one implementation accepts what
another rejects" is as much a divergence as a wrong number, and exactly that
class of bug was found by hand in the instruction layer during this work.

**Validated by mutation:** flipping `rpow`'s accumulator from half-up to floor in
the TypeScript — a realistic one-ulp slip — fails 1,218 of 3,290 vectors. The
harness detects the class of bug it exists for rather than being green by
construction.

CI gates it, including a stale-corpus check, so changing `MathLib.sol` without
regenerating fails the build. Run locally: `npm run test:differential`.

**Not covered:** the far-tail overflow region (D-04) is excluded by design; only
`compute_multiplier` is compared, not the conversion helpers.

---

# Part 2 — Resolved by the governing principle

## D-01 · `MAX_ACCRUAL_WINDOW` on-chain — `RESOLVED` (no)

Neither stack caps how far `rateEnd` may be set into the future.

**Decision: do not add an on-chain cap.** It is business policy, not a maths
invariant, and fails all three limbs of the decision rule. Enforce it in
`scripts/admin/set-yield-rate.ts`, which already validates windows, and in the
shared epoch tooling.

**Residual risk, characterised rather than assumed.** Without the cap, a
fat-fingered far-future `rateEnd` could in principle push `rpow` past `u128` and
make the multiplier un-computable, erroring every mint and redeem until the
operator republishes. Measured:

| rate | window | result |
|---|---|---|
| 20 % APY | 30 years | computes fine |
| 100 % APY | 30 years | computes fine |
| `MAX_RATE` (2242 % APY) | 1 year | computes fine |
| `MAX_RATE` | 3 years | computes fine |
| `MAX_RATE` | 30 years | **errors** |

The failure requires **two simultaneous extreme fat-fingers** — a near-`MAX_RATE`
rate *and* a multi-decade window. It mis-prices nothing (it errors, it does not
return a wrong number) and is recoverable by republishing. EVM's own `rpow`
reverts around the same 30-year mark at `MAX_RATE`, so the divergent band is
narrow.

**Consequence, and the reason this matters:** together with D-22 this means
**no EVM upgrade is required at all.** `OkuMoney` is live on six networks;
avoiding a UUPS upgrade cycle with `checkLayout`/`preState` rehearsal on each is
the single largest simplification available in this design.

---

## D-22 · On-chain epoch-grid validation — `RESOLVED` (no)

Considered storing `epochLength` / `epochAnchor` on-chain and validating that
`endTimestamp` lands on the grid, to stop a fat-fingered timestamp silently
desynchronising one chain.

**Decision: no.** Pure business policy. It would also hard-code a parameter that
is still open (D-23) into six live contracts, making a config choice into an
upgrade.

Detection stays off-chain: `checkMultiplierDrift.ts` already supports an optional
grid-alignment check (`EPOCH_ANCHOR_UNIX` / `EPOCH_LENGTH_SECONDS` /
`EPOCH_GRID_TOLERANCE_SECONDS`), skipped entirely until those are set. Enable it
once D-23 lands.

Supersedes the "Consider whether the epoch grid should be validated ON-CHAIN"
follow-up in `TRACKER.md` § Epoch-grid convention.

---

## D-12 · Integrator access to the canonical multiplier — `RESOLVED`

Solana has no view functions, so an integrator wanting the canonical multiplier
must recompute it from `PsmConfig` or read the lagging display mirror.

**Decision: document `@okumoney/yield-tooling` as the supported path. Do not add
a `get_okum_multiplier` instruction.** New on-chain surface on an audited program,
for a read that already exists off-chain and is differential-tested against the
Solidity, fails the decision rule.

`SVM/README.md` should state plainly that reading the ScaledUiAmount extension
yields a value up to one sync interval stale, that this is bounded and always
**low**, and that most integrators reading it will be fine — they should simply
know why.

**Revisit only if** a real integrator needs a language-agnostic path; the
`set_return_data` + simulation approach remains available.

---

## D-09 · `SECONDS_PER_YEAR` convention — `RESOLVED`

EVM's deriver uses exactly 365 days (`EVM/scripts/utils/yieldRate.ts:30`).
Token-2022's `InterestBearingConfig` uses 365.24, previously flagged as a parity
friction point.

**Moot.** That extension is not used — the display mirror stores a *multiplier*,
not a rate, so Token-2022 never performs rate math on our behalf. The 365-day
convention applies uniformly because both stacks consume the same derived
per-second integer.

Remaining action: delete the stale 365.24 note from `TRACKER.md`.

---

# Part 3 — On-chain surface deliberately retained

Stated explicitly so these are decisions rather than omissions. Each is
justified against the decision rule; none is there for decentralisation.

| Control | Rule | Why it survives |
|---|---|---|
| Rate rails (`rate >= PRECISION`, `<= MAX_RATE`) | (b) | Monotonicity is the invariant the entire multiplier model rests on. A backend bug writing a sub-unity rate would corrupt accounting, not merely misbehave. Cost ≈ 0 |
| Bounded-window requirement on yielding rates | (b) | An open-ended rate ends at a transaction-dependent, per-chain moment — reintroducing exactly the cross-chain divergence the design eliminates |
| Pause gate on rate *increases*, vs the **effective** rate | (b) | Prevents inflating the multiplier while users cannot exit. Subtle and load-bearing — a divergence was found here during the audit |
| `max_supply` / `minter_allowance` caps | (a) | Bound the blast radius of a compromised minter key |
| 12-role separation on `PsmConfig` | (a) | Cold / warm / orchestrator separation is key-compromise defence |
| `set_okum_multiplier` emergency override | (c) | The backend needs an atomic re-anchor lever |
| Sandwich lock on the override | (c) | The override is the one remaining discrete jump |
| Computed multiplier (`rpow` on the hot path) | (c) | Must price atomically inside the user's transaction — see D-17 |

**The distinction to apply generally:** maths invariants and key-compromise
bounds stay on-chain; business policy moves to the backend.

---

# Part 4 — Open: needs a decision

## D-23 · Epoch length and anchor — `OPEN`

Full analysis in `TRACKER.md` § "Epoch-grid convention".

**Now low-stakes.** With D-22 resolved (no on-chain grid validation), this is a
backend constant — changing it later is a config edit, not an upgrade.

**Recommendation: 30 days**, anchored at a round UTC timestamp (e.g.
`2026-01-01T00:00:00Z`) so grid arithmetic stays human-checkable.

The decisive argument is operational: a 2-day settlement window at
`DEFAULT_SETTLEMENT_FRACTION = 1/15` is comfortably wide for a reliable
transaction; a 1-hour epoch leaves 4 minutes, which is not.

**Do not cite the simulation's epoch-length axis as evidence.** Its measured
error was flat (2.27–2.29%) across all five lengths, almost certainly because
the shock's position is specified as a fraction of the epoch and therefore
scales with it. It is a mechanism smoke test, not an accuracy comparison. Since
the decision is now cheap to revise, the previously-suggested simulation rework
(repositioning the shock to an absolute time) is **not** worth doing first.

## D-24 · `conservativeFactor` — `OPEN`

Purely off-chain; the governing principle is silent.

| Option | Effect |
|---|---|
| `1.0` (current default) | Pure rear-facing. No permanent float. Overshoot corrected by a slower next epoch |
| `0.97` | Publishes 97 % of realised yield. Simulation confirms it costs exactly −3.00 %, no more. Implies a permanent carry buffer of `realizedYieldPerEpoch × 0.03` |

**Recommendation: `0.97` until D-25's monitor is live, then revisit.**

The reason is specific rather than general caution: a lower published rate
reduces the chance of tripping the **irreversible** early-shock overshoot
(D-25), so that 3 % margin is buying protection against the one failure mode
that cannot be undone. Once the monitor is actively catching overshoot, the
passive buffer is redundant and `1.0` — no permanent float — becomes preferable.

## D-25 · Early-shock detection — automation posture — `OPEN`

The highest-severity unmitigated item in the design. Full analysis in
`TRACKER.md` § "Early-shock detection".

Because the multiplier is monotonic, an early long-duration supply shock can
push actual distribution past the epoch target **before** the scheduled
settlement-staging instant — after which settlement can only halt, never claw
back. Simulation's worst case: **+28.61 %** error for a shock 5 % into the epoch,
versus −0.82 % for the identical shock at 97 %.

Detection and response are **entirely manual today.**

The governing principle argues *for* automation: the backend is trusted and
should hold this lever.

**Recommendation: build the monitor, implement auto-halt, default it off.**
Enable once it has run several epochs without false positives. An automated
`setOkuMYieldRateWithSuccessor(PRECISION, …)` across six chains is powerful
enough to want evidence before arming, but "a human will notice in time" is not
a control for something that becomes irreversible the moment it is missed.

## D-26 · Carry ledger + V̄ store durability — `OPEN` (mainnet blocker)

Both are **cross-chain-critical state with no on-chain representation**,
currently local JSON files explicitly marked reference-only in their own module
docs. The published rate is independently verifiable via `okuMRatePerSecond()`;
the carry balance and the time-weighted average backing it are verifiable by
nobody except whoever holds the files.

**The governing principle raises the stakes here rather than lowering them.** If
the backend owns the levers, these files *are* the protocol's system of record.

**Recommendation: treat as a mainnet prerequisite.** Minimum bar: durable,
versioned, append-only, ideally signed. A lost or forked carry ledger means the
cumulative-conservation identity cannot be reconstructed.

## D-27 · V̄ sampling cadence + SVM environment wiring — `OPEN`

**Recommendation: hourly.** Confirm against real AUM volatility that
`samplesInWindow`'s ">= 2 samples" floor is never the binding constraint on
measurement accuracy.

**Operational hazard worth calling out separately:** `globalValue.ts` now reads
SVM, and requires `SVM_RPC_URL`, `SVM_LITE_PSM_PROGRAM_ID` and `SVM_OKU_M_MINT`.
**If they are unset, SVM is excluded from V(t) and every derived rate comes out
too high** — V is the denominator. It warns, but a warning in a cron log is easy
to miss. Consider making the sampler fail hard rather than warn once SVM is
live.

## D-14 · `tsc --noEmit` does not pass on the SVM test suite — `OPEN`

21 errors, unchanged in count and kind from before this work (verified against a
clean stash): ~12 Anchor generic-variance (`Program<LitePsm>` vs `Program<Idl>`)
plus 9 miscellaneous (`accountsPartial` extra keys Anchor accepts at runtime,
`AccountNamespace<Idl>` lacking `psmConfig`).

Tests pass only because `tsx` transpiles without typechecking.

**`EVM/` and `packages/yield-tooling/` both typecheck clean**, including all the
new SVM-reading code. The gap is confined to `SVM/oku-programs/tests/`.

**Recommendation: fix — and the governing principle raises its priority.** A
backend-controlled architecture makes the off-chain code *more* load-bearing,
not less, and TypeScript is currently providing no safety net across the SVM
suite.

## D-16 · Display freshness depends entirely on the crank — `ACCEPTED`, interval `OPEN`

Follows from D-15's removal of the piggyback sync. An idle PSM with nobody
running `scripts/admin/sync-display.ts` shows a stale wallet balance.

Bounded and safe: the mirror reads **low**, never high, so a redeem always pays
at least what was displayed, and nothing prices against it. But display
freshness is now an operational responsibility rather than a self-maintaining
property, and `SVM/README.md` says so.

**Open:** `DISPLAY_SYNC_INTERVAL` is 60 s, chosen when the piggyback existed as a
backstop. It is now the only mechanism. 30 s costs ~0.014 SOL/day if tighter
display is wanted.

**Recommendation: keep 60 s, keep it permissionless** (the written value is fully
determined by chain state, so there is nothing to gate), and run it from
whatever already monitors the deployment — it needs no key material. If staleness
proves annoying, shorten the interval rather than restoring the piggyback.

---

# Part 5 — Accepted divergences and verification debt

## D-03 · Solana clock lag vs EVM `block.timestamp` — `ACCEPTED` (handled)

`Clock::unix_timestamp` is validator-vote-derived and can trail wall clock.
Because the multiplier is a pure function of it, this is a **self-correcting
lag, not a permanent drift** — SVM catches up when the clock does.

Handled in tooling: `checkMultiplierDrift.ts` records the timestamp each chain's
multiplier was evaluated at (`evaluatedAtSec`) and reports the read skew
alongside any spread. The **schedule-field equality check is the real catch-all**
— it is timestamp-independent and therefore exact; the multiplier spread is
secondary and annotated so a clock lag is not mistaken for a divergence.

`readSvmSchedule` uses `getBlockTime(getSlot())` for cluster time and warns
loudly on fallback to wall clock, since that reintroduces the exact confusion
the field exists to avoid.

## D-04 · `rpow` overflow threshold differs in the far tail — `ACCEPTED`

EVM reverts when an intermediate **product** exceeds `uint256` (`x < 2^128`).
The Rust port returns `None` when an intermediate **quotient** exceeds `u128`
(`x ≈ 1.84e28`). The SVM bound binds first.

Both sit far outside the reachable domain — `MAX_MULTIPLIER` clamps output at
1e6×, while the SVM bound engages only above ~1.8e10× *within a single squaring
step*. See D-01's table for where the boundary actually is in rate/window terms.

The differential corpus deliberately does **not** generate vectors here — doing
so would produce known-failing cases and devalue the whole corpus. The exclusion
is documented in the generator header so it is explicit rather than an accident
of the chosen ranges.

**Open verification debt:** with D-01 resolved as "no on-chain cap", this no
longer closes for free. It needs a dedicated boundary-search test asserting the
two thresholds bracket the reachable domain. Small and contained.

## D-06 · `mul_div_ceil` has no on-chain caller — `ACCEPTED`

Pre-existing. Fuzzed, Kani-proven, unit-tested, unused. Retained for a future
reserve-accounting path per the rounding policy in
`crates/oku-shared/src/math.rs`. Unchanged by the WAD migration — still the
generic `u64` helper, since it was never a multiplier path.

**Keep.** It is a `pub fn` in a library crate with no caller, so it carries no
meaningful on-chain cost, and deleting then re-adding it later is worse than
leaving a documented, proven primitive in place.

## D-07 · SVM needs a fresh redeploy — `DEFERRED`

`PsmConfig` grew 562 → 626 bytes, so existing accounts cannot be reallocated in
place. SVM is devnet-only (`deployments/` holds only `devnet.json` /
`devnet-fork.json`), so this is a fresh deploy rather than a migration, and no
mainnet holders exist — the mint can be recreated freely.

Already tracked in `TRACKER.md`.

**Now unblocked earlier than expected:** with D-01 and D-22 both resolved as "no",
there is no EVM upgrade to sequence behind.

## D-08 · Pre-existing SVM defects — mostly resolved

Recorded during the audit as out of scope. Five of seven self-resolved:

| Defect | Status |
|---|---|
| `distribute-yield.ts` read `cfg.multiplier`, a removed field → `TypeError` | **Resolved** — script deleted with the instruction |
| README documented `set_multiplier(f64)`; ABI was `u64` | **Resolved** — instruction removed, docs rewritten |
| README claimed `read_multiplier` treats `0.0` as `1.0` | **Resolved** — helper deleted |
| `test-devnet.ts` used dollar supply where on-chain used raw | **Resolved** — step rewritten for streaming |
| CI referenced non-existent `trident-tests` | **Resolved** — step removed |
| Dead `InterestBearingConfig` mint helper, never invoked (`scripts/utils/tokenHelpers.ts`) | **Outstanding** |
| Anchor version mismatch: `Anchor.toml` 1.0.2 vs `Makefile`/CI 1.0.0 | **Outstanding** |

**Recommendation: fix both remaining.** Trivial, and the version mismatch is a
genuine reproducibility risk on a program that is about to be redeployed.

---

# Part 6 — Implemented fixes (record)

## D-10 · Display could read above canonical after an emergency override — `FIXED`

The override halts the schedule, but a previous sync may have pre-armed a step
`m(t+T)` computed under the *old, still-running* schedule. That armed value can
exceed the new canonical multiplier, because the override's strict-increase
check compares against the **current** canonical value, not an already-armed
future one. For up to one sync interval the display would read *above* canonical
— the one direction the mirror must never take.

**Fixed:** `set_okum_multiplier` now writes the display mirror synchronously
(immediate effective timestamp, no pre-arm), overwriting the stale armed step and
collapsing the window to zero. Unlike the old piggyback this write is **not**
best-effort — if the display cannot be corrected, the override fails.

Regression test: `tests/bankrun/display-mirror.ts:210`.

## D-11 · Piggyback sync swallowed errors — `OBSOLETE`

Superseded by D-15. The opportunistic display sync on `mint_oku_m` /
`redeem_oku_m` was deliberately infallible, so a persistently failing CPI would
have been invisible from the PSM path. The piggyback was removed entirely; the
user-facing instructions no longer touch the display mirror, so no
swallowed-error path remains on them.

## D-13 · test-bankrun did not rebuild the program — `FIXED`

Bankrun loads `target/deploy/lite_psm.so`, but `test:bankrun` was just `mocha`.
Editing Rust and re-running without an intervening `anchor build` silently tested
the **previous** binary.

Not hypothetical: it masked the D-10 fix appearing not to work. The test was
correct and the code was correct; only the artifact was stale, and the resulting
"the fix doesn't work" conclusion was wrong.

**Fixed** by prefixing `anchor build &&`. CI already built first, so this was a
local-dev trap only.

**Still worth doing:** have `startBankrun` assert the `.so` mtime is newer than
the newest file under `programs/`, so the trap cannot reappear for anyone
invoking mocha directly.

## D-15 · Compute budget — `FIXED`

The refactor shipped on an **estimate** of 15–40k CU. Measured:

| path | before | after |
|---|---|---|
| `mint_oku_m`, 7-day window | 151,225 | 53,473 |
| `mint_oku_m`, 90-day window | 172,324 | 62,335 |
| `mint_oku_m`, two-`rpow` overhang | **>200k — hard failure** | 80,883 |
| `redeem_oku_m`, two-`rpow` overhang | **>200k — hard failure** | 74,359 |
| `sync_display_multiplier` | 179,875 | 103,753 |

The overhang branch is not an edge case — it is the state of every chain between
an epoch handover and the next schedule write. **As committed, mints and redeems
would have begun failing outright once a window closed.** That the estimate went
unchecked for a full pass is the process lesson: a user-facing hot path acquired
a ~20-iteration `rpow` and nobody measured it.

Causes and fixes, both in `crates/oku-shared/src/wad.rs`:

1. `widening_mul` held its limbs as `u128`, so LLVM emitted four `__multi3`
   libcalls per call instead of native 64×64→128 widening multiplies. Fixed by
   typing the limbs `u64`.
2. `div_wad` always ran the full four-limb long division — eight software
   division libcalls — despite the product fitting `u128` for essentially every
   real operation. Added a fast path: when `a * b` fits `u128`, one multiply and
   one division. Provably identical; re-fuzzed 23.5 M executions against the
   independent oracle and re-verified against the 3,290-vector corpus.
3. Removed the opportunistic piggyback display sync (~31k CU for a cosmetic
   refresh). See D-16 for the operational consequence.

Pinned by `tests/bankrun/compute-budget.ts` at 100k on user paths and 150k on the
crank, so a regression fails CI.

**Further optimisation available, deliberately not taken.** The dominant cost is
now one `u128` division per `mul_div` (`__udivti3` is a software routine; SBF has
no 128-bit divide). Either Granlund–Montgomery division-by-constant, or 128÷64
via three native `u64` divisions, would cut it further. Both would be new,
subtle, security-critical code on the hottest path in the protocol, for headroom
nothing currently needs at 80k against 200k.

---

## Open items at a glance

| # | Needs | Blocking? |
|---|---|---|
| D-23 | Pick epoch length + anchor (rec. 30 d, round UTC) | Design finalisation |
| D-24 | Pick `conservativeFactor` (rec. 0.97 for now) | Design finalisation |
| D-25 | Build early-shock monitor; choose automation posture | **Highest severity** |
| D-26 | Durable carry + V̄ stores | **Mainnet blocker** |
| D-27 | V̄ cadence; SVM env wiring must not be silently absent | Rate correctness |
| D-14 | Fix SVM test-suite `tsc` | Backend safety net |
| D-16 | Confirm 60 s crank interval; assign an owner | Operational |
| D-04 | Boundary-search test | Verification debt |
| D-08 | Dead `tokenHelpers` helper; Anchor version mismatch | Hygiene |
| D-07 | Sequence the SVM fresh redeploy | Now unblocked |
| D-13 | Optional `.so` mtime guard in `startBankrun` | Hygiene |
