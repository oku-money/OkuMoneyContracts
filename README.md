# OkuMoney Protocol

Yield-bearing stablecoin infrastructure backed by US Treasury Bills.
Centralized B2B product — registered MSB, not a DeFi protocol. EVM +
SVM in parallel, off-chain orchestrator coordinating both.

> **For reviewers:** start with the per-side READMEs ([`EVM/README.md`](EVM/README.md),
> [`SVM/README.md`](SVM/README.md)), each with an "Accepted Risks" section
> covering known design decisions. Open items live in [`TRACKER.md`](TRACKER.md).

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
  infrastructure responsibly. See
  [What is and isn't independently verifiable](#what-is-and-isnt-independently-verifiable)
  for exactly where that trust is load-bearing in the yield mechanism.
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

### EVM — two tokens, single shared multiplier

Two tokens, one price:

| Token | Type | Purpose |
|---|---|---|
| **OkuMoney (OkuM)** | Non-rebasing | DeFi, bridging, protocol integrations |
| **OkuDollar (usdOku)** | Rebasing ($1 peg) | Retail UX, "balance grows" experience |

**OkuMoney** is the solvency anchor and the sole source of yield.
`balanceOf()` returns a static raw token count; price appreciation is
tracked via `okuMMultiplier()`, computed continuously from a
streaming rate schedule (`setOkuMYieldRate` / `setNextOkuMYieldRate`)
rather than written in discrete ticks — see
[`EVM/README.md`](EVM/README.md) for the full rationale.

**OkuDollar** wraps OkuMoney 1:1 at that same multiplier — it has no
independent rate of its own; `usdMultiplier()` **is**
`okuMoney.okuMMultiplier()`. `balanceOf()` grows every second because
the shared multiplier does. Collateralization is exactly 1.0 by
construction (shares are only ever minted/burned 1:1 against real
OkuM at the same multiplier), so there is no spread to manage, no
surplus to extract, and no reserve top-up path — protocol margin
comes entirely from the off-chain spread between realized T-Bill
yield and the published on-chain rate.

### SVM — single-token model

A single token: **OkuM**, a Token-2022 mint
(`4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN`) with
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
│  │  OkuMoney      │◄┤  OkuDollar   │   │   LitePSM    │        │
│  │  (Non-Rebase)  │ │  (Rebasing)  │   │  (USDC ↔ OkuM│        │
│  │ okuMMultiplier │ │  Vault       │   │  price-aware) │        │
│  └────────────────┘ └──────────────┘   └──────────────┘        │
│                                                                  │
│  (Cross-chain transfers are orchestrator-mediated via PSM        │
│   mint/burn on each chain — no on-chain bridge in v1.)           │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Function |
|---|---|
| **OkuMoney** | Non-rebasing base token — static balance, price appreciates via stored `okuMMultiplier`. |
| **OkuDollar** | Rebasing $1-pegged stablecoin — balance grows, backed by OkuMoney reserves. |
| **LitePSM** | Peg Stability Module — price-aware USDC ↔ OkuM. Sole user-facing mint/burn surface. Ships `mintUsdOku` / `redeemUsdOku` convenience flows that route through the vault. |
| **RedemptionQueue** | FIFO queue when PSM buffer is insufficient. |

### SVM

```
┌─────────────────────────────────────────────────────────────────┐
│                     SVM On-Chain (lite-psm)                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐         │
│  │  lite-psm (4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5Tubu…) │         │
│  │  ─ mint_oku_m / redeem_oku_m (buffer-only)         │         │
│  │  ─ set_okum_yield_rate / _with_successor           │         │
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

**Both stacks now run the same model.** Yield streams continuously from
a per-second rate schedule, computed on read rather than written in
discrete ticks — so there is no step for an arbitrageur to sandwich,
and every chain returns the same multiplier at the same wall-clock
second without any messaging between them.

- **EVM:** `okuMMultiplier()` is computed continuously from a
  per-second rate schedule (`setOkuMYieldRate` /
  `setNextOkuMYieldRate` on OkuMoney) — there is no discrete step for
  an arbitrageur to sandwich. `setOkuMMultiplier` survives only as a
  pause-gated emergency override; it's the sole function that still
  stamps `lastYieldDistributionBlock`, and PSM/vault operations revert
  if executed in the same block as that override. OkuDollar has no
  multiplier of its own to update — `usdMultiplier()` reads OkuMoney's
  directly, so it inherits the same continuity and the same guard.
- **SVM:** identical model. `lite-psm` computes its multiplier from
  the same six-field rate schedule using a line-for-line port of
  `MathLib.sol`, at the same `PRECISION = 1e18`, so both stacks return
  bit-identical values from identical schedule state. As on EVM, only
  the emergency override (`set_okum_multiplier`) stamps
  `last_yield_distribution_slot`, and it also halts the schedule.
  Wallet display is the one thing that still steps: Token-2022's
  `ScaledUiAmount` extension cannot stream, so it is maintained as a
  lagging, permissionlessly-cranked mirror that is always at or below
  the canonical value — nothing prices against it.

### What is and isn't independently verifiable

The multiplier is derived off-chain and published on-chain. That split
means some of the protocol's economics are independently checkable by
anyone, and some rest on trusting Oku Money. The line is worth stating
plainly.

**Independently verifiable on-chain, by anyone:**

- the published per-second rate and its window (`okuMRatePerSecond()`,
  `okuMRateEnd()`, and the SVM `PsmConfig` equivalents)
- the resulting multiplier at any timestamp — it is a pure function of
  that schedule, so it can be recomputed and checked
- total supply, and therefore the total dollar value of OkuM on each chain
- that the multiplier only ever increases, and that every yielding rate
  carries a bounded window

**Not verifiable on-chain — trusted:**

- **realised yield** for an epoch: what the RWA backing actually earned
- **V̄**, the time-weighted average global value the rate is divided by
- the **carry balance**: yield earned but not yet published, carried
  forward to a later epoch

These three are the *inputs* to the rate derivation. Anyone can confirm
the published rate is internally consistent and that the multiplier
follows from it; nobody outside Oku Money can confirm the rate was the
*right* one for the yield actually earned.

**The decision, and the trade.** These records are kept as a signed,
versioned, append-only off-chain ledger. We considered anchoring a hash
of each epoch's derivation on-chain, which would make the record
tamper-evident and let a third party verify our arithmetic without
trusting us. We chose not to.

The reasoning is the same one behind the rest of the architecture: this
is an openly centralized product. Users already trust Oku Money to
custody and manage the RWA backing itself — a far larger trust
assumption than trusting the yield arithmetic derived from it. An
on-chain anchor would not remove that dependency; it would harden a
small link in a chain whose binding constraint is elsewhere, while
adding a contract to deploy, audit and maintain.

**What we give up:** the ledger is tamper-evident only to whoever holds
the signing key and can see the signatures. Nobody can prove, from
public data alone, that a past epoch's carry balance was not restated.
Auditors and counterparties verify it by inspecting the signed ledger
directly, the same way they would verify any other book.

**When we would revisit this:** if third-party verifiability of rate
derivation becomes a product requirement — a partner, regulator or
listing that wants to check our arithmetic without a trust relationship.
The change is additive and needs no modification to any deployed
contract: a standalone attestation contract, one hash per epoch. See
`SVM/DECISIONS.md` D-26.

Separately, and regardless of that choice: because the carry ledger and
V̄ history have no on-chain representation, **losing them means the
cumulative-conservation identity cannot be reconstructed.** They are
protocol state that happens to live off-chain, and must be backed up and
replicated as such — not treated as operational logs.

---

## PSM (Peg Stability Module)

### EVM — price-aware USDC ↔ OkuMoney swaps

```
mintOkuM:      okuMAmount = usdcValue × PRECISION / okuMMultiplier()
redeemOkuM:    usdcAmount = okuMAmount × okuMMultiplier() / PRECISION
```

LitePSM ships convenience functions that route through the vault for
single-transaction usdOku ↔ USDC:

```
mintUsdOku:    USDC → PSM mints OkuM → wraps into vault → usdOku to user
redeemUsdOku:  usdOku → unwrap to OkuM → redeem for USDC (or queue if buffer empty)
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
  EVM (orchestrator supplies USDC). If the user wants usdOku on EVM,
  the convenience `mintUsdOku` flow wraps through the vault.

Tested by `EVM/test/hardhat/scenarios/RealWorldUsage.ts`
(cross-chain bridge scenarios) and
`SVM/oku-programs/tests/bankrun/crossChainBridging.ts`.

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
| Destination supply headroom | `OkuMoney.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuMoney.minterAllowance(psm) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user token balance | `OkuMoney.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMAta).amount >= bridge_amount` |
| Source buffer for instant path | `usdc.balanceOf(psm) > expectedUsdcOut` | `getAccount(vaultUsdc).amount > expected_usdc_out` (EVM↔SVM only; SVM↔SVM uses direct burn/mint) |
| Recipient ATA not frozen | `OkuMoney.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |

If the EVM source PSM buffer is insufficient, the redeem succeeds but
the OkuM is escrowed in EVM's redemption queue. **The orchestrator
must wait for `processQueue` to pay out USDC before completing the
destination mint leg.** Poll queue state to detect (EVM only — SVM
has no redemption queue, see below):

```
EVM:  queue.queueHead() < queue.queueTail()  → entries pending
```

The orchestrator can accelerate payment by calling `depositBuffer`
to fund the queue, then `processQueue`.

> **Note:** SVM has no redemption queue at all (deliberately removed
> — see [`SVM/README.md` § Why no redemption queue](SVM/README.md)).
> `redeem_oku_m` on SVM is buffer-only: it reverts with
> `InsufficientBuffer` if the vault can't cover it — there is nothing
> to drain or poll. SVM-to-SVM bridges additionally bypass the USDC
> buffer entirely, using direct `burn_oku_m_direct` /
> `mint_oku_m_direct` to conserve raw OkuM amounts 1:1.

#### Mid-flight failure recovery

| Failure mode | Recovery |
|---|---|
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap), wait for the blocking condition to clear, retry `mintOkuM` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain OkuM is already burned. |
| Source redeem was queued | Don't mint on destination until USDC is in hand. Poll queue state every ~30 s; call `depositBuffer` + `processQueue` to accelerate. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Schedule broadcast across chains

The multiplier is no longer "ticked" anywhere. `OKUM_REBASER`
publishes a per-second rate and a bounded window, and every chain
computes the same multiplier from it. The operational rules follow
from that:

1. Broadcast **byte-identical integers** to every chain — EVM and SVM.
   Derive the rate once and reuse it; never hand-enter it twice. This
   is the only real failure mode left, and nothing on-chain can detect
   it — `scripts/operator/checkMultiplierDrift.ts` (which covers SVM
   too) is the detection layer.
2. **The broadcast is not time-critical.** A pre-staged successor
   activates off an absolute timestamp with no transaction, so staging
   may land on different chains hours or days apart and the handover is
   still simultaneous to the second.
3. If a broadcast is **missed entirely**, that chain's accrual HALTS at
   `rateEnd` rather than diverging. Safe and recoverable — but silent,
   so monitor for it (`admin:read-schedule` on SVM exits non-zero when
   halted).
4. Divergence is **one-way**: the multiplier is monotonic, so a chain
   that ran hot cannot be corrected downward. The only remedy is to run
   the laggards hot until they catch up.
5. The "wait one slot/block after a price tick before bridging" rule is
   **retired** — there is no tick. It applies only around the emergency
   override, which still stamps the sandwich lock.

#### Minter allowance rotation policy

`minterAllowance` on `OkuMoney` (EVM) and `PsmConfig.minterAllowance`
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
- **EVM roles:** `OKUM_REBASER` (governs both OkuM and UsdOku — the
  vault has no rate of its own), `PSM_QUEUE_PROCESSOR`,
  `PSM_BUFFER_DEPOSITOR`.
- **SVM roles:** `rebaser`, `buffer_depositor`, `direct_minter`,
  `direct_burner`. (No queue-processor equivalent on SVM — no
  redemption queue.)
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
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, VAULT_RESCUER | role_admin, unpauser, cap_manager, allowance_manager, buffer_withdrawer |
| Warm Multisig | all PAUSER, all BLACKLISTER | pauser, freezer |
| Orchestrator | OKUM_REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR | rebaser, buffer_depositor, direct_minter, direct_burner |
| LitePSM | OKUM_MINTER, OKUM_BURNER (cycle 4: split on EVM) | Mint authority on OkuM Token-2022 mint |
| RedemptionQueue | OKUM_BURNER (cycle 4) | no SVM equivalent — redemption queue removed entirely, buffer-only PSM |

The `BRIDGE_*`, `ROUTER_*`, and `NTT_*` roles defined in
`EVM/src/lib/Roles.sol` are reserved for future re-introduction of
OkuBridge / NTT / CCIP — not granted by v1 deploy scripts.

**Devnet/testnet delegation.** The table above is the mainnet target
model. On devnet/testnet it's common to delegate operational roles
to a coworker- or CI-owned key while governance/safety roles and
`role_admin` / `DEFAULT_ADMIN_ROLE` stay with the deployer/owner:

- **SVM:** `direct_minter`, `direct_burner`, `rebaser`, `buffer_depositor`
  → see [`SVM/README.md § Delegated operation vs. retained
  ownership`](SVM/README.md) for the full rationale and the
  `scripts/admin/grant-roles.ts --delegate=<pubkey>` tool that implements
  it.
- **EVM:** `OKUM_REBASER`, `OKUM_MINTER`, `OKUM_BURNER` (OkuMoney),
  `PSM_BUFFER_DEPOSITOR`, `PSM_QUEUE_PROCESSOR` (LitePSM), plus a
  matching `configureMinterAllowance` grant so the mint role is actually
  usable → `EVM/scripts/operator/grantRoles.ts` (targets `MASTER_EOA`).
  **This mint/burn grant is a deliberate testnet-only divergence** from
  the mainnet threat model below ("orchestrator key has no special
  minting authority on EVM") — SVM's direct-mint/burn roles exist
  because SVM has no redemption queue and must mint/burn directly; EVM's
  production bridge legs are USDC-collateral-mediated instead and don't
  need it. `grantRoles.ts` refuses to run against a mainnet network for
  this reason — see its NatSpec header for the full rationale. Both
  tools are idempotent (safe to re-run) and support `DRY_RUN`.

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
- Rescue OkuMoney donated directly to the EVM vault (`rescueDonation`)
  — cannot touch OkuM backing outstanding shares; there is no
  "surplus" beyond accidental donations under the single-multiplier
  design (collateralization is exactly 1.0 by construction).
- Grant any role to any address (DEFAULT_ADMIN_ROLE / role_admin SVM).
- Unblacklist, unpause, unfreeze ATAs.
- Rotate operational authority pubkeys.

**Cannot (on-chain code prevents even at quorum):**
- Mint above `maxSupply` or `minterAllowance`.
- Set `okuMMultiplier` (EVM) / `multiplier` (SVM) below current (monotonic).
- Set a yield rate outside `[PRECISION, MAX_RATE]` (EVM).
- Set `maxSupply` below current `totalSupply`.
- Rescue any OkuM below `totalUsdShares` (EVM `rescueDonation`).

#### Warm Multisig (lower-quorum, faster to sign)

**Can:**
- Pause all protocol contracts, halting mint / redeem / bridging.
- Blacklist any address on OkuMoney and OkuDollar (EVM).
- On SVM: freeze any OkuM ATA via Token-2022 freeze authority.

**Cannot:**
- Unpause or unblacklist (cold multisig only). Pause is a one-way
  door for the warm key.
- Access any funds or parameters.

#### Orchestrator (KMS-backed, automated)

**Can:**
- Update the OkuM yield-rate schedule (EVM: `setOkuMYieldRate` /
  `setNextOkuMYieldRate`, bounded by `[PRECISION, MAX_RATE]`) or the
  multiplier directly (SVM: `set_multiplier`, non-decreasing, bounded
  by `MAX_MULTIPLIER`). A compromised rebaser key can ratchet the
  multiplier toward the ceiling, inflating token dollar value beyond
  the actual T-Bill backing rate. On EVM this single schedule governs
  **both** OkuM and UsdOku, since UsdOku has no rate of its own.
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
  RedemptionQueue contracts.
- Access admin parameters, role grants, upgrades.
- Drain the USDC buffer (cold-multisig BUFFER_WITHDRAWER only).

#### Protocol contracts (LitePSM, RedemptionQueue)

**EVM:** Hold `OKUM_MINTER` / `OKUM_BURNER`. Mint via
`OkuMoney.mint()` only during `mintOkuM` / `processQueue`, gated by
per-minter `minterAllowance` and the global `maxSupply` cap. Burn
(cycle-4 split role) only via `OkuMoney.burn()` from inside
`redeemOkuM` / `processQueue`.

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
| Token model | Dual-token: OkuMoney (non-rebasing) + OkuDollar (rebasing) | Single-token: OkuM with ScaledUiAmount extension (displays as usdOku) |
| Multiplier | Stored `uint256`, 18 decimals (`okuMMultiplier`) + continuous `_rpow` for OkuDollar | Multiplier on mint extension (ScaledUiAmountConfig), 1e9 precision, 6-decimal token |
| OkuDollar multiplier | Continuous `_rpow` streaming | N/A — single-token model; multiplier serves as both pricing and UI display |
| Yield lock | `block.number` comparison | `Clock::slot` comparison |
| Token standard | ERC-20 (custom rebasing for OkuDollar) | Token-2022 (OkuM with ScaledUiAmount + MetadataPointer + TokenMetadata) |
| Decimals | 18 | 6 |
| Proxy pattern | TransparentUpgradeable / UUPS | Solana program upgrades (Squads authority) |
| Convenience functions | On LitePSM contract | Direct OkuM mint/redeem on the PSM; no wrapping needed |
| Redemption when buffer insufficient | Escrowed in `RedemptionQueue`, drained via `processQueue` | Reverts `InsufficientBuffer` — no queue (deliberately removed) |
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
│   │   ├── token/       # OkuMoney.sol, OkuDollar.sol
│   │   ├── psm/         # LitePSM.sol, RedemptionQueue.sol
│   │   ├── interfaces/  # IOkuMoney.sol, IOkuDollar.sol, IOkuBridgeNative.sol (reserved)
│   │   └── lib/         # Roles, Constants, MathLib, events
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
> (tracked, live `<chain>` keys only). Local-fork runs write `fork:<chain>`
> entries to the gitignored `EVM/scripts/config/addresses.local.json`, so
> ephemeral fork addresses never dirty the tracked file.

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

Deploys MockUSDC, OkuMoney, OkuDollar, RedemptionQueue, LitePSM;
configures all roles + minter allowances (LitePSM + RedemptionQueue
hold `OKUM_MINTER` / `OKUM_BURNER`); verifies deployment state.
Fork-deployed addresses land under `fork:<chain>` in the gitignored
`addresses.local.json`, so they never collide with live entries or
dirty the tracked address book.

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
npx hardhat test                              # in-process happy-path
NETWORK=sepolia npm run test:onchain:sepolia  # live round-trip + balance check
                                               # (baseSepolia/arbSepolia/bscTestnet variants also available;
                                               # `npm run test:onchain` alone runs against a FORK, not live —
                                               # despite the name, it targets `--network localhost`)
```

**SVM:**

```bash
cd SVM/oku-programs
NETWORK=devnet npm run test:onchain           # ~30 s end-to-end smoke
NETWORK=devnet npm run test:onchain -- --step=redeem   # single step (mint/transfer/redeem/
                                                        # streamingAccrual/pause/setAuthority also available —
                                                        # `distributeYield` was removed with the discrete-yield model)
```

### Phase 4 — cross-chain bridge test (noBridge / PSM-mediated)

```
1. EVM source: LitePSM.redeemOkuM(amount) → orchestrator observes the OkuMRedeemed event + USDC outflow.
2. Destination (EVM or SVM): orchestrator deposits USDC into the destination PSM and calls LitePSM.mintOkuM, crediting OkuM to recipient.
3. Treasury periodically tops up PSM USDC buffers per chain (on SVM there is no queue to drain — see [`SVM/README.md`](SVM/README.md)).
```

EVM cross-chain accounting covered by
`EVM/test/hardhat/scenarios/RealWorldUsage.ts`. Full EVM↔SVM
roundtrip bridge test:

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
