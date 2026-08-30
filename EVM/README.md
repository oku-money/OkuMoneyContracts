# Oku Money — EVM

Two tokens, one price, and a small permissionless window.

- **OkuM** (Oku Money) — non-rebasing share token backed by off-chain RWA. Its
  ERC-8056 multiplier `M_oku` is the single price in the system.
- **USDOku** (Oku Dollar) — a rebasing, dollar-denominated presentation of OkuM.
- **LitePSM** — bounded permissionless USDC ↔ OkuM conversion at `M_oku`.

---

## Design

### One multiplier, three roles

`OkuM.uiMultiplier()` is simultaneously:

1. the **ERC-8056 display multiplier** — what wallets show,
2. the **PSM mint/redeem price** — what USDC converts at, and
3. the **OkuM ⟷ USDOku conversion price** — what wrap/unwrap convert at.

These are the same number **by construction, not by convention**. A display price
that can drift from a settlement price is the single most likely source of a
user-visible loss, and unifying them removes the possibility rather than managing
it.

`USDOku`'s index `M_usd` is a *separate* thing that does **not** set the exchange
rate. It cancels algebraically out of `wrap` — shares are minted at `M_oku/M_usd`
then valued back at `M_usd` — and does not appear in `unwrap` at all. Its only job
is to make balances rebase.

### The two indices

| | Character | Set from |
|---|---|---|
| **`M_oku`** | Continuous, **rear-facing** | Yield the issuer has *already banked*, delivered smoothly over the following window |
| **`M_usd`** | Continuous, **forward-looking** | A declared steady headline rate |

The wedge between them **is** the smoothing buffer, held as surplus OkuM in the
vault:

| | RWA realized | `M_oku` | `M_usd` | Vault surplus |
|---|---|---|---|---|
| Good period | 0.40% / 30d | 4.87% APR | 4.50% APR | **accumulates** |
| Lean period | 0.30% / 30d | 3.65% APR | 4.50% APR | **draws down** |

That is what delivers a stable headline rate from a variable real one.

> A *persistent* `M_usd < M_oku` is economically a fee on USDOku holders, since the
> wedge accrues to the vault. Fine as a buffer; be deliberate if it trends.

### Rear-facing yield, smooth delivery

The rate for a segment distributes yield **already banked**, spread across the
following window. Two consequences:

- **OkuM never accrues against a forecast.** At every instant, cumulative accrual
  since declaration is bounded by what was held at declaration.
- The one-period lag leaves the system carrying roughly **one period of surplus at
  all times** — a structural cushion that absorbs an underperforming period with no
  intervention.

Rate *variability* is therefore not a solvency risk. If earnings halve, you declare
a lower rate next period; you are never paying out money you do not have.

**This cannot be proven on-chain.** OkuM's backing is off-chain RWA and no contract
can inspect it. The guarantee is procedural. What *is* enforced is the blast radius
if the procedure fails or the key is compromised:

| Bound | Effect |
|---|---|
| `MAX_IMPLIED_APR_BPS` | Caps the rate |
| `MAX_RATE_DURATION` | Caps the window |
| `MAX_REANCHOR_BPS` | Caps any instantaneous jump at 0.1% |
| Flatline on expiry | Past `endTime`, accrual stops dead |

Worst case is `cap_APR × one window`, and it is self-healing. `setOkuMRate` also
logs a `realizedYieldBacking` parameter — an immutable, auditable claim, though not
a check. See TRACKER for why a separate attester role was considered and rejected.

### Why continuous instead of stepped

A discrete step has two problems. The familiar one is that it is a free round-trip
for anyone holding across it, funded from the PSM buffer. At ~$100k of liquidity
per chain that is worth a few thousand a year — real but not decisive.

**The decisive one is multichain.** Oku Money deploys to ten networks. An
orchestrator stepping each chain separately opens a window on every mark during
which chain A has stepped and chain B has not — a cross-chain round-trip for as
long as propagation takes. No amount of per-chain care closes it.

A **segment anchored to absolute wall-clock time** closes it completely:

```
index(t) = baseIndex × rpow(rate, min(t, endTime) − startTime) / 1e18
```

`M_oku(t)` is a pure function of time. Publish identical parameters on every chain
and every chain reports an identical multiplier at every instant, **regardless of
when each transaction landed**. No messaging, no oracle, no sync window, no bridge.

It is also **self-healing**: because `baseIndex` is supplied as an absolute value
rather than derived from local history, a chain that misses a segment entirely is
restored by the next one. Deriving it locally would make that divergence permanent.

`MAX_REANCHOR_BPS` exists exactly for this catch-up, and caps it at 0.1% — which is
what makes "no step arbitrage" a **contract-enforced** property rather than a
procedural one. Even a fully compromised `OKUM_RATE_SETTER` cannot manufacture a
larger step.

### The ERC-8056 fit

A segment scheduled to begin in the future **is** the pending multiplier:

```
effectiveAt()     == pending.startTime
newUIMultiplier() == pending.baseIndex   // the value it takes effect at
```

so `uiMultiplier() == newUIMultiplier()` exactly at `effectiveAt`. The standard's
scheduling primitive turns out to be precisely the multichain sync primitive:
publish ahead of time on every chain and they all flip simultaneously by wall clock.

The EIP permits this explicitly — *"how the multiplier is updated is an
implementation detail left to the token issuer."*

**One deliberate conformance deviation.** `uiMultiplier()` drifts continuously while
`UIMultiplierUpdated` fires only on declaration. A consumer caching on the event
will under-display. The value is monotonic, so staleness always *understates* and
never overstates. Tracked, and worth raising upstream.

We also fix a real defect in the EIP's reference implementation: its setter branches
on `>` while its view resolves on `>=`, so a pending value maturing in the same
second as the next write is silently lost. `_installSegment` crystallises through
the same `>=`-consistent resolution the view uses, removing the second branch.

### The PSM is a window, not the exit

Deliberately small — order **$100k per chain**. At that size the **USDC buffer is
the security bound**: the worst case from any pricing error or key compromise is
the buffer, per chain.

Redemption **reverts** when the buffer is exhausted. There is no queue. That removes
FIFO fairness, stranded users, and a specific flaw in the predecessor design where
pausing to stop an outflow *also* froze payouts to everyone already queued.

**No fees.** A fee floor exists to make a round-trip across a step unprofitable.
With continuous accrual a round-trip earns exactly the elapsed-time yield — what a
legitimate holder earns — so the fee has nothing left to defend.

### Two gates, not one

| | Role | Purpose |
|---|---|---|
| `mintEnabled` / `redeemEnabled` | `PSM_GATEKEEPER` | The KMS back-end's routine lever |
| `pause()` | `PSM_PAUSER` | Incident response |

Closing the window is an everyday operation because **`setOkuMRate` requires it** —
which keeps rate publication and trading disjoint without an on-chain calendar, DST
handling, or a holiday table. The back-end defines its own market hours by closing
and reopening.

A fresh deployment starts **closed**, so the first segment can be published before
anyone can trade against the default 1.0 multiplier.

### Pre-funding is a maintained invariant

`MAX_SOLVENCY_GAP_BPS == 0`. Declaring a USDOku rate requires the liability
**projected to `rateEnd`** to be covered by OkuM the vault already holds, valued at
today's `M_oku`. Backing is deliberately *not* projected forward: a future OkuM
segment may carry a lower rate, so projecting it would be optimistic rather than
merely computed.

This closes a real defect where `M_usd` outrunning `M_oku` left a grown USDOku
balance unredeemable — earlier exiters paid in full, last one out stranded.

`wrap` is checked against the same projection, not spot coverage: a mid-segment
entrant adds shares that accrue to `rateEnd`. That hole was found by stateful
fuzzing, not inspection.

Rounding favours the invariant in both directions — `wrap` floors the share credit
(building surplus), `unwrap` ceils the share burn (liability falls at least as fast
as backing).

---

## Contracts

| Contract | Description |
|---|---|
| `src/token/OkuM.sol` | Share token. ERC-20 raw ledger + ERC-8056 display layer + continuous accrual |
| `src/token/USDOku.sol` | Rebasing dollar presentation. Share ledger, `M_usd`, solvency invariant |
| `src/psm/LitePSM.sol` | Bounded permissionless USDC ↔ OkuM at `M_oku` |
| `src/lib/ScaledUIAmountUpgradeable.sol` | ERC-8056 core + all three extensions, segment-based |
| `src/lib/MathLib.sol` | `rpow`, `compound`, `toUIAmount`/`fromUIAmount`, USDC scaling, `impliedAprBps` |
| `src/lib/Constants.sol` | Bounds, interface IDs, terminology legend |
| `src/lib/Roles.sol` · `Errors.sol` · `ReentrancyGuardUpgradeable.sol` | Support |
| `src/interfaces/IOkuM.sol` · `IUSDOku.sol` | Consumer-facing surfaces |
| `src/interfaces/erc8056/*.sol` | The four EIP interfaces, so `type(I).interfaceId` is assertable |

**Deleted from the predecessor design:** `RedemptionQueue.sol` (ordering is an
off-chain policy decision), `YieldSandwichGuard.sol` (a continuous segment changes
slope not level — there is nothing to sandwich), `SafeApprove.sol` (dead code),
`lib/events/*.sol` (folded onto their contracts), and the two dead `MathLib` wrap
helpers.

**Stack:** Solidity 0.8.28 / Cancun · Foundry + Hardhat · OpenZeppelin v5.6.1
Upgradeable · UUPS proxies · ERC-7201 namespaced storage.

---

## Testing

```bash
forge test                                             # 102 tests
forge test --match-path "test/SystemInvariants.t.sol"   # 256 × 500 = 128k calls each
forge fmt --check
forge coverage --no-match-coverage '^(test|script)/|node_modules/|^lib/' --report summary
npx tsc --noEmit && npx hardhat compile
npm run upgrade:validate                                # OZ storage-layout validator
```

**Current state: 102 tests, 100% line and 100% function coverage on `src/`
(554/554 lines), zero lint warnings in `src/`.**

> The coverage filter must be **anchored**. An unanchored `lib/` also matches
> `src/lib/`, which silently drops the ERC-8056 display layer from measurement
> entirely.

| File | Covers |
|---|---|
| `Differential.t.sol` | **The two load-bearing proofs**, each verified lethal by sabotage |
| `SystemInvariants.t.sol` | 10 invariants at 128k calls, adversarial handler |
| `OkuM.t.sol` | ERC-8056 conformance, rate bounds, halt, the closed-window rule |
| `USDOku.t.sol` | The `M_oku`-only exchange rate, pre-funding, rebasing ledger |
| `LitePSM.t.sol` | The buffer bound, the two gates, pricing, deployment guards |
| `MathLib.t.sol` | Rounding policy, `rpow` assembly branches, `compound` determinism |
| `Coverage.t.sol` | Accessors, admin paths, defensive branches incl. the unreachable `_update` guard |

### The two proofs

Everything rests on these, so neither is merely asserted:

1. **No arbitrage** — `test_roundTripCannotBeatElapsedYield` shows a permissionless
   round-trip earns exactly the elapsed-time yield, against a mutant computing what
   a *stepped* multiplier would have handed over. Sabotaging `indexAt` into a step
   makes it fail.
2. **Multichain determinism** — `test_identicalSegmentsSynchroniseAcrossChains`
   installs the same segment on two deployments at block timestamps 47 minutes
   apart and asserts they agree at every sampled instant. Anchoring to
   `block.timestamp` instead of the supplied `startTime` makes it fail.

Both sabotages were run and both were caught by exactly the right test.

The invariants are **probe-verified**: temporary inverted assertions confirmed the
fuzzer reaches non-degenerate states (multiplier moved, 88k OkuM minted, vault
holding reserves) rather than no-oping through the handler's `try/catch`.

CI fails below **95% line coverage** on any `src/` file. Everything sits at 100%.

---

## Roles

Pause and unpause are split everywhere: **a compromised warm key can stop the
protocol but cannot restart it.**

| Role | Custody | Can | Cannot |
|---|---|---|---|
| `OKUM_RATE_SETTER` | Orchestrator (KMS) | Declare segments — set the price every conversion executes at | Move funds, open the window's buffer |
| `PSM_GATEKEEPER` | Orchestrator (KMS) | Open/close the conversion window | Withdraw the buffer |
| `PSM_BUFFER_WITHDRAWER` | Cold | Remove USDC | Set a price |
| `OKUM_PAUSER` / `VAULT_PAUSER` / `PSM_PAUSER` | Warm | Halt | Resume |
| `*_UNPAUSER`, `*_UPGRADER`, `OKUM_CAP_MANAGER` | Cold | Resume, upgrade, widen caps | — |

The separation that matters: the orchestrator can **misprice** but not
**extract**; the buffer withdrawer can extract but not misprice.

---

## Deployment

```bash
FORK_NETWORK=base npx hardhat node                          # Terminal 1
npx hardhat run scripts/deploy/index.ts --network localhost # Terminal 2
npx hardhat run scripts/test/test-onchain.ts --network localhost
```

Deploy order is enforced: **OkuM → USDOku → LitePSM**. CREATE2-deterministic via
the Arachnid factory, salt
`keccak256("okumoney." + DEPLOYMENT_VERSION + "." + name)`.

Three post-deploy steps have no on-chain default:

1. `OkuM.setConversionGate(psm)` — without it the closed-window check is **inert**
   and rates could be published mid-trading. The deploy script does this and
   `verifyDeployment` warns if it is missing.
2. `configureMinterAllowance(psm, ...)` — mint reverts otherwise.
3. Publish the first segment, **then** `openWindow()`.

### Multichain rate publication

```bash
# Once, to derive the parameters:
DRY_RUN=true npm run operator:setOkuMRate -- --apr-bps=500 --duration=2592000 --realized=412000

# Then per chain, reusing the printed parameters VERBATIM:
NETWORK=base   npm run operator:setOkuMRate -- --base=… --rate=… --start=… --end=…
NETWORK=optimism npm run operator:setOkuMRate -- --base=… --rate=… --start=… --end=…
```

**Do not re-derive `--base` per chain** — passing the identical absolute value is
what makes the chains agree. Use a `--start` in the future so all chains flip
simultaneously by wall clock.

---

## Limitations

1. **OkuM's backing cannot be verified on-chain.** It is off-chain RWA. The
   rear-facing guarantee is procedural; only its blast radius is enforced.
2. **A negative real return cannot be passed through.** Multipliers are monotonic,
   so a loss flatlines the index and is absorbed by the issuer rather than holders.
   Almost certainly what you want for a stable-value product, but it is an equity
   commitment.
3. **`wrap` can revert because of issuer behaviour**, not the caller's, when the
   forward headroom is unfunded.
4. **A single address can take the whole buffer** in one transaction. At $100k that
   is a fairness question, not a solvency one — token bucket tracked.
5. **SVM is not yet on this spec**, so the synchronisation property currently holds
   across the EVM deployments only.
6. **Pausing OkuM blocks `unwrap`**, since the vault→user transfer passes through
   `_update`'s pause check.

---

## Pointers

- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **ERC-8056 (Draft):** https://eips.ethereum.org/EIPS/eip-8056
- **ERC-8056 discussion:** https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899
- **Lido's staking rate limit** (the token-bucket precedent): https://docs.lido.fi/guides/lido-tokens-integration-guide/#staking-rate-limits
