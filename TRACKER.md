# okuMoney Contracts Tracker

Open issues + follow-ups for the okuMoney on-chain stack (EVM + SVM).
Scope is on-chain code; operational items (key custody, monitoring,
incident response) are tracked separately by the operator team and
intentionally excluded from this file. Resolved items are removed;
full history lives in git and in each side's README (see "Accepted
Risks" in `EVM/README.md` / `SVM/README.md`).

**Status legend:** 🔴 blocks external exposure · 🟡 should-fix before audit · ⚪ post-launch

**Tag legend:** `[EVM]` `[SVM]` `[both]`

The goal is to clear every item before audit. This file should be
removable post-launch.

---

## Recently completed — continuous yield epochs `[EVM]`

Context for anyone picking this up mid-stream. The EVM side replaced
OkuMoney's discrete multiplier with continuous epoch accrual, added
ERC-8056, and removed the redemption queue.

**Why.** `okuMMultiplier` is the settlement price for instant, two-way
convertibility at the PSM. A discrete jump in a settlement price is
riskless arbitrage — mint immediately before the step, redeem
immediately after, capture the whole increment with no holding period,
funded from the PSM buffer and diluting honest holders. At $1M TVL /
5% APR / 30-day steps that was worth ~$2,055 per event (~$25k/yr, up
to half of all yield).

The old `YieldSandwichGuard` did **not** close it: it compared
`block.number` against a flag written *inside* `distributeYield`, so a
mint ordered *before* the step in the same block passed, and the
redeem waited for the next block. It was a backrun guard, not a
frontrun guard, and the profitable round trip spans two blocks.

**Measured result** (`EVM/test/token/YieldSandwich.t.sol`): the same
attack sequence now nets **$0.0095** instead of **$2,055** — a
216,000× reduction — and that residual exactly matches the honest
12-second pro-rata share.

**Shipped:**

- `OkuMoney`: linear `YieldEpoch` accrual; `startYieldEpoch`,
  `scheduleYieldEpoch`, `cancelPendingYieldEpoch`, `haltAccrual`,
  `resumeAccrual`; `okuMMultiplierAt(t)` projection.
- Removed `setOkuMMultiplier`, `distributeYield`,
  `lastYieldDistributionBlock`, and `lib/YieldSandwichGuard.sol`.
- ERC-8056 core + all three extensions, ERC-165 detection, IDs
  asserted against the published EIP literals.
- `RedemptionQueue` deleted; redemption is buffer-only (`InsufficientBuffer`),
  matching SVM.
- Operator scripts: `startYieldEpoch.ts`, `manageYieldEpoch.ts`
  (replacing `distributeYield.ts`, `processQueue.ts`,
  `rescueQueueEntry.ts`).

**Gates:** 503/503 forge · 27/27 hardhat · 98.06% line coverage ·
`tsc` clean · `forge fmt` clean.

**Deployment consequence (out of scope for this cycle, flagged for
whoever picks it up):** the change is **layout-breaking**.
`OkuMoneyStorage` dropped `okuMMultiplier` and
`lastYieldDistributionBlock` and added `currentEpoch` / `pendingEpoch`
/ `accrualHalted`; `LitePSMStorage` dropped `redemptionQueue`. Existing
proxies cannot be upgraded in place — bump `DEPLOYMENT_VERSION` and
deploy fresh.

Note also that `scripts/upgrade/checkLayout.ts` reports `COMPATIBLE`
for these contracts regardless, because all state lives in ERC-7201
namespaced structs that the OZ validator cannot see. It is not a
safety net for namespaced storage; changes inside a `*Storage` struct
need manual review.

---

## 🟡 Should-fix before external audit

### SVM still uses a discrete multiplier `[SVM]`

**This is now the largest EVM/SVM divergence.** `set_multiplier()` /
`distribute_yield()` on lite-psm still write the multiplier as a
discrete step, protected only by the single-slot fence
(`last_yield_distribution_slot`).

That fence has the same structural limitation the EVM one had: it
blocks the atomic same-slot round trip but not the cross-slot version
(position before the update slot, exit after). SVM therefore still
carries the step-arbitrage exposure EVM has eliminated, scaling
linearly with SVM-side TVL.

Porting the epoch model is not a direct copy — Token-2022's
`ScaledUiAmountConfig` is a two-point step (`multiplier`,
`new_multiplier`, `new_multiplier_effective_timestamp`) with **no rate
field**, so a continuous segment cannot live in the extension. The
likely shape is a hybrid: an integer settlement segment in
`PsmConfig` that all `read_multiplier` call sites resolve against,
with the extension refreshed periodically for **display only** via
`UpdateMultiplier`'s existing `effective_timestamp`.

**Prerequisite:** this cannot be validated in the current dev
environment — `anchor 1.0.2` requires GLIBC ≥ 2.39 and the build host
has 2.35. `cargo test --workspace` works; `anchor build`, bankrun and
IDL regeneration do not.

**Decision needed before starting:** whether SVM should match EVM's
continuous model, or whether the SVM deployment is small enough that
the step exposure is accepted and documented instead.

### SVM devnet needs a fresh re-deploy (not an in-place upgrade) `[SVM]`

The program builds and passes all tests, but **the devnet program has
not been rebuilt/redeployed** against the current source. On-chain state
is out of scope for review/audit; the internal devnet instance should
eventually be refreshed for testing. An in-place BPF upgrade is **not**
sufficient — the config PDA seed is `psm_config`, so if any prior devnet
deploy used a different seed a fresh deploy (new PDA + mint) is required.

Notable deployed-surface facts vs. any older devnet build:

- Config PDA seed is `psm_config`.
- USDC transfers use `transfer_checked` (mint + decimals validated).
- Error enum includes `ZeroOutput`, `SlippageExceeded`,
  `MultiplierUnpackFailed`, `ScaledUiExtensionMissing`,
  `MultiplierOutOfRange`.
- `update_token_metadata` instruction is present.

**Follow-up required before this can be closed:** rebuild, deploy fresh
to devnet (new PDA + mint), re-verify with the bankrun/devnet suites,
then mainnet-beta following the testnet-then-mainnet posture.

### SVM test harness does not pass `tsc --noEmit` `[SVM]`

`npx tsc --noEmit` reports type errors across the bankrun test files
(`Program<LitePsm>` vs `Program<Idl>` generic-variance around
`addEventListener`). Harmless — the suite runs via `tsx` (no type-check)
and all bankrun tests pass — but a fully polished project would type-
check clean. Fix with a targeted cast/typing shim in the harness.

**Note:** the error count previously recorded here (~35) was measured
against a **stale local `target/idl/lite_psm.json`** still declaring
removed instructions. `target/` is gitignored, so the true count
against a fresh build is unknown until the GLIBC blocker above is
resolved.

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/`
package) was removed. If a static-analysis gate is wanted for the audit,
re-introduce a lint runner (dylint or an alternative) in CI.

---

## ⚪ Post-launch / low priority

### Epoch-boundary monitoring is operator-owned `[EVM]`

Accrual **flatlines silently** past `yieldEpochEndsAt()` when no
successor is scheduled. This is the correct safe default — never
extrapolate unearned yield — but it emits no event, so a missed
renewal simply stops yield with no on-chain signal.

`manageYieldEpoch.ts --action status` warns when accrual has
flatlined. A production monitor should alert on
`yieldEpochEndsAt()` approaching, not just passing.

Considered and rejected: an on-chain "epoch expiring" event (cannot be
emitted without a keeper) and auto-rollover of the previous rate
(would distribute unearned yield — exactly what flatlining prevents).

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Two-chain Foundry invariant harness `[EVM]`

Extend the existing `LitePSMHandler` / `OkuDollarHandler` stateful-fuzz
harness to model a second simultaneous `chainB` LitePSM and randomly
bridge between them. Surfaces cross-chain accounting bugs that
scripted scenarios miss.

**Effort:** 1–2 weeks.

### Cross-process E2E test `[both]`

Forked EVM (anvil) + bankrun SVM + actual orchestrator process
between them. Better suited as nightly CI than per-PR.

**Effort:** 2–3 weeks.

### Audit-attention surfaces `[both]`

Informational only — no functional issue, just where reviewer time
will concentrate:

- **EVM `OkuMoney` epoch resolution** (`_resolveEpoch` /
  `_multiplierAt` / `_deriveEpochRate`) is the highest-consequence
  code in the EVM suite: every economic surface prices off it, and
  the APR cap is the only on-chain bound on a mispriced rate. The
  arithmetic is deliberately linear and integer-only, and overflow
  headroom was checked at ~10³⁰ against `MAX_MULTIPLIER` over a
  century, but this is where review time is best spent.
- **SVM manual Token-2022 mint construction in `initialize`**
  (`instructions/init.rs`) is the highest-complexity code in the crate:
  extension-length math, a two-step `CreateAccount`, and four raw
  `invoke`/`invoke_signed` calls. Correct and well-commented as
  written; flagged for focused audit attention rather than as a
  defect.
- **SVM `f64` multiplier round-trip** (`helpers/scaled_ui.rs`,
  `instructions/yield_ops.rs`) is the most numerically-sensitive path:
  the `u64 → f64 → u64` conversion is exact only under the compile-time
  `MAX_MULTIPLIER < 2^52` assertion, and `read_multiplier` re-implements
  effective-multiplier selection to work around the Token-2022 zero-init
  edge case. Carries an in-code `AUDITOR ATTENTION` block.
- **EVM `LitePSM._redeemOkuMShared`** is a single function serving
  multiple call shapes via a `bool okuMAtPsm` flag that toggles both
  the token-pull and the event emission. Simpler since the queue
  branch was removed, but still the densest control flow in the PSM.

### Operator CLI gaps `[both]`

Still missing CLIs — defer until post-audit when the function
kill-list is finalised:

**EVM:**

- `setNextUsdYieldRate` — schedules a future OkuDollar rate;
  `setUsdYieldRate` covers the immediate-effect case. Add only if the
  schedule-ahead flow becomes part of the runbook. (The OkuMoney
  equivalent, `scheduleYieldEpoch`, IS covered by
  `manageYieldEpoch.ts`.)

**SVM:**

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the
  two-step `role_admin` transfer's second step happens once per
  rotation by the cold multisig via Squads; a documented IDL call in
  the runbook is sufficient. Build CLIs only if the runbook requires
  them.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, accepted risks)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence, accepted risks)
