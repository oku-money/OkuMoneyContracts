# OkuMoney Solana Implementation

> See [`../README.md`](../README.md) for shared architecture, RBAC,
> business logic, the orchestrator runbook, and the deployment
> end-to-end guide.

Solana implementation of OkuMoney — institutional-grade yield
infrastructure backed by US Treasury Bills. Single-token architecture
(`OkuM`) with ScaledUiAmount-based yield display.

## Stack

- **Language:** Rust 1.90.0 (pinned in `oku-programs/rust-toolchain.toml`)
- **Framework:** Anchor 1.0.2 (`Anchor.toml` + workspace `Cargo.toml`)
- **Solana crates:** 3.x series (`solana_version = "3.1.10"` in `Anchor.toml`)
- **Token standard:** Token-2022 (`OkuM` mint with `ScaledUiAmount` + `MetadataPointer` + `TokenMetadata` extensions)
- **Multisig:** Squads Protocol
- **JavaScript bindings:** `@anchor-lang/core 1.0.x`

## Programs

### lite-psm

The single program housing the Peg Stability Module (buffer-only —
no redemption queue), yield distribution, compliance (freeze / thaw),
and direct mint/burn for bridging. Program ID:
`BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g`. Holds mint
authority, freeze authority, and `ScaledUiAmountConfig` authority
over the `OkuM` mint. All program authority is held by a PDA — no
EOA controls minting.

The `initialize` instruction creates the `OkuM` Token-2022 mint
with three extensions (`ScaledUiAmount`, `MetadataPointer`,
`TokenMetadata`) via CPIs to the Token-2022 program.

### oku-shared (workspace crate)

Pure-Rust workspace lib with **zero dependencies** (no `solana-*`,
no `anchor-lang`). Houses the protocol-wide constants and pure-math
primitives (`math.rs` + `yield_lock.rs` + `constants.rs`).
Re-exported by `lite-psm` through its `constants.rs` module so call
sites still write `use crate::constants::*` without caring where the
value is authored.

Lives in `crates/` rather than `programs/` because `anchor build`
walks `programs/*` and requires every member to declare an
`idl-build` feature; `crates/*` is for ordinary workspace libs.

### Cross-chain transfers (off-chain orchestrator)

There is no on-chain bridge program. Cross-chain transfers use an
asymmetric model:

- **SVM side:** The orchestrator calls `burn_oku_m_direct` on the
  source chain (burns raw OkuM tokens) and `mint_oku_m_direct`
  on the destination chain (mints raw OkuM tokens). Raw amounts
  are conserved directly — no USDC intermediate on the SVM side.
- **EVM side:** Still uses PSM-mediated USDC flow
  (`mint` / `redeem`).
- **Orchestrator** handles the asymmetry between the two models.

See [`../README.md` § Orchestrator runbook](../README.md) for
operational procedures.

---

## Why a single token on SVM

**Platform constraint:** Solana's SPL Token program stores balances
as a literal `u64` in each token account — there is no `balanceOf()`
override, so **true on-chain rebasing (the EVM stETH/USDM/rUSDY
pattern) is impossible on SVM**. Every yield-bearing Solana token
(JitoSOL, mSOL, Sanctum LSTs, Ondo USDY) instead uses a
value-appreciating model: static raw balances, value-per-token rises
over time. None of them use Token-2022 extensions for display.

**Our approach:** Token-2022's `ScaledUiAmountConfig` extension
stores an updatable f64 multiplier on the mint. Wallets/RPCs that
support it display `raw_amount * multiplier`; the raw
`token_account.amount` never changes, so DeFi protocols (AMMs,
lending) see static balances by construction. This gives the
value-appreciating model under the hood with a $1-pegged display on
top (deposit 100 USDC → see 100.00 OkuM; after 5% yield → see 105.00
OkuM). This is the extension's intended use case per the [official
ScaledUiAmount integration
guide](https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide).

**Naming convention (important):** the on-chain token is **OkuM
(OkuMoney)** in all code, instructions, and field names
(`oku_m_mint`, `mint_oku_m`, `MintOkuM`, etc.). The mint's
`TokenMetadata` extension carries this same on-chain identity —
`name: "OkuMoney", symbol: "OkuM"` — matching the EVM `OkuMoney`
token (`EVM/test/shared/Constants.sol`: `OKUMONEY_NAME`/`OKUMONEY_SYMBOL`).
Wallets and block explorers therefore display **OkuM** for the mint
and for transfers, showing the true, non-$1-pegged OkuM amounts.

The **`name`/`symbol` strings are a single source of truth** —
`OKU_M_METADATA_NAME` / `OKU_M_METADATA_SYMBOL` in
`programs/lite-psm/src/constants.rs` — consumed by both `initialize`
(mint creation) and `update_token_metadata` (in-place rename of an
already-deployed mint by `role_admin`).

**OkuM vs usdOku (display layer).** "usdOku" is NOT the on-chain
symbol. The $1-pegged **usdOku** value is a *presentation-layer*
number produced by the mint's `ScaledUiAmount` extension
(`raw_amount * multiplier`), which Token-2022-aware wallets render
automatically. So: on-chain identity = OkuM (value-appreciating,
T-Bill-backed); the wallet/UI display of that same balance as a
$1-pegged usdOku figure is the scaled UI amount. (On EVM, usdOku
/ `OkuDollar` is a *separate* wrapper token; SVM collapses that role
into the ScaledUiAmount display of the single OkuM mint.)

**Why we keep the symbol as `OkuM` (not `usdOku`).** A Token-2022
mint has a *single* `symbol` field; it cannot serve one label to
explorers and another to wallets. Renaming the symbol to `usdOku`
would not remove the raw layer — it would only relabel it, and a
`usdOku` label on a raw (unscaled) number falsely asserts a $1 peg.
Keeping `OkuM` means the raw number always reads as what it truly
is (the underlying token count), while ScaledUiAmount-aware wallets
still show the $1-pegged dollar value. **Testers will see the raw,
non-scaled OkuM amount** (lower than the wallet's dollar figure
whenever the multiplier > 1) in: non-ScaledUiAmount explorers, raw
RPC (`amount` vs `uiAmount`), `spl-token accounts`, transfer
instruction arguments in tx history, the mint's `supply`, and any
program/AMM integration operating on base units. This is expected —
those surfaces denominate in raw OkuM, not in the usdOku display.

---

## Key SVM design choices

**Single token with ScaledUiAmount.** `OkuM` ("OkuMoney") is the
sole protocol token. It is a Token-2022 mint with the
`ScaledUiAmountConfig` extension, which stores an f64 multiplier.
Wallets and explorers that support `ScaledUiAmount` render the
scaled dollar-value balance automatically (e.g. 1 000 000 raw OkuM
tokens at multiplier 1.05 displays as a "1.05" usdOku value — the
mint's on-chain symbol is still OkuM; "usdOku" is the UI label for
the scaled figure). The multiplier on the mint extension is the
**single source of truth** — there is no `oku_m_price` PDA field or
dual-write path.

**`read_multiplier()` helper and zero-init guard.** The helper at
`lite-psm/src/helpers/scaled_ui.rs` reads the multiplier from the
mint's `ScaledUiAmountConfig` extension via
`get_extension::<ScaledUiAmountConfig>()`. Before `set_multiplier`
has ever been called, the extension field is zero-initialized (f64
`0.0`); the helper treats `0.0` as `1.0` to prevent division-by-zero
in price-aware instructions.

**f64 precision characteristics.** The `ScaledUiAmountConfig`
extension stores the multiplier as an IEEE 754 `f64`. f64 has ~15.9
significant decimal digits; for practical stablecoin multipliers
(1.0 to ~2.0 over years of yield), this provides sub-nano-dollar
precision. The `MAX_MULTIPLIER` constant documents the upper bound
where precision degrades, but the practical operating range is well
within f64's capabilities.

**Discrete multiplier bumps.** The orchestrator calls
`set_multiplier` to update the `ScaledUiAmountConfig` scalar. There
is no continuous compounding — `ScaledUiAmount` stores a flat scalar,
not a rate. Economic effect is identical between orchestrator calls.

**DeFi compatible by construction.** Raw token amounts are static —
AMMs, lending protocols, and orderbooks operate on raw balances that
never change from yield accrual. UI amounts (dollar values) are
derived from the `ScaledUiAmount` extension. Raydium CPMM/CLMM
explicitly allow `ScaledUiAmount` tokens; Jupiter routes through
them natively.

**Single-slot yield distribution lock.** `set_multiplier()` and
`distribute_yield()` set `last_yield_distribution_slot =
Clock::get().slot`. PSM operations check `current_slot !=
last_yield_distribution_slot` before executing. Self-fence prevents
same-slot re-entry by the rebaser. Mirrors EVM's
`lastYieldDistributionBlock`.

**6-decimal token.** `OkuM` uses 6 decimals, matching USDC on
Solana. EVM uses 18 decimals. The off-chain orchestrator handles
decimal conversion when reflecting value across chains.

---

## Program structure

```
crates/
  oku-shared/                # Pure-Rust workspace lib (no solana-*, no anchor-lang)
    src/
      lib.rs
      constants.rs           # PRECISION, BASIS_POINTS, MAX_MULTIPLIER, TOKEN_DECIMALS
      math.rs                # mul_div_floor, mul_div_ceil + siblings, overflow-safe Option<u64>
                             # + Kani harnesses gated on #[cfg(kani)]
      yield_lock.rs          # Pure slot-comparison primitive
    fuzz/                    # cargo-fuzz workspace
      fuzz_targets/
        mul_div_floor.rs
        mul_div_ceil.rs
        raw_to_dollars.rs
        dollars_to_raw.rs

programs/
  lite-psm/
    src/
      lib.rs                       # 24 instruction entry points
      state.rs                     # PsmConfig only (seed: psm_config, 562B) —
                                   # no RedemptionQueue account; buffer-only PSM
      errors.rs                    # 26 error variants
      events.rs
      roles.rs                     # AuthorityRole enum (12 roles)
      constants.rs                 # Re-exports oku_shared::*
      helpers/
        scaled_ui.rs               # read_multiplier() — reads ScaledUiAmountConfig extension from mint
        yield_lock.rs              # check_yield_lock (delegates to shared yield_lock_engaged)
        math.rs                    # Anchor-error-flavoured wrappers over oku_shared::math
      instructions/
        init.rs                    # initialize (creates PsmConfig + OkuM mint with ScaledUiAmount +
                                   # MetadataPointer + TokenMetadata via CPIs); escrow ATA creation is
                                   # client-side (no on-chain setup instruction)
        psm.rs                     # mint_oku_m, redeem_oku_m (buffer-only — reverts InsufficientBuffer
                                   # if the vault can't cover it), deposit_buffer, withdraw_buffer
        psm_admin.rs               # pause/unpause, freeze/thaw, set_authority, accept_role_admin,
                                   # cancel_role_admin_transfer, update_token_metadata,
                                   # set_max_supply, set_minter_allowance,
                                   # set_direct_minter_allowance, set_direct_burner_allowance
        direct_mint.rs             # mint_oku_m_direct (bridge/fiat on-ramp)
        direct_burn.rs             # burn_oku_m_direct (bridge off-ramp)
        yield_ops.rs               # set_multiplier, distribute_yield (CPI to Token-2022 UpdateMultiplier)
      contexts/                    # Per-instruction account contexts

tests/
  bankrun/                  # Default in-process suite (npm test, 128 bankrun tests)
    smoke.ts
    lite-psm.ts
    direct-mint.ts
    direct-burn.ts
    init-invariants.ts
    rate-over-time.ts
    crossChainBridging.ts
    scaled-ui-amount.ts          # ScaledUiAmount-specific suite
    coverage-additions.ts
    scenarios/
      realWorldUsage.ts
  shared/
    setup.ts                     # Shared authority keypairs + initializePsm
    bankrun.ts                   # Harness, helpers, autoBumpSlot wrapper
```

---

## State accounts

### PsmConfig PDA (`b"psm_config"`)

```rust
pub struct PsmConfig {
    pub bump: u8,
    // 12 authority pubkeys: role_admin, pauser, unpauser, freezer, unfreezer,
    //   buffer_depositor, buffer_withdrawer, cap_manager, allowance_manager,
    //   rebaser, direct_minter, direct_burner
    // Token references: usdc_mint, oku_m_mint, vault_usdc
    // Limits: max_supply, minter_allowance, direct_minter_allowance,
    //   direct_burner_allowance, is_paused
    // Yield: last_yield_distribution_slot
    // Two-step RoleAdmin: pending_role_admin
    // Cross-chain sync window: sync_lock_until_ts, sync_window_secs
    // Fees: tin_bps, tout_bps; cadence: last_mark_ts
}
```

`PsmConfig` is the only state account. Its byte length is pinned at 602
bytes by a compile-time `assert!`. There is no `RedemptionQueue` account
and no on-chain escrow-vault field — the PSM is buffer-only (see "Why no
redemption queue" below), and the OkuM escrow ATA is derived client-side,
not stored on `PsmConfig`.

The PsmConfig PDA is the **mint authority**, **freeze authority**, and
**ScaledUiAmount authority** for the `OkuM` mint. All mint/freeze/
multiplier-update CPIs are signed by the PDA's seeds. The seed string is
defined once as `PsmConfig::SEED` in `programs/lite-psm/src/state.rs` and
mirrored for clients in `scripts/utils/pdaHelpers.ts`.

### Why no redemption queue

`redeem_oku_m` is buffer-only: it reverts with `InsufficientBuffer` if
`vault_usdc.amount` cannot cover the redemption. This matches how every
other stablecoin issuer on Solana operates (buffer-only, no on-chain
queue) and keeps the operational surface small — there are no
queue-management instructions, capacity SLAs, or queue-processor role.
Operators keep the buffer topped up via `deposit_buffer` /
`withdraw_buffer`; there is nothing to drain.

---

## Core operations

### Yield (ScaledUiAmount multiplier)

```rust
// Set the ScaledUiAmount multiplier on the OkuM mint — REBASER only, monotonic
// CPIs into Token-2022 UpdateMultiplier
pub fn set_multiplier(new_multiplier: f64)

// Dollar-denominated yield distribution — REBASER only
// Computes new multiplier from yield_amount and total supply, then CPIs UpdateMultiplier
pub fn distribute_yield(yield_amount: u64)
```

Both set `last_yield_distribution_slot = Clock::get().slot` and self-fence to
reject same-slot re-entry. Both also **unconditionally arm the cross-chain
sync window** as part of the same write (fail-closed), so a tick can never
land unfenced — there is no separate open call an operator could forget.

> **Scope of the same-slot fence.** It stops an operation sharing a slot with the
> multiplier write, and nothing more. It does **not** prevent step arbitrage: mint
> at slot `N-1`, let the write land at `N`, redeem at `N+1`, and the whole step is
> captured after ~800 ms of holding. Widening the fence does not help — the
> attacker simply moves further out. Two separate mechanisms cover the two real
> surfaces: the [sync window](#cross-chain-sync-window) for cross-chain
> divergence, and [`tout`](#fees-tin--tout) for the step itself.

### Cross-chain sync window

A multiplier tick is not atomic across chains. Between the SVM write and the EVM
write the two sides price a raw token differently, so anything converting value
*through* the multiplier in that interval settles at a stale price on one side.

```rust
pub fn set_sync_window_secs(secs: i64)    // CAP_MANAGER — 0 disables; <= MAX_SYNC_WINDOW_SECS
```

**Auto-arm only — there is no open/close protocol.** Every `set_multiplier` /
`distribute_yield` write unconditionally arms `sync_lock_until_ts = now +
sync_window_secs` as part of the same transaction that writes the multiplier.
There is no `begin_sync_window` / `end_sync_window` pair, no `sync_epoch`, and
no `last_write_epoch` field — an earlier design had all three, and they are
gone. The write and the fence are now the same transaction, so there is no
ordering for an operator to get wrong and no separate open call to forget.

The lock end is **assigned**, not extended or stacked: `sync_lock_until_ts =
now + sync_window_secs` overwrites whatever was there before. That single
choice is what bounds the window by construction — no sequence of writes,
however adversarial, can chain windows past `MAX_SYNC_WINDOW_SECS`, so the
`MIN_SYNC_WINDOW_GAP_SECS` anti-grief gap the old open/close protocol needed
is gone too; there is nothing left for it to guard against.

**Gating rule:** an instruction is sync-gated **iff it can move value across a
multiplier boundary between chains**. Gated: `mint_oku_m_direct`,
`burn_oku_m_direct` — the bridge legs, and only those. Not gated: `mint_oku_m`,
`redeem_oku_m`, `deposit_buffer`, `withdraw_buffer`, and every admin path.

> **`mint_oku_m` / `redeem_oku_m` were gated and are not any more.** They are
> single-chain: the price they transact at is *this* chain's own multiplier,
> which is correct whatever the peer chain currently believes. Gating them
> bought no security and cost a `sync_window_secs` outage on subscription and
> redemption after every mark — the two paths a user most needs available. The
> EVM twin removed the equivalent gating from the module, the queue and the
> wrapper at the same time.

> **The rule is deliberately not "does it price locally".** An earlier revision
> exempted the direct bridge legs on exactly that basis — neither reads the
> multiplier for its quantity, and the `read_multiplier` call inside feeds only
> the event's `dollar_value`. That reasoning is correct per instruction and
> wrong per round trip. The cross-chain PAIR does price: burning 100 raw where
> `M = 1.04` destroys $104 of claim while minting 100 raw where `M = 1.05`
> creates $105, conjuring a dollar out of a mid-tick divergence.
> "Raw-conserving" is a property of one leg that does not survive both.
> Pinned by `crossChainBridging.ts` — "bridge legs are BLOCKED mid-tick, and
> conserve raw 1:1 once the window lifts".

Buffer deposit/withdraw stay open because they move USDC at par and never
consult the multiplier, so a stale price cannot misprice them — and blocking
them would obstruct the operator's own remediation mid-tick.

| Property | Mechanism |
|---|---|
| Fail-closed | every multiplier write auto-arms, in the same transaction as the write |
| Fail-open | auto-expiry at `MAX_SYNC_WINDOW_SECS` (900s) — a dead orchestrator cannot brick redemption |
| Bounded by construction | assign, not extend — no sequence of writes can chain a window past the ceiling |
| Ships inert | `sync_window_secs` defaults to `0`, which blocks nothing at all |

Wall-clock seconds rather than slots, deliberately: Solana slot times stretch
under exactly the congestion that slows cross-chain propagation, so a
slot-denominated window would shrink precisely when it needs to be longest. This
also keeps it cleanly orthogonal to the slot-based same-slot fence.

**Cross-chain completion is verified off-chain, by comparing multiplier
VALUES, not epoch numbers.** `scripts/admin/check-sync-parity.ts` reads
`uiMultiplier()` from the EVM `OkuM` contract and the SVM mint's Token-2022
`ScaledUiAmountConfig.multiplier`, scales the SVM f64 to an integer at 1e9
(`Math.round(multiplier * 1e9)`, exact for every value the program can write),
and compares the two directly at SVM precision (`evm_raw / 1e9` vs `svm_raw`,
tolerance configurable via `--tolerance`, default `0`). This is **strictly
stronger** than the epoch check it replaced: equal epochs only ever proved
both chains *wrote something* for a tick, never that they wrote the *same
value*. A wrong-value write is caught by a value comparison and invisible to
an epoch comparison. There is no on-chain attestation of the peer chain's
state to keep in sync, and nothing more to verify than what the comparison
already does.

### Fees (`tin` / `tout`)

```rust
pub fn set_fees(tin_bps: u64, tout_bps: u64)   // CAP_MANAGER — both <= MAX_FEE_BPS (100)
```

Restored from the upstream this PSM was modelled on
([`dss-lite-psm`](https://github.com/makerdao/dss-lite-psm)), which the original
port omitted. Both default to **0 bps** and ship inert.

**The combined `tin + tout` is the control for local step arbitrage, and it is
load-bearing on both chains now.** The multiplier moves in discrete steps —
Token-2022 refuses `ScaledUiAmount` alongside `InterestBearingConfig`, so
continuous accrual is unavailable on SVM; EVM's `OkuM` is stepwise by design
so both sides carry the same value at the same cadence (see [`../EVM/README.md`
§ ERC-8056 on OkuM](../EVM/README.md)). A discrete step is free money without a
fee: mint at `M0`, wait for the step to `M1`, redeem, pocket the difference. No
risk, no meaningful holding period, repeatable every step, bounded only by
`minter_allowance` and buffer depth. The yield captured belonged to holders who
actually held.

The sync window does **not** prevent this — the attacker never transacts while it
is open, and the multiplier is monotone so waiting costs them nothing. Fees are
the only control.

#### The coverage invariant

Sizing the fees correctly is **not** left to the operator, and it is **not**
runtime state. Coverage is a relationship between two constants:

```rust
// at every multiplier write (set_multiplier, distribute_yield):
require!( step_bps_ceil(M0, M1) <= MAX_STEP_BPS );          // StepAboveMax
require!( now >= last_mark_ts + MIN_MARK_INTERVAL_SECS );   // MarkTooSoon

// at every fee change (set_fees):
require!( tout_bps >= MAX_STEP_BPS );                       // FeeBelowStepFloor
// tin_bps has NO floor and ships at 0
```

Composed, every step the program can take is covered on **each leg
independently**, for all time, with no account space and no history to consult.
`initialize` seeds both legs at `MAX_STEP_BPS`, so coverage holds from the first
slot.

**The EXIT leg only.** The arbitrage gain is realised on exit, and the only exit
that drains the vault is `redeem_oku_m`, which always charges `tout_bps`. So
`tout >= step` is sufficient and `tin` is irrelevant — including cross-chain,
since whichever chain the attacker exits on charges its own `tout`. Deposits are
free, which matters: permissionless frictionless entry is the product.

Two earlier revisions got this wrong in the same way — first binding the combined
`tin + tout`, then flooring both legs on a cross-chain leg-pairing argument.
Neither survives the observation above.

**`MIN_MARK_INTERVAL_SECS` is what makes `MAX_STEP_BPS` mean anything.** The
ceiling bounds one *call*; nothing bounded how many landed per slot, so a
compromised `rebaser` could loop `set_multiplier` and compound arbitrarily fast.
Wall-clock rather than slots, and deliberately not a reuse of
`last_yield_distribution_slot` — that is a same-slot reentrancy fence, this is a
cadence control, and slot times stretch under exactly the congestion that would
delay a mark. Ondo enforces the same control on OUSG at 23 hours.

*Proof.* The worst case the program admits is a mark of exactly `MAX_STEP_BPS`
against `tin = 0` and `tout = MAX_STEP_BPS`:

```text
net <= D(1 + s)(1 - s) = D(1 - s²) < D    for s = MAX_STEP_BPS
``` Holding period and later redemption price are irrelevant: the floor is a
constant, so no future fee change can weaken it. Verified by
`oku_shared::step_coverage::verification::proof_admissible_step_under_admissible_fees_is_never_profitable`
(Kani) and by
`tests/bankrun/sync-window-and-fees.ts § local step arbitrage`, which includes
the cheapest cross-chain leg pairing.

**What this replaced, and why.** The earlier design had four interacting parts: a
`step_is_covered(tin + tout)` read at write time, a `max_step_bps` high-water
ratchet, a floor on later `set_fees` calls against that ratchet, and a cold
`reset_step_high_water_mark` escape hatch. Each existed to contain the previous
one, and the escape hatch's honest precondition — that the raw supply outstanding
when a large step landed had substantially turned over — was not verifiable
on-chain, so the program could only make the action deliberate and loud, never
safe. The static floor is strictly stronger (the ratchet only ever covered steps
that had *actually occurred*), costs 8 bytes less of `PsmConfig`, and removes the
un-modelled trust surface entirely.

A time-based cooldown on fee decreases was also considered and rejected: the
attacker's edge is locked in the instant the step lands and does not decay, and
the multiplier is monotonic so waiting costs them nothing. A cooldown delays the
profit rather than removing it. Note the contrast with the sync window, where a
time lock **is** the right tool — cross-chain divergence is transient and
self-correcting, so waiting genuinely removes the edge, whereas a step's gain is
permanent.

Two consequences worth internalising:

- **`tout` ships AT the floor and can never return to zero; `tin` ships at 0.** The
  program no longer reads the fee schedule at multiplier-write time, so a
  zero-fee window would be an *uncovered-step* window rather than a fail-closed
  state. Shipping covered also removes a launch-ordering dependency: the program
  is accrual-ready from `initialize`.
- **A single step can never exceed `MAX_STEP_BPS`.** That implies a **minimum
  cadence**: at 5% APY a daily mark is ~1.37 bps against a 5 bps ceiling (~3.5x
  headroom, so a missed three days still fits), but a long outage must be caught
  up over several marks, each re-arming its own sync window. This is the direct
  analogue of the `MAX_IMPLIED_APR` catch-up limitation on the EVM side, and it
  is the operator-absence protection working as designed.

Sizing, at 5% APY:

| Cadence | Step | `MAX_STEP_BPS` must be at least | Minimum exit fee |
|---|---|---|---|
| hourly | ~0.06 bps | 1 bps | 2 bps |
| daily | ~1.37 bps | 2 bps | 2 bps |
| **6-hourly** | **~0.34 bps** | 1 bps (**2 shipped**, ~6x headroom) | 2 bps |
| weekly | ~9.6 bps | 10 bps | 20 bps |
| monthly | ~40.7 bps | 41 bps | 82 bps |

Note the coupling runs one way: `MAX_STEP_BPS` sets both the cadence bound and
the minimum EXIT fee, so a coarser cadence necessarily makes the product more
expensive to leave. Entry is free at any cadence. The trade-off is explicit
rather than emergent.

Fees are **withheld, not forwarded**: `tin` enters the vault without OkuM minted
against it, `tout` is owed but never transferred out. Both raise the collateral
ratio. No recipient, no sweep. Fees round up and payouts round down, per the
`oku-shared` protocol-favouring rounding policy; a redemption whose entire payout
rounds into the fee is rejected with `ZeroOutput` rather than settling a zero
transfer.

The multiplier is read back from the mint via `read_multiplier()`
(in `helpers/scaled_ui.rs`), which calls
`get_extension::<ScaledUiAmountConfig>()` on the mint account data.
This is the only path for reading the current multiplier — there is
no duplicate field on `PsmConfig`.

### PSM

```rust
// raw_oku_m_amount = usdc_amount × PRECISION / multiplier
// (usdc_amount is treated as a dollar value; ScaledUiAmount handles $1-peg display).
// At multiplier == PRECISION (1.0) this is 1:1; above it, fewer raw OkuM per USDC.
pub fn mint_oku_m(usdc_amount: u64)

// usdc_amount = raw_oku_m_amount × multiplier / PRECISION.
// Buffer-only: reverts InsufficientBuffer if vault_usdc can't cover it
// (no redemption queue — see "Why no redemption queue" above).
pub fn redeem_oku_m(raw_oku_m_amount: u64, min_usdc_out: u64)

pub fn deposit_buffer(amount: u64)                   // top up USDC vault
pub fn withdraw_buffer(amount: u64)                  // drain USDC vault
```

All protected by the same-slot yield fence. `mint_oku_m` and `redeem_oku_m` are
additionally gated by the [cross-chain sync window](#cross-chain-sync-window) and
apply [`tin`/`tout`](#fees-tin--tout); `deposit_buffer` and `withdraw_buffer` are
neither, since they move USDC at par and never read the multiplier.

`min_usdc_out` is slippage protection — pass `0` to disable the check. It is
compared against the **net** payout, after `tout`, so it means what the caller
actually receives.

### Direct mint / burn (bridging + fiat on-ramp)

```rust
// Mint raw OkuM tokens — DIRECT_MINTER only
// Used for cross-chain bridging (SVM side) and fiat on-ramp
pub fn mint_oku_m_direct(amount: u64)

// Burn raw OkuM tokens — DIRECT_BURNER only
// Used for cross-chain bridging off-ramp
pub fn burn_oku_m_direct(amount: u64)
```

Raw amounts are conserved across chains — no multiplier conversion
during bridging. The `ScaledUiAmount` multiplier is synchronized
separately by the rebaser on each chain.

### Cross-chain

See "Cross-chain transfers (off-chain orchestrator)" above for the
overview. One load-bearing property specific to this instruction set:

**`mint_oku_m` is fully permissionless.** Any USDC holder can call
it; the orchestrator does NOT hold a privileged mint authority for
PSM operations. The PSM config PDA is the OkuM mint authority and
signs the inner `mint_to` CPI. Orchestrator key compromise does not
grant mint privilege beyond the orchestrator's direct_minter
allowance. This property is load-bearing;
`tests/bankrun/crossChainBridging.ts` asserts it.

See [`../README.md` § Orchestrator runbook](../README.md) for
operational procedures.

---

## Precision model

```rust
const PRECISION: u64 = 1_000_000_000; // 1e9

// ScaledUiAmount multiplier: f64, e.g. 1.0 = $1.00, 1.045 = $1.045
// All intermediate u64 calculations use u128 to prevent overflow.
// Rounding favours protocol (round DOWN throughout).
```

**Why 1e9 on SVM vs 1e18 on EVM:** SVM uses `u64` for token amounts
and BPF natively widens to `u128` for intermediates. `1e9 × u64`
peaks around `1.8e28`, comfortably within `u128::MAX (≈ 3.4e38)`.
A 1e18 precision would require either `u128` token amounts (no SPL
Token-2022 support) or aggressive precision loss on every operation.

**f64 for ScaledUiAmount:** The Token-2022 `ScaledUiAmountConfig`
extension stores the multiplier as IEEE 754 `f64`. For the practical
stablecoin multiplier range (1.0 to ~2.0), f64 provides ~15 decimal
digits of precision — more than sufficient for sub-micro-dollar
accuracy. `MAX_MULTIPLIER` in `oku-shared/src/constants.rs` documents
the upper bound where f64 precision would degrade.

---

## Hardcoded constants

Shared protocol constants live in
[`crates/oku-shared/src/constants.rs`](oku-programs/crates/oku-shared/src/constants.rs);
program-specific constants live in the program's own `constants.rs`.
None can be changed without a program upgrade.

### Shared (`oku-shared`)

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1_000_000_000` (1e9) | Fixed-point base for all multiplier math. |
| `BASIS_POINTS` | `10_000` | Universal bps denominator. |
| `MAX_MULTIPLIER` | `1_000_000_000_000_000` (1e15, = $1M/token) | Overflow guard / f64 precision boundary. Math-sanity bound. |
| `TOKEN_DECIMALS` | `6` | OkuM uses 6 decimals on SVM (matches USDC). Asserted at init. |

### Lite-PSM

`lite-psm/src/constants.rs` re-exports the shared constants from
`oku-shared` and defines the on-chain OkuM metadata identity
(`OKU_M_METADATA_NAME` / `OKU_M_METADATA_SYMBOL`).

---

## Authority model

For the full centralized trust model and what each key tier
can / can't do see [`../README.md § Signer trust implications`](../README.md).
SVM-specific table:

| Role | Held by | What it can do | On-chain prevention |
|---|---|---|---|
| `role_admin` | Cold Multisig (Squads) | Rotate any other role via `set_authority` (two-step `accept_role_admin` handshake for its own transfer) | Meta-role. Quorum breach = full system compromise. Two-step rotation catches typos. No-op rejection on self-assignment. |
| `pauser` | Warm Multisig | Set `is_paused = true`, halting mint/redeem | Cannot unpause (requires `unpauser`). Cannot access funds. |
| `unpauser` | Cold Multisig | Clear `is_paused` | — |
| `freezer` | Warm Multisig | CPI-freeze any OkuM ATA via Token-2022 freeze authority | Cannot drain or redirect frozen tokens. |
| `unfreezer` | Cold Multisig | CPI-thaw a frozen ATA | — |
| `rebaser` | Orchestrator (KMS) | Update ScaledUiAmount multiplier (non-decreasing) and call `distribute_yield` | Cannot decrease; capped at `MAX_MULTIPLIER`. Self-fenced (same-slot re-entry rejected). |
| `buffer_depositor` | Orchestrator | Transfer USDC from caller's ATA into the PSM vault | Caller must hold USDC; no damage possible. |
| `buffer_withdrawer` | Cold Multisig | Drain USDC from the PSM vault | Cannot withdraw more than the vault's current USDC balance. |
| `cap_manager` | Cold Multisig | Set `max_supply` | Cannot set below current circulating supply. |
| `allowance_manager` | Cold Multisig | Set `minter_allowance`, `direct_minter_allowance`, and `direct_burner_allowance` | Bounded by `max_supply`; PSM PDA is the mint authority. |
| `direct_minter` | Operator / Bridge Orchestrator | `mint_oku_m_direct` (raw OkuM without USDC) | Bounded by `direct_minter_allowance` + `max_supply`. No USDC collateral on-chain — fiat/bridge backing is off-chain. |
| `direct_burner` | Operator / Bridge Orchestrator | `burn_oku_m_direct` (raw OkuM burn for bridge off-ramp) | Bounded by `direct_burner_allowance`. Burns from caller's ATA only. |

---

## Initialization

`initialize(InitializeParams)` creates `PsmConfig` and the USDC
vault in a single instruction. It also creates the `OkuM` Token-2022
mint with three extensions (`ScaledUiAmount` — multiplier authority =
PsmConfig PDA, `MetadataPointer`, `TokenMetadata`) via CPIs to the
Token-2022 program. The PsmConfig PDA is set as mint authority and
freeze authority.

The OkuM escrow ATA (owned by the PsmConfig PDA) is created
client-side by the deploy script via a standard idempotent
associated-token-account instruction — there is no separate on-chain
escrow-setup instruction.

No on-chain bridge, router, or redemption queue is deployed — the PSM is
buffer-only and cross-chain transfers are orchestrator-mediated.

---

## Error codes

Full list (31 variants) in `programs/lite-psm/src/errors.rs`. Key errors:

- `YieldDistributionInProgress` — operation blocked during yield lock.
- `MultiplierCannotDecrease` — ScaledUiAmount multiplier is monotonically increasing.
- `InsufficientUserBalance` — user balance shortfall on redeem.
- `InsufficientBuffer` — PSM USDC vault can't cover a redeem or withdraw_buffer.
- `ZeroOutput` — redeem output rounds down to zero.
- `SlippageExceeded` — redeem output is below the caller's `min_usdc_out` floor.
- `YieldTooSmall` — `distribute_yield` amount truncates to zero.
- `Paused` — operation attempted while system is paused.
- `Unauthorized` — caller lacks the required role.
- `SyncWindowActive` — a multiplier tick is propagating cross-chain; the bridge legs are blocked until it expires.
- `StepAboveMax` — the step from a multiplier write exceeds `MAX_STEP_BPS`.
- `FeeBelowStepFloor` — a proposed `tout_bps` is below `MAX_STEP_BPS`, the step-coverage floor. `tin_bps` has no floor.
- `MarkTooSoon` — a mark was attempted less than `MIN_MARK_INTERVAL_SECS` after the previous one.

---

## Accepted Risks

Trust assumptions and design decisions the SVM side makes
deliberately. A third-party reviewer or auditor should not re-flag
these; they are the considered output of design discussion.

### 1. Operator-compromise is out of scope

okuMoney is a centralized US-regulated MSB. The on-chain authority
model encodes separation-of-duties within the company (see
`Authority model` above), but the threat model does NOT include "what
if the cold multisig is malicious." That scenario is managed via
off-chain controls (key custody, change-management procedures,
regulatory framework).

Guards like `MAX_MULTIPLIER` and per-role allowance caps are present
as math-sanity bounds (keeping `u64 * u64 -> u128` paths in the
overflow-safe region, and stopping operator typos), not as defense
against a compromised rebaser key.

### 2. No on-chain Proof-of-Reserves or oracle

There is no on-chain Proof-of-Reserves feed or USDC-peg circuit-breaker.
A PoR feed controlled by the operator cannot detect operator-side
reserve fraud, and USDC-depeg handling is a monitoring concern rather
than an on-chain guard. The protocol relies on off-chain monitoring for
USDC depeg events.

### 3. Buffer-only PSM (no redemption queue)

`redeem_oku_m` is buffer-only: it reverts with `InsufficientBuffer` if
`vault_usdc.amount` can't cover the redemption, rather than escrowing the
request in an on-chain queue. This matches how every other stablecoin
issuer operates on Solana and keeps the operational surface small — no
queue capacity limits, batch-drain SLAs, or spam-DoS considerations.
Operators keep the buffer topped up via `deposit_buffer` /
`withdraw_buffer`; there is nothing to drain or rescue.

### 4. SVM ↔ EVM constant parity carries the 1e9 vs 1e18 scaling delta

SVM uses `PRECISION = 1e9` for the structural reason that `u64` token
amounts × `1e9` precision peak around `1.8e28`, comfortably within
`u128::MAX`. A `1e18` precision would require either `u128` token
amounts (no SPL Token-2022 support) or aggressive precision loss on
every operation. Every numeric constant has its SVM-scaled
counterpart (e.g. `MAX_MULTIPLIER = 1e15` on SVM vs `MAX_MULTIPLIER =
1e24` on EVM). The off-chain orchestrator handles the scale
conversion when reflecting value across the EVM ↔ SVM boundary. See
[`oku-programs/crates/oku-shared/src/constants.rs`](oku-programs/crates/oku-shared/src/constants.rs)
and the EVM mirror in
[`../EVM/src/lib/Constants.sol`](../EVM/src/lib/Constants.sol).

---

## Testing

```bash
# Full bankrun suite — 128 bankrun tests + 44 Rust unit tests = 172 total
npm test
# or directly:
npx mocha --require tsx --timeout 60000 'tests/bankrun/**/*.ts'

# Individual bankrun test files
npx mocha --require tsx --timeout 60000 'tests/bankrun/lite-psm.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/direct-mint.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/direct-burn.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/scaled-ui-amount.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/rate-over-time.ts'

# Cargo unit tests (math primitives, helpers)
cargo test --workspace                # 44 unit tests

# Anchor build
anchor build
```

### Token-2022 binary override for bankrun

The `ScaledUiAmount` extension requires a recent Token-2022 program
binary that includes `UpdateMultiplier` support. The default
`solana-bankrun` / `litesvm` image may ship an older Token-2022
binary without this instruction. The project includes a Makefile
target to fetch a mainnet Token-2022 binary override:

```bash
make fetch-token-2022
```

This downloads the mainnet Token-2022 `.so` and places it where
bankrun can load it at test startup. Without this override,
`set_multiplier` and `distribute_yield` tests will fail with an
"invalid instruction" error from the Token-2022 program.

### ScaledUiAmount test suite

The `tests/bankrun/scaled-ui-amount.ts` file contains 7 dedicated
tests for ScaledUiAmount behaviour:

- Multiplier initialization (starts at 0.0, treated as 1.0)
- `set_multiplier` updates the on-chain extension
- `distribute_yield` computes and applies a new multiplier
- Monotonicity enforcement (decrease rejected)
- Yield-lock interaction with multiplier updates
- `readMultiplierFromMint()` TS helper round-trip verification

The `readMultiplierFromMint()` helper in the test shared code reads
the `ScaledUiAmountConfig` extension directly from a mint account's
data, parsing the TLV structure to extract the f64 multiplier. This
mirrors the on-chain `read_multiplier()` Rust helper.

### Runner notes

The entire unit suite runs on
[`solana-bankrun`](https://github.com/kevinheavey/solana-bankrun)
via the thin `anchor-bankrun` adapter. Bankrun executes BPF programs
in-process on `litesvm`, eliminating the 30 s confirmation-polling
window in `@solana/web3.js@1.x` and wall-clock waits for slot rollover.

**`autoBumpSlot` (default on).** `startBankrun()` wraps
`provider.sendAndConfirm` so every transaction advances the bankrun
slot by 1 before submission. This handles two unrelated annoyances:

- `check_yield_lock` rejects any op in the same slot as the last
  `set_multiplier` / `distribute_yield` — without auto-bump, any
  test ordering that follows a yield op hits `YieldDistributionInProgress`.
- Bankrun caches identical-byte transactions and replays the prior
  result ("This transaction has already been processed") — auto-bump
  forces a fresh blockhash on every submission.

Tests needing strict slot semantics pass
`startBankrun({ autoBumpSlot: false })` and call `warpSlots(h, n)`
explicitly.

---

## Deployment

See [`../README.md § Deployment runbook`](../README.md) for the full
two-chain + SVM deploy walk-through. SVM-side highlights:

```bash
# Pre-flight cost estimate
anchor build
npm run cost                  # estimate one-time rent for program + PsmConfig + mint + ATAs

# Phase 1 — deploy program .so file
NETWORK=devnet npm run deploy:programs

# Phase 2 — create OkuM mint + initialize PSM
NETWORK=devnet npm run deploy:init

# Mainnet — transfer program upgrade authority to cold multisig
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

---

## Runbook (SVM-specific)

### Pre-mainnet checklist

- [ ] `MAINNET_ORCHESTRATOR` env var points at a KMS-backed signer, not the deployer wallet.
- [ ] BPF loader upgrade authority transferred to the cold multisig.
- [ ] `Anchor.toml [programs.<network>]` matches the freshly-deployed program ID (`BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g`).
- [ ] Token-2022 binary override applied if bankrun tests are part of CI (`make fetch-token-2022`).

### Delegated operation vs. retained ownership (devnet/testnet)

On mainnet, roles map to the Squads multisig tiers per the Authority
model table above. On devnet/testnet it's common to delegate
day-to-day operation of the app to a coworker or CI-owned key (the
"delegate") while governance retains ownership. The rule of thumb:

- **Operational roles** (safe to delegate to a third-party operating
  key): `direct_minter`, `direct_burner`, `rebaser`, `buffer_depositor`.
  These are bounded by allowances/caps and can't drain funds or
  brick the protocol.
- **Governance/safety roles** (must stay on a key you hold):
  `pauser`, `unpauser`, `freezer`, `unfreezer`, `cap_manager`,
  `allowance_manager`, `buffer_withdrawer`. `allowance_manager` in
  particular sets the blast-radius cap (`direct_minter_allowance` /
  `direct_burner_allowance`) on the delegate's own operational roles
  — handing it to the same party being capped defeats the point.
- **`role_admin`** never leaves the deployer/owner. It grants
  unconditional claw-back of every other role via `set_authority`
  (single tx, no coworker signature needed) and is the basis of
  "ownership" independent of who currently holds an operational role.
- **BPF upgrade authority** is a separate axis entirely (see
  `admin:set-upgrade-authority`) and should also stay with the owner.

`scripts/admin/grant-roles.ts` implements this split: it only grants
the four operational roles to a `--delegate` pubkey and will never
touch the governance/safety set or `role_admin` (see the NatSpec
header in that file for full rationale). Use `set-authority.ts` directly
if you need to rotate an individual governance role.

### Orchestrator key

In v1 the orchestrator holds a single Solana keypair that
is granted roles for `buffer_depositor`, `rebaser`, `direct_minter`,
and `direct_burner`. For cross-chain transfers it calls
`burn_oku_m_direct` / `mint_oku_m_direct`. It also holds
the matching EVM key on the other side. Both keys KMS-backed.

A future on-chain bridge (NTT, CCIP, native OkuBridge port) would
add a separate signing scheme — out of v1 scope.

### Buffer discipline

The PSM is buffer-only — `redeem_oku_m` reverts with
`InsufficientBuffer` if `vault_usdc.amount` can't cover the
redemption (see "Why no redemption queue" earlier in this doc).
Operational discipline:

- Keep `vault_usdc.amount` topped up via `deposit_buffer` so
  `redeem_oku_m` always succeeds for expected redemption volume.
- Monitor buffer balance against a rolling estimate of daily
  redemption volume; alert well before it's depleted.
- If a redeem reverts with `InsufficientBuffer`, the fix is simply
  `deposit_buffer` — there is nothing "stuck" to rescue or drain,
  since no queue exists to hold a failed redemption.

### Cross-chain refund / recovery

In v1 there is no on-chain refund flow because there is no on-chain
bridge. If an off-chain cross-chain transfer is interrupted (e.g.
orchestrator outage between source burn and destination mint), the
orchestrator reconciles state by re-running the mint on the
destination once it recovers, or by re-minting on the source if
it never actually burned.

### Admin scripts

All admin scripts live under `scripts/admin/`. Each:

- Prints a human-readable summary block before any state change.
- Honors `--dry-run` (build the tx, simulate, don't submit).
- On `mainnet-beta` / `mainnet-fork`, requires
  `--yes-i-mean-it-on-mainnet` OR an interactive `yes` prompt.

| Script | Wraps | Role gate |
|---|---|---|
| `admin:set-authority` | `set_authority` (any single role, incl. `direct_minter`/`direct_burner`) | `role_admin` |
| `admin:grant-roles` (`grant-roles.ts --delegate=<pubkey>`) | `set_authority` for the 4 *operational* roles only (`direct_minter`, `direct_burner`, `rebaser`, `buffer_depositor`) + resets their allowances | `role_admin` (roles) + `allowance_manager` (allowances, best-effort — see script header) |
| `admin:pause-psm` / `admin:unpause-psm` | `pause` / `unpause` | `pauser` / `unpauser` |
| `admin:set-max-supply` | `set_max_supply` | `cap_manager` |
| `admin:set-minter-allowance` | `set_minter_allowance` | `allowance_manager` |
| `admin:set-direct-minter-allowance` / `admin:set-direct-burner-allowance` | `set_direct_minter_allowance` / `set_direct_burner_allowance` | `allowance_manager` |
| `admin:mint-oku-m` / `admin:redeem-oku-m` | `mint_oku_m` / `redeem_oku_m` — standalone orchestrator bridge-leg CLIs | permissionless / caller |
| `admin:mint-oku-m-direct` | `mint_oku_m_direct` — permissioned fiat on-ramp | `direct_minter` |
| `admin:set-multiplier` | `set_multiplier` | `rebaser` (stamps yield slot + arms sync window) |
| `admin:distribute-yield` | `distribute_yield` | `rebaser` (stamps yield slot + arms sync window) |
| `admin:set-sync-window-secs` | `set_sync_window_secs` (0 disables; ≤ `MAX_SYNC_WINDOW_SECS`) | `cap_manager` |
| `admin:set-fees` | `set_fees` — `tin_bps` in `[0, MAX_FEE_BPS]`, `tout_bps` in `[MAX_STEP_BPS, MAX_FEE_BPS]`. The `tout` floor is the step-arbitrage control; there is no reset instruction because there is no accumulated state | `cap_manager` |
| `admin:check-sync-parity` | read-only cross-chain **multiplier VALUE** comparison (EVM `uiMultiplier()` vs SVM mint's `ScaledUiAmountConfig.multiplier`, `--tolerance` flag) — strictly stronger than the old epoch check, since equal epochs never proved equal values | none (read-only) |
| `admin:freeze-account` / `admin:thaw-account` | `freeze_account` / `thaw_account` | `freezer` / `unfreezer` |
| `admin:deposit-buffer` / `admin:withdraw-buffer` | `deposit_buffer` / `withdraw_buffer` | `buffer_depositor` / `buffer_withdrawer` |
| `admin:close-programs` | `solana program close` (BPF loader) — recover rent from stale program deployments. | BPF upgrade authority (deployer wallet) |

---

## EVM vs SVM — divergence catalogue

> **Updated for the two-token EVM design.** EVM runs two tokens: `OkuM` (the
> fully-backed, ERC-8056 share token — SVM's counterpart) and `USDOku` (a
> continuously-rebasing dollar wrapper over it, EVM-only, no ERC-8056). SVM has
> no `USDOku` equivalent; it remains single-token. `OkuM`'s accrual granularity
> is now **stepwise on both chains** — EVM's `OkuM` moved from continuous to
> discrete `setOkuMultiplier` writes for the same reason SVM always was
> (Token-2022 rejects `ScaledUiAmount` alongside `InterestBearingConfig`, so a
> continuous SVM design was never possible; EVM converged onto the same
> granularity so both chains carry the same value at the same cadence). That
> removes what used to be this catalogue's biggest divergence: **the
> post-step sync window and the `tin + tout` step-coverage invariant are now
> near-identical mechanisms on both chains**, not an SVM-only concern. `USDOku`
> is the chain's one remaining continuous-accrual instrument, and it is
> EVM-only, so it does not appear in this catalogue at all. See the EVM-side
> mirror in [`../EVM/README.md`](../EVM/README.md) for the symmetric
> perspective, particularly "Rate authority and the gate/lock mechanism" and
> "ERC-8056 on OkuM".

This section catalogues SVM-specific deliberate departures from the
EVM implementation. See the EVM-side mirror in
[`../EVM/README.md`](../EVM/README.md) for the symmetric perspective.

### Workspace layout — where the EVM libs went

EVM groups protocol-wide invariants into `EVM/src/lib/`:

| EVM file | SVM equivalent |
|---|---|
| `lib/Constants.sol` | `crates/oku-shared/src/constants.rs` |
| `lib/MathLib.sol` | `crates/oku-shared/src/math.rs` |
| `lib/YieldSandwichGuard.sol` (removed on EVM when accrual went continuous, pre-dating the current two-token design) | `crates/oku-shared/src/yield_lock.rs` + `lite-psm/src/helpers/yield_lock.rs` wrapper — no longer a port of anything, SVM-only |
| `OkuM`'s `ScaledUIAmountStorage` sync-window fields (own ERC-7201 namespace) | `crates/oku-shared/src/sync_window.rs` + `lite-psm/src/helpers/sync_window.rs` wrapper + `PsmConfig` fields |
| `MathLib.feeAmount` / `applyFee` | `oku_shared::math::fee_amount` / `apply_fee` |
| `lib/Roles.sol` | `programs/lite-psm/src/roles.rs` (single program owns all RBAC) |
| `lib/Errors.sol` | `programs/lite-psm/src/errors.rs` |
| `lib/events/*.sol` | `programs/lite-psm/src/events.rs` |
| `lib/SafeApprove.sol` | not ported — SPL Token-2022 doesn't have the EIP-20 allowance-zeroing footgun |
| `lib/ReentrancyGuardUpgradeable.sol` | not ported — Solana's account-lock model + no fallback fns means reentrancy isn't reachable the same way |

### Single-token architecture

EVM has two tokens: `OkuM` (fully-backed share token, ERC-8056,
stepwise) and `USDOku` (a continuously-rebasing dollar wrapper over
it, EVM-only, no ERC-8056 — see [`../EVM/README.md`](../EVM/README.md)).
SVM has a single token: `OkuM`, a Token-2022 mint with the
`ScaledUiAmountConfig` extension. Raw balances are static on both
chains' `OkuM`; displayed dollar values scale with the multiplier.
SVM has no `USDOku` counterpart at all — there is nothing on SVM
that plays USDOku's role, not even a stepwise analogue.

This eliminates the need for wrap/unwrap, the wrapper program, dead
shares, a solvency-gap invariant, and the two-program CPI chain that
`USDOkuWrapper` requires on EVM.

### ScaledUiAmount vs ERC-8056 storage

EVM stores the multiplier (`M_oku`) in `OkuM`'s own ERC-7201
`ScaledUIAmountStorage` namespace, alongside the sync-window and
step-high-water-mark fields — the token contract owns its own price.
SVM stores the multiplier as an `f64` in the Token-2022
`ScaledUiAmountConfig` extension on the mint itself; the sync-window
and step-high-water-mark fields live on `PsmConfig` instead, since
the PSM program (not the mint) is the natural place for PDA-owned
state on Solana. Neither chain has a price field on the PSM/module
contract — `read_multiplier()` (SVM) and `uiMultiplier()` (EVM) are
each the single source of truth for their chain.
`set_multiplier()`/`distribute_yield()` (SVM) and
`setOkuMultiplier()` (EVM) write it.

### Rebasing model

Both chains' `OkuM` now move in **discrete steps** — EVM converged
onto SVM's model rather than the reverse: Token-2022 rejects
`ScaledUiAmount` alongside `InterestBearingConfig`, so continuous
accrual was never available on SVM, and EVM's `setOkuMultiplier` is
now the same "write a discrete value, effective immediately" shape as
SVM's `set_multiplier` / `distribute_yield`. Neither chain
pre-schedules a step for the reasons in
[`yield_ops.rs`'s module doc](oku-programs/programs/lite-psm/src/instructions/yield_ops.rs)
— scheduling makes a step predictable, not smaller, and the fees
handle profitability regardless of timing. Discrete updates are
economically identical between orchestrator calls. `USDOku` remains
the only continuously-accruing instrument in the system, and it is
EVM-only with no SVM counterpart.

### `distributeYield` zero-yield guard

Both EVM and SVM reject a `yieldAmount` / `yield_amount` that
truncates to zero per token. Without this guard, a sub-threshold
yield call would stamp `lastYieldDistributionBlock` /
`last_yield_distribution_slot` without actually moving the
multiplier, wasting the sandwich-lock window for the entire
block/slot.

- EVM: `OkuMoney.distributeYield` reverts `YieldTooSmall()`.
- SVM: `distribute_yield` reverts `LitePsmError::YieldTooSmall`.

### Pause-bypass deltas

| Operation | EVM | SVM |
|---|---|---|
| `freeze_account` / `thaw_account` | bypasses pause (Token-2022 freeze authority independent of `Pausable`) | bypasses pause (Token-2022 freeze CPI signed by config PDA; pause check intentionally omitted) |
| `processQueue` when paused | proceeds — pause must not lock users in the queue | N/A — SVM has no queue |

### Sync-window and fee deltas

Both mechanisms converged to the same shape on both chains: **auto-arm only,
assign-not-extend, no epoch, no open/close protocol**, and a **combined `tin +
tout` step-coverage invariant** enforced at write time plus a high-water-mark
floor at the fee setter. What remains is genuinely chain-specific plumbing,
not a design gap on either side:

| Aspect | EVM | SVM |
|---|---|---|
| Sync window | **REMOVED ENTIRELY.** EVM has no dedicated bridge instruction — `OkuM.mint`/`burn` are the shared supply hooks the module and queue use for ordinary local subscription and redemption, so gating them would gate the whole PSM. A future bridge adapter reproduces the fence in its own contract from `lastSteppedAt()`, which ERC-8056 makes the token store anyway | **RETAINED**, gating `mint_oku_m_direct` and `burn_oku_m_direct` — the bridge legs, and only those |
| Step-coverage invariant | `StepAboveMaximum` at `setOkuMultiplier` + `FeeBelowStepFloor` on `tout` at `setFees` — both against the `MAX_STEP_BPS` constant | `StepAboveMax` at write + `FeeBelowStepFloor` on `tout_bps` at `set_fees` — identical rule, same constant |
| Mark cadence | `MIN_MARK_INTERVAL` read off `lastSteppedAt` (stored anyway for ERC-8056) | `MIN_MARK_INTERVAL_SECS` against a dedicated `last_mark_ts` field |
| Window default | `DEFAULT_SYNC_WINDOW` (60s) | `DEFAULT_SYNC_WINDOW_SECS` (60s) |
| Open/close protocol | none — auto-arm only, same as SVM | none — auto-arm only, same as EVM |
| Cross-chain completion check | off-chain, by multiplier **value** (`check-sync-parity.ts`), not epoch — same script, same direction | off-chain, by multiplier **value** (`check-sync-parity.ts`) |
| Max single multiplier move | bounded — `MAX_STEP_BPS` per write, same combined-fee-coverage shape as SVM | 1% — ceiled step `<= MAX_STEP_BPS`, bounded by `tin_bps + tout_bps 
 <= 2×MAX_FEE_BPS`, implying a minimum cadence |
| Window unit | `block.timestamp` seconds | `Clock::unix_timestamp` seconds (**not** slots — slot times stretch under the congestion that slows propagation) |
| Window state location | `OkuM`'s own `ScaledUIAmountStorage` (ERC-7201 namespace) — the multiplier authority lives on the token itself; other contracts read `isSyncLocked()` | `PsmConfig` — same program owns both the multiplier write and the PSM |
| Auto-arm trigger | `setOkuMultiplier` only. `haltAccrual` deliberately does **not** arm — `OKU_GUARDIAN` is warm and withhold-only | `set_multiplier` and `distribute_yield` |
| `USDOku`'s `setUsdOkuRate` | **not** sync-gated — moves no value; its solvency check reads `M_oku` but is provably conservative mid-tick | N/A — no continuous-accrual instrument on SVM |
| Same-slot fence | none — no continuous-accrual concern remains once `OkuM` is stepwise on both chains; EVM never had one for `OkuM` | `last_yield_distribution_slot`, SVM-only, self-fences same-slot re-entry |
| `processQueue` under window | **gated** (prices at the live multiplier), unlike under pause | N/A — no queue |
| Fee floor role | **load-bearing on both chains** — `tout` floored at `MAX_STEP_BPS`, seeded there by `initialize`, unreachable below it; `tin` free and shipping at 0 | **identical** — same constant, same exit-leg rule |
| Queued-fee snapshot | `QueueEntry.toutBps`, packed into the entry's existing free bits; settles at `min(snapshot, live)` | N/A — no queue |
| Window/fee setter | `OKU_CAP_MANAGER` (window), `PSM_FEE_MANAGER` (fees) — split because AccessControl is per-contract | `cap_manager` for both |

The one genuine remaining asymmetry above the plumbing level: EVM additionally
has `USDOku`'s continuous, unstepped `setUsdOkuRate` surface, which has no
sync-window or step-coverage concern at all (nothing to step, nothing to
propagate a value through) and therefore no SVM analogue to compare against.

### Bridging model asymmetry

| Aspect | EVM | SVM |
|---|---|---|
| Bridge mechanism | PSM-mediated USDC flow (`mint` / `redeem`) | Direct raw-amount `burn_oku_m_direct` / `mint_oku_m_direct` |
| USDC intermediate | yes | no |
| Multiplier during bridge | not applicable (USDC is 1:1) | raw amounts conserved; multiplier synced separately by rebaser |

The orchestrator handles this asymmetry transparently.

### Redemption model — queue (EVM) vs buffer-only (SVM)

EVM keeps a `RedemptionQueue` to escrow a redeem when the buffer is
insufficient; SVM has no queue at all (`redeem_oku_m` reverts
`InsufficientBuffer` instead). See "Why no redemption queue" above —
this is a deliberate SVM-specific simplification, not a parity gap.

### DeFi compatibility

| Aspect | EVM | SVM |
|---|---|---|
| AMM integration | rebasing tokens require wrapper or custom pool logic | raw amounts static — standard AMM pools work natively |
| Raydium | n/a | CPMM/CLMM explicitly allow `ScaledUiAmount` tokens |
| Jupiter | n/a | routes through `ScaledUiAmount` tokens natively |
| Lending protocols | must account for rebasing | raw collateral amounts are stable; no rebasing risk |

### Approval model

EVM uses `IERC20.approve` + `transferFrom`. SVM uses SPL account
ownership: each operation has a `Signer` field on the account
context, and Anchor validates ownership at deserialization. No
global approval table.

### Round-trip drift

PSM mint/redeem rounding direction is identical on both sides
(round down, favouring the protocol). End-to-end USDC → OkuM → USDC
round-trips lose at most 1 wei (EVM) / 1 micro-USDC (SVM) of dust
per round-trip from integer-division truncation.

### Cross-chain operational requirements (v1)

The orchestrator holds:

- A Solana keypair with `buffer_depositor`, `rebaser`, `direct_minter`,
  and `direct_burner` roles. Uses `burn_oku_m_direct` /
  `mint_oku_m_direct` for cross-chain settlement.
- An EVM EOA with `PSM_BUFFER_DEPOSITOR`, `PSM_QUEUE_PROCESSOR`,
  `OKU_RATE_SETTER` (arms the sync window on every `setOkuMultiplier` call,
  same as SVM's `rebaser`) (and a separate EVM owner key for relevant
  `SubscriptionModule` admin actions). SVM has no queue-processor
  equivalent.

Both KMS-backed. No on-chain bridge state, no chain whitelist, no
nonces, no refund flow — all cross-chain coordination is off-chain.

### Programs that exist on one side only

| Component | EVM | SVM | Notes |
|---|---|---|---|
| `OkuM` (share token, ERC-8056 / Token-2022 ScaledUiAmount) | yes (`EVM/src/token/OkuM.sol`) | yes (Token-2022 mint) | parity — same role, different platform mechanism |
| `USDOku` (continuously-rebasing dollar wrapper) | yes (`EVM/src/token/USDOku.sol`) | no | EVM-only; no SVM analogue at all, not even a stepwise one |
| `USDOkuWrapper` (OkuM ↔ USDOku at `M_oku`) | yes (`EVM/src/wrapper/USDOkuWrapper.sol`) | no | EVM-only, exists only because `USDOku` exists |
| `SubscriptionModule` (USDC ↔ OkuM PSM) | yes (`EVM/src/psm/SubscriptionModule.sol`, renamed from `LitePSM`) | yes (`programs/lite-psm`) | parity (different token model) |
| `RedemptionQueue` | yes (`EVM/src/psm/RedemptionQueue.sol`) | no — buffer-only PSM | SVM-only deliberate simplification |
| On-chain bridge | none | none | both sides are off-chain orchestrator-mediated |

### Events

PSM events have matching shapes across EVM and SVM with minor naming
differences (e.g. `BufferDeposited` ↔ `BufferDepositEvent`). SVM has
no queue events (no queue exists). For per-event schemas see
[`../EVM/src/lib/events/`](../EVM/src/lib/events) (Solidity event
declarations) and
[`oku-programs/programs/lite-psm/src/events.rs`](oku-programs/programs/lite-psm/src/events.rs).

---

## Pointers

- **Orchestrator runbook + deployment guide:** [`../README.md`](../README.md)
- **Open issues:** [`../TRACKER.md`](../TRACKER.md)
- **Accepted risks:** see "Accepted Risks" above
- **EVM-side docs:** [`../EVM/README.md`](../EVM/README.md)
