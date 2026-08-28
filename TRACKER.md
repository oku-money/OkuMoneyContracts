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

**EVM status (this pass):** `forge fmt`, `forge build` (zero lint warnings in
`src/`), `forge test` (202 tests), `forge coverage` (**100% line and 100% function
on `src/`**, 753/753 lines, 86.18% branch), `npm run typecheck`,
`npx hardhat compile`, `npm run upgrade:validate`, `npm run metadata` and a full
fork deploy + lifecycle walkthrough all pass. All four implementations validate
as UUPS-safe under `hardhat-upgrades` 3.9.0 with ERC-7201 namespaced storage.
One 🔴 remains.

Also fixed this pass: the CI coverage filter used an unanchored `lib/`, which
matched `src/lib/` and silently excluded `ScaledUIAmountUpgradeable`, `MathLib`
and `ReentrancyGuardUpgradeable` from the gate. The pattern is now anchored, the
100% requirement on the three pricing-path files is actually enforced, and the
gate fails if it parses too few rows — so an over-broad filter can no longer pass
silently. All three failure modes verified lethal against the real CI script.

---

## 🔴 Blocks external exposure

### ERC-7730 descriptors are authored but not submitted `[EVM]`

**Authoring is complete.** `EVM/metadata/erc7730/` carries v2-schema descriptors
covering **all 64 state-changing functions** across the four proxies, plus two
ERC-2612 EIP-712 descriptors and 16 reference test fixtures. `erc7730 lint`
exits 0 (warnings only) and a local gate validates every selector, ABI fragment
and field path against the compiled ABI. `metadata/DISPLAY_CONVENTION.md` is
written.

**What remains is deployment-gated**, because the registry needs real addresses
a reviewer can verify on-chain:

1. Deploy at `v0.3`, then verify on **Sourcify** (`verify.ts` now does both
   Sourcify and Etherscan — the ERC-7730 linter resolves ABIs from Sourcify
   first, and a miss produces the "Could not fetch ABI" warning reviewers are
   told to challenge).
2. `NETWORK=… OWNER=… OWNER_URL=… npm run metadata:sync` to emit per-chain
   descriptors, then regenerate fixtures and run
   `npm run metadata:validate -- --strict`.
3. Open one PR to `ethereum/clear-signing-erc7730-registry` under a single
   entity folder.

Still to decide before step 2: the **official entity name** (`metadata.owner`,
and the `registry/<entity>/` folder) and a **canonical URL of 26 characters or
fewer** — Ledger truncates beyond that, measured with the linter.

---

## 🟡 Should-fix before external audit

### Mark cadence needs confirming against `MAX_STEP_BPS` `[EVM]`

`Constants.MAX_STEP_BPS = 100` (1%) is derived from an assumed monthly
`setOkuMultiplier` cadence at a ~5% target annual yield, sized with
~2.4x headroom so one missed month can be caught up in a single mark.
If the actual operational cadence differs, this ceiling should move
with it — it is the only per-write oracle-sanity bound on a compromised
`OKU_RATE_SETTER` (see `EVM/README.md § Rate authority`).

### `MAX_IMPLIED_APR_BPS` / `MAX_RATE_DURATION` `[EVM]`

Shipped at `1000` bps / `30 days` (worst-case over-accrual from a
compromised key ≈0.82% per segment, ≈10.52% APY at the cap — both
verified against `MathLib.impliedAprBps`). The APR figure is a
placeholder; the duration is a round-number convention. Confirm both
before audit.

### ERC-7540 alignment depth `[EVM]` — DECIDED, partially landed

Settled: **align events and views, keep our function names.** Landed in this pass:
`DepositRequest` / `RedeemRequest` now carry ERC-7540's exact names *and* field
shapes; `pendingDepositRequest` / `pendingRedeemRequest` match the spec
signatures; `claimableDepositRequest` / `claimableRedeemRequest` exist and return
0 (we push on fulfillment, so nothing is ever claimable); all four 7540/7575
interface IDs are pinned and asserted false.

Deliberately NOT renamed: `requestSubscription` / `requestRedemption`. ERC-7540's
signature is `requestDeposit(assets, controller, owner)` and ours carries a
load-bearing `minOut`, so taking the spec name with different semantics would
invite false recognition.

Residual, low priority: ERC-7540's event shape has no slippage field, so `minOut`
is absent from request logs (readable via `getRequest`, and `RequestFulfilled`
carries the realised `amountOut`). Revisit only if an integrator needs `minOut`
from logs alone.

### `OKU_GUARDIAN` warm-vs-cold `[EVM]`

`haltAccrual()` (OkuM) and `haltUsdOkuAccrual()` (USDOku) are both warm
`OKU_GUARDIAN` levers, each withholding yield on a different token. Reversal is
cold-only via **`OKU_ACCRUAL_RESUMER`** — a role this refactor introduced that
the original design doc did not name, confirmed as wanted and now covered by
`test_haltAccrual_blocksMarksAndColdResumeRestores` (asserts the warm guardian
can halt but cannot resume).

Remaining question is operational, not structural: reconfirm warm is right for
the halt itself now that it is two lookalike switches, and make sure
`grantRolesMainnet.ts` grants `OKU_ACCRUAL_RESUMER` to the cold multisig on both
tokens. A halt withholds yield, which is not nothing.

### `setUsdOkuRate` has no in-breach tapering path `[EVM]`

By design, and largely academic under pre-funding. `MAX_SOLVENCY_GAP_BPS` is
zero, so any positive rate must be pre-funded; the only rate write that is
exempt is a full stop (`newRate == PRECISION`), which is provably non-worsening.

A shortfall should now be **unreachable in normal operation** — it would require
`M_oku` to fall (monotonicity forbids it) or a defect in `withdrawSurplus`
(which checks post-withdrawal backing before transferring). The escape hatch is
retained as a safety property, not a routine remedy. Covered by
`test_unfundedRate_fullStopStillPermitted`.

Decide before audit whether the full-stop-only hatch is the wanted shape, or
whether operators also want to taper down inside a live segment.

### `wrap` is now gated on projected solvency `[EVM]`

**Found by the stateful-fuzz suite, not by inspection.** `setUsdOkuRate` projects
liability using the shares outstanding AT WRITE TIME. A `wrap` during a live rate
segment mints new shares that then accrue for the remainder of the segment with
no pre-funding behind them, breaking `backingCoversLiability` a fraction of a
percent at a time (the fuzzer found ~0.0072% on a ~353k position).

Fixed by checking `projectedLiabilityAtRateEnd()` inside `wrap`, so newly minted
shares must also be covered through `rateEnd`.

**The consequence needs a product decision:** `wrap` is a permissionless path
that can now revert (`WouldBreachBacking`) when the issuer has not funded enough
headroom for new entrants. A user wrapping mid-segment is refused because of
issuer behaviour, not their own. Options:

1. Accept it, and have the issuer maintain generous headroom (operational).
2. Have `wrap` pull the required top-up from a funded buffer automatically.
3. Charge entering wrappers for their own remaining-segment accrual.

Option 1 is what ships today. `withdrawSurplus` and `withdrawableSurplus` are
also projection-aware, so committed funding is correctly excluded from surplus.

### Pausing OkuM blocks USDOku `unwrap` `[EVM]`

`USDOkuWrapper.unwrap` pays out by transferring OkuM from the wrapper to the
user, which passes through `OkuM._update`'s pause check. So an OkuM pause blocks
unwrap, qualifying the design's "unwrap is never gated on anything" claim.

Accepted for now — OkuM pause is the nuclear option and freezing all OkuM
movement is arguably the point. Flagged because the wrapper is deliberately
*not* pausable precisely so exits stay open, and this partially defeats that.
Decide whether the exit path should be exempt (e.g. a pause-exempt transfer path
for the wrapper) or whether the coupling is intended.

### Pausing OkuM traps escrowed OkuM in a pending redemption `[EVM]`

Same root cause as the item above, but with a sharper consequence, and found
while auditing `master`'s redemption controls for comparison.

`SubscriptionModule._refund` returns a redemption request's escrow with
`okuM.safeTransfer(req.user, req.amountIn)` (`SubscriptionModule.sol:468`). That
is a module → user transfer, so both addresses are non-zero and `OkuM._update`
fires `_requireNotPaused()` (`OkuM.sol:383-385`).

**While OkuM is paused, a user with a pending redemption cannot `cancelRequest`
and recover their tokens.** `rejectRequest` refunds through the same path, so the
operator cannot return the escrow either.

This matters more than the `unwrap` case: the module's pause was deliberately
scoped to intake only, so that escrow stays recoverable and the backlog stays
drainable while paused. The *token's* pause reintroduces the trap through a
different surface, and here the funds are held by the protocol rather than by the
user. It is the one place `noRedeem` still reproduces the failure shape it was
built to remove — an emergency lever that strands the people already in the
queue.

Options: exempt the module (and wrapper) from the pause check on the refund path,
or accept the coupling and state plainly that an OkuM pause freezes escrow. Worth
deciding together with the `unwrap` item — same fix shape.

### `setUsdOkuRate` cannot show an APR on a hardware wallet `[EVM]`

`newRate` is an 18dp per-second compounding rate: `1000000003170979198` is
roughly 10% nominal. ERC-7730 has no arithmetic, so the best a device can render
is `1.000000003170979198 /s`. The parameter is value-bearing, so it must stay
visible; hiding it is not an option.

Mitigated operationally: `npm run operator:setUsdOkuRate` prints the implied APR
and refuses to submit an unfunded rate, and `DISPLAY_CONVENTION.md` §5.1 makes
off-device APR verification a runbook requirement. Revisit if ERC-7730 ever
gains derived/computed fields.

### ERC-7730 cannot express a display multiplier `[EVM]`

The mirror image of the existing ERC-8056 denomination question below, and the
same standards gap seen from the other side. ERC-7730's `tokenAmount` resolves
ticker and decimals from the token contract, so an OkuM amount clear-signs as
raw units while the app shows dollars. We mitigate with explicit labels
(`OkuM Amount`, `USDOku Amount`, `USDOku Shares`), but no descriptor can close
the gap.

We hold an unusually clear motivating case for both proposals — a two-index,
non-equity ERC-8056 deployment — and they should probably be raised together:
a denomination field on ERC-8056, and multiplier awareness on ERC-7730.

### External ERC-8056 conformance suite wiring `[EVM]`

`ScaledUIAmountUpgradeable` is written against the EIP text (no OZ
reference implementation exists) and deliberately fixes the reference's
`block.timestamp == effectiveAt` boundary defect. Wire
`jumpboxtech/erc-8056-conformance` (or equivalent) into the test suite
before trusting boundary-case coverage.

### `SubscriptionModule` upgrade-with-pending-requests runbook `[EVM]`

The OZ layout validator catches storage breaks, but a logic change to
pricing or expiry semantics would apply retroactively to requests
submitted under the old rules. Either drain pending requests before
upgrading, or version the `Request` struct. Needs a runbook entry once
`scripts/upgrade/` is rebuilt for the new contract set.

### SVM has not adopted the reviewed-conversion pivot `[SVM]`

The new EVM design assumes an orchestrator-assigned `epoch` on every
multiplier write (`OkuM.setOkuMultiplier(newMultiplier, epoch)`,
`syncEpoch()`) and drops `distributeYield` entirely. SVM's `lite-psm`
still has `distribute_yield` and no `epoch` concept, and
`oku_shared::constants` still mirrors `MAX_STEP_BPS`/`MAX_FEE_BPS` from
the old design, not the new one. This pass was scoped to `EVM/` only —
SVM and the cross-chain reconciliation story (`check-sync-parity.ts`)
are now out of sync with the new EVM README and need their own pass.

### Root `README.md` still documents the retired design `[EVM]`

The workspace-level `README.md` (token model, PSM, orchestrator runbook)
describes the dual-token `OkuMoney`/`OkuDollar`/`LitePSM`/`RedemptionQueue`
system this pass replaced on the EVM side. Needs a rewrite once the EVM
refactor (tests + scripts + deploy) is complete, so it isn't rewritten
twice.

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

`npx tsc --noEmit` reports ~35 type errors across the bankrun test files
(`Program<LitePsm>` vs `Program<Idl>` generic-variance around
`addEventListener`). Harmless — the suite runs via `tsx` (no type-check)
and all 94 bankrun tests pass — but a fully polished project would type-
check clean. Fix with a targeted cast/typing shim in the harness.

### SVM audit-tooling note `[SVM]`

The Trail of Bits `solana-lints`/dylint integration
(`[workspace.metadata.dylint]`, `deny.toml` git-allow, `audit/`
package) was removed. If a static-analysis gate is wanted for the audit,
re-introduce a lint runner (dylint or an alternative) in CI.

---

## ⚪ Post-launch / low priority

### One pending request per user per direction — too restrictive? `[EVM]`

`SubscriptionModule` uses a `mapping(address => mapping(Direction =>
uint256))`, not a queue — deliberate, and why there is no
`RedemptionQueue.sol` anymore. Institutional flows needing concurrency
must use separate addresses. Revisit if that proves painful; a small
bounded array is the fallback and still not a queue.

### Should request expiry auto-refund? `[EVM]`

Today an expired (`MAX_REQUEST_AGE`) request needs an explicit
`cancelRequest` from the user. Auto-refund on expiry would be friendlier
but needs a permissionless poke, which reintroduces a keeper.

### ERC-8056 denomination field — propose upstream `[EVM]`

The EIP has no way to declare *what unit* a multiplier converts to.
OkuM's converts shares → dollars, across asset classes; Robinhood's
converts tokens → shares, within one. A consumer cannot distinguish
them, which is the root of the double-count hazard
(`EVM/README.md § Integration surface`). Worth proposing a denomination
field on the EIP-8056 discussion thread once the metadata/SDK work
above has shaken out real integration pain.

### `allowanceUI` saturates instead of reverting `[EVM]`

`OkuM.allowanceUI` now returns `type(uint256).max` rather than reverting when the
raw allowance is large enough that `raw × M_oku / PRECISION` would overflow —
which is the case for an infinite approval once `M_oku > PRECISION`. An unbounded
raw approval *is* an unbounded dollar approval, so the saturated value is honest,
and a drift-monitoring view that reverted on the most common approval pattern
would have been useless.

Informational: any SDK or explorer surfacing this must treat `uint256.max` as
"unbounded", not as a literal figure. Worth a line in the eventual
`DISPLAY_CONVENTION.md`.

### Steps are not scheduled ahead of effect `[EVM]`

`setOkuMultiplier(newMultiplier, epoch)` takes no effective-at parameter and
writes every step with `effectiveAt = block.timestamp`, so `M_oku` moves
immediately. The ERC-8056 pending-multiplier extension is structurally satisfied
(both fields are seeded and maintained, and `uiMultiplier() == newUIMultiplier()`
holds from the block of the write onward), and the storage layout is fully
general — enabling scheduling later is an added parameter, not a migration.

Worth doing eventually: the "upcoming adjustment" UI is the main thing the
extension exists for, and a stepwise index is the ideal case for it.

### Trapped wrapper over-collateral `[EVM]`

`USDOkuWrapper` has no `withdrawSurplus`-equivalent by design — an
extraction path on OkuM backing is exactly what the solvency model
forbids (senior OkuM holders are never subordinated to USDOku's
smoothing). Consequence: any donation-style top-up of OkuM reserves
(README's prescribed way to close a solvency gap) is permanently
locked in the wrapper. Accepted trade-off; revisit only if issuer
capital efficiency becomes a real constraint.

### Solana 3 → 4 SDK bump `[SVM]`

Deferred post-audit. Major-version bump scope unclear; revisit once
audit feedback narrows the surface.

### Two-chain Foundry invariant harness `[EVM]`

Once the `SystemInvariants`/handler suite is rebuilt for the new
contract set, extend it to model a second simultaneous `chainB` OkuM
deployment and randomly bridge between them. Surfaces cross-chain
accounting bugs that scripted scenarios miss.

**Effort:** 1–2 weeks.

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
- **EVM `SubscriptionModule.fulfillSubscription`/`fulfillRedemption`**
  are the highest-value control flow in the new EVM suite — the sole
  points where pricing (`M_oku` at fulfillment, never at request),
  fees, escrow accounting, and mint/burn authority all meet. Flagged as
  where auditor review time will concentrate once the differential
  "priced at request block" mutant test exists (see the 🔴 refactor
  item above).

### Operator CLI gaps `[both]`

Still missing CLIs — defer until post-audit when the function
kill-list is finalised:

**EVM:** none identified yet — `scripts/operator/` needs a full
rewrite for the new contract set (see the 🔴 refactor item above)
before a gap list is meaningful.

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
