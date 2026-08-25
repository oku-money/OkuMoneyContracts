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

## 🔴 Blocks external exposure

### Multiplier-arbitrage parameters must be chosen `[both]`

The mechanisms are built, enforced and tested. What is **not** decided is the
numbers they are configured with. Read
[`SVM/README.md § Fees`](SVM/README.md) for the invariant these feed.

| Parameter | Ships as | Needs |
|---|---|---|
| SVM rebase **cadence** | undecided | The driver for everything below |
| `tout_bps` | **0** (fail-closed) | > one step's yield. ~2 bps daily, >10 bps weekly at 5% APY |
| `tin_bps` | 0 | A product decision; not required for safety |
| `sync_window_secs` / `syncWindowDuration` | 60 s | Confirm 60 s is the right propagation budget for the intended chain set |
| `MAX_SYNC_WINDOW` / `MIN_SYNC_WINDOW_GAP` | 15 min / 6 h | Round placeholders. Give a ≥96% availability floor (asserted in `SyncWindowTest.test_Gap_AvailabilityFloorHolds` and `oku-shared::sync_window::availability_floor_holds`). The gap caps tick cadence at one per 6 h |
| `MAX_FEE_BPS` | 100 (1%) | Confirm 1% is an acceptable worst-case haircut |

**`tout = 0` means the protocol cannot rebase at all.** `step_is_covered`
rejects every multiplier increase while no fee is configured, so this is
fail-closed and cannot be silently forgotten — but it does mean **yield does not
accrue on SVM until `tout` is set**. That is the launch-blocking edge.

**Derived constraint, needs sign-off:** `step ≤ tout ≤ MAX_FEE_BPS` caps a single
multiplier step at 1% — roughly 73 days of yield at 5% APY. This implies a
**minimum cadence**: a longer outage cannot be caught up in one write and must be
walked over several ticks, each needing its own window spaced by
`MIN_SYNC_WINDOW_GAP`. Direct analogue of the existing `MAX_IMPLIED_APR`
catch-up limitation on EVM.

**Historical correction worth keeping.** An earlier version of this file said the
multiplier skew "is not user-exploitable because bridging is orchestrator-mediated".
That was true only of the *cross-chain* surface. The *local* SVM surface — mint
before a step, redeem after — needed no bridge, was fully permissionless, and the
pre-existing same-slot fence does not prevent it (mint at slot `N-1`, step at `N`,
redeem at `N+1`). That surface is what `tout` closes.

---

## 🟡 Should-fix before external audit

### Multiplier-arbitrage follow-ups `[both]`

- **`reset_step_high_water_mark` is an un-modelled trust surface `[SVM]`.**
  Cold-multisig only, deliberately separate from `set_fees`, and emits
  `StepHighWaterMarkReset` — but it clears the floor under `tout` and reopens
  historical step exposure. Its honest precondition (that supply outstanding at
  the time of the large step has substantially turned over) is **not verifiable
  on-chain** — the contract can only make the action deliberate and loud, not
  safe. Decide whether that is acceptable or whether the escape hatch should be
  removed entirely (accepting that a one-off large step then pins the fee
  permanently). The corresponding alarm and runbook entry are the operator
  team's, per this file's scope note.

- **Cross-chain *value* equality is not proven `[both]`.** `end_sync_window`
  requires that a multiplier write landed in the epoch, so equal epochs mean
  *both chains wrote for tick N*. They do **not** mean both wrote the **same
  value** — a wrong-value write is undetectable on-chain and must be reconciled
  against the intended rate off-chain. Inherent: neither chain can observe the
  other, and there is no bridge, oracle or messaging between them.
  `check-sync-parity.ts` detects epoch divergence, not value divergence.

- **Kani proofs are not run in CI `[SVM]`.** `crates/oku-shared/src/step_coverage.rs`
  carries `proof_covered_step_is_never_profitable` (the formal statement of the
  whole step-arbitrage defence), plus `proof_zero_fee_admits_no_step` and
  `proof_mark_never_exceeds_permitting_fee`; `math.rs` carries three more. They
  are `#[cfg(kani)]` and only run under `cargo kani`, which **no CI job
  invokes**. The properties are also covered by ordinary unit tests, so this is a
  strengthening rather than a gap — but a proof nobody runs will rot.

- **`PsmConfig` grew to 618 bytes.** Pinned by the compile-time assert in
  `state.rs`. Makes the fresh devnet redeploy below **mandatory** rather than
  merely advisable — see that section for the full deployed-surface delta.

- **EVM `initialize` grants `OKU_MINTER` / `OKU_BURNER` to `_admin` `[EVM]`.**
  Privilege residue, not an arbitrage vector: `mint` is defused by
  `minterAllowance` defaulting to 0, and `burn` only destroys the caller's own
  balance. But the deploy admin retains a live `OKU_BURNER` until revoked, and
  the "contract-only" property is currently enforced by an assertion in
  `grantRolesMainnet.ts` rather than by the contract. Consider dropping both
  grants from `initialize`, mirroring how `QUEUE_PSM` is deliberately granted
  post-deploy.

- **No CI drift check on `artifacts/svm/` `[SVM]`.** `artifacts/evm/` is gated
  (`.github/workflows/test.yml`), so a stale EVM ABI fails the build. The SVM IDL
  has no equivalent, and it now changes on every instruction or `PsmConfig`
  edit — easy to forget after `anchor build`.

### v0.3 single-token refactor — follow-ups `[EVM]`

The EVM side was refactored from the dual-token split economy to a single
ERC-8056 token (`OkuDollar` / `rUSDOku`). Contracts, tests, scripts and docs are
done; these items are outstanding.

- **`MAX_IMPLIED_APR` is a placeholder.** Currently 1000 bps nominal. This is the
  bound doing most of the work in the compromised-setter story, and it needs a
  real number from treasury rather than a round one. Paired with
  `MAX_RATE_DURATION = 30 days` it caps worst-case over-accrual at ~0.82% per
  segment.
- **ERC-7730 deployment addresses are zero-filled.** `EVM/metadata/erc7730/*.json`
  carry the full field-label metadata but placeholder addresses. Fill them in
  after the first `v0.3` deploy and submit to the Ledger registry.
  **This is a launch blocker** — Ledger and Trezor render raw calldata, so without
  it the app says "$1,050" while the device says "1,000".
- **Client SDK not built.** `EVM/metadata/DISPLAY_CONVENTION.md` specifies the
  required API shape (`getDisplayBalance`, `getMaxSendRaw` with no inverse,
  `allowanceUI`). The contract-side surface it needs is complete and shipped.
- **Reference AMM + lending integrations not built.** Rate-aware pools only —
  a naive constant-product pair against USDC leaks the entire accrual rate to
  arbitrageurs.
- **Listings communications.** Neither number is a $1 unit price. What goes to
  CoinGecko / CMC / exchange listing teams, and whether the ticker changes, must
  land before launch.
- **`MathLib.rpow` has one uncovered assembly branch.** The `zx` overflow revert
  inside the squaring loop. Assembly branch coverage is unreliable and the branch
  requires a very specific overflow shape; left uncovered deliberately rather
  than chased with a contrived harness. `src/lib/MathLib.sol` is at 96.67% lines,
  above the 95% CI gate.

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
- **`PsmConfig` is 618 bytes** (was 562, then 602). Adds the sync-window fields
  (`sync_lock_until_ts`, `sync_epoch`, `last_write_epoch`, `sync_window_secs`)
  and the fee / step-coverage fields (`tin_bps`, `tout_bps`, `max_step_bps`).
  A size change alone makes a fresh deploy mandatory.
- New instructions: `begin_sync_window`, `end_sync_window`,
  `set_sync_window_secs`, `set_fees`, `reset_step_high_water_mark`.
- New error variants appended (codes 6026-6033): `SyncWindowActive`,
  `SyncWindowGapNotElapsed`, `EpochMismatch`, `SyncWindowTooLong`,
  `FeeAboveMax`, `StepExceedsFeeCoverage`, `FeeBelowStepHighWaterMark`,
  `NoWriteInEpoch`. Appended deliberately so existing codes did not shift.

**Follow-up required before this can be closed:** rebuild, deploy fresh
to devnet (new PDA + mint), re-verify with the bankrun/devnet suites,
then mainnet-beta following the testnet-then-mainnet posture.

### SVM test harness does not pass `tsc --noEmit` `[SVM]`

`npx tsc --noEmit` reports ~35 type errors across the bankrun test files
(`Program<LitePsm>` vs `Program<Idl>` generic-variance around
`addEventListener`). Harmless — the suite runs via `tsx` (no type-check)
and all 128 bankrun tests pass — but a fully polished project would type-
check clean. Fix with a targeted cast/typing shim in the harness.

Note the new files added by the arbitrage work (`tests/shared/multiplier.ts`,
`tests/bankrun/sync-window-and-fees.ts`) and the four new admin CLIs do type-check
clean; the pre-existing variance issue is unchanged.

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/`
package) was removed. If a static-analysis gate is wanted for the audit,
re-introduce a lint runner (dylint or an alternative) in CI.

---

## ⚪ Post-launch / low priority

### `RedemptionQueue.QueueEntry` storage packing `[EVM]`

**Still open, deliberately not bundled with the fee work.** The `tout` snapshot
added for per-entry fee pinning is a `uint16` declared immediately after `user`,
so it occupies the 96 free bits already in that slot and costs nothing — the entry
is still three slots. The packing optimisation below is independent, carries its
own ceiling caveat, and was left alone rather than folded into a change it has
nothing to do with.

Currently three `uint256` fields per entry = three storage slots.
`address user` (160 bits) + `uint96 rawAmount` + `uint48 timestamp` would pack
into two, saving ~20k gas per `enqueue`.

**The v0.2 caution no longer applies.** That entry said "storage-layout change
on a UUPS proxy — defer to v2". v0.3 is a *fresh* CREATE2 deploy with no live
state, so this is free to do right now and progressively more expensive after
the first mainnet deploy. If it is wanted, do it before `v0.3` ships.

**Caveat on the width.** `uint96` maxes at ~7.9e28, which comfortably holds any
entry under the 1e9-token deploy cap (1e27 raw) but does **not** hold
`Constants.MAX_TOTAL_SUPPLY` (1e33). Packing therefore introduces a real ceiling
on a single queue entry that the current `uint256` does not have. Either accept
it and enforce a matching bound in `enqueue`, or use `uint128`
(still packs to two slots with `address` + `uint48` spilling one word).

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Two-chain Foundry invariant harness `[EVM]`

Extend the v0.3 `SystemHandler` stateful-fuzz harness to model a second
simultaneous `chainB` LitePSM and randomly bridge between them. Surfaces
cross-chain accounting bugs that scripted scenarios miss — including the
EVM-continuous vs SVM-stepwise multiplier skew, which is currently only
reasoned about rather than fuzzed.

**Effort:** 1–2 weeks.

### Fork tests against real integrations `[EVM]`

The Hardhat suite covers the upgrade path and month-scale scenarios against a
freshly-deployed system, plus low/high-multiplier behaviour. What it does not
cover is *real* third-party integrations on a fork — a Curve pool with
`uiMultiplier()` as the rate provider, or a lending market pricing off
`OkuMultiplierAdapter`. Those tests can only be written once the reference
integrations exist (see the launch-blocker list above), and they are the only
way to catch an integration that silently assumes `multiplier == 1e18`.

### Cross-process E2E test `[both]`

Forked EVM (anvil) + bankrun SVM + actual orchestrator process
between them. Better suited as nightly CI than per-PR.

**Effort:** 2–3 weeks.

### Audit-attention surfaces `[both]`

Informational only — no functional issue, just where reviewer time
will concentrate:

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
- **EVM `RedemptionQueue.processQueue`** (`RedemptionQueue.sol`) is now the
  densest control flow in the EVM suite: three distinct soft-skip paths
  (`AlreadyCleared` / `InsufficientFunds` / `TransferFailed`), a
  break-vs-continue distinction that preserves FIFO fairness, a
  per-batch multiplier cache, and a hand-rolled `_trySafeTransferFrom`
  handling all three non-conforming ERC-20 shapes. Covered by
  `RedemptionQueueTest`; flagged for focused review, not as a defect.
- **EVM `ScaledUIAmountUpgradeable`** is small but sits on every pricing
  path, and its reading of the ERC-8056 pending-multiplier extension
  (`effectiveAt` == `rateEnd`, `newUIMultiplier` == the terminal value of
  the current rate segment) diverges from the EIP's step-function intent.
  Held at 100% line coverage by a CI gate. See open question 1 in
  `EVM/README.md`.

### Operator CLI gaps `[both]`

Still missing CLIs — defer until post-audit when the function
kill-list is finalised:

**EVM:**

- `sweepToken` (LitePSM) / `sweepExcess` (RedemptionQueue) — recover tokens
  donated to either contract. Both are role-gated and provably cannot touch
  user escrow or the USDC buffer, so a documented ABI call is sufficient
  until a donation actually happens. No CLI yet.

**SVM:**

- `accept-role-admin.ts`, `cancel-role-admin-transfer.ts` — the
  two-step `role_admin` transfer's second step happens once per
  rotation by the cold multisig via Squads; a documented IDL call in
  the runbook is sufficient. Build CLIs only if the runbook requires
  them.
- `reset-step-high-water-mark.ts` — no CLI. Deliberate for now: the action
  reopens historical step exposure and should be a considered, one-off cold
  multisig call rather than something with a convenient wrapper. Revisit only
  if the runbook ends up needing it regularly, which would itself be a smell.

**Shipped by the arbitrage work** (listed so the gap analysis above stays
honest): EVM `beginSyncWindow.ts`, `endSyncWindow.ts`,
`setSyncWindowDuration.ts`, `setFees.ts`; SVM `sync-window.ts`,
`set-sync-window-secs.ts`, `set-fees.ts`, `check-sync-parity.ts`. The
pre-existing `pause.ts` / `unpause.ts` `--target` bug (documented
`okuM|usdOku`, only `token|psm` accepted) was fixed at the same time.

---

## Decisions log — multiplier-arbitrage protection

Recorded because several of these are counter-intuitive, and re-deriving them
from the code alone would be slow. Each is a *closed* decision; reopen only with
the reasoning below in hand.

**Two harms, two mechanisms, no substitution.** Cross-chain divergence needs a
*window* (profit requires transacting while chains disagree). Local step
arbitrage needs a *fee* (profit requires holding across a step, which needs no
transaction during any window). Widening the window does nothing for the second;
raising the fee does nothing for the first. Conflating them was the single
biggest error during design and is why both READMEs say so explicitly.

**A time-based cooldown on `tout` decreases was rejected.** It looks like the
obvious way to stop "raise tout → big step → lower tout", and it does not work:
the attacker's edge is locked in the instant the step lands and never decays, and
the multiplier is monotonic so waiting through a cooldown costs them nothing. A
cooldown delays profit rather than removing it. The `max_step_bps` high-water mark
has no expiry, and is *less* restrictive in the common case — it pins only
against steps actually taken, so an all-1.4 bps history still permits lowering
`tout` to 1.4 bps.

**The gating rule is "can this move value across a multiplier boundary", not
"does this price locally".** The weaker phrasing wrongly exempted the SVM direct
bridge legs: neither prices on its own, but burning 100 raw at `M=1.04` while
minting 100 raw at `M=1.05` conjures a dollar. Raw-conserving is a property of
one leg that does not survive both.

**The epoch-to-write binding is SVM-only.** EVM accrues continuously and has
nothing to land per tick; its role in a window is to hold still while SVM catches
up. Requiring an EVM write per tick would be artificial ceremony.

**`tout` on EVM is parity-only.** Continuous accrual means no discrete step to
hold across, so the step-coverage invariant is not enforced there and there is no
`MAX_FEE_BPS`-derived minimum cadence on that side. The parameter exists so the
fee schedule, runbook and monitoring stay symmetric.

**Token-2022's scheduled multiplier (`new_multiplier_effective_timestamp`) was
considered and dropped.** Pre-announcing the step makes it *predictable* but not
*smaller*, so it reduces arbitrage profit by zero — that is `tout`'s job
regardless of timing. Meanwhile it adds a second timing parameter to align across
chains and decouples "the write landed" from "the price changed", which is the
exact ambiguity the window exists to remove. Writes stay immediate
(`effective_timestamp = 0`); rationale is in `yield_ops.rs`.

**`PSM_FEE_MANAGER` exists as a distinct constant, not a reuse of
`OKU_CAP_MANAGER`.** Intended for the same cold key — a fee schedule is economic
policy of the same class as a supply cap — but AccessControl mappings are
per-contract, and gating a PSM function on a role whose name reads as a token
role would defeat the `OKU_`/`PSM_`/`QUEUE_` prefix convention. Same key,
correctly-scoped capability. No other new roles were added: window control reuses
`OKU_RATE_SETTER` / `rebaser`.

**`haltAccrual` deliberately does not arm a window.** `OKU_GUARDIAN` is warm and
justified as withhold-only; arming would hand that key a repeatable mint/redeem
block the RBAC model denies it. Halting also lowers no trajectory that could
desync a peer chain upward, so there is nothing to fence.

**A window inside the inter-window gap clamps rather than reverts.** A multiplier
write must never be rejectable on window state, or anyone able to open a window
could censor the rate setter — `setYieldRate` is deliberately un-gated so an
operator can zero the rate during an incident. The gap bound still holds: a
caller looping the write gets at most one window per gap period.

**`OkuMultiplierAdapter.isHealthy()` was deliberately left unchanged.** The
multiplier is genuinely correct during a sync window; the window holds EVM still
while a peer catches up, it does not indicate a bad price. Marking the feed
unhealthy would trigger needless liquidation pauses on an accurate price. The
narrower fact — that a position cannot be unwound through the PSM for at most
`MAX_SYNC_WINDOW` — is surfaced by the new `isSyncLocked()` passthrough instead.

**`getQueueEntryValue` is a conservative floor, not the exact settlement.**
Settlement charges `min(snapshot, live)` `tout`, but the view has no `msg.sender`
to read the live fee from, and storing a pointer back to the PSM would recreate
the circular deploy dependency that post-deploy `QUEUE_PSM` granting exists to
avoid. Erring low is the right direction for a quote.

**The `QueueEntry` slot-packing optimisation was NOT bundled with the fee work.**
The `tout` snapshot is a `uint16` after `user`, occupying the slot's existing free
bits at zero cost. The packing item is independent, carries its own `uint96`
ceiling caveat, and stays open below.

**Both mechanisms originally shipped inert; the window now ships ON.** Inert
defaults kept every pre-existing test green through the contract work, which is
how the change stayed reviewable. Once step coverage made `tout = 0` fail-closed,
a dormant window was the only remaining "protection that depends on someone
remembering", so `DEFAULT_SYNC_WINDOW(_SECS) = 60` is now written at
`initialize`.

**The invariant fuzz harness now advances `block.timestamp` ~12 s per action.**
It previously only moved time via its explicit `warp` action (~1 call in 17), so
short-lived time-based state behaved nothing like production — a window armed by
`setRate` stayed engaged for a dozen unrelated actions. With realistic block
progression the fuzzer runs against the **real deployed window default** instead
of needing it disabled, which is strictly better coverage than before this work.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook (incl. the
  three-step multiplier-tick protocol and its failure modes)
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, accepted risks)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence, accepted risks).
  The step-coverage invariant and its proof sketch live in § Fees.
