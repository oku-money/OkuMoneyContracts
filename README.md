# OkuMoney Protocol

Yield-bearing stablecoin infrastructure backed by US Treasury Bills.
Centralized B2B product — registered MSB, not a DeFi protocol. EVM +
SVM in parallel, off-chain orchestrator coordinating both.

> **For reviewers:** start with the per-side READMEs ([`EVM/README.md`](EVM/README.md),
> [`SVM/README.md`](SVM/README.md)), each with an "Accepted Risks" section
> covering known design decisions, and [`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md) for
> admin powers. Non-obvious invariants: [§ Cross-stack invariants](#cross-stack-invariants).
> Open work is tracked internally (Linear), not in this repo.

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


---

## Token model

One dollar-value-per-token **multiplier** (`m`) prices the whole
protocol on every chain. It is *computed*, never stored: a pure
function of a published per-second rate schedule and the current
timestamp, so every chain returns the same value at the same
chain timestamp with no messaging between them. A chain's timestamp normally
tracks wall clock; the exceptions (an L2 after a sequencer outage, SVM's
`Clock`) are handled operationally: § L2 sequencer outage. Protocol margin
comes entirely from the off-chain spread between realized T-Bill
yield and the rate published on-chain.

The two stacks express that one multiplier differently:

| | EVM | SVM |
|---|---|---|
| Tokens | **OkuMoney (OkuM)**, non-rebasing + **OkuDollar (usdOku)**, rebasing $1-peg wrapper | **OkuM** only — a Token-2022 mint |
| Where `m` lives | Computed by `OkuMoney.okuMMultiplier()`; `OkuDollar.usdMultiplier()` returns it verbatim | Computed by `lite-psm` from the `PsmConfig` rate schedule |
| Wallet display | usdOku's `balanceOf()` grows every second | `ScaledUiAmount` mint extension, a lagging display mirror of `m` |
| Mechanics | [`EVM/README.md` § Dual-Token Shared-Multiplier Model](EVM/README.md#dual-token-shared-multiplier-model) | [`SVM/README.md` § Why a single token on SVM](SVM/README.md#why-a-single-token-on-svm) |

Because OkuDollar has no rate of its own, OkuM and usdOku necessarily
earn identical yield and collateralization is exactly 1.0 by
construction. On SVM there is no wrapper token at all — "usdOku" is a
presentation-layer label for the scaled display of the single OkuM
mint. (Program and mint addresses:
[`SVM/oku-programs/deployments/devnet.json`](SVM/oku-programs/deployments/devnet.json),
`tokens.okuM` and `programs.litePsm`.)

---

## On-chain components

```
            EVM (per chain)                       SVM
 ┌──────────────────────────────────┐   ┌──────────────────────────────┐
 │ OkuMoney ──► OkuDollar (vault)   │   │ lite-psm  (one program)      │
 │  (non-rebasing)  (rebasing $1)   │   │  mint_oku_m / redeem_oku_m   │
 │        ▲             ▲           │   │  set_okum_yield_rate[_*]     │
 │        └── LitePSM ──┘           │   │  *_oku_m_direct  · freeze    │
 │                                  │   └──────────────┬───────────────┘
 │                                  │                  ▼
 │                                  │   ┌──────────────────────────────┐
 │  m = OkuMoney.okuMMultiplier()   │   │ OkuM — Token-2022 mint       │
 │      computed from the schedule  │   │  ScaledUiAmount (display     │
 └──────────────────────────────────┘   │  mirror) + MetadataPointer   │
                                        │  + TokenMetadata             │
   No on-chain bridge on either side.   │ m computed from PsmConfig    │
   Transfers are orchestrator-mediated. └──────────────────────────────┘
```

| Component | Stack | Function |
|---|---|---|
| **OkuMoney** | EVM | Non-rebasing base token. Static balances; `okuMMultiplier()` is **computed**, not stored. The solvency anchor and sole source of yield. |
| **OkuDollar** | EVM | Rebasing $1-pegged stablecoin wrapping OkuMoney 1:1 at the same multiplier. No rate state of its own. |
| **LitePSM** | EVM | Peg Stability Module — multiplier-aware reserve (USDC or USDT) ↔ OkuM, plus `mintUsdOku` / `redeemUsdOku` flows that route through the vault. Sole user-facing mint/burn surface. |
| **lite-psm** | SVM | One program (ID: `declare_id!` in `programs/lite-psm/src/lib.rs`, `Anchor.toml`, `deployments/devnet.json` → `programs.litePsm`): PSM, the rate schedule, compliance (freeze/thaw), and direct mint/burn for bridging. Holds mint, freeze and ScaledUiAmount authority via PDA. PDA seed `psm_config`. |
| **OkuM mint** | SVM | Token-2022 mint (address: `deployments/<network>.json` → `tokens.okuM`), 6 decimals. Its `ScaledUiAmount` extension is a **write-only display mirror**, not the pricing source. |

Both stacks: `PRECISION = 1e18`, `MAX_MULTIPLIER = 1e24`, `MAX_RATE = PRECISION + 1e11`.

---

## Yield distribution & sandwich prevention

**Both stacks run the same model.** Yield streams continuously from a
per-second rate schedule, computed on read rather than written in
discrete ticks — so there is no step for an arbitrageur to sandwich,
and every chain returns the same multiplier at the same chain
timestamp without any messaging between them. SVM's `oku-shared/src/rate.rs`
is a line-for-line port of EVM's `MathLib.sol` at the same
`PRECISION = 1e18`, so identical schedule state yields bit-identical
multipliers across the fleet.

On both stacks the emergency override (`setOkuMMultiplier` /
`set_okum_multiplier`) is the sole remaining discrete jump, and
therefore the sole function that stamps the sandwich lock
(`lastOverrideBlock` / `last_override_slot`).

Mechanics: [`EVM/README.md` § Streaming Accrual & Cross-Chain
Determinism](EVM/README.md#streaming-accrual--cross-chain-determinism)
and [`SVM/README.md` § Yield (streaming rate schedule)](SVM/README.md).
The derivation of the published rate from realized off-chain yield —
epochs, carry ledger, base+settlement split — lives in
[`EVM/docs/epoch-accounting.md`](EVM/docs/epoch-accounting.md).

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

**Decision: no on-chain anchor.** Epoch derivations are recorded in a signed,
versioned, append-only off-chain ledger (this repo ships only a reference
implementation — local JSON files, see
[`EVM/docs/epoch-accounting.md` § Reference implementation status](EVM/docs/epoch-accounting.md#reference-implementation-status);
the signed store is the backend's). Anchoring a hash per epoch on-chain would prove the
file was not edited afterwards, not that its inputs were honest, and users
already trust Oku Money with the far larger custody of the RWA backing itself.

**What this gives up:** nobody can prove from public data alone that a past
carry balance was not restated; auditors and counterparties inspect the signed
ledger directly. If third-party verifiability becomes a product requirement,
a standalone attestation contract (one hash per epoch) is additive and needs no
change to any deployed contract.

Because the carry ledger and V̄ history have no on-chain representation,
**losing them means the cumulative-conservation identity cannot be
reconstructed.** They are protocol state that lives off-chain and must be
backed up and replicated as such, not treated as operational logs.

---

## PSM (Peg Stability Module)

**Reserve.** Each PSM holds exactly one reserve token, fixed at init: USDC or USDT
on EVM (USDC expected in most deployments), USDC only on SVM. There is no
multi-reserve PSM. Code identifiers keep the `usdc` name (`usdc()`,
`withdrawUsdc`, `usdcDecimalMultiplier`, `vault_usdc`); read them as "the
configured reserve". EVM mints and buffer deposits credit the reserve balance
the PSM actually received, so a fee-on-transfer reserve cannot under-back them.

Both stacks price reserve ↔ OkuM off the same multiplier and round the
same direction (floor, favouring the protocol):

```
mint:    okuMAmount = usdcValue × PRECISION / m
redeem:  usdcAmount = okuMAmount × m / PRECISION
```

Redemptions are paid from the PSM's reserve buffer on both stacks. A redeem the
buffer cannot cover reverts `InsufficientBuffer` (nothing is burned). A mint whose
output rounds to zero reverts `AmountTooSmall`; so does a zero-output redeem on EVM,
which SVM cannot produce (multiplier ≥ 1 and OkuM / USDC share 6 decimals).

**Buffer controls (identical on both stacks).** `depositBuffer` /
`deposit_buffer` (depositor role) and `withdrawUsdc` / `withdraw_buffer`
(withdrawer role) are both **pause-gated and blocked while the emergency
override's sandwich lock is active** (`whenNotPaused` + `whenNoOverrideThisBlock`
on EVM; `Paused` / `OverrideInProgress` on SVM). Withdrawal has **no solvency
check** — see `AUTHORITY-MATRIX.md` §3-B. Consequence for incidents: while a
PSM is paused its buffer can be neither refilled nor drained, so the cold
unpauser must unpause before any top-up. Redeems are paused too, so nothing is
lost in the interim.

Per-stack detail: [`EVM/README.md` § LitePSM.sol](EVM/README.md#litepsmsol)
(incl. the `mintUsdOku` / `redeemUsdOku` vault-routing convenience
flows) and [`SVM/README.md` § PSM](SVM/README.md#psm).

---

## Cross-stack invariants

Load-bearing and easy to break with a change that looks locally reasonable. Each is
listed because the reason is not visible from the code alone.

1. **The multiplier is monotonically non-decreasing, and that is the only reason the
   PSM needs no slippage parameter.** Redeem output increases with the multiplier, so
   delay and front-running can only pay the caller more. This depends on the PSM
   charging no fee: if that ever changes, min-out parameters must land in the same
   change. A reserve issuer's transfer fee is not a PSM fee (EVM Accepted Risk #14).
   Detail: the `LitePSM` NatSpec header and EVM Accepted Risk #13.
2. **Rate windows are bounded at 90 days on both stacks, and the two constants must
   agree** (`Constants.MAX_RATE_WINDOW` / `MAX_RATE_WINDOW_SECONDS`). At `MAX_RATE`,
   `rpow` overflows after about 15 years on SVM (`u128`) and about 30 on EVM, and once
   `okuMMultiplier()` reverts every recovery path reverts with it, including the
   emergency override, which re-anchors through the same read; the only exit is an
   upgrade. A divergence between stacks means one chain accepts a schedule the other
   rejects. Long-horizon fixtures must chain 90-day re-anchors, not open one long
   window.
3. **SVM's display multiplier never exceeds the canonical one, by exact cancellation
   rather than margin.** See [`SVM/README.md` § Development notes](SVM/README.md#development-notes).

---

## Cross-chain transfers (v1: off-chain orchestrated)

No on-chain bridging in v1. Every transfer is the orchestrator
performing a burn on the source chain and an equivalent mint on the
destination, with **different mechanics per stack**:

| Route | Source leg | Destination leg | Conserves |
|---|---|---|---|
| EVM ↔ EVM | `LitePSM.redeemOkuM` (user) → USDC out | orchestrator funds `LitePSM.mintOkuM` with that USDC | USDC, to ≤ 1 USDC-unit per bridge |
| SVM ↔ SVM | `burn_oku_m_direct` | `mint_oku_m_direct` | **raw OkuM, exactly 1:1** — no USDC intermediary, no multiplier rounding |
| EVM → SVM | `redeemOkuM` → USDC | `mint_oku_m` (USDC-funded) | USDC |
| SVM → EVM | `burn_oku_m_direct` | `mintOkuM` (orchestrator supplies USDC); `mintUsdOku` instead if the user wants usdOku | USDC |

"USDC" in the table is the source and destination PSM's reserve. When the two
reserves differ (a USDT-reserve EVM chain and a USDC chain), the orchestrator
converts between them off-chain between the legs; that conversion, and any
spread on it, is outside the contracts.

**`mintOkuM` / `mint_oku_m` are permissionless.** Any address with the reserve
can call them; the orchestrator holds no privileged PSM mint authority
on either stack. Orchestrator key compromise grants no mint privilege
beyond its own reserve custody — and, on SVM, beyond
`direct_minter_allowance`.

**Cross-chain conservation invariant (reserve-mediated routes, same reserve
on both legs).** Stated in DOLLAR VALUE, not reserve units. A reserve-denominated
drift is structurally zero and therefore unfalsifiable: with a fee-free reserve
`LitePSM.mintOkuM(x)` credits exactly `x`, so the amount redeemed on the source
and the amount supplied on the destination are the same number by construction.
A transfer fee (or a cross-reserve conversion) is a loss outside the bound below. Value is what can actually move, through two
independent floors:

```
dollars_received_B ≤ dollars_redeemed_A              (a bridge never creates value)
dollars_redeemed_A - dollars_received_B < 1 USDC-unit + ceil(m_B / 1e18)
```

The upper bound is the accumulated truncation: up to one collateral unit from
`dollarsToUsdc`'s floor on the source, plus up to one OkuM wei from
`dollarsToOkuM`'s floor on the destination.

Tested by `EVM/test/hardhat/scenarios/RealWorldUsage.ts` (round-trip and
multiplier-divergence scenarios) and
`SVM/oku-programs/tests/bankrun/crossChainBridging.ts`.

### Future bridging

OkuBridge (proprietary burn-and-mint) and third-party rails (NTT,
CCIP) are planned post-launch and will be introduced as additive
components. **Neither stack keeps a reserved seam for them.** There
are no bridge role constants in `EVM/src/lib/Roles.sol`, no bridge
interfaces in `EVM/src/interfaces/`, and no reserved enum variants in
SVM's `roles.rs`. On either stack a future bridge ships as new code
granted mint authority — deploy the proxy/program, grant it
`OKUM_MINTER` (EVM) or wire it through PSM (SVM), configure its
allowance. No existing contract changes.

### Orchestrator runbook

The orchestrator coordinates every cross-chain bridge. This is the
canonical operating procedure for both stacks.

#### Pre-flight checklist (per bridge)

Verify on **both source and destination chains** before submitting:

| Check | EVM | SVM |
|---|---|---|
| Destination PSM not paused | `LitePSM.paused()` | `psm.account.psmConfig.fetch(...).isPaused` |
| Destination supply headroom | `OkuMoney.maxSupply() - totalSupply() >= mintAmount` | `psmConfig.maxSupply - totalSupply >= mint_amount` |
| Destination minter allowance | `OkuMoney.minterAllowance(psm) >= mintAmount` | `psmConfig.minterAllowance >= mint_amount` |
| Source user token balance | `OkuMoney.balanceOf(user) >= bridgeAmount` | `getAccount(userOkuMAta).amount >= bridge_amount` |
| Source buffer covers the redeem | `usdc.balanceOf(psm) >= expectedUsdcOut` | `getAccount(vaultUsdc).amount >= expected_usdc_out` (EVM↔SVM only; SVM↔SVM uses direct burn/mint) |
| Recipient ATA not frozen | `OkuMoney.isBlacklisted(recipient) == false` | `getAccount(recipientAta).state != AccountState::Frozen` |

A source redeem the buffer cannot cover reverts `InsufficientBuffer` with
nothing burned, so the bridge simply has not started: top up the buffer and
retry. SVM↔SVM bridges bypass the buffer (direct burn/mint).

#### Mid-flight failure recovery

| Failure mode | Recovery |
|---|---|
| Source redeem succeeded, destination mint failed | Diagnose the revert reason (pause / cap), wait for the blocking condition to clear, retry `mintOkuM` with the same USDC amount. If unrecoverable inside SLA, hold the destination USDC and file an incident — the user's source-chain OkuM is already burned. |
| Source redeem reverted `InsufficientBuffer` | Nothing moved. Top up the source buffer (unpause first if paused) and retry; don't mint on destination until USDC is in hand. |
| Orchestrator process crashes between legs | On restart, inspect orchestrator USDC + OkuM balances on both chains. Source USDC > expected float → leg-2 (dest mint) didn't run. Destination OkuM > 0 → leg-3 (forward to recipient) didn't run. All zero → verify on-chain event logs. **Orchestrator OkuM float must be zero between completed bridges**; non-zero for > 1 batch cycle indicates a stuck bridge. |

#### Schedule broadcast across chains

The multiplier is never "ticked". `OKUM_RATE_MANAGER`
publishes a per-second rate and a bounded window, and every chain
computes the same multiplier from it. The operational rules follow
from that:

1. Broadcast **byte-identical integers** to every chain — EVM and SVM.
   Derive the rate once (`EVM/scripts/operator/deriveEpochSchedule.ts`,
   which writes a versioned artifact) and fan it out from that artifact
   (`EVM/scripts/operator/broadcastSchedule.ts`, which drives every EVM
   chain plus SVM's `set-yield-rate.ts`). Never hand-enter a rate
   twice. This is the only real failure mode left, and nothing on-chain
   can detect it — `EVM/scripts/operator/checkMultiplierDrift.ts`
   (which covers SVM too) is the detection layer.
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
   the laggards hot until they catch up (see
   [Depeg longer than the armed window](#depeg-longer-than-the-armed-window)).
5. There is no price tick, so no "wait a slot/block before bridging" rule
   in normal operation. It applies only around the emergency override,
   which stamps the sandwich lock.

#### Depeg longer than the armed window

A rate write is a yielding write, and while paused the rate setters may only lower the
projected curve (`EnforcedPause` on EVM, `Paused` on SVM). Past the armed window
(`rateEnd`, then the successor's end; one to two days at 24-hour epochs) a paused chain
therefore **cannot restart yield**, and a depeg can outlast that (March 2023: about three
days). EVM honours OkuMoney's pause, SVM's single `is_paused` flag is the PSM's, so a
PSM-only pause halts SVM alone.

1. **Pause all three contracts (PSM, OkuMoney, vault) on every chain**, not just the PSM.
   Every chain then hits the same gate and halts at the same absolute `rateEnd`: no
   divergence. Pause is warm; unpause is cold.
2. **After the cold unpause, publish a fresh schedule** with the normal derive and
   `broadcastSchedule` flow. All chains are at the same multiplier, so the pre-state
   check passes. Chains stay paused for no longer than the cold key takes to sign.
3. **If the chains diverged anyway** (a PSM-only pause, a missed broadcast), follow
   [§ Chain lagging the fleet](#chain-lagging-the-fleet). The laggard cannot go through
   `broadcastSchedule`, which refuses a chain not at the artifact's pre-state.

#### Chain lagging the fleet

A chain whose multiplier is below the fleet's sells OkuM through its PSM below its
global value, and the buyer redeems the difference from the buffer (Cyfrin audit
finding #2). So **PSM minting on a lagging chain stays closed until it has caught
up.** No contract change is needed: a minter allowance of 0 fails every PSM mint
(`ExceedsAllowance` on EVM, `AllowanceExceeded` on SVM) while redeems, rate writes and
the multiplier override keep working, and on both stacks `configureMinterAllowance` /
`set_minter_allowance` works whether or not the PSM is paused. A configured 0 has a
limit of 0, so redemptions never revive it (§ Minter allowance rotation policy).

**Act before the lag, not after it.** A chain falls behind when its accrual stops
before the fleet's: a successor that was never armed, or a pause that outlasted its
window. Both are visible ahead of time. `checkMultiplierDrift` fails with
`LAG IMMINENT` when a chain stops accruing within `LAG_ALARM_HOURS` (default 6) while
the rest of the fleet keeps going, and with `LAGGING THE FLEET` once it has. Run it
on the monitoring cadence (§ Monitoring SLAs).

1. **On `LAG IMMINENT`, stage the missing successor** with the normal broadcast. If it
   cannot land before the chain's accrual stops, **pause that chain's PSM (warm key)
   before then**: EVM `LitePSM.pause()` (`PSM_PAUSER`; leave OkuMoney unpaused so its
   rate writes still work), SVM `pause` (`pauser`). No mint is then ever priced below
   the fleet. On `LAGGING THE FLEET` (the moment has passed), pause it immediately.
   An SVM chain paused through a depeg that outlasted its window is already paused.
2. **Zero its PSM minter allowance (cold allowance manager)**, recording the current
   value: EVM Safe `OkuMoney.configureMinterAllowance(<LitePSM>, 0)`; SVM Squads vault
   `set_minter_allowance(0)` (`admin:set-minter-allowance -- --amount=0`).
3. **Unpause the PSM (cold).** Redemptions resume; minting stays closed.
4. **Catch it up.** Read the leader's multiplier and `rateEnd` (`checkMultiplierDrift`,
   `admin:read-schedule`), then on the laggard:
   - SVM: `set-yield-rate.ts --mode=active --target-multiplier=<wad> --end=<leader rateEnd>`
   - EVM: `TARGET_MULTIPLIER=<wad> END_TIMESTAMP=<leader rateEnd> npx hardhat run
     scripts/operator/setOkuMYieldRate.ts --network <chain>`

   Both derive the minimal rate (`catchUpRate` in `packages/yield-tooling`) that lands the
   laggard on the leader's multiplier at `rateEnd`. The write clears any successor, so
   then stage the leader's successor on the laggard (EVM `STAGE=true` with
   `setOkuMYieldRate.ts`, SVM `set-yield-rate.ts --mode=successor`)
   so the same successor takes over everywhere at `rateEnd`. `planCatchUp` computes target
   and rate from two schedules. A transaction landing late leaves the chain marginally
   under target, never over. Expect `checkMultiplierDrift` to report a rate mismatch and
   multiplier spread on the laggard until `rateEnd`; that is the catch-up working, not a
   fault. A gap that needs more than `MAX_RATE` (about 2242% APY) over the window must be
   closed over several windows.
5. **Reopen minting (cold allowance manager)** with the recorded allowance, or the
   policy value, only once the laggard has reached the leader: past the leader's
   `rateEnd`, `checkMultiplierDrift` passes, with identical rate, `rateEnd`, successor
   and successor end on both, and the multipliers equal at the same timestamp up to
   rounding dust. If a late transaction left it short, run another catch-up window
   first. Skip the weekly rotation on that chain until then.

While a chain's PSM minting is closed, bridges whose destination leg is that PSM's
mint stall (the pre-flight checklist's allowance check catches it); redemptions and
the source legs keep working.

#### L2 sequencer outage

**Affected chains:** Arbitrum One, OP Mainnet and Base (any rollup deployment).
Ethereum and BSC are L1s and are not affected.

The multiplier is priced at `block.timestamp`, and on a rollup that timestamp
can trail wall clock after a sequencer outage (Cyfrin audit finding #3):

- **Arbitrum:** a message force-included from the delayed inbox executes at the
  later of the previous L2 timestamp and the L1 timestamp at which it entered the
  inbox, not at its inclusion time. Forced inclusion opens only after the
  force-inclusion delay (about one day), so the lag can exceed a day.
- **OP Mainnet / Base:** each block's timestamp is its parent's plus 2 seconds,
  so after the sequencer resumes the chain catches up to wall clock in 2-second
  steps (bounded by the ~12 h sequencing window), and a deposit forced through
  `OptimismPortal` during the outage executes at its L1 origin's time.

A `mintOkuM` / `mintUsdOku` that executes at a trailing timestamp buys at the old
multiplier, and a redeem after the clock catches up collects the rise over the lag
from the PSM buffer (about 134 USDC per 1,000,000 USDC per day of lag at 5 % APY).
The PSM is fee-free by design, so the defence is operational: **keep the PSM closed
while that chain's clock trails wall clock.** It needs no third-party
infrastructure: the protocol's own nodes and the rollup's L1 contracts are the only
inputs.

**Expected automated behaviour (production monitoring, per affected chain):**

1. **Detect.** Watch the chain's head from the protocol's own L2 nodes (more than
   one RPC). Raise the outage alarm when no new block has arrived for
   `SEQUENCER_STALL_SECONDS` (suggested 60 s), or when the latest
   `block.timestamp` trails wall clock by more than `CLOCK_LAG_TOLERANCE_SECONDS`
   (suggested 60 s). Also watch the rollup's L1 contracts for forced traffic aimed
   at the PSM: Arbitrum delayed-inbox messages and `SequencerInbox.forceInclusion`
   calls, OP Stack `OptimismPortal` `TransactionDeposited` events with
   `to = LitePSM`.
2. **Pause through the forced path, immediately.** A transaction sent to the
   stalled sequencer will not land, so the automated pauser submits
   `LitePSM.pause()` on L1: Arbitrum `Inbox.sendL2Message` carrying a signed L2
   transaction (then `SequencerInbox.forceInclusion` once the delay has passed,
   if the sequencer is still down); OP Stack `OptimismPortal.depositTransaction`
   with `to = LitePSM`, `data = pause()`. Forced messages execute in submission
   order, so every mint submitted after the pause fails, and the pause executes
   before the PSM can be used at a stale timestamp by anyone queued behind it.
   If the sequencer comes back first, the same pause goes through it.
3. **Hold.** Leave the PSM paused while the chain catches up. Do not unpause on
   sequencer recovery alone.
4. **Unpause (cold)** only once the latest `block.timestamp` is within
   `CLOCK_LAG_TOLERANCE_SECONDS` of wall clock and the backlog of forced messages
   has drained. Run `checkMultiplierDrift` first: the chain's schedule must still
   match the fleet's.

**The automated pauser.** Step 2 cannot wait for a multisig quorum, so each
affected chain grants `PSM_PAUSER` on `LitePSM` (only that role, only that
contract) to a dedicated automated key, alongside the warm multisig. It must be an
**EOA** with the same address on L1 and L2: a contract (e.g. a Safe) sending
through the Arbitrum inbox or `OptimismPortal` is address-aliased on L2 and would
not hold the role. Its blast radius is the warm tier's: denial of service only,
since unpausing needs the cold key. Fund it with L1 ETH for the forced
submission. Drill the full path (L1 submission, aliasing, execution order) on the
chain's testnet before launch.

**What remains (accepted).** A mint submitted through the forced path *before*
the pauser's message executes first and keeps the stale price. Exploiting it
needs an L2 sequencer outage and winning a race against an automated alarm in its
first seconds to minutes; the gain is bounded by the multiplier's rise over the
lag, the buffer, the minter allowance and the supply cap, and appears as a
redemption against the buffer. Removing it entirely would take a mint fee sized
for the worst-case rate over the worst-case lag, which ends the fee-free design
(`EVM/README.md` § Accepted Risks #13 and #15).

#### Minter allowance rotation policy

`minterAllowance` on `OkuMoney` (EVM) and `PsmConfig.minterAllowance`
(SVM) bounds the PSM's **net outstanding issuance** on each chain: every PSM
mint draws it down, and every PSM redeem (EVM `OkuMoney.burn`, SVM
`redeem_oku_m`) restores it by the amount burned, never above the value last
configured (`minterAllowanceLimit(psm)` on EVM, `PsmConfig.minter_allowance_limit`
on SVM). `configureMinterAllowance` / `set_minter_allowance` set both values.
A mint-and-redeem loop therefore returns the allowance it consumed and cannot
exhaust it (Cyfrin audit finding #1). The SVM direct-mint / direct-burn
allowances are separate and are **not** restored.

- **Production policy:** ~ **1 % of weekly bridging volume** of headroom for
  net outstanding PSM issuance, reviewed on a **weekly cadence** by
  `OKUM_ALLOWANCE_MANAGER` (cold multisig). It bounds how much OkuM a
  compromised PSM contract or orchestrator USDC custody can have outstanding
  at once. Because redemptions refill it, it is **not** a cap on gross mint
  volume per week: the gross-volume and buffer alerts below replace that
  circuit breaker, with a warm-key `pause()` as the response.
- **Setting 0 is still the off-switch:** a configured zero allowance has a
  zero limit, so redemptions never revive it.
- **After the upgrade that introduces the limit,** the limit reads 0 on every
  existing deployment. The live allowance is left untouched (never lowered),
  but redemptions restore nothing until the allowance manager re-runs the
  rotation command below once per chain. Make that call part of the upgrade
  runbook.
- **Testnet** defaults are effectively uncapped; they are set in the deploy scripts (see § Initial deploy parameters).

EVM rotation (env vars, not flags — see [`EVM/README.md` § Development notes](EVM/README.md#development-notes)):

```bash
NETWORK=base MINTER=<psm-address> ALLOWANCE=10000000000000000000000000 YES_MAINNET=1 \
  npx hardhat run scripts/operator/configureMinterAllowance.ts --network base
```

SVM rotation:

```bash
NETWORK=mainnet-beta tsx scripts/admin/set-minter-allowance.ts \
  --amount=10000000 --yes-i-mean-it-on-mainnet
```

Monitoring alerts: `minterAllowance < 10 %` of its limit (sustained net
issuance, not a single loop); gross PSM mint volume (sum of `OkuMMinted` /
`UsdOkuMinted` on EVM, `MintEvent` on SVM) above 2 × the expected rolling
24 h volume; or a limit of 0 on a live PSM (post-upgrade re-configure missed).

#### Monitoring SLAs

| Metric | Alert threshold | Notes |
|---|---|---|
| Orchestrator token float (EVM) | Non-zero OkuM for > 1 h between batch cycles | EVM bridges use PSM-mediated USDC flow |
| PSM buffer | < 2 × expected daily redemption volume | A depleted buffer reverts redeems with `InsufficientBuffer` on both stacks |
| Minter allowance | < 10 % of its configured limit | Tracks net outstanding PSM issuance; redemptions refill it |
| Gross PSM mint volume | Rolling 24 h mint volume > 2 × expected | Replaces the gross-volume circuit breaker the allowance no longer provides; respond with warm-key `pause()` |
| Pause state | PSM paused for > 15 min unexpectedly | Buffer top-ups are blocked while paused; unpause (cold) first |
| Lag alarm | `checkMultiplierDrift` reports `LAG IMMINENT` or `LAGGING THE FLEET` | `LAG_ALARM_HOURS` (default 6) before a chain stops accruing ahead of the fleet. Stage its successor, or pause its PSM (warm) before then: § Chain lagging the fleet |
| L2 sequencer / clock lag | No new L2 block for > 60 s, or `block.timestamp` > 60 s behind wall clock, on Arbitrum / OP / Base; or forced L1 traffic to `LitePSM` | Automated `LitePSM.pause()` through the forced path, then hold until caught up: § L2 sequencer outage |
| Minting left closed | PSM minter allowance 0 on a chain whose schedule and multiplier match the fleet | A finished catch-up or new chain whose minting was never reopened; destination bridge legs to it stall |

SVM bridges use direct `burn_oku_m_direct` / `mint_oku_m_direct` with no USDC
intermediary, so there is no float to monitor; watch the direct minter/burner
transaction success rate instead.

All metrics on a 1-min cadence, except the L2 sequencer check, which needs a
cadence well under its 60 s threshold. PagerDuty for "token float", "PSM buffer",
"Lag alarm" and "L2 sequencer / clock lag"; Slack warning for the rest.

#### Orchestrator security

- The orchestrator key has **no mint authority on EVM** (`OKUM_MINTER` is held
  by contracts); compromise cannot mint beyond the key's own USDC holdings.
- **EVM roles:** `OKUM_RATE_MANAGER` (governs both OkuM and UsdOku — the vault has no
  rate of its own), `PSM_BUFFER_DEPOSITOR`.
- **SVM roles:** `rate_manager`, `buffer_depositor`. `direct_minter` / `direct_burner`
  are assigned independently on mainnet (`MAINNET_DIRECT_MINTER` /
  `MAINNET_DIRECT_BURNER`, unset = disabled; `SVM/oku-programs/scripts/config/authorities.ts`).
  Whichever key holds them performs SVM bridge mint/burn and bears the
  `direct_minter_allowance` / `direct_burner_allowance` blast radius.
- Compromise allows multiplier manipulation — material but bounded by
  `MAX_RATE` / `MAX_MULTIPLIER` (`AUTHORITY-MATRIX.md` §3-A). It cannot withdraw
  the buffer: `*_BUFFER_WITHDRAWER` and every `*_UNPAUSER` are cold.
- On suspected compromise rotate the key immediately. The emergency lever is
  pausing **every** contract on every chain at once (warm multisig), coordinated
  by the backend: on EVM that means OkuMoney as well as LitePSM and OkuDollar,
  because the rate setters and `setOkuMMultiplier` honour OkuMoney's pause only.
  Pausing just the PSMs does not stop a compromised rate key.
- **No two concurrent orchestrator instances** may process the same bridge
  request; nonce / event-ID dedup is the orchestrator's responsibility.

---

## RBAC (role-based access control)

Roles are scoped to one action family each: separate roles for minting,
burning, pausing, unpausing, upgrading and so on, so one key's compromise
reaches only what its roles reach. The full list is `EVM/src/lib/Roles.sol`
and `SVM/oku-programs/programs/lite-psm/src/roles.rs`.

| Entity | EVM Roles | SVM Roles |
|---|---|---|
| Cold Multisig | DEFAULT_ADMIN_ROLE, all `*_UNPAUSER`, all `*_UNBLACKLISTER`, OKUM_CAP_MANAGER, OKUM_ALLOWANCE_MANAGER, all `*_UPGRADER`, PSM_BUFFER_WITHDRAWER, VAULT_RESCUER | role_admin, unpauser, unfreezer, cap_manager, allowance_manager, buffer_withdrawer |
| Warm Multisig | all `*_PAUSER`, all `*_BLACKLISTER` | pauser, freezer |
| Orchestrator | OKUM_RATE_MANAGER, PSM_BUFFER_DEPOSITOR | rate_manager, buffer_depositor |
| Automated L2 pauser (Arbitrum / OP / Base) | PSM_PAUSER on LitePSM only, an EOA (§ L2 sequencer outage) | — |
| Bridge backend | — | direct_minter, direct_burner (separate keys; may be unset) |
| LitePSM | OKUM_MINTER, OKUM_BURNER | Mint authority on OkuM Token-2022 mint |

`unfreezer` on SVM is the counterpart of EVM's `OKUM_UNBLACKLISTER` and is cold
on both stacks. The automated L2 pauser is granted by the cold admin after the handover
on each rollup chain; it is not part of `grantRolesMainnet.ts`. The EVM mainnet split is encoded in
`EVM/scripts/operator/grantRolesMainnet.ts`; the SVM split in
`scripts/config/authorities.ts` (`MAINNET_*` env vars). Handover order:
§ Mainnet ceremony.

**Devnet/testnet delegation.** The table above is the mainnet target
model, implemented by `EVM/scripts/operator/grantRolesMainnet.ts` and (on
SVM) by `initialize` with the `MAINNET_*` authorities (`AUTHORITY-MATRIX.md`
§2, §5). On devnet/testnet both stacks instead delegate *operational* roles to a
coworker- or CI-owned key while governance/safety roles and
`role_admin` / `DEFAULT_ADMIN_ROLE` stay with the deployer/owner. This is
a **deliberate testnet-only divergence** from the threat model below, safe
only because testnet OkuM is backed by MockUSDC and has no value:

- **EVM** — `grantRoles.ts` gives one operator EOA everything needed to
  operate the protocol (its role list is in the script header) and leaves
  the deployer exactly two things: the ability to **upgrade**, and literal **ownership**
  (`DEFAULT_ADMIN_ROLE`, the role-admin for every granted role), which is
  what lets it revoke the lot unilaterally. Consequences stated plainly:
  holding `OKUM_MINTER` + `OKUM_ALLOWANCE_MANAGER` + `OKUM_CAP_MANAGER`
  together means **no on-chain ceiling on what that key can mint**, and
  `PSM_BUFFER_WITHDRAWER` lets it drain the reserve buffer. `grantRoles.ts`
  therefore **hard-refuses mainnet with no override**. Full grant list and
  rationale: [`EVM/README.md` § Role Grants Policy](EVM/README.md#role-grants-policy).
- **SVM** — `scripts/admin/grant-roles.ts --delegate=<pubkey>` moves only
  `direct_minter`, `direct_burner`, `rate_manager`, `buffer_depositor`, and will
  never touch the governance/safety set or `role_admin`. Rationale:
  [`SVM/README.md` § Delegated operation vs. retained ownership](SVM/README.md#delegated-operation-vs-retained-ownership-devnettestnet).

Both tools are idempotent and support a dry run.

### Recording who has been granted privilege

The EVM contracts extend OpenZeppelin `AccessControlUpgradeable`, **not
`AccessControlEnumerable`**, so there is no on-chain way to ask *"who holds
`OKUM_MINTER`?"* — only `hasRole(role, account)`, which requires already
knowing the account. A grantee address that isn't written down is
recoverable only from `RoleGranted` event logs, and on a chain whose history
has been pruned (every free bscTestnet endpoint), not even from those.

`EVM/scripts/config/roleGrants.json` closes that gap: an append-only ledger
of every grant/revoke **performed by a script** — the deploy's
`OKUM_MINTER` / `OKUM_BURNER` grants to LitePSM, `operator/grantRoles.ts` and
`operator/grantRolesMainnet.ts` — recording grantee address, label, role,
contract, chain, granting key and tx hash. Revocations append rather than
delete, so former holders stay visible for incident review. Roles that
`initialize` grants to the admin are not ledgered (the ledger is `[]` after a
clean deploy; they are recoverable from the deploy transaction's `RoleGranted`
logs). It is **tracked in git deliberately** because it is not reconstructible
from chain state alone. Implementation: `EVM/scripts/utils/roleRegistry.ts`.

### Signer trust implications

okuMoney is a **centralized financial product.** Users trust Oku Money as an
institution — the same way they trust Circle for USDC or Paxos for PYUSD.
On-chain RBAC enforces *separation of duties within the company*, not
protection *against* the company. Read every "cannot" below in that light.

**Per-path blast radius, guards and reversibility:
[`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md).** That file is canonical; where it
and this README disagree, the contract source wins. The tiering below is the
organisational model it assumes (role names per the RBAC table above).

| Tier | Key material | Shape of the worst case |
|---|---|---|
| **Cold Multisig** | Squads / Safe, hardware-backed quorum | Total. Upgrade replaces all logic with no timelock. **Do not read `maxSupply` or `minterAllowance` as a bound on this tier** — it sets both. |
| **Warm Multisig** | Lower quorum, faster to sign | Denial of service only. Pause is a **one-way door** — unpausing needs cold. No access to funds or parameters. |
| **Automated L2 pauser** | Dedicated EOA, automated (Arbitrum / OP / Base only) | `PSM_PAUSER` on `LitePSM` only, for the forced-path pause in § L2 sequencer outage. Same as the warm tier: denial of service only. |
| **Orchestrator** | KMS-backed, automated | Can ratchet the multiplier toward `MAX_MULTIPLIER`, inflating dollar value beyond actual backing. Cannot mint on EVM (`OKUM_MINTER` is held by contracts), cannot drain the buffer, cannot touch roles or upgrades. |
| **Protocol contracts** | n/a | Mint only from inside `mintOkuM` / `mintUsdOku` (LitePSM); burn only from the redeem paths — bounded by `minterAllowance` and `maxSupply`, which the cold tier can raise. |

**The one bound that is structural rather than administrative:** the multiplier
is monotonically non-decreasing on both stacks. No key, at any quorum, can move
it backwards. Everything else in the "cannot" column is a parameter that the
cold tier can re-parameterise.

**On timelocks.** okuMoney is centralized and US-regulated, not decentralized.
Industry peers (USDC, USDT, USDP, PYUSD, FDUSD) do not use on-chain timelocks;
they rely on operational, procedural and regulatory controls. Trust is anchored
in Oku Money as a legal entity, its MSB registration and its internal control
framework — not in on-chain delay mechanics. The cold-multisig quorum
requirement is itself the delay. **Timelocks are not pursued.**

---

## EVM vs SVM

The two stacks diverge deliberately in several places, and the catalogue of
*why* — token model, multiplier location, pause semantics, bridging asymmetry,
DeFi compatibility, event shapes — lives in
[`SVM/README.md` § EVM vs SVM — divergence catalogue](SVM/README.md#evm-vs-svm--divergence-catalogue).
Role and authority asymmetries are in
[`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md) § 4; constants are in each stack's
constants file (`EVM/src/lib/Constants.sol`,
`SVM/oku-programs/crates/oku-shared/src/constants.rs`) and must agree.

The three differences that are pure toolchain rather than design (versions:
`EVM/foundry.toml` / `hardhat.config.ts`, `SVM/oku-programs/Anchor.toml`):

| | EVM | SVM |
|---|---|---|
| Language | Solidity | Rust (Anchor) |
| Yield lock primitive | `block.number` | `Clock::slot` |
| Upgrade mechanism | UUPS proxy (all three contracts) | Solana BPF program upgrade (Squads authority) |

---

## Directory structure

```
contracts/
├── README.md                  # this file — cross-stack model, trust, runbook
├── AUTHORITY-MATRIX.md        # canonical role/authority reference
├── artifacts/                 # curated ABIs + IDLs for downstream consumers
├── EVM/                       # Solidity (Foundry + Hardhat)
│   ├── README.md              # contracts, deployment, accepted risks
│   └── docs/
│       └── epoch-accounting.md   # off-chain epoch/yield model
├── SVM/                       # Anchor programs (Rust)
│   └── README.md              # programs, design, divergence catalogue
├── packages/yield-tooling/    # shared multiplier + epoch math (TS); differential test
│                              #   (corpus: EVM/test/differential/vectors.jsonl)
└── testnet-addresses.json     # live deployment registry (auto-generated)
```

Each stack's README documents its own internal layout.

---

## Deployment runbook

Complete guide for deploying OkuMoney on EVM chains + Solana, and
exercising the on-chain protocol end-to-end. v1 cross-chain transfers
are off-chain orchestrator-mediated (PSM mint/burn) — there is no
on-chain bridge.

> Authoritative deployment state lives in
> [`testnet-addresses.json`](testnet-addresses.json) at the repo root,
> auto-synced by every successful live EVM deploy. Do NOT hand-edit;
> rerun the deploy script to refresh. **`DEPLOYMENT_VERSION` is `v0.4` and the
> EVM entries are empty until the clean-slate deploy runs** (including
> `MockUSDC`, whose bytecode changed); see
> [`EVM/scripts/config/addresses.README.md`](EVM/scripts/config/addresses.README.md)
> for the version-bump procedure.
>
> Per-chain working address book is at
> [`EVM/scripts/config/addresses.json`](EVM/scripts/config/addresses.json)
> (tracked, live `<chain>` keys only). Local-fork runs write `fork:<chain>`
> entries to the gitignored `EVM/scripts/config/addresses.local.json`, so
> ephemeral fork addresses never dirty the tracked file.

### Prerequisites

Copy `.env.example` to `.env` in `EVM/` and `SVM/oku-programs/` and fill it in;
each file documents its own keys. Then `npm install` plus `npx hardhat compile`
(EVM) / `anchor build` (SVM). SVM local-fork testing additionally needs
[Surfpool](https://run.surfpool.run/).

One EVM key worth calling out because it is not obvious: a **single**
`ETHERSCAN_API_KEY` covers verification on all supported chains via the
Etherscan V2 API — you do not need a per-explorer key.

### Phase 1 — local-fork pre-flight (recommended)

Validates the deploy will succeed against real chain state before
spending real funds. Catches funding shortfalls, RPC quirks, gas
estimation issues.

**EVM local fork** (auto-detects target chain from running node's `eth_chainId`):

```bash
cd EVM

# Terminal 1 — fork target chain (default: sepolia)
FORK_NETWORK=base hh node            # supported values: see EVM/hardhat.config.ts

# Terminal 2 — deploy + integration test against the fork
hh run scripts/deploy/index.ts --network localhost
hh run scripts/test/test-onchain.ts --network localhost
```

Deploys MockUSDC, OkuMoney, OkuDollar, LitePSM. Each `initialize` grants the
deployer its full role set; the script then grants LitePSM `OKUM_MINTER` /
`OKUM_BURNER`, sets its minter allowance and verifies the full role matrix.
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

# Per-network shortcuts: the `deploy:<chain>` scripts in EVM/package.json
npm run deploy:sepolia        # e.g. Eth Sepolia

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

`deploy:programs` prints the freshly-deployed program IDs and the exact lines
to paste into `[programs.devnet]` (or `[programs.mainnet]`); the cluster
sections are kept separate so one can rotate without the other. Until
`Anchor.toml` matches, an `[addressBook] WARNING:` fires on every admin script.

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
NETWORK=devnet npm run test:onchain -- --step=redeem   # single step; an unknown name prints the available steps
```

### Phase 4 — cross-chain bridge test (noBridge / PSM-mediated)

```
1. EVM source: LitePSM.redeemOkuM(amount) → orchestrator observes the OkuMRedeemed event + USDC outflow.
2. Destination: orchestrator calls `LitePSM.mintOkuM` (EVM) or `mint_oku_m` (SVM) funded with that USDC, crediting OkuM to the recipient.
3. Treasury periodically tops up PSM reserve buffers per chain.
```

EVM cross-chain accounting covered by
`EVM/test/hardhat/scenarios/RealWorldUsage.ts`. Full EVM↔SVM
roundtrip bridge test (reads EVM addresses from `testnet-addresses.json`, so it
fails until the v0.4 EVM deploy has repopulated them):

```bash
cd SVM/oku-programs
PRIVATE_KEY=<evm-key> tsx scripts/test/bridge-svm-evm.ts \
    --evm=baseSepolia --svm=devnet --amount=5 --direction=roundtrip
```

### Troubleshooting

Generic RPC flakiness (insufficient funds, `nonce too low`, replacement
underpriced) is absorbed by `withRetry`; if it persists, switch RPC. Two
non-generic ones:

- **`BAD_DATA: invalid address (value="")`** — a BSC pending-tx quirk.
  `scripts/utils/rpcCompat.ts` normalises it preventatively.
- **`Chain ID mismatch: local node reports X, NETWORK=Y expects Z`** — restart
  `hh node` with `FORK_NETWORK=Y`, or unset `NETWORK` and let the script
  auto-detect from the live chainId.

### Initial deploy parameters

Testnet supply cap and minter allowance are set in `EVM/scripts/deploy/index.ts`
and `SVM/oku-programs/scripts/config/constants.ts`; they are effectively
uncapped for dev.

**Mainnet deploys leave PSM minting closed** (minter allowance 0) on both stacks,
because every chain starts halted at a 1.00 multiplier (Cyfrin audit finding #2):
`EVM/scripts/deploy/index.ts` `getDeploymentConfig` sends no
`configureMinterAllowance` and `verifyDeployment` requires the allowance to be 0;
`SVM/oku-programs/scripts/deploy/lib/config.ts` initializes `minter_allowance = 0`
and `deploy-init.ts` fails if an existing config has a non-zero one. There is no
flag to open minting at deploy on mainnet. `PSM_MINTING_CLOSED=true` rehearses the
closed deploy on a testnet. The production allowance (§ Minter allowance rotation
policy) is set last, in § Opening PSM minting on a chain.

### Mainnet ceremony

The **deployer** is the key that ran the deploy: on EVM it holds
`DEFAULT_ADMIN_ROLE` and every granular role `initialize` gave it; on SVM it is
`role_admin` and BPF upgrade authority. Hand over in this order, verifying each
step on-chain before the next. Dry-run first (`DRY_RUN=1` on EVM,
`--dry-run` on SVM).

**EVM, per chain.**

1. Run `grantRolesMainnet.ts`. It checks LitePSM holds `OKUM_MINTER` /
   `OKUM_BURNER`, grants the cold / warm / orchestrator sets from the RBAC
   table, refuses to continue unless the cold multisig holds
   `DEFAULT_ADMIN_ROLE` on all three contracts, has the deployer
   `renounceRole` every granular role `initialize` gave it (all `*_UPGRADER`,
   `OKUM_MINTER` / `OKUM_BURNER`, `OKUM_RATE_MANAGER`, `PSM_BUFFER_WITHDRAWER`, ...),
   revokes the deployer's `DEFAULT_ADMIN_ROLE` last, and finally asserts with
   `hasRole` that the deployer holds nothing. Every grant, renounce and revoke
   is ledgered. Re-running is idempotent.

   ```bash
   MAINNET_COLD_MULTISIG=0x... MAINNET_WARM_MULTISIG=0x... MAINNET_ORCHESTRATOR=0x... YES_MAINNET=1 \
     npx hardhat run scripts/operator/grantRolesMainnet.ts --network base
   ```

2. Upgrades from here on are proposed to the cold multisig, not signed by
   the deployer: [`EVM/README.md`](EVM/README.md#upgrading-deployed-proxies) § Upgrading deployed proxies.

**SVM.** The deploy's `initialize` assigns the 9 granular roles directly to
their final holders (`MAINNET_*` env vars via `authorities.ts`), but forces
`role_admin` = deployer, because the signer must be the BPF upgrade authority
(`contexts/init.rs`). `deployments/<network>.json` records the *intended*
authorities, not on-chain state.

1. **Propose** from the deployer. This only writes `pending_role_admin`;
   `cancel_role_admin_transfer` aborts it.

   ```bash
   NETWORK=mainnet-beta tsx scripts/admin/set-authority.ts \
     --role=roleAdmin --new=<SQUADS_COLD_VAULT> --yes-i-mean-it-on-mainnet
   ```

2. **Accept** with `accept_role_admin`, signed by the cold Squads vault:
   `npm run admin:accept-role-admin -- --emit` prints the instruction for the
   Squads vault transaction.
3. **Verify** on-chain: `PsmConfig.role_admin` is the cold vault and
   `pending_role_admin` is the zero pubkey.
4. **Only then** transfer the BPF upgrade authority
   (`scripts/admin/set-upgrade-authority.ts`), so the deployer remains a
   recovery path until the cold tier has proven it can sign:

   ```bash
   NETWORK=mainnet-beta npm run admin:set-upgrade-authority -- --program=<LITE_PSM_PROGRAM> \
     --new-authority=<SQUADS_COLD_VAULT> --confirm=<SQUADS_COLD_VAULT> --yes-i-mean-it-on-mainnet
   ```

   (The raw CLI form needs `--skip-new-upgrade-authority-signer-check`, since a
   vault PDA cannot co-sign; the script adds it and verifies the result.)
   Program upgrades from here on use `MODE=propose`: [`SVM/README.md` § Program upgrades](SVM/README.md#program-upgrades).

The deployer then holds nothing on SVM. Mechanics and the SVM README
pre-mainnet checklist: [`SVM/README.md`](SVM/README.md). Final state per role:
`AUTHORITY-MATRIX.md` §5.

#### Opening PSM minting on a chain

**Both stacks, last.** The deploy leaves PSM minting closed (§ Initial deploy
parameters), and every chain starts halted at 1.00. Open it only after the
handover, and only once the chain's multiplier matches the fleet's:

1. **Fleet still at 1.00** (chains launched together, before any yield): publish the
   first schedule to every chain with `broadcastSchedule`, confirm
   `checkMultiplierDrift` passes, then go to step 4.
2. **Chain added after yield accrued elsewhere:** with minting still closed, override
   it to the leader's current multiplier (EVM `setOkuMMultiplier.ts`; SVM
   `set-multiplier.ts --to-match-evm=<wad>`), then catch it up to the leader's `rateEnd`
   and stage the leader's successor, as § Chain lagging the fleet step 4 does. Until it
   has caught up, `checkMultiplierDrift` reports it as lagging; that is expected while
   its minting is closed.
3. **Confirm it has caught up:** past the leader's `rateEnd`, `checkMultiplierDrift`
   passes with identical schedules, and its multiplier equals the leader's at the same
   timestamp up to rounding dust.
4. **Open minting:** the cold allowance manager (EVM `OKUM_ALLOWANCE_MANAGER`, SVM
   `allowance_manager`) sets the production allowance (§ Minter allowance rotation
   policy) as a multisig transaction: EVM Safe `OkuMoney.configureMinterAllowance(<LitePSM>, <amount>)`,
   SVM Squads vault `set_minter_allowance(<amount>)`.

Until step 4, PSM mints on that chain fail and bridges whose destination leg is its
PSM mint stall; redemptions are open throughout. SVM direct mints are not affected
(they take a raw OkuM amount, so they are not priced by the multiplier).

### Security notes

1. **Testnet collapses roles onto convenience keys.** On EVM the deployer holds everything `initialize` granted (operational roles optionally delegated by `grantRoles.ts`). On SVM the deployer is only `role_admin` / upgrade authority and the 9 granular roles sit on `keys/devnet-authority.json`. Production MUST use a separate KMS-backed orchestrator and the split topology above.
2. **Never commit `.env` files** or private keys to git.
3. **RPC reliability** — Alchemy preferred for live runs; public RPCs can lag on nonce / mempool state.
4. **No on-chain bridge in v1.** Cross-chain replay/refund protection is the orchestrator's responsibility — the protocol surface is just PSM mint/burn.
5. **EVM reserve token (USDC or USDT) should not carry a transfer callback.** `LitePSM` is reviewed against a plain ERC-20 (its user paths are `nonReentrant` as defence in depth); `initialize` validates only `decimals() <= 18` and cannot verify this on-chain. Circle USDC, Tether USDT and their canonical bridged variants have no such callback; confirm this holds for whatever token is configured on any new chain before deploying, particularly a non-canonical or custom-bridged variant. A transfer fee (Tether's legacy Ethereum contract can enable one) is tolerated: mints and buffer deposits credit the received balance, and a payout fee is borne by the recipient. See [`EVM/README.md` § Accepted Risks #14](EVM/README.md#14-reserve-token-usdc-or-usdt).

### Chain IDs

EVM chain IDs are listed per-network in
[`EVM/scripts/config/chains.ts`](EVM/scripts/config/chains.ts), which is the
source of truth.

---

## Pointers

- **EVM-specific docs:** [`EVM/README.md`](EVM/README.md) (incl. Accepted Risks)
- **SVM-specific docs:** [`SVM/README.md`](SVM/README.md) (incl. Accepted Risks)
- **Authority reference:** [`AUTHORITY-MATRIX.md`](AUTHORITY-MATRIX.md)
- **Open issues:** tracked internally (Linear)
- **Downstream SDK / backend consumption:** [`artifacts/README.md`](artifacts/README.md)
