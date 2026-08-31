# Oku Money Protocol

Yield-bearing stablecoin infrastructure backed by US Treasury Bills.
Centralized B2B product — registered MSB, not a DeFi protocol. EVM +
SVM in parallel, off-chain orchestrator coordinating both.

> **For reviewers:** start with the per-side READMEs ([`EVM/README.md`](EVM/README.md),
> [`SVM/README.md`](SVM/README.md)), each with an "Accepted Risks" section
> covering known design decisions. Open items live in [`TRACKER.md`](TRACKER.md).

> **`master` is retired — do not deploy from it.** It is the pre-`8056` EVM
> generation and carries three known live defects (no step-arbitrage defence, no
> cross-chain sync, one coarse pause lever) that this branch exists to fix. Tagged
> `master-retired-v1`. See TRACKER.md's "`master` should be marked retired" entry
> for the full defect list.

---

## Design philosophy

**Off-chain orchestrator architecture** for maximum operational
agility:

- **Orchestrator** coordinates all protocol operations. Never stores
  private keys — constructs payloads and requests Cloud KMS signatures.
- **Direct chain operations** — interacts directly with contracts via
  KMS-signed transactions.
- **Trust model** — openly centralized product for safe government
  yield. Users trust Oku Money to manage RWA backing and operate
  infrastructure responsibly.
- **Legal framework** — registered with FinCEN as an MSB. Licensed
  as a money transmitter in states where we onboard users.

```
                    ┌─────────────────────────┐
                    │    Off-Chain             │
                    │    Orchestrator          │
                    │    (Cloud KMS)           │
                    └───────────┬──────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
   ┌─────────┐            ┌─────────┐            ┌─────────┐
   │ Ethereum│            │ Arbitrum│            │ Solana  │
   │   EVM   │            │   EVM   │            │   SVM   │
   └─────────┘            └─────────┘            └─────────┘
```

---

## Token model

### EVM — dual-token split-economy

Two tokens with independent economics:

| Token | Type | Yield | Purpose |
|---|---|---|---|
| **Oku Money (OkuM)** | Non-rebasing | Continuous, **rear-facing** (realized RWA returns) | DeFi, protocol integrations |
| **Oku Dollar (USDOku)** | Rebasing ($1 denominated) | Continuous, **forward-looking** (declared policy rate) | Retail UX, "balance grows" experience |

**OkuM** is the solvency anchor — it only ever distributes yield already banked,
spread smoothly over the following window. `balanceOf()` returns a static raw token
count; value appreciation lives in `uiMultiplier()` (`M_oku`), its ERC-8056 display
multiplier.

`M_oku` is **the single price in the system** — it is simultaneously the wallet
display multiplier, the PSM's USDC conversion price, and the OkuM ⟷ USDOku
conversion price. Those are the same number by construction.

**USDOku** is the policy lever. `balanceOf()` grows every second via `rpow`
streaming at a declared steady rate, and the vault holds OkuM as reserves. `M_usd`
does NOT set the exchange rate — it cancels out of `wrap` and is absent from
`unwrap` — its only job is to make balances rebase.

The wedge between the two indices IS the smoothing buffer:

```
M_usd rate > M_oku rate  →  surplus draws down   → must be PRE-FUNDED (enforced)
M_usd rate = M_oku rate  →  surplus steady
M_usd rate < M_oku rate  →  surplus accumulates  → extractable via withdrawSurplus
```

`MAX_SOLVENCY_GAP_BPS == 0`: a forward USDOku rate can only be declared if the
liability projected to `rateEnd` is already covered by OkuM the vault holds.

### SVM — single-token model

A single token: **OkuM**, a Token-2022 mint
(`BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g`) with
`ScaledUiAmount` + `MetadataPointer` + `TokenMetadata` extensions.
The on-chain token IS OkuM (a value-appreciating T-Bill-backed
token); the `TokenMetadata` extension stores the wallet-facing brand
`name: "OkuDollar", symbol: "usdOku"` so wallets display it as a $1
stablecoin. See [`SVM/README.md` § Naming convention](SVM/README.md)
for the full split.

There is no separate OkuMoney token on SVM. The **multiplier** lives
directly on the mint extension (`ScaledUiAmountConfig`) and is the
single source of truth — it determines both the raw-to-UI scaling and
the USDC conversion rate in the PSM. Revenue extraction happens
off-chain before yield distribution (the orchestrator sets the
multiplier to a value that already accounts for the protocol take).

---

## On-chain components

### EVM

```
┌─────────────────────────────────────────────────────────────────┐
│                     EVM On-Chain Contracts                        │
│                                                                  │
│  ┌────────────────┐ ┌──────────────┐   ┌──────────────┐        │
│  │  OkuM          │◄┤  USDOku      │   │   LitePSM    │        │
│  │  (Non-Rebase)  │ │  (Rebasing)  │   │  (USDC ↔ OkuM│        │
│  │  ERC-8056      │ │  Vault       │   │   at M_oku)  │        │
│  │  uiMultiplier  │ │              │   │              │        │
│  └────────────────┘ └──────────────┘   └──────────────┘        │
│                                                                  │
│  No bridge and no redemption queue. Chains stay consistent by    │
│  publishing IDENTICAL rate segments, anchored to absolute        │
│  wall-clock time — not by messaging.                             │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **OkuM** | Non-rebasing base token. Static balance; value appreciates via the continuously-accruing ERC-8056 `uiMultiplier()`. |
| **USDOku** | Rebasing $1-denominated presentation of OkuM. Balance grows; backed by OkuM reserves under a maintained pre-funding invariant. |
| **LitePSM** | Bounded permissionless USDC ↔ OkuM at `M_oku`. ~$100k per chain, no fees, no queue — redemption reverts when the buffer is exhausted. |

**Cross-chain consistency without messaging.** A rate segment is
`(baseIndex, ratePerSecond, startTime, endTime)` anchored to absolute wall-clock
time, so the index is a pure function of `block.timestamp`. Publishing identical
parameters on every chain gives an identical multiplier everywhere at every
instant, regardless of when each transaction lands — and a chain that misses a
segment is self-healed by the next one.

> **SVM has not yet adopted this.** Until it does, the synchronisation property
> holds across the EVM deployments only. Tracked in [`TRACKER.md`](TRACKER.md).

### SVM

```
┌─────────────────────────────────────────────────────────────────┐
│                     SVM On-Chain (lite-psm)                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐         │
│  │  lite-psm (BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCG…) │         │
│  │  ─ mint_oku_m / redeem_oku_m (buffer-only)         │         │
│  │  ─ set_multiplier / distribute_yield               │         │
│  │  ─ mint_oku_m_direct / burn_oku_m_direct           │         │
│  └────────────────────────────────────────────────────┘         │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────┐         │
│  │  OkuM — Token-2022 mint                            │         │
│  │  Extensions: ScaledUiAmount + MetadataPointer       │         │
│  │              + TokenMetadata                        │         │
│  │  Multiplier on ScaledUiAmountConfig                 │         │
│  └────────────────────────────────────────────────────┘         │
│                                                                  │
│  PDA: psm_config_v6 (no redemption queue — buffer-only PSM)      │
│  Precision: 1e9 · MAX_MULTIPLIER: 1e15 · 6 decimals             │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **lite-psm** | Single program handling PSM (USDC ↔ OkuM, buffer-only — no redemption queue), yield distribution, and compliance. |
| **OkuM mint** | Token-2022 mint with `ScaledUiAmount` extension — multiplier on the mint is the single source of truth for pricing and UI display. |

---

## Yield distribution & sandwich prevention

**EVM** declares a *continuous accrual segment* rather than stepping the
multiplier: `setOkuMRate(baseIndex, ratePerSecond, startTime, endTime,
realizedYieldBacking)` on OkuM installs `(baseIndex, ratePerSecond, startTime,
endTime)`, and `uiMultiplier()` is a pure function of `block.timestamp` from
then on. A *routine* declaration only ever changes slope, not level — the curve
is seamless at the moment it takes effect, so there is nothing to sandwich and
no same-block lock is needed. The one level-moving case, a re-anchor (catch-up
for a chain that missed a segment), is bounded to `MAX_REANCHOR_BPS` (0.1%) and
must take effect immediately rather than land at a scheduled future time — see
[`EVM/README.md`](EVM/README.md) and [`TRACKER.md`](TRACKER.md).

**SVM** still updates the multiplier discretely via `set_multiplier()` /
`distribute_yield()` on lite-psm, and still needs the single-block/slot lock
(`last_yield_distribution_slot`) to prevent sandwiching a real step. Bringing
SVM onto the segment model is tracked in [`TRACKER.md`](TRACKER.md) as the
largest open item.

---

## PSM (Peg Stability Module)

### EVM — price-aware USDC ↔ OkuM swaps

```
mintOkuM:      okuMAmount = usdcValue × PRECISION / uiMultiplier()
redeemOkuM:    usdcAmount = okuMAmount × uiMultiplier() / PRECISION
```

USDOku is reached in two steps — the PSM no longer ships wrap/unwrap convenience
flows; one contract, one job:

```
to USDOku:     psm.mintOkuM(usdc)  then  usdOku.wrap(okuM, receiver, minOut)
from USDOku:   usdOku.unwrap(usd, receiver)  then  psm.redeemOkuM(okuM, minOut)
```

### SVM — direct USDC ↔ OkuM swaps (buffer-only)

```
mint_oku_m:    raw_amount = usdc_amount × PRECISION / multiplier
redeem_oku_m:  usdc_amount = raw_amount × multiplier / PRECISION
```

lite-psm provides direct `mint_oku_m` / `redeem_oku_m` instructions —
no wrapping or off-chain composition needed. `redeem_oku_m` is
**buffer-only**: it reverts with `InsufficientBuffer` if the PSM's
USDC vault can't cover the redemption. There is no redemption queue
on SVM (deliberately removed — see
[`SVM/README.md` § Why no redemption queue](SVM/README.md)).

---

## Cross-chain transfers (v1: off-chain orchestrated)

No on-chain bridging in v1. Cross-chain transfers are orchestrated
off-chain, with **different mechanics per stack**:

### EVM ↔ EVM — PSM-mediated USDC flow

1. User redeems OkuM for USDC on chain A via `LitePSM.redeemOkuM`.
2. Orchestrator observes the burn, waits for finality, then performs
   an equivalent USDC-funded `mintOkuM` on chain B crediting the
   recipient.
3. PSM USDC buffers on each chain are rebalanced operationally by
   treasury.

**`mintOkuM` is permissionless.** Any address with USDC can call it;
the orchestrator does NOT hold `OKUM_MINTER`. Orchestrator key
compromise grants no special mint privilege beyond the orchestrator's
USDC custody.

**Cross-chain USDC flow conservation invariant (EVM):**

```
|USDC_redeemed_A - USDC_minted_B| ≤ 1 USDC-unit per bridge
Cumulative drift across N bridges ≤ N USDC-units
```

### SVM ↔ SVM — direct burn/mint of OkuM

SVM bridges use `burn_oku_m_direct` / `mint_oku_m_direct` —
direct burn and mint of OkuM **without a USDC intermediary**. The
orchestrator burns OkuM on the source chain and mints an equivalent
raw amount on the destination chain.

**SVM-to-SVM bridges conserve raw OkuM amounts 1:1** — no USDC
conversion, no rounding from multiplier differences.

### Cross-stack (EVM ↔ SVM)

The orchestrator handles the asymmetry between the two-token EVM
model and the single-token SVM model:

- **EVM → SVM:** redeem OkuM for USDC on EVM, then `mint_oku_m`
  on SVM (USDC-funded).
- **SVM → EVM:** `burn_oku_m_direct` on SVM, then `mintOkuM` on
  EVM (orchestrator supplies USDC). If the user wants USDOku on EVM,
  follow with `usdOku.wrap(okuM, receiver, minOut)` — there is no
  privileged one-call convenience mint; wrap is the permissionless path.

Cross-chain bridge scenarios are covered by
`SVM/oku-programs/tests/bankrun/crossChainBridging.ts`. The EVM side of a
bridge is exercised through the ordinary `LitePSM`/`USDOku` Foundry suites
(`EVM/test/`) — there is no dedicated cross-chain scenario harness on the EVM
side yet.

### Future bridging

OkuBridge (proprietary burn-and-mint) and third-party rails (NTT,
CCIP) are planned post-launch and will be introduced as additive
components:

- **EVM** retains role constants (`BRIDGE_*`, `ROUTER_*`, `NTT_*`)
  and integration interfaces (`IOkuBridgeNative`, `IBridgeAdapter`)
  in the tree as reserved seams so re-introduction does not require
  modifying existing contracts.
- **SVM** has no reserved enum variants — a future on-chain bridge
  will ship as a brand-new program granted minter authority via PSM,
  the same additive shape as the EVM path.

### Orchestrator runbook

The orchestrator coordinates every cross-chain bridge. The operating
procedures below were previously in a standalone `docs/orchestrator-runbook.md`
and are consolidated here.

#### Pre-flight checklist (per bridge)

Verify on **both source and destination chains** before submitting:

| Check | EVM | SVM |
|---|---|---|
| Destination PSM not paused | `LitePSM.paused()` | `psm.account.psmConfig.fetch(...).isPaused` |
| Destination supply headroom | `OkuM.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuM.minterAllowance(psm) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user token balance | `OkuM.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(psm) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` (EVM↔SVM only; SVM↔SVM uses direct burn/mint) |
| Recipient ATA not frozen | `OkuM.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |

**Neither side has a redemption queue.** If the source PSM buffer cannot cover the
redeem, it reverts `InsufficientBuffer` — there is nothing to escrow, drain, or
poll. Check capacity BEFORE committing to a bridge:

```
EVM:  psm.availableToRedeem()  → USDC redeemable right now (0 if closed or paused)
SVM:  getAccount(vaultUsdc).amount
```

If capacity is short, call `depositBuffer` first. SVM-to-SVM bridges bypass the
USDC buffer entirely, using direct `burn_oku_m_direct` / `mint_oku_m_direct` to
conserve raw OkuM amounts 1:1.

#### Fund the vault before marketing USDOku (EVM)

`USDOku.wrap` is permissionless but reverts `WouldBreachBacking` when the vault's
funded surplus cannot cover a new entrant's forward liability to `rateEnd` — a
revert caused by the ISSUER not having pre-funded, not by anything the caller did
wrong. This is expected behaviour under the pre-funding invariant
(`MAX_SOLVENCY_GAP_BPS == 0`), not a bug, but it means driving retail traffic to
`wrap` without checking headroom first produces a wave of confusing failures.

Before any USDOku marketing push or onboarding batch:

```
EVM: usdOku.withdrawableSurplus()  → 0 means no headroom for new entrants
     usdOku.realizedBacking() vs usdOku.projectedLiabilityAtRateEnd()
```

If headroom is thin, call `depositReserves` (fund the vault with OkuM) before
increasing wrap volume — do not lower the declared rate to "fix" a funding gap
that funding, not de-scoping, is meant to solve. `scripts/operator/solvencyStatus.ts`
reports this read-only, with no role required.

#### Mid-flight failure recovery

| Failure mode | Recovery |
|---|---|
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap), wait for the blocking condition to clear, retry `mintOkuM` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain OkuM is already burned. |
| Source redeem reverted `InsufficientBuffer` | Nothing was burned and no state changed — the bridge simply did not start. Call `depositBuffer` to top up, then retry. Check `availableToRedeem()` before committing next time. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Multiplier-tick sequencing across chains

**On EVM this is no longer a sequencing problem.** A rate segment is anchored to
absolute wall-clock time, so the index is a pure function of `block.timestamp`:
publish the IDENTICAL `(baseIndex, ratePerSecond, startTime, endTime)` on every EVM
chain and they agree at every instant regardless of when each transaction lands.
Schedule `startTime` in the future and every chain flips simultaneously.

Two rules for the orchestrator:

1. **Derive the parameters once, reuse them verbatim.** Do NOT re-derive
   `baseIndex` per chain — passing the same absolute value is exactly what makes
   the chains agree. `npm run operator:setOkuMRate -- --dry-run` prints the tuple
   to reuse.
2. **A missed chain self-heals.** Because `baseIndex` is absolute, a chain that
   misses a segment entirely is restored by the next one, within
   `MAX_REANCHOR_BPS` (0.1%, roughly a week of catch-up at 5% APR).

3. **On SVM only, wait one slot after a price tick before bridging**, to avoid
   `YieldDistributionInProgress`. EVM has no equivalent lock — a routine segment
   declaration changes slope, not level, so there is nothing to wait out.

> **SVM still uses a discrete multiplier** and therefore still needs same-batch
> sequencing, with the old caveat: if sequencing diverges, per-bridge dollar value
> is still conserved but the recipient may receive a slightly different raw amount.
> Bringing SVM onto segments is tracked in [`TRACKER.md`](TRACKER.md).

#### Minter allowance rotation policy

`minterAllowance` on `OkuM` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds how many raw OkuM tokens the PSM can mint on each chain
before an explicit refresh.

- **Testnet:** `minterAllowance == maxSupply == 1B` — effectively uncapped for dev.
- **Production:** ~ **1 % of weekly bridging volume**, rotated on a **weekly cadence** by `OKUM_ALLOWANCE_MANAGER` (cold multisig). Bounds a single-week worst-case mint by a compromised PSM contract or orchestrator USDC custody.

EVM rotation:

```bash
NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts \
  --network base --minter <psm-address> --allowance 10000000000000000000000000 --yes-mainnet
```

SVM rotation:

```bash
NETWORK=mainnet-beta tsx scripts/admin/set-minter-allowance.ts \
  --amount=10000000 --yes-i-mean-it-on-mainnet
```

Monitoring alerts: `minterAllowance < 10 %` of weekly throughput; or
not rotated in > 7 days.

#### Monitoring SLAs

| Metric | Alert threshold | Notes |
|---|---|---|
| Orchestrator token float (EVM) | Non-zero OkuM for > 1 h between batch cycles | EVM bridges use PSM-mediated USDC flow |
| Queue depth (EVM only) | Oldest pending entry > 24 h unfilled | SVM has no queue — buffer depletion reverts the redeem instead |
| PSM buffer | < 2 × expected daily redemption volume | Depleted buffer reverts SVM redeems with `InsufficientBuffer`; EVM redeems queue instead |
| Minter allowance | < 10 % of weekly throughput estimate | |
| Pause state | PSM paused for > 15 min unexpectedly | |

SVM bridges use direct `burn_oku_m_direct` / `mint_oku_m_direct`
— there is no orchestrator token float to monitor (no USDC
intermediary). Monitor the direct minter/burner transaction success
rate instead.

All metrics on a 1-min cadence. PagerDuty for "token float" and
"queue > 24 h"; Slack warning for the rest.

#### Orchestrator security

- Orchestrator key has **NO special minting authority** on EVM.
  Compromise does not allow minting beyond the key's USDC holdings.
  On SVM, the orchestrator may hold `direct_minter` / `direct_burner`
  roles for cross-chain bridge operations (direct OkuM mint/burn).
- **EVM roles:** `OKUM_RATE_SETTER`, `VAULT_RATE_SETTER`,
  `PSM_GATEKEEPER`, `PSM_BUFFER_DEPOSITOR`.
- **SVM roles:** `rebaser`, `buffer_depositor`, `direct_minter`,
  `direct_burner`. (No `VAULT_RATE_SETTER` equivalent on SVM — no vault.)
- The separation that matters on EVM: the orchestrator can **misprice**
  (`OKUM_RATE_SETTER`) and can **open the window** (`PSM_GATEKEEPER`), but holds
  neither `PSM_BUFFER_WITHDRAWER` nor a direct mint authority. Mispricing and
  extraction sit in different key custodies.
- Compromise allows multiplier manipulation and buffer drain —
  material but bounded. On EVM, compromise also allows skipping
  ahead in the redemption queue. On SVM, compromise allows direct
  OkuM mint/burn up to `minterAllowance` (no queue to skip — SVM has
  none). Cold multisig controls `*_UNPAUSER` and
  `*_BUFFER_WITHDRAWER` (more dangerous).
- Rotate the orchestrator key immediately on suspected compromise.
  Pausing both PSMs (warm multisig) is the emergency lever.
- **No two concurrent orchestrator instances** should process the
  same user bridge request. Off-chain dedup (nonces, event-ID
  tracking) is the orchestrator's responsibility.

---

## RBAC (role-based access control)

One role per action. No role performs more than one function.

| Entity | EVM Roles | SVM Roles |
|---|---|---|
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, RESERVE_MANAGER | role_admin, unpauser, cap_manager, allowance_manager, buffer_withdrawer |
| Warm Multisig | all PAUSER, all BLACKLISTER | pauser, freezer |
| Orchestrator | OKUM_RATE_SETTER, VAULT_RATE_SETTER, PSM_GATEKEEPER, BUFFER_DEPOSITOR | rebaser, buffer_depositor, direct_minter, direct_burner |
| LitePSM | OKUM_MINTER, OKUM_BURNER (split on EVM) | Mint authority on OkuM Token-2022 mint |

The `BRIDGE_*`, `ROUTER_*`, and `NTT_*` roles defined in
`EVM/src/lib/Roles.sol` are reserved for future re-introduction of
OkuBridge / NTT / CCIP — not granted by v1 deploy scripts.

**Devnet/testnet delegation.** The table above is the mainnet target
model. On devnet/testnet it's common to delegate operational roles
(`direct_minter`, `direct_burner`, `rebaser`, `buffer_depositor` on
SVM) to a coworker- or CI-owned key while governance/safety roles
and `role_admin` stay with the deployer/owner — see
[`SVM/README.md § Delegated operation vs. retained ownership`](SVM/README.md)
for the full rationale and the `grant-roles.ts --delegate=<pubkey>`
tool that implements it.

### Signer trust implications

okuMoney is a **centralized financial product**. Users trust Oku
Money as an institution — the same way they trust Circle for USDC or
Paxos for PYUSD. On-chain RBAC enforces *separation of duties within
the company*, not protection *against* the company.

#### Cold Multisig (Squads / Safe, hardware-backed quorum)

**Can:**
- Upgrade any contract (EVM: UUPS `_authorizeUpgrade`; SVM: BPF
  program upgrade authority). A malicious or erroneous upgrade can
  replace all logic — the highest-impact key.
- Configure `maxSupply` and `minterAllowance`. Raising allowance to
  the cap and minting up to it is the worst-case mint outcome.
- Drain the USDC buffer (`withdrawUsdc` / `withdraw_buffer`). On EVM,
  bounded by pending redemption-queue obligations; on SVM, bounded
  only by the vault's current balance (no queue to protect).
- Withdraw OkuM surplus from the vault (`withdrawSurplus` /
  `withdraw_reserves`) down to the `minCollateralRatio` floor (EVM only).
- Grant any role to any address (DEFAULT_ADMIN_ROLE / role_admin SVM).
- Unblacklist, unpause, unfreeze ATAs.
- Rotate operational authority pubkeys.

**Cannot (on-chain code prevents even at quorum):**
- Mint above `maxSupply` or `minterAllowance`.
- Move `uiMultiplier` (EVM) / `multiplier` (SVM) below current — both are monotonic.
- Set `usdMultiplier` below current (EVM only — SVM has no vault).
- Push the vault below `minCollateralRatio` via surplus withdrawal (EVM only).
- Set `maxSupply` below current `totalSupply`.
- Set `minCollateralRatio` below the 90 % hard floor (EVM only).

#### Warm Multisig (lower-quorum, faster to sign)

**Can:**
- Pause all protocol contracts, halting mint / redeem / bridging.
- Blacklist any address on OkuM and USDOku (EVM).
- On SVM: freeze any OkuM ATA via Token-2022 freeze authority.

**Cannot:**
- Unpause or unblacklist (cold multisig only). Pause is a one-way
  door for the warm key.
- Access any funds or parameters.

#### Orchestrator (KMS-backed, automated)

**Can:**
- Update `uiMultiplier` (EVM) / `multiplier` (SVM)
  (non-decreasing, bounded by `MAX_MULTIPLIER`). A compromised
  rebaser key can ratchet the multiplier toward the ceiling,
  inflating token dollar value beyond the actual T-Bill backing rate.
- Update `usdMultiplier` on EVM (bounded by `MAX_USD_MULTIPLIER`).
  An extreme bump would push the vault toward the
  `minCollateralRatio` floor, requiring Oku to deposit more
  reserves. (Not applicable on SVM — no vault.)
- Process the redemption queue (EVM only — SVM has no queue).
- Deposit USDC to the PSM buffer.
- Call `mintOkuM` / `redeemOkuM` (EVM) or `mint_oku_m` /
  `redeem_oku_m` (SVM) as a normal user (**permissionless** — the
  orchestrator holds no special mint authority, only USDC custody).
- On SVM: call `mint_oku_m_direct` / `burn_oku_m_direct` for
  cross-chain bridge operations (requires `direct_minter` /
  `direct_burner` roles).

**Cannot:**
- Mint OkuM directly on EVM. `OKUM_MINTER` is held by the PSM /
  contracts.
- Access admin parameters, role grants, upgrades.
- Drain the USDC buffer (cold-multisig BUFFER_WITHDRAWER only).

#### Protocol contracts (LitePSM)

**EVM:** Hold `OKUM_MINTER` / `OKUM_BURNER`. Mint via
`OkuM.mint()` only during `mintOkuM`, gated by
per-minter `minterAllowance` and the global `maxSupply` cap. Burn
(split role) only via `OkuM.burn()` from inside
`redeemOkuM`.

**SVM:** lite-psm holds mint authority on the OkuM Token-2022 mint.
Minting via `mint_oku_m` / `mint_oku_m_direct` is gated by
`minterAllowance` and `maxSupply`. Burning via `redeem_oku_m` /
`burn_oku_m_direct`. `redeem_oku_m` is buffer-only — there is no
redemption queue on SVM to fall back to.

**On timelocks:** okuMoney is centralized US-regulated, not
decentralized. Industry peers (USDC, USDT, USDP, PYUSD, FDUSD) do
not use on-chain timelocks; they rely on operational, procedural,
and regulatory controls. Trust is anchored in Oku Money as a legal
entity, its MSB registration, and its internal control framework —
not in on-chain delay mechanics. The cold-multisig quorum
requirement is itself the delay mechanism. **Timelocks are not pursued.**

---

## EVM vs SVM at a glance

| Aspect | EVM | SVM |
|---|---|---|
| Language | Solidity 0.8.28 | Rust (Anchor 1.0.2) |
| Token model | Dual-token: OkuM (non-rebasing, ERC-8056) + USDOku (rebasing) | Single-token: OkuM with ScaledUiAmount extension (displays as usdOku) |
| Multiplier | Continuous segment `(base, rate, start, end)`, 18dp, anchored to absolute wall-clock time | Discrete value on the mint extension (ScaledUiAmountConfig), 1e9 precision — **not yet on segments** |
| USDOku multiplier | Continuous `rpow` streaming | N/A — single-token model; multiplier serves as both pricing and UI display |
| Cross-chain sync | Structural — identical segment params give identical index, no messaging | Same-batch sequencing still required |
| Token standard | ERC-20 + ERC-8056 (custom rebasing for USDOku) | Token-2022 (OkuM with ScaledUiAmount + MetadataPointer + TokenMetadata) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | Direct OkuM mint/redeem on the PSM; no wrapping needed |
| Redemption when buffer insufficient | Reverts `InsufficientBuffer` — no queue | Reverts `InsufficientBuffer` — no queue |
| Cross-chain transfers (v1) | Off-chain orchestrator + LitePSM mint/burn (USDC-mediated) | Off-chain orchestrator + direct burn/mint of OkuM (`burn_oku_m_direct` / `mint_oku_m_direct`) |

**Full cross-chain parity matrix** — constants, roles, pause
semantics, sandwich-fence behaviour, event schema diffs, deliberate
non-parity items — see [`SVM/README.md § EVM vs SVM — divergence
catalogue`](SVM/README.md#evm-vs-svm--divergence-catalogue).

---

## Directory structure

```
contracts/
├── README.md            # this file
├── TRACKER.md           # Open issues + follow-ups (EVM + SVM)
├── EVM/                 # Solidity contracts (Foundry + Hardhat)
│   ├── README.md        # EVM-specific deployment, contracts, runbook
│   ├── src/
│   │   ├── token/       # OkuM.sol, USDOku.sol
│   │   ├── psm/         # LitePSM.sol
│   │   ├── interfaces/  # IOkuM.sol, IUSDOku.sol, erc8056/
│   │   └── lib/         # ScaledUIAmountUpgradeable, Roles, Constants, MathLib
│   ├── test/            # Foundry + Hardhat suites
│   └── scripts/         # Deploy + operator scripts
├── SVM/                 # Anchor programs (Rust)
│   ├── README.md        # SVM-specific runbook, divergence catalogue, deployment
│   └── oku-programs/
│       ├── programs/
│       │   └── lite-psm/    # PSM (buffer-only, no queue) + yield ops + compliance + direct mint/burn
│       ├── crates/
│       │   └── oku-shared/  # Pure-Rust shared constants + math + yield lock
│       ├── tests/
│       ├── scripts/
│       ├── deployments/     # Per-network deployment records
│       └── keys/            # Local keypair directory (gitignored, see keys/README.md)
├── artifacts/           # Curated ABIs + IDLs for backend / SDK / frontend use
│   ├── evm/             # Slim Hardhat artifacts (abi + bytecode) per contract
│   ├── svm/             # Anchor IDL JSON per program
│   └── README.md        # Consumption docs for downstream services
└── testnet-addresses.json  # Canonical live deployment registry (auto-generated)
```

---

## Deployment runbook

Complete guide for deploying OkuMoney on EVM chains + Solana, and
exercising the on-chain protocol end-to-end. v1 cross-chain transfers
are off-chain orchestrator-mediated (PSM mint/burn) — there is no
on-chain bridge.

> Authoritative deployment state lives in
> [`testnet-addresses.json`](testnet-addresses.json) at the repo root,
> auto-synced by every successful live EVM deploy. Do NOT hand-edit;
> rerun the deploy script to refresh.
>
> Per-chain working address book is at
> [`EVM/scripts/config/addresses.json`](EVM/scripts/config/addresses.json)
> (live `<chain>` keys + `fork:<chain>` namespaces for local-fork runs).

### Prerequisites

**EVM:**
```bash
cd EVM
cp .env.example .env
# PRIVATE_KEY=<deployer key>
# ALCHEMY_API_KEY=<covers Eth/OP/Arb/Base/BSC/Sepolia>
# ETHERSCAN_API_KEY=<single Etherscan V2 key — covers all of the above for verification>
npm install && npx hardhat compile
```

**SVM:**
```bash
cd SVM/oku-programs
cp .env.example .env
solana config set --url devnet
solana-keygen new --outfile ~/.config/solana/id.json   # if needed
npm install && anchor build
```

**(Optional) Surfpool** for SVM local-fork testing:
```bash
curl -sL https://run.surfpool.run/ | bash
```

### Phase 1 — local-fork pre-flight (recommended)

Validates the deploy will succeed against real chain state before
spending real funds. Catches funding shortfalls, RPC quirks, gas
estimation issues.

**EVM local fork** (auto-detects target chain from running node's `eth_chainId`):

```bash
cd EVM

# Terminal 1 — fork target chain (default: sepolia)
FORK_NETWORK=base hh node            # =sepolia, =opSepolia, =mainnet, =optimism, =arbitrum, =base, =bsc

# Terminal 2 — deploy + integration test against the fork
hh run scripts/deploy/index.ts --network localhost
hh run scripts/test/test-onchain.ts --network localhost
```

Deploys MockUSDC, OkuM, USDOku, LitePSM; configures roles and the minter
allowance (LitePSM holds `OKUM_MINTER` / `OKUM_BURNER`); points OkuM's conversion
gate at the PSM; verifies deployment state.

The PSM deploys with **both conversion windows closed** so the first rate segment
can be published before anyone can trade against the default 1.0 multiplier.
Fork-deployed addresses land under `addresses.json["fork:<chain>"]`
so they never collide with live entries.

**SVM local fork (Surfpool):**

```bash
cd SVM/oku-programs
surfpool start --rpc-url https://api.devnet.solana.com   # terminal 1
# Two-phase deploy against the surfpool fork (terminal 2):
NETWORK=devnet-fork npm run deploy:programs:devnet-fork
NETWORK=devnet-fork npm run deploy:init:devnet-fork
NETWORK=devnet-fork npm run test:onchain:fork
```

### Phase 2 — live deploy

**EVM:**

```bash
cd EVM

# Per-network shortcuts (defined in package.json):
npm run deploy:sepolia        # Eth Sepolia
npm run deploy:opSepolia      # OP Sepolia
npm run deploy:baseSepolia    # Base Sepolia
npm run deploy:bscTestnet     # BSC testnet (Chapel)
npm run deploy:base           # Base mainnet
npm run deploy:bsc            # BSC mainnet

# Chains without a pre-baked alias:
hh run scripts/deploy/index.ts --network <chain>
```

The script is **idempotent and resumable**: already-deployed
contracts are reused via the `tryAttach` bytecode check; transient
RPC errors are absorbed by `withRetry` (exponential backoff, up to
5 attempts). Partial-deploy failures: just rerun.

Addresses written to `EVM/scripts/config/addresses.json` under
`"<chain>"` and to repo-root `testnet-addresses.json` under
`"evm.<chain>"`.

**SVM:**

```bash
cd SVM/oku-programs

anchor build
npm run cost                  # estimate one-time rent (program + PsmConfig + mint + ATAs)
solana airdrop 5 --url devnet # x2

# Phase 1 — deploy program .so files (writes IDs into deployments/devnet.json)
NETWORK=devnet npm run deploy:programs

# Phase 2 — create OkuM mint + initialize PSM config
NETWORK=devnet npm run deploy:init
```

`deploy:programs` prints the freshly-deployed program IDs and the
exact lines to paste into `[programs.devnet]` (or `[programs.mainnet]`).
`[programs.devnet]` and `[programs.localnet]` are kept SEPARATE on
purpose — preserves the option to rotate one cluster without
touching the other. Until `Anchor.toml` matches, the
`[addressBook] WARNING:` block fires on every admin script.

**Stale `deployments/devnet.json` recovery:** if program IDs in the
file no longer match `Anchor.toml`, rent-reclaim old programs
before redeploying:

```bash
NETWORK=devnet npm run admin:close-programs -- --dry-run   # plan
NETWORK=devnet npm run admin:close-programs                # execute
rm deployments/devnet.json
NETWORK=devnet npm run deploy:programs
NETWORK=devnet npm run deploy:init
```

By default this reads program IDs from `deployments/<network>.json::programs.*`,
verifies the deployer wallet is the upgrade authority, captures
rent, and runs `solana program close` with deployer as recipient.
Refuses IDs currently in `Anchor.toml [programs.<network>]` unless
`--allow-anchor-toml-ids` is passed AND
`target/deploy/<program>-keypair.json` is rotated afterwards.

### Phase 3 — verification smoke

**EVM:**

```bash
cd EVM
forge test                                    # the real suite: 104 tests, Foundry
NETWORK=sepolia npm run test:onchain:sepolia  # live round-trip against a testnet
```

There is no hardhat/mocha test suite (`npx hardhat test` compiles but finds
zero tests) — all EVM contract tests are Foundry (`test/*.t.sol`), per
[`EVM/README.md`](EVM/README.md).

**SVM:**

```bash
cd SVM/oku-programs
NETWORK=devnet npm run test:onchain           # ~30 s end-to-end smoke
NETWORK=devnet npm run test:onchain -- --step=redeem   # single step (mint/transfer/redeem/
                                                        # distributeYield/pause/setAuthority also available)
```

### Phase 4 — cross-chain bridge test (noBridge / PSM-mediated)

```
1. EVM source: LitePSM.redeemOkuM(amount) → orchestrator observes the OkuMRedeemed event + USDC outflow.
2. Destination (EVM or SVM): orchestrator deposits USDC into the destination PSM and calls LitePSM.mintOkuM, crediting OkuM to recipient.
3. Treasury periodically tops up PSM USDC buffers per chain (on SVM there is no queue to drain — see [`SVM/README.md`](SVM/README.md)).
```

EVM-side accounting for a bridge leg is covered indirectly by the ordinary
`LitePSM`/`OkuM` Foundry suites (`EVM/test/`) — there is no dedicated
cross-chain scenario harness on the EVM side. Full EVM↔SVM roundtrip bridge
test:

```bash
cd SVM/oku-programs
PRIVATE_KEY=<evm-key> tsx scripts/test/bridge-svm-evm.ts \
    --evm=baseSepolia --svm=devnet --amount=5 --direction=roundtrip
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Sender doesn't have enough funds` | Top up dev wallet on target chain. The pre-flight fork shows the *real* funding shortfall before you spend live ETH. |
| `nonce too low` / `replacement transaction underpriced` | RPC nonce-cache race. `withRetry` should absorb it; if persistent, switch RPC (`BASE_RPC_URL` / `BSC_RPC_URL`) or wait. |
| `BAD_DATA: invalid address (value="")` | BSC pending-tx quirk. `scripts/utils/rpcCompat.ts` normalises it preventatively. |
| `Chain ID mismatch: local node reports chainId X, but NETWORK=Y expects Z` | Restart `hh node` with `FORK_NETWORK=Y`, OR unset `NETWORK` so the script auto-detects. |

### Initial deploy parameters (testnet defaults)

**EVM (`EVM/scripts/deploy/index.ts`):**

| Parameter | Value | Notes |
|---|---|---|
| `maxSupply` | 1 B OkuM (1e27 raw) | 1 B token cap. |
| `minterAllowance` | 1 B OkuM | Matches `maxSupply` (effectively uncapped on testnet). **Production**: 1 % of weekly bridging volume, weekly rotation. |
| `minCollateralRatio` | 100 % (1e18) | Full backing at deploy; lowerable post-deploy. |

**SVM (`SVM/oku-programs/scripts/config/constants.ts`):**

| Parameter | Value | Notes |
|---|---|---|
| `MAX_SUPPLY` | 1 B OkuM (6 dec = 1e15 raw) | 1 B token cap. |
| `MINTER_ALLOWANCE` | 1 B OkuM | Matches EVM. **Production**: rotate weekly via `set-minter-allowance.ts`. |

### Mainnet ceremony

**EVM RBAC routing** — after live deploy, run `grantRolesMainnet.ts`:

```bash
MAINNET_COLD_MULTISIG=0x... MAINNET_WARM_MULTISIG=0x... MAINNET_ORCHESTRATOR=0x... \
  npx hardhat run scripts/operator/grantRolesMainnet.ts --network base --yes-mainnet
```

**SVM upgrade authority transfer** — after live deploy:

```bash
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

See `SVM/oku-programs/scripts/admin/set-upgrade-authority.ts`.

### Security notes

1. **Testnet uses deployer as orchestrator** for convenience. Production MUST use a separate KMS-backed orchestrator key.
2. **Never commit `.env` files** or private keys to git.
3. **RPC reliability** — Alchemy preferred for live runs; public RPCs can lag on nonce / mempool state.
4. **No on-chain bridge in v1.** Cross-chain replay/refund protection is the orchestrator's responsibility — the protocol surface is just PSM mint/burn.

### Chain ID reference

EVM chain IDs follow EIP-155. SVM chain identifiers (Ankr convention)
are protocol-internal — they appear only in deployment registry
metadata after the noBridge refactor.

| Network | EIP-155 / chain ID | Type |
|---|---|---|
| Solana Mainnet | 101 | Ankr convention |
| Solana Devnet | 103 | Ankr convention |
| Ethereum | 1 | EIP-155 |
| Optimism | 10 | EIP-155 |
| BSC | 56 | EIP-155 |
| Base | 8453 | EIP-155 |
| Arbitrum One | 42161 | EIP-155 |
| Eth Sepolia | 11155111 | EIP-155 |
| OP Sepolia | 11155420 | EIP-155 |
| Base Sepolia | 84532 | EIP-155 |
| BSC Testnet (Chapel) | 97 | EIP-155 |

---

## Pointers

- **EVM-specific docs:** [`EVM/README.md`](EVM/README.md) (incl. Accepted Risks)
- **SVM-specific docs:** [`SVM/README.md`](SVM/README.md) (incl. Accepted Risks)
- **Open issues:** [`TRACKER.md`](TRACKER.md)
- **Downstream SDK / backend consumption:** [`artifacts/README.md`](artifacts/README.md)
