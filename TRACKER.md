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
[`SVM/README.md § Fees`](SVM/README.md) for the invariant these feed. Step
coverage is now the combined `tin_bps + tout_bps` on both chains (see the
Decisions log entry below), which changes the "needs" column for the fee pair.

| Parameter | Ships as | Needs |
|---|---|---|
| SVM rebase **cadence** | undecided | The driver for everything below |
| `tin_bps + tout_bps` (combined step coverage) | both **0** (fail-closed) | Combined must exceed one step's yield. ~2 bps daily, >10 bps weekly at 5% APY. Either `tin` or `tout` alone is no longer the right thing to reason about — it's the sum |
| `sync_window_secs` / `syncWindowDuration` | 60 s (ships **on**) | Confirm 60 s is the right propagation budget for the intended chain set |
| `MAX_SYNC_WINDOW` / `MIN_SYNC_WINDOW_GAP` | 15 min / 6 h | **Stale — see Decisions log.** `MIN_SYNC_WINDOW_GAP` no longer exists (the epoch protocol it gated was removed); `MAX_SYNC_WINDOW` (15 min fail-open expiry) still applies |
| `MAX_FEE_BPS` | 100 (1%) | Confirm 1% is an acceptable worst-case haircut. Also caps the coverable step size, i.e. sets the *minimum* `M_oku` mark cadence — see the placeholder-parameter coupling item below |

**`tin + tout = 0` means the protocol cannot rebase at all.** `step_is_covered`
rejects every multiplier increase while no combined fee is configured, so this
is fail-closed and cannot be silently forgotten — but it does mean **yield does
not accrue on SVM (or step on EVM's `OkuM`) until fees are set**. That is the
launch-blocking edge.

**Derived constraint, needs sign-off:** `step ≤ tin + tout ≤ MAX_FEE_BPS` caps a
single multiplier step at 1% — roughly 73 days of yield at 5% APY. This implies a
**minimum cadence**: a longer outage cannot be caught up in one write and must be
walked over several ticks. (The old `MIN_SYNC_WINDOW_GAP`-spaced-ticks framing no
longer applies — see Decisions log — ticks are now only rate-limited by how often
someone is willing to arm a window, not by an on-chain gap.) Direct analogue of
the existing `MAX_IMPLIED_APR` catch-up limitation on EVM.

**Historical correction worth keeping.** An earlier version of this file said the
multiplier skew "is not user-exploitable because bridging is orchestrator-mediated".
That was true only of the *cross-chain* surface. The *local* SVM surface — mint
before a step, redeem after — needed no bridge, was fully permissionless, and the
pre-existing same-slot fence does not prevent it (mint at slot `N-1`, step at `N`,
redeem at `N+1`). That surface is what `tin + tout` coverage closes.

### Placeholder treasury numbers are coupled, not independent `[EVM]`

`MAX_STEP_BPS`, `MAX_IMPLIED_APR`, `MAX_SOLVENCY_GAP_BPS` (all `EVM/src/lib/Constants.sol`)
and the SubscriptionModule `tin`/`tout` deploy defaults all interact and **must
be tuned together**. Per `Constants.sol`'s own comments:

- `MAX_SOLVENCY_GAP_BPS` is a **cumulative** ceiling on `USDOku`'s declared-vs-backed
  gap, not a per-write one. Worst-case over-accrual inside a single maximum-length
  rate segment (`MAX_IMPLIED_APR` over `MAX_RATE_DURATION` = 30 days) is ~79 bps —
  *below* the current 100 bps bound. So at current placeholder values, no single
  rate write starting from a zero gap can ever be refused; the bound only bites
  after several consecutive segments have out-run realized marks. Raise
  `MAX_SOLVENCY_GAP_BPS` above ~79 bps and it stops being able to catch even a
  *single* pathological write — it becomes purely a multi-segment backstop.
- `MAX_FEE_BPS` (the `tin + tout` ceiling, `SVM`/`OkuM` shared) caps the coverable
  `M_oku` step size, which sets the *minimum* mark cadence: a longer gap between
  marks needs a bigger step, and a bigger step needs more fee to stay covered.

None of `MAX_STEP_BPS`, `MAX_IMPLIED_APR`, `MAX_SOLVENCY_GAP_BPS`, or the
`tin`/`tout` defaults can be picked in isolation without silently changing what
the others actually guarantee. **This blocks audit scoping** — see
`EVM/README.md` Open questions 1–3, which name the same coupling.

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

- **Cross-chain *value* equality is not proven `[both]`.** Since the sync-window
  simplification (see Decisions log), `check-sync-parity.ts` compares
  `M_oku(evm) / 1e9 == multiplier(svm)` directly, which is strictly stronger than
  the epoch-equality check it replaced — but it is still off-chain: a wrong-value
  write on either chain is undetectable on-chain and must be reconciled against
  the intended rate by whoever runs the comparison script. Inherent: neither
  chain can observe the other, and there is no bridge, oracle or messaging
  between them.

- **`solvencyGapBps()` is a monitoring signal, not a continuously-preserved
  on-chain invariant `[EVM]`.** The Foundry invariant fuzzer found a real
  counterexample during this work: a sequence of unwraps alone (no rate write)
  drove the ratio to 146 bps against what had been assumed to be a 100 bps
  on-chain bound. The reason: an unwrap removes matching liability and backing,
  so the *absolute* shortfall is unchanged but the ratio's denominator shrinks,
  inflating the ratio. `M_oku` is monotonic and liability only grows toward its
  projection, so a wrapper draining toward its last holders can present an
  alarming percentage from an unchanged, small absolute shortfall. The invariant
  suite was corrected to bound absolute shortfall against peak liability instead
  (`EVM/test/invariants/SystemInvariants.t.sol::invariant_ShortfallBoundedByPeakLiability`;
  full writeup in `EVM/test/wrapper/Solvency.t.sol`'s file header). Not a
  contract bug — `setUsdOkuRate`'s enforcement point was always the absolute
  shortfall, never the ratio — but `solvencyGapBps()` is exposed as a headline
  number and needs an alerting design that accounts for this before launch,
  rather than a naive "alarm above N bps" threshold on the ratio.

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

### v0.3 single-token refactor — follow-ups `[EVM]` — SUPERSEDED, historical only

**This entire section describes a design that no longer exists.** v0.3 moved
the EVM side to a single continuous-accrual ERC-8056 token (`OkuDollar` /
`rUSDOku`). That was itself superseded by the current two-token model — `OkuM`
(stepwise `M_oku`, ERC-8056) + `USDOku` (continuous `M_usd`, rebasing, no
ERC-8056) + `USDOkuWrapper` — described in full in `EVM/README.md`. Kept below
for git-blame continuity; do not act on any item here without re-reading
`EVM/README.md` first.

- ~~**`MAX_IMPLIED_APR` is a placeholder.**~~ Still true, but the constant now
  lives on `USDOku`'s continuous accrual, not `OkuDollar`'s. Re-tracked above
  under "Placeholder treasury numbers are coupled, not independent".
- ~~**ERC-7730 deployment addresses are zero-filled.**~~ Superseded by the
  current contract set — `EVM/metadata/erc7730/*.json` needs re-auditing
  against `OkuM`/`USDOku`/`USDOkuWrapper`/`SubscriptionModule` calldata shapes,
  not just re-filled with addresses. Worth a fresh tracker item if this hasn't
  been redone; not re-added here sight-unseen.
- ~~**Client SDK not built.**~~ `DISPLAY_CONVENTION.md`'s API shape now needs to
  cover two tokens with different display conventions (stepwise share token vs.
  continuous rebasing dollar token) rather than one. Status not verified as
  part of this pass.
- ~~**Reference AMM + lending integrations not built.**~~ Still open in spirit;
  `EVM/README.md` Limitation 6 now additionally warns USDOku specifically
  should not be pooled or used as collateral (no on-chain peg defense).
- ~~**Listings communications.**~~ Now a three-way problem (`OkuM`, `USDOku`,
  and USDC) rather than two.
- **`MathLib.rpow` has one uncovered assembly branch — still current, not
  obsolete.** `MathLib.sol` and its `rpow` survived the refactor and now back
  `USDOku`'s continuous `M_usd` accrual (`USDOku.sol` calls
  `MathLib.rpow(rate, elapsed, PRECISION)`). The uncovered `zx`-overflow-revert
  branch inside the squaring loop is the same one described previously; not
  re-verified this pass whether it is still deliberately left uncovered or has
  since been closed — check `MulDivBoundsTest`'s current coverage number
  against the 95% CI gate before re-closing this line item.

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

### `addresses.json` still carries retired-layout live entries `[EVM]`

Root `addresses.json` currently has `evm.<network>.contracts` keyed as
`okuMoney` / `okuDollar` / `litePSM` (plus `redemptionQueue`, `mockUSDC`) across
every listed EVM network (sepolia, base, bsc, bscTestnet, baseSepolia,
arbSepolia), all pointing at addresses from the retired single-token storage
layout that predates this refactor. Nothing is upgradeable in place across that
boundary, so these entries are stale and unusable against the current
`OkuM`/`USDOku`/`USDOkuWrapper`/`SubscriptionModule`/`RedemptionQueue` set — a
consumer reading this file today would attach to dead or wrong-shaped
contracts. `addresses.json` is marked auto-generated/do-not-hand-edit, so the
correct fix is a fresh deploy per network (via `scripts/deploy/index.ts`,
which is idempotent/resumable and will overwrite `addresses.json` on run), not
a manual edit. **Until that redeploy happens, this file is actively
misleading** and should probably be wiped or annotated as stale rather than
left looking current. Retired addresses, for institutional memory — all
identical across every listed network, i.e. never actually independently
redeployed per chain:

| Key | Address |
|---|---|
| `okuMoney` | `0x0696204405505f16bB5a8f5B227327c380e62796` |
| `okuDollar` | `0x7A9948284F985cBC1E2Fdf23BBf763bcBd27A70C` |
| `litePSM` | `0xee5D2cc97252353E50779D93D218057f6Ae93d80` |
| `redemptionQueue` | `0x06eFbeFd14c5A90f9d84BFf47dF0512fd5b15929` |
| `mockUSDC` | `0x437ABbc8d2dd04E383D557A8ea9c8451Ef9936e8` |

SVM devnet `litePsm` program: `BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g`.

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

Extend the `SystemHandler` stateful-fuzz harness to model a second simultaneous
`chainB` `SubscriptionModule` and randomly bridge between them. Surfaces
cross-chain accounting bugs that scripted scenarios miss. (The EVM-continuous
vs SVM-stepwise multiplier skew this item originally called out no longer
applies as stated — `OkuM`'s `M_oku` is stepwise on both chains now; the
remaining cross-chain surface to fuzz is `M_oku` step *timing* divergence
between chains, not a continuous-vs-stepwise mismatch. `USDOku`'s `M_usd` is
EVM-only and has no SVM counterpart to diverge from.)

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

- `sweepToken` (`SubscriptionModule`) / `sweepExcess` (`RedemptionQueue`) — recover tokens
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

**SUPERSEDED by the two-token refactor — kept for history, do not rely on
either claim below.** Both of the following were true when EVM had a single
continuous-accrual token and are false now that `OkuM`'s `M_oku` is stepwise
on both chains:

- ~~"The epoch-to-write binding is SVM-only. EVM accrues continuously and has
  nothing to land per tick."~~ The epoch protocol this referred to no longer
  exists at all (see the sync-window decision entry above); moot either way.
- ~~"`tout` on EVM is parity-only ... the step-coverage invariant is not
  enforced there."~~ Now false: `OkuM.setOkuMultiplier` enforces the same
  `tin + tout >= step` coverage as SVM, reading the fees from
  `SubscriptionModule`. `tout`/`tin` are load-bearing on both chains — see
  "SVM step coverage moved from `tout`-only to combined `tin + tout`" above.
  Continuous accrual (and its parity-only fee role) now lives on `USDOku`,
  which has no SVM counterpart and no step to cover.

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

**A multiplier write must never be rejectable on window state.** Otherwise
anyone able to open a window could censor the rate setter —
`setUsdOkuRate`/`haltAccrual` are deliberately un-gated by `isSyncLocked()` so
an operator can always zero or adjust the rate during an incident. (This entry
originally also claimed an inter-window "gap" bound limited callers to one
window per gap period — that referred to `MIN_SYNC_WINDOW_GAP`, which no longer
exists post auto-arm; see the sync-window decision entry above. The
never-censoring property itself still holds under auto-arm, just without a gap
to reason about.)

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

**The orchestrator-epoch sync-window protocol was replaced by auto-arm +
off-chain value comparison.** The earlier design had each chain record an
orchestrator-assigned `sync_epoch` per tick, with `beginSyncWindow(epoch)` /
`endSyncWindow(epoch)` bracketing the write and a `MIN_SYNC_WINDOW_GAP`
anti-grief cooldown between windows. It was removed because the machinery that
looked load-bearing wasn't: the epoch was supposed to make "a tick completed on
every chain" externally verifiable, but equal epochs never proved equal
*values* — only that both chains wrote *something*. `beginSyncWindow` had to be
callable before the write, so a window could be opened and never used, which
needed a write-landed-in-epoch check to close, which needed a
`last_write_epoch` field, which needed the anti-grief gap to stop windows being
chained — each mechanism existed only to contain the previous one. Arming on the
write (every `setOkuMultiplier` now sets `syncLockedUntil` unconditionally, no
`beginSyncWindow`/`endSyncWindow`/epoch/gap) removes the whole chain: there is
no unfenced tick to guard against, because the fence and the tick are the same
transaction. `check-sync-parity.ts` was rewritten to match — it now compares
`M_oku(evm) / 1e9 == multiplier(svm)` directly, which is strictly stronger than
the epoch check it replaced. Full rationale in `EVM/README.md`'s "v0.x
migration note: the epoch protocol was removed".

**SVM step coverage moved from `tout`-only to combined `tin + tout`, mirroring
EVM.** A round trip pays `tin` on the way in and `tout` on the way out, so the
figure that actually bounds step arbitrage is the sum, not `tout` in isolation
— a design that zeroed `tin` while relying on a nonzero `tout` was leaving half
the round-trip cost unpriced into the coverage check. `step_is_covered` (and
the fee-floor high-water mark that stops coverage being removed after the
fact) now both read `tin_bps + tout_bps`; `OkuM.setOkuMultiplier` on EVM reads
the module's `tin() + tout()` the same way, so the invariant is chain-symmetric.
See `oku-shared::step_coverage` module docs for the full derivation.

**The invariant fuzz harness now advances `block.timestamp` ~12 s per action.**
It previously only moved time via its explicit `warp` action (~1 call in 17), so
short-lived time-based state behaved nothing like production — a window armed by
`setRate` stayed engaged for a dozen unrelated actions. With realistic block
progression the fuzzer runs against the **real deployed window default** instead
of needing it disabled, which is strictly better coverage than before this work.

---

## Pointers

- [`README.md`](README.md) — workspace overview + orchestrator runbook (incl. the
  auto-arm sync-window / value-comparison protocol and its failure modes)
- [`EVM/README.md`](EVM/README.md) — EVM-specific docs (contracts, deployment, runbook, accepted risks)
- [`SVM/README.md`](SVM/README.md) — SVM-specific docs (programs, design, runbook, EVM divergence, accepted risks).
  The step-coverage invariant and its proof sketch live in § Fees.
