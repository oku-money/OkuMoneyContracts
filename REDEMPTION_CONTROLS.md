# Redemption controls: `master` vs `noRedeem`

A short note on one specific question — **can redemption be switched off, or
bounded?** — because the answer on `master` is worse than the design docs imply,
and it is the sharpest single argument for the `noRedeem` pivot.

Verified against source on both branches, not against the READMEs.

---

## 1. The problem

`master` exposes `redeemOkuM` and `redeemUsdOku` as **permissionless** functions.
Anyone holding OkuM can convert it to USDC at the declared multiplier, in any
size, at any time. A permissionless exit is only safe if the operator can (a)
close it and (b) bound it. `master` can do neither with any precision.

The general principle: **an issuance control with no matching exit control is not
a control.** It bounds how fast the balance sheet can grow while leaving
unbounded how fast it can be drained.

---

## 2. Gaps on `master`

### 2.1 One lever, and it is the wrong shape

`LitePSM.pause()` / `unpause()`, gated `PSM_PAUSER` (warm) / `PSM_UNPAUSER`
(cold) — `LitePSM.sol:422-428`. That is the entire control surface.

`whenNotPaused` sits on `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`
**and `processQueue`** (`:195, :230, :314, :363, :407`).

So pausing to stop an outflow simultaneously:

- stops **inflow** (mints), the thing that would replenish the buffer, and
- stops **payouts to users already queued**, who are stuck and cannot be paid
  until the pause lifts.

The emergency lever makes the emergency worse. There is no way to stop new
redemptions while draining the existing backlog — the exact thing an operator
needs during a liquidity incident.

### 2.2 No limits of any kind

Greping all of `master`'s `EVM/src` and `EVM/scripts`: no per-transaction
maximum, no per-user maximum, no per-block / daily / rolling-window cap, no
cooldown, no cumulative ceiling, no redemption allowlist, and no toggle that
separates redemption from minting.

The only bound on `redeemOkuM` is a **minimum** — `AmountTooSmall` at one USDC
unit (`LitePSM.sol:259`). Never a maximum.

### 2.3 The mint/redeem asymmetry

| | Controls |
|---|---|
| **Mint** | `maxSupply` global cap (`OKUM_CAP_MANAGER`) **and** per-minter `minterAllowance`, decremented per call, Circle FiatToken-style — `OkuMoney.sol:337-347` |
| **Burn** | `onlyRole(OKUM_BURNER)`. No allowance, no cap, and deliberately not pause-gated — `OkuMoney.sol:354` |

Every issuance control has no mirror on the exit side.

The mint-side caps are also weaker than they look: deploy sets
`minterAllowance == maxSupply == 1e9` (`deploy/index.ts:73-74`), so the
per-minter allowance constrains nothing at launch. The repo's own operator
script says it "should be set well below maxSupply (e.g. 1%)" — the deploy
default contradicts that guidance.

### 2.4 The buffer is not a limit

Exceeding the USDC buffer does not reject — it **queues**
(`LitePSM.sol:292-297`). The buffer bounds *instant payout*, not *redemption
acceptance*: the protocol takes the user's OkuM and the liability
unconditionally. Worse, queued OkuM keeps appreciating via `okuMMultiplier`
while it waits, so the obligation **grows while it is unpayable**.

### 2.5 Two things that look like limits and are not

- **`minCollateralRatio`** is enforced only in `withdrawSurplus`
  (`OkuDollar.sol:618`) — the operator's extraction path. The user path `unwrap`
  checks only physical `InsufficientReserves` (`:517`). `master`'s own README
  concedes this: *"it does not halt minting or unwrapping if the live ratio
  drifts below it."*
- **`WouldStrandQueue`** on `withdrawUsdc` constrains the *operator* from
  draining the buffer below queue obligation. Not a user-facing limit.

Both are plausible enough to be mistaken for redemption throttles by someone
reading role names or constants. Neither is.

---

## 3. How `noRedeem` mitigates this

### 3.1 The exit is no longer permissionless

This is the structural fix and it subsumes most of the rest. Redemption is a
two-phase request: `requestRedemption` escrows the OkuM, and only
`REQUEST_FULFILLER` can convert it (`SubscriptionModule.sol:504`). There is no
call path by which an unapproved party moves value out. "Bounding" the exit is
now an off-chain decision about which requests to fulfil and when, rather than a
set of on-chain parameters that must anticipate every scenario.

### 3.2 Pause is directional — the key correction

`SubscriptionModule.pause()` gates **only** `requestSubscription` and
`requestRedemption` (`:359-360, :378-379`). It deliberately does **not** gate
`fulfillSubscription`, `fulfillRedemption`, `rejectRequest` or `cancelRequest`.

So a paused module stops new intake **while the existing backlog stays fully
drainable** — precisely the capability `master` lacks. Users can also still
cancel and recover escrow while paused.

### 3.3 Directional toggle on the one permissionless path

`wrap` (OkuM → USDOku) is gated by `wrapEnabled`, settable by `WRAPPER_ADMIN`
(`USDOkuWrapper.sol:158, :346`). `unwrap` has no toggle and cannot be disabled.

The asymmetry is intentional: entry can be closed, exit cannot. Never trap
holders on the way out.

### 3.4 Request-level bounds that `master` had no equivalent for

| Bound | Value | Effect |
|---|---|---|
| `MAX_REQUEST_AGE` | 7 days | A stale request cannot be fulfilled at a multiplier that has since moved |
| `MIN_CANCEL_DELAY` | 1 hour | Blocks submit-and-cancel probing of fulfilment timing |
| One pending request per `(user, direction)` | — | Caps per-address escrow exposure without a queue |
| `minOut` | per request | User-side protection, checked at fulfilment |
| `MAX_TOTAL_SUPPLY` | 1e33 | Absolute ceiling `setMaxSupply` cannot exceed (`OkuM.sol:438`) |

### 3.5 Solvency became a maintained invariant

With `MAX_SOLVENCY_GAP_BPS = 0`, forward yield must be pre-funded, so
`backing >= liability` holds continuously rather than being monitored. A
displayed USDOku balance is always redeemable. On `master` this was a monitoring
threshold the docs claimed was "funded by the buffer" — no such buffer existed,
and the last holder out was stranded.

---

## 4. What still remains

Being honest about what the pivot did **not** solve.

### 4.1 Pausing OkuM traps escrowed OkuM — worth fixing

`_refund` returns a redemption request's escrow with
`okuM.safeTransfer(req.user, ...)` (`SubscriptionModule.sol:468`). That is a
module → user transfer, so it passes through OkuM's `_update`, where both
addresses are non-zero and `_requireNotPaused()` fires (`OkuM.sol:383-385`).

**Consequence: while OkuM is paused, a user with a pending redemption cannot
cancel and recover their tokens.** `rejectRequest` refunds through the same path,
so the operator cannot return them either. The module's own pause was carefully
designed not to trap anyone; the *token's* pause reintroduces exactly that,
through a different surface, and here the funds sit with the protocol rather than
with the user.

This is the one place `noRedeem` still reproduces the failure shape it was built
to remove — an emergency lever that strands the people already in the queue.

Verified, not inferred: `RegressionTest.test_okuMPauseTrapsEscrowedRedemption`
asserts both reverts and confirms recovery after unpause. Now tracked in
`TRACKER.md` (🟡), alongside the related `unwrap` item — same root cause, same
fix shape.

### 4.2 `wrap` is permissionless and uncapped

The one remaining permissionless value path. Bounded only by projected solvency,
which means it can revert `WouldBreachBacking` when the issuer has not funded
headroom — a user refused because of issuer behaviour, not their own. There is
no per-tx or aggregate cap, only the binary `wrapEnabled`. Already flagged as
needing a product decision; the control granularity is part of that decision.

### 4.3 The wrapper has no pause at all

`USDOkuWrapper` is not `Pausable`. `wrapEnabled` covers the entry side, and
leaving exit always-open is deliberate — but it does mean the wrapper has no
lever for an incident that is not entry-related.

### 4.4 The mint/burn asymmetry technically persists

`OkuM.burn` still has no allowance or cap (`OkuM.sol:412`), mirroring `master`.
The difference is reachability: burn is now callable only by
`SubscriptionModule.fulfillRedemption`, itself role-gated, so there is no
permissionless path to it. The asymmetry is defused by access control rather
than removed. If a future contract is granted `OKU_BURNER`, it returns.

### 4.5 No aggregate escrow cap

`totalEscrowedUsdc` / `totalEscrowedOkuM` are tracked but not bounded. One
request per user per direction limits *per-address* exposure; nothing limits the
total. Low severity — escrow is inert and refundable, and the operator chooses
what to fulfil — but it is not a bound.

### 4.6 Operator trust is now the binding constraint

`master` bounded the operator with on-chain machinery (sync window, step
coverage, queue fairness) because a permissionless actor sat on the pricing
path. `noRedeem` removes that actor and, with it, the need for most of that
machinery — but the residual operator risk is real and largely unbounded by
contract. The mitigation is role separation (`OKU_RATE_SETTER` can misprice but
not convert; `REQUEST_FULFILLER` can convert but not misprice), not a numeric
limit.

---

## 5. Summary

| | `master` | `noRedeem` |
|---|---|---|
| Redemption permissionless | **Yes** | No — backend-fulfilled |
| Can disable redemption alone | **No** — global pause only | N/A; fulfilment is already gated |
| Backlog drainable while paused | **No** | **Yes** |
| Per-tx / per-user / rate limits | **None** | N/A on the gated path; none on `wrap` |
| Directional toggle | **No** | `wrapEnabled` — entry only |
| Mint capped | Yes (nominal at deploy) | Yes |
| Burn capped | **No** | No, but unreachable permissionlessly |
| Exit guaranteed by solvency | **No** — gap unfunded | Yes — pre-funded invariant |
| Escrow recoverable while paused | N/A | Yes for module pause, **no for OkuM pause** (§4.1) |

**One action fell out of this review:** §4.1 was a real defect that no one had
filed. It is now covered by a regression test and tracked. Everything else is
either resolved by the pivot or already on the tracker.

The broader point is that `master`'s controls fail a simple test — *can the
operator stop the bleeding without also stopping the treatment?* — and `noRedeem`
passes it everywhere except §4.1.
