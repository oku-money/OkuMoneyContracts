# SVM Streaming-Accrual Refactor — Open Decisions & Deferred Items

Working log for the port of EVM's streaming rate-schedule model to SVM
(`TRACKER.md` § "EVM/SVM yield-model divergence").

Every entry here is something deliberately **not** resolved during the
implementation pass, recorded so it is not silently lost. Nothing in this
file is a known bug in shipped code; these are design questions, accepted
divergences, and verification debt.

Status key: `OPEN` needs a human decision · `DEFERRED` decided, work not done
yet · `ACCEPTED` divergence we are knowingly living with.

---

## Decisions already taken (for context)

| # | Decision | Rationale |
|---|---|---|
| — | Canonical multiplier computed in-program; `ScaledUiAmount` is a lagging **display mirror** only | `ScaledUiAmount` cannot stream (one pre-armable step); `InterestBearingConfig` is mutually exclusive with it (`spl-token-2022-interface-2.1.0/src/extension/mod.rs:1359-1361`) and loses `rateEnd`, the pre-staged successor, and re-anchoring |
| — | `PRECISION` 1e9 → **1e18** | One ulp of a per-second rate at 1e9 is **3.2% APY** — the schedule is inexpressible. Also buys bit-identical EVM parity |
| — | Full 256-bit `mul_div` rather than the split-numerator trick | Split-numerator caps at ~777 days at `MAX_RATE`; the 256-bit version is exact over the entire `u128²` domain with no reachability argument to maintain. Divisor is `1e18 < 2^60`, so it is small-divisor long division, not Knuth-D |
| — | `DISPLAY_SYNC_INTERVAL = 60s` | ~$0.35 drift per $1M at 20% APY; ~0.007 SOL/day |
| — | Scope is the yield model only | SVM stays single-token — no `OkuDollar`, no `RedemptionQueue` (deliberate, per Track C) |

---

## D-01 · `MAX_ACCRUAL_WINDOW` — `DEFERRED` (needs a decision, blocks nothing)

Neither stack caps how far `rateEnd` may be set into the future. EVM's only
bound is `rpow` reverting on overflow (~30 years at `MAX_RATE`, per
`EVM/src/lib/MathLib.sol:78-81`).

**Deliberately not done this pass.** It is the only item that would touch
`OkuMoney.sol`, which is **live on six networks**. Adding a `require` is
storage-layout-neutral, but it is still a UUPS upgrade needing the full
`checkLayout` / `preState` rehearsal on every one of them — a deployment
decision, not a code one.

**Nothing depends on it.** All three reasons it was originally proposed have
since been addressed another way:

- *Correctness*: the 256-bit `mul_div` already covers the whole reachable
  domain (see D-04).
- *Bounding the differential corpus*: the generator bounds its own domain at
  90 days by construction, documented in its header.
- *Compute cost*: `rpow` scales with `log2(elapsed)`, so a 90-day window costs
  only ~3 more iterations than a 7-day one. Capping the window is a weak lever
  on CU and is not what fixed D-15.

**Still worth doing** as defence in depth: it bounds the unattended-successor
overhang and makes halt semantics explicit rather than emergent from an
overflow. Proposal stands at `MAX_ACCRUAL_WINDOW_SECS = 90 days` (3-13x the
candidate epoch lengths), enforced identically in `OkuMoney._setOkuMYieldRate`
/ `_setNextOkuMYieldRate` and the SVM equivalents.

**Needs:** approval to schedule an EVM upgrade, and a value.

---

## D-02 · Token-2022 `update_multiplier` future-timestamp semantics — `RESOLVED`

**Verified empirically** against the real `spl_token_2022.so` dump in
`tests/bankrun/display-mirror.ts`. After the two-CPI sync the extension holds:

```
multiplier    = 1.0                 <- first CPI, effective immediately
newMultiplier = 1.0000057924871757  <- second CPI, pre-armed
effectiveTs   = t0 + 60
```

So the processor **does** resolve the standing `multiplier` field to
`current_multiplier(now)` before overwriting `new_multiplier`, and it preserves
the immediate write. Both orderings behave as intended.

`sync_display_multiplier` keeps the two-CPI form regardless: it is correct under
either semantics, costs one extra CPI per minute, and does not depend on an
undocumented processor detail that could change in a future Token-2022 release.

**Possible optimisation, not taken:** the first CPI could be dropped now that the
resolve behaviour is confirmed. Not worth coupling to the detail.

---

## D-03 · Solana clock lag vs EVM `block.timestamp` — `ACCEPTED`, needs tooling change

`Clock::unix_timestamp` is validator-vote-derived and can lag wall clock.
Because the multiplier is a pure function of that timestamp, this is a
self-correcting **lag**, not a permanent drift — SVM catches up when the
clock does.

**Handled.** `checkMultiplierDrift.ts` now reads SVM and records the timestamp
each chain's multiplier was evaluated at (`evaluatedAtSec`), reporting the read
skew alongside any spread. The schedule-field equality check — which is
timestamp-independent and therefore exact — is the real catch-all; the
multiplier spread is secondary and annotated so a clock lag is not mistaken
for a divergence.

`readSvmSchedule` uses `getBlockTime(getSlot())` for cluster time and warns
loudly if it has to fall back to wall clock, since that reintroduces the very
confusion the field exists to avoid.

---

## D-04 · `rpow` overflow threshold differs from EVM in the far tail — `ACCEPTED`

EVM's `rpow` reverts when an intermediate **product** exceeds `uint256`
(`x < 2^128 ≈ 3.4e38`). This port returns `None` when an intermediate
**quotient** exceeds `u128` (`x ≈ 1.84e28`). The SVM bound binds first.

Both thresholds sit far outside the reachable domain: `MAX_MULTIPLIER`
clamps output at `1e24` (1e6×), while the SVM bound only engages above
~1.8e10× *within a single squaring step*. There is therefore no reachable
schedule where EVM succeeds and SVM errors — but this is an argument, not a
proof.

**Status after D-05.** The differential corpus deliberately does NOT generate
vectors in this region — doing so would produce known-failing cases and
devalue the whole corpus. So this remains an argument, not a proof. It is
recorded in the generator's header so the exclusion is explicit rather than
an accident of the chosen ranges.

**To close properly:** adopt D-01's window cap, which makes the argument
trivial, or add a dedicated boundary-search test that asserts the two
thresholds bracket the reachable domain.

---

## D-05 · Cross-language differential harness — `DONE`

Built. `EVM/test/differential/GenerateVectors.t.sol` drives the existing
`MathLibHarness` over a structured grid — every `computeMultiplier` branch,
both window boundaries sampled at ±1, `MAX_RATE`, the `MAX_MULTIPLIER` clamp,
`elapsed == 0`, halted, `anchor > rateEnd`, zero base — plus 400 seeded fuzz
cases and four deliberate revert cases. It writes
`EVM/test/differential/vectors.jsonl` (committed).

Both other implementations replay it:

- `SVM/oku-programs/crates/oku-shared/tests/differential.rs`
- `packages/yield-tooling/test/differential.test.ts`

**3,290 vectors, 4 of them reverts, all three implementations agreeing
exactly.** Reverts are checked as strictly as values: "one implementation
accepts what another rejects" is as much a divergence as a wrong number, and
exactly that class of bug was found by hand in the instruction layer during
this pass.

Run the whole loop with `npm run test:differential` from the repo root.

**Validated by mutation.** Flipping `rpow`'s accumulator from half-up to floor
in the TypeScript — a realistic one-ulp rounding slip — fails 1,218 of 3,290
vectors. The harness detects the class of bug it exists for, rather than
being green by construction.

**Not covered:** the generator bounds its domain to what a compliant writer
can produce, so the far-tail overflow divergence (D-04) is excluded by design.
Only `computeMultiplier` is compared; `raw_to_dollars` / `dollars_to_raw` have
their own per-stack fuzzing but no cross-language corpus.
---

## D-06 · `mul_div_ceil` still has no on-chain caller — `ACCEPTED` (pre-existing)

Carried over from before this refactor. Fuzzed, Kani-proven, unit-tested,
unused. Retained for a future reserve-accounting path per the rounding
policy in `crates/oku-shared/src/math.rs`. Unchanged by the WAD migration —
it is still the generic `u64` helper, since it was never a multiplier path.

---

## D-07 · `PsmConfig` grows — fresh redeploy required — `DEFERRED` (already tracked)

Adding the six schedule fields plus `last_display_sync_ts` grows `PsmConfig`
from 562 bytes. SVM is devnet-only (`deployments/` contains only
`devnet.json` / `devnet-fork.json`), so this is a fresh deploy rather than a
migration, and `TRACKER.md` already carries "SVM devnet needs a fresh
re-deploy (not an in-place upgrade)".

No mainnet SVM holders exist, so the mint can be recreated freely.

---

## D-08 · Pre-existing SVM defects found during the audit — `DEFERRED` (out of scope)

Explicitly excluded from this pass (scope = yield model only). Recorded so
they are not lost:

| Defect | Location |
|---|---|
| `distribute-yield.ts` reads `cfg.multiplier`, a field removed from `PsmConfig` → `TypeError` before submit | `scripts/admin/distribute-yield.ts:62,86` |
| README documents `set_multiplier(new_multiplier: f64)`; actual ABI is `u64` | `SVM/README.md:300` |
| README claims `read_multiplier` "treats 0.0 as 1.0"; it falls back to `config.multiplier` | `SVM/README.md:143-149` |
| `test-devnet.ts` computes expected yield delta against **dollar** supply; on-chain used **raw** supply | `scripts/test/test-devnet.ts:526` |
| Dead `InterestBearingConfig` mint helper, never invoked | `scripts/utils/tokenHelpers.ts:71-130` |
| CI references non-existent `SVM/oku-programs/trident-tests` | `.github/workflows/test.yml:192` |
| Anchor version mismatch: `Anchor.toml` 1.0.2 vs CI/Makefile 1.0.0 | `Anchor.toml:2`, `Makefile:9` |

Several of these self-resolve: `distribute_yield` and `read_multiplier` are
both deleted by this refactor, taking their stale docs and scripts with them.

---

## D-10 · Display mirror could read above canonical after an emergency override — `FIXED`

The override halts the schedule, but a previous sync may have pre-armed a step
`m(t+T)` computed under the *old, still-running* schedule. That armed value can
exceed the new canonical multiplier, because the override's strict-increase
check compares against the CURRENT canonical value, not against an
already-armed future one. For up to one sync interval the display would then
read *above* canonical — the one direction the mirror must never take.

**Fixed** by having `set_okum_multiplier` write the display mirror
synchronously (immediate effective timestamp, no pre-arm), which overwrites the
stale armed step and collapses the window to zero. Unlike the piggyback sync
this write is NOT best-effort — if the display cannot be corrected the override
fails.

Needs a bankrun regression test: sync → arm a step → override below the armed
value → assert display `<=` canonical immediately.

---

## D-13 · `npm run test:bankrun` did not rebuild the program — `FIXED`

Bankrun loads `target/deploy/lite_psm.so`, but `test:bankrun` was just
`mocha`. Running it after editing Rust without an intervening `anchor build`
silently tested the **previous** binary.

Not hypothetical: it masked the D-10 fix appearing not to work. The test was
correct and the code was correct; only the artifact was stale, and the
resulting "the fix doesn't work" conclusion was wrong.

**Fixed** by making `test:bankrun` run `anchor build &&` first.

**Still worth considering:** have `startBankrun` assert the `.so` mtime is
newer than the newest file under `programs/`, so the trap cannot reappear for
anyone invoking mocha directly.

---

## D-14 · `tsc --noEmit` does not pass on this repo — `ACCEPTED` (pre-existing)

21 type errors, unchanged by this refactor (verified by diffing the count
against a clean stash). Two categories:

- 12 × Anchor generic variance — `Program<LitePsm>` not assignable to
  `Program<Idl>` in shared test helpers.
- 9 × miscellaneous: `accountsPartial` extra keys that Anchor accepts at
  runtime, a wrong relative path to `target/types` in
  `scenarios/realWorldUsage.ts`, and `AccountNamespace<Idl>` lacking
  `psmConfig` in `tests/shared/setup.ts`.

Tests pass because `tsx` transpiles without typechecking. Nothing here is a
runtime bug, but it means TypeScript is providing no safety net on the SVM
test suite.

**Partly addressed.** `EVM/` and `packages/yield-tooling/` both typecheck
clean, including all the new SVM-reading code. The remaining errors are
confined to `SVM/oku-programs/tests/` and are unchanged in count and kind from
before this work (verified by diffing against a clean stash).

---

## D-11 · Piggyback sync swallowed errors — `OBSOLETE` (superseded by D-15)

The opportunistic display sync on `mint_oku_m` / `redeem_oku_m` was
deliberately infallible, so a persistently failing CPI would have been
invisible from the PSM path.

Moot: the piggyback was removed entirely after compute-budget measurement
(D-15). The user-facing instructions no longer touch the display mirror, so
there is no swallowed-error path left on them.
---

## D-12 · No on-chain multiplier view for integrators — `OPEN`

Solana has no view functions. Integrators who want the canonical multiplier
must either recompute `compute_multiplier` client-side from `PsmConfig`, or
read the lagging display mirror.

Options, none implemented:
- Add a `get_okum_multiplier` instruction that returns via `set_return_data`,
  callable through simulation.
- Ship the TS mirror as part of `@okumoney/yield-tooling` (planned anyway for
  `checkMultiplierDrift`), and document it as the supported path.

The TS mirror will exist regardless, so this is mostly a question of what we
tell third parties to use.

---

## D-09 · `SECONDS_PER_YEAR` convention — `OPEN`

EVM's off-chain deriver uses exactly 365 days (`EVM/scripts/utils/yieldRate.ts:30`)
as a protocol convention. Token-2022's `InterestBearingConfig` uses 365.24 —
previously flagged in `TRACKER.md` as a parity friction point.

**This is now moot for correctness**: the display mirror writes a *multiplier*,
not a rate, so Token-2022 never performs rate math on our behalf. The 365-day
convention applies uniformly on both stacks because both consume the same
derived per-second integer.

**Remaining action:** delete the stale 365.24 friction note from `TRACKER.md`
when the tracker entry is closed out.

---

## D-15 · Compute budget — `FIXED`, with headroom to reclaim if ever needed

The streaming refactor shipped on an **estimate** of 15-40k CU for the
multiplier computation. Measured, it was:

| path | before | after |
|---|---|---|
| `mint_oku_m`, 7-day window | 151,225 | 53,473 |
| `mint_oku_m`, 90-day window | 172,324 | 62,335 |
| `mint_oku_m`, two-`rpow` overhang | **>200k — hard failure** | 80,883 |
| `redeem_oku_m`, two-`rpow` overhang | **>200k — hard failure** | 74,359 |
| `sync_display_multiplier` | 179,875 | 103,753 |

The overhang branch is not an edge case — it is the state of every chain
between an epoch handover and the next schedule write. **As committed, mints
and redeems would have begun failing outright once a window closed.** That the
estimate went unchecked for a full pass is the process lesson here: a
user-facing hot path acquired a ~20-iteration `rpow` and nobody measured it.

Causes and fixes, both in `crates/oku-shared/src/wad.rs`:

1. `widening_mul` held its limbs as `u128`, so LLVM emitted four `__multi3`
   libcalls per call instead of native 64x64→128 widening multiplies. Fixed by
   typing the limbs `u64`.
2. `div_wad` always ran the full four-limb long division — eight software
   division libcalls — despite the product fitting `u128` for essentially every
   real operation. Added a fast path: when `a * b` fits `u128`, one multiply
   and one division. Provably identical; re-fuzzed 23.5M executions against the
   independent oracle and re-verified against the 3,290-vector differential
   corpus.
3. Removed the opportunistic piggyback display sync from `mint_oku_m` /
   `redeem_oku_m` (~31k CU for a cosmetic refresh).

Pinned by `tests/bankrun/compute-budget.ts` at a 100k ceiling on user paths
and 150k on the crank, so a regression fails CI.

**Remaining headroom, if it is ever wanted.** The dominant cost is now a single
`u128` division per `mul_div` (`__udivti3` is a software routine on SBF; there
is no 128-bit divide instruction). Two options, neither taken because nothing
currently needs them:

- Division by the *constant* `PRECISION` via Granlund-Montgomery multiply-high,
  turning the division into a 128x128 multiply-high plus a shift.
- 128÷64 via three native `u64` divisions (SBF has a 64-bit divide instruction),
  using the standard two-limb algorithm.

Either would be new, subtle, security-critical code on the hottest path in the
protocol. Not worth it at 80k against a 200k limit.

---

## D-16 · Display freshness now depends entirely on the crank — `ACCEPTED`

Follows directly from D-15's removal of the piggyback. An idle PSM with nobody
running `scripts/admin/sync-display.ts` will show a stale wallet balance.

Bounded and safe: the mirror only ever reads **low**, never high, so a redeem
always pays at least what was displayed. Nothing prices against it. But it does
mean display freshness is an operational responsibility rather than a
self-maintaining property, and `SVM/README.md` says so explicitly.

If this proves annoying in practice, the cheapest fix is not to restore the
piggyback but to have the crank run as part of whatever already monitors the
deployment — it is permissionless, so it needs no key material.
