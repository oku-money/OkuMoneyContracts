# OkuDollar — EVM Implementation

> See [`../README.md`](../README.md) for shared architecture and cross-VM design.

Solidity contracts for the OkuDollar system: a fully-backed yield-bearing share
token (**OkuM**) and a dollar-denominated rebasing wrapper over it (**USDOku**),
backed by US Treasury Bills.

**Two tokens. Two multipliers. One realized backing.**

---

## Design

The system separates two things that a single token cannot express at once: a
claim on *realized* off-chain yield, and a *smoothed forward-looking* dollar
balance.

| | **OkuM** | **USDOku** |
|---|---|---|
| Balance semantics | Fixed raw balances | Rebasing |
| Denomination | Shares | Dollars (1 USDOku = $1) |
| Accrual | **Stepwise** — discrete marks from realized RWA performance | **Continuous** — smoothed declared rate |
| Direction | Rear-facing (what was earned) | Forward-facing (what is being paid out) |
| Backing | **Fully backed** — hard invariant | **May exceed backing** — bounded, published |
| Chains | EVM + SVM | **EVM only** |
| ERC-8056 | **Yes** | **No** — see below |
| DeFi composability | Full | AMM-hostile by construction |
| Lifecycle | Permanent | **Transitional** — see [Sunset](#usdoku-is-transitional) |

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
                    │  wrap / unwrap at M_oku
                    ▼
   ┌────────────────────────────────────────────────┐
   │  USDOku — rebasing, dollar-denominated          │
   │                                                 │
   │  balanceOf(u) = 1,004.10   (grows every block)  │  ← M_usd, continuous,
   │  1 USDOku = $1.00, always                       │     smoothed, may run
   │  NO uiMultiplier — balanceOf IS the dollar view │     AHEAD of M_oku
   └────────────────────────────────────────────────┘
                    │
                    ▼
   solvency gap = Σ USDOku − (OkuM held by wrapper × M_oku)
   bounded by MAX_SOLVENCY_GAP_BPS, published on-chain, funded by the buffer
```

### Why two tokens

One token and one multiplier cannot express a forward-looking smoothed payout
*and* a rear-facing realized claim. They are different instruments with
different risk. Collapsing them means either the payout is chunky (bad UX) or
the realized claim is smoothed (dishonest about what is actually backed).

### The honest cost

This is not free, and the doc should not pretend it is:

- **USDOku rebases, so `balanceOf` changes with no transfer to observe.** That
  breaks AMM pools, balance snapshots, and most lending markets. This is
  *acceptable* only because USDOku is never intended for those venues — OkuM is
  the composable leg. If anyone proposes an AMM pool for USDOku, the answer is no.
- **Two tokens is real cognitive overhead.** Users must understand which they
  hold. Unwrapping is an extra transaction on every power-user path.
- **Liquidity fragmentation.** Secondary DeFi splits across two assets.

The countervailing fact: a rebasing `balanceOf()` displays correctly in **every
wallet ever written**, with zero integration work. ERC-8056 requires each
integrator to opt in. As of this writing, support exists on BscScan, Mantlescan,
Fordefi, TokenPocket, and Base's enshrined B20 standard (landing at the next
hardfork) — and **not** in MetaMask, Rabby, Uniswap's interface, or 1inch's.

USDOku exists to cover that gap while it closes. It is expected to be deprecated.

### USDOku is transitional

Stated here, at launch, deliberately: **USDOku is a transitional instrument.**
When ERC-8056 display support reaches the wallets our users actually hold, OkuM
alone delivers the same experience and USDOku is retired.

Sunset path, in order:

1. Disable `wrap` (OkuM → USDOku). `unwrap` stays open indefinitely.
2. Announce a redemption window with a **hard end date** and keep the wrapper
   fully funded through it.
3. After expiry, hold residual backing for direct off-chain claims.

**Do not** wind down by draining the wrapper's backing to force insolvency. That
terminates the liability by making redemption fail for whoever is last in line —
a bank run with a published starting gun. It is also a materially different act
for a licensed issuer than a noticed wind-down. Same outcome, no one stranded.

Track `USDOku.totalSupply()` as a first-class metric with an agreed deprecation
threshold, so the sunset decision is data-driven rather than re-litigated.

### Naming

**No `r` / `s` prefix on either ticker.** An `r` prefix reads as *rebasing* to
most DeFi users, which is precisely backwards for OkuM. An `s` prefix implies a
wrapper you unwrap into — true of OkuM today, false after USDOku sunsets. There
is no established Solana convention prefixing scaled-UI-amount mints; do not
claim one.

`OkuM` is the share, `USDOku` is the dollar wrapper. One name per contract,
consistently, in code and docs both.

---

## The two multipliers

Everything downstream depends on these being kept distinct. They are.

### `M_oku` — OkuM's realized index

Dollars per raw OkuM. Stepwise. Written when off-chain RWA performance is marked.

Stored in the `ScaledUIAmount` namespace on `OkuM`, exposed **twice** through two
interfaces that read the identical number:

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
correct — while the multiplier is 18 dp. They are related by a floor, so
`convertToAssets(1e18) == uiMultiplier()` is dimensionally impossible and any
fuzz test written against equality fails immediately.

Corollary worth writing down rather than discovering: **`convertToAssets` and
`convertToShares` are not inverses.** A round trip quantizes to USDC
granularity, losing up to `1e12` in 18-dp terms. Fine for a lending market
pricing collateral; fatal for anything treating it as exact.

### `M_usd` — USDOku's declared rate

The continuous smoothed rate driving USDOku's rebase. Lives in a separate
namespace on `USDOku`. Computed from `baseIndex`, `ratePerSecond`,
`lastAccrualTime`, `rateEnd` — the Aave liquidity-index / `sDAI` `chi` pattern.

`M_usd` is **not** dollars per share. It is the rebase index: a holder's USDOku
balance is `shares × M_usd / PRECISION`, and each USDOku is $1 by definition.

### Why the accrual granularity differs

This is a deliberate asymmetry and the doc states it once, here, so no section
contradicts another:

- **`M_oku` is stepwise on both chains.** T-Bill performance is a discrete mark,
  not a rate-per-second. Publishing it continuously would make it
  forward-looking — which is USDOku's job, not OkuM's. Token-2022 additionally
  forbids `ScaledUiAmount` alongside `InterestBearingConfig`, so SVM is stepwise
  by construction regardless.
- **`M_usd` is continuous, EVM-only.** Smoothing is the whole point; a smoothed
  rate that arrived in jumps would be neither smooth nor forward-looking.

**Consequence, stated plainly:** OkuM has a discrete step, so **local step
arbitrage is a live surface on EVM** — not SVM-only, as an earlier single-token
draft had it. `tin`/`tout` are a real defence here, bound to the step size. See
[Fees](#fees-tin--tout).

**Compensation:** the EVM/SVM accrual-granularity divergence is **gone**. Both
chains step, with the same value at the same cadence, and parity is externally
verifiable by comparing the multiplier **values** directly
(`check-sync-parity.ts` — see [Window mechanics](#window-mechanics)). This was a
standing limitation of the single-token design and this design does not have it.

`M_usd` has no step, so it needs no sandwich guard, no announcement window, and
no forward pricing. Those mechanisms exist only where a step exists.

---

## Solvency

The single most important section. USDOku's declared liability **may exceed**
realized backing — by design. That is what "forward-looking" means. It is only
safe if the gap is bounded, measured, and funded.

### The three quantities

```
liability   = USDOku.totalSupply()                          // dollars, 1:1
backing     = OkuM.balanceOf(wrapper) × M_oku / PRECISION    // dollars, realized
gap         = liability − backing                            // may be > 0
gapBps      = gap × 10_000 / backing
```

All three are exposed on-chain by `USDOkuWrapper`:

```solidity
function declaredLiability() external view returns (uint256);
function realizedBacking()   external view returns (uint256);
function solvencyGapBps()    external view returns (int256);   // signed; may be negative
function backingRatioBps()   external view returns (uint256);  // backing/liability
```

### The bound

`MAX_SOLVENCY_GAP_BPS` is a **constant, not a config field**. No key can widen it.

`setUsdOkuRate` reverts with `SolvencyGapExceeded` if the projected gap at
`rateEnd` would breach the bound. This is the check that makes the declared rate
honest: you cannot promise a rate the realized backing plus buffer cannot fund.

Because the check is a **projection to `rateEnd`**, it cannot be breached
mid-segment by the passage of time alone — the same technique
`MAX_MULTIPLIER` uses.

**The bound is cumulative across rate-write segments, not per single write.**
Worst-case accrual inside one maximum-length segment (`MAX_IMPLIED_APR` over
`MAX_RATE_DURATION`) is only ≈79 bps — *below* `MAX_SOLVENCY_GAP_BPS` (100 bps
placeholder). So no single `setUsdOkuRate` call starting from a zero gap can
ever be refused; the check only bites once several consecutive segments have
out-run realized marks. `Constants.sol` documents this at length on
`MAX_SOLVENCY_GAP_BPS` — the three constants (`MAX_IMPLIED_APR`,
`MAX_RATE_DURATION`, `MAX_SOLVENCY_GAP_BPS`) must be tuned together, or the
solvency bound silently becomes a different, stricter product.

**`solvencyGapBps()` is a monitoring ratio, not a continuously-preserved
invariant — it can legitimately exceed `MAX_SOLVENCY_GAP_BPS` at some blocks.**
The enforced quantity is the *absolute* shortfall, bounded against peak
liability, not the ratio:

- A **wrap** adds matching liability and backing (both price at `M_oku`), so the
  absolute shortfall is unchanged and the ratio can only shrink — a wrap-side
  check would be unreachable code.
- An **unwrap** removes matching liability and backing too, so the shortfall is
  *also* unchanged — but the ratio's denominator (`backing`) shrinks, so
  `solvencyGapBps()` *grows*. Exits alone can walk the ratio past
  `MAX_SOLVENCY_GAP_BPS` with no rate write at all.
- `M_oku` only steps upward, so backing only ever grows; liability grows toward
  the projection and never past it.

So the actual invariant, asserted in
`SystemInvariants.invariant_ShortfallBoundedByPeakLiability`, is on the
*absolute* shortfall against *peak* liability:

```
liability > backing  =>  (liability − backing) <= MAX_SOLVENCY_GAP_BPS × peakLiability / 10_000 + 1
```

Treat `solvencyGapBps()` as the right thing to alarm on — a small shortfall
becoming a large ratio is exactly the shape of a wrapper draining toward its
last holders — but do not assume it stays under the bound at every block; it
does not.

### When the gap approaches the bound

Defined behavior, not improvisation:

| Condition | Action | Who |
|---|---|---|
| `gapBps > MAX_SOLVENCY_GAP_BPS × 50%` | Alarm. Rate write for a *lower* rate still permitted | Monitoring |
| Projected gap would breach | `setUsdOkuRate` reverts | Contract |
| `gapBps` breached by realized underperformance | `haltUsdOkuAccrual()` — freeze `M_usd`, no timelock | `OKU_GUARDIAN` (warm) |
| Sustained breach | Buffer top-up from issuer capital, or rate set below realized to close the gap | Cold multisig |
| Realized marks overtake liability (surplus, the reverse condition) | `USDOkuWrapper.withdrawSurplus` recovers genuinely excess backing, bounded so `realizedBacking() >= declaredLiability()` always holds afterward | `WRAPPER_RESERVE_MANAGER` (cold) |

`M_usd` is **monotone** — the rebase index never decreases. So a breach is closed
by *slowing* accrual until realized catches up, never by writing balances down.
This is a deliberate narrowing and it means a persistent shortfall must be
absorbed off-chain. See Limitation 4.

### OkuM's invariant is hard

Unlike USDOku, OkuM is **fully backed**, asserted:

```
OkuM.totalSupply() × M_oku / PRECISION <= attestedAssets
```

`attestedAssets` is off-chain-sourced (Limitation 2), so this is a
*reconciliation* invariant checked by monitoring, not an on-chain revert. But it
is the line that must not move: OkuM holders are senior and their claim is not
subordinated to USDOku's smoothing.

**Stated for the avoidance of doubt:** USDOku's gap is funded by the buffer and
issuer capital, **not** by diluting OkuM holders. If the buffer is exhausted, the
correct action is to halt `M_usd`, not to let USDOku unwrap into OkuM that
backs someone else's claim.

---

## Rate authority and the gate/lock mechanism

Two rate surfaces, two chains, one lock. This section supersedes any earlier
single-multiplier description.

### Two setters

```solidity
// OkuM.sol — the realized step. Both chains. Cross-chain critical.
function setOkuMultiplier(uint256 newMultiplier) external;  // OKU_RATE_SETTER

// USDOku.sol — the declared smoothed rate. EVM only. Local.
function setUsdOkuRate(uint256 ratePerSecond, uint256 endTimestamp) external;  // OKU_RATE_SETTER
```

`setOkuMultiplier` writes a discrete value, effective immediately, and arms the
post-step sync window on every call — there is no orchestrator-assigned epoch
and nothing to schedule. `setUsdOkuRate` snapshots `baseIndex = usdOkuIndex()`,
sets `lastAccrualTime = block.timestamp`, then writes rate and end — so calling
it before `rateEnd` extends accrual with **no gap and no step**, which is why no
separate pending-rate staging field exists.

### Constraints

**`setOkuMultiplier`:**

| Constraint | Error |
|---|---|
| `newMultiplier >= currentMultiplier` (monotone) | `MultiplierCannotDecrease` |
| Step size `<= MAX_STEP_BPS` | `StepAboveMaximum` |
| `MIN_MARK_INTERVAL` since the last mark | `MarkTooSoon` |
| `newMultiplier <= MAX_MULTIPLIER` | `MultiplierAboveMaximum` |
| Guardian has not halted accrual | `AccrualIsHalted` |

**`setUsdOkuRate`:**

| Constraint | Error |
|---|---|
| `ratePerSecond >= PRECISION` (monotone) | `IndexCannotDecrease` |
| Annualized `<= MAX_IMPLIED_APR` | `RateAboveMaximum` |
| `endTimestamp > block.timestamp` | `RateEndNotInFuture` |
| `endTimestamp - now <= MAX_RATE_DURATION` | `RateDurationTooLong` |
| Projected `M_usd` at `rateEnd` `<= MAX_MULTIPLIER` | `MultiplierAboveMaximum` |
| **Projected solvency gap at `rateEnd` within bound** | `SolvencyGapExceeded` |

### The post-step sync window — REMOVED on EVM

The window fenced value crossing a multiplier boundary **between chains**. Raw is
conserved per instruction, but a cross-chain *pair* prices: burning 100 raw where
`M = 1.0000` destroys $100.00 of claim while minting 100 raw where `M = 1.0001`
creates $100.01, conjuring the difference out of a mid-tick divergence.

**On SVM that pair has dedicated instructions** — `mint_oku_m_direct` and
`burn_oku_m_direct` — and they are still gated. See `SVM/README.md`.

**On EVM there is no such instruction.** `OkuM.mint` and `OkuM.burn` are the
shared supply hooks `SubscriptionModule` and `RedemptionQueue` use for ordinary
*local* subscription and redemption, so gating them gates the entire PSM. An
intermediate revision of this refactor did exactly that — narrowing the window to
"the bridge legs" and then discovering EVM has none — and briefly took every
user-facing path offline for 60 seconds after every mark.

It was then held for a while as an "advisory signal" that gated nothing, which is
worse than absent: a reviewer assumes protection that is not there. So it is
**deleted** — storage, views, `setSyncWindowDuration`, the role, `MAX_SYNC_WINDOW`,
`DEFAULT_SYNC_WINDOW`, the adapter passthroughs, a 462-line test file and an
operator script.

**Nothing is lost.** A future EVM bridge adapter reproduces the fence in one line,
in its own contract, from state ERC-8056 makes us store anyway:

```solidity
if (block.timestamp < okuM.lastSteppedAt() + PROPAGATION_BUDGET) revert;
```

That is tracked in `TRACKER.md` as a precondition on building the adapter.

**Why a time lock is right there and wrong for step arbitrage.** The two edges
differ in kind. Cross-chain divergence is *transient and self-correcting* — once
the lagging chain marks, the edge is exactly zero, so making the attacker wait
erases it. A mark's gain is *permanent* and `M_oku` is monotone, so waiting costs
a step-arbitrageur nothing and no window length deters them. Hence a lock for the
bridge, a fee for the marks.

**Consequently, no user-facing operation on EVM is time-gated at all.** Mint,
redeem, `redeemUiAmount`, `mintUsdOku`, `redeemUsdOku`, `processQueue`, `wrap`,
`unwrap` and `withdrawSurplus` all stay live through a mark, and are priced at
this chain's own `M_oku`, which is correct whatever a peer chain currently
believes. The only time gate left in the system is `MIN_MARK_INTERVAL`, and it
constrains the **operator**, not the user.

**Cross-chain parity is verified off-chain** by comparing multiplier *values*
directly (`check-sync-parity.ts`) — strictly stronger than the epoch bookkeeping
an earlier design used, which only ever proved both chains *wrote*, never that
they wrote the same value.

### The setter is an oracle write

The moment any lending market prices off `uiMultiplier()`, a wrong value mints
borrowing power directly. There is no on-chain referent — `totalAssets()` is
*derived from* the multiplier, not measured. ERC-8056's reference implementation
guards only `> 0` and a future timestamp, which is insufficient for a
value-bearing multiplier.

Controls capping damage from a compromised setter key:

- **`MAX_STEP_BPS`** — ceiling on any single `M_oku` mark, AND the floor under
  `tout`. The binding bound on the value layer, and the single number that
  defines step coverage (see Fees).
- **`MIN_MARK_INTERVAL`** — minimum wall-clock gap between marks. Turns the
  ceiling above into a bound on yield per unit *time* rather than per call.
- **`MAX_IMPLIED_APR`** (1000 bps nominal) + **`MAX_RATE_DURATION`** (30 days) —
  bound `M_usd`. Worst-case over-accrual per segment ≈ **0.82%**.
- **`MAX_SOLVENCY_GAP_BPS`** — bounds how far declared can outrun realized
  regardless of rate.
- **Monotonicity** on both — a compromised key can over-accrue but never
  confiscate by writing a multiplier down.
- **`haltAccrual()` / `haltUsdOkuAccrual()`** — `OKU_GUARDIAN` (warm) freezes
  either index immediately, no timelock. Monotone-safe. Pulls `rateEnd` to `now`
  so the halted state is unambiguous.

`MAX_STEP_BPS`, `MAX_IMPLIED_APR` and `MAX_SOLVENCY_GAP_BPS` are all
**placeholders pending treasury numbers.**

---

## ERC-8056 on OkuM

### Which extensions, and the pending-multiplier reading

| Interface | ID | Claimed |
|---|---|---|
| `IScaledUIAmount` | `0xa60bf13d` | Yes |
| `IScaledUIAmountNewUIMultiplier` | `0x4bd27648` | Yes |
| `IScaledUIAmountConversion` | `0x57854fc3` | Yes |
| `IScaledUIAmountBalances` | `0xd890fd71` | Yes |
| `IERC4626` | — | **No** — conversion views only |

Because `M_oku` is genuinely stepwise, the pending-multiplier extension fits
**natively** — unlike the single-token continuous design, which had to read
`newUIMultiplier()` as "where a trajectory terminates" and flag the divergence
from the EIP's intent as an open question. That awkwardness is gone.

```solidity
function newUIMultiplier() external view returns (uint256);  // the scheduled next step
function effectiveAt()     external view returns (uint256);  // when it takes effect
```

Steps may be scheduled ahead of time, which is exactly what the extension was
designed for and what integrators want for "upcoming adjustment" UI.

### Conformance

There is no OpenZeppelin reference implementation;
`ScaledUIAmountUpgradeable` is written against the EIP text. Two things follow:

1. **Run against an external conformance suite, do not assert boundary
   conformance from the EIP's reference implementation.** That reference has a
   documented defect at `block.timestamp == effectiveAt` — `uiMultiplier()`
   resolves with `>=` while the setter commits with `>`, so a matured pending
   value can silently revert. The deployed Robinhood `Stock` contract fixes it by
   crystallizing the current multiplier unconditionally on every write. Ours does
   the same; verify it against `jumpboxtech/erc-8056-conformance` rather than
   against the reference.
2. **Event-name divergence is real.** The spec names the optional transfer event
   `TransferWithUIAmount`; Robinhood's production contract emits
   `TransferWithScaledUI`. We emit the **spec** name. Indexers built against
   Robinhood Chain will not see our events, and vice versa. Document this for
   integrators rather than letting them discover it.

> ERC-8056 is a Standards Track **Draft** (created 2025-10-20). Interface IDs are
> constants in `Constants.sol`, never inline literals, so a spec revision is a
> one-line change. **Budget for one revision.**

### USDOku does not implement ERC-8056

Deliberate. USDOku's `balanceOf` already returns dollars — it rebases. An 8056
multiplier on top would be a **second scaling factor over an already-scaled
balance**, and an aware wallet would apply it twice.

`USDOku.supportsInterface(0xa60bf13d)` returns `false`. Asserted in the
invariant suite so no future refactor quietly adds it.

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
   moved). `mulDiv` earns its place for three other reasons: it states the
   rounding policy explicitly in one reviewable place; `toUIAmount` /
   `fromUIAmount` are public views accepting arbitrary `uint256` that no supply
   bound constrains; and `MathLib` is shared with `OkuMultiplierAdapter`, which
   may read a third-party ERC-8056 token whose multiplier is unbounded.

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
    uint256 multiplier;        // M_oku. Current, live value.
    uint256 lastSteppedAt;     // Timestamp of the last step. Aliased as
                                // effectiveAt() (ERC-8056) and lastSteppedAt().
                                // Steps are immediate, so newUIMultiplier()
                                // just returns `multiplier` too — no separate
                                // pending-value field exists.
}

// erc7201:okumoney.storage.OkuM                  — OkuM token policy
struct OkuMStorage {
    address asset;                    // USDC. THE single source of truth for
    uint256 usdcDecimalMultiplier;    // this binding; every consumer cross-asserts
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
}

// erc7201:okumoney.storage.SyncWindow            — cross-chain tick fence
struct SyncWindowStorage {
    uint64 lockedUntil;  // Exclusive; 0 = never armed. Assigned, not extended.
    uint64 duration;     // Window length in seconds. 0 = inert.
}

// erc7201:okumoney.storage.UsdOkuIndex           — USDOku's declared rate
struct UsdOkuIndexStorage {
    uint256 baseIndex;        // M_usd anchor, snapshotted at last rate write
    uint256 ratePerSecond;    // Compound per-second (1e18 = no yield)
    uint256 lastAccrualTime;
    uint256 rateEnd;          // Accrual halts here
}
```

`usdcDecimalMultiplier` is derived **once**, in `OkuM.initialize`, from the
deployed USDC's `decimals()`. `SubscriptionModule`, `RedemptionQueue` and
`USDOkuWrapper` each read it from the token and **assert equality against their
own** at `initialize`, reverting on mismatch. Independent derivation in more than
one contract is a silent pricing-divergence bug waiting to happen; there is
exactly one source of truth and every consumer proves it agrees.

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
| `src/token/USDOku.sol` | Rebasing dollar wrapper. Share-denominated ledger, `M_usd` index. **No ERC-8056** |
| `src/wrapper/USDOkuWrapper.sol` | OkuM ↔ USDOku at `M_oku`. Owns the solvency views and `withdrawSurplus` |
| `src/psm/SubscriptionModule.sol` | USDC ↔ OkuM at `M_oku`, plus one-transaction USDC ↔ USDOku (`mintUsdOku`/`redeemUsdOku`) via the wrapper |
| `src/psm/RedemptionQueue.sol` | FIFO queue for redemptions when the buffer is depleted |
| `src/lib/ScaledUIAmountUpgradeable.sol` | ERC-8056 core + all three extensions, ERC-165 registration |
| `src/oracle/OkuMultiplierAdapter.sol` | Chainlink `AggregatorV3Interface`-compatible read of `uiMultiplier()`, with bounds and staleness |
| `src/lib/MathLib.sol` | `toUiAmount`, `fromUiAmount`, `usdcToDollars`, `dollarsToUsdc`, `rpow` |
| `src/lib/Constants.sol` | Constants, interface IDs, terminology legend |
| `src/lib/Roles.sol` · `Errors.sol` · `SafeApprove.sol` · `ReentrancyGuardUpgradeable.sol` | Support |
| `src/interfaces/IOkuM.sol` | `IERC20` + the four ERC-8056 interfaces + value-layer anchor + role-gated supply hooks |
| `src/interfaces/erc8056/*.sol` | The four EIP interfaces, one file each. Real interfaces so `type(I).interfaceId` can be asserted against published IDs |
| `metadata/DISPLAY_CONVENTION.md` | **Normative** for anything rendering a balance |
| `metadata/erc7730/*.json` | Clear-signing metadata for hardware wallets |

**Renamed from `LitePSM`.** Nothing here is pegged. `SubscriptionModule` is a
mint/redeem facility quoting at the current index. A contract called *PSM*, in a
product called *Oku **Dollar***, with `tin`/`tout` fees, will be read by
integrators and counsel as a peg mechanism — OkuM has no peg and never will.
(USDOku's $1 unit comes from the wrapper's 1:1 definition, not from a stability
module.) The `tin`/`tout` names are kept, since the arithmetic is inherited
verbatim from [`dss-lite-psm`](https://github.com/makerdao/dss-lite-psm).

**Stack:** Solidity 0.8.28 / Cancun · Foundry (unit + invariant) + Hardhat
(layout validator + scenarios) · OpenZeppelin v5.6.1 Upgradeable · UUPS proxies ·
ERC-7201 namespaced storage.

Four contracts deploy as UUPS proxies (`OkuM`, `USDOku`, `USDOkuWrapper`,
`SubscriptionModule`, `RedemptionQueue`). `OkuMultiplierAdapter` is deliberately
**immutable and non-upgradeable** — changing its bounds means deploying a new one
and re-pointing consumers, the correct blast radius for a price feed.

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
/ `redeem` are absent — subscription and redemption run through
`SubscriptionModule` and may queue rather than settle. A `deposit()` that reverts
for everyone is worse than an absent one, because integrators detect the
interface and assume it works.

The cost of not claiming: rate providers and risk teams often probe for 4626
shape. The integration guide must state explicitly which four views exist and
that nothing else does.

Plus ERC-20, ERC-2612 permit, `AccessControl`, `Pausable`, UUPS, and the
regulated-issuer controls: per-minter `minterAllowance`, global `maxSupply`,
blacklist. Burning does **not** restore minter allowance.

Pause is a full freeze on `transfer`, `transferFrom`, `mint`. **Burn is not
gated** — self-burn works while paused, supporting the pause-then-blacklist
protocol. Also not gated: `setOkuMultiplier`, `haltAccrual`, `blacklist` —
emergency levers that must remain callable during an incident.

### USDOku

```solidity
function balanceOf(address) external view returns (uint256);   // shares × M_usd
function sharesOf(address) external view returns (uint256);    // the raw ledger
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
| `OkuMultiplierStepped(old, new, stepBps)` | OkuM | Richer than the EIP event; carries `stepBps` for off-chain step-arbitrage monitoring |
| `SyncWindowArmed(lockedUntil)` | OkuM | Emitted by every `setOkuMultiplier` write that arms a nonzero-duration window. No begin/end, no epoch — one event per step |
| `UsdOkuRateSet(oldRate, newRate, rateEnd, snapshotIndex)` | USDOku | Snapshot for off-chain reconstruction |
| `AccrualHalted(atMultiplier)` / `UsdOkuAccrualHalted(atIndex)` | Both | |
| `SolvencyGapUpdated(liability, backing, gapBps)` | Wrapper | Emitted on every wrap/unwrap and rate write. **This is the series to alarm on** |
| `Wrapped(user, okuMAmount, usdOkuAmount, multiplier)` / `Unwrapped(user, usdOkuAmount, okuMAmount, multiplier)` | Wrapper | |
| `SurplusWithdrawn(to, okuMAmount, gapBpsAfter)` | Wrapper | Cold-only, `WRAPPER_RESERVE_MANAGER`. Issuer capital recovered from genuinely excess backing |
| `UsdOkuMinted(user, usdcAmount, usdOkuOut, uiMultiplier)` / `UsdOkuRedeemed(user, usdOkuIn, usdcOut, uiMultiplier)` | Module | One-transaction USDC ↔ USDOku path |
| `UsdOkuWrapperSet(oldWrapper, newWrapper)` | Module | Post-deploy wiring, `PSM_FEE_MANAGER` |
| `StepHighWaterMarkReset(oldMark)` | OkuM | Cold-only. **Alarm on it** — see Limitation 12 |

---

## USDOkuWrapper.sol

```solidity
function wrap(uint256 okuMAmount) external returns (uint256 usdOkuOut);
function wrap(uint256 okuMAmount, address receiver) external returns (uint256 usdOkuOut);
function unwrap(uint256 usdOkuAmount) external returns (uint256 okuMOut);
function unwrap(uint256 usdOkuAmount, address receiver) external returns (uint256 okuMOut);

function quoteWrap(uint256 okuMAmount) external view returns (uint256);
function quoteUnwrap(uint256 usdOkuAmount) external view returns (uint256);

function surplus() external view returns (uint256);
function withdrawSurplus(address to, uint256 okuMAmount) external;  // WRAPPER_RESERVE_MANAGER
```

The `receiver`-parameterized `wrap`/`unwrap` overloads exist for
`SubscriptionModule.mintUsdOku` / `redeemUsdOku`: the module pulls USDC, mints
OkuM to itself, then calls `wrap(rawOut, user)` so USDOku lands directly with
the caller — no intermediate OkuM balance the user has to hold or approve. The
reverse for `redeemUsdOku`: the module pulls USDOku from the user (measuring the
share delta of its own pull), then calls `unwrap(effectiveAmount, address(this))`
so the OkuM lands where the module can redeem it for USDC in the same
transaction.

```
wrap:    usdOku = okuM × M_oku / PRECISION          // dollars in, 1:1 as USDOku
unwrap:  okuM   = usdOku × PRECISION / M_oku
```

**Both directions price at `M_oku`, the realized index — never at `M_usd`.**
This is the load-bearing rule of the whole design. `M_usd` determines how fast a
USDOku *balance* grows; it never determines a conversion rate. If unwrap priced
at `M_usd`, USDOku holders could extract the smoothing gap directly from the
OkuM backing pool, converting a bounded accounting gap into an unbounded drain
on senior holders.

Consequence, stated so nobody has to derive it: a USDOku holder whose balance
grew at the declared rate above realized **can** unwrap for more OkuM than they
wrapped. That extraction is exactly the solvency gap, it is funded by the
buffer, and it is bounded by `MAX_SOLVENCY_GAP_BPS`. It is not a bug; it is the
mechanism.

`wrap` and `unwrap` are both **sync-gated** — they price through `M_oku`.

Neither `wrap` nor `unwrap` reverts on the solvency bound directly — see
[Solvency](#solvency) for why a wrap-side check would be unreachable code, and
why unwrap is deliberately never gated on it either: refusing to let people out
of a wrapper because the wrapper is under-funded is how a slow problem becomes a
panic. (`setUsdOkuRate`'s projection check is the actual solvency gate.)

### Surplus withdrawal

The mirror image of the funding mechanism. `setUsdOkuRate` can open a gap that
donations or issuer top-ups then fund by transferring OkuM into the wrapper.
Once realized `M_oku` marks overtake the declared liability, that capital is no
longer needed as backing — `withdrawSurplus` (`WRAPPER_RESERVE_MANAGER`, cold)
is the recovery path back out. Without it, issuer capital committed to the
wrapper would be permanently stranded the moment it stopped being needed.

```
surplus() = fromUIAmount(max(0, realizedBacking() - declaredLiability()))
```

**Deliberately bounded by `surplus()`, not by `MAX_SOLVENCY_GAP_BPS`.** A
withdrawal may only remove backing the protocol does not need — after
`withdrawSurplus`, `realizedBacking() >= declaredLiability()` always holds. This
is *stricter* than the solvency bound `setUsdOkuRate` is allowed to spend
**into**: if a withdrawal could spend backing **down to** that same ceiling,
issuer capital could walk a fresh gap open from the withdrawal side immediately
after a rate write legitimately opened one from the liability side — the two
mechanisms would fight over the same headroom. `surplus()` reads `0` whenever
`realizedBacking() <= declaredLiability()`, including every block in which any
gap — even one within bound — is open.

Sync-gated: `surplus()` is `M_oku`-priced, so it must not be read or spent while
a step is propagating. Bound checked before the transfer against the
pre-computed `surplus()` value, not re-checked after, so a hostile `IOkuM`
reentering `realizedBacking()` mid-call cannot move the goalposts —
`nonReentrant` covers the token call regardless.

---

## SubscriptionModule.sol

USDC ↔ OkuM at `M_oku`.

```solidity
function mint(uint256 usdcAmount) external returns (uint256 rawOut);
function redeem(uint256 rawAmount) external returns (uint256 usdcOut);
function redeemUiAmount(uint256 uiAmount) external returns (uint256 usdcOut);
function quoteMint(uint256 usdcAmount) external view returns (uint256 rawOut);
function quoteRedeem(uint256 rawAmount) external view returns (uint256 usdcOut);
function redeemableNow() external view returns (uint256 maxRawInstant);

// USDC <-> USDOku, one transaction
function mintUsdOku(uint256 usdcAmount) external returns (uint256 usdOkuOut);
function redeemUsdOku(uint256 usdOkuAmount) external returns (uint256 usdcOut);
function quoteMintUsdOku(uint256 usdcAmount) external view returns (uint256);
function quoteRedeemUsdOku(uint256 usdOkuAmount) external view returns (uint256);
function setUsdOkuWrapper(address newWrapper) external;  // PSM_FEE_MANAGER
```

```
USDC → raw:   raw  = (usdcAmount × usdcDecimalMultiplier) × PRECISION / M_oku
raw → USDC:   usdc = (raw × M_oku / PRECISION) / usdcDecimalMultiplier
```

At `M_oku = 1.05e18`, depositing 100 USDC yields ~95.24 raw OkuM (displayed as
$100.00 by an 8056-aware surface); redeeming 95.24 raw returns ~100 USDC.

Admin surface: `depositBuffer`, `withdrawUsdc`, `processQueue`, `setFees`,
`setUsdOkuWrapper`, `sweepToken`, `pause` / `unpause`. `withdrawUsdc` reverts
`ZeroAddress` on `to == 0` and `WouldStrandQueue` if it would drop the buffer
below outstanding queue obligations.

### USDC ↔ USDOku in one transaction (`mintUsdOku` / `redeemUsdOku`)

**Why this exists.** Without it, acquiring USDOku is mint → approve → wrap
(three transactions) and exiting is the four-transaction reverse — backwards for
a token whose entire purpose is serving wallets that cannot yet render
ERC-8056. `mintUsdOku` mints OkuM to the module itself, then calls
`USDOkuWrapper.wrap(rawOut, msg.sender)` so USDOku lands directly with the
caller; `redeemUsdOku` is the mirror.

**`redeemUsdOku` measures the SHARE DELTA of its own pull, rather than passing
the nominal `usdOkuAmount` straight through to the wrapper.** Flooring the
pull (`transferFrom`, which floors to shares) and flooring the wrapper's own
`unwrap` conversion *independently* could, in principle, ask the wrapper to
pull marginally more than the module actually holds. The module instead:

1. Reads `sharesOf(this)` before and after pulling `usdOkuAmount` from the
   caller, and takes the *delta* — the shares it actually received.
2. Converts that share delta back to a dollar figure at the current
   `usdOkuIndex()` (floored).
3. Hands the wrapper *that* figure, not the caller's nominal input.

Flooring twice this way can only ask for the same or fewer shares than
flooring once — provably no more than the module holds. At most 1 wei of
USDOku dust can be left behind in the module; nothing user-facing rounds
unfavourably. See the NatSpec on `redeemUsdOku` for the full proof.

**Wired post-deploy, fails closed until then.** The wrapper does not exist yet
when the module initializes (deploy order is OkuM → queue → module → USDOku →
wrapper), so `usdOkuWrapper` starts at the zero address and both functions
revert `UsdOkuWrapperNotSet` until `setUsdOkuWrapper` is called.

**Quotes are approximate, not exact like `quoteMint`/`quoteRedeem`.**
`quoteMintUsdOku` composes `quoteMint` with the wrapper's `quoteWrap` and can
overstate by up to the flooring the real path performs on the module's actual
OkuM receipt; `quoteRedeemUsdOku` has the same caveat via `quoteUnwrap`. Fine
for UI display; do not use either as a slippage floor.

Both are sync-gated (they price through `M_oku` via `mint`/`redeem` and
`wrap`/`unwrap`) and emit `UsdOkuMinted` / `UsdOkuRedeemed`.

### Fees (`tin` / `tout`)

**On EVM these are a live defence, not parity parameters.** This is the material
change from the single-token design. `M_oku` steps, so the round trip
mint-at-`M0` / redeem-at-`M1` extracts the step unless fees cover it:

```
profit per unit = M1/M0 − 1 − (tin + tout)/10_000
```

The **step-coverage invariant** therefore binds the *combined* round-trip cost,
not `tout` alone — an earlier draft had this as `tout`-only, which leaks the
mint-side half:

```
tin + tout >= stepBps    for every step taken
```

**Enforced as a relationship between two constants, not as runtime state:**

```
setOkuMultiplier:  stepBps <= MAX_STEP_BPS      // StepAboveMaximum
                   MIN_MARK_INTERVAL elapsed    // MarkTooSoon
setFees:           tout    >= MAX_STEP_BPS      // FeeBelowStepFloor
                   (tin has NO floor; ships at 0)
```

Composed, the exit fee always covers the largest mark the protocol can take, with
no stored state. `initialize` seeds `tout` at the floor, so coverage holds from
block one — no wiring step to forget, no ordering to get wrong.

**The exit leg alone is sufficient.** The arbitrage gain is realised on exit, and
the only exit that drains the buffer is `redeem`, which always charges `tout`:

```
raw   = floor(D / M0)              <= D / M0
gross = floor(raw * M1)            <= D(1 + s)
net   = gross - ceil(gross * tout) <= D(1 + s)(1 - s) = D(1 - s²)  <  D
```

for every mark `s <= MAX_STEP_BPS <= tout`. This holds with `tin = 0`, and holds
cross-chain too, since whichever chain the attacker exits on charges its own
`tout`. **So deposits are free** — which matters, because permissionless
frictionless entry is what this product is for.

**`MIN_MARK_INTERVAL` is what makes the ceiling mean anything.** `MAX_STEP_BPS`
bounds one *call*; nothing bounded how many landed per block, so a compromised
rate setter could loop `setOkuMultiplier` and compound arbitrarily fast. With the
interval, yield is bounded per unit **time**, which is what the fee is sized
against. Ondo enforces the same control on OUSG at 23 hours; we use 1 hour.
`haltAccrual` is separate, immediate and ungated, so incident response is
unaffected — and halting deliberately does not stamp `lastSteppedAt`.

**What this replaced.** The token used to read `tin() + tout()` back from the
module at write time (`StepNotCovered`), ratchet a `stepHighWaterMark`, floor
later `setFees` calls against that mark (`FeesBelowStepFloor`), and expose a cold
`resetStepHighWaterMark` escape hatch. Four interacting mechanisms maintaining
one inequality, plus an escape hatch whose honest precondition — that supply
outstanding at the time of a large past step had substantially turned over — was
not verifiable on-chain. The static floor is strictly stronger (the ratchet only
ever covered steps that had *actually occurred*), removes the token→module
dependency, and removes the un-modelled trust surface.

An intermediate revision floored **both** legs, on a cross-chain leg-pairing
argument that does not survive the exit-leg observation above. Deposits were
briefly taxed for nothing.

**Industry precedent, deliberately not invented here.** The accepted defences for
a discretely-marked share token are (a) continuous accrual, (b) a
subscription/redemption fee at least as large as the mark, (c) a settlement
delay. (a) is unavailable — ERC-8056 and Token-2022 `ScaledUiAmount` both define
the multiplier as a *stored discrete value*. We use (b), the same `tin`/`tout`
shape as MakerDAO's PSM that this module was ported from, and already have (c) in
`RedemptionQueue`. Ondo does the same for OUSG, their stepwise product (1% max
move, 23h minimum interval, fee on the instant path); their *continuous* product,
USDY, needs no fee at all.

`MAX_STEP_BPS` therefore sets the **minimum mark cadence** — and, being the fee
floor as well, the cadence sets the price. One mark is worth `APY x interval`:

| Cadence | Step @5% APY | Required `tout` |
|---|---|---|
| Monthly | 40.7 bps | 41 bps |
| Weekly | 9.6 bps | 10 bps |
| Daily | 1.37 bps | 2 bps |
| **6-hourly** | **0.34 bps** | 1 bps (2 shipped, ~6x headroom) |
| Hourly | 0.057 bps | 1 bps |

**Mark more often, charge less.** In the limit of continuous accrual the fee is
zero, which is exactly why sDAI and aTokens need none. The fee is the price of
the discreteness Token-2022 forces on us, and nothing more.

At the provisional 2 bps one mark absorbs ~1.5 days of catch-up; a longer outage
is walked over several marks. Same operator-absence protection `MAX_IMPLIED_APR`
provides on USDOku, and deliberate rather than a limitation.

Fees are **withheld, not forwarded** — `tin` enters the buffer with no OkuM
minted against it, `tout` is owed but never transferred out. No recipient, no
sweep, so a fee raises the collateral ratio. Fees round up, payouts round down.

Queued redemptions **snapshot** `tout` at `enqueue` and settle at
`min(snapshot, live)` — protected from an increase, passed a decrease, so a
queued user never pays more than someone redeeming instantly beside them.
`getQueueEntryValue` reports the snapshot (it cannot see the live fee — no
`msg.sender`), erring low rather than over-promising. `quoteMint` / `quoteRedeem`
are fee-inclusive; `redeemableNow` is deliberately fee-free (a fee only reduces
USDC leaving the buffer, so the capacity bound stays valid); `totalQueuedUsdc` is
a fee-free upper bound (per-entry snapshots make an exact O(1) figure impossible,
and over-approximating is the safe direction for sizing the `processQueue`
approval).

---

## RedemptionQueue.sol

Stores **raw OkuM**. Raw balances are fixed, so queued amounts do not grow in
count — they appreciate in dollar value via `M_oku`. At processing,
`usdcAmount = rawAmount × M_oku / PRECISION`, scaled to USDC decimals. The
multiplier is cached once per batch for gas and cross-entry consistency.

```solidity
function enqueue(address user, uint256 rawAmount, uint256 toutBps) external; // QUEUE_PSM
function processQueue(uint256 startIndex, uint256 endIndex) external;        // QUEUE_PSM
function rescueQueueEntry(uint256 index, address alt) external;              // QUEUE_RESCUER
function sweepExcess(address to) external;                                   // QUEUE_RESCUER
function advanceHead(uint256 maxSlots) external;                             // permissionless
```

`enqueue` is record-only — the module transfers tokens in before calling.
`toutBps` is snapshotted into the entry (free: `uint16` in bits already left in
the `address user` slot) so a later fee change cannot retroactively tax users
already waiting.

`sweepExcess` exists because the escrow-backing invariant is a **bound, not an
equality**. Anyone can transfer OkuM to the queue for free, so
`totalQueuedRaw == balanceOf(queue)` would be permanently griefable; the
invariant is `<=` and the sweep recovers the surplus, capped at
`balanceOf(this) − totalQueuedRaw` so it provably cannot touch user escrow.
`SubscriptionModule.sweepToken` is the same idea for donations and explicitly
refuses USDC — the buffer has its own gated path with the `WouldStrandQueue`
check.

`processQueue` **is** sync-gated but deliberately **not** pause-gated. Pause is
unbounded incident response, so gating queue processing on it could strand users
indefinitely; the mark cadence is bounded by `MIN_MARK_INTERVAL`, and it can only
ever be open because a real, capped, fee-covered multiplier step armed it.

Neither `processQueue` nor `rescueQueueEntry` advances `queueHead`; `advanceHead`
amortizes the head walk into a separate gas-bounded transaction. `queueLength()`
is an upper bound until it runs. Redemption correctness is independent of the cursor.

USDC transfers use `SafeERC20.trySafeTransferFrom`, which swallows reverts *and*
decodes the boolean return — a non-standard ERC-20 returning `false` without
reverting is soft-skipped rather than treated as paid.

---

## OkuMultiplierAdapter.sol

Chainlink `AggregatorV3Interface`-compatible read of `OkuM.uiMultiplier()`.

```solidity
function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
function decimals() external pure returns (uint8);   // 18 — NOT Chainlink's usual 8
function isHealthy() external view returns (bool);
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

Immutable and non-upgradeable: `minAnswer`, `maxAnswer`, `stalenessThreshold` are
constructor args. **Staleness** fires when the last step (`effectiveAt()` /
`lastSteppedAt()`) is older than `stalenessThreshold` — a lapsed mark leaves the
multiplier flat and *truthful*, but a consumer should not price off it
indefinitely. `getRoundData` always reverts: this is a live derivation, not a
push feed with history.

**No `isAccrualStopped()` view.** An earlier version exposed one; it was
removed because under stepwise accrual the answer was true between every pair
of marks — a step is a discrete event, not a continuous flow, so "has accrual
stopped" read as "stopped" at literally every block that was not itself the
block of a step. The view told consumers nothing they could not already get,
more accurately, from staleness against `effectiveAt()`.

**A mark does not make the feed unhealthy.** The multiplier
is genuinely correct the instant a mark lands — the mark IS the new price.
Reporting unhealthy would trigger needless liquidation pauses on an accurate
feed. There is no longer any asymmetry to branch on either: nothing user-facing
is gated by a mark, so a position valued off this feed can always be unwound
through the module in the same block. Staleness of the last mark
(`effectiveAt()`) is the only health signal, and it is the one a price consumer
actually wants.

Note the protocol-wide asymmetry: no oracle gates the *input* side (USDC peg
monitoring is off-chain), but this adapter makes the system a price **publisher**
on the output side. Worth an auditor's attention.

---

## Precision and rounding

- **18 decimals on both tokens.** With a growing multiplier, 6 decimals surfaces
  display-layer dust far sooner than expected.
- **One rounding direction, stated once:** every conversion rounds **against the
  caller, in favour of the protocol**. `toUIAmount`, `fromUIAmount`, `wrap`,
  `unwrap` all truncate; the caller absorbs the loss.
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
must be computed from `sharesOf`, not from `balanceOf`, because `balanceOf` moves
between the read and the transaction. `getMaxSendShares()` exists for this and
has no inverse either.

---

## Integration surface

The contracts are small. This is where the work is.

### The double-count hazard — normative

**This is the failure mode most likely to reach production, and it is not an
amount bug. It is an amount × price bug.**

An 8056-aware wallet reads the *amount* from the chain and the *price* from an
aggregator. Those are separate subsystems that do not know about each other. Pair
`balanceOfUI() = 1,000` with a market quote of $1.05 for raw OkuM and it renders
**$1,050** for a $1,000 position. The error is exactly the accrued yield and it
**grows with the multiplier**.

> **Normative rule.** Any consumer that applies `uiMultiplier()` to an amount
> MUST price the result at **$1.00 per unit**. Any consumer that prices raw OkuM
> at a market quote MUST use the **raw** `balanceOf`, never `balanceOfUI`.
> Applying both is a double-count.

Restated as the only two valid pairings:

| Amount | Price | Result |
|---|---|---|
| `balanceOf` (raw) | market quote for OkuM | correct |
| `balanceOfUI` (scaled) | $1.00 | correct |
| `balanceOfUI` (scaled) | market quote for OkuM | **WRONG — overstates by `M_oku`** |

This is not hypothetical: it is the same trap Robinhood documents in its own
stack, where the REST `/prices` endpoint returns the raw underlying quote while
the Chainlink feed returns the multiplier-adjusted one. They are largely
protected because nearly all their multipliers still read exactly 1.0. `M_oku`
will be off 1.0 from week one and permanently drifting.

`DISPLAY_CONVENTION.md` carries this rule normatively. Every integration
conversation opens with it.

### Every surface needs review

The app and any embedded wallet; third-party wallets (the long tail — there is no
EVM equivalent of Solana's RPC-level `uiAmount`, so each must integrate
explicitly); explorers, trackers, indexers, subgraphs; custodians and exchanges;
bridges.

**Hardware wallet signing is a launch blocker.** Ledger and Trezor render raw
calldata amounts. The app says "$1,050"; the device says "1,000." Ship
**ERC-7730** clear-signing metadata for both tokens and every module entry point
**before** launch. Field labels deliberately read
`Amount (OkuM units, NOT dollars)` rather than a bare `Amount`, so a device that
cannot apply the multiplier is still unambiguous.

**Check the wallet risk-banner behavior before launch.** TokenPocket ships
in-app risk alerts on ERC-8056 tokens as a class, aimed at the inflate-a-worthless-
balance scam pattern. It is unclear whether the alert is a blanket class notice or
a targeted heuristic. Load a Robinhood stock token in TokenPocket and observe —
ten minutes, and it tells us whether the surface we are counting on will show a
caution banner on a legitimate token.

### Ship alongside the contracts

| # | Deliverable | Status |
|---|---|---|
| 1 | **Display convention** incl. the double-count rule and the two-token disambiguation | ⚠️ needs the double-count section |
| 2 | **ERC-7730 metadata** for both tokens and every module entrypoint | ⚠️ written for OkuM; USDOku + wrapper pending. **Launch blocker until submitted to the Ledger registry** |
| 3 | **`OkuMultiplierAdapter`** | ✅ shipped |
| 4 | **Client SDK** — `getDisplayBalance()`, `getMaxSendRaw()` / `getMaxSendShares()` with no inverses, `allowanceUI`, solvency views, ERC-165 detection internal | ❌ not built |
| 5 | **Reference integrations, open-sourced** — one AMM, one lending market, both against OkuM | ❌ not built |
| 6 | **Own-frontend 8056 support** | ❌ — the reference implementation others will copy. Highest-leverage adoption lever we control |

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
aggregators will list it there. This is *correct* — OkuM is not pegged — but the
team should expect it at launch rather than treat it as a depeg. ERC-8056 scales
amounts, not prices; no amount of wallet adoption changes this.

**Cross-chain.** One canonical `M_oku` source pushed to satellites. Bridges move
**raw units and nothing else** — audit each for decimal or display handling.
Bridge legs are sync-gated per clause (a) of the gating rule. USDOku does not
bridge; it is EVM-only.

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

```
USDC → raw:   raw    = (usdcAmount × dm) × PRECISION / M_oku
raw → USDC:   usdc   = (raw × M_oku / PRECISION) / dm
raw → UI:     ui     = raw × M_oku / PRECISION          // toUIAmount
UI → raw:     raw    = ui × PRECISION / M_oku           // fromUIAmount
OkuM → USDOku: usdOku = okuM × M_oku / PRECISION         // wrap — M_oku, NOT M_usd
USDOku → OkuM: okuM   = usdOku × PRECISION / M_oku       // unwrap — M_oku, NOT M_usd
USDOku balance: bal   = shares × M_usd / PRECISION

parity (a BOUND, not an equality):
  convertToAssets(1e18) × dm  <=  M_oku  <  (convertToAssets(1e18) + 1) × dm
```

---

## Constants

Every bound is a **constant, not a config field**. No key — warm or cold — can
widen a window, raise a fee ceiling, shorten the anti-grief gap, or loosen the
solvency bound.

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1e18` | Fixed-point base. ERC-8056 mandates 18-dp multiplier precision |
| `BASIS_POINTS` | `10_000` | Convention |
| `SECONDS_PER_YEAR` | `365 days` | Annualization base |
| **`M_oku` authority** | | |
| `MAX_STEP_BPS` | **2 (provisional)** | Ceiling on one mark AND the floor under `tout`. The single number defining step coverage. Sized for a 6-HOURLY cadence at ~5% APY (~0.34 bps/mark, ~6x headroom). **Needs treasury sign-off on the cadence, after which this follows mechanically** |
| `MIN_MARK_INTERVAL` | **1 hour** | Minimum gap between marks. What makes `MAX_STEP_BPS` a bound on yield per unit *time* rather than per call |
| `MAX_MULTIPLIER` | `1e24` | Cumulative ceiling. Round-number convention |
| **`M_usd` authority** | | |
| `MAX_IMPLIED_APR` | `1000` bps | Nominal (simple) annualization. At the cap the per-second ceiling compounds to ~10.52% APY — delivered APY sits slightly above nominal by construction, documented rather than corrected because a monotone-in-rate check is cheaper to audit than an `rpow` round trip in the setter. **Placeholder** |
| `MAX_RATE_DURATION` | `30 days` | Exposure window of one rate write. Worst-case over-accrual from a compromised key ≈ **0.82%** per segment. Operational cost: a missed renewal freezes yield, and since the cap also binds catch-up, a long outage cannot be fully compensated |
| `MAX_SOLVENCY_GAP_BPS` | **TBD** | How far declared may outrun realized. **The number that defines the product's risk. Placeholder — needs treasury sign-off, not an engineering guess** |
| **Supply** | | |
| `MAX_TOTAL_SUPPLY` | `1e33` | Ceiling on `maxSupply`, enforced in **both** `initialize` and `setMaxSupply`. `maxSupply` is mutable, so an init-only assertion would evaporate the first time the cap moved — and with it the overflow invariant |
| **Sync window** | | |
| `MIN_MARK_INTERVAL` | `1 hour` | Minimum wall-clock gap between marks. Makes `MAX_STEP_BPS` a bound on yield per unit *time* rather than per call. Applies to `setOkuMultiplier` and `distributeYield` alike, so the two cannot be alternated around it |
| **Fees** | | |
| `MAX_FEE_BPS` | `100` (1%) | Anti-confiscation *and* the binding constraint on maximum step size. Worst case is a 1% haircut, not seizure |
| **Misc** | | |
| `MAX_USDC_DECIMALS` | `18` | USDC is 6 dp everywhere targeted. Capping rather than hardcoding 6 is forward-compat. Also the only configuration where `SubscriptionModule.mint`'s `AmountTooSmall` guard is reachable |
| `IID_SCALED_UI_*` | see above | From the draft EIP. Pinned |

Each has an SVM mirror in `oku_shared::constants` — `MIN_MARK_INTERVAL_SECS`,
`MAX_FEE_BPS`, `MAX_STEP_BPS` — so the two chains
cannot drift on the bounds defining the tick protocol. `MAX_SOLVENCY_GAP_BPS`
and `MAX_IMPLIED_APR` have **no** SVM mirror: USDOku is EVM-only.

---

## Roles

Each contract's `initialize` grants its full role set to `admin`, who
redistributes post-deployment. Exception: `RedemptionQueue.QUEUE_PSM` is granted
after deployment to the `SubscriptionModule` proxy, avoiding a circular
dependency and keeping admin from calling `enqueue` / `processQueue` directly.

| Role | Held by | Can do | Bounded by |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Cold | Grant/revoke any role | Nothing — meta-role |
| `*_UPGRADER` | Cold | Replace logic via UUPS | Nothing — mitigated by fork rehearsal and diff review |
| `OKU_ALLOWANCE_MANAGER` | Cold | Set `minterAllowance` | Capped at `maxSupply`; minting still needs `OKU_MINTER` |
| `OKU_CAP_MANAGER` | Cold | `setMaxSupply`, `resumeAccrual` | Cap cannot go below `totalSupply()` |
| `PSM_FEE_MANAGER` | Cold | `setFees`, `setUsdOkuWrapper` | `tin` in `[0, MAX_FEE_BPS]`, `tout` in `[MAX_STEP_BPS, MAX_FEE_BPS]`; cannot retroactively change queued entries |
| `PSM_BUFFER_WITHDRAWER` | Cold | Drain buffer | Cannot drop below outstanding queue obligations |
| `WRAPPER_ADMIN` | Cold | Disable `wrap` (sunset step 1) | **Cannot disable `unwrap`** — deliberate |
| `WRAPPER_RESERVE_MANAGER` | Cold | `withdrawSurplus` | Bounded by `surplus()`; post-withdrawal `realizedBacking() >= declaredLiability()` always. Distinct from `WRAPPER_ADMIN` — moving capital out is a different capability than gating the sunset switch |
| `OKU_PAUSER` / `PSM_PAUSER` | Warm | Halt operations | Cannot unpause — cold only |
| `OKU_UNPAUSER` / `PSM_UNPAUSER` | Cold | Resume | Deliberately a different role: a compromised warm key can stop the protocol but never restart it |
| `OKU_BLACKLISTER` | Warm | Block an address | Cannot unblacklist; cannot access funds |
| `OKU_UNBLACKLISTER` | Cold | Unblock | Same split, same reason |
| `OKU_GUARDIAN` | Warm | `haltAccrual()`, `haltUsdOkuAccrual()` | Can only stop growth. Cannot set a rate, reduce either multiplier, **or arm a sync window**. Pulls `rateEnd` to `now` so the halted state reads unambiguously as "nothing pending" |
| `OKU_RATE_SETTER` | Orchestrator | `setOkuMultiplier`, `distributeYield`, `setUsdOkuRate` | Step cap, **mark cadence**, APR cap, duration cap, monotonicity, `MAX_MULTIPLIER`, **solvency bound** |
| `PSM_QUEUE_PROCESSOR` | Orchestrator | Process queue entries | Destination fixed to the entry's `user` |
| `PSM_BUFFER_DEPOSITOR` | Orchestrator | Deposit USDC to buffer | Caller must hold the USDC |
| `QUEUE_RESCUER` | Warm | `rescueQueueEntry`, `sweepExcess` | Cannot redirect a live entry's payment; sweep capped at `balanceOf − totalQueuedRaw` |
| `OKU_MINTER` | **SubscriptionModule + USDOkuWrapper (contracts)** | `OkuM.mint()` / `USDOku.mint()` in the swap path | Per-minter allowance and `maxSupply` |
| `OKU_BURNER` | **SubscriptionModule + RedemptionQueue + USDOkuWrapper (contracts)** | `burn()` on instant, queued, and unwrap paths | Burns only the caller's own balance |
| `QUEUE_PSM` | **SubscriptionModule (contract)** | `enqueue`, `processQueue` | Granted post-deploy, never in `initialize` |

The last three are **contract-only**. `grantRolesMainnet.ts` verifies they are
held by the expected proxies *and* asserts no cold, warm or orchestrator key
holds any of them — a separation-of-duties check that fails the run rather than
warning.

Named `OKU_RATE_SETTER`, not `REBASER`. **Note:** USDOku *does* rebase, so unlike
the single-token design this name is a scoping choice rather than a factual one —
the role sets rates on both tokens, and only one of them rebases.

`PSM_FEE_MANAGER` is intended for the same cold key as `OKU_CAP_MANAGER` — a fee
schedule is economic policy of the same class as a supply cap. It is nonetheless
a distinct, PSM-namespaced constant, because AccessControl mappings are
per-contract: gating a module function on a role whose name reads as a token role
would defeat the prefix convention that keeps a grant on one contract from being
mistaken for a grant on another. `setUsdOkuWrapper` (post-deploy wiring of the
USDOku ↔ USDC convenience path) reuses `PSM_FEE_MANAGER` for the same reason —
same cold key already performs this class of one-time wiring, e.g.
`USDOku.setSolvencySource`.

---

## Invariants

Stateful-fuzz invariants in `SystemInvariants`, driven by an **adversarial**
handler that donates tokens to the module, the queue, and the wrapper. That
handler is why every backing property is a **bound and never an equality**: free
token donations are unpreventable, so an equality would be a permanently
griefable failure rather than a property of the protocol.

```
// OkuM display / value parity
convertToAssets(1e18) × dm <= uiMultiplier() < (convertToAssets(1e18)+1) × dm
totalSupplyUI() == totalSupply() × M_oku / PRECISION
fromUIAmount(toUIAmount(x)) ∈ [x-1, x]                      // fuzzed, full range
Σ balanceOfUI(holder) <= totalSupplyUI()                    // gap <= 1 wei per holder

// M_oku
M_oku >= previousM_oku                                      // monotone
stepBps <= MAX_STEP_BPS                                     // every mark
tout >= MAX_STEP_BPS                                        // step coverage
markGap >= MIN_MARK_INTERVAL                                // cadence bound
M_oku <= MAX_MULTIPLIER
uiMultiplier() == newUIMultiplier() once past effectiveAt()  // ERC-8056 boundary contract

// M_usd
M_usd >= previousM_usd                                      // monotone
M_usd continuous across every setUsdOkuRate call            // slope moves, value does not
M_usd constant once block.timestamp >= rateEnd              // accrual halts
impliedAprBps() <= MAX_IMPLIED_APR

// Solvency — the load-bearing set
liability > backing =>
    (liability - backing) <= MAX_SOLVENCY_GAP_BPS × peakLiability / 10_000 + 1
                                                             // absolute shortfall, NOT the ratio —
                                                             // solvencyGapBps() alone is a monitoring
                                                             // signal and can exceed the bound (unwraps
                                                             // shrink the denominator, not the shortfall)
USDOku.totalSupply() == Σ (sharesOf × M_usd / PRECISION)    // exact, share layer
wrap/unwrap price at M_oku, never M_usd                     // asserted structurally
withdrawSurplus never leaves realizedBacking() < declaredLiability()

// Sync window
markGap >= MIN_MARK_INTERVAL                                // cadence, always
setOkuMultiplier always arms on a nonzero-duration write     // fail-closed, unconditional

// Raw layer
OkuM.balanceOf(u) == OZ ERC20 _balances[u]                  // stock OZ, unmodified
Σ OkuM.balanceOf(holder) == OkuM.totalSupply()              // exact — raw layer only
OkuM.totalSupply() <= maxSupply
maxSupply <= MAX_TOTAL_SUPPLY                               // init AND setMaxSupply
MAX_TOTAL_SUPPLY × MAX_MULTIPLIER < type(uint256).max       // static assertion

// Interface
OkuM.supportsInterface(0xa60bf13d) == true
OkuM.supportsInterface(<4626-shaped id>) == false           // we do NOT claim this
USDOku.supportsInterface(0xa60bf13d) == false               // NEVER — double-scale guard

// Module / queue
queue.totalQueuedRaw <= OkuM.balanceOf(queue)               // BOUND: donations
totalQueuedUsdc() == dollarsToUsdc(toUiAmount(totalQueuedRaw))
usdcOutflow <= seededBuffer + trackedDeposits + donations

// Allowance
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                        // burns do not restore
```

Properties deliberately **without** an invariant: none asserts the buffer covers
the queue obligation — entries queue precisely when it does not, and
`WouldStrandQueue` only stops the withdrawer making an existing shortfall worse.
None of the form `OkuM.balanceOf(module) <= 1 wei`: that asserted an accounting
property through a griefable proxy, and is replaced by the real one — the module
never reads its own token balance for pricing.

---

## Testing

```bash
forge install && forge build
forge test
forge test --match-path "test/invariants/*"          # 256 runs × 500 depth
npx hardhat compile && npx hardhat test              # layout validator + scenarios
```

| Suite | Covers |
|---|---|
| `ERC8056Conformance` | All four interface IDs; conversion round-trips; balance identities; `UIMultiplierUpdated`; the `uiMultiplier() == newUIMultiplier()` boundary contract. **Cross-checked against `jumpboxtech/erc-8056-conformance`**, not against the EIP's reference implementation |
| `StepArbitrageTest` | The round trip across a mark at every admissible `(tin, tout, stepBps)` combination — `tin` sampled **from zero**, which is what proves the exit leg alone suffices. Exhaustive over the mark dimension now that `MAX_STEP_BPS` is small. Plus the `tout` floor (`FeeBelowStepFloor`), the mark ceiling (`StepAboveMaximum`), the cross-chain leg pairing, and that a zero `tout` is unreachable |
| `SolvencyTest` | Gap accounting across wrap/unwrap/step/rate sequences; `SolvencyGapExceeded` on `setUsdOkuRate`; unwrap never gated on solvency; gap closing as realized catches up; `withdrawSurplus` — bounded by `surplus()`, `ExceedsSurplus` rejection, post-withdrawal `realizedBacking() >= declaredLiability()` |
| `WrapperTest` | `wrap`/`unwrap` price at `M_oku` and never `M_usd` (differential against a mutant that uses `M_usd`); round-trip dust; sunset — `wrap` disabled, `unwrap` still open; the `receiver`-parameterized overloads |
| `UsdOkuConvenienceTest` | `mintUsdOku`/`redeemUsdOku` end to end; `UsdOkuWrapperNotSet` before wiring; the share-delta rounding proof pinned against a mutant that passes the nominal amount straight through; sync-gating |
| `RebaseTest` | **New.** USDOku share-ledger identities; `balanceOf` continuity across rate writes; max-send from `sharesOf`; `supportsInterface(0xa60bf13d) == false` |
| `AccrualTest` | `M_usd` continuity across rate changes; halt at `rateEnd`; re-anchoring; APR and duration cap rejections; `haltUsdOkuAccrual` |
| `MaxSendTest` | The max-send rule against the real transfer path on **both** tokens, at low and high multiplier |
| `TenYearAccrualTest` | Long-horizon: overflow, precision drift, dust, and **cumulative solvency gap over a full rate cycle** |
| `MulDivBoundsTest` | What `mulDiv` actually buys. Naive and `mulDiv` agree across the legal envelope (so it is not papering over a real overflow); `mulDiv` survives hostile-counterparty inputs where naive reverts; the extended domain is still **bounded**. Plus `rpow` branch coverage |
| `RedemptionQueueTest` | Queue lifecycle; the three soft-skip paths (`AlreadyCleared`, `InsufficientFunds`, `TransferFailed`) via `MockUSDC.setBlocked` (revert) and `setReturnFalse` (non-standard `false`) |
| `OkuMTest` | Regulated-issuer surface: supply cap incl. `MAX_TOTAL_SUPPLY` on **both** write paths, minter allowances, blacklist reachable through `_update` on mint/burn, pause semantics, permit, upgrade authorization |
| `OkuMultiplierAdapterTest` | Bounds, staleness, halt→fresh→stale, 18-decimal reporting, `getRoundData` refusing history |
| ~~`SyncWindowTest`~~ | **Deleted with the window.** What survives is distributed: `OkuMultiplierTest` pins the cadence bound (`MarkTooSoon` on both entry points, and that `haltAccrual` does not consume the cadence), and the Hardhat suite asserts every user-facing path stays live through a mark |
| `FeesTest` | `tin`/`tout` arithmetic and ceil-rounding; accrual to the buffer; fee-inclusive quotes; per-entry `tout` snapshot surviving a governance change; the two regressions written against a fee-free world — **ported, not deleted** |
| `SystemInvariants` | Stateful-fuzz at 256 runs × 500 depth, adversarial handler donating to module, queue, **and wrapper** |
| Hardhat `Scenarios.ts` | OZ storage-layout validator on a real `upgradeProxy`; twelve-month operating scenario incl. a **full rate cycle where declared runs ahead then behind**; the **high-multiplier regime** (≥5x); incident protocol end to end; multi-holder fairness; adapter lifecycle; **the sunset sequence** |

Foundry is authoritative for functional coverage. Hardhat carries what Foundry
cannot or covers less naturally: the OZ layout validator (forge cannot invoke
it), multi-contract scenarios with full deploy-script wiring, and the
high-multiplier regime.

That last one earns its place. **At `M_oku == 1e18` the raw and displayed numbers
are identical, so every off-by-a-multiplier bug is invisible.** Half the Hardhat
suite runs at ≥5x for exactly that reason. The same logic now applies to
`M_usd`: scenarios must run with a nonzero solvency gap, because at gap zero
every wrap/unwrap mispricing is invisible too.

CI fails below **95% line coverage** on any `src/` file, with **100% required on
`ScaledUIAmountUpgradeable` and `USDOkuWrapper`** — both small, both on every
pricing path.

**Harnesses** (test-only, never in a production import path):

- `MathLibHarness` — exposes `rpow` so the `x == 0` and `mul`-overflow branches of
  MakerDAO's assembly are reachable, plus `naiveToUiAmount` for differential
  comparison against `mulDiv`.
- `ScaledUIHarness` — drives `M_oku` to arbitrary values **including
  standard-legal ones this token forbids** (below `PRECISION`, above
  `MAX_MULTIPLIER`, decreasing). Two jobs: reaching defensive bounds legitimate
  accrual cannot, and standing in as a hostile-but-conformant ERC-8056
  counterparty for anything reading a third-party token.
- `SolvencyHarness` — forces arbitrary gap and surplus states, including past
  `MAX_SOLVENCY_GAP_BPS` and into genuine over-backing, so both recovery paths
  (`haltUsdOkuAccrual` closing a gap, `withdrawSurplus` recovering excess) are
  reachable without a multi-year fuzz run.
- `MockUSDC` — 6-decimal, with `setBlocked` (revert, Circle's blacklist shape)
  and `setReturnFalse` (non-standard silent `false`) independently selectable.
- `MockHighDecimalToken` — configurable `decimals()`. Above 18 to exercise
  rejection; at exactly 18 to reach `AmountTooSmall`, unreachable with 6-dp USDC.

Note `bound()` is **not** used anywhere — `_bound()` is. Numerically identical,
but `bound` emits a `console2` log per call, and at 128,000 handler calls per
invariant run that buries the output.

---

## Limitations

**1. Centralized rate authority, no timelock.** Two setters, both on the
orchestrator key. `MAX_STEP_BPS`, `MAX_IMPLIED_APR`, `MAX_RATE_DURATION`,
`MAX_SOLVENCY_GAP_BPS`, monotonicity and the two halts bound the damage.
Worst-case `M_usd` over-accrual per segment ≈ 0.82%. Role grants, upgrades and
buffer withdrawals remain unbounded beyond multisig custody.

**2. No on-chain backing verification.** `totalAssets()` is derived from `M_oku`,
not measured. The value interface is exactly as trustworthy as the multiplier
authority. The OkuM full-backing invariant is a *reconciliation* property checked
off-chain, not an on-chain revert. Inherent to off-chain RWA backing.

**3. USDC peg monitoring is off-chain.** No oracle gates mint/redeem on USDC's
peg; the orchestrator monitors and pauses. Note the asymmetry: no oracle on the
input side, but `OkuMultiplierAdapter` makes this system a price *publisher* on
the output side.

**4. Both multipliers are monotone; neither has a downward path.** Over-accrual
of `M_usd` relative to realized backing cannot be corrected on-chain — only
slowed. A persistent shortfall must be absorbed off-chain. Adding a downward
path later is not a patch: it needs a longer timelock on decreases than
increases, mandatory advance notice, and liquidation-impact review with every
lending venue.

**5. ERC-8056 is a Draft.** IDs shift if any signature changes. Re-conforming is
a one-line change and a single-contract upgrade. We emit the spec's
`TransferWithUIAmount`; Robinhood Chain emits `TransferWithScaledUI` — indexers
built for one will not see the other.

**6. USDOku's dollar unit is a definition, not a market price.** 1 USDOku = $1 by
wrapper construction. There is no arbitrage keeping it there and no on-chain
oracle asserting it. If USDOku ever trades on a secondary venue it may trade
away from $1, and the protocol has no mechanism to defend that. This is the
reason USDOku should not be pooled or used as collateral.

**7. Allowance value drift.** OkuM allowances are raw-denominated, so a bounded
approval's *dollar* value grows with `M_oku`. Mitigated by `allowanceUI` on-chain
and surfacing drifted approvals in the app; there is no contract-level fix
preserving ERC-20 semantics. USDOku allowances drift too, in the opposite
direction — a raw-share approval on a rebasing token — and `sharesOf` is exposed
so integrators can reason about it.

**8. Max-send rounding hazard.** Inherent to any scaled-display or rebasing
token; mitigated by SDK design rather than eliminated. Now applies to **both**
tokens, for different reasons.

**9. `advanceHead` is permissionless.** No privileged effect — `queueHead` only
moves forward, only past cleared slots, gas-bounded by `maxSlots`.

**10. Two tokens is real complexity.** Cognitive overhead, an extra unwrap
transaction on power-user paths, and liquidity fragmentation across two assets.
Accepted deliberately, with a documented sunset path.

**11. Cross-chain tick completion is attested, not proven on-chain.** Neither
chain observes the other: no bridge, oracle or message passing between them for
multiplier state. Each chain fences itself with its own auto-arming sync
window; nothing on-chain asserts what the *other* chain wrote. Parity is
verified off-chain by directly comparing multiplier **values**
(`check-sync-parity.ts`, `M_oku(evm) / 1e9 == multiplier(svm)`) rather than by
comparing tick numbers — this is strictly stronger than the epoch-based check
an earlier design used (equal epochs only ever proved both chains *wrote*,
never that they wrote the *same value*; direct value comparison catches a
wrong-value write and a missing write alike), but it is still an off-chain
attestation, not an on-chain-enforceable invariant. A malicious or absent
orchestrator can write a wrong value on one chain and never run the check;
`MIN_MARK_INTERVAL` bounds how fast the multiplier can move on the chain that
did step correctly, but does not itself detect divergence.

**12. Step coverage has one named escape.** `resetStepHighWaterMark` is a
cold-multisig action clearing the fee floor and reopening historical exposure. It
is deliberately separate from `setFees`, emits `StepHighWaterMarkReset`, and
**should be alarmed on**. Its honest precondition — that supply outstanding at
the time of the large step has substantially turned over — is not verifiable
on-chain.

**13. The solvency gap is publishable but not auditable on-chain.** `backing` is
computed from `M_oku`, which is itself declared. A holder can verify the gap
between two declared numbers; they cannot verify either against reality without
the off-chain attestation. The same is true of `surplus()` and
`withdrawSurplus`: a genuinely excess-backed state is only as trustworthy as
the multiplier authority that reports it.

---

## Open questions

1. **`MAX_SOLVENCY_GAP_BPS`.** The number that defines the product's risk
   profile. Needs treasury and legal sign-off, not an engineering guess. **Blocks
   audit scoping.**
2. **`MAX_STEP_BPS` and the published `M_oku` cadence.** These are one decision:
   the step size and the interval are linked, and `MAX_FEE_BPS` caps the
   coverable step. Daily is ~1.34 bps at 5%, monthly ~40.7 bps.
3. **`MAX_IMPLIED_APR` and `MAX_RATE_DURATION`.** The first needs a real number;
   the second is a round-number convention.
4. **`OKU_GUARDIAN` — warm or cold?** Warm gives a fast halt; cold makes the halt
   harder to abuse. A halt withholds yield, which is not nothing. Note the halt
   is now *two* levers on different tokens with different consequences.
5. **Allowance drift.** Is SDK-plus-app sufficient, or does this warrant
   something at the contract level?
6. **USDOku sunset threshold.** Agree the `totalSupply()` figure below which
   deprecation begins, now, before anyone has an incentive to argue about it.
7. **Raise the continuous-accrual question upstream regardless.** Even though
   `M_oku` is now stepwise and fits the pending-multiplier extension natively,
   the spec still has no way to declare *what unit* a multiplier converts to.
   Ours converts shares → dollars, across asset classes; Robinhood's converts
   tokens → shares, within one. A consumer cannot distinguish them, which is the
   root of the double-count hazard. Worth proposing a denomination field on
   the [Ethereum Magicians thread](https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899)
   — it is a draft, the authors have accepted essentially every substantive
   suggestion, and we hold the only non-equity two-index use case in the
   discussion.

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
then `RedemptionQueue` and `SubscriptionModule` (which cross-assert against it),
then `USDOku`, then `USDOkuWrapper` (which asserts against both tokens). The
script enforces this; do not reorder.

**Post-deploy wiring, once every contract exists.** `SubscriptionModule` cannot
be told about `USDOkuWrapper` at `initialize` — the wrapper does not exist yet
at that point in the order above. Wire it afterward, each a one-time
cross-reference on the same class of cold key, though the role constant differs
per contract (AccessControl mappings are per-contract):

- `USDOku.setSolvencySource(wrapper)` — solvency projection reads
  (`OKU_CAP_MANAGER`)
- `SubscriptionModule.setUsdOkuWrapper(wrapper)` — enables `mintUsdOku` /
  `redeemUsdOku`, which revert `UsdOkuWrapperNotSet` until this runs
  (`PSM_FEE_MANAGER`)

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

### Upgrades

```bash
FORK_NETWORK=sepolia hh node                              # Terminal 1
TARGETS=OkuM,USDOku,USDOkuWrapper npm run upgrade         # Terminal 2 — rehearse
TARGETS=OkuM,USDOku,USDOkuWrapper npm run upgrade:sepolia # When the diff is clean
```

`scripts/upgrade/index.ts` verifies the `*_UPGRADER` role before broadcasting,
runs OZ's `prepareUpgrade` so a layout-breaking change aborts before any
transaction, diffs pre/post invariant state (`uiMultiplier`, `newUIMultiplier`,
`effectiveAt`, `usdOkuIndex`, `convertToAssets(1e18)`, `solvencyGapBps`,
`supportsInterface(0xa60bf13d)` on **both** tokens), and appends an audit trail
with old/new implementation, tx hash, signer and timestamp.

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

---

## Pointers

- **Workspace overview:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **Display convention** (normative for integrators): [`metadata/DISPLAY_CONVENTION.md`](metadata/DISPLAY_CONVENTION.md)
- **ERC-7730 clear-signing metadata:** [`metadata/erc7730/`](metadata/erc7730/)
- **SVM implementation:** [`../SVM/README.md`](../SVM/README.md)
- **ERC-8056 (Draft):** https://eips.ethereum.org/EIPS/eip-8056
- **ERC-8056 discussion:** https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899
- **External conformance suite:** https://github.com/jumpboxtech/erc-8056-conformance
- **`dss-lite-psm` (fee arithmetic upstream):** https://github.com/makerdao/dss-lite-psm