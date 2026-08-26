# OkuM / USDOku Display Convention

Normative guidance for anything that renders an **OkuM** or **USDOku** balance:
the Oku app, third-party wallets, explorers, portfolio trackers, indexers,
custodians, exchanges and tax vendors.

This document is the contract between the tokens and their display surfaces.
If you are integrating either token, this is the shortest path to getting it
right. **Read the summary table first — the two tokens have opposite display
hazards, and applying one token's rule to the other is itself a bug.**

---

## The two tokens, side by side

| | **OkuM** | **USDOku** |
|---|---|---|
| What `balanceOf` returns | Raw share count (not dollars) | Dollars, already (rebases) |
| Apply a multiplier? | **Yes** — `uiMultiplier()` / `balanceOfUI()`, ERC-8056 | **Never** — no multiplier exists; `supportsInterface(0xa60bf13d)` is `false` |
| Price the display amount at | $1.00 (never a market quote — see Rule 1) | Nothing further — it's already dollars |
| Max-send computed from | Raw `balanceOf` (never `fromUIAmount(display)`) | `sharesOf` (never live `balanceOf`) |
| Accrual | Stepwise, discrete marks | Continuous, every block |
| Chains | EVM + SVM | EVM only |

Both failure modes below are the same *shape* of mistake — treating a number as
something it is not — but they point in **opposite directions**:

- **OkuM:** the raw number under-reports value; the scaled number is the
  dollar figure. Under-scaling (or double-scaling against a market quote) is
  the hazard.
- **USDOku:** `balanceOf` already IS the dollar figure. There is nothing to
  scale. Applying *any* multiplier logic to it — because a wallet assumes
  every okuMoney token behaves like OkuM — silently double-scales an
  already-scaled number.

If you integrate only one token today, re-read this table before you add the
second. The single most likely integration bug in this system is carrying
OkuM's display logic over to USDOku, or vice versa.

---

# Part 1 — OkuM

## The one thing to understand

There are **two numbers**, and they are both correct.

| | Name | Source | Meaning |
|---|---|---|---|
| **Raw** | `balanceOf(user)` | stock ERC-20 storage | The unit count. Static. Moves only on transfer, mint, burn. |
| **Display** | `balanceOfUI(user)` | `raw × uiMultiplier() / 1e18` | The dollar value. Grows in discrete steps over time. |

`uiMultiplier()` starts at `1e18` (= $1.00) and only ever increases.

A holder with 954.20 raw at a multiplier of 1.048 holds **$1,000.00**. Both
"954.20 OkuM" and "$1,000.00" are accurate statements about the same
position. What is *never* acceptable is rendering `954.20` and labelling it
`$954.20`.

## Rules

### 1. The double-count hazard — normative

**This is the failure mode most likely to reach production, and it is not an
amount bug. It is an amount × price bug.**

An 8056-aware wallet reads the *amount* from the chain and the *price* from an
aggregator. Those are separate subsystems that do not know about each other.
Pair `balanceOfUI() = 1,000` with a market quote of $1.05 for raw OkuM and it
renders **$1,050** for a $1,000 position. The error is exactly the accrued
yield and it **grows with the multiplier**.

> **Normative rule.** Any consumer that applies `uiMultiplier()` to an amount
> MUST price the result at **$1.00 per unit**. Any consumer that prices raw
> OkuM at a market quote MUST use the **raw** `balanceOf`, never
> `balanceOfUI`. Applying both is a double-count.

Restated as the only two valid pairings:

| Amount | Price | Result |
|---|---|---|
| `balanceOf` (raw) | market quote for OkuM | correct |
| `balanceOfUI` (scaled) | $1.00 | correct |
| `balanceOfUI` (scaled) | market quote for OkuM | **WRONG — overstates by `uiMultiplier()`** |

This is not hypothetical: it is the same trap Robinhood documents in its own
stack, where the REST `/prices` endpoint returns the raw underlying quote
while the Chainlink feed returns the multiplier-adjusted one. `uiMultiplier()`
will be off `1.0` from week one and permanently drifting, so a consumer that
gets this wrong does not fail occasionally — it fails from the first mark
onward.

### 2. Detect capability, do not assume it

```solidity
supportsInterface(0xa60bf13d)  // IScaledUIAmount
```

If `true`, the token is scaled-display and you must apply the multiplier.
If `false`, or if you cannot check, **fall back to showing the raw balance with
the `OkuM` ticker and no dollar sign.** That is a graceful degradation: the
number is honest, it just is not a dollar figure.

**Do not assume this result applies to every okuMoney token.** `OkuM.
supportsInterface(0xa60bf13d)` is `true`; `USDOku.supportsInterface(0xa60bf13d)`
is deliberately `false` (Part 2). Check per-token, per-address — never cache
capability keyed only on "is this an okuMoney token."

Interface IDs:

| Interface | ID | What it gives you |
|---|---|---|
| `IScaledUIAmount` | `0xa60bf13d` | `uiMultiplier()` |
| `IScaledUIAmountNewUIMultiplier` | `0x4bd27648` | `newUIMultiplier()`, `effectiveAt()` |
| `IScaledUIAmountConversion` | `0x57854fc3` | `toUIAmount()`, `fromUIAmount()` |
| `IScaledUIAmountBalances` | `0xd890fd71` | `balanceOfUI()`, `totalSupplyUI()` |

### 3. The max-send rule (OkuM half)

> **A max-send must never round-trip through the display layer.**
>
> Compute the transfer amount from raw `balanceOf`. Derive the displayed value
> *from that raw amount*. Never compute `fromUIAmount(displayedBalance)`.

`fromUIAmount(toUIAmount(x))` is `x - 1` for most `x`, because both directions
floor. A "Max" button built the wrong way leaves a wei of dust on every send —
or, if someone "fixes" the rounding, produces an amount that exceeds the balance
and reverts, which users read as a broken app.

```ts
// CORRECT
const raw = await okuM.balanceOf(user);
const display = await okuM.toUIAmount(raw);
await okuM.transfer(to, raw);          // clears the balance exactly

// WRONG
const display = await okuM.balanceOfUI(user);
const raw = await okuM.fromUIAmount(display);   // <= actual balance, leaves dust
await okuM.transfer(to, raw);
```

This is the most likely user-visible bug in the whole system. It is pinned by
`test/psm/MaxSend.t.sol`, which also carries the regression assertions from the
May-2026 Sepolia redemption incident.

**USDOku has its own, differently-shaped max-send rule — see Part 2, Rule 3.
The two are not interchangeable: OkuM's hazard is a rounding round-trip;
USDOku's is a stale read.**

#### Required SDK surface

The client SDK must make the wrong version *unavailable*, not merely
discouraged. Minimum normative shape:

```ts
/** Display balance in dollars. Handles ERC-165 detection internally and
 *  falls back to the raw balance, clearly flagged, when unsupported. */
getDisplayBalance(token, user): Promise<{ display: bigint; raw: bigint; supported: boolean }>;

/** The ONLY OkuM max-send helper. Returns raw, plus the display value derived
 *  from that same raw figure. There is deliberately no inverse and no
 *  `getMaxSendDisplay()` — an inverse is the bug. */
getMaxSendRaw(token, user): Promise<{ raw: bigint; display: bigint }>;

/** The ONLY USDOku max-send helper. See Part 2, Rule 3. */
getMaxSendShares(token, user): Promise<{ shares: bigint; display: bigint }>;

/** Current dollar value of a raw-denominated OkuM allowance. See §5. */
allowanceUI(token, owner, spender): Promise<bigint>;
```

`getMaxSendRaw` returning both figures from one raw read is the whole point: it
removes the opportunity to derive one from the other in the wrong direction.
Any SDK that exposes a `fromUIAmount`-based max-send has not implemented this
document. The same applies to `getMaxSendShares` and a `balanceOf`-based
max-send on USDOku.

### 4. Truncate to the token's decimals

Render UI amounts at 18 decimals maximum, and in practice at 2 for currency
display. Never surface full multiplier precision — `1.048273916402841` implies a
precision the T-Bill backing does not have.

### 5. Approvals drift upward in dollar terms

Allowances are denominated in **raw** units. An approval for 1,000 raw was worth
$1,000 when granted and is worth more later. Read `allowanceUI(owner, spender)`
to show the current dollar value, and warn on bounded approvals whose UI value
has grown materially since they were granted. Infinite approvals are unaffected.

### 6. Surface the accrual state

`OkuM` steps are **immediate**, not scheduled: `setOkuMultiplier` crystallizes
the new value in the same transaction that writes it (this deviates
deliberately from the ERC-8056 reference implementation's pending-write
defect — see `../README.md § ERC-8056 on OkuM`). In practice,
`newUIMultiplier() == uiMultiplier()` and `effectiveAt()` is already in the
past immediately after every mark; there is no forward-looking "pending step"
window to show a user under normal operation. Do not build UI around an
upcoming-adjustment countdown — there is nothing to count down to.

What *is* worth surfacing: whether a mark is currently propagating
cross-chain. While `isSyncLocked()` is `true`, price-sensitive operations
(`mint`, `redeem`, bridge legs) are blocked on-chain, and a UI that does not
explain why a transaction just reverted will generate support tickets. Show
`syncLockedUntil()` as "pricing is settling, try again shortly," not as an
error.

### 7. Never use the display layer for accounting

The multiplier is an input to **pricing**. It is never an input to
**accounting**. Ledgers, balances, allowances, and queue records are all raw.
This is the line that keeps ERC-8056 a display extension rather than load-bearing
consensus, and it applies to integrators as much as to the contracts.

---

# Part 2 — USDOku

## USDOku does not implement ERC-8056 — never apply a multiplier

`USDOku.balanceOf()` is **already dollar-denominated**. It rebases: the
number returned grows continuously, on its own, with no transfer required to
observe the change. There is no separate raw/display pair to reconcile, and
critically, **there is no `uiMultiplier()` to apply**.

> **Normative rule.** `USDOku.balanceOf()` **IS** the dollar amount. Full
> stop. No multiplier, anywhere, ever. A wallet or integrator that applies
> ERC-8056-style scaling logic to a USDOku balance — because it assumes every
> token in the okuMoney family behaves like OkuM — **double-scales an
> already-scaled number**, silently and in the wrong direction from Part 1's
> hazard, but no less wrong.

This is deliberate on the contract's side, not an oversight to work around:

```solidity
USDOku.supportsInterface(0xa60bf13d) == false   // asserted in the invariant suite
```

Check capability the same way you would for OkuM (Rule 2, Part 1) — the
`false` result here is the signal to render `balanceOf()` directly and stop,
not a reason to fall back to a raw/scaled heuristic borrowed from OkuM.

```ts
// CORRECT
const display = await usdOku.balanceOf(user);   // already dollars

// WRONG — there is no multiplier to read, this call does not even exist,
// but the WRONG pattern to watch for is treating balanceOf as a "raw" amount
// that needs a further scaling step before display, e.g. by mistakenly
// reusing an OkuM-style getDisplayBalance() helper against a USDOku address.
```

USDOku's own internal index (`M_usd` / `usdOkuIndex()`) is **not** a display
multiplier in the ERC-8056 sense — it is the mechanism `balanceOf()` already
applies internally to produce the dollar figure you read. You never read
`usdOkuIndex()` yourself for display purposes; `balanceOf()` has already done
that work.

### Rule 3 (USDOku half) — the max-send rule

USDOku's max-send hazard is **not** the OkuM rounding round-trip (Part 1, Rule
3) — it is a **staleness** problem:

> **A USDOku max-send must never be computed from a `balanceOf` read.**
>
> `balanceOf()` itself **moves between when a UI reads it and when a
> transaction lands**, because the token rebases continuously. A max-send
> computed from a balance read one block ago can already be stale by the time
> the transaction is mined — sending too little (leaving dust) or, if the UI
> tries to send the exact live figure, reverting because the on-chain balance
> has already moved past what was read.
>
> The invariant quantity — the one that does **not** move between the read
> and the transaction — is `sharesOf()`. Compute a USDOku max-send from
> `sharesOf`, never from `balanceOf`.

```ts
// CORRECT
const shares = await usdOku.sharesOf(user);
// transfer using the share-denominated path / the SDK helper below

// WRONG
const display = await usdOku.balanceOf(user);   // moves before the tx lands
await usdOku.transfer(to, display);              // stale by the time it's mined
```

See `src/token/USDOku.sol`'s NatSpec on `balanceOf` / `sharesOf` for the
precise framing: *"MAX-SEND RULE: never compute a transfer amount from this —
it moves between the read and the transaction. Compute from `sharesOf`."*

SDK exposes `getMaxSendShares()` for this, with no inverse — the same
"make the wrong version unavailable" principle as `getMaxSendRaw()` in Part 1.

### Approvals drift too, in the opposite direction

USDOku allowances are share-denominated under the hood (a raw-share approval
on a rebasing token), the mirror image of OkuM's raw-denominated approvals
drifting *upward* in dollar terms. `sharesOf` is exposed on-chain so an
integrator that must survive a rebase has the invariant quantity available
without reconstructing it from `balanceOf` history.

### USDOku's dollar unit is a definition, not a market price

1 USDOku = $1 by contract definition, not by a stability mechanism or an
oracle asserting it. If USDOku ever trades on a secondary venue it may trade
away from $1 — that would be a market fact about liquidity, not a peg
failure, and displaying a "USDOku price" from a DEX quote alongside the
$1-by-definition balance is its own small version of the double-count trap:
decide explicitly which number a surface is showing, and label it. **USDOku
should not be pooled or listed as a priced asset in the first place** — see
"AMMs and lending" below — so this scenario should not arise if venue
guidance is followed.

---

## Hardware wallets

Ledger and Trezor render raw calldata amounts. For OkuM, your app says
"$1,050"; the device says "1,000" raw units. For USDOku, calldata amounts are
already dollar-denominated shares under the hood, so the device figure and
the intended dollar transfer diverge for a different reason — the device
cannot show the share→dollar conversion either. Users abort transactions over
discrepancies like that, and they are right to.

ERC-7730 clear-signing metadata for **both tokens** and every module entry
point lives in [`erc7730/`](erc7730/). Field labels there deliberately say
`Amount (OkuM units, NOT dollars)` rather than a bare `Amount`, so the device
screen is unambiguous even though it cannot apply the multiplier. USDOku
entries get the analogous treatment for its share-denominated calldata.

Before mainnet, the deployment addresses in those files must be filled in and
the metadata submitted to the Ledger registry for both tokens. **Treat this
as a launch blocker.**

---

## Price feeds and listings

**OkuM** has no `$1` unit price. Market data providers will show a unit price
drifting above $1 unless they integrate ERC-8056. What gets published to
CoinGecko / CMC / exchange listing teams — and whether the ticker changes — is
a communications decision that must land before launch, not after.

**USDOku** is `$1.00` by definition (Part 2). It should not be listed as a
priced, tradeable asset in the first place — see "AMMs and lending" below —
so a listing-team conversation about USDOku should start from "why is this
being listed at all," not from a price-feed integration question.

For on-chain consumers of OkuM's price, use `OkuMultiplierAdapter`: a
Chainlink `AggregatorV3Interface`-compatible feed over `uiMultiplier()` with
bounds and staleness checks. **It reports 18 decimals, not Chainlink's
conventional 8.** There is no analogous adapter for USDOku — there is nothing
for it to adapt; `balanceOf()` is already the answer.

---

## AMMs and lending

**AMMs — rate-aware pools only, OkuM only.** Curve stableswap with
`uiMultiplier()` as the rate provider, or a Uniswap v4 hook. A naive
constant-product pair against USDC leaks the entire accrual rate to
arbitrageurs continuously; LPs capture materially less than the yield rate and
will not understand why. State this in LP-facing docs, not only here.

**USDOku must never be pooled.** It rebases continuously, and a pool would
leak the entire yield to whoever calls the rebase (or simply holds through
it), the same failure mode as any naively-pooled rebasing token. This is not
a display-convention nuance — it's a hard "no" for venue integrations.

**Lending — talk to us first, OkuM only.** The multiplier becomes your price
feed. The on-chain bounds are `MAX_IMPLIED_APR`, `MAX_RATE_DURATION`, strict
monotonicity, and a `MAX_MULTIPLIER` ceiling; a warm-multisig guardian can
freeze accrual with `haltAccrual()`. We will put the worst-case over-accrual
bound in writing for your risk team. **USDOku should not be listed as
collateral** while its solvency gap against realized OkuM backing may be
nonzero — see [`../README.md`](../README.md) for the solvency-gap mechanics.
