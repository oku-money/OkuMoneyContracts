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

**One number, one decision.** The mechanisms are built, enforced and tested;
what is not signed off is the published mark cadence, from which `MAX_STEP_BPS`
follows mechanically.

`MAX_STEP_BPS` is simultaneously the ceiling on a single `M_oku` mark and the
floor under `tout`:

```
setOkuMultiplier / set_multiplier:  stepBps <= MAX_STEP_BPS
setFees          / set_fees:        tout    >= MAX_STEP_BPS
MIN_MARK_INTERVAL between marks     (what makes the ceiling a per-TIME bound)
```

**The fee is the price of discreteness, and cadence is the dial.** One mark is
worth `APY x interval`, so marking more often lowers the required fee toward
zero — which is exactly why continuously-accruing designs (Maker `chi`, Aave's
liquidity index, Ondo's USDY oracle) need no fee at all. Token-2022's
`ScaledUiAmount` stores a discrete multiplier, so we cannot accrue continuously
and this fee is the exact cost of that constraint.

| Cadence | Step @5% APY | Required `tout` | Coverage at 2 bps |
|---|---|---|---|
| Monthly | 40.7 bps | 41 bps | ✗ |
| Weekly | 9.6 bps | 10 bps | ✗ |
| Daily | 1.37 bps | 2 bps | 1.5x |
| **6-hourly** | **0.34 bps** | 1 bps | **6x** ← shipped |
| Hourly | 0.057 bps | 1 bps | 35x |

| Parameter | Ships as | Needs |
|---|---|---|
| Mark **cadence** | assumed **6-hourly** | The one decision. Everything below follows |
| `MAX_STEP_BPS` | **2** | Confirm. ~6x headroom at 6-hourly; one mark absorbs ~1.5 days of catch-up |
| `tout` | **2** (seeded at the floor by `initialize`) | Confirm a 2 bps exit fee is acceptable product pricing. Raising it buys no extra cadence — purely revenue |
| `tin` | **0** | Deposits are free and have no floor. Confirm that is intended as a permanent product commitment |
| `MIN_MARK_INTERVAL` | **1 hour** | Well under the 6-hourly cadence, so it never binds in normal operation. Ondo uses 23h on OUSG |
| `MAX_FEE_BPS` | 100 (1%) | Worst-case haircut from a compromised cold key |

**Operational consequence of the cadence:** ~4 marks/day/chain. Cheap on L2 and
SVM, non-trivial on Ethereum mainnet. If mainnet gas makes 6-hourly marking
uneconomic, the cadence coarsens and `tout` must rise with it — that is the
trade-off, and it is explicit rather than emergent.

**Two launch-blocking edges that no longer exist.** (1) `tin + tout = 0` used to
mean the protocol could not rebase at all; `initialize` now seeds a covered
`tout` on both chains, so a fresh deployment is accrual-ready with no
configuration. (2) A compromised rate setter could loop marks and compound
arbitrarily fast; `MIN_MARK_INTERVAL` closes that.

**Historical corrections worth keeping.** (1) An early version of this file said
the multiplier skew "is not user-exploitable because bridging is
orchestrator-mediated" — true only of the cross-chain surface; the *local*
mint-before-mark / redeem-after surface needed no bridge and was fully
permissionless. (2) A later version described coverage as the combined
`tin + tout`. (3) A later one still floored BOTH legs, justified by a
cross-chain leg-pairing argument. Both (2) and (3) were wrong in the same way:
the arbitrage gain is realised on EXIT, and the only exit that drains the buffer
charges `tout`. So `tout >= step` is sufficient, `tin` is irrelevant, and
deposits are free.

### Instant-redemption rate limits — IMMINENT, decide before external exposure `[both]`

**Not an arbitrage control.** Step arbitrage is closed by the exit fee. This is
about the risk that is genuinely novel to what we are building.

**We appear to be the only permissionless instant on-chain RWA redemption.**
Surveyed while designing the fee:

| Protocol | Index shape | Permissionless? | Instant on-chain redemption? |
|---|---|---|---|
| Ondo USDY | Continuous (`RWADynamicOracle`, compounding rate segments) | ✗ allow-list (`OndoIDRegistry`) | KYC-gated |
| Ondo OUSG | Stepwise (1%/23h bounded) | ✗ allow-list | KYC-gated, $5k min, **$50M global / $25M per-user per 24h** |
| BlackRock BUIDL | Stepwise NAV | ✗ transfer agent | ✗ |
| Maker sDAI | Continuous (`chi`) | ✓ | ✓ |
| Aave aTokens | Continuous (liquidity index) | ✓ | ✓ |
| wstETH | Continuous | ✓ (wrap) | ✗ (ETH exit queues) |
| **OkuM / USDOku** | **Stepwise** | **✓** | **✓** |

Everyone permissionless-and-instant uses a *continuous* index; everyone with a
*stepwise* index gates access. Nobody occupies our square. That is the
opportunity and also why the arbitrage exists.

**NOT YET VERIFIED:** Midas (`mTBILL`/`mBASIS` — their docs returned 403),
Backed (`bIB01`), Spiko, Superstate. Confirm all four are allow-listed before
making the "first permissionless instant RWA redemption" claim publicly.

**The exposure is liquidity, not MEV.** The buffer is finite and T-bills settle
T+1/T+2. A redemption rush drains it and everyone else falls into
`RedemptionQueue`. Ondo's $50M/$25M limits almost certainly exist for this
rather than for arbitrage.

**What to decide:**

- **Per-user and global 24h rate limits on `SubscriptionModule` mint/redeem.**
  Real added state (rolling windows, per-address accounting) — genuinely more
  complexity, and the one place I would argue it is worth it, because it caps
  the loss even if a parameter is mis-set. Ondo has them on both products.
- **Buffer sizing and top-up policy.** Treasury, not contracts. Determines how
  often "instant" is actually instant.
- **The honest product claim** is "instant while the buffer is liquid, queued
  otherwise, always permissionless and always self-service". Materially better
  than anything in the table — nobody else lets an unknown address redeem at
  all — but unqualified "instant" will be wrong on the worst day, and it is
  better to say so up front than to have someone discover it.

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

- **`PsmConfig` is 602 bytes.** Pinned by the compile-time assert in `state.rs`.
  Went 618 -> 594 when `max_step_bps` was removed with the ratchet, then 594 ->
  602 when `last_mark_ts` was added for the cadence bound. A size change alone
  makes the fresh devnet redeploy below **mandatory** rather than merely
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

- **An EVM bridge adapter must gate itself on `lastSteppedAt()` `[EVM]`.**
  The sync window was DELETED on EVM (~700 lines) because it gated nothing: EVM
  has no dedicated bridge instruction — `OkuM.mint`/`burn` are the shared supply
  hooks the module and queue use for ordinary local subscription and redemption,
  so gating them would gate the whole PSM.

  When a bridge adapter is built it must reproduce the fence in its OWN
  contract, which needs no protocol state:

  ```solidity
  if (block.timestamp < okuM.lastSteppedAt() + PROPAGATION_BUDGET) revert;
  ```

  `lastSteppedAt` is stored anyway for ERC-8056's `effectiveAt()`. Without the
  check, a mid-tick cross-chain pairing conjures the divergence: burning 100 raw
  where M=1.04 destroys $104 of claim while minting 100 raw where M=1.05 creates
  $105. SVM already gates its dedicated legs (`mint_oku_m_direct` /
  `burn_oku_m_direct`) and keeps its window for exactly that reason.

- **`check-sync-parity.ts` should also compare `tout` and `MAX_STEP_BPS` parity
  `[both]`.** It compares `M_oku` values across chains, which is the right check
  for divergence. But the exit-fee floor is what makes a cross-chain round trip
  lossy, and it is enforced per-chain against a per-chain constant — so if
  `MAX_STEP_BPS` ever diverged between the EVM and SVM builds, one chain's exit
  would be under-covered and nothing on-chain would notice. Cheap to add.

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
- **`PsmConfig` is 602 bytes** (was 562, then 602, 618, 594). Adds the
  sync-window fields (`sync_lock_until_ts`, `sync_window_secs`), the fee fields
  (`tin_bps`, `tout_bps`) and `last_mark_ts`. The epoch fields (`sync_epoch`,
  `last_write_epoch`) and `max_step_bps` were added and then removed again — do
  not expect them. A size change alone makes a fresh deploy mandatory.
- New instructions: `set_sync_window_secs`, `set_fees`. `begin_sync_window`,
  `end_sync_window` and `reset_step_high_water_mark` were added and then removed;
  the current surface is 23 instructions.
- Error variants: `SyncWindowActive`, `SyncWindowTooLong`, `FeeAboveMax`,
  `StepAboveMax`, `FeeBelowStepFloor`, `MarkTooSoon`.
  `SyncWindowGapNotElapsed`, `EpochMismatch`, `NoWriteInEpoch`,
  `StepExceedsFeeCoverage` and `FeeBelowStepHighWaterMark` were added and then
  removed. **Codes shifted** as a result — earlier revisions appended
  deliberately to avoid that, but the `PsmConfig` size change already mandates a
  fresh deploy, so there is no on-chain consumer to protect.
- **Fees ship `tin = 0`, `tout = MAX_STEP_BPS`.** Deposits free, exits covered.

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

**STEP COVERAGE IS STATIC AND SITS ON THE EXIT LEG ONLY. (Latest; supersedes
both the combined-coverage entries further down AND the per-leg revision.)**

```
setOkuMultiplier / set_multiplier:  stepBps <= MAX_STEP_BPS
setFees          / set_fees:        tout    >= MAX_STEP_BPS
                                    (tin has NO floor; ships at 0)
```

Replaced four interacting mechanisms — a `tin() + tout()` read back into the
token at write time, a `stepHighWaterMark` ratchet, a floor on later `setFees`
calls against that mark, and a cold `resetStepHighWaterMark` escape hatch — with
a relationship between two constants. Strictly stronger: the ratchet only ever
covered steps that had *actually occurred*, whereas the floor covers every step
the protocol *can* take. Also removes the token→module dependency and the
escape hatch's unverifiable precondition.

**The exit leg alone is sufficient, and this took two corrections to get right.**
First it was the combined `tin + tout`. Then it was per-leg, justified by a
cross-chain leg-pairing argument. Both missed the same thing: the arbitrage gain
is realised on EXIT, and the only exit that drains the buffer is `redeem`, which
always charges `tout` —

```
net <= D(1 + s)(1 - tout) < D    for every s <= MAX_STEP_BPS <= tout
```

— with `tin = 0`, and cross-chain too, since whichever chain the attacker exits
on charges its own `tout`. So `tin` is irrelevant to the attack and deposits are
free. That is not a nicety: permissionless frictionless entry is the product.
The Kani proof quantifies `tin` from zero, which is what makes it explicit.

**`tout` ships AT the floor, not at zero.** A correction made mid-implementation,
and the one non-obvious consequence. Once the token stops reading the fee
schedule, "ships inert at zero fees" is no longer fail-closed — it is an
*uncovered-mark window* lasting until someone calls `setFees`. So `initialize`
seeds `tout = MAX_STEP_BPS` on both chains and `setFees` can only raise it. Side
benefit: the launch-blocking "remember to set fees or the protocol cannot
accrue" step disappears.

**`MIN_MARK_INTERVAL` is what makes `MAX_STEP_BPS` mean anything.** Without it
the ceiling bounds one call while nothing bounds how many land in a block, so a
compromised rate setter could loop `setOkuMultiplier` — each call individually
legal — and compound arbitrarily fast, bounded only by `MAX_MULTIPLIER`. The
ceiling gave the *appearance* of bounding the rate of change without doing so.
Applied to `distributeYield` too, so the two entry points cannot be alternated
around it. Ondo enforces the same control on OUSG at 23 hours
(`RWAOracleRateCheck.MIN_PRICE_UPDATE_WINDOW`); we use 1 hour because our cadence
is finer. It does not impede incident response — `haltAccrual` is separate,
immediate and ungated, and halting deliberately does not stamp `lastSteppedAt`.

**Industry precedent, deliberately not invented here.** The accepted defences for
a discretely-marked share token are (a) continuous accrual, (b) a
subscription/redemption fee at least as large as the mark, (c) a settlement
delay. (a) is unavailable: ERC-8056 and Token-2022 `ScaledUiAmount` both define
the multiplier as a *stored discrete value*, so it cannot accrue per-second. We
use (b) — the same `tin`/`tout` shape as MakerDAO's PSM, which this module was
ported from — and already have (c) in the redemption queue. Nothing beyond that
is ours.

**THE SYNC WINDOW IS DELETED ON EVM AND KEPT ON SVM.**
A single-chain operation priced at its own chain's `M_oku` is correct whatever the
peer believes, so the previous gating of module mint/redeem, queue processing and
wrapper wrap/unwrap (11 EVM call sites, 2 SVM instructions) bought no security
and cost an outage after every mark. SVM keeps the window on
`mint_oku_m_direct` / `burn_oku_m_direct`, which genuinely do move value across a
multiplier boundary as a pair.

EVM has no counterpart instruction: `OkuM.mint`/`burn` are the shared supply
hooks the module and queue use for ordinary local subscription and redemption. An
early attempt at this change DID gate them, on the theory that they were "the
bridge legs", and transitively re-gated the entire PSM.

It was then briefly kept on EVM as an "advisory signal" gating nothing, which is
worse than absent — a reviewer assumes protection that is not there. Deleted
outright (~700 lines including storage, views, config, role, a 462-line test file
and an operator script). A future bridge adapter reproduces it in one line from
`lastSteppedAt`, which ERC-8056 makes us store anyway. Tracked above.

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

---

# PLANNED PIVOT — operator-approved mint/redeem `[both]`

**Status: NOT STARTED. Design agreed, nothing implemented.** Recorded here so the
decision set survives while other approaches are explored on other branches. The
tree as committed is still the permissionless design with the tout-only floor.

The product pivots to an **approval system for all redemptions, including
on-chain**. A redemption becomes a request the back end approves and settles
later, rather than an atomic permissionless swap. Minting moves under the same
gate. Everything below follows from that one change.

## Decisions taken

| Question | Decision |
|---|---|
| EVM token model | **Keep two-token.** `OkuM` + `USDOku` + `USDOkuWrapper` survive as-is. Only the queue and the fee floor are removed |
| How user tokens reach the protocol | **Allowance + operator-pull.** User approves the module; operator calls `executeRedemption(user, rawAmount)` → `transferFrom` → `burn` → pay USDC, atomic |
| Mint path | **Also operator-only.** Symmetric with redemption; closes the mint-before-mark free option |
| SVM bridge | **Stays.** Keep the sync window on the bridge legs; delete only the step-coverage mirror |
| Fees | **Delete entirely.** No `tin`, no `tout`, no fee surface on either chain |

## What the pivot does and does not retire

The step-arbitrage defence is two separable halves and only one dies. This is the
single most important thing to get right when executing — the halves address
different threats and are easy to conflate.

| Control | Threat it addresses | Verdict |
|---|---|---|
| `tout >= MAX_STEP_BPS` floor (`SubscriptionModule.sol:751`) | mint → step → redeem round trip | **Retire.** The round trip needs a timely exit. The operator controls exit timing, so there is no risk-free arb left to price against |
| SVM `step_coverage.rs` | same | **Retire**, same reasoning |
| `stepBps <= MAX_STEP_BPS` (`ScaledUIAmountUpgradeable.sol:188`) | compromised `OKU_RATE_SETTER` | **KEEP.** Not an arb defence. Without it one call can 1000x the multiplier and print unbacked liability |
| `MIN_MARK_INTERVAL = 1 hour` (`OkuM.sol:450`) | compromised rate setter looping marks | **KEEP.** Same threat class — bounds yield per unit *time*, not per call |
| SVM sync window (`helpers/sync_window.rs`) | cross-chain step propagation on `mint_oku_m_direct` / `burn_oku_m_direct` | **KEEP.** Gates bridge legs, not user redemption. The bridge stays in scope |

Consequence for the open 🔴 item above: the cadence decision **narrows but does
not disappear**. `tout` and `tin` leave the table entirely, and with them the
"required `tout`" column. What still needs treasury sign-off is the mark cadence
itself, because `MAX_STEP_BPS` remains the ceiling on a single mark for
key-compromise reasons and still has to be sized against the published cadence.

## Why the queue goes

`RedemptionQueue` exists for exactly one case: the buffer is short, so escrow now
and pay later (`SubscriptionModule.sol:587-605` → `RedemptionQueue.sol:249`).
Under approval gating *every* redemption is "pay later", and the operator simply
does not execute until USDC is on hand. The queue is subsumed.

Deleting it removes 530 lines, 3 roles, `advanceHead`, `sweepExcess`,
`rescueQueueEntry`, `_effectiveTout`, the per-entry `tout` snapshot, the
`WouldStrandQueue` guard, and the "callers must treat a `0` return as queued"
footgun documented at `SubscriptionModule.sol:439-442`. It also closes the
`QueueEntry` slot-packing follow-up open above, by deleting the struct.

## Why allowance-pull, and why it is the safe choice

`OkuM.burn(uint256)` burns from the **caller's own balance** only
(`OkuM.sol:551`). There is no `burnFrom(address,uint256)`. So the back end cannot
burn a user's OkuM as the code stands — the tokens must first reach a
protocol-controlled address, and *how* is a product decision, not an
implementation detail. Three candidates were considered:

- **(A) deposit address** — user transfers OkuM to a treasury address, back end
  watches `Transfer`. Almost no new contract code, but no on-chain request
  record, and refunds plus wrong-amount sends become manual ops burden.
- **(B) allowance + operator-pull** — chosen.
- **(C) on-chain request + escrow** — gives users an on-chain claim, at the cost
  of rebuilding much of the queue being deleted.

**(B) has a deliberately small blast radius.** `executeRedemption(user, rawAmount)`
only works for users who have already approved, burns their OkuM, and pays USDC
computed on-chain from the live multiplier. A compromised `PSM_REDEEMER` can
force consenting users out at fair value; it cannot steal. Nothing is ever held
in escrow, so nothing can be stranded, and the user can withdraw consent by
revoking the allowance.

**Deleting fees strengthens this rather than weakening it.** With no `tout`,
`usdcOut` is a deterministic conversion at `M_oku` with zero operator discretion
over price. The operator chooses **whether and when, never how much**. Had fees
survived as an operator-supplied argument, an executed redemption would have
carried no on-chain fair-value guarantee.

**Wrap/unwrap stay permissionless.** Both legs price at `M_oku`
(`USDOkuWrapper.sol:36-37`), so the round trip is a provable no-op and leaks
nothing. Keeping them open preserves the "no code path disables `unwrap`"
guarantee (`USDOkuWrapper.sol:57-58`): a conversion between two protocol tokens
is not an exit. The exit to USDC is what is now gated.

**Pause is retained on the new entry points** even though the operator could
simply stop calling. It is held by a warm multisig distinct from the operator
key, which makes it the only lever that stops a *compromised* operator.

---

## Phase 1 — EVM contracts

**1.1 Delete `EVM/src/psm/RedemptionQueue.sol`.** Takes with it `IModuleFees`,
`QueueEntry`, `RedemptionSkipReason`, `_effectiveTout`, `advanceHead`,
`sweepExcess`, `rescueQueueEntry`, and the `okumoney.storage.RedemptionQueueV2`
namespace.

**1.2 `SubscriptionModule.sol` — gate and simplify.**

Storage: drop `redemptionQueue`, `tin`, `tout`. Bump namespace →
`okumoney.storage.SubscriptionModuleV2`.

New entry points, replacing `redeem` / `redeemUiAmount` / `redeemUsdOku`
(`:443`, `:466`, `:493`) and `mint` / `mintUsdOku` (`:363`, `:375`):

```
executeRedemption(address user, uint256 rawAmount)           onlyRole(PSM_REDEEMER)
executeRedemptionUsdOku(address user, uint256 usdOkuAmount)  onlyRole(PSM_REDEEMER)
executeSubscription(address user, uint256 usdcAmount)        onlyRole(PSM_SUBSCRIBER)
executeSubscriptionUsdOku(address user, uint256 usdcAmount)  onlyRole(PSM_SUBSCRIBER)
```

`_redeem` (`:524`) loses the buffer branch entirely. An under-funded buffer now
reverts `InsufficientBuffer` instead of silently returning `0`.

Delete: `setFees` (`:744`), `tin()` / `tout()` (`:330` / `:335`), `processQueue`
(`:623`), `redeemableNow()` (`:321`), `redeemUiAmount`, errors
`FeeAboveMaximum` / `FeeBelowStepFloor` / `WouldStrandQueue`, events
`RedemptionEnqueued` / `BufferRefilled` / `FeesUpdated`, and the
`WouldStrandQueue` check in `withdrawUsdc` (`:663-668`).

Simplify `quoteMint` / `quoteRedeem` (`:291` / `:301`) to pure multiplier
conversions. Drop `quoteMintUsdOku` / `quoteRedeemUsdOku` (`:344` / `:353`) —
with no fees they stop being approximations and become redundant.

**Retain, load-bearing:** the sub-USDC-unit dust guard (`:538-540`); the
zero-net-payout revert (`:551-554`); the share-delta measurement on the USDOku
path (`:507-512`, guards a real double-flooring hazard); the deploy-time
asset/decimals cross-assertions (`:208-220`); `sweepToken`'s USDC exclusion
(`:689`).

**Delete the slippage floor (`:556-575`), with reasoning recorded.** Two
independent arguments: (i) with fees gone,
`minExpected = dollarsToUsdc(toUiAmount(rawFloor, M))` and
`rawFloor <= rawAmount`, so the check is provably non-binding — it only ever bit
because `applyFee` ceil-rounds; (ii) `M_oku` is monotonically increasing, so a
mark landing between submission and inclusion can only pay the user *more*.
There is no slippage to protect against.

**1.3 `Roles.sol`** — remove `PSM_FEE_MANAGER`, `PSM_QUEUE_PROCESSOR`,
`QUEUE_UPGRADER`, `QUEUE_PSM`, `QUEUE_RESCUER`; add `PSM_REDEEMER`,
`PSM_SUBSCRIBER`. 22 → 19. Two roles rather than one `PSM_OPERATOR` because the
keys have different failure modes and should rotate independently.

**1.4 `Constants.sol`** — delete `MAX_FEE_BPS` (`:232`). **Keep `MAX_STEP_BPS`
(`:93`) and `MIN_MARK_INTERVAL` (`:118`).** Rewrite the NatSpec at `:51-92`,
which currently frames the entire number around the two-rule fee floor. Without
that rewrite `MAX_STEP_BPS` reads as orphaned config and someone deletes it later.

**1.5 `MathLib.sol`** — delete `feeAmount` (`:152`) and `applyFee` (`:166`), now
unreferenced. Rounding policy and every conversion helper stay untouched.

**1.6 Stale-NatSpec sweep** — pre-existing drift from the sync-window removal,
cheapest to clear while these files are already open:
`SubscriptionModule.sol:616-622` (claims `processQueue` is sync-gated),
`SubscriptionModule.sol:273` (refers to deleted `setStepFeeSource`),
`USDOkuWrapper.sol:389-390` (claims `withdrawSurplus` is sync-gated),
`Roles.sol:50-52` and `:71-72`, `ScaledUIAmountUpgradeable.sol:41-58` (states a
per-leg `tin` AND `tout` floor that is already untrue), `:167`, `:179-181`,
`OkuM.sol:135-137`, `:420-423`,
`IScaledUIAmountNewUIMultiplier.sol:16-17`.

## Phase 2 — EVM tests

Delete `test/psm/RedemptionQueue.t.sol`, `test/psm/Fees.t.sol`,
`test/psm/StepArbitrage.t.sol`.

Rewrite `test/psm/SubscriptionModule.t.sol` (role gating; `InsufficientBuffer`
replaces enqueue), `test/psm/Reentrancy.t.sol` (queue vectors gone),
`test/psm/UsdOkuConvenience.t.sol`, `test/handlers/SystemHandler.sol` +
`test/invariants/SystemInvariants.t.sol` (drop queue invariants; actor model
becomes operator-driven).

**Keep `test/psm/MaxSend.t.sol`** even though `redeemUiAmount` is deleted — it
pins `MathLib` rounding direction and `fromUIAmount` is still live in the wrapper.

Unchanged: `test/token/*`, `test/wrapper/*`, `test/oracle/*`, `test/lib/*`.

New coverage: unauthorized caller reverts on all four entry points; redemption
fails closed on insufficient user allowance; a mark landing between approval and
execution pays the user more, never less; `pause` stops a compromised operator.

`test/hardhat/Scenarios.ts` — reconcile.

## Phase 3 — EVM scripts + deploy

Delete `operator/processQueue.ts`, `operator/rescueQueueEntry.ts`,
`operator/setFees.ts`. Rewrite `operator/psmMint.ts` / `psmRedeem.ts` as
operator-execution scripts taking a target user.

**Fix `operator/distributeYield.ts:170`** — calls the deleted `syncLockedUntil()`
after submitting, so it throws on every successful run today. Pre-existing bug,
unrelated to the pivot, fix in passing.

Update `scripts/deploy/index.ts` (drop queue deployment and the `QUEUE_PSM` grant
at `:765-774`; add two new role grants), `config/roles.ts`,
`config/addresses.json`, `utils/addressBook.ts`, `test/smoke.ts`. Run
`upgrade/checkLayout.ts` to confirm the namespace bump is clean.

`config/addresses.json` is separately stale — it still carries pre-rename
`OkuMoney` / `OkuDollar` / `LitePSM` keys with identical addresses across all six
networks. Nothing live to preserve, so fresh deploys and namespace bumps are free.

## Phase 4 — SVM

**Keep** `helpers/sync_window.rs` and `crates/oku-shared/src/sync_window.rs`.

**Delete** `crates/oku-shared/src/step_coverage.rs` plus its `lib.rs:29` module
declaration and `lib.rs:37` `step_bps_ceil` re-export; the fee fields; and
`scripts/admin/set-fees.ts`.

**Gating maps onto SPL delegation, not approvals.** SVM has no allowance table,
so decision (B) becomes: the user calls `approve` on their OkuM ATA delegating to
the `PsmConfig` PDA, and the program burns with `authority = delegate`, signing
with PDA seeds. **Delegate the PDA, not the operator keypair**, so outstanding
delegations survive operator key rotation.

Changes: add `redeemer: Pubkey` and `subscriber: Pubkey` to `PsmConfig`; add
`Redeemer` / `Subscriber` to `AuthorityRole` (`roles.rs:40`); add
`has_one = redeemer @ LitePsmError::Unauthorized` to `RedeemOkuM` and
`has_one = subscriber` to `MintOkuM` — the *absence* of that constraint is
precisely what makes them permissionless today. Update the layout pin
`assert!(PsmConfig::LEN == 602)` (`state.rs:227`); layout change ⇒ fresh devnet
deploy. Drop the vestigial `min_usdc_out` slippage argument.

Tests: split `tests/bankrun/sync-window-and-fees.ts`, keeping the sync-window
half. Update `tests/shared/setup.ts` (`DEFAULT_TEST_TIN_BPS`, tout clamp),
`lite-psm.ts`, `smoke.ts`, `coverage-additions.ts`. `crossChainBridging.ts`,
`direct-mint.ts`, `direct-burn.ts`, `scaled-ui-amount.ts`, `rate-over-time.ts`
stay. Update `scripts/admin/check-sync-parity.ts` — parity now covers the step
ceiling and cadence only, not step coverage.

## Phase 5 — docs + artifacts

`README.md`, `EVM/README.md`, `SVM/README.md`, this file, `artifacts/evm/*.json`,
`artifacts/svm/lite_psm.json`, and `EVM/metadata/erc7730/*` (clear-signing
metadata references the deleted entry points).

The root README's collateralization thesis (`usdOku` rate vs `OkuM` rate →
`depositReserves` / `withdrawSurplus`) is **unaffected** — two-token survives.
What changes is the access model and the removal of the fee surface.

---

## Open question blocking Phase 1.2

**Where does subscription USDC come from?** The plan above assumes
`executeSubscription(user, usdcAmount)` pulls USDC from `user` via allowance —
the on-chain USDC subscription path, symmetric with redemption. For a **fiat
on-ramp** the user has no on-chain USDC at all and the operator would mint
against treasury-supplied backing instead. That is a different signature and a
different backing invariant. If the MVP needs the fiat path, add a second
explicit entry point rather than overloading one with a `payer` argument.

## Execution risks

- **The largest surface is test reconciliation, not contracts.** 402 Foundry, 66
  Hardhat, 126 bankrun and 40 Rust unit tests currently encode permissionless
  mint/redeem as expected behaviour, and the arbitrage suites assert properties
  that are about to stop being meaningful.
- **`MAX_STEP_BPS` will look orphaned** once its fee-floor counterpart is gone.
  The NatSpec rewrite in 1.4 is not cosmetic.
- **Do not let the two halves of the step defence be conflated.** The retire/keep
  table above is the guard against that.
