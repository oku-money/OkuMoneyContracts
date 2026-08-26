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

### `MAX_STEP_BPS` needs treasury sign-off on the mark cadence `[both]`

**Reduced from a four-constant puzzle to one number.** The mechanisms are built,
enforced and tested; what is not decided is the published mark cadence, and
`MAX_STEP_BPS` follows from it mechanically.

`MAX_STEP_BPS` is now simultaneously the ceiling on a single `M_oku` step and the
per-leg floor under `tin`/`tout`:

```
setOkuMultiplier / set_multiplier:  stepBps  <= MAX_STEP_BPS
setFees          / set_fees:        tin      >= MAX_STEP_BPS
                                    tout     >= MAX_STEP_BPS
```

Composed, every admissible step is covered on each leg for all time, with no
stored state. So the cadence decision and the fee decision are the same decision
and cannot drift apart.

| Parameter | Ships as | Needs |
|---|---|---|
| Mark **cadence** | assumed DAILY | The one decision. Everything below follows |
| `MAX_STEP_BPS` | **5** (provisional) | Confirm 5 bps suits a daily mark at the intended APY. ~1.37 bps/day at 5%, so ~3.5x headroom — a missed three days still fits in one mark |
| `tin` / `tout` | both **5** (seeded at the floor by `initialize`) | Confirm a 10 bps minimum round trip is acceptable product pricing. Raising either leg buys no extra cadence; it is purely revenue/haircut |
| `MAX_FEE_BPS` | 100 (1%) | Confirm 1% is an acceptable worst-case haircut from a compromised cold key. No longer couples to step size |
| `sync_window_secs` / `syncWindowDuration` | 60 s (ships on) | Confirm 60 s is the right cross-chain propagation budget. SVM-side only in effect — see the EVM note below |
| `MAX_SYNC_WINDOW` | 15 min | Fail-open expiry ceiling. Unchanged |

**The old "`tin + tout = 0` means the protocol cannot rebase" launch-blocking
edge is GONE.** `initialize` seeds both legs at the floor on both chains, so a
fresh deployment is accrual-ready with no configuration and no ordering to get
wrong. That was the single most likely launch mistake and it is now unreachable:
`setFees` refuses anything below the floor, so there is no zero-fee state.

**Derived constraint, still needs sign-off:** `MAX_STEP_BPS` caps a single mark,
so it sets a **minimum cadence**. A longer outage cannot be caught up in one
write and must be walked over several marks. Direct analogue of the existing
`MAX_IMPLIED_APR` catch-up limitation on `M_usd`, and deliberate.

**Historical corrections worth keeping.** (1) An early version of this file said
the multiplier skew "is not user-exploitable because bridging is
orchestrator-mediated". True only of the cross-chain surface; the *local* SVM
surface — mint before a step, redeem after — needed no bridge and was fully
permissionless. That is what per-leg fee coverage closes. (2) A later version
described coverage as the combined `tin + tout`. That is sufficient on one chain
and insufficient across two: a cross-chain round trip pays `tin` on the chain it
mints on and `tout` on the chain it redeems on, so `(0, 2N)` here and `(2N, 0)`
there each satisfy a combined check while the pairing pays nothing. Hence
per-leg.

### `MAX_IMPLIED_APR` / `MAX_SOLVENCY_GAP_BPS` remain coupled `[EVM]`

**Narrowed.** `MAX_STEP_BPS` and the `tin`/`tout` defaults no longer participate
in this coupling — step coverage became a self-contained relationship between
`MAX_STEP_BPS` and itself, and the fee defaults are now derived from it rather
than tuned independently. What remains is the `M_usd` pair:

- `MAX_SOLVENCY_GAP_BPS` is a **cumulative** ceiling on USDOku's
  declared-vs-backed gap, not a per-write one. Worst-case over-accrual inside a
  single maximum-length rate segment (`MAX_IMPLIED_APR` over
  `MAX_RATE_DURATION` = 30 days) is ~79 bps — *below* the current 100 bps bound.
  So at current values no single rate write starting from a zero gap can be
  refused; the bound only bites after several consecutive segments have out-run
  realized marks. Raise it above ~79 bps and it stops being able to catch even a
  single pathological write, becoming purely a multi-segment backstop.
- Neither can be picked in isolation without silently changing what the other
  guarantees. `SolvencyTest` asserts the cumulative behaviour explicitly so the
  relationship cannot change unnoticed.

**Newly relevant:** `MAX_STEP_BPS` at 5 bps means realized marks advance slowly,
so a declared `M_usd` rate that outpaces the mark cadence will open a gap faster
than marks can close it. At 5% APY declared and a daily mark this is balanced;
at a coarser mark cadence it is not. The two cadences must be chosen together.

See `EVM/README.md` Open questions.

---

## 🟡 Should-fix before external audit

### Multiplier-arbitrage follow-ups `[both]`

- ~~**`reset_step_high_water_mark` is an un-modelled trust surface `[SVM]`.**~~
  **CLOSED by deletion.** The escape hatch is gone, and so is the
  `max_step_bps` ratchet it cleared. The static per-leg fee floor has no
  accumulated state to unwind, so there is nothing to reset and no
  unverifiable-precondition action to model. The EVM twin
  (`OkuM.resetStepHighWaterMark`) went with it. Changing cadence is now an edit
  to `MAX_STEP_BPS`, reviewed as code.

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
  carries `proof_admissible_step_under_admissible_fees_is_never_profitable` (the
  formal statement of the whole step-arbitrage defence) and
  `proof_step_bps_ceil_is_conservative`; `math.rs` carries three more. They are
  `#[cfg(kani)]` and only run under `cargo kani`, which **no CI job invokes**.
  The properties are also covered by ordinary unit tests, so this is a
  strengthening rather than a gap — but a proof nobody runs will rot.

  Note the proof got materially simpler with the static floor: it no longer has
  to assume a relation between the step and the live fee schedule, because the
  constants already guarantee it. Two proofs replaced three.

- **`PsmConfig` is 594 bytes.** Pinned by the compile-time assert in `state.rs`.
  Shrank from 602 when `max_step_bps` was removed with the ratchet. A size change
  alone makes the fresh devnet redeploy below **mandatory** rather than merely
  advisable — see that section for the full deployed-surface delta.

- ~~**EVM `initialize` grants `OKU_MINTER` / `OKU_BURNER` to `_admin` `[EVM]`.**~~
  **DONE.** Both grants dropped from `initialize`. Supply authority now reaches
  only contracts, and "no EOA can mint" is a property of the contract rather than
  of an assertion in `grantRolesMainnet.ts`. `_admin` retains
  `DEFAULT_ADMIN_ROLE` and can grant either role deliberately; the Hardhat
  fixture does so explicitly, so the affordance is visible rather than
  inherited.

- **`USDOkuWrapper`'s five `nonReentrant` guards are UNTESTED `[EVM]`.**
  `ReentrancyTest` covers the module and the queue against a hostile asset, but
  the wrapper cannot be reached that way: it never touches USDC. Its only
  external calls are to `OkuM` and `USDOku`, both protocol-controlled, so there
  is no untrusted callee to reenter from and the guards are defence-in-depth
  against a future change rather than protection against a present vector.

  An earlier draft of that suite appeared to cover them by arming a callback
  during `module.redeemUsdOku`; the selector assertion proved it did not — the
  module calls `wrapper.unwrap` first and pays USDC out afterwards, so the
  wrapper's guard is already released when the hostile transfer fires, and the
  reentrant `wrap` was failing on an allowance check.
  `test_WrapperGuardsAreNotReachableViaHostileAsset` documents this and will
  fail if it ever becomes guard-blocked. Covering them properly needs a hostile
  `OkuM` or `USDOku` mock.

- **`SubscriptionModule.depositBuffer` has no `nonReentrant` `[EVM]`.**
  Found by the same suite. Safe as-is — role-gated, pulls USDC inward only, and
  reads no state across the external call that it then writes — and recorded so
  a reviewer does not add a guard and assume `ReentrancyTest` covers it. The
  test asserts the *absence* explicitly.

- **An EVM bridge adapter must gate on `isSyncLocked()` `[EVM]`.**
  The sync window gates nothing on EVM today, because EVM has no dedicated
  bridge instruction — `OkuM.mint`/`burn` are the shared supply hooks the module
  and queue use for ordinary local subscription and redemption, so gating them
  would gate the whole PSM. The window is armed, bounded and fully observable
  (`isSyncLocked`, `syncLockedUntil`) as an advisory signal.

  When a bridge adapter is built it MUST consult it, and should do so in its own
  contract rather than by adding the modifier back to `OkuM`. Without that, a
  mid-tick cross-chain pairing conjures the divergence: burning 100 raw where
  M=1.04 destroys $104 of claim while minting 100 raw where M=1.05 creates $105.
  SVM already gates its dedicated legs (`mint_oku_m_direct` /
  `burn_oku_m_direct`).

- **`check-sync-parity.ts` should also compare FEE parity `[both]`.**
  It compares `M_oku` values across chains, which is the right check for
  divergence. But the per-leg fee floor is what makes a cross-chain round trip
  lossy, and it is enforced per-chain against a per-chain constant — so if
  `MAX_STEP_BPS` ever differs between the EVM and SVM builds, the cross pairing
  is under-covered and nothing on-chain would notice. Cheap to add and strictly
  stronger than a value-only comparison.

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
- **`PsmConfig` is 594 bytes** (was 562, then 602, then 618). Adds the
  sync-window fields (`sync_lock_until_ts`, `sync_window_secs`) and the fee
  fields (`tin_bps`, `tout_bps`). The epoch fields (`sync_epoch`,
  `last_write_epoch`) and `max_step_bps` were added and then removed again — do
  not expect them. A size change alone makes a fresh deploy mandatory.
- New instructions: `set_sync_window_secs`, `set_fees`. `begin_sync_window`,
  `end_sync_window` and `reset_step_high_water_mark` were added and then removed;
  the current surface is 23 instructions.
- Error variants: `SyncWindowActive`, `SyncWindowTooLong`, `FeeAboveMax`,
  `StepAboveMax`, `FeeBelowStepFloor`. `SyncWindowGapNotElapsed`,
  `EpochMismatch`, `NoWriteInEpoch`, `StepExceedsFeeCoverage` and
  `FeeBelowStepHighWaterMark` were added and then removed. **Codes shifted** as a
  result — earlier revisions appended deliberately to avoid that, but the
  `PsmConfig` size change already mandates a fresh deploy, so there is no
  on-chain consumer to protect.

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

### `addresses.json` is wiped and awaits a fresh deploy `[EVM]`

**Corrected.** An earlier version of this entry described the file as populated
with retired-layout entries and "actively misleading". It was **wiped in
`b38e112`**; there are no live EVM entries now. What remains open is simply that
nothing has been redeployed since, so the file is empty rather than wrong.

`addresses.json` is marked auto-generated/do-not-hand-edit, so the fix is a fresh
deploy per network via `scripts/deploy/index.ts` (idempotent/resumable, overwrites
the file on run) rather than a manual edit.

Retired addresses, for institutional memory — all identical across every listed
network, i.e. never actually independently redeployed per chain:

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

### ~~`RedemptionQueue.QueueEntry` storage packing `[EVM]`~~ — DONE

Packed to two slots, saving ~20k gas per `enqueue`:

```
slot 0:  user (160) + toutBps (16) + timestamp (48)  = 224 bits
slot 1:  rawAmount (128)
```

**Used `uint128`, not the `uint96` this entry originally proposed.** `uint96`
maxes at ~7.9e28, which is **below** `Constants.MAX_TOTAL_SUPPLY` (1e33), so it
would have introduced a real per-entry ceiling requiring a new bound and revert
path in `enqueue` — the caveat this entry flagged. `uint128` leaves ~3.4e5
headroom over the supply cap, so the bound is unreachable by construction and
needs no check. `RedemptionQueueTest` probes the storage slots directly and pins
the headroom, so a future cap raise trips a test rather than truncating an entry.

Done now because it was free now: a UUPS layout change with no live state. After
the first mainnet deploy it stops being a refactor and becomes a migration.

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
- ~~`reset-step-high-water-mark.ts`~~ — **moot.** The instruction no longer
  exists.

**Still missing, worth building before the backend integrates:**

- EVM `mintUsdOku.ts` / `redeemUsdOku.ts` — the one-transaction USDC↔USDOku
  path has contract functions and quote views but no operator CLI. `psmMint.ts`
  / `psmRedeem.ts` cover only the OkuM leg. Low effort; the backend will want
  the USDOku path.

**Shipped:** EVM `setSyncWindowDuration.ts`, `setFees.ts`,
`setOkuMultiplier.ts`, `distributeYield.ts` (new — the dollar-denominated mark
entry, restoring cross-chain symmetry with SVM's `distribute_yield`),
`haltAccrual.ts`, `resumeAccrual.ts`, `solvencyStatus.ts`, `wrapperSunset.ts`;
SVM `sync-window.ts`, `set-sync-window-secs.ts`, `set-fees.ts`,
`check-sync-parity.ts`. `beginSyncWindow.ts` / `endSyncWindow.ts` were shipped
and then deleted with the epoch protocol. The pre-existing `pause.ts` /
`unpause.ts` `--target` bug (documented `okuM|usdOku`, only `token|psm`
accepted) was fixed along the way.

---

## Decisions log — multiplier-arbitrage protection

Recorded because several of these are counter-intuitive, and re-deriving them
from the code alone would be slow. Each is a *closed* decision; reopen only with
the reasoning below in hand.

**STEP COVERAGE IS STATIC AND PER-LEG. (Latest, supersedes the combined-coverage
entries further down.)**

```
setOkuMultiplier / set_multiplier:  stepBps  <= MAX_STEP_BPS
setFees          / set_fees:        tin      >= MAX_STEP_BPS
                                    tout     >= MAX_STEP_BPS
```

Replaced four interacting mechanisms — a `tin() + tout()` read back into the
token at write time, a `stepHighWaterMark` ratchet, a floor on later `setFees`
calls against that mark, and a cold `resetStepHighWaterMark` escape hatch — with
a relationship between two constants. Strictly stronger: the ratchet only ever
covered steps that had *actually occurred*, whereas the floor covers every step
the protocol *can* take. Also removes the token→module dependency and the
escape hatch's unverifiable precondition.

**Per-leg rather than combined, and this was the decisive argument.** A combined
`tin + tout >= step` rule is sufficient on one chain and insufficient across two:
a cross-chain round trip pays `tin` on the chain it mints on and `tout` on the
chain it redeems on, so `(0, 2N)` on one chain and `(2N, 0)` on the other each
satisfy a combined check while the pairing pays nothing at all. Cost: the minimum
round trip is `2 × MAX_STEP_BPS` rather than `MAX_STEP_BPS`.

**Fees ship AT the floor, not at zero.** This was a correction made mid-
implementation, and it is the one non-obvious consequence. Once the token stops
reading the fee schedule, "ships inert at zero fees" is no longer fail-closed —
it is an *uncovered-step window* lasting until someone calls `setFees`. So
`initialize` seeds both legs at `MAX_STEP_BPS` on both chains and `setFees` can
only raise them. Side benefit: the launch-blocking "remember to set fees or the
protocol cannot accrue" step disappears.

**Industry precedent, deliberately not invented here.** The accepted defences for
a discretely-marked share token are (a) continuous accrual, (b) a
subscription/redemption fee at least as large as the mark, (c) a settlement
delay. (a) is unavailable: ERC-8056 and Token-2022 `ScaledUiAmount` both define
the multiplier as a *stored discrete value*, so it cannot accrue per-second. We
use (b) — the same `tin`/`tout` shape as MakerDAO's PSM, which this module was
ported from — and already have (c) in the redemption queue. Nothing beyond that
is ours.

**THE SYNC WINDOW GATES ONLY BRIDGE LEGS, and on EVM that means nothing yet.**
A single-chain operation priced at its own chain's `M_oku` is correct whatever the
peer believes, so the previous gating of module mint/redeem, queue processing and
wrapper wrap/unwrap (11 EVM call sites, 2 SVM instructions) bought no security
and cost an outage after every mark. SVM keeps the window on
`mint_oku_m_direct` / `burn_oku_m_direct`, which genuinely do move value across a
multiplier boundary as a pair.

EVM has no counterpart instruction: `OkuM.mint`/`burn` are the shared supply
hooks the module and queue use for ordinary local subscription and redemption. An
early attempt at this change DID gate them, on the theory that they were "the
bridge legs", and transitively re-gated the entire PSM. The window is therefore
retained on EVM as an armed, bounded, fully observable advisory signal, and the
bridge adapter — when it exists — must consult it. Tracked above.

**Why a time lock is right for one and wrong for the other.** The two edges
differ in kind. Cross-chain divergence is *transient and self-correcting*: once
the lagging chain ticks, the edge is exactly zero, so making the attacker wait
removes it. A step's gain is *permanent* and the multiplier is monotone, so
waiting costs a step-arbitrageur nothing and no window length deters them. Hence
a lock for the bridge, a fee floor for the steps.

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
