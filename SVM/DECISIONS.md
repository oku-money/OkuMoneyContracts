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

## D-01 · `MAX_ACCRUAL_WINDOW` — add to both stacks? — `OPEN`

Neither stack currently caps how far `rateEnd` may be set into the future.
EVM's only bound is `rpow` reverting on overflow (~30 years at `MAX_RATE`,
per `EVM/src/lib/MathLib.sol:78-81`).

The user's direction was "keep it congruent with EVM, 30 years is more than
fine, small tweaks to the EVM side are ok". The 256-bit `mul_div` removed the
*correctness* need for a cap (see D-04 for the residual tail), so no cap has
been added. It is still worth adding as **defence in depth** — it bounds the
unattended-successor overhang and makes the halt semantics explicit rather
than emergent from an overflow.

**Proposed:** `MAX_ACCRUAL_WINDOW_SECS = 90 days`, enforced identically in
`OkuMoney.setOkuMYieldRate` / `setOkuMYieldRateWithSuccessor` and in the SVM
equivalents. Epochs are 7–30 days, so 90 days is 3–13× headroom.

**Needs:** confirmation that touching `OkuMoney.sol` is in scope, and a value.

---

## D-02 · Token-2022 `update_multiplier` future-timestamp semantics — `RESOLVED by design` (verification still wanted)

The display mirror pre-arms the next staircase step. Whether Token-2022's
processor resolves the standing `multiplier` field to `current_multiplier(now)`
before overwriting `new_multiplier` lives in the **processor**, which is not
part of `spl-token-2022-interface` (the only crate vendored here), and was not
verified during this pass.

**Worked around rather than blocked on:** `sync_display_multiplier` issues
**two** CPIs — `m(now)` effective immediately, then `m(now+T)` pre-armed — which
is correct under either processor semantics. The ambiguity is therefore off the
correctness path; the cost is one extra CPI per sync.

**Still worth doing:** assert the actual behaviour in
`tests/bankrun/display-mirror.ts` against the real `spl_token_2022.so` dump. If
the processor *does* resolve, the first CPI can be dropped for a small saving.

---

## D-03 · Solana clock lag vs EVM `block.timestamp` — `ACCEPTED`, needs tooling change

`Clock::unix_timestamp` is validator-vote-derived and can lag wall clock.
Because the multiplier is a pure function of that timestamp, this is a
self-correcting **lag**, not a permanent drift — SVM catches up when the
clock does.

**Consequence for tooling:** `checkMultiplierDrift.ts` must compare multipliers
at equal *chain timestamps*, not at equal wall-clock instants, or it will
report false positives against SVM. Not yet implemented.

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

**To close properly:** extend the cross-language differential harness
(D-05) to search the boundary region explicitly, or adopt D-01's window cap
which makes the argument trivial.

---

## D-05 · Cross-language differential harness — `DEFERRED`

The strongest available evidence for the cross-chain-determinism claim, and
the one thing that would catch a silent port divergence. Not yet built.

Design: a Foundry script drives the existing `EVM/test/mocks/MathLibHarness.sol`
over the full 7-tuple input space — all three `computeMultiplier` branches,
boundaries at `rateEnd`/`pendingRateEnd`, `MAX_RATE`, the `MAX_MULTIPLIER`
clamp, `elapsed == 0`, halted — and emits a JSON vector file. A Rust
`#[test]` and a TS test both replay it and assert **exact** equality. Corpus
committed; runs in CI. Round-trips in both directions so a Rust fuzz finding
can be replayed against Solidity.

Until this exists, EVM↔SVM multiplier parity rests on code review of the
port plus the per-stack unit tests.

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

## D-10 · Display mirror is not monotonic across an emergency override — `OPEN`

`set_okum_multiplier` writes a new base to `PsmConfig` but does **not** touch
the extension, so the display mirror only catches up on the next sync (≤60s).
Since the override is strict-increase, display stays `<=` canonical throughout,
which is the safe direction.

But there is a subtler case: the override also **halts** the schedule. If a
sync had previously pre-armed a step at `m(t+T)` computed under the *old*
(still-running) schedule, that pre-armed value could exceed the new canonical
value if the override lands at a lower point than the old curve would have
reached. The override's strict-increase check is against the current canonical
value, not against the outstanding pre-armed one.

**Consequence:** for up to one sync interval after an emergency override, the
display could read slightly *above* canonical — the unsafe direction.

**Proposed fix:** have `set_okum_multiplier` write the display mirror
synchronously (immediate value, no pre-arm), collapsing the window to zero.
This requires adding the mint + token program to `SetOkuMMultiplier`'s accounts,
which it already has for the supply read.

Not done in this pass. Low severity (emergency-only path, bounded by the sync
interval, bounded in magnitude by one interval of yield) but it is a genuine
inversion of the invariant the mirror is supposed to maintain.

---

## D-11 · Piggyback sync swallows errors — `ACCEPTED`

`try_sync_display` in `instructions/psm.rs` is deliberately infallible: a
display-mirror failure must never block a user's mint or redeem. The trade-off
is that a persistently failing CPI would be invisible from the PSM path.

Mitigation is that the same failure would also surface on the permissionless
crank, which *does* propagate errors, and the `DisplayMultiplierSynced` event
makes staleness observable off-chain.

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
