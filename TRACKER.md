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
| `forge build` | pass — **zero lint warnings in `src/`** |
| `forge test` | **102 passing** across 7 suites |
| `forge coverage` | **100% line, 100% function** on `src/` (554/554 lines) |
| `npx tsc --noEmit` | pass |
| `npx hardhat compile` | pass |
| `npm run upgrade:validate` | pass — all 3 impls UUPS-safe with ERC-7201 storage |
| Fork deploy + 11-step lifecycle | pass |

| Suite | Tests | Covers |
|---|---|---|
| `Differential.t.sol` | 5 | The two load-bearing proofs |
| `SystemInvariants.t.sol` | 10 | 128k calls each, adversarial handler |
| `OkuM.t.sol` | 23 | ERC-8056 conformance, rate bounds, halt, closed-window rule |
| `LitePSM.t.sol` | 17 | Buffer bound, the two gates, pricing, deploy guards |
| `Coverage.t.sol` | 21 | Accessors, admin paths, defensive branches |
| `MathLib.t.sol` | 16 | Rounding, `rpow` branches, `compound` determinism |
| `USDOku.t.sol` | 10 | `M_oku`-only exchange rate, pre-funding, rebasing ledger |

**Assurance is verified, not asserted.** Both differential proofs were confirmed
lethal by sabotaging the contract — stepping `indexAt` breaks the no-arbitrage
test; anchoring the segment to `block.timestamp` breaks the multichain determinism
test. USDOku's two were confirmed the same way. The invariants are
*probe-verified*: temporary inverted assertions confirmed the fuzzer reaches
non-degenerate states rather than no-oping through the handler's `try/catch`.

### SVM

Unchanged on this branch. Still on the discrete-multiplier model — see
[SVM must be brought up to this spec](#svm-must-be-brought-up-to-this-spec-svm),
which is the largest single open item in this file.

---

## 🔴 Blocks external exposure

**None.** The EVM side is feature-complete and green against every gate. The items
below are calibration, parity, and polish rather than blockers.

---

## 🟡 Should-fix before external audit

### `master` should be marked retired, not deployed `[EVM]`

`master` is the previous generation and carries **three live defects** that this
branch exists to fix. It should be tagged retired so nobody deploys from it:

1. **No step-arbitrage defence and no fees.** `okuMMultiplier` moves as a discrete
   instantaneous step with no per-step size limit — a single call may legally jump
   1x to 1,000,000x. The only guard is `YieldSandwichGuard`, a strict same-block
   `block.number` equality check. Mint in block N−1, step in N, redeem in N+1 is
   free money, and the PSM charges nothing on any of its four paths (`tin`/`tout`
   appear only in MakerDAO comments).
2. **No cross-chain sync of any kind.** Ten chains are configured and the
   multiplier is set per-chain by an off-chain orchestrator with no coordination
   primitive, so every mark opens a propagation window during which one chain has
   stepped and another has not.
3. **Redemption has one coarse lever.** `pause()` gates mint, redeem *and*
   `processQueue` together, so halting an outflow also freezes payouts to everyone
   already queued. Mint is capped twice (`maxSupply` + `minterAllowance`); burn is
   capped zero times.

Not actionable as code — the branch is superseded — but worth an explicit tag and
a note in the README so the state is deliberate rather than ambient.

### SVM must be brought up to this spec `[SVM]`

**The two sides are now materially divergent.** EVM has moved to continuous,
time-anchored accrual; SVM still models a discrete multiplier written per-chain by
the orchestrator. Until SVM follows, the multichain synchronisation property holds
across the EVM deployments only, and an SVM/EVM pair retains the same propagation
window the EVM side just eliminated.

Required for parity:

- Replace the discrete multiplier write with a `(baseIndex, ratePerSecond,
  startTime, endTime)` segment and per-second compounding.
- Anchor to absolute wall-clock time, never to the slot clock at write time. This
  is the whole property: identical parameters must give an identical multiplier.
- Match the bounds exactly — `MAX_IMPLIED_APR_BPS`, `MAX_RATE_DURATION`,
  `MAX_REANCHOR_BPS`, `MAX_SCHEDULE_LEAD` — scaled for SVM's 1e9 precision.
- Mirror flatline-on-expiry.
- Add the closed-window precondition on the rate instruction.

**Numeric risk worth calling out early:** SVM's scaled-UI path round-trips the
multiplier through `f64` (`helpers/scaled_ui.rs`), exact only under the
`MAX_MULTIPLIER < 2^52` assertion. Per-second compounding evaluated in `f64` will
**not** reproduce EVM's integer `rpow` bit-for-bit, and cross-chain determinism
requires exactly that. SVM needs an integer `rpow` equivalent, not a float one.

**Effort:** meaningful. Treat as its own cycle, not a follow-up.

### `MAX_IMPLIED_APR_BPS` and `MAX_RATE_DURATION` need real numbers `[EVM]`

`1000` bps and `30 days` are placeholders inherited from the previous design. They
are load-bearing here in a way they were not before: together with
flatline-on-expiry they are the **only** on-chain bound on OkuM paying out yield
that has not been realized, because off-chain RWA backing cannot be verified
on-chain.

Worst case from a fully compromised rate setter is `cap_APR x one window`. Pick
both against the actual product, then state the resulting worst case in
`EVM/README.md` as a **number**, not a property.

### Confirm `MAX_REANCHOR_BPS` against real operator latency `[EVM]`

Ships at `10` (0.1%), permitting roughly a week of catch-up at 5% APR while
capping any single step at 0.1%. It is the bound that makes "no step arbitrage" a
**contract-enforced** property rather than a procedural one — even a fully
compromised `OKUM_RATE_SETTER` cannot manufacture a larger step.

Too tight and a chain that misses a segment cannot be restored without an
intermediate catch-up segment; too loose and it becomes a usable step. Measure the
real worst-case gap between the orchestrator publishing to its first chain and its
last, then set this to a small multiple of that.

### `wrap` can revert because of issuer behaviour `[EVM]`

`USDOku.wrap` is permissionless but gated on the **forward** solvency projection,
so it reverts `WouldBreachBacking` when the issuer has not funded headroom for new
entrants. A user is refused for reasons that are not their own.

The alternative — admitting the entrant and letting them dilute existing holders'
coverage — is worse, so the gate stays. But the failure needs a real error message
in the app, and the runbook needs a "fund the vault before marketing USDOku" step.
The underlying hole was originally found by stateful fuzzing at ~0.0072% on ~353k,
not by inspection.

### ERC-8056 conformance: continuous drift vs. the event requirement `[EVM]`

`uiMultiplier()` changes every second while `UIMultiplierUpdated` fires only on
declaration. The EIP says the event MUST be emitted "whenever the multiplier is
changed", and also that "how the multiplier is updated is an implementation detail
left to the token issuer" — the two pull in opposite directions for a
continuously-accruing token, which the stock-split motivation did not anticipate.

Our position: the event marks a change of **schedule**, and drift between
declarations is the schedule executing, not a change. A consumer caching on the
event under-displays; the value is monotonic so staleness always understates,
never overstates.

Worth raising upstream — we hold an unusually clear motivating case, a two-index
yield-bearing ERC-8056 deployment, which is a shape the authors have not seen.

### SVM devnet needs a fresh re-deploy (not an in-place upgrade) `[SVM]`

The program builds and passes all tests, but **the devnet program has not been
rebuilt/redeployed** against the current source. An in-place BPF upgrade is **not**
sufficient — the config PDA seed is `psm_config`, so if any prior devnet deploy
used a different seed a fresh deploy (new PDA + mint) is required.

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

### SVM test harness does not pass `tsc --noEmit` `[SVM]`

`npx tsc --noEmit` reports **35 type errors** (re-counted on this branch) across
the bankrun test files — `Program<LitePsm>` vs `Program<Idl>` generic variance
around `addEventListener`. Harmless in practice, since the suite runs via `tsx`
with no type-check, but a polished project type-checks clean. Fix with a targeted
cast/typing shim in the harness.

> The SVM suite itself was **not re-run on this branch** — no SVM source changed
> here. Re-verify it as part of the segment rework above rather than assuming the
> last-known-good result still holds.

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

### Multichain orchestration wrapper `[EVM]`

`setOkuMRate.ts` prints the exact parameter tuple to reuse per chain and refuses
to re-derive `baseIndex`, but the operator still runs it once per network by hand.
A driver that fans the identical segment out to all ten and then asserts
`indexAt(t)` agrees everywhere would turn the synchronisation property from a
**procedure** into a **checked post-condition**.

This is the highest-value remaining EVM tooling item — it closes the gap between
"the contracts make sync possible" and "sync is verified after every publication".

### Two-chain Foundry invariant harness `[EVM]`

Extend `SystemHandler` to model a second simultaneous deployment and assert
`indexAt(t)` agreement under adversarial interleaving — segments landing out of
order, one chain missing a segment entirely, catch-up at the `MAX_REANCHOR_BPS`
boundary. `Differential.t.sol` proves the property for scripted sequences; this
would prove it for arbitrary ones.

**Effort:** ~1 week (smaller than the previous estimate — there is no bridge to
model, only shared segment parameters).

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
- **EVM `OkuM.setOkuMRate`** — the single highest-value entry point. It sets the
  price every permissionless conversion executes at, on every chain. The
  continuity and re-anchor checks are what bound a compromised key to 10 bps.
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
  zero-init edge case. Carries an in-code `AUDITOR ATTENTION` block.

### Operator CLI gaps `[SVM]`

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the two-step
  `role_admin` transfer's second step happens once per rotation by the cold
  multisig via Squads; a documented IDL call in the runbook is sufficient. Build
  CLIs only if the runbook requires them.

---

## Next steps

In order. The first three are decisions rather than code, and they gate the rest.

1. **Set `MAX_IMPLIED_APR_BPS` and `MAX_RATE_DURATION`.** Product decision. These
   define the worst-case unrealized-yield exposure, which should be a stated
   number before anyone reviews the design.
2. **Set `MAX_REANCHOR_BPS`** from measured orchestrator latency across all ten
   chains.
3. **Tag `master` retired** so the three live defects above cannot be deployed by
   accident.
4. **SVM segment rework** — the largest item, and the one that makes the
   multichain property true rather than EVM-only.
5. **SVM devnet redeploy**, sequenced after (4).
6. **Multichain orchestration wrapper** — turns synchronisation into a checked
   post-condition.
7. **Audit.**

Not on the critical path but cheap and worth doing alongside: the `wrap` revert
message in the app, and the SVM test-harness `tsc` shim.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`EVM/README.md`](EVM/README.md) — EVM design, contracts, deployment, limitations
- [`SVM/README.md`](SVM/README.md) — SVM programs, design, runbook, EVM divergence
