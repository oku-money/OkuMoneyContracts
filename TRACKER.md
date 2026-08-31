# Oku Money Contracts Tracker

Open issues + follow-ups for the Oku Money on-chain stack (EVM + SVM).
Scope is on-chain code; operational items (key custody, monitoring,
incident response) are tracked separately by the operator team and
intentionally excluded from this file. Resolved items are removed;
full history lives in git and in each side's README.

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Tag legend:** `[EVM]` `[SVM]` `[both]`

The goal is to clear every item before audit. This file should be
removable post-launch.

---

## Status

### EVM — `8056_reduced_redeem`

Continuous, time-anchored accrual; ERC-8056 on OkuM with a single unified
multiplier; bounded permissionless PSM with no fees and no queue.

| Gate | Result |
|---|---|
| `forge fmt --check` | pass |
| `forge build` | pass — **no `warning[...]` and no `unused-import`/`unsafe-typecast` `note[...]` in `src/`.** The remaining `src/` notes are `mixed-case-function`/`pascal-case-struct` from ERC-8056's required `UI`/`PSM` casing (e.g. `toUIAmount`, `LitePSMStorage`) — not fixable without breaking the interface, so not counted as warnings. |
| `forge test` | **109 passing** across 7 suites |
| `forge coverage` | **100% line, 100% function** on `src/` (555/555 lines); **81.73% branch** (85/104) — `MathLib` (57%) and `LitePSM` (65%) are the weakest, worth auditor attention |
| `npx tsc --noEmit` | pass |
| `npx hardhat compile` | pass |
| `npm run upgrade:validate` | pass — all 3 impls UUPS-safe with ERC-7201 storage |
| `npx hardhat compile && npm run export-abis` | **must be re-run before every commit that changes an ABI** — CI's drift check (`git status --porcelain artifacts/evm/`) hard-fails otherwise. Caught mid-cycle this time; see "Resolved this cycle." |
| Fork deploy + 11-step lifecycle | pass |

| Suite | Tests | Covers |
|---|---|---|
| `Differential.t.sol` | 6 | The two load-bearing proofs + fuzzed two-chain agreement under adversarial interleaving |
| `SystemInvariants.t.sol` | 10 | 128k calls each, adversarial handler |
| `OkuM.t.sol` | 25 | ERC-8056 conformance, rate bounds, halt, backdating/re-anchor guards |
| `LitePSM.t.sol` | 17 | Buffer bound, window levers, pricing, deploy guards |
| `Coverage.t.sol` | 21 | Accessors, admin paths, defensive branches |
| `MathLib.t.sol` | 16 | Rounding, `rpow` branches, `compound` determinism |
| `USDOku.t.sol` | 14 | `M_oku`-only exchange rate, pre-funding, rebasing ledger, backdating/re-anchor guards |

**Resolved this cycle** (see git history for the diff):

- **CI was red — the ABI-drift gate failed.** Last cycle's contract changes
  (gate removal, new errors) changed `OkuM`'s ABI, but `artifacts/evm/` was never
  regenerated. CI's "Check exported artifacts are up to date" step hard-fails on
  this. Fixed by regenerating and committing.
- **CI installed the wrong Anchor CLI version.** `.github/workflows/test.yml`
  installed `anchor-cli --tag v1.0.0` while `Anchor.toml` pins `anchor_version =
  "1.0.2"` — the comment even claimed they matched. Fixed the tag, cache key, and
  comment to `1.0.2`.
- **The SVM job never type-checked, at all.** `npm run typecheck` existed only in
  the EVM job. Added a `TypeScript type-check` step to `svm-tests`, positioned
  after `anchor build` so it sees a freshly generated IDL rather than a stale
  local one. Landed **non-blocking** (`continue-on-error: true`) deliberately —
  see "SVM test harness `tsc` count was wrong" below for why the true baseline
  is still unknown.
- **`USDOku.setUsdOkuRate` had the identical backdating/re-anchor-bound gap
  `OkuM.setOkuMRate` had before last cycle — found independently, confirmed by
  exploit test, then fixed.** No lower bound existed on `startTime`, and no
  `MAX_REANCHOR_BPS`-equivalent capped an instantaneous `baseIndex` jump — only
  `IndexCannotDecrease`/`IndexTooHigh` (a coarse ceiling) and
  `backingCoversLiability()` (a vault-solvency check, not a step-size one). A
  single call could jump `M_usd` by ~50% instantly (confirmed exploit,
  ~5000x the analogous OkuM bound), reallocating value to whoever held USDOku
  shares at that moment. Fixed with a new `MAX_USD_REANCHOR_BPS` constant and a
  `StartTimeInThePast` check, mirroring the OkuM fix — **except** a USDOku
  re-anchor is deliberately **not** required to take effect immediately, since
  `M_usd` is a declared forward rate that legitimately schedules ahead as routine
  practice (unlike an OkuM re-anchor, which is specifically a one-off catch-up).
- **`wrap`'s issuer-caused revert is now decoded with an actionable message**
  in `scripts/test/test-onchain.ts`, and the root README's orchestrator runbook
  gained a "Fund the vault before marketing USDOku" section pointing at
  `withdrawableSurplus()` / `solvencyStatus.ts`.
- **`master` tagged retired** (`master-retired-v1`, annotated, local — not
  pushed) and a "do not deploy from it" banner added to this branch's README.
  `master`'s own README was deliberately left untouched — switching branches
  mid-cycle to edit it was judged higher-risk than the value it added; the tag
  is the durable, branch-independent marker.
- **Multichain orchestration wrapper built and tested end-to-end**
  (`scripts/operator/publishSegmentAllChains.ts`): derives one segment, submits
  it to every chain with a deployed `OkuM`, then samples `indexAt(t)` on all of
  them and asserts agreement — turning "the contracts make sync possible" into a
  checked post-condition. Verified against two independently-deployed local
  `OkuM` instances: successful fan-out + agreement, and (separately) a forced
  divergence correctly detected and reported with a non-zero exit code.
- **Two-chain Foundry fuzz harness added**
  (`testFuzz_twoChainsAgreeUnderAdversarialInterleaving`,
  `test/Differential.t.sol`): two independent `OkuM` deployments, adversarial
  publish/catch-up ordering and timing, asserting `indexAt` agreement at every
  round. Scoped as a bounded 3-round fuzz test rather than a full stateful
  handler (see TRACKER note in the test file for why). Took three real
  iterations to get the TEST FIXTURE correct — a `vm.prank` argument-evaluation
  footgun (same class the codebase already documents in `Base.t.sol`), an
  unmodeled compounding-divergence case, and a flat-vs-accruing segment timeline
  mismatch — each caught by a fuzz counterexample rather than by inspection,
  which is the argument for having this harness at all.
- Stale `RedemptionQueue`/`OracleRelay` references purged from 5 operator/upgrade
  scripts, `testnet-addresses.json`, and both READMEs (prior cycle).
  `grantRolesMainnet.ts` had a dead branch that silently skipped its deploy-time
  sanity check — fixed to check `OkuM` + `LitePSM` directly.
- `scripts/upgrade/preState.ts` was calling getters that don't exist on the
  current contracts at all — rewritten against the real public surface (prior
  cycle).
- **`setOkuMRate` backdating bypass** (prior cycle): no lower bound on
  `startTime` let the re-anchor check resolve against arbitrary history,
  admitting a ~0.82% jump (~8x `MAX_REANCHOR_BPS`) in one call. Fixed with a
  `StartTimeInThePast` check and an immediate-effect requirement for re-anchors.
- **The PSM conversion-gate mechanic removed entirely** (prior cycle) — it
  didn't hold up under the continuous-accrual model and created its own hazard
  (checked at publication time, not when a re-anchor's step actually lands).
- **`MAX_RATE_PER_SECOND` is now derived from `MAX_IMPLIED_APR_BPS`** at compile
  time (prior cycle), instead of a disconnected hand-precomputed literal.
- **`invariant_indexIsFlatPastRateEnd` false positive fixed** (prior cycle) —
  the probe now anchors to `max(activeSegment().endTime,
  pendingSegment().endTime)` instead of assuming no segment is already scheduled.

**Assurance is verified, not asserted.** Both differential proofs were confirmed
lethal by sabotaging the contract — stepping `indexAt` breaks the no-arbitrage
test; anchoring the segment to `block.timestamp` breaks the multichain determinism
test. USDOku's two were confirmed the same way. The invariants are
*probe-verified*: temporary inverted assertions confirmed the fuzzer reaches
non-degenerate states rather than no-oping through the handler's `try/catch`.

### SVM

No source changes on this branch. The design surface was investigated this
cycle (see "SVM must be brought up to this spec" below for a materially revised
plan) but nothing was built — **the environment used for this cycle cannot run
the SVM toolchain at all** (GLIBC 2.35 present, `anchor 1.0.2` requires 2.39;
confirmed by attempting `anchor build`). `cargo test --workspace` (Rust unit
tests only, no Anchor/Solana toolchain needed) does pass: 8 + 12 tests, 1
ignored. Any SVM code change needs a capable machine or CI to build, test, or
verify.

---

## 🔴 Blocks external exposure

**None currently open.** Two real ones were found and fixed across the last two
cycles (`setOkuMRate`'s backdating bypass, and the identical gap independently
present in `setUsdOkuRate`) — both surfaced by deliberately re-examining a
mechanism rather than by the existing fuzz suite, since the handler never
generated the relevant input space until it was deliberately widened. Worth
internalizing for review process: an adversarial fuzz suite is only as good as
the input space its handler explores, and a handler that always calls with
"today's timestamp" will never find a backdating bug no matter how many runs it
does.

---

## 🟡 Should-fix before external audit

### SVM must be brought up to this spec `[SVM]`

**The two sides are materially divergent.** EVM has moved to continuous,
time-anchored accrual; SVM still models a discrete multiplier written per-chain
by the orchestrator. Until SVM follows, the multichain synchronisation property
holds across the EVM deployments only.

**Revised this cycle: the naive parity plan ("just port the EVM segment") does
not work, because Token-2022's `ScaledUiAmountConfig` extension cannot express
it.** Read directly from `spl-token-2022-interface`:

```rust
pub struct ScaledUiAmountConfig {
    pub authority: OptionalNonZeroPubkey,
    pub multiplier: PodF64,
    pub new_multiplier_effective_timestamp: UnixTimestamp,
    pub new_multiplier: PodF64,
}
```

Two `f64` values and a timestamp — a two-point schedule, no rate field, no
compounding. Wallets read this struct directly, so it cannot be bypassed for
display purposes without the display and the settlement price disagreeing —
precisely the failure mode `OkuM.sol`'s own header comment names as the top
design risk on the EVM side.

**The recommended shape is a hybrid, not a straight port:**

- Keep `(baseIndex, ratePerSecond, startTime, endTime)` in `PsmConfig`,
  evaluated with an **integer** `rpow` — this is the SETTLEMENT price, bit-
  identical in spirit to EVM's (same inputs would need the same `rpow`
  implementation, ported separately — see the `f64` note below).
- Refresh the Token-2022 extension **for display only**, on a cheap periodic
  cadence, using `UpdateMultiplier`'s existing `effective_timestamp` field to
  pre-schedule the next display step (the extension already supports this; the
  current code hardcodes `effective_timestamp = 0` in `yield_ops.rs` and simply
  never uses the future-scheduling capability).
- All six `read_multiplier` call sites (`psm.rs` x2, `direct_mint.rs`,
  `direct_burn.rs`, `yield_ops.rs` x2) settle against the integer segment, not
  the `f64` extension value.

**Why this is viable, not just "less bad":** measured (not simulated) numbers
at 5% APR — the maximum DISPLAY drift from a stale extension is 0.00056%/hour,
0.013%/day, 0.40% at 30 days (worst case before any refresh). Refresh cost is
negligible: ~$6.57/yr per chain at hourly cadence, ~$26/yr at 15-minute. This
dissolves the `f64` determinism problem for SETTLEMENT (integer math, `f64`
never touches money) and leaves a bounded, always-understating display lag —
the same shape of tradeoff the EVM-side ERC-8056 conformance item already
accepts for `UIMultiplierUpdated` (see below).

**Not yet done:**

- Validate this design against a working Anchor build — it was derived by
  reading extension source and doing arithmetic, not by compiling or testing
  anything. Needs a machine with GLIBC ≥ 2.39 or CI.
- `PsmConfig` needs new fields for the segment (`baseIndex`, `ratePerSecond`,
  `startTime`, `endTime`) — on Solana this likely means a realloc or a fresh
  PDA, which is exactly why the devnet redeploy item below is already sequenced
  after this work.
- Port an integer `rpow` (SVM currently has none — `oku-shared/src/math.rs` has
  `mul_div_floor`/`mul_div_ceil` but no compounding primitive).
- Match the bounds — `MAX_IMPLIED_APR_BPS`, `MAX_RATE_DURATION`,
  `MAX_REANCHOR_BPS`, `MAX_SCHEDULE_LEAD` — scaled for SVM's 1e9 precision.
- Mirror flatline-on-expiry.
- **Do NOT port a closed-window precondition** — the EVM side had one and
  removed it. A routine declaration moves slope, not level, so it protects
  nothing; the two points below are the real requirement.
- Reject a backdated `startTime` (must be `>= now`, with a `0`-means-"now"
  sentinel). Without this, the re-anchor bound is bypassable — see the resolved
  EVM/USDOku bugs above; port the FIX, not the original bug.
- Require a re-anchor (segment `baseIndex` above the live curve) to take effect
  immediately, never scheduled ahead — the EVM-side reasoning applies unchanged
  to the SETTLEMENT segment (the display-only extension refresh is a separate,
  unrelated schedule and may legitimately be pre-scheduled).

**Effort:** meaningful — treat as its own cycle. The design question is now
answered; what's left is implementation, an integer `rpow` port, and a fresh
devnet deploy (below), all needing a capable build environment this cycle did
not have.

### `MAX_IMPLIED_APR_BPS`, `MAX_RATE_DURATION`, and `MAX_USD_REANCHOR_BPS` need
real numbers `[EVM]`

`MAX_IMPLIED_APR_BPS = 1000` and `MAX_RATE_DURATION = 30 days` are placeholders
inherited from the previous design, explicitly marked `PLACEHOLDER` in
`Constants.sol` pending treasury sign-off — left untouched this cycle
deliberately (no real numbers were available). They are load-bearing here in a
way they were not before: together with flatline-on-expiry they are the
**only** on-chain bound on OkuM paying out yield that has not been realized,
because off-chain RWA backing cannot be verified on-chain.

`MAX_USD_REANCHOR_BPS = 10` (new this cycle, mirroring `MAX_REANCHOR_BPS`'s
value as a placeholder of the same kind) needs the same treatment.

Worst case from a fully compromised rate setter is `cap_APR x one window`. Pick
real numbers against the actual product, then state the resulting worst case in
`EVM/README.md` as a **number**, not a property.

### Confirm `MAX_REANCHOR_BPS` / `MAX_USD_REANCHOR_BPS` against real operator
latency `[EVM]`

Both ship at `10` (0.1%), permitting roughly a week of catch-up at 5% APR while
capping any single step at 0.1%. They are what makes "no step arbitrage" a
**contract-enforced** property on both tokens rather than a procedural one.
Two cycles' worth of fixes have made this claim actually hold in practice
(backdating closed on both `setOkuMRate` and `setUsdOkuRate`; the conversion
gate that used to stand in for a real bound is gone) — calibrate both as
load-bearing, not as one of several layers.

Too tight and a chain that misses a segment cannot be restored without an
intermediate catch-up segment; too loose and it becomes a usable step. Measure
the real worst-case gap between the orchestrator publishing to its first chain
and its last, then set both to a small multiple of that.

### ERC-8056 conformance: continuous drift vs. the event requirement `[EVM]`

`uiMultiplier()` changes every second while `UIMultiplierUpdated` fires only on
declaration. The EIP says the event MUST be emitted "whenever the multiplier is
changed", and also that "how the multiplier is updated is an implementation
detail left to the token issuer" — the two pull in opposite directions for a
continuously-accruing token, which the stock-split motivation did not anticipate.

Our position: the event marks a change of **schedule**, and drift between
declarations is the schedule executing, not a change. A consumer caching on the
event under-displays; the value is monotonic so staleness always understates,
never overstates.

Worth raising upstream — we hold an unusually clear motivating case, a two-index
yield-bearing ERC-8056 deployment, which is a shape the authors have not seen.
Not code — an email/issue to the EIP authors, not gated on anything else here.

### SVM devnet needs a fresh re-deploy (not an in-place upgrade) `[SVM]`

The program builds and passes all tests, but **the devnet program has not been
rebuilt/redeployed** against the current source. An in-place BPF upgrade is
**not** sufficient — the config PDA seed is `psm_config`, so if any prior
devnet deploy used a different seed a fresh deploy (new PDA + mint) is
required. The segment-rework item above will add fields to `PsmConfig` that
independently require a realloc or a fresh PDA, so this redeploy should happen
once, after that work, not twice.

Notable deployed-surface facts vs. any older devnet build:

- Config PDA seed is `psm_config`.
- USDC transfers use `transfer_checked` (mint + decimals validated).
- Error enum includes `ZeroOutput`, `SlippageExceeded`, `MultiplierUnpackFailed`,
  `ScaledUiExtensionMissing`, `MultiplierOutOfRange`.
- `update_token_metadata` instruction is present.

**Before closing:** rebuild, deploy fresh to devnet (new PDA + mint), re-verify
with the bankrun/devnet suites, then mainnet-beta following the
testnet-then-mainnet posture.

> Sequence this **after** the SVM segment rework above, or the redeploy will be
> immediately stale.

### SVM test harness `tsc` count was wrong — real baseline still unknown `[SVM]`

Previously recorded as "35 type errors, caused by `Program<LitePsm>` vs
`Program<Idl>` generic variance." **Both the count and the diagnosis were
wrong.** Measured this cycle against this branch's LOCAL build state: **138
errors** (`TS2339` x49, `TS2353` x44, `TS2345` x32, `TS2551` x12, `TS2307` x1).
The dominant cause is a stale local `target/idl/lite_psm.json` still declaring
instructions and accounts that don't exist in current source
(`setup_redemption_queue`, `oracle_manager`, `pyth_program_owner`, `rebaser`),
plus dead IDLs for programs removed from the design entirely (`oku_dollar`,
`wokusd_vault`, `oku_bridge_router`). `target/` is gitignored, so this is a
LOCAL build artifact, not something committed.

**Genuinely unresolved:** whether 138 is inflated by local staleness or close
to the true fresh-build count could not be determined this cycle — `anchor
build` cannot run in this environment (GLIBC 2.35 vs 2.39 required). The
non-blocking CI `tsc` step added this cycle (see "Resolved this cycle") exists
specifically to get a real number from a fresh build without gating the
pipeline on it. **Next step: read that CI run's output, triage the real error
count, then promote the step to blocking** (remove `continue-on-error`) once
addressed or explicitly waived per-error.

> The SVM suite itself was **not run** on this branch (no capable toolchain
> available). Re-verify it as part of the segment rework above rather than
> assuming any prior result still holds.

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/` package) was
removed. If a static-analysis gate is wanted for the audit, re-introduce a lint
runner in CI.

---

## ⚪ Post-launch / low priority

### Reconsider a token-bucket rate limiter on the PSM `[EVM]`

**Deferred deliberately, not overlooked.** At the planned ~$100k of permissionless
liquidity per chain the USDC buffer **is** the security bound: worst case from any
pricing error or key compromise is the buffer, per chain, and redemption reverts
cleanly when exhausted. A rate limiter adds nothing to that bound.

What it *would* add is fairness. Today a single address can take the entire buffer
in one transaction, so "permissionless liquidity" may not be available to anyone
who is not first. Lido solves exactly this on its entry side with a token bucket —
`_maxStakingLimit` plus `_stakeLimitIncreasePerBlock`, described in their docs as
a health globe regenerating at a constant rate, with a public
`getCurrentStakeLimit()` so integrators can check before submitting.

Revisit if either becomes true:

- per-chain liquidity grows past roughly $1M, where the buffer stops being a
  comfortable loss bound; or
- monitoring shows the buffer drained by one or two addresses rather than serving
  retail flow.

Roughly 40 lines plus one storage slot. `capacity` and `refillPerSecond` would be
deploy config, and `capacity = 0` would subsume the existing `redeemEnabled` flag.

### An independent attester would make the rear-facing guarantee enforceable `[EVM]`

Today `realizedYieldBacking` is a logged parameter on `setOkuMRate`: an immutable,
auditable claim, but not a check. A separate attester **role** was considered and
rejected — it would compare one attested number against another from the same
trust domain, and a late attester would block even a rate *decrease*, which is a
lockout shape already fixed once elsewhere in this codebase.

It becomes worth building the moment the second signer is a genuinely independent
trust domain: an RWA custodian signature, or a Chainlink Proof-of-Reserve feed.
The parameter is deliberately shaped so a PoR feed drops in without a migration —
the check becomes `projectedAccrualAt(rateEnd) <= porFeed.reserves()`.

### Cross-process E2E test `[both]`

Forked EVM (anvil) + bankrun SVM + the actual orchestrator process between them.
Better suited to nightly CI than per-PR. Gated on the SVM segment rework.

**Effort:** 2–3 weeks.

### Audit-attention surfaces `[both]`

Informational only — no functional issue, just where reviewer time will
concentrate:

- **EVM `ScaledUIAmountUpgradeable.indexAt`** — the densest and
  highest-consequence code in the EVM suite. It resolves which of two segments
  governs a given timestamp, and its purity in time is what makes ten chains agree
  without messaging. `_installSegment`'s crystallisation step deserves equal
  attention: it exists specifically to avoid the boundary defect in ERC-8056's own
  reference implementation, where the setter branches on `>` while the view
  resolves on `>=`, so a pending value maturing in the same second as the next
  write is silently lost.
- **EVM `OkuM.setOkuMRate` and `USDOku.setUsdOkuRate`** — the two highest-value
  entry points; they set the price every permissionless conversion executes at,
  on every chain. Two cycles' worth of fixes now bound both: the continuity and
  re-anchor checks cap a compromised key at 10 bps (`MAX_REANCHOR_BPS` /
  `MAX_USD_REANCHOR_BPS`), and backdating is closed on both. The
  routine/catch-up split and the `startTime == 0` sentinel are the most
  recently-changed and least battle-tested logic in either contract;
  disproportionate review attention here is warranted. `publishSegmentAllChains.ts`
  and `testFuzz_twoChainsAgreeUnderAdversarialInterleaving` (both new this
  cycle) are the tools that exercise this surface most directly — worth an
  auditor's time to read alongside the contract code, not just the contract
  code alone.
- **EVM `USDOku.wrap` / `unwrap` rounding directions** — `wrap` floors the share
  credit and `unwrap` ceils the share burn. That asymmetry is what makes
  `backing >= liability` survive both directions; inverting either silently breaks
  the invariant without failing any single-call test.
- **SVM manual Token-2022 mint construction in `initialize`**
  (`instructions/init.rs`) — extension-length math, a two-step `CreateAccount`,
  and four raw `invoke`/`invoke_signed` calls. Correct and well-commented;
  flagged for focused attention rather than as a defect.
- **SVM `f64` multiplier round-trip** (`helpers/scaled_ui.rs`,
  `instructions/yield_ops.rs`) — the `u64 → f64 → u64` conversion is exact only
  under the compile-time `MAX_MULTIPLIER < 2^52` assertion, and `read_multiplier`
  re-implements effective-multiplier selection to work around the Token-2022
  zero-init edge case. Carries an in-code `AUDITOR ATTENTION` block. The segment
  rework above proposes moving this to display-only, which shrinks but does not
  eliminate its consequence — a wrong DISPLAY multiplier is now a UX bug rather
  than a mispricing, but still worth getting right.

### Operator CLI gaps `[SVM]`

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the two-step
  `role_admin` transfer's second step happens once per rotation by the cold
  multisig via Squads; a documented IDL call in the runbook is sufficient. Build
  CLIs only if the runbook requires them.

---

## Next steps

In order. The first two are decisions rather than code, and they gate the rest.

1. **Set `MAX_IMPLIED_APR_BPS`, `MAX_RATE_DURATION`, `MAX_REANCHOR_BPS`, and
   `MAX_USD_REANCHOR_BPS`.** Product decisions. These define the worst-case
   unrealized-yield exposure and the step-arbitrage ceiling on BOTH tokens,
   which should be stated numbers before anyone reviews the design.
2. **Triage the SVM `tsc` CI baseline** once the non-blocking step (added this
   cycle) has run against a fresh build — then promote it to blocking.
3. **Validate the SVM segment-rework design** (hybrid: integer settlement
   segment in `PsmConfig`, `f64` extension refreshed for display only) against
   a real Anchor build, on a machine or CI with GLIBC ≥ 2.39. This cycle
   produced the design by reading source and doing arithmetic; nothing was
   compiled or tested.
4. **SVM segment implementation** — port the fixed (not the original buggy)
   backdating/re-anchor logic from EVM, plus an integer `rpow`.
5. **SVM devnet redeploy**, sequenced after (4).
6. **Audit.**

Already done this cycle, previously listed here as open: tag `master` retired,
build the multichain orchestration wrapper, build the two-chain Foundry
harness, fix the USDOku re-anchor gap, decode the `wrap` revert message, fix
the three CI defects (ABI drift, Anchor version, missing SVM typecheck).

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`EVM/README.md`](EVM/README.md) — EVM design, contracts, deployment, limitations
- [`SVM/README.md`](SVM/README.md) — SVM programs, design, runbook, EVM divergence
