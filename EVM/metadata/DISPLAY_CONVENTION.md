# rUSDOku Display Convention

Normative guidance for anything that renders an rUSDOku balance: the Oku app,
third-party wallets, explorers, portfolio trackers, indexers, custodians,
exchanges and tax vendors.

This document is the contract between the token and its display surfaces. If you
are integrating rUSDOku, this is the shortest path to getting it right.

---

## The one thing to understand

There are **two numbers**, and they are both correct.

| | Name | Source | Meaning |
|---|---|---|---|
| **Raw** | `balanceOf(user)` | stock ERC-20 storage | The unit count. Static. Moves only on transfer, mint, burn. |
| **Display** | `balanceOfUI(user)` | `raw × uiMultiplier() / 1e18` | The dollar value. Grows continuously with time. |

`uiMultiplier()` starts at `1e18` (= $1.00) and only ever increases.

A holder with 954.20 raw at a multiplier of 1.048 holds **$1,000.00**. Both
"954.20 rUSDOku" and "$1,000.00" are accurate statements about the same
position. What is *never* acceptable is rendering `954.20` and labelling it
`$954.20`.

---

## Rules

### 1. Label the unit, always

- Displaying the dollar value: `$1,000.00` or `1,000.00 USD`.
- Displaying the raw value: `954.20 rUSDOku`. Never prefix it with `$`.

The failure mode we are designing against is a surface that shows the raw number
with a dollar sign. It under-reports by `uiMultiplier / 1e18` — small at launch,
growing monotonically forever.

### 2. Detect capability, do not assume it

```solidity
supportsInterface(0xa60bf13d)  // IScaledUIAmount
```

If `true`, the token is scaled-display and you must apply the multiplier.
If `false`, or if you cannot check, **fall back to showing the raw balance with
the `rUSDOku` ticker and no dollar sign.** That is a graceful degradation: the
number is honest, it just is not a dollar figure.

Interface IDs:

| Interface | ID | What it gives you |
|---|---|---|
| `IScaledUIAmount` | `0xa60bf13d` | `uiMultiplier()` |
| `IScaledUIAmountNewUIMultiplier` | `0x4bd27648` | `newUIMultiplier()`, `effectiveAt()` |
| `IScaledUIAmountConversion` | `0x57854fc3` | `toUIAmount()`, `fromUIAmount()` |
| `IScaledUIAmountBalances` | `0xd890fd71` | `balanceOfUI()`, `totalSupplyUI()` |

### 3. The max-send rule

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
const raw = await token.balanceOf(user);
const display = await token.toUIAmount(raw);
await token.transfer(to, raw);          // clears the balance exactly

// WRONG
const display = await token.balanceOfUI(user);
const raw = await token.fromUIAmount(display);   // <= actual balance, leaves dust
await token.transfer(to, raw);
```

This is the most likely user-visible bug in the whole system. It is pinned by
`test/psm/MaxSend.t.sol`, which also carries the regression assertions from the
May-2026 Sepolia redemption incident.

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

`effectiveAt()` is when accrual **halts**, not when a step lands. If
`block.timestamp >= effectiveAt()` the multiplier is frozen: holders are not
currently earning. That is worth showing to a user, and it is worth alerting on
operationally.

Do not present `newUIMultiplier()` as "an upcoming price change". Under this
token it is the value the trajectory terminates at, and the multiplier is
continuous — there is no step.

### 7. Never use the display layer for accounting

The multiplier is an input to **pricing**. It is never an input to
**accounting**. Ledgers, balances, allowances, and queue records are all raw.
This is the line that keeps ERC-8056 a display extension rather than load-bearing
consensus, and it applies to integrators as much as to the contracts.

---

## Hardware wallets

Ledger and Trezor render raw calldata amounts. Your app says "$1,050"; the device
says "1,000". Users abort transactions over discrepancies like that, and they are
right to.

ERC-7730 clear-signing metadata for the token and every PSM entry point lives in
[`erc7730/`](erc7730/). Field labels there deliberately say
`Amount (rUSDOku units, NOT dollars)` rather than a bare `Amount`, so the device
screen is unambiguous even though it cannot apply the multiplier.

Before mainnet, the deployment addresses in those files must be filled in and the
metadata submitted to the Ledger registry. **Treat this as a launch blocker.**

---

## Price feeds and listings

Neither number is a $1 unit price. Market data providers will show a unit price
drifting above $1 unless they integrate ERC-8056. What gets published to
CoinGecko / CMC / exchange listing teams — and whether the ticker changes — is a
communications decision that must land before launch, not after.

For on-chain consumers, use `OkuMultiplierAdapter`: a Chainlink
`AggregatorV3Interface`-compatible feed over `uiMultiplier()` with bounds and
staleness checks. **It reports 18 decimals, not Chainlink's conventional 8.**

---

## AMMs and lending

**AMMs — rate-aware pools only.** Curve stableswap with `uiMultiplier()` as the
rate provider, or a Uniswap v4 hook. A naive constant-product pair against USDC
leaks the entire accrual rate to arbitrageurs continuously; LPs capture materially
less than the yield rate and will not understand why. State this in LP-facing
docs, not only here.

**Lending — talk to us first.** The multiplier becomes your price feed. The
on-chain bounds are `MAX_IMPLIED_APR` (1000 bps nominal), `MAX_RATE_DURATION`
(30 days), strict monotonicity, and a `MAX_MULTIPLIER` ceiling; a warm-multisig
guardian can freeze accrual with `haltAccrual()`. Worst-case over-accrual from a
compromised rate-setter key inside one segment is ~0.82%. We will put that in
writing for your risk team.
