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
| [D-23](#d-23--epoch-length-and-anchor--decided) | Epoch length + anchor | `DECIDED` |
| [D-24](#d-24--conservativefactor--decided) | `conservativeFactor` | `DECIDED` |
| [D-25](#d-25--early-shock-detection--accepted-exposure) | Early-shock exposure | `ACCEPTED` |
| [D-26](#d-26--carry-ledger--v-store-durability--open-mainnet-blocker) | Carry ledger + V̄ durability | `OPEN` |
| [D-27](#d-27--v-sampling-cadence--svm-environment-wiring--decided) | V̄ cadence + SVM env wiring | `DECIDED` |
| [D-16](#d-16--display-freshness-depends-on-the-crank--accepted-interval-resolved) | Display crank dependency; pre-arm removed | `ACCEPTED` / interval `RESOLVED` |
| [D-02](#d-02--token-2022-update_multiplier-future-timestamp-semantics--decided) | Token-2022 future-timestamp semantics | `DECIDED` |
| [D-03](#d-03--solana-clock-lag-vs-evm-blocktimestamp--accepted-handled) | Solana clock lag | `ACCEPTED` |
| [D-04](#d-04--rpow-overflow-threshold-differs-in-the-far-tail--accepted-now-proven) | `rpow` far-tail threshold | `ACCEPTED` (proven) |
| [D-05](#d-05--cross-language-differential-harness--decided) | Differential harness | `DECIDED` |
| [D-06](#d-06--mul_div_ceil-has-no-on-chain-caller--accepted) | `mul_div_ceil` unused | `ACCEPTED` |
| [D-07](#d-07--svm-needs-a-fresh-redeploy--deferred) | SVM fresh redeploy | `DEFERRED` |
| [D-08](#d-08--pre-existing-svm-defects--mostly-resolved) | Pre-existing SVM defects | all resolved |
| [D-09](#d-09--seconds_per_year-convention--resolved) | `SECONDS_PER_YEAR` convention | `RESOLVED` |
| [D-10](#d-10--display-could-read-above-canonical-after-an-emergency-override--fixed) | Display above canonical on override | `FIXED` |
| [D-11](#d-11--piggyback-sync-swallowed-errors--obsolete) | Piggyback swallowed errors | `OBSOLETE` |
| [D-13](#d-13--test-bankrun-did-not-rebuild-the-program--fixed) | Bankrun stale-binary trap | `FIXED` |
| [D-14](#d-14--tsc---noemit-on-the-svm-test-suite--fixed) | SVM `tsc` failures | `FIXED` |
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

## D-23 · Epoch length and anchor — `DECIDED`

**30 days, anchored 2026-01-01T00:00:00Z**, with one settlement window
(2 days) of grid tolerance. Committed in `EVM/scripts/config/epoch.ts`;
`checkMultiplierDrift.ts` now defaults to it, so the alignment check runs
instead of being silently skipped.

Chosen on operational grounds, not measured accuracy. At
`DEFAULT_SETTLEMENT_FRACTION = 1/15`, 30 days gives a ~2-day window in which to
land the settlement transaction on every chain. A 1-hour epoch gives 4 minutes,
which is a race rather than a window.

**The simulation's epoch-length axis is not evidence.** Its error was flat
(2.27-2.29 %) from 1 hour to 90 days, almost certainly because the shock's
position is specified as a fraction of the epoch and therefore scales with it.
It is a mechanism smoke test.

**Low-stakes by construction.** With on-chain grid validation declined (D-22),
these are backend constants — revising them is an edit to one file, not an
upgrade. That is precisely why it was not worth reworking the simulation first.

**Recorded trade-off:** shorter epochs would bound the early-shock overshoot
(D-25), because a shock has less time to compound before the next re-anchor.
30 days maximises operational comfort and therefore maximises that exposure.

---

## D-24 · `conservativeFactor` — `DECIDED`

**`1.0`** — pure rear-facing, no permanent float. Already the shipped default
(`yieldRate.ts:196`, `runEpoch.ts:94`), so no change was needed.

Never an on-chain parameter: it is a scalar applied to the target before the
rate is derived off-chain. Variance is absorbed by the carry ledger, which
carries any shortfall into the next epoch, and by PSM liquidity.

**An earlier recommendation of 0.97 was withdrawn.** It was justified as
protection against the early-shock overshoot (D-25), which does not hold up: a
3 % margin against a ~28 % overshoot is not meaningful mitigation.
`conservativeFactor` smooths ordinary epoch-to-epoch variance; it does not bound
a shock. Keeping it at 1.0 avoids holding permanent float for a benefit that
was overstated.

---

## D-25 · Early-shock detection — `ACCEPTED` exposure

Because the multiplier is monotonic, an early long-duration supply shock can
push actual distribution past the epoch target **before** the scheduled
settlement-staging instant — after which settlement can only halt, never claw
back.

**Decision: accept the exposure.** Supply shocks are part of the deal; the
mitigation is conservative off-chain and on-chain liquidity plus conservative
rate-setting, not additional guards.

**What is being accepted, stated numerically** — $100M AUM, 5 % APY, 30-day
epoch:

```
epoch yield target              $410,959
worst TESTED overshoot 28.61%   $117,575 over-distributed, permanently
```

Two caveats that matter for reserve sizing:

- **28.61 % is the worst case tested, not a proven bound.** Overshoot scales
  with shock magnitude, so a larger shock is worse.
- **It is irreversible.** Once distributed, the multiplier cannot be walked
  back; the only response is to halt going forward.

Worth noting the mitigation lever is weaker than it sounds:
`conservativeFactor` moves the rate by single-digit percent, while a shock
moves `V(t)` by tens of percent (see D-24). **Shorter epochs are the stronger
lever**, which is the trade recorded in D-23.

Nothing about this required a contract change either way — the monitor would
have read `globalValue.ts` samples and used the existing
`setOkuMYieldRateWithSuccessor`. It remains available if the exposure proves
uncomfortable in practice.

---

## D-26 · Carry ledger + V̄ store durability — `OPEN` (mainnet blocker)

Both are **cross-chain-critical state with no on-chain representation**,
currently local JSON files marked reference-only in their own module docs. The
published rate is independently verifiable via `okuMRatePerSecond()`; the carry
balance and the time-weighted average backing it are verifiable by nobody except
whoever holds the files.

**The governing principle raises the stakes here rather than lowering them.**
If the backend owns the levers, these files *are* the protocol's system of
record.

### Can this be tracked on-chain via events?

Asked, and worth answering precisely because the two stacks differ:

| | EVM | SVM |
|---|---|---|
| Retention | Archive nodes; standard indexing | RPC prunes tx history (~days on public RPC); needs an archive/indexer |
| Provable to a third party | **Yes** — logs are committed in the receipts trie, so a Merkle proof exists | **No** — Solana has no receipts trie. You can show a log; you cannot prove one |

The decisive point is that **the carry ledger and V̄ are global, not per-chain**.
One record covers all six EVM chains plus SVM, so cross-platform emission is not
needed at all — anchor once, wherever the property is strongest. That is EVM.

### Recommendation

**Signed off-chain ledger as canonical, plus a per-epoch hash anchored on one
EVM chain.**

- Full record (`epochId`, `realisedYieldUsd`, `measuredAvgValueUsd`, `carryIn`,
  `carryOut`, published rate, per-chain breakdown) stays off-chain, signed,
  append-only. That is the working store.
- Only `keccak(record)` goes on-chain — 12 transactions/year.
- Gives tamper-evidence and third-party verifiability **without** publishing the
  book.
- Needs a standalone ~30-line `EpochAttestation` contract — one function, one
  event, deployed once, never upgraded. **No change to `OkuMoney`.**

**This is an acknowledged exception to the decision rule.** It is not
key-compromise defence, not a maths invariant, not atomicity. The justification
is different: the chain is being used as a **notarisation service**, not to run
logic. Nothing can reject anything; there is no control flow. That is a use
chains are genuinely good at and which no off-chain system replicates without a
trusted third party.

**If third-party verifiability is not a property you want** — if the consumers
are internal plus auditors who accept your signature — then the signed
off-chain ledger alone is sufficient and the contract should be skipped. That is
the real question to settle.

Either way, the minimum bar is: durable, versioned, append-only, signed. A lost
or forked carry ledger means the cumulative-conservation identity cannot be
reconstructed.

---

## D-27 · V̄ sampling cadence + SVM environment wiring — `DECIDED`

**Cadence: hourly.** ~720 samples per 30-day epoch, comfortably past
`samplesInWindow`'s ">= 2 samples" floor.

**The wiring hazard is now a hard error.** `globalValue.ts` reads SVM, and V is
the DENOMINATOR of every derived rate:

```text
   rate  ~=  realisedYield / (V̄ x window)
```

A chain omitted from V does not make the sample incomplete — it makes the rate
too **high**. If SVM held 20 % of supply and were silently excluded, V̄ would come
out 20 % low and the rate 25 % high, every epoch, with nothing failing.

`SVM_EXPECTED=true` now makes a missing or unreadable SVM configuration throw
rather than warn. The flag exists because "SVM is absent" is a legitimate
pre-launch state that must stay distinguishable from "SVM is misconfigured" —
set it the moment SVM carries supply. A warning in a cron log is not a control.

---

## D-14 · `tsc --noEmit` on the SVM test suite — `FIXED`

Was 21 errors, unchanged since before the streaming work. Now **zero**, and
`npm run typecheck` is gated in CI across all three packages.

Root cause was a single one: shared helpers in `tests/shared/setup.ts` were
typed `Program<Idl>` while every caller passed `Program<LitePsm>`, which is not
assignable due to variance in `addEventListener`. There is exactly one program
in the workspace, so typing the helpers concretely fixed ~12 errors and let
**19 `as any` casts** — which existed only to paper over that — be deleted.

The remainder were dead account keys (`vaultOkuM`, plus `okuMMint` /
`token2022Program` on `withdraw_buffer`) that Anchor silently ignores at
runtime. Removed rather than suppressed: the instructions genuinely do not take
them, and `vaultOkuM` is a leftover from a design where redeemed OkuM went to a
vault instead of being burned.

The governing principle is what raised this from hygiene to priority: a
backend-controlled architecture makes the off-chain code *more* load-bearing,
so it should not be the only part of the system without a type checker.

---

## D-16 · Display freshness depends on the crank — `ACCEPTED`, interval `RESOLVED`

An idle PSM with nobody running `scripts/admin/sync-display.ts` shows a stale
wallet balance. Bounded and safe: the mirror reads **low**, never high, so a
redeem always pays at least what was displayed, and nothing prices against it.

**Interval resolved: there is no on-chain interval any more.** Reviewing this
question surfaced that the pre-armed second step was violating the mirror's one
invariant, so it was removed (see below). `DISPLAY_SYNC_INTERVAL` went with it.
The cadence is now purely an operator choice — nothing on-chain enforces or
assumes one. 60 s remains the recommendation (~$0.35 under-read per $1M at
20 % APY, ~0.007 SOL/day). The crank stays permissionless; the mechanism that
runs it is out of scope for now.

### The pre-arm was removed, and why that matters

The mirror used to write two points per sync: `m(now)`, and `m(now + 60s)`
pre-armed at its own effective timestamp, so the display kept advancing for one
interval if the crank stopped.

A step armed under one schedule fires under whatever schedule is live when its
timestamp arrives. After a rate **decrease** — routine at an epoch roll, where
the settlement rate is usually below the base rate — the armed value is computed
from the old, faster curve and lands **above** the new canonical value. Only
`set_okum_multiplier` re-synced the display (D-10); the ordinary rate path did
not, so this was live.

Measured at the worst alignment (rate change immediately after a sync):

| change | display excess |
|---|---|
| 20 % → 5 % APY (routine epoch roll) | $0.25 per $1M |
| 100 % → 0 % (aggressive halt) | $1.32 per $1M |
| `MAX_RATE` → 0 % (absolute worst) | $6.00 per $1M |

Small and self-correcting within one crank, but the wrong direction — the
display would briefly promise more than the PSM will pay.

Closing it by having every rate write re-sync the display would have meant
putting the mint back into `SetYieldRate`, re-coupling the one instruction that
must land reliably at epoch boundaries to the token program. **Dropping the
pre-arm instead was better on four counts:**

- the invariant becomes **unconditional** — the mirror is a pure lag on a
  monotonically-increasing curve, with no armed step that can go stale
- `sync_display_multiplier` halved, 103,753 → **54,309 CU**
- the dependency on Token-2022's future-timestamp resolve semantics (D-02)
  disappears entirely
- less on-chain machinery, in line with the governing principle

Cost: if the crank stops, the display freezes rather than advancing one more
step. Stale-**low**, therefore safe.

Verified by mutation: with the pre-arm temporarily restored, all three new tests
fail, reporting display `1.0000058` against canonical `1.0000000189` after a
decrease and against exactly `1.0` after a halt.

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

## D-04 · `rpow` overflow threshold differs in the far tail — `ACCEPTED` (now proven)

EVM reverts when an intermediate **product** exceeds `uint256` (`x < 2^128`).
The Rust port returns `None` when an intermediate **quotient** exceeds `u128`
(`x ≈ 1.84e28`). The SVM bound binds first, so a band exists where EVM succeeds
and SVM errors.

**Previously an argument; now a test.** `crates/oku-shared/src/rate.rs`
§ `reachability` sweeps the domain and the margin is far larger than expected:

| rate | window | result | computes? |
|---|---|---|---|
| 20 % APY | 100 years | 8.3e7× | yes |
| 100 % APY | 30 years | 1.1e9× | yes |
| `MAX_RATE` | 3 years | — | yes |
| 500 % APY | 30 years | 2.2e23× | **no** |
| 100 % APY | 100 years | 1.3e30× | **no** |

`rpow` only fails where the multiplier would be ~**1e23×** or more, while
`MAX_MULTIPLIER` already clamps it at **1e6×** ($1,000,000 per token).
Roughly **seventeen orders of magnitude** separate the point where the value
stops being economically meaningful from the point where the arithmetic stops
working.

The headline assertion is the one that matters: *anywhere the result is still
inside `MAX_MULTIPLIER`, the arithmetic works* — swept across every rate the
rails permit and windows from one day to a century.

Failure is also an **error, never a wrong number**: the PSM refuses to price
rather than mispricing, recoverable by republishing the schedule.

The differential corpus still excludes this region by design (it would generate
known-failing vectors); the reachability tests cover it instead.

---

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
| Dead `InterestBearingConfig` mint helper, never invoked (`scripts/utils/tokenHelpers.ts`) | **Resolved** — deleted (77 lines), along with its now-unused imports and a stale reference in the cost estimator |
| Anchor version mismatch: `Anchor.toml` 1.0.2 vs `Makefile`/CI 1.0.0 | **Resolved** — aligned to 1.0.2 |

The version mismatch was the more serious of the two: `Anchor.toml`,
`Cargo.toml` and `Cargo.lock` all declared **1.0.2** while the Makefile and CI
installed **1.0.0**, so CI was verifying builds against a different compiler
from the one developers and the lockfile use. Both are now 1.0.2, and CI
asserts the installed CLI matches `Anchor.toml` rather than discovering drift
through a behaviour difference.

All seven items in this entry are now closed.

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

**Fixed** twice over. `test:bankrun` now prefixes `anchor build &&`, and
`startBankrun` asserts the `.so` is newer than the newest `.rs` / `Cargo.toml`
under `programs/` and `crates/`, failing with an actionable message. The second
guard matters because invoking mocha directly is the natural thing to do when
iterating on a single suite, and that path bypassed the first.

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

## Status at a glance

**One decision outstanding.**

| # | Needs | Blocking? |
|---|---|---|
| **D-26** | Signed off-chain ledger only, or also a per-epoch hash anchored on one EVM chain? | **Mainnet blocker** either way — the stores must become durable regardless; only the on-chain anchor is undecided |

**Accepted, no action:**

| # | Accepted |
|---|---|
| D-25 | Early-shock overshoot — worst *tested* 28.61 % of an epoch's yield, not a proven bound, irreversible. Mitigated by conservative liquidity and rate-setting rather than guards |
| D-03 | Solana clock lag — a self-correcting lag, handled in drift tooling |
| D-04 | `rpow` far-tail threshold — now proven unreachable by ~17 orders of magnitude |
| D-06 | `mul_div_ceil` retained without an on-chain caller |
| D-16 | Display freshness depends on the crank; stale-low, therefore safe |

**Deferred:**

| # | Deferred |
|---|---|
| D-07 | SVM fresh redeploy — unblocked, since no EVM upgrade is in the path |

Everything else in this log is `DECIDED`, `RESOLVED`, `FIXED`, `REJECTED` or
`OBSOLETE`.
