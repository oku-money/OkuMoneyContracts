# Display convention — normative

**This document is normative for anything that renders an OkuDollar balance or
amount: the app, an embedded wallet, a third-party wallet, an explorer, an
indexer, a custodian, an exchange, or a hardware-wallet signing screen.**

Every integration conversation opens with the rule in §1. It is the failure mode
most likely to reach production, and it is not an amount bug — it is an
`amount × price` bug.

---

## 1. The double-count rule

OkuM implements **ERC-8056**. Its raw ERC-20 balance is fixed; yield is expressed
by a separate multiplier, `uiMultiplier()` (written `M_oku`, 18 dp, starts at
`1e18` = $1.00 and only rises).

An 8056-aware wallet reads the **amount** from the chain and the **price** from a
market aggregator. Those are separate subsystems that do not know about each
other. Pair a scaled amount with a market quote and you double-count the yield.

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

The error is exactly the accrued yield, and it **grows with the multiplier**.
`M_oku` is off 1.0 from week one and permanently drifting, so this will not stay
latent.

---

## 2. Units — the canonical table

There are four distinct units in this system and three of them are 18 dp, so
decimals alone cannot tell them apart.

| Unit | Where it appears | Notes |
|---|---|---|
| **Raw OkuM** (18 dp) | `OkuM.transfer/approve/mint/burn`, `wrap.okuMAmount`, `requestRedemption.okuMAmount`, `withdrawSurplus.okuMAmount`, `setMaxSupply`, `configureMinterAllowance` | Dollar value is `amount × M_oku / 1e18`. **Never equal to dollars.** |
| **USDOku dollars** (18 dp) | `USDOku.transfer/transferFrom/approve/permit`, `balanceOf`, `totalSupply`, `unwrap.usdOkuAmount`, `wrap.minUsdOkuOut` | 1 USDOku = $1 by construction |
| **USDOku shares** (18 dp) | `USDOku.mint`, `USDOku.burn`, `sharesOf`, `totalShares` | The invariant ledger. `dollars = shares × M_usd / 1e18` |
| **USDC** (6 dp) | `requestSubscription.usdcAmount`, `requestRedemption.minUsdcOut` | |

**Two calls mix units internally.** `requestSubscription(usdcAmount, minOkuMOut)`
takes 6 dp USDC then 18 dp raw OkuM; `requestRedemption(okuMAmount, minUsdcOut)`
reverses that order. `wrap(okuMAmount, receiver, minUsdOkuOut)` carries two
*different tokens that are both 18 dp*.

---

## 3. Approval drift — opposite directions

This is a genuine footgun and it points in different directions for the two
tokens.

- **OkuM allowances are raw-denominated.** A bounded approval's *dollar* value
  **grows** with `M_oku`. Approving 1,000 OkuM today authorises strictly more
  value tomorrow. `allowanceUI(owner, spender)` exposes the current dollar value
  on-chain so an explorer can warn without importing anything. It **saturates**
  at `type(uint256).max` for an infinite approval rather than reverting — treat
  that value as "unbounded", not as a literal figure.
- **USDOku allowances are dollar-denominated.** Their *share* purchasing power
  **shrinks** as `M_usd` rises.

Surface drifted approvals in any approval-management UI.

---

## 4. The max-send rule

> **A max-send must never round-trip through the display layer.** Compute the
> transfer from the raw `balanceOf`; derive the displayed value *from that raw
> amount*. Never compute `fromUIAmount(displayedBalance)`.

`fromUIAmount(toUIAmount(x))` is `x − 1` for most `x`. A "Max" button built the
wrong way leaves dust on every send, or — rounding the other way — exceeds the
balance and reverts, which users read as a broken app.

**The same rule applies to USDOku, for a different reason.** A max-send there
must be computed from `sharesOf`, not `balanceOf`, because `balanceOf` moves
between the read and the transaction.

**And to max-redeem.** `requestRedemption` with a max amount must pass raw
`balanceOf`, never `fromUIAmount(displayed)`.

The SDK exposes `getMaxSendRaw()`, `getMaxSendShares()` and `getMaxRedeemRaw()`,
and deliberately provides **no inverse** for any of them.

---

## 5. Hardware wallets show RAW units — always

This is the part most likely to surprise a user, and it cannot currently be
fixed at the standard level.

**ERC-7730 has no way to express a display multiplier.** Its `tokenAmount`
format resolves ticker and decimals from the token contract, so a hardware
wallet signing an OkuM transfer displays:

```
Send OkuM
OkuM Amount   1000 OkuM
To            0xabc…
```

while the app that produced the transaction may have shown **$1,050**. Both are
correct. They are different units.

Mitigations actually implemented in `metadata/erc7730/`:

- Labels name the token explicitly — **`OkuM Amount`**, **`USDOku Amount`**,
  **`USDOku Shares`** — so a raw figure cannot be read as dollars. USDC keeps a
  bare `Amount`, because its ticker is unambiguous.
- `USDOku.mint`/`burn` are rendered with the `unit` format as `shares`, **not**
  as a `tokenAmount`. A token binding there would be wrong by `M_usd / 1e18` and
  would drift every second.
- Intents name the direction and the asset (`Send OkuM`, `Wrap OkuM into
  USDOku`, `Request OkuM subscription`).

**Product requirement:** any app flow that displays dollars and then asks for a
hardware-wallet signature MUST warn the user that the device will show raw OkuM,
and SHOULD show the raw figure alongside the dollar figure on the confirmation
screen so the two can be reconciled.

### 5.1 One value the device cannot render meaningfully

`USDOku.setUsdOkuRate(newRate, endTimestamp)` takes an **18 dp per-second
compounding rate**. `1000000003170979198` is roughly 10% nominal APR. ERC-7730
has no arithmetic, so the device shows `1.000000003170979198 /s` and nothing
better is achievable within the standard.

> **Operational requirement.** The rate setter's runbook MUST require computing
> and verifying the implied APR **off-device** before signing. Use
> `npm run operator:setUsdOkuRate`, which prints the APR and refuses to submit an
> unfunded rate.

---

## 6. Two tokens, one product

| | **OkuM** | **USDOku** |
|---|---|---|
| Balance semantics | Fixed raw balances | Rebasing |
| Denomination | Shares | Dollars (1 USDOku = $1) |
| `balanceOf` returns | raw units | dollars |
| ERC-8056 | **Yes** | **No — never** |
| Composable in DeFi | Yes | **No** |

`USDOku.supportsInterface(0xa60bf13d)` returns **false** and is asserted so in
the invariant suite. USDOku's `balanceOf` already returns dollars; an 8056
multiplier on top would be a second scaling factor over an already-scaled
balance, and an aware wallet would apply it twice.

**USDOku must never be pooled** — it rebases, and a pool would leak the entire
yield to whoever calls sync. **USDOku should not be used as collateral** while
the solvency gap is nonzero. OkuM is the composable leg.

---

## 7. Public secondary price is expected

Someone will pool OkuM against USDC. That pool prices raw OkuM at
`$1 × M_oku` and climbing, and aggregators will list it there. **This is
correct** — OkuM is not pegged — but expect it at launch rather than treating it
as a depeg. ERC-8056 scales amounts, not prices; no amount of wallet adoption
changes that.

---

## 8. Precision and rounding

- **18 decimals on both tokens.** With a growing multiplier, 6 decimals surfaces
  display-layer dust far sooner than expected.
- **One rounding direction:** every conversion rounds **against the caller, in
  favour of the protocol**.
- **Display precision:** truncate UI amounts to the token's decimals. Never
  render full multiplier precision — it implies precision the backing lacks.

---

## 9. Event denominations differ by token

| Event | Contract | Denomination |
|---|---|---|
| `Transfer` / `Approval` | OkuM | **raw** |
| `Transfer` / `Approval` | USDOku | **dollars** (rebased) |
| `TransferWithUIAmount` | OkuM | carries both raw and UI amounts |
| `SharesTransferred` | USDOku | **shares** |

Same signature, different denomination. Indexers must not share a code path
between the two tokens without accounting for this.

---

## Pointers

- ERC-7730 descriptors: [`erc7730/`](erc7730/)
- Submission runbook: [`erc7730/README.md`](erc7730/README.md)
- Design rationale: [`../README.md`](../README.md)
- ERC-8056 (Draft): <https://eips.ethereum.org/EIPS/eip-8056>
- ERC-7730 (Draft): <https://eips.ethereum.org/EIPS/eip-7730>
