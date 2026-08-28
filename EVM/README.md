# OkuDollar — EVM Implementation

> See [`../README.md`](../README.md) for shared architecture and cross-VM design.

Solidity contracts for the OkuDollar system: a fully-backed yield-bearing share
token (**OkuM**) and a dollar-denominated rebasing wrapper over it (**USDOku**),
backed by US Treasury Bills.

**Two tokens. Two multipliers. Reviewed subscription and redemption.**

---

## Design

Three decisions define this system. Everything else follows from them.

1. **Two tokens**, because a single index cannot express both a *realized*
   claim on off-chain yield and a *smoothed forward-looking* dollar balance.
2. **OkuM carries ERC-8056**, so a display-aware surface can render dollars
   without a wrapper.
3. **Subscription and redemption are reviewed, not permissionless.** Every
   USDC ↔ token conversion is a two-phase request the backend fulfills after
   off-chain review.

| | **OkuM** | **USDOku** |
|---|---|---|
| Balance semantics | Fixed raw balances | Rebasing |
| Denomination | Shares | Dollars (1 USDOku = $1) |
| Accrual | **Stepwise** — discrete marks from realized RWA performance | **Continuous** — smoothed declared rate |
| Direction | Rear-facing (what was earned) | Forward-facing (what is being paid out) |
| Backing | **Fully backed** — hard invariant | **Fully backed** — forward yield is pre-funded |
| Chains | EVM + SVM | **EVM only** |
| ERC-8056 | **Yes** | **No** — see below |
| Transfers | Permissionless | Permissionless |
| Subscribe / redeem | **Reviewed** | **Reviewed** |
| Wrap / unwrap | — | **Permissionless** — see [the farming question](#the-farming-question) |
| Lifecycle | Permanent | **Transitional** |

```
   realized backing (off-chain T-Bills, attested)
                    │
                    ▼
   ┌────────────────────────────────────────────────┐
   │  OkuM — fixed raw balances, stepwise index     │
   │                                                 │
   │  balanceOf(u)          = 954.20    (raw, fixed) │
   │  uiMultiplier()        = 1.048e18  (M_oku)      │  ← ERC-8056 + 4626 views
   │  balanceOfUI(u)        = $1,000.00              │     read the SAME number
   │  convertToAssets(1e18) = 1.048000  (USDC, 6dp)  │
   └────────────────────────────────────────────────┘
          ▲                              │
          │ reviewed                     │ permissionless
          │ (request → fulfill)          │ wrap / unwrap at M_oku
          │                              ▼
   ┌──────────────┐        ┌────────────────────────────────────┐
   │ USDC         │        │  USDOku — rebasing, dollars         │
   │ (treasury)   │        │  balanceOf = shares × M_usd         │
   └──────────────┘        │  1 USDOku = $1.00, by definition    │
                           │  NO uiMultiplier — balanceOf IS the │
                           │  dollar view                        │
                           └────────────────────────────────────┘
                                          │
                                          ▼
   solvency gap = Σ USDOku − (OkuM held by wrapper × M_oku)
   MAX_SOLVENCY_GAP_BPS = 0: forward yield is pre-funded, so gap <= 0 always
```

### What reviewed conversion buys

This is the largest simplification in the design, and it is worth being explicit
about what it removes rather than letting the absence pass unnoticed.

With no permissionless mint or redeem, **there is no permissionless actor on any
pricing path.** Transfers move raw units and price nothing. Bridges are
backend-operated burn-and-mint. Subscription and redemption are backend-fulfilled.

Deleted outright, relative to the permissionless design:

| Removed | Why it existed | Why it is gone |
|---|---|---|
| `RedemptionQueue.sol` — FIFO, cursor, `advanceHead`, soft-skip paths, per-entry fee snapshots, `sweepExcess`, `WouldStrandQueue` | Permissionless redemption could exceed buffer capacity, so excess had to queue fairly | The backend simply does not fulfill until liquid. Ordering is an off-chain policy decision, not an on-chain fairness problem |
| **Sync window** — `lockedUntil`, `duration`, auto-arm, clamp-vs-revert, `MAX_SYNC_WINDOW`, `MIN_SYNC_WINDOW_GAP`, `DEFAULT_SYNC_WINDOW` | A multiplier tick is not atomic across chains; mid-propagation an actor could mint on one chain and redeem on the other | Every cross-chain value path is now backend-controlled. The window was on-chain enforcement of something the backend does directly |
| **Step-arbitrage defence** — step-coverage invariant, `stepHighWaterMark`, `reset_step_high_water_mark`, `MIN_STEP_COVERAGE` | Permissionless round-trip across a discrete `M_oku` step extracted the step unless fees covered it | No permissionless round trip exists. The backend declines or delays a request that straddles a mark |
| **Standing USDC buffer** — `depositBuffer`, `withdrawUsdc`, `redeemableNow`, buffer accounting | Instant redemption needed pre-positioned liquidity | Fulfillment pulls USDC from treasury at execution time |

What that leaves: **one epoch counter** for cross-chain reconciliation, no lock.

Retained deliberately, because reviewed conversion does *not* address them:

- The **double-count hazard** — an integration bug, not an arbitrage.
- The **solvency gap** — an accounting property of the two-index design.
- **Max-send rounding** — inherent to scaled display and to rebasing.
- **Allowance drift** — a property of raw-denominated approvals.
- **Monotonicity** and the rate-authority bounds — a compromised setter key is
  still a compromised setter key.

### Why two tokens, and the honest cost

One token and one multiplier cannot express a forward-looking smoothed payout
*and* a rear-facing realized claim. Collapsing them means either the payout is
chunky (bad UX) or the realized claim is smoothed (dishonest about backing).

The cost is real:

- **USDOku rebases**, so `balanceOf` changes with no transfer to observe. That
  breaks AMM pools, balance snapshots, and most lending markets. Acceptable only
  because USDOku is never intended for those venues — OkuM is the composable leg.
- **Two tokens is cognitive overhead.** Users must know which they hold.
  Unwrapping is an extra transaction on power-user paths.
- **Liquidity fragmentation** across two assets in secondary DeFi.

The countervailing fact: a rebasing `balanceOf()` displays correctly in **every
wallet ever written**, with zero integration. ERC-8056 requires each integrator
to opt in. Support today exists on BscScan, Mantlescan, Fordefi, TokenPocket, and
Base's enshrined B20 standard (landing at the next hardfork) — and **not** in
MetaMask, Rabby, Uniswap's interface, or 1inch's.

USDOku covers that gap while it closes. It is expected to be deprecated.

### USDOku is transitional

Stated at launch, deliberately. When ERC-8056 display support reaches the wallets
our users actually hold, OkuM alone delivers the same experience.

Sunset path:

1. Disable `wrap` (OkuM → USDOku). `unwrap` stays open indefinitely.
2. Announce a redemption window with a **hard end date**, wrapper fully funded
   throughout.
3. After expiry, hold residual backing for direct off-chain claims.

**Do not** wind down by draining the wrapper to force insolvency. That terminates
the liability by making redemption fail for whoever is last in line — a bank run
with a published starting gun, and a materially different act for a licensed
issuer than a noticed wind-down.

Track `USDOku.totalSupply()` as a first-class metric with an agreed deprecation
threshold, so the decision is data-driven rather than re-litigated.

### Naming

**No `r` or `s` prefix on either ticker.** `r` reads as *rebasing*, which is
precisely backwards for OkuM. `s` implies a wrapper you unwrap into — true today,
false after sunset. There is no established Solana convention prefixing
scaled-UI-amount mints; do not claim one.

`OkuM` is the share, `USDOku` is the dollar wrapper. One name per contract,
consistently, in code and docs.

---

## The two multipliers

Everything downstream depends on these staying distinct.

### `M_oku` — OkuM's realized index

Dollars per raw OkuM. **Stepwise.** Written when off-chain RWA performance is
marked. Exposed **twice**, through two interfaces reading the identical number:

| Layer | Functions | Consumers |
|---|---|---|
| **Display** (ERC-8056) | `uiMultiplier`, `balanceOfUI`, `totalSupplyUI`, `toUIAmount`, `fromUIAmount` | Wallets, explorers, trackers |
| **Value** (4626-shaped) | `convertToAssets`, `convertToShares`, `asset`, `totalAssets` | Lending markets, AMM rate providers |

A **bound, not an equality**, holds them together at every block:

```
convertToAssets(1e18) × usdcDecimalMultiplier
    <= uiMultiplier()
    <  (convertToAssets(1e18) + 1) × usdcDecimalMultiplier
```

`convertToAssets` returns USDC at 6 dp — it must, to be 4626-semantically
correct — while the multiplier is 18 dp. Related by a floor, so
`convertToAssets(1e18) == uiMultiplier()` is dimensionally impossible; any fuzz
test written against equality fails immediately.

Corollary worth writing down rather than discovering: **`convertToAssets` and
`convertToShares` are not inverses.** A round trip quantizes to USDC
granularity, losing up to `1e12` in 18-dp terms. Fine for a lending market
pricing collateral; fatal for anything treating it as exact.

### `M_usd` — USDOku's declared rate

The **continuous** smoothed rate driving USDOku's rebase. Computed from
`baseIndex`, `ratePerSecond`, `lastAccrualTime`, `rateEnd` — the Aave
liquidity-index / `sDAI` `chi` pattern.

`M_usd` is **not** dollars per share. It is the rebase index: a holder's balance
is `shares × M_usd / PRECISION`, and each USDOku is $1 by definition.

### Why the granularity differs

Stated once, here, so no section contradicts another:

- **`M_oku` is stepwise on both chains.** T-Bill performance is a discrete mark,
  not a rate-per-second. Publishing it continuously would make it
  forward-looking — which is USDOku's job. Token-2022 additionally forbids
  `ScaledUiAmount` alongside `InterestBearingConfig`, so SVM is stepwise by
  construction regardless.
- **`M_usd` is continuous, EVM-only.** Smoothing is the point; a smoothed rate
  arriving in jumps would be neither smooth nor forward-looking.

Two consequences, both favourable in this design:

**The step needs no defence.** In a permissionless system a discrete `M_oku`
step is an arbitrage surface — mint at `M0`, redeem at `M1`. Reviewed conversion
removes it: the backend declines or delays a request that straddles a mark. This
is why `tin`/`tout` are commercial parameters here and not a safety mechanism.

**EVM/SVM granularity divergence is gone.** Both chains step, same value, same
cadence, and epoch equality is externally verifiable. This was a standing
limitation of the single-token design.

---

## Solvency

The most important section. USDOku's declared rate is forward-looking, so its
liability runs ahead of what realized T-Bill performance has already marked. The
design resolves this by **pre-funding**: the issuer must place the forward yield
in the wrapper *before* declaring the rate that pays it. Smoothing survives; it
just has to be funded rather than promised out of future returns.

### The three quantities

```
liability = USDOku.totalSupply()                            // dollars, 1:1
backing   = OkuM.balanceOf(wrapper) × M_oku / PRECISION      // dollars, realized
gap       = liability − backing                              // may be > 0
gapBps    = gap × 10_000 / backing
```

All exposed on-chain by `USDOkuWrapper`:

```solidity
function declaredLiability() external view returns (uint256);
function realizedBacking()   external view returns (uint256);
function solvencyGapBps()    external view returns (int256);   // signed
function backingRatioBps()   external view returns (uint256);
```

### The bound

`MAX_SOLVENCY_GAP_BPS` is **zero**, and a **constant, not a config field**. No
key widens it.

That single value is what turns `backing >= liability` from a monitoring
threshold into a **maintained invariant**:

- every `setUsdOkuRate` establishes it, by projection to `rateEnd`;
- `wrap` moves both sides by the same dollar amount but **floors** the share
  credit, so it builds a small surplus;
- `unwrap` **ceils** `sharesToBurn`, so liability falls at least as fast as
  backing.

Rounding therefore favours the invariant in both directions. Two consequences
follow directly, and both are asserted in the suite: **`unwrap` can never revert
for want of reserves**, and `withdrawSurplus` is safe to expose because it can be
gated on the same inequality.

`setUsdOkuRate` reverts `SolvencyGapExceeded` if the projected gap at `rateEnd`
would breach it. This is the check that makes the declared rate honest: you
cannot promise a rate the realized backing cannot fund. Because it is
a **projection to `rateEnd`**, it cannot be breached mid-segment by the passage of
time alone — the same technique `MAX_MULTIPLIER` uses.

**`setUsdOkuRate` is the only live call site.** `wrap` is *not* gated on the
bound, because it cannot breach it: a wrap moves liability and backing by the
identical dollar amount and floors the share credit, so the **absolute surplus**
`backing − liability` can only grow. A check there would be unreachable code.

Note the assertion is on the absolute surplus, not on `solvencyGapBps()`. That
view is a *ratio*, and adding equal amounts to both sides dilutes it toward zero
— a healthy surplus position legitimately sees `gapBps` rise (say −115 → −19bps)
on a large wrap while the surplus itself is untouched. Tests written against the
ratio will produce confusing failures.

### Operating the pre-funded rate

Defined behavior, not improvisation:

| Condition | Action | Who |
|---|---|---|
| Declaring a new forward rate | Transfer the projected yield into `USDOkuWrapper` **first**, then `setUsdOkuRate` | Cold multisig, then orchestrator |
| Rate declared without funding | `setUsdOkuRate` reverts `SolvencyGapExceeded` | Contract |
| Funding lapses / rate cannot be renewed | `setUsdOkuRate(PRECISION, ...)` — a full stop is always permitted | `OKU_RATE_SETTER` |
| Incident, need an immediate freeze | `haltUsdOkuAccrual()` — no timelock | `OKU_GUARDIAN` (warm) |
| Funding no longer needed (rate halted, or `M_oku` caught up) | `withdrawSurplus` — gated on post-withdrawal `backing >= liability` | `WRAPPER_ADMIN` (cold) |

Under a zero bound a shortfall should be **unreachable in normal operation**: it
would require `M_oku` to fall, which monotonicity forbids, or a defect in
`withdrawSurplus`, which checks before it transfers.

**The full-stop escape hatch.** `setUsdOkuRate` skips the solvency check entirely
when `newRate == PRECISION`. That case is provably non-worsening — `rpow` at
`PRECISION` is the identity, so the projected index equals the live index and the
projected liability equals the current liability. It must always be available:
when funding lapses, switching accrual *off* is the correct response and cannot
itself be blocked by a funding shortfall. It also means a stop works before
`setWrapper` has been wired, since the `WrapperNotSet` revert lives inside the
skipped check.

**There is no "taper while short" path, by design.** Any `newRate > PRECISION`
projects a larger liability and must therefore be pre-funded like any other rate.
The contract has no view of the realized (`M_oku`) growth rate, so it cannot
distinguish a gap-closing positive rate from a gap-widening one, and does not
try. Stop, fund, then re-declare.

`M_usd` is **monotone** — the rebase index never decreases. Accrual is slowed or
stopped, never written down. See Limitation 4.

### OkuM's invariant is hard

```
OkuM.totalSupply() × M_oku / PRECISION <= attestedAssets
```

`attestedAssets` is off-chain-sourced (Limitation 2), so this is a
*reconciliation* invariant checked by monitoring, not an on-chain revert. But it
is the line that must not move: **OkuM holders are senior and their claim is not
subordinated to USDOku's smoothing.** If the buffer is exhausted, the correct
action is to halt `M_usd` — not to let USDOku unwrap into OkuM backing someone
else's claim.

### The farming question

**Largely resolved by pre-funding — but read the residual below.**

Wrap and unwrap are permissionless, and both indices are public. So the round
trip

```
t0:  wrap R OkuM   → R × M_oku(t0) USDOku
     hold — balance grows at M_usd
t1:  unwrap        → R × M_oku(t0) × [M_usd(t1)/M_usd(t0)] / M_oku(t1) OkuM
```

is profitable **exactly when `M_usd` outgrew `M_oku` over `[t0, t1]`** — which is
the intended mechanism by which USDOku holders receive smoothed yield, and also a
strategy anyone can time deliberately. A sophisticated actor wraps only while
declared outruns realized and unwraps before it catches up, capturing the gap
that the buffer funds.

Under pre-funding this changes character substantially. Every dollar available
to extract was **deliberately placed in the wrapper by the issuer** as funding
for declared yield. There is no unfunded subsidy to race for and no shortfall
that a timer can create — extraction is ordinary yield distribution, and the
issuer controls its size directly by controlling how much it funds and at what
rate.

**The residual, which is a distribution question rather than a solvency one:**
funded yield is still claimed by whoever holds USDOku across the accrual window,
so a holder who wraps late and unwraps early captures more per unit time than a
patient holder. That is a fairness and marketing consideration, not a risk to
backing, and it is bounded by the funding the issuer chose to provide.

If that distribution is judged unacceptable, the original options still apply —
an unwrap fee, a minimum holding period, or reviewing `wrap`/`unwrap` — but none
is now required for safety.

---

## Subscription and redemption

Reviewed, two-phase, symmetrical in both directions.

### Lifecycle

```
  user                        contract                      backend
   │                              │                             │
   ├─ requestSubscription ───────▶│  escrow USDC                │
   │  (usdcAmount, minOut)        │  status = Pending      ─────▶│  review
   │                              │                             │
   │                              │◀──── fulfillSubscription ───┤  approve
   │◀─ OkuM minted at live M_oku  │      (id)                   │
   │                              │                             │
   │                              │◀──── rejectRequest ─────────┤  decline
   │◀─ USDC refunded              │      (id, reason)           │
   │                              │                             │
   ├─ cancelRequest ─────────────▶│  after MIN_CANCEL_DELAY     │
   │◀─ USDC refunded              │                             │
```

```solidity
// Request — permissionless, escrows the input
function requestSubscription(uint256 usdcAmount, uint256 minOkuMOut) external returns (uint256 id);
function requestRedemption(uint256 okuMAmount, uint256 minUsdcOut) external returns (uint256 id);
function cancelRequest(uint256 id) external;              // after MIN_CANCEL_DELAY

// Fulfillment — REQUEST_FULFILLER
function fulfillSubscription(uint256 id) external;
function fulfillRedemption(uint256 id) external;
function rejectRequest(uint256 id, bytes32 reasonCode) external;

// Views
function getRequest(uint256 id) external view returns (Request memory);
function pendingRequestOf(address user, Direction d) external view returns (uint256 id);
function quoteSubscription(uint256 usdcAmount) external view returns (uint256);
function quoteRedemption(uint256 okuMAmount) external view returns (uint256);
```

### Pricing at fulfillment, never at request

**The single most important rule in this module.** A request records the *input
amount* and a *minimum output*. Pricing happens at fulfillment, against the live
`M_oku`.

Pricing at request time would hand every requester a **free option**: submit,
watch the multiplier, cancel if it moves against you, let it fulfill if it moves
in your favour. That reintroduces exactly the step arbitrage that reviewed
conversion was supposed to eliminate — and reintroduces it *inside* the
mechanism meant to prevent it.

`minOut` is the user's protection against an adverse move while they wait.
Fulfillment reverts `SlippageExceeded` if the live price would deliver less.
`MAX_REQUEST_AGE` bounds how long a request can sit before it must be refreshed.

```
subscribe:  okuM = (usdcAmount × dm) × PRECISION / M_oku(fulfillment)
redeem:     usdc = (okuM × M_oku(fulfillment) / PRECISION) / dm
```

### One pending request per user per direction

A `mapping(address => mapping(Direction => uint256))`, not a queue. O(1),
no cursor, no head-walking, no ordering fairness to enforce on-chain — because
ordering is now an off-chain policy decision.

A user with a pending request must let it resolve or cancel it before submitting
another. Institutional flows needing concurrency should use separate addresses;
this is deliberate, and it is why there is no `RedemptionQueue.sol`.

There is deliberately **no** `MIN_REQUEST_AMOUNT`: the slot is the user's own, so
dust in it blocks only that user, and an ignored request just expires at no cost
to the operator. A request whose output would round to zero reverts
`AmountTooSmall` at fulfillment. See [Constants](#constants).

### Cancellation is delayed, rejection is not

`cancelRequest` is only callable after `MIN_CANCEL_DELAY`. Without the delay, a
user could submit and cancel within the same block window to probe fulfillment
timing, or race a fulfillment transaction to grief the operator's gas.

`rejectRequest` is immediate and carries a `reasonCode` — an opaque `bytes32`
resolved off-chain, so no compliance detail lands on-chain.

### Escrow

Input sits in the module, not in treasury, until fulfillment or refund. Two
invariants, both **bounds** because token donations are unpreventable:

```
Σ pending subscription escrow  <= USDC.balanceOf(module)
Σ pending redemption escrow    <= OkuM.balanceOf(module)
```

`sweepToken` recovers the surplus, capped at `balanceOf − Σ escrow`, so it
provably cannot touch a user's escrowed input. It **refuses** to sweep below
escrow rather than reverting on the whole call.

### No standing buffer

`fulfillRedemption` pulls USDC from `treasury` via allowance at execution time.
There is no on-chain buffer to size, deposit into, withdraw from, or strand — the
backend decides liquidity off-chain and fulfills when it can. This is the direct
consequence of dropping instant redemption, and it removes `depositBuffer`,
`withdrawUsdc`, `redeemableNow`, and `WouldStrandQueue` entirely.

If the treasury allowance is insufficient, fulfillment reverts
`InsufficientTreasuryAllowance` — a loud operational failure, not a silent
partial fill.

### ERC-7540 alignment

This request/fulfill pattern is what **ERC-7540 (Asynchronous ERC-4626 Tokenized
Vaults)** standardizes, and it exists for precisely this case: vaults where
fulfillment requires off-chain action. ERC-7540 is **Final** (created
2023-10-18), not a draft, and it `Requires` ERC-7575.

**We do not claim ERC-7540 compliance** — `supportsInterface` returns false for
all four of its IDs, asserted in the suite. Three blocking incompatibilities,
stated precisely rather than hand-waved:

1. **ERC-7540 mandates a pull-based Claim and explicitly forbids push:** "Vaults
   MUST NOT 'push' tokens onto the user after a Request, users MUST 'pull' the
   tokens via the Claim function." Our `fulfillSubscription` pushes OkuM straight
   to the user, so there is no Claimable state to claim from. This is structural,
   not cosmetic.
2. **ERC-7540 has no cancellation or rejection concept** — both are explicitly
   deferred to a future EIP — and both are central here.
3. **ERC-7540 requires ERC-7575** (the `share` method), which does not apply:
   OkuM is not a vault share of the module.

What we *do* adopt, because it is free and genuinely useful:

| Adopted | Detail |
|---|---|
| `DepositRequest` / `RedeemRequest` events | ERC-7540's exact names **and** exact field shapes, so a 7540 indexer reads our request logs unmodified. `controller` and `owner` are both the requesting user (no operator delegation); `sender` is the caller |
| `pendingDepositRequest(requestId, controller)` · `pendingRedeemRequest(...)` | Exact 7540 signatures and semantics. `requestId == 0` is 7540's "aggregate for this controller" convention |
| `claimableDepositRequest` · `claimableRedeemRequest` | Present and hard-wired to **0**, which is the truthful answer given we push. Better than a missing-function revert |
| `requestId` naming | Throughout, including return values |

What we deliberately **do not** adopt: renaming `requestSubscription` /
`requestRedemption` to `requestDeposit` / `requestRedeem`. ERC-7540's signature is
`requestDeposit(assets, controller, owner)`; ours carries a load-bearing `minOut`
instead. Taking the spec's *name* with a different signature and push semantics
would invite exactly the false-recognition failure described under
[OkuM's token surface](#okum) for ERC-4626 — an integrator detects the name and
assumes the behaviour.

One consequence worth flagging: ERC-7540's event shape has no slippage field, so
`minOut` does **not** appear in the request logs. It is readable via
`getRequest(requestId)`, and `RequestFulfilled` carries the actual `amountOut`,
so realised slippage stays auditable from logs alone.

### Fees

`tin` / `tout`, bounded by `MAX_FEE_BPS` (100 = 1%), default **0**.

**These are commercial parameters, not a safety mechanism.** In the
permissionless design `tout` was load-bearing — it was the control that made
step arbitrage unprofitable, and it carried a step-coverage invariant binding it
to the size of each `M_oku` mark. None of that applies now. There is no
permissionless round trip to price against, so the fee schedule is purely a
revenue decision.

Arithmetic is inherited verbatim from
[`dss-lite-psm`](https://github.com/makerdao/dss-lite-psm):

```
subscribe: credited = usdcAmount − ceil(usdcAmount × tin  / 10_000)
redeem:    paid     = gross      − ceil(gross      × tout / 10_000)
```

Fees are **withheld, not forwarded** — no recipient, no sweep, so a fee raises
the collateral ratio. Fees round up, payouts round down, per the library-wide
protocol-favouring policy. Fees are applied at **fulfillment**, and the rate in
force at fulfillment is the one charged; `minOut` is the user's protection
against a fee change while they wait, which is why no per-request fee snapshot
exists.

---

## Rate authority

Two setters, both on the orchestrator key.

```solidity
// OkuM.sol — the realized step. Both chains.
function setOkuMultiplier(uint256 newMultiplier, uint256 epoch) external;  // OKU_RATE_SETTER

// USDOku.sol — the declared smoothed rate. EVM only.
function setUsdOkuRate(uint256 ratePerSecond, uint256 endTimestamp) external;  // OKU_RATE_SETTER
```

`setOkuMultiplier` writes a discrete value with an orchestrator-assigned `epoch`.
`setUsdOkuRate` snapshots `baseIndex = usdOkuIndex()`, sets `lastAccrualTime`,
then writes rate and end — so calling it before `rateEnd` extends accrual with
**no gap and no step**, which is why no pending-rate staging field exists.

### Constraints

**`setOkuMultiplier`:**

| Constraint | Error |
|---|---|
| `newMultiplier >= currentMultiplier` (monotone) | `MultiplierCannotDecrease` |
| Step size `<= MAX_STEP_BPS` | `StepAboveMaximum` |
| `newMultiplier <= MAX_MULTIPLIER` | `MultiplierAboveMaximum` |
| `epoch > lastEpoch` | `EpochNotIncreasing` |

**`setUsdOkuRate`:**

| Constraint | Error |
|---|---|
| `ratePerSecond >= PRECISION` (monotone) | `IndexCannotDecrease` |
| Annualized `<= MAX_IMPLIED_APR_BPS` | `RateAboveMaximum` |
| `endTimestamp > block.timestamp` | `RateEndNotInFuture` |
| `endTimestamp - now <= MAX_RATE_DURATION` | `RateDurationTooLong` |
| Projected `M_usd` at `rateEnd` `<= MAX_MULTIPLIER` | `MultiplierAboveMaximum` |
| Projected solvency gap at `rateEnd` within bound | `SolvencyGapExceeded` |

**No operation is gated on rate-write state.** There is no sync window, no
window-active revert, no clamp-vs-reject asymmetry. `MAX_STEP_BPS` survives, but
its rationale has changed: it is now an **oracle-sanity bound** against a
compromised setter key writing an absurd step, not an arbitrage control bound to
the fee schedule.

### `MAX_STEP_BPS` no longer constrains cadence

Worth flagging, because the previous draft coupled them. When `tout` had to cover
the step, `MAX_FEE_BPS` (1%) capped the largest coverable step and therefore the
longest safe interval between marks — roughly 2.4 months at a 5% target. That
coupling is gone. Cadence is now purely an operational choice, and
`MAX_STEP_BPS` should be set from *what a plausible mark looks like* rather than
from what a fee can absorb.

### The epoch

`setOkuMultiplier` takes an orchestrator-assigned, strictly-increasing `epoch`
recorded on both chains. `syncEpoch()` is externally readable, so
`syncEpoch()_evm == sync_epoch_svm` remains a verifiable "both chains wrote for
mark N" assertion — checked by
`SVM/oku-programs/scripts/admin/check-sync-parity.ts`.

**This is a reconciliation counter, not a lock.** It blocks nothing. Equal epochs
mean both chains wrote for mark N; they do **not** mean both wrote the same
value. See Limitation 11.

### The setter is an oracle write

The moment any lending market prices off `uiMultiplier()`, a wrong value mints
borrowing power directly. There is no on-chain referent — `totalAssets()` is
*derived from* the multiplier, not measured. ERC-8056's reference implementation
guards only `> 0` and a future timestamp, insufficient for a value-bearing
multiplier.

Controls capping damage from a compromised setter key:

- **`MAX_STEP_BPS`** — ceiling on any single `M_oku` step.
- **`MAX_IMPLIED_APR_BPS`** (1000 bps nominal) + **`MAX_RATE_DURATION`** (30 days) —
  bound `M_usd` via the derived `MAX_USD_RATE_PER_SECOND`. Worst-case
  over-accrual per segment ≈ **0.82%**.
- **`MAX_SOLVENCY_GAP_BPS`** (zero) — declared can never outrun realized at all;
  a rate must be pre-funded to be declarable.
- **Monotonicity** on both — a compromised key can over-accrue but never
  confiscate by writing a multiplier down.
- **`haltAccrual()` / `haltUsdOkuAccrual()`** — `OKU_GUARDIAN` (warm) freezes
  either index immediately, no timelock. Monotone-safe: stops growth without
  reducing anything accrued. `haltUsdOkuAccrual` pulls `rateEnd` to `now` so the
  halted state is unambiguous to an integrator. Reversal is cold-only
  (`OKU_ACCRUAL_RESUMER`), so a compromised warm key cannot un-freeze.
- **Request rejection** — a *new* control this design gains. A compromised rate
  setter cannot be exploited through subscription or redemption without the
  fulfiller key also being compromised. Two-key separation on the value path.

`MAX_SOLVENCY_GAP_BPS` is settled at **zero** (pre-funding) and needs no further
sign-off. `MAX_STEP_BPS` and `MAX_IMPLIED_APR_BPS` ship at concrete, deliberately
conservative values but remain **placeholders pending treasury numbers** — see
[Constants](#constants) and [`../TRACKER.md`](../TRACKER.md).

---

## ERC-8056 on OkuM

| Interface | ID | Claimed |
|---|---|---|
| `IScaledUIAmount` | `0xa60bf13d` | Yes |
| `IScaledUIAmountNewUIMultiplier` | `0x4bd27648` | Yes |
| `IScaledUIAmountConversion` | `0x57854fc3` | Yes |
| `IScaledUIAmountBalances` | `0xd890fd71` | Yes |
| `IERC4626` | — | **No** — conversion views only |
| `IERC7540*` | — | **No** — pattern alignment only |

Because `M_oku` is genuinely stepwise, the pending-multiplier extension fits
**natively** — unlike a continuous design, which has to read `newUIMultiplier()`
as "where a trajectory terminates" and flag the divergence from the EIP's intent.
Steps *can* be scheduled ahead, which is exactly what the extension was built for
and what integrators want for "upcoming adjustment" UI.

> **Current implementation caveat.** `setOkuMultiplier(newMultiplier, epoch)`
> takes no effective-at parameter and writes every step with
> `effectiveAt = block.timestamp` — i.e. steps take effect immediately and are
> not currently scheduled ahead. The storage and views are fully general, so the
> required extension is satisfied and `uiMultiplier() == newUIMultiplier()` holds
> from the block of the write onward; enabling scheduling later is an added
> parameter, not a storage change.

```solidity
function newUIMultiplier() external view returns (uint256);  // the scheduled next step
function effectiveAt()     external view returns (uint256);  // when it takes effect
```

### Conformance

No OpenZeppelin reference implementation exists;
`ScaledUIAmountUpgradeable` is written against the EIP text. Two consequences:

1. **Run against an external conformance suite; do not assert boundary
   conformance from the EIP's reference implementation.** That reference has a
   documented defect at `block.timestamp == effectiveAt` — `uiMultiplier()`
   resolves with `>=` while the setter commits with `>`, so a matured pending
   value can silently revert. The deployed Robinhood `Stock` contract fixes it by
   crystallizing the current multiplier unconditionally on every write. Ours does
   the same; verify against `jumpboxtech/erc-8056-conformance`.
2. **Event-name divergence is real.** The spec names the optional transfer event
   `TransferWithUIAmount`; Robinhood's production contract emits
   `TransferWithScaledUI`. We emit the **spec** name. Indexers built for
   Robinhood Chain will not see ours, and vice versa. Document this for
   integrators rather than letting them find out.

> ERC-8056 is a Standards Track **Draft** (created 2025-10-20). Interface IDs are
> constants in `Constants.sol`, never inline literals, so a spec revision is a
> one-line change. **Budget for one revision.**

### USDOku does not implement ERC-8056

Deliberate. USDOku's `balanceOf` already returns dollars — it rebases. An 8056
multiplier on top would be a **second scaling factor over an already-scaled
balance**, and an aware wallet would apply it twice.

`USDOku.supportsInterface(0xa60bf13d)` returns `false`, asserted in the invariant
suite so no future refactor quietly adds it.

### Beyond the EIP

`allowanceUI(owner, spender)` on OkuM — not in the spec. Allowances are
raw-denominated, so a bounded approval's *dollar* value grows with `M_oku`
(Limitation 7). Exposed on-chain rather than only in the SDK so an explorer or
wallet can warn about a drifted approval without importing anything.

Two deviations from the reference implementation:

1. **`Math.mulDiv`, not naive multiply.** *Not* because this token's balances
   could overflow — they cannot. `MAX_TOTAL_SUPPLY × MAX_MULTIPLIER = 1e57`, some
   1e20× below `type(uint256).max`, enforced in **both** `initialize` and
   `setMaxSupply` (an init-only assertion would evaporate the first time the cap
   moved, and with it the overflow invariant). `mulDiv` earns its place for three
   other reasons: it states the rounding policy explicitly in one reviewable
   place; `toUIAmount` / `fromUIAmount` are public views accepting arbitrary
   `uint256` that no supply bound constrains; and `MathLib` is shared with
   `OkuMultiplierAdapter`, which may read a third-party ERC-8056 token whose
   multiplier is unbounded.

   Stated precisely, because the loose version is wrong in a way that sounds
   right: `mulDiv` extends the safe input domain by exactly `PRECISION` (1e18×),
   from `2²⁵⁶/m` to `2²⁵⁶·1e18/m`. It does **not** make the domain unbounded —
   `toUIAmount(type(uint256).max)` still reverts at `MAX_MULTIPLIER`. Both facts
   asserted in `MulDivBoundsTest`.

2. **`TransferWithUIAmount` only for genuine transfers.** The reference emits
   unconditionally from `_update`, including mint and burn where the counterparty
   UI amount is meaningless. We emit from the same hook gated on
   `from != 0 && to != 0`.

---

## Storage

Namespaced per ERC-7201, one namespace per concern.

```solidity
// erc7201:okumoney.storage.ScaledUIAmount        — OkuM's realized index
struct ScaledUIAmountStorage {
    uint256 multiplier;      // M_oku, current live value
    uint256 newMultiplier;   // Scheduled next step (ERC-8056 pending extension)
    uint256 effectiveAt;     // When newMultiplier takes effect
    uint256 epoch;           // Orchestrator-assigned mark number. Reconciliation only
    bool    accrualHalted;   // OKU_GUARDIAN latch. Blocks further setOkuMultiplier
}

// erc7201:okumoney.storage.OkuM                  — OkuM token policy
struct OkuMStorage {
    address asset;                    // USDC. THE single source of truth for
    uint256 usdcDecimalMultiplier;    // this binding; every consumer cross-asserts
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
}

// erc7201:okumoney.storage.UsdOkuIndex           — USDOku's ledger + declared rate
struct UsdOkuIndexStorage {
    mapping(address => uint256) usdShares;  // the invariant ledger
    uint256 totalUsdShares;
    uint256 baseIndex;        // M_usd anchor, snapshotted at last rate write
    uint256 ratePerSecond;    // Compound per-second (1e18 = no yield)
    uint256 lastAccrualTime;
    uint256 rateEnd;          // Accrual freezes here until the next rate write
    bool    accrualHalted;    // OKU_GUARDIAN latch
    address wrapper;          // Solvency source for setUsdOkuRate. Wired post-deploy
    mapping(address => bool) isBlacklisted;
}

// erc7201:okumoney.storage.USDOkuWrapper         — OkuM <-> USDOku conversion
struct USDOkuWrapperStorage {
    IOkuM   okuM;
    IUSDOku usdOku;
    bool    wrapEnabled;      // Sunset step 1 toggles this. No unwrap equivalent
}

// erc7201:okumoney.storage.Subscription          — request lifecycle
struct SubscriptionStorage {
    IOkuM   okuM;
    IERC20  usdc;
    address treasury;
    uint16  tinBps;
    uint16  toutBps;
    uint256 nextRequestId;    // starts at 1; 0 is the "no pending request" sentinel
    mapping(uint256 => Request) requests;
    mapping(address => mapping(Direction => uint256)) pendingOf;
    uint256 totalEscrowedUsdc;
    uint256 totalEscrowedOkuM;
}

struct Request {
    address       user;
    uint96        amountIn;   // USDC (6dp) or OkuM (18dp) per direction
    uint96        minOut;
    uint40        createdAt;
    Direction     direction;  // enum: Subscribe | Redeem
    RequestStatus status;     // enum: Pending | Fulfilled | Rejected | Cancelled
}
```

The `SyncWindow` namespace is **deleted**. `epoch` moves into
`ScaledUIAmountStorage` as a plain counter.

`Request` packs into **two slots** (160 + 96, then 96 + 40 + 8 + 8). The `uint96`
fields cap an amount at ~7.9e28, which is below `MAX_TOTAL_SUPPLY` (1e33), so
`_openRequest` bounds both `amountIn` and `minOut` explicitly and reverts
`AmountExceedsRequestField` rather than truncating.

**Both `multiplier` and `newMultiplier` are seeded to `PRECISION` at init.**
`uiMultiplier()` resolves `block.timestamp >= effectiveAt ? newMultiplier :
multiplier`, so leaving `newMultiplier` at its zero value would make a freshly
deployed token report a multiplier of **zero** — every conversion would return
zero or divide by zero. `effectiveAt` is likewise seeded to `block.timestamp`, not
left at zero, so `OkuMultiplierAdapter.isAccrualStopped()` does not read as
instantly stale. Both are regression-tested.

`usdcDecimalMultiplier` is derived **once**, in `OkuM.initialize`, from the
deployed USDC's `decimals()`. `SubscriptionModule` reads it from the token and
**asserts `okuM.asset() == usdc`** at `initialize`, reverting `AssetMismatch`.
Independent derivation in more than one contract is a silent pricing-divergence
bug waiting to happen; there is exactly one source of truth and every consumer
proves it agrees. `USDOkuWrapper` does **not** participate: it only ever touches
OkuM and USDOku, both 18dp, so it has no decimal binding to cross-assert.

OkuM's raw balances, allowances and total supply live in OZ's
`ERC20Upgradeable` namespace, untouched. `_mint` and `_burn` are not overridden;
the ledger is stock OpenZeppelin.

`_update` **is** overridden — the only override of OZ's transfer machinery. It
does not touch the ledger: it applies pause and blacklist guards, delegates to
`super._update`, then emits `TransferWithUIAmount`. The guards live there rather
than on `transfer` / `transferFrom` precisely so `_mint` and `_burn` cannot
bypass them — a blacklisted address can neither be minted to nor burn out.

USDOku's rebasing ledger stores **shares** and derives `balanceOf` from
`shares × M_usd`. It does **not** use stock OZ `_balances`.

---

## Contracts

| Contract | Description |
|---|---|
| `src/token/OkuM.sol` | The share token. Stock ERC-20 raw layer + ERC-8056 display layer + 4626 conversion views |
| `src/token/USDOku.sol` | Rebasing dollar wrapper. Share ledger, `M_usd` index. **No ERC-8056** |
| `src/wrapper/USDOkuWrapper.sol` | OkuM ↔ USDOku at `M_oku`. Owns the solvency views |
| `src/subscription/SubscriptionModule.sol` | Reviewed USDC ↔ OkuM. Request / fulfill / reject / cancel |
| `src/lib/ScaledUIAmountUpgradeable.sol` | ERC-8056 core + all three extensions, ERC-165 registration |
| `src/oracle/OkuMultiplierAdapter.sol` | Chainlink `AggregatorV3Interface`-compatible read of `uiMultiplier()`, with bounds and staleness |
| `src/lib/MathLib.sol` | `toUIAmount`, `fromUIAmount`, `usdcToDollars`, `dollarsToUsdc`, `applyFeeCeil`, `impliedAprBps`, `rpow` |
| `src/lib/Constants.sol` | Constants, interface IDs, terminology legend |
| `src/lib/Roles.sol` · `Errors.sol` · `ReentrancyGuardUpgradeable.sol` | Support |
| `src/interfaces/IOkuM.sol` | `IERC20` + the four ERC-8056 interfaces + value-layer anchor + role-gated supply hooks |
| `src/interfaces/IUSDOku.sol` · `IUSDOkuWrapper.sol` | USDOku's share ledger + rate index; the wrapper's four solvency views (read by `USDOku.setUsdOkuRate`) |
| `src/interfaces/erc8056/*.sol` | The four EIP interfaces, one file each. Real interfaces so `type(I).interfaceId` can be asserted against published IDs |
| `metadata/DISPLAY_CONVENTION.md` | **Normative** for anything rendering a balance. ✅ written |
| `metadata/erc7730/*.json` | Clear-signing metadata for hardware wallets. ✅ written — all 64 state-changing functions + 2 ERC-2612 messages. **Generated** from the ABI; submission is deployment-gated |
| `scripts/metadata/*.ts` | Descriptor spec, generator, local validation gate, fixture generator, per-chain sync. Edit `descriptorSpec.ts`, never the JSON |

**Deleted:** `src/psm/RedemptionQueue.sol`, and `LitePSM.sol` is replaced by
`SubscriptionModule.sol` — not a rename. The PSM name was wrong regardless
(nothing here is pegged), and the contract's shape has changed from a swap
facility to a request lifecycle.

Also deleted: `lib/YieldSandwichGuard.sol` (it guarded a same-block sandwich
against a permissionless actor that no longer exists), `lib/events/*.sol` (four
files, folded onto their contracts), and `lib/SafeApprove.sol` — genuinely dead
code at 0% coverage, imported nowhere, left over from the old approve/do/revoke
pattern.

**Stack:** Solidity 0.8.28 / Cancun · Foundry (unit + invariant) + Hardhat
(layout validator + scenarios) · OpenZeppelin v5.6.1 Upgradeable · UUPS proxies ·
ERC-7201 namespaced storage.

Four contracts deploy as UUPS proxies (`OkuM`, `USDOku`, `USDOkuWrapper`,
`SubscriptionModule`). `OkuMultiplierAdapter` is deliberately **immutable and
non-upgradeable** — changing its bounds means deploying a new one and re-pointing
consumers, the correct blast radius for a price feed.

---

## Token surfaces

### OkuM

```solidity
// ERC-8056
function uiMultiplier() external view returns (uint256);
function newUIMultiplier() external view returns (uint256);
function effectiveAt() external view returns (uint256);
function toUIAmount(uint256 rawAmount) external view returns (uint256);
function fromUIAmount(uint256 uiAmount) external view returns (uint256);
function balanceOfUI(address account) external view returns (uint256);
function totalSupplyUI() external view returns (uint256);
function allowanceUI(address owner, address spender) external view returns (uint256);

// Value views — NOT ERC-4626 compliant
function asset() external view returns (address);
function totalAssets() external view returns (uint256);
function convertToAssets(uint256 shares) external view returns (uint256);
function convertToShares(uint256 assets) external view returns (uint256);
```

**`supportsInterface` does not claim ERC-4626.** `deposit` / `mint` / `withdraw`
/ `redeem` are absent — conversion runs through `SubscriptionModule` and is
asynchronous. A `deposit()` that reverts for everyone is worse than an absent
one, because integrators detect the interface and assume it works.

The cost of not claiming: rate providers and risk teams often probe for 4626
shape. The integration guide must state explicitly which four views exist and
that nothing else does.

Plus ERC-20, ERC-2612 permit, `AccessControl`, `Pausable`, UUPS, and the
regulated-issuer controls: per-minter `minterAllowance`, global `maxSupply`,
blacklist. Burning does **not** restore minter allowance.

Pause is a full freeze on `transfer`, `transferFrom`, `mint`. **Burn is not
gated** — self-burn works while paused, supporting the pause-then-blacklist
protocol. Also not gated: `setOkuMultiplier`, `haltAccrual`, `resumeAccrual`,
`blacklist` — emergency levers that must remain callable during an incident.

`setOkuMultiplier` in particular: a mark is an *oracle write*, not a user
operation, and raising `M_oku` raises `USDOkuWrapper.realizedBacking()`, which is
the primary lever for closing a solvency gap. Pause-gating it would remove the
remedy exactly when an incident makes it necessary. `haltAccrual()` is the
dedicated way to stop marks, and it is independent of pause in both directions.
Regression-tested both ways: a mark lands while paused, and transfers still
revert while paused.

One accepted consequence of the `_update`-based pause: pausing OkuM also blocks
`USDOkuWrapper.unwrap`, since the wrapper→user OkuM transfer passes through the
pause check. OkuM pause is the nuclear option, but this qualifies the "unwrap is
never gated" claim made elsewhere.

### USDOku

```solidity
function balanceOf(address) external view returns (uint256);   // shares × M_usd
function sharesOf(address) external view returns (uint256);    // the invariant ledger
function usdOkuIndex() external view returns (uint256);        // M_usd
function totalShares() external view returns (uint256);
```

Standard ERC-20 + permit + pause + blacklist. **No ERC-8056, no 4626 views.**

`sharesOf` is exposed because any integrator that must survive a rebase needs the
invariant quantity, and the alternative is each one reverse-engineering it.

### Events

| Event | Contract | Notes |
|---|---|---|
| `Transfer` / `Approval` | Both | Standard. **Raw on OkuM, rebased on USDOku** — different denominations, same signature. Document loudly |
| `TransferWithUIAmount(from, to, amount, uiAmount)` | OkuM | ERC-8056 optional; both figures |
| `UIMultiplierUpdated(old, new, effectiveAt)` | OkuM | ERC-8056 required; every step |
| `OkuMultiplierStepped(old, new, epoch, stepBps)` | OkuM | Richer than the EIP event; carries the epoch for cross-chain reconciliation |
| `UsdOkuRateSet(oldRate, newRate, rateEnd, snapshotIndex)` | USDOku | Snapshot for off-chain reconstruction |
| `AccrualHalted(atMultiplier)` | OkuM | Latches the mark setter closed |
| `AccrualHalted(atIndex)` | USDOku | Same name, different contract — freezes `M_usd` |
| `AccrualResumed(...)` | Both | Cold-only reversal via `OKU_ACCRUAL_RESUMER` |
| `SharesTransferred(from, to, shares, dollarValue)` | USDOku | Share-denominated companion to the dollar-denominated `Transfer` |
| `WrapperSet(wrapper)` | USDOku | One-time post-deploy solvency-source wiring |
| `WrapEnabledUpdated(enabled)` | Wrapper | Sunset step 1 |
| `SolvencyGapUpdated(liability, backing, gapBps)` | Wrapper | On every wrap/unwrap and rate write. **This is the series to alarm on** |
| `Wrapped` / `Unwrapped(user, okuMAmount, usdOkuAmount, multiplier)` | Wrapper | |
| `DepositRequest(controller, owner, requestId, sender, assets)` | Module | **ERC-7540's exact shape** — a 7540 indexer reads it unmodified. No `minOut` field; see [ERC-7540 alignment](#erc-7540-alignment) |
| `RedeemRequest(controller, owner, requestId, sender, shares)` | Module | Ditto |
| `RequestFulfilled(id, amountIn, amountOut, multiplier, feeBps)` | Module | Carries the multiplier **at fulfillment** — the price actually used |
| `RequestRejected(id, reasonCode)` | Module | `reasonCode` is opaque; resolved off-chain |
| `RequestCancelled(id)` | Module | User-initiated |
| `TreasuryUpdated` / `FeesUpdated` / `TokenSwept` | Module | |

Deleted: every `SyncWindow*` event, every `Redemption{Queued,Processed,Skipped,Rescued}`
event, `QueueHeadAdvanced`, `ExcessSwept`, `BufferDeposited`, `BufferWithdrawn`,
`BufferRefilled`, `StepHighWaterMarkReset`.

---

## USDOkuWrapper.sol

```solidity
function wrap(uint256 okuMAmount, address receiver, uint256 minUsdOkuOut)
    external returns (uint256 usdOkuOut);
function unwrap(uint256 usdOkuAmount, address receiver)
    external returns (uint256 okuMOut);
function quoteWrap(uint256 okuMAmount) external view returns (uint256);
function quoteUnwrap(uint256 usdOkuAmount) external view returns (uint256);
```

```
wrap:    usdOku = okuM × M_oku / PRECISION          // dollars in, 1:1 as USDOku
unwrap:  okuM   = usdOku × PRECISION / M_oku
```

**The wrapper holds OkuM as reserves; it never mints or burns it.** `wrap` pulls
OkuM in and mints USDOku shares against it; `unwrap` burns USDOku shares and pays
out of those same reserves. OkuM supply changes only through
`SubscriptionModule`. Consequently the wrapper holds `OKU_MINTER` / `OKU_BURNER`
on **USDOku only**, and holds no role at all on OkuM.

**Both directions price at `M_oku`, the realized index — never at `M_usd`.**
The load-bearing rule of the whole design. `M_usd` determines how fast a USDOku
*balance* grows; it never determines a conversion rate. If unwrap priced at
`M_usd`, USDOku holders could extract the smoothing gap directly from the OkuM
backing pool, converting a bounded accounting gap into an unbounded drain on
senior holders. There is a differential test against a mutant that uses `M_usd`.

Consequence, stated so nobody has to derive it: a USDOku holder whose balance
grew at the declared rate above realized **can** unwrap for more OkuM than they
wrapped. That extraction is the solvency gap and it is bounded by
the funding the issuer placed in the wrapper. It is the mechanism, not a bug —
see [the farming question](#the-farming-question) for the residual distribution
consideration.

> **A displayed USDOku balance is always redeemable.** Because the forward rate
> must be pre-funded (`MAX_SOLVENCY_GAP_BPS == 0`), the wrapper always holds OkuM
> covering the full declared liability, so `unwrap` cannot revert for want of
> reserves — including for the last holder out. Covered by
> `test_unwrap_fullGrownBalanceAlwaysRedeemable` and
> `test_backingCoversLiability_survivesFullCycle`.
>
> Funding arrives as a **plain ERC-20 transfer** of OkuM to the wrapper; there is
> deliberately no privileged deposit path. It is recovered via `withdrawSurplus`,
> which is gated on post-withdrawal `backing >= liability`.

`wrap` is **not** gated on solvency — it provably cannot reduce the surplus (see
[The bound](#the-bound)), so a gate there would be dead code. `unwrap` is not
gated either, and under pre-funding it cannot fail for reserves at all. The
`InsufficientReserves` error remains as a defensive assertion; reaching it would
mean the invariant had already been violated elsewhere.

Both are **permissionless**, unlike subscription and redemption. This asymmetry
is deliberate — USDOku's purpose is a frictionless dollar view, and gating the
wrapper would defeat it — but it is the one place a permissionless actor still
touches a pricing path, which is why the farming question matters.

`setWrapEnabled(bool)` on `WRAPPER_ADMIN` toggles `wrap` for the sunset sequence.
It is intentionally **two-way** (a paused rollout can be resumed) but there is no
equivalent for `unwrap`, which cannot be disabled at all. The wrapper is also
deliberately **not pausable**: a pause would block `unwrap`.

Note that pausing **OkuM** does block `unwrap`, because the wrapper→user OkuM
transfer passes through OkuM's `_update` pause check. OkuM pause is the
nuclear option and this is accepted, but it qualifies "never gated" above.

---

## OkuMultiplierAdapter.sol

Chainlink `AggregatorV3Interface`-compatible read of `OkuM.uiMultiplier()`.

```solidity
function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
function decimals() external pure returns (uint8);   // 18 — NOT Chainlink's usual 8
function isHealthy() external view returns (bool);
function isAccrualStopped() external view returns (bool);
function getRoundData(uint80) external pure;         // always reverts NoDataPresent
```

**Why ship it.** Lending markets will price off the multiplier whether or not we
give them a safe way to do it, and a hand-rolled integration has no bounds and no
liveness signal. One audited adapter beats auditing five third-party versions.

**18 decimals, not 8.** An integrator assuming Chainlink's convention misprices
by `1e10`. Asserted in both suites.

**There is no adapter for `M_usd`, deliberately.** `M_usd` is a declared payout
rate, not a value a lending market should price collateral against. Nothing
should be borrowed against USDOku at its rebased balance while the solvency gap
is nonzero.

**`isSyncLocked()` is removed** — there is no window to report. `isHealthy()` now
reflects only bounds and staleness, which simplifies the consumer contract: no
branch on a lock state that no longer exists.

Immutable and non-upgradeable: `minAnswer`, `maxAnswer`, `stalenessThreshold` are
constructor args. **Staleness** fires when the last step is older than
`stalenessThreshold` — a lapsed mark leaves the multiplier flat and *truthful*,
but a consumer should not price off it indefinitely. `getRoundData` always
reverts: this is a live derivation, not a push feed with history.

Note the protocol-wide asymmetry: no oracle gates the *input* side (USDC peg
monitoring is off-chain), but this adapter makes the system a price **publisher**
on the output side. Worth an auditor's attention.

---

## Precision and rounding

- **18 decimals on both tokens.** With a growing multiplier, 6 decimals surfaces
  display-layer dust far sooner than expected.
- **One rounding direction, stated once:** every conversion rounds **against the
  caller, in favour of the protocol**. `toUIAmount`, `fromUIAmount`, `wrap`,
  `unwrap`, and both fulfillment paths truncate; the caller absorbs the loss.
- **Display precision:** truncate UI amounts to the token's decimals. Never
  render full multiplier precision — it implies precision the backing lacks.

### The max-send rule

> **A max-send must never round-trip through the display layer.** Compute the
> transfer from raw `balanceOf`; derive the displayed value *from that raw
> amount*. Never compute `fromUIAmount(displayedBalance)`.

`fromUIAmount(toUIAmount(x))` is `x − 1` for most `x`. A "Max" button built the
wrong way leaves dust on every send, or — rounding the other way — exceeds the
balance and reverts, which users read as a broken app.

**This is the most likely user-visible bug in the system.** Enforced in three
places: the SDK exposes `getMaxSendRaw()` and no inverse; the invariant suite
fuzzes `fromUIAmount(toUIAmount(x)) ∈ [x−1, x]`; `MaxSendTest` drives the real
transfer path across the full multiplier range.

**The same rule applies to USDOku, for a different reason.** A max-send there
must be computed from `sharesOf`, not `balanceOf`, because `balanceOf` moves
between the read and the transaction. `getMaxSendShares()` exists for this and
has no inverse either.

**And to max-redeem.** `requestRedemption` with a max amount must pass raw
`balanceOf`, never `fromUIAmount(displayed)`. The SDK's `getMaxRedeemRaw()`
wraps this.

---

## Integration surface

The contracts are small. This is where the work is.

### The double-count hazard — normative

**The failure mode most likely to reach production, and it is not an amount bug.
It is an amount × price bug.**

An 8056-aware wallet reads the *amount* from the chain and the *price* from an
aggregator. Those are separate subsystems that do not know about each other. Pair
`balanceOfUI() = 1,000` with a market quote of $1.05 for raw OkuM and it renders
**$1,050** for a $1,000 position. The error is exactly the accrued yield and it
**grows with the multiplier**.

> **Normative rule.** Any consumer that applies `uiMultiplier()` to an amount
> MUST price the result at **$1.00 per unit**. Any consumer that prices raw OkuM
> at a market quote MUST use the **raw** `balanceOf`, never `balanceOfUI`.
> Applying both is a double-count.

The only two valid pairings:

| Amount | Price | Result |
|---|---|---|
| `balanceOf` (raw) | market quote for OkuM | correct |
| `balanceOfUI` (scaled) | $1.00 | correct |
| `balanceOfUI` (scaled) | market quote for OkuM | **WRONG — overstates by `M_oku`** |

Not hypothetical: the same trap Robinhood documents in its own stack, where the
REST `/prices` endpoint returns the raw underlying quote while the Chainlink feed
returns the multiplier-adjusted one. They are largely protected because nearly
all their multipliers still read exactly 1.0. `M_oku` will be off 1.0 from week
one and permanently drifting.

`DISPLAY_CONVENTION.md` carries this rule normatively. Every integration
conversation opens with it.

### Every surface needs review

The app and any embedded wallet; third-party wallets (the long tail — there is no
EVM equivalent of Solana's RPC-level `uiAmount`, so each must integrate
explicitly); explorers, trackers, indexers, subgraphs; custodians and exchanges;
bridges.

**Hardware wallet signing is a launch blocker.** Ledger and Trezor render raw
calldata amounts. The app says "$1,050"; the device says "1,000." **ERC-7730**
descriptors now exist for both tokens, the wrapper and the module — see
[ERC-7730 clear-signing metadata](#erc-7730-clear-signing-metadata) below.

The gap they *cannot* close: ERC-7730's `tokenAmount` resolves ticker and
decimals from the token contract and has no concept of a display multiplier, so
a device physically cannot show the dollar figure. The mitigation is naming, not
arithmetic — labels read `OkuM Amount`, `USDOku Amount` and `USDOku Shares`, and
only USDC gets a bare `Amount`. A signer can then tell which of three
denominations they are looking at even though the device shows raw units. Labels
are terse because Ledger truncates: enum entries cap at 20 characters and owner
URLs at 26, both measured with the registry linter rather than assumed.

**Async conversion needs its own UX review.** A request that sits pending is a
state users have not seen from a stablecoin. Status, expected timing, `minOut`
semantics, cancellation delay, and rejection all need surfacing — and rejection
needs a human-readable mapping from `reasonCode` that does not leak compliance
detail.

**Check the wallet risk-banner behavior before launch.** TokenPocket ships in-app
risk alerts on ERC-8056 tokens as a class, aimed at the inflate-a-worthless-
balance scam pattern. It is unclear whether the alert is a blanket class notice or
a targeted heuristic. Load a Robinhood stock token in TokenPocket and observe —
ten minutes, and it tells us whether the surface we are counting on shows a
caution banner on a legitimate token.

### Ship alongside the contracts

| # | Deliverable | Status |
|---|---|---|
| 1 | **Display convention** incl. the double-count rule and two-token disambiguation | ✅ [`metadata/DISPLAY_CONVENTION.md`](metadata/DISPLAY_CONVENTION.md) |
| 2 | **ERC-7730 metadata** for both tokens, wrapper, and module | ⚠️ authored and linting clean; **submission blocked on deployment + Sourcify verification** |
| 3 | **`OkuMultiplierAdapter`** | ✅ shipped (`src/oracle/`), 15 tests |
| 4 | **Client SDK** — `getDisplayBalance()`, `getMaxSendRaw()` / `getMaxSendShares()` / `getMaxRedeemRaw()` with no inverses, `allowanceUI`, solvency views, request lifecycle helpers, ERC-165 detection internal | ❌ not built |
| 5 | **Reference integrations, open-sourced** — one AMM, one lending market, both against OkuM | ❌ not built |
| 6 | **Own-frontend 8056 support** | ❌ — the reference implementation others will copy. Highest-leverage adoption lever we control |

### ERC-7730 clear-signing metadata

Descriptors live in [`metadata/erc7730/`](metadata/erc7730/) and cover **all 64
state-changing functions** across the four proxies plus the two ERC-2612 permit
messages: `common-oku-definitions.json` (25 role hashes), four `calldata-*.json`,
two `eip712-*-permit.json`.

**They are generated, not hand-written.** Edit
[`scripts/metadata/descriptorSpec.ts`](scripts/metadata/descriptorSpec.ts) and
run `npm run metadata` — never edit the JSON. The reason is ERC-7730's matching
rule: a format key must be the *byte-exact* canonical function fragment, with
canonical type names and no space after commas. Hand-maintaining 64 of those
against a moving ABI guarantees silent drift, where a descriptor stops matching
and the device quietly falls back to raw hex. Generating from the compiled ABI
turns a renamed parameter into a build failure instead.

Four scripts, each with one job:

| Script | Job |
|---|---|
| `buildDescriptors.ts` | Emits all 7 files from the compiled ABI. Fails on any spec/ABI mismatch |
| `validateDescriptors.ts` | Local gate — see below |
| `genTestFixtures.ts` | 16 registry test fixtures across 4 files |
| `syncDeployments.ts` | Per-chain output; the USDC address differs per chain, so each gets its own descriptor |

**Why a local validator when the registry has an official linter.** The registry
linter fetches a reference ABI and validates every field path against it — but it
has a proxy heuristic, and when it fires it **silently skips all ABI and
field-path validation**. All four of our contracts are UUPS proxies, so the
official linter validates almost nothing for us; `REVIEWING.md` even tells human
reviewers to watch for the "Could not fetch ABI" tell. `validateDescriptors.ts`
therefore checks selectors, byte-exact fragments, field paths, complete parameter
coverage, and — the one that actually matters — **hard-fails on any hidden
value-bearing parameter**, so no amount or recipient can ever be omitted from a
signing screen. It was verified lethal against three deliberate sabotages
(renamed parameter, hidden `approve.value`, dropped `burn` coverage).

Two schema traps worth knowing, both discovered the hard way:

- The registry moved to
  [`ethereum/clear-signing-erc7730-registry`](https://github.com/ethereum/clear-signing-erc7730-registry)
  and **v2 is mandatory**; v1 is deprecated.
- **The rendered ERC-7730 spec page describes a later draft than the schema the
  registry actually enforces.** In v2, `required`, `excluded` and `screens` do
  not exist (format objects are `additionalProperties: false`); the
  unlimited-approval key is `message`, not `thresholdLabel`; and `number`,
  `bytes32` and `percentage` are not formats. Use `visible: "never"` to hide a
  field. The linter's own "add it to `excluded` list" hint is v1-era advice that
  would fail v2 validation.

`npm run metadata:lint` runs the official linter (exit 0 today). CI runs
build + validate + a drift check that regenerates and diffs, so a contract change
that invalidates a descriptor fails the build rather than shipping.

**Before submission:** replace the entity-name and owner-URL placeholders, deploy,
verify on **Sourcify** (the linter resolves ABIs from Sourcify first, Etherscan
second — `verifyBoth` in `scripts/deploy/verify.ts` does both, for implementation
*and* proxy), then `npm run metadata:sync` and
`npm run metadata:validate -- --strict`, which fails on any remaining
placeholder. Runbook: [`metadata/erc7730/README.md`](metadata/erc7730/README.md).

**One limitation with no fix.** `setUsdOkuRate`'s `newRate` is an 18dp
per-second compounding rate; ERC-7730 has no arithmetic, so a device can only
render `1.000000003170979198 /s` and never an APR. The parameter is value-bearing
so it cannot be hidden. Mitigated operationally: the operator CLI prints the
implied APR and refuses an unfunded rate, and off-device verification is a
runbook step.

### Venue requirements

**AMMs — rate-aware pools only, OkuM only.** Curve stableswap with
`uiMultiplier()` as the rate provider, or a Uniswap v4 hook. A naive
constant-product pair against USDC leaks accrual to arbitrageurs continuously;
LPs capture materially less than the yield rate. State this in LP-facing docs.
**USDOku must never be pooled** — it rebases, and the pool would leak the entire
yield to whoever calls sync.

**Lending — engage each risk team before launch, OkuM only.** The multiplier
becomes their price feed; they will want step bounds, cadence, and `haltAccrual`
semantics in writing. USDOku should not be listed while the solvency gap is
nonzero.

**Public secondary price is expected, not a surprise.** Someone will pool OkuM
against USDC. That pool prices raw OkuM at `$1 × M_oku` and climbing, and
aggregators will list it there. This is *correct* — OkuM is not pegged — but
expect it at launch rather than treating it as a depeg. ERC-8056 scales amounts,
not prices; no amount of wallet adoption changes that.

**A secondary market is now the only instant exit.** Worth stating plainly:
with redemption reviewed, a holder who wants immediate liquidity must sell into a
pool rather than redeem. That makes third-party liquidity more important than in
the permissionless design, not less, and it means the pool price is where any
loss of confidence will show up first. Monitor it.

**Cross-chain.** One canonical `M_oku` source pushed to satellites. Bridging is
backend-operated burn-and-mint through the KMS orchestrator — **unchanged from
the previous design.** Bridges move **raw units and nothing else**; audit each
for decimal or display handling. Because both legs are backend-controlled, no
on-chain fence is required; correctness rests on the orchestrator not burning and
minting across a mark, which is an operational commitment (Limitation 11).
USDOku does not bridge; it is EVM-only.

---

## Terminology

| Term | Meaning |
|---|---|
| `rawAmount` | Raw OkuM count — what `balanceOf`, `transfer`, `approve` move (18 dp) |
| `uiAmount` | Dollar value of an OkuM amount — what `balanceOfUI` returns (18 dp) |
| `usdcAmount` | USDC amount (6 dp on all targeted chains) |
| `M_oku` / `uiMultiplier` | Dollar value of 1 raw OkuM. Starts `1e18` = $1.00. Stepwise, monotone |
| `M_usd` / `usdOkuIndex` | USDOku's rebase index. Continuous, monotone. **Not** a conversion rate |
| `shares` | USDOku's invariant ledger quantity — `sharesOf` |
| `stepBps` | Size of one `M_oku` step, in basis points |
| `gap` | `USDOku.totalSupply() − backing`. May be positive. Bounded |
| `epoch` | Orchestrator-assigned mark number. **Reconciliation counter, not a lock** |
| `request` | A pending, reviewed conversion. Priced at fulfillment, never at submission |

```
USDC → raw:    raw    = (usdcAmount × dm) × PRECISION / M_oku   // at FULFILLMENT
raw → USDC:    usdc   = (raw × M_oku / PRECISION) / dm          // at FULFILLMENT
raw → UI:      ui     = raw × M_oku / PRECISION                 // toUIAmount
UI → raw:      raw    = ui × PRECISION / M_oku                  // fromUIAmount
OkuM → USDOku: usdOku = okuM × M_oku / PRECISION                // wrap — M_oku, NOT M_usd
USDOku → OkuM: okuM   = usdOku × PRECISION / M_oku              // unwrap — M_oku, NOT M_usd
USDOku balance: bal   = shares × M_usd / PRECISION

parity (a BOUND, not an equality):
  convertToAssets(1e18) × dm  <=  M_oku  <  (convertToAssets(1e18) + 1) × dm
```

---

## Constants

Every bound is a **constant, not a config field**. No key — warm or cold — can
widen it.

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1e18` | Fixed-point base. ERC-8056 mandates 18-dp multiplier precision |
| `BASIS_POINTS` | `10_000` | Convention |
| `SECONDS_PER_YEAR` | `365 days` | Annualization base |
| **`M_oku` authority** | | |
| `MAX_STEP_BPS` | `100` (1%) | Ceiling on one step. **Oracle-sanity bound against a compromised setter — no longer coupled to the fee schedule.** Derived from a monthly mark cadence at a ~5% target (~42bps/month), sized ~2.4x so one missed month can be caught up in a single mark. **Placeholder pending cadence confirmation** |
| `MAX_MULTIPLIER` | `1e24` | Cumulative ceiling. Round-number convention. Note this alone would permit a single 1,000,000× step, which is why `MAX_STEP_BPS` is load-bearing and not redundant |
| **`M_usd` authority** | | |
| `MAX_IMPLIED_APR_BPS` | `1000` bps | Nominal (simple) annualization. At the cap the per-second ceiling compounds to ~10.52% APY — delivered APY sits slightly above nominal by construction, documented rather than corrected because a monotone-in-rate check is cheaper to audit than an `rpow` round trip in the setter. Placeholder |
| `MAX_USD_RATE_PER_SECOND` | `1e18 + 3_170_979_198` | **Derived, not chosen**: `PRECISION + (PRECISION × MAX_IMPLIED_APR_BPS / BASIS_POINTS) / SECONDS_PER_YEAR`. Precomputed as a constant. Verified to reproduce both figures quoted here — ~10.517% APY over a year, ~0.8253% over 30 days |
| `MAX_RATE_DURATION` | `30 days` | Exposure window of one rate write. Worst-case over-accrual from a compromised key ≈ **0.82%** per segment. Operational cost: a missed renewal freezes yield, and since the cap also binds catch-up, a long outage cannot be fully compensated |
| `MAX_SOLVENCY_GAP_BPS` | **`0`** | Declared liability may never exceed realized backing: **the forward rate must be pre-funded**. This is what makes `backing >= liability` a maintained invariant and `unwrap` unable to fail for reserves. A nonzero value reintroduces a band in which a displayed USDOku balance is not fully redeemable — do not raise it without re-deciding who absorbs the shortfall |
| **Supply** | | |
| `MAX_TOTAL_SUPPLY` | `1e33` | Ceiling on `maxSupply`, enforced in **both** `initialize` and `setMaxSupply`. `maxSupply` is mutable, so an init-only assertion would evaporate the first time the cap moved — and with it the overflow invariant |
| **Requests** | | |
| `MAX_REQUEST_AGE` | `7 days` | A request older than this cannot be fulfilled and must be resubmitted. Bounds how stale a `minOut` can be |
| `MIN_CANCEL_DELAY` | `1 hour` | Prevents submit-and-cancel probing of fulfillment timing. Does **not** prevent fulfillment-racing once elapsed — that residual grief is accepted, not eliminated |
| **Fees** | | |
| `MAX_FEE_BPS` | `100` (1%) | Anti-confiscation. **No longer a step-coverage constraint** — worst case is a 1% haircut, not seizure |
| **Misc** | | |
| `MAX_USDC_DECIMALS` | `18` | USDC is 6 dp everywhere targeted. Capping rather than hardcoding 6 is forward-compat |
| `IID_SCALED_UI_*` | see above | From the draft EIP. Pinned |
| `IID_ERC7540_*`, `IID_ERC7575` | see below | Pinned so the suite can assert we return **false** for each |

**Deleted:** `MAX_SYNC_WINDOW`, `DEFAULT_SYNC_WINDOW`, `MIN_SYNC_WINDOW_GAP`,
`MIN_STEP_COVERAGE`, `MAX_RATE` (superseded by the derived
`MAX_USD_RATE_PER_SECOND`), `MIN_COLLATERAL_RATIO_FLOOR` (the collateral-ratio
config surface is gone; `MAX_SOLVENCY_GAP_BPS` is a constant instead).

**`MIN_REQUEST_AMOUNT` is deleted, not TBD.** Its stated job was anti-dust on the
per-user slot, but there is no shared resource left to spam: the slot is the
user's *own*, one per direction, and occupying it with dust only blocks that same
user. An ignored request simply expires, costing the operator nothing — anti-dust
was load-bearing only in the queue design, where a dust entry consumed a shared
FIFO position an operator had to walk past. The one real hazard, a request whose
output rounds to zero, is caught by an explicit `AmountTooSmall` revert at
fulfillment, which needs no tuned constant.

Remaining SVM mirrors in `oku_shared::constants`: `MAX_STEP_BPS`, `MAX_FEE_BPS`.
`MAX_SOLVENCY_GAP_BPS`, `MAX_IMPLIED_APR_BPS` and every request constant have
**no** SVM mirror — USDOku and the subscription module are EVM-only. Note the SVM
side has not yet adopted this design at all; see [`../TRACKER.md`](../TRACKER.md).

---

## Roles

Each contract's `initialize` grants its full role set to `admin`, who
redistributes post-deployment.

| Role | Held by | Can do | Bounded by |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Cold | Grant/revoke any role; `USDOku.setWrapper` (one-time wiring) | Nothing — meta-role |
| `OKU_UPGRADER` · `USD_UPGRADER` · `WRAPPER_UPGRADER` · `SUB_UPGRADER` | Cold | Replace logic via UUPS. One per proxy, deliberately not shared | Nothing — mitigated by fork rehearsal and diff review |
| `OKU_ALLOWANCE_MANAGER` | Cold | Set `minterAllowance` | Capped at `maxSupply`; minting still needs `OKU_MINTER` |
| `OKU_CAP_MANAGER` | Cold | `setMaxSupply` | Cap cannot go below `totalSupply()`, cannot exceed `MAX_TOTAL_SUPPLY` |
| `SUB_FEE_MANAGER` | Cold | `setFees` | `MAX_FEE_BPS`. Applies at fulfillment; `minOut` protects pending requests |
| `SUB_TREASURY_MANAGER` | Cold | `setTreasury` | Non-zero address; emits |
| `WRAPPER_ADMIN` | Cold | `setWrapEnabled` (sunset step 1) | **Cannot disable `unwrap`** — deliberate. Two-way, so a rollout can be resumed |
| `OKU_PAUSER` / `USD_PAUSER` / `SUB_PAUSER` | Warm | Halt operations | Cannot unpause — cold only |
| `OKU_UNPAUSER` / `USD_UNPAUSER` / `SUB_UNPAUSER` | Cold | Resume | Deliberately a different role: a compromised warm key can stop the protocol but never restart it |
| `OKU_BLACKLISTER` | Warm | Block an address | Cannot unblacklist; cannot access funds. Same role hash spans OkuM and USDOku, but must be granted on each |
| `OKU_UNBLACKLISTER` | Cold | Unblock | Same split, same reason |
| `OKU_GUARDIAN` | Warm | `haltAccrual()` (OkuM), `haltUsdOkuAccrual()` (USDOku) | Can only stop growth. Cannot set a rate or reduce either multiplier. `haltUsdOkuAccrual` pulls `rateEnd` to `now` so the halted state reads unambiguously as "nothing pending" |
| `OKU_ACCRUAL_RESUMER` | Cold | `resumeAccrual()`, `resumeUsdOkuAccrual()` | Clears the halt latch only. Deliberately **not** `OKU_GUARDIAN`: same warm-stop / cold-restart split as pause and blacklist, so a compromised warm key can freeze yield but never un-freeze it. Without this role a halt would need a UUPS upgrade to undo |
| `OKU_RATE_SETTER` | Orchestrator | `setOkuMultiplier`, `setUsdOkuRate` | Step cap, APR cap, duration cap, monotonicity, `MAX_MULTIPLIER`, solvency bound, halt latch |
| `REQUEST_FULFILLER` | Orchestrator | `fulfillSubscription`, `fulfillRedemption`, `rejectRequest` | Cannot change amounts or destination — both fixed at request. Cannot price: pricing is `M_oku` at fulfillment. Cannot fulfill past `MAX_REQUEST_AGE` |
| `SUB_SWEEPER` | Warm | `sweepToken` | Capped at `balanceOf − Σ escrow`; provably cannot touch user escrow |
| `OKU_MINTER` | **SubscriptionModule** on OkuM · **USDOkuWrapper** on USDOku | `OkuM.mint()` / `USDOku.mint()` | Per-minter allowance and `maxSupply` on OkuM |
| `OKU_BURNER` | **SubscriptionModule** on OkuM · **USDOkuWrapper** on USDOku | `OkuM.burn()` on redemption; `USDOku.burn()` on unwrap | See below |

The last two are **contract-only**. `grantRolesMainnet.ts` verifies they are held
by the expected proxies *and* asserts no cold, warm or orchestrator key holds
any of them — a separation-of-duties check that fails the run rather than warning.

**They are scoped per token, not shared across both.** `SubscriptionModule` holds
mint/burn on **OkuM only** (it mints on fulfilled subscription, burns its own
escrowed balance on fulfilled redemption). `USDOkuWrapper` holds mint/burn on
**USDOku only** — it never touches OkuM's supply, only holds OkuM as reserves.
Note the two `burn` signatures differ deliberately: `OkuM.burn(amount)` burns the
caller's own balance, while `USDOku.burn(from, shares)` debits a target, because
the wrapper must burn a user's shares during `unwrap` without a prior transfer
step. Both are share/raw-denominated, never dollar-denominated.

**`REQUEST_FULFILLER` is deliberately separate from `OKU_RATE_SETTER`**, even
though both live on the orchestrator. The value path now requires two
capabilities: setting the multiplier and fulfilling a conversion at it. Splitting
them means a single compromised key cannot both misprice and extract. This is a
security property the permissionless design could not have, and it should be
honoured with distinct keys in production, not just distinct role constants.

Deleted: `PSM_BUFFER_DEPOSITOR`, `PSM_BUFFER_WITHDRAWER`, `PSM_QUEUE_PROCESSOR`,
`QUEUE_RESCUER`, `QUEUE_PSM`, `QUEUE_UPGRADER`, `VAULT_ADMIN`,
`VAULT_RESERVE_MANAGER` (no reserve-management surface exists any more).

Named `OKU_RATE_SETTER`, not `REBASER`. **Note:** USDOku *does* rebase, so this
name is a scoping choice rather than a factual one — the role sets rates on both
tokens and only one rebases.

---

## Invariants

Stateful-fuzz invariants in `SystemInvariants`, driven by an **adversarial**
handler that donates tokens to the module and the wrapper, and that submits,
cancels, and races requests. That handler is why every backing property is a
**bound and never an equality**: free token donations are unpreventable, so an
equality would be a permanently griefable failure rather than a property of the
protocol.

```
// OkuM display / value parity
convertToAssets(1e18) × dm <= uiMultiplier() < (convertToAssets(1e18)+1) × dm
totalSupplyUI() == totalSupply() × M_oku / PRECISION
fromUIAmount(toUIAmount(x)) ∈ [x-1, x]                      // fuzzed, full range
Σ balanceOfUI(holder) <= totalSupplyUI()                    // gap <= 1 wei per holder

// M_oku
M_oku >= previousM_oku                                      // monotone
stepBps <= MAX_STEP_BPS                                     // every step
M_oku <= MAX_MULTIPLIER
uiMultiplier() == newUIMultiplier() once past effectiveAt()  // ERC-8056 boundary
epoch strictly increasing                                    // reconciliation only

// M_usd
M_usd >= previousM_usd                                      // monotone
M_usd continuous across every setUsdOkuRate call            // slope moves, value does not
M_usd constant once block.timestamp >= rateEnd
impliedAprBps(ratePerSecond) <= MAX_IMPLIED_APR_BPS

// Solvency — load-bearing
// THE core solvency invariant, maintained (not merely monitored) because
// MAX_SOLVENCY_GAP_BPS == 0 forces every forward rate to be pre-funded:
USDOkuWrapper.backingCoversLiability()                      // backing >= liability
    // established by setUsdOkuRate's projection to rateEnd;
    // preserved by wrap (floors share credit -> builds surplus)
    // and unwrap (ceils sharesToBurn -> liability falls at least as fast)
wrap never reduces (backing - liability)                    // ABSOLUTE surplus, not gapBps
unwrap never reverts for insufficient reserves
withdrawSurplus cannot leave backing < liability
setUsdOkuRate reverts unless pre-funded, EXCEPT newRate == PRECISION
USDOku.totalSupply() == Σ (sharesOf × M_usd / PRECISION)    // exact, share layer
wrapper OkuM balance × M_oku >= USDOku.totalSupply()        // EXACT, not a bound
wrap/unwrap price at M_oku, never M_usd                     // differential vs mutant

// Requests — new
Σ pending subscription escrow <= USDC.balanceOf(module)     // BOUND: donations
Σ pending redemption escrow   <= OkuM.balanceOf(module)     // BOUND: donations
at most one pending request per (user, direction)
a request resolves exactly once: fulfilled XOR rejected XOR cancelled
fulfillment price == M_oku at the fulfilling block           // NEVER the request block
amountOut >= minOut on every fulfillment
no fulfillment when createdAt + MAX_REQUEST_AGE < now
cancel reverts before createdAt + MIN_CANCEL_DELAY
rejected and cancelled requests refund amountIn exactly      // no fee on either
sweepToken can never reduce balance below Σ escrow

// Raw layer
OkuM.balanceOf(u) == OZ ERC20 _balances[u]                  // stock OZ, unmodified
Σ OkuM.balanceOf(holder) == OkuM.totalSupply()              // exact — raw layer only
OkuM.totalSupply() <= maxSupply
maxSupply <= MAX_TOTAL_SUPPLY                               // init AND setMaxSupply
MAX_TOTAL_SUPPLY × MAX_MULTIPLIER < type(uint256).max       // static assertion

// Interface
OkuM.supportsInterface(0xa60bf13d) == true
OkuM.supportsInterface(<4626-shaped id>) == false           // we do NOT claim this
OkuM.supportsInterface(<7540-shaped ids>) == false          // pattern only
USDOku.supportsInterface(0xa60bf13d) == false               // NEVER — double-scale guard

// Allowance
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                        // burns do not restore
```

Deleted invariants: every `syncLockedUntil` bound, the clamp-vs-revert pair,
`tin + tout >= stepHighWaterMark`, `queue.totalQueuedRaw <= balanceOf(queue)`,
`totalQueuedUsdc()` identity, and the buffer-outflow accounting bound.

The property deliberately **without** an invariant: none asserts the treasury can
cover outstanding redemption requests. Requests exist precisely to let the
backend decide that off-chain, and an on-chain assertion would either be
vacuously true or block legitimate queuing of intent.

---

## Testing

```bash
forge install && forge build
forge test                                            # 202 tests
forge test --match-path "test/SystemInvariants.t.sol"  # 256 runs × 500 depth
forge fmt --check
forge coverage --no-match-coverage 'test/|script/|node_modules/|lib/' --report summary
npx tsc --noEmit && npx hardhat compile                # scripts + Hardhat pipeline
npm run upgrade:validate                               # OZ storage-layout validator
npm run metadata                                       # ERC-7730 build + validate + fixtures
```

The coverage filter is not cosmetic: without excluding `node_modules/|lib/` the
gate measures **OpenZeppelin's** coverage, and the `Total` row reads ~50% while
every file we wrote is above 95%.

**Current state: 202 tests, all passing. 100% line and 100% function coverage on
`src/` (753/753 lines), 86.18% branch.** What exists today:

| File | Covers |
|---|---|
| `Differential.t.sol` | **The two load-bearing pricing rules, proven against mutants.** Pricing at fulfilment (not the request block) and wrapper pricing at `M_oku` (not `M_usd`). Each test first asserts its fixture is non-degenerate, so it cannot pass vacuously; verified lethal by sabotaging the wrapper and watching them fail |
| `SystemInvariants.t.sol` | 13 stateful-fuzz invariants at 256 runs x 500 depth (128k calls each), driven by an adversarial handler that donates tokens and races request transitions. Headline: `backingCoversLiability` |
| `Regression.t.sol` | The five defects fixed after the first contract pass, plus the ERC-8056 / ERC-7540 interface surface |
| `CriticalPaths.t.sol` | Request lifecycle, escrow, `unwrap` at `M_oku`, sunset, role separation, max-send, regulated-issuer controls |
| `USDOku.t.sol` · `OkuM.t.sol` · `SubscriptionModule.t.sol` · `Wrapper.t.sol` · `OkuMultiplierAdapter.t.sol` · `MathLib.t.sol` | Per-contract unit and branch coverage |
| `Coverage.t.sol` | Accessors, admin paths and defensive branches the behavioural suites do not naturally reach — incl. `USDOku._update`, which is unreachable by design and therefore needs a harness |

Not yet built: the Hardhat scenario suite (the OZ storage-layout validator runs
standalone via `scripts/upgrade/validateImpls.ts`), and the long-horizon
`TenYearAccrual` / `Farming` quantification suites.

The suite names below are the original target taxonomy, retained for reference:

| Suite | Covers |
|---|---|
| `ERC8056Conformance` | All four interface IDs; conversion round-trips; balance identities; `UIMultiplierUpdated`; the `uiMultiplier() == newUIMultiplier()` boundary contract. **Cross-checked against `jumpboxtech/erc-8056-conformance`**, not the EIP's reference implementation |
| `RequestLifecycleTest` | **New.** Every transition and every illegal transition: double-fulfill, fulfill-after-reject, cancel-after-fulfill, second pending request, fulfill past `MAX_REQUEST_AGE`, cancel before `MIN_CANCEL_DELAY`, and a request whose output rounds to zero |
| `FulfillmentPricingTest` | **New, and the most important in this suite.** Asserts the price used is `M_oku` at the *fulfilling* block, differentially against a mutant that prices at the request block. Plus `minOut` enforcement across a step, and the free-option scenario the mutant admits |
| `EscrowTest` | **New.** Escrow bounds under donation; refund exactness on reject and cancel (no fee); `sweepToken` capped below escrow; treasury allowance exhaustion reverting loudly |
| `SolvencyTest` | Gap accounting across wrap/unwrap/step/rate sequences; `SolvencyGapExceeded` on `setUsdOkuRate` (the only live call site); the full-stop escape hatch; `wrap` provably unable to worsen the gap; unwrap never gated on solvency; gap closing as realized catches up |
| `FarmingTest` | **New.** Simulates the deliberate wrap/hold/unwrap strategy across a full rate cycle and measures how much funded yield a timing-aware actor captures versus a patient holder. Quantifies a distribution question; solvency is no longer at stake |
| `WrapperTest` | `wrap`/`unwrap` price at `M_oku` and never `M_usd` (differential vs a mutant); round-trip dust; sunset — `wrap` disabled, `unwrap` open |
| `RebaseTest` | USDOku share-ledger identities; `balanceOf` continuity across rate writes; max-send from `sharesOf`; `supportsInterface(0xa60bf13d) == false` |
| `AccrualTest` | `M_usd` continuity across rate changes; halt at `rateEnd`; re-anchoring; APR and duration cap rejections; `haltUsdOkuAccrual` |
| `MaxSendTest` | The max-send rule against the real transfer path on **both** tokens plus the redemption request path, at low and high multiplier |
| `TenYearAccrualTest` | Long-horizon: overflow, precision drift, dust, and cumulative solvency gap over a full rate cycle |
| `MulDivBoundsTest` | What `mulDiv` actually buys. Naive and `mulDiv` agree across the legal envelope (so it is not papering over a real overflow); `mulDiv` survives hostile-counterparty inputs where naive reverts; the extended domain is still **bounded**. Plus `rpow` branch coverage |
| `OkuMTest` | Regulated-issuer surface: supply cap incl. `MAX_TOTAL_SUPPLY` on **both** write paths, minter allowances, blacklist reachable through `_update` on mint/burn, pause semantics, permit, upgrade authorization |
| `OkuMultiplierAdapterTest` | Bounds, staleness, halt→fresh→stale, 18-decimal reporting, `getRoundData` refusing history |
| `RoleSeparationTest` | **New.** Asserts `OKU_RATE_SETTER` alone cannot extract: a key holding it but not `REQUEST_FULFILLER` can misprice but not convert, and vice versa |
| `FeesTest` | `tin`/`tout` arithmetic and ceil-rounding; accrual to the buffer; fee-inclusive quotes; fee applied at fulfillment with `minOut` protecting pending requests |
| `SystemInvariants` | Stateful-fuzz at 256 runs × 500 depth; adversarial handler donating to module and wrapper and racing request transitions |
| Hardhat `Scenarios.ts` | OZ storage-layout validator on a real `upgradeProxy`; twelve-month operating scenario incl. a **full rate cycle where declared runs ahead then behind**; the **high-multiplier regime** (≥5x); incident protocol end to end; multi-holder fairness; adapter lifecycle; the sunset sequence; **a request backlog spanning several marks** |

**Deleted:** `SyncWindowTest` (the entire suite), `StepArbitrageTest`,
`RedemptionQueueTest`, and the two fee regressions that existed only because
`tout` was load-bearing.

Foundry is authoritative for functional coverage. Hardhat carries what Foundry
cannot or covers less naturally: the OZ layout validator (forge cannot invoke
it), multi-contract scenarios with full deploy-script wiring, and the
high-multiplier regime.

That last one earns its place. **At `M_oku == 1e18` the raw and displayed numbers
are identical, so every off-by-a-multiplier bug is invisible.** Half the Hardhat
suite runs at ≥5x for exactly that reason. The same logic now applies twice more:
scenarios must run with a **nonzero solvency gap** (at gap zero every wrap/unwrap
mispricing is invisible) and with **a mark landing between request and
fulfillment** (otherwise request-time and fulfillment-time pricing are
indistinguishable, and `FulfillmentPricingTest` passes vacuously).

CI fails below **95% line coverage** on any `src/` file, with **100% required on
`ScaledUIAmountUpgradeable`, `USDOkuWrapper`, and `SubscriptionModule`** — all
three on every pricing path. All three sit at 100% today, as does every other
`src/` file.

Two things the gate learned the hard way, both now guarded:

- **The exclusion patterns must be anchored.** An unanchored `lib/` matches
  `src/lib/` as well as the forge dependency directory, which silently dropped
  `ScaledUIAmountUpgradeable`, `MathLib` and `ReentrancyGuardUpgradeable` from
  measurement entirely — the ERC-8056 display layer was ungated. It is
  `^(test|script)/|node_modules/|^lib/`; `node_modules/` stays unanchored
  because npm nests transitive copies.
- **A filter that matches everything produces an empty table and a passing
  gate.** The gate now also fails if it parses fewer than nine rows, so
  over-exclusion is loud rather than silent. Both failure modes, plus a
  below-threshold file, were verified to fail the real CI script.

The harnesses below exist for a related reason: a defensive branch that no
production path can reach is also unreachable by test, which leaves an assertion
unverified. `USDOku._update` is the clearest case — it reverts unconditionally so
that a future refactor routing through `ERC20Upgradeable._mint`/`_burn` fails
loudly instead of silently diverging the share ledger from the balance mapping.

**Harnesses** (test-only, never in a production import path):

- `MathLibHarness` — exposes `rpow` so the `x == 0` and `mul`-overflow branches of
  MakerDAO's assembly are reachable, plus `naiveToUiAmount` for differential
  comparison against `mulDiv`.
- `ScaledUIHarness` — drives `M_oku` to arbitrary values **including
  standard-legal ones this token forbids** (below `PRECISION`, above
  `MAX_MULTIPLIER`, decreasing). Two jobs: reaching defensive bounds legitimate
  accrual cannot, and standing in as a hostile-but-conformant ERC-8056
  counterparty for anything reading a third-party token.
- `SolvencyHarness` — forces arbitrary gap states, including past
  a surplus or a hypothetical shortfall, so `withdrawSurplus` bounds and the
  defensive `InsufficientReserves` path stay reachable without a multi-year fuzz run.
- `RequestHarness` — **new.** Forces a request into any status and any age,
  including past `MAX_REQUEST_AGE`, so expiry and illegal-transition branches are
  reachable without time-warping the whole scenario.
- `MockUSDC` — 6-decimal, with `setBlocked` (revert, Circle's blacklist shape)
  and `setReturnFalse` (non-standard silent `false`) independently selectable.
  Still needed: a blacklisted recipient must make **fulfillment** fail loudly,
  which is now the operator's problem rather than a queue soft-skip.
- `MockHighDecimalToken` — configurable `decimals()`, above 18 to exercise
  rejection.

Note `bound()` is **not** used anywhere — `_bound()` is. Numerically identical,
but `bound` emits a `console2` log per call, and at 128,000 handler calls per
invariant run that buries the output.

---

## Limitations

**1. Centralized rate authority, no timelock.** Two setters on the orchestrator.
`MAX_STEP_BPS`, `MAX_IMPLIED_APR_BPS`, `MAX_RATE_DURATION`, `MAX_SOLVENCY_GAP_BPS`,
monotonicity and the two halts bound the damage. Worst-case `M_usd` over-accrual
per segment ≈ 0.82%. Partially mitigated by the `OKU_RATE_SETTER` /
`REQUEST_FULFILLER` split. Role grants and upgrades remain unbounded beyond
multisig custody.

**2. No on-chain backing verification.** `totalAssets()` is derived from `M_oku`,
not measured. The value interface is exactly as trustworthy as the multiplier
authority. The OkuM full-backing invariant is a *reconciliation* property checked
off-chain. Inherent to off-chain RWA backing.

**3. Conversion is not permissionless — this is a trust assumption, not just a
simplification.** A holder cannot exit to USDC without the operator fulfilling.
An operator that stops fulfilling, or fulfills selectively, has functionally
frozen redemption, and there is **no on-chain recourse and no timeout that forces
fulfillment**. Requests expire; they do not self-execute. This is the single
largest departure from a permissionless stablecoin and it should be disclosed as
such, not framed as an implementation detail. Mitigations are operational
(published SLAs, monitoring, secondary liquidity) rather than technical.

**4. Both multipliers are monotone; neither has a downward path.** Over-accrual
of `M_usd` relative to realized backing cannot be corrected on-chain — only
slowed. A persistent shortfall is absorbed off-chain. Adding a downward path
later is not a patch: it needs a longer timelock on decreases than increases,
mandatory advance notice, and liquidation-impact review with every lending venue.

**5. ERC-8056 is a Draft.** IDs shift if any signature changes. Re-conforming is
a one-line change and a single-contract upgrade. We emit the spec's
`TransferWithUIAmount`; Robinhood Chain emits `TransferWithScaledUI` — indexers
built for one will not see the other.

**6. USDOku's dollar unit is a definition, not a market price.** 1 USDOku = $1 by
wrapper construction. No arbitrage keeps it there and no on-chain oracle asserts
it. If USDOku ever trades on a secondary venue it may trade away from $1, and the
protocol has no mechanism to defend that. This is why USDOku should not be pooled
or used as collateral.

**7. Allowance value drift.** OkuM allowances are raw-denominated, so a bounded
approval's *dollar* value grows with `M_oku`. Mitigated by `allowanceUI`
on-chain and surfacing drifted approvals in the app; no contract-level fix
preserves ERC-20 semantics. USDOku allowances drift in the opposite direction — a
raw-share approval on a rebasing token — and `sharesOf` is exposed so integrators
can reason about it.

**8. Max-send rounding hazard.** Inherent to scaled display and to rebasing.
Mitigated by SDK design rather than eliminated. Applies to both tokens and to the
redemption request path.

**9. Forward yield must be pre-funded, which costs capital.** `setUsdOkuRate`
requires the liability projected to `rateEnd` to be already covered by OkuM in
the wrapper, so the issuer funds the yield before promising it rather than paying
it out of future realized returns. This is what makes a displayed USDOku balance
always redeemable, but it is a real working-capital commitment: roughly the
segment's yield, held in the wrapper for the segment's duration. If funding
lapses, the rate must be stopped — accrual cannot continue unfunded.

**9a. Funded yield is still distributed by timing, not by patience.** A holder
who wraps late and unwraps early captures more funded yield per unit time than a
patient holder. This is a distribution/fairness property, not a solvency one —
it cannot create a shortfall — and it is bounded by whatever the issuer chose to
fund. See [the farming question](#the-farming-question).

**10. Two tokens is real complexity.** Cognitive overhead, an extra unwrap
transaction on power-user paths, and liquidity fragmentation. Accepted
deliberately, with a documented sunset path.

**11. Cross-chain correctness now rests on operational discipline, not an
on-chain fence.** With the sync window removed, nothing prevents the orchestrator
from burning on one chain and minting on the other across a mark, or from writing
different values for the same epoch. Equal epochs prove both chains wrote for
mark N — not that they wrote the same number. `check-sync-parity.ts` detects
divergence after the fact; nothing prevents it. **This is a deliberate trade:**
the window's threat model was a permissionless actor, and there is no longer one,
but the residual operator risk is real and unbounded by contract.

**12. The solvency gap is publishable but not auditable on-chain.** `backing` is
computed from `M_oku`, which is itself declared. A holder can verify the gap
between two declared numbers; they cannot verify either against reality without
the off-chain attestation.

**13. Async conversion is an unfamiliar UX for a dollar product.** Pending
states, expiry, `minOut`, cancellation delay, and rejection are all states users
do not expect from a stablecoin. This is a product risk, not a contract one, and
it needs deliberate design rather than a status field.

---

## Open questions

**These are tracked, with status and severity, in
[`../TRACKER.md`](../TRACKER.md) — that file is the source of truth.** Summarised
here for readers of this document only.

Blocking external exposure:

1. **ERC-7730 registry submission.** The descriptors and
   `DISPLAY_CONVENTION.md` now exist and lint clean, so the authoring work is
   done. Submission is *deployment-gated*: the registry requires real deployed
   addresses and Sourcify-resolvable ABIs, and two fields are still placeholders
   — the legal entity name and a canonical URL of **26 characters or fewer**
   (Ledger truncates beyond that; measured, not guessed).
   **This is the only remaining item blocking external exposure.**

Should-fix before audit:

2. **Mark cadence, which sets `MAX_STEP_BPS`.** Ships at `100` (1%), derived from
   an assumed monthly cadence at a ~5% target with ~2.4x catch-up headroom. Publish
   the cadence and move the ceiling with it if it differs.
3. **`MAX_IMPLIED_APR_BPS` and `MAX_RATE_DURATION`.** `1000` bps / `30 days`. The
   first needs a real number; the second is a round-number convention. Note these
   now also set the pre-funding working-capital requirement per segment.
4. **`OKU_GUARDIAN` — warm or cold?** Warm gives a fast halt; cold makes it harder
   to abuse. Now two lookalike levers on different tokens. Reversal is already
   cold-only via `OKU_ACCRUAL_RESUMER`, a role this implementation added that the
   original design did not name — confirm the split before granting in production.
5. **External ERC-8056 conformance suite.** `jumpboxtech/erc-8056-conformance`
   exists and is wireable; not yet wired.

Post-launch / lower priority:

6. **One pending request per user per direction — too restrictive?** It is what
   removes the queue entirely. Institutional flows would need separate addresses.
   A small bounded array is the fallback and it is still not a queue.
7. **Should request expiry auto-refund?** Today an expired request needs an
   explicit `cancelRequest`. Auto-refund is friendlier but needs a permissionless
   poke, which reintroduces a keeper.
8. **Raise the denomination question upstream.** ERC-8056 has no way to declare
    *what unit* a multiplier converts to. Ours converts shares → dollars, across
    asset classes; Robinhood's converts tokens → shares, within one. A consumer
    cannot distinguish them, which is the root of the double-count hazard. Worth
    proposing a denomination field on the
    [Ethereum Magicians thread](https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899)
    — it is a draft, the authors have accepted essentially every substantive
    suggestion, and we hold the only non-equity two-index use case in the
    discussion.

**Resolved since the design doc:** `MIN_REQUEST_AMOUNT` (deleted, not tuned — see
[Constants](#constants)); ERC-7540 alignment depth (events and views only,
function names kept — see [ERC-7540 alignment](#erc-7540-alignment));
`MAX_SOLVENCY_GAP_BPS` (settled at **zero** — forward yield is pre-funded, which
also resolved the un-redeemable-balance defect and reduced the farming question
to a distribution consideration); trapped wrapper over-collateral (recoverable
via `withdrawSurplus`).

---

## Deployment

`scripts/deploy/index.ts` provisions every contract for a chain in one run and
writes to a per-network address book. Proxies and implementations are
CREATE2-deterministic via the
[Arachnid factory](https://github.com/Arachnid/deterministic-deployment-proxy)
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on every supported chain),
so the same source tree, `DEPLOYMENT_VERSION` and constructor args produce the
same address on every chain. Salt:
`keccak256("okumoney." + DEPLOYMENT_VERSION + "." + <name>)`.

`v0.x` is pre-audit iteration; `v1.0+` is reserved for post-audit. Bumping
`DEPLOYMENT_VERSION` is one-way. Chains using real Circle USDC diverge from
testnets using `MockUSDC`, since constructor args differ.

**Networks:** `sepolia` (11155111), `opSepolia` (11155420), `baseSepolia`
(84532), `arbSepolia` (421614), `bscTestnet` (97), `mainnet` (1), `optimism`
(10), `arbitrum` (42161), `base` (8453), `bsc` (56).

**Deployment order matters.** `OkuM` first (it owns `usdcDecimalMultiplier`),
then `SubscriptionModule` (which cross-asserts `okuM.asset()`), then `USDOku`, then
`USDOkuWrapper` (which asserts against both tokens). The script enforces this; do
not reorder.

**Two post-deploy wiring steps have no on-chain default and both fail closed:**

1. `USDOku.setWrapper(wrapper)` — `DEFAULT_ADMIN_ROLE`. The wrapper does not
   exist when USDOku initializes, so `setUsdOkuRate` reverts `WrapperNotSet` for
   any positive rate until this is called. (A full stop, `newRate == PRECISION`,
   works regardless — the check it lives inside is skipped for that case.)
2. The **treasury allowance** to `SubscriptionModule` — `fulfillRedemption`
   reverts `InsufficientTreasuryAllowance` without it.

`grantRolesMainnet.ts` must perform both, and must also grant `OKU_MINTER` /
`OKU_BURNER` to `SubscriptionModule` on **OkuM** and to `USDOkuWrapper` on
**USDOku**, then revoke the admin's init-time grant of each.

```bash
# Fork pre-flight
FORK_NETWORK=base hh node                            # Terminal 1
hh run scripts/deploy/index.ts --network localhost   # Terminal 2 — auto-detects chain

# Live
hh run scripts/deploy/index.ts --network base
```

Idempotent and resumable: `tryAttach` reuses any contract already in the address
book whose address still has bytecode. Transient RPC errors — `nonce too low`,
`replacement transaction underpriced`, BSC's
`BAD_DATA: invalid address (value="")` pending-tx quirk, timeouts — are retried
with exponential backoff (2s → 32s, five attempts) inside `withRetry`. A provider
shim (`scripts/utils/rpcCompat.ts`) normalises BSC's pending-tx response shape
before ethers' strict formatter sees it.

**Verify on both Etherscan and Sourcify.** `verifyBoth` in
`scripts/deploy/verify.ts` does implementation *and* proxy on both. Sourcify is
not cosmetic here: the ERC-7730 registry linter resolves reference ABIs from
Sourcify first and Etherscan second, and a contract missing from Sourcify
produces the "Could not fetch ABI" warning that silently disables field
validation — the exact failure a reviewer is told to look for.

Then wire the descriptors to the real addresses, per chain:

```bash
NETWORK=base OWNER="…" OWNER_URL="https://…" npm run metadata:sync
npm run metadata:fixtures && npm run metadata:validate -- --strict
```

`--strict` fails on any remaining placeholder. One descriptor set per chain,
because the USDC address is chain-specific.

### Upgrades

```bash
FORK_NETWORK=sepolia hh node                              # Terminal 1
TARGETS=OkuM,USDOku,USDOkuWrapper npm run upgrade         # Terminal 2 — rehearse
TARGETS=OkuM,USDOku,USDOkuWrapper npm run upgrade:sepolia # When the diff is clean
```

`scripts/upgrade/index.ts` verifies the `*_UPGRADER` role before broadcasting,
runs OZ's `prepareUpgrade` so a layout-breaking change aborts before any
transaction, diffs pre/post invariant state (`uiMultiplier`, `newUIMultiplier`,
`effectiveAt`, `epoch`, `usdOkuIndex`, `convertToAssets(1e18)`,
`solvencyGapBps`, `supportsInterface(0xa60bf13d)` on **both** tokens), and
appends an audit trail with old/new implementation, tx hash, signer and
timestamp.

**Upgrading `SubscriptionModule` with requests pending needs a runbook entry.**
The layout validator catches storage breaks, but a logic change to pricing or
expiry semantics applies to requests submitted under the old rules. Either drain
pending requests before upgrading, or version the `Request` struct.

---

## Dependencies

| Library | Version |
|---|---|
| `solc` | `0.8.28` |
| `@openzeppelin/contracts` / `-upgradeable` | `5.6.1` |
| `lib/openzeppelin-contracts` | `v5.6.1` @ `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| `lib/openzeppelin-contracts-upgradeable` | `v5.6.1` @ `7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf` |
| `lib/forge-std` | `v1.12.0` @ `7117c90c8cf6c68e5acce4f09a6b24715cea4de6` |

Node tooling pinned exactly in `package.json`. There is no OpenZeppelin reference
implementation of ERC-8056 to depend on — `ScaledUIAmountUpgradeable` is written
against the EIP text and cross-checked against an external conformance suite. The
only OZ surface beyond a standard ERC-20 is `ERC165Upgradeable` and
`Math.mulDiv`, both in 5.6.1. `npm audit` findings are in transitive dev
dependencies and do not enter production bytecode.

The `dss-lite-psm` fee arithmetic is retained by derivation, not dependency — the
contract shape no longer resembles a PSM.

---

## Pointers

- **Workspace overview:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **Display convention** (normative for integrators): [`metadata/DISPLAY_CONVENTION.md`](metadata/DISPLAY_CONVENTION.md)
- **ERC-7730 clear-signing metadata:** [`metadata/erc7730/`](metadata/erc7730/)
- **SVM implementation:** [`../SVM/README.md`](../SVM/README.md)
- **ERC-8056 (Draft):** https://eips.ethereum.org/EIPS/eip-8056
- **ERC-8056 discussion:** https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899
- **ERC-7540 (async 4626):** https://eips.ethereum.org/EIPS/eip-7540
- **ERC-7730 (Draft):** https://eips.ethereum.org/EIPS/eip-7730
- **Clear-signing registry:** https://github.com/ethereum/clear-signing-erc7730-registry
- **External conformance suite:** https://github.com/jumpboxtech/erc-8056-conformance