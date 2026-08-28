# `noRedeem` vs `master` — what changed and why

A high-level comparison of the EVM contract suite on this branch against
`master`, for reviewers coming to the branch cold.

**Scope:** `EVM/` only. SVM is untouched and is now out of sync — tracked.

**Headline:** `master` is a permissionless dual-token PSM with a redemption
queue. `noRedeem` replaces it with a **reviewed-conversion** system where every
USDC ↔ token conversion is a backend-fulfilled request, OkuM carries **ERC-8056**
scaled-UI display, and USDOku's forward yield must be **pre-funded**.

---

## 1. The premise change

`master` let anyone mint and redeem atomically against an on-chain USDC buffer,
with a FIFO queue for when the buffer ran dry. Because a permissionless actor sat
on a pricing path, the design needed a lattice of defences: a sync window, a
step-coverage fee floor, a yield-sandwich guard, and queue-fairness machinery.

`noRedeem` removes the permissionless actor. Subscription and redemption become
two-phase requests that the backend reviews and fulfils. **Once no untrusted
party can price, every defence that existed to constrain that party becomes dead
weight** — which is why so much of this diff is deletion.

Approval/compliance gating itself is explicitly out of scope for this repo; the
contracts only provide the request lifecycle the backend drives.

---

## 2. Contract-level changes

| `master` | `noRedeem` | Why |
|---|---|---|
| `OkuMoney.sol` (426) | **`OkuM.sol`** (489) | Renamed. Gains ERC-8056 display, 4626-shaped value views, `epoch`, `MAX_STEP_BPS`, halt/resume, `MAX_TOTAL_SUPPLY`, `allowanceUI`. Loses `distributeYield` and the sandwich stamp |
| `OkuDollar.sol` (808) | **`USDOku.sol`** (550) + **`USDOkuWrapper.sol`** (304) | **Split in two.** One contract both rebased *and* held reserves; now the ledger/index and the conversion/solvency logic are separate concerns |
| `LitePSM.sol` (477) | **`SubscriptionModule.sol`** (610) | Replaced, not renamed. Atomic swap → request lifecycle. The PSM name was wrong anyway: nothing here is pegged |
| `RedemptionQueue.sol` (375) | **deleted** | Ordering is now an off-chain policy decision |
| `YieldSandwichGuard.sol` | **deleted** | Guarded a same-block sandwich against a permissionless actor that no longer exists |
| `SafeApprove.sol` | **deleted** | Genuinely dead — 0% coverage, imported nowhere. Served the old approve/do/revoke pattern |
| `lib/events/*.sol` (4) | **deleted** | Events moved onto their contracts |
| — | **`ScaledUIAmountUpgradeable.sol`** | New: ERC-8056 core + all three extensions |
| — | **`OkuMultiplierAdapter.sol`** | New: Chainlink-shaped read of `uiMultiplier()`, immutable and non-upgradeable |
| — | **`interfaces/erc8056/*`** (4) | New: real interfaces so `type(I).interfaceId` is assertable |

Net: 17 → 18 source files, ~3,034 LOC. Roughly 80% of the contract code is new.

---

## 3. What was removed, and the reasoning

Each of these existed to constrain a permissionless actor on a pricing path:

- **Redemption queue** — FIFO, cursor, `advanceHead`, soft-skip paths, per-entry
  fee snapshots, `WouldStrandQueue`. Permissionless redemption could exceed
  buffer capacity, so excess had to queue *fairly*. The backend simply does not
  fulfil until liquid.
- **Sync window** — `lockedUntil`, `MAX_SYNC_WINDOW`, clamp-vs-revert. A
  multiplier tick is not atomic across chains; mid-propagation an actor could
  mint on one chain and redeem on the other. Every cross-chain value path is now
  backend-controlled. **The residual operator risk is real and unbounded by
  contract** — see Limitation 11.
- **Step-arbitrage defence** — step-coverage invariant, `stepHighWaterMark`,
  `MIN_STEP_COVERAGE`. A permissionless round-trip across a discrete `M_oku` step
  extracted the step unless fees covered it. No permissionless round trip exists.
- **Standing USDC buffer** — `depositBuffer`, `withdrawUsdc`, `redeemableNow`.
  Fulfilment pulls from treasury at execution time.
- **Yield-sandwich guard**, **collateral-ratio config** (`setMinCollateralRatio`,
  `MIN_COLLATERAL_RATIO_FLOOR`), **`MAX_RATE`**, and **`setNextUsdYieldRate`**
  (calling `setUsdOkuRate` before `rateEnd` already extends with no gap or step).
- **`MIN_REQUEST_AMOUNT`** — never shipped. Its anti-dust rationale was a queue
  artefact: the request slot is the *user's own*, so dust blocks only them, and
  an ignored request costs the operator nothing. Replaced by a zero-output revert.

Roles dropped: all six queue/buffer roles, plus `VAULT_ADMIN` and
`VAULT_RESERVE_MANAGER`.

---

## 4. What was added

**Reviewed conversion.** `requestSubscription` / `requestRedemption` escrow the
input; `fulfill*` / `rejectRequest` / `cancelRequest` resolve it. One pending
request per `(user, direction)` — a mapping, not a queue.

> **The single most important rule: pricing happens at fulfilment, never at
> request.** Pricing at request time would hand every requester a free option —
> submit, watch the multiplier, cancel if it moves against you. That would
> reintroduce step arbitrage *inside the mechanism meant to prevent it*. There is
> a differential test against a mutant that prices at the request block.

**ERC-8056 on OkuM.** Interface IDs verified against the published EIP. The
implementation deliberately fixes a defect in the EIP's reference implementation,
which branches on `>` in the setter while resolving on `>=` in the view, so a
matured pending value can be silently lost.

**Two-key separation.** `OKU_RATE_SETTER` (can misprice, cannot convert) and
`REQUEST_FULFILLER` (can convert, cannot misprice) are distinct roles. A security
property the permissionless design could not have.

**Pre-funded yield.** See §5 — the most consequential design change.

**Fees.** `tin`/`tout` are new; `master`'s PSM had none. They are now purely
commercial, not a safety mechanism.

---

## 5. The two design decisions that changed most

### `MAX_SOLVENCY_GAP_BPS = 0` — forward yield must be pre-funded

Originally specified as a tunable ~1% band. Set to **zero**, which turns
`backing >= liability` from a monitoring threshold into a **maintained
invariant**: every rate write establishes it by projection to `rateEnd`, `wrap`
floors the share credit (building surplus), and `unwrap` ceils the share burn.
Rounding favours the invariant in both directions.

This closed a defect the fuzzer would otherwise have shipped: previously a
holder's grown USDOku balance **exceeded the backing**, so unwrapping in full
reverted — earlier exiters paid in full, last one out stranded. The doc claimed
the gap was "funded by the buffer"; no buffer existed.

Cost: the issuer funds forward yield before declaring it. Benefit: a displayed
USDOku balance is always redeemable, the farming question reduces to a
distribution question with no solvency stake, and `withdrawSurplus` becomes safe
to expose.

### `wrap` is gated on *projected* solvency

**Found by the stateful-fuzz suite, not by inspection.** `setUsdOkuRate` projects
liability using shares outstanding *at write time*; a `wrap` mid-segment adds
shares that then accrue unfunded. The fuzzer caught the invariant failing by
~0.0072%. Fixed via `projectedLiabilityAtRateEnd()`.

**Consequence needing a product decision:** `wrap` is permissionless and can now
revert when the issuer has not funded headroom for new entrants — a user is
refused because of issuer behaviour, not their own.

---

## 6. Bugs found and fixed on this branch

| Bug | Severity | Found by |
|---|---|---|
| `uiMultiplier()` returned **0** on a freshly deployed token — every conversion returned zero or divided by zero | **Critical** — token bricked from deployment | Reasoning about an unrelated overflow |
| `backingCoversLiability` broken by mid-segment `wrap` | High | Stateful fuzz |
| Grown USDOku balance not fully redeemable | High | Targeted test |
| `setUsdOkuRate` locked itself out once breached — could not even stop accrual | Medium | Spec review |
| `setOkuMultiplier` pause-gated, removing the solvency remedy during an incident | Medium | Spec review |
| `wrap` checked slippage against a pre-rounding value | Low | Spec review |
| `allowanceUI` reverted on infinite approvals | Low | Spec review |

---

## 7. Testing

| | `master` | `noRedeem` |
|---|---|---|
| Test files | 40 | 19 |
| Tests | ~546 | **196** |
| `src/` line coverage | ~unknown | **99.24%** (95% gate passes per-file) |
| Branch coverage | — | 86.32% |
| Invariants | 18 (single-contract) | **13 system-wide**, adversarial handler, 128k calls each |
| Differential mutants | 0 | **2, verified lethal by sabotage** |

Fewer tests, more coverage — the old suite was spread across four contracts with
significant duplication. The two mutants prove the load-bearing rules
(fulfilment pricing; `M_oku` not `M_usd` in the wrapper) rather than asserting
them, and each test first asserts its fixture is non-degenerate so it cannot pass
vacuously.

The invariant suite paid for itself immediately by finding the `wrap` hole.

---

## 8. Infrastructure

- **`v0.2` → `v0.3`**, address books wiped. Every ERC-7201 namespace changed, so
  `master` proxies **cannot be upgraded into this** — it needs a fresh deploy.
- **UUPS upgrade safety validated** — all four implementations pass OZ's
  validator with ERC-7201 namespaced storage under `hardhat-upgrades` 3.9.0.
  This had never been run on `master`'s new namespaces.
- **Scripts**: 30 of 38 files rewritten. Buffer/queue/collateral CLIs deleted;
  `setOkuMultiplier`, `setUsdOkuRate`, `fundWrapper`, `withdrawSurplus`,
  `solvencyStatus`, `fulfillRequest`, `rejectRequest`, `haltAccrual` added.
- **ERC-7730 clear-signing metadata** — new. All 64 state-changing functions plus
  two ERC-2612 messages, generated from the compiled ABI, with a local validator
  covering what the registry linter skips on proxies (it has a heuristic that
  silently disables field validation for proxy contracts).
- **`DISPLAY_CONVENTION.md`** — new, normative.
- **Sourcify verification** added alongside Etherscan.
- **CI fix**: the coverage gate was measuring OpenZeppelin's coverage in its
  `Total` row; `node_modules/` and `lib/` are now excluded. A missing
  `[profile.ci]` in `foundry.toml` was also silently falling back to defaults.

---

## 9. Known gaps

**Blocking:** ERC-7730 registry submission is deployment-gated. Needs the
official entity name and a canonical URL of ≤26 characters (Ledger truncates).

**Before audit:** mark cadence confirming `MAX_STEP_BPS`; `MAX_IMPLIED_APR_BPS`;
`OKU_GUARDIAN` warm-vs-cold plus the newly-introduced `OKU_ACCRUAL_RESUMER`;
the `wrap` gating consequence in §5.

**Accepted, documented:** pausing OkuM blocks `unwrap` (the transfer passes
through `_update`'s pause check); `setUsdOkuRate` has no in-breach taper, only a
full stop; a device cannot render the rate as an APR.

**Out of sync:** SVM has not adopted the pivot — it still has `distribute_yield`,
no `epoch`, and mirrors the old constants. The root `README.md` still documents
the retired design.

---

## 10. Reviewer orientation

Read in this order:

1. **`EVM/README.md` §Design** — the premise and what reviewed conversion buys
2. **`EVM/src/subscription/SubscriptionModule.sol`** — the request lifecycle
3. **`EVM/test/Differential.t.sol`** — the two rules the design rests on
4. **`EVM/test/SystemInvariants.t.sol`** — what is claimed to hold always
5. **`EVM/metadata/DISPLAY_CONVENTION.md`** — the integration hazard

Fastest way to see it work: `FORK_NETWORK=sepolia npx hardhat node`, then
`npx hardhat run scripts/deploy/index.ts --network localhost` and
`npx hardhat run scripts/test/test-onchain.ts --network localhost`, which drives
the full lifecycle and prints the solvency invariant at each step.
