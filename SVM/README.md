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
`4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN`. Holds mint
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

There is no on-chain bridge program and no reserved seam for one. The
SVM leg is `burn_oku_m_direct` on the source / `mint_oku_m_direct` on
the destination — raw OkuM amounts conserved 1:1, with no USDC
intermediary and no multiplier conversion. The EVM leg is
PSM-mediated USDC flow, and the orchestrator absorbs the asymmetry.

Full model, conservation invariants and operating procedure:
[`../README.md` § Cross-chain transfers](../README.md#cross-chain-transfers-v1-off-chain-orchestrated)
and § Orchestrator runbook.

---

## Why a single token on SVM

**Platform constraint.** SPL token balances are a literal `u64` with no
`balanceOf()` hook, so true on-chain rebasing — the EVM stETH/USDM/rUSDY
pattern — is impossible on SVM.

Every yield-bearing Solana token (JitoSOL, mSOL, Sanctum LSTs, Ondo
USDY) uses a value-appreciating model instead: static raw balances,
value-per-token rises over time. None of them use Token-2022 extensions for
display.

**Our approach.** Token-2022's `ScaledUiAmountConfig` extension stores an
updatable f64 multiplier on the mint. Wallets and RPCs that support it display
`raw_amount * multiplier`; `token_account.amount` never changes, so AMMs,
lending protocols and orderbooks see static balances by construction. Raydium
CPMM/CLMM explicitly allow `ScaledUiAmount` tokens and Jupiter routes through
them natively. This is the extension's intended use case per the [official
ScaledUiAmount integration
guide](https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide).

This eliminates wrap/unwrap, the vault program, dead shares, collateral
ratios, and the two-program CPI chain that the EVM two-token model requires.

### The mint extension is NOT the source of truth

It is a **write-only display mirror**: the program pushes values into it for
wallets to render and never reads them back. The canonical multiplier is
computed on read from the rate schedule on `PsmConfig` (`helpers/multiplier.rs`
→ `oku_shared::rate`), exactly as EVM computes `okuMMultiplier()` from its
schedule. There is no duplicate multiplier field on `PsmConfig` and no read
path from the extension — do not add one.

The reason is structural. `ScaledUiAmountConfig::current_multiplier()` is a
step function with exactly one pre-armable future step, so it cannot represent
a continuously-accruing value. The extension that *can*
(`InterestBearingConfig`) is mutually exclusive with it on-chain
(`spl-token-2022-interface` `extension/mod.rs:1359-1361`) and would cost the
bounded rate window, the pre-staged successor, and the ability to re-anchor —
three correctness properties traded for one cosmetic one.

**Continuous accrual, discrete display.** The canonical multiplier compounds
every second with no transactions at all. The mirror is a staircase refreshed
by a permissionless crank (60s recommended), always at or below the canonical
value — so a redeem pays at least what the wallet showed. At 20% APY the
under-read is about $0.35 per $1,000,000.

**f64 precision.** The extension stores the multiplier as an IEEE 754 `f64`
(~15.9 significant decimal digits), which is sub-nano-dollar precision for
practical stablecoin multipliers. Since it is display-only, this is a display
concern rather than a pricing one — see § Precision model.

### Naming: OkuM on-chain, usdOku in the wallet

The on-chain token is **OkuM (OkuMoney)** in all code, instructions and field
names (`oku_m_mint`, `mint_oku_m`, `MintOkuM`). The mint's `TokenMetadata`
extension carries that same identity — `name: "OkuMoney", symbol: "OkuM"` —
matching the EVM `OkuMoney` token. Wallets and explorers therefore display
**OkuM** for the mint and for transfers, showing true, non-$1-pegged amounts.

The name/symbol strings are a **single source of truth**,
`OKU_M_METADATA_NAME` / `OKU_M_METADATA_SYMBOL` in
`programs/lite-psm/src/constants.rs`, consumed by both `initialize` (mint
creation) and `update_token_metadata` (in-place rename by `role_admin`).

**"usdOku" is NOT the on-chain symbol.** It is a *presentation-layer* number
produced by the `ScaledUiAmount` extension (`raw_amount * multiplier`), which
Token-2022-aware wallets render automatically. On-chain identity = OkuM
(value-appreciating, T-Bill-backed); the wallet rendering of that same balance
as a $1-pegged figure is the scaled UI amount. On EVM, usdOku / `OkuDollar` is
a *separate* wrapper token; SVM collapses that role into the display layer of
the single OkuM mint.

**Why the symbol stays `OkuM`.** A Token-2022 mint has a *single* `symbol`
field; it cannot serve one label to explorers and another to wallets. Renaming
it to `usdOku` would not remove the raw layer — it would relabel it, and a
`usdOku` label on a raw (unscaled) number falsely asserts a $1 peg. Keeping
`OkuM` means the raw number always reads as what it is. **Testers will see the
raw, non-scaled OkuM amount** (lower than the wallet's dollar figure whenever
the multiplier > 1) in: non-ScaledUiAmount explorers, raw RPC (`amount` vs
`uiAmount`), `spl-token accounts`, transfer instruction arguments in tx
history, the mint's `supply`, and any program/AMM integration operating on
base units. Those surfaces denominate in raw OkuM, not in the usdOku display.

### Other SVM-specific choices

**Single-slot sandwich lock.** Only `set_okum_multiplier()` (the emergency
override) sets `last_yield_distribution_slot = Clock::get().slot`. PSM
operations check `current_slot != last_yield_distribution_slot` before
executing, which also self-fences same-slot re-entry by the rebaser. Mirrors
EVM's `lastYieldDistributionBlock`.

**6-decimal token.** `OkuM` uses 6 decimals, matching USDC on Solana; EVM uses
18. The off-chain orchestrator handles decimal conversion when reflecting
value across chains. This is unrelated to `PRECISION`, which is 1e18 on both
stacks.

---

## Program structure

```
crates/
  oku-shared/                # Pure-Rust workspace lib (no solana-*, no anchor-lang)
    src/
      lib.rs
      constants.rs           # PRECISION, MAX_MULTIPLIER, TOKEN_DECIMALS
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
      lib.rs                       # 25 instruction entry points
      state.rs                     # PsmConfig only (seed: psm_config, LEN = 754) —
                                   # no RedemptionQueue account; buffer-only PSM
      errors.rs                    # 31 error variants
      events.rs
      roles.rs                     # AuthorityRole enum (12 roles)
      constants.rs                 # Re-exports oku_shared::*
      helpers/
        multiplier.rs              # canonical multiplier — computed from the PsmConfig rate schedule
        display_sync.rs            # write-only ScaledUiAmount display mirror (cosmetic)
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
        yield_ops.rs               # rate-schedule writers + emergency override + display crank
      contexts/                    # Per-instruction account contexts

tests/
  bankrun/                  # Default in-process suite — see § Testing
  integration/              # Opt-in, against a live validator
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
    // Yield schedule (6 fields, mirroring EVM): okum_base_multiplier,
    //   okum_rate_per_second, okum_last_accrual_time, okum_rate_end,
    //   okum_pending_rate_per_second, okum_pending_rate_end
    // Sandwich lock: last_yield_distribution_slot
    // Two-step RoleAdmin: pending_role_admin
    pub reserved: [u8; 128],   // tail padding for future fields
}
```

`PsmConfig` is the only state account. `PsmConfig::LEN` is **754** bytes
(8-byte discriminator + `InitSpace`), pinned by a compile-time `assert!` so
any field-width change fails the build. There is no `RedemptionQueue` account
and no on-chain escrow-vault field — the PSM is buffer-only (see "Why no
redemption queue" below), and the OkuM escrow ATA is derived client-side,
not stored on `PsmConfig`.

### `reserved: [u8; 128]`

The config is a singleton PDA, so without tail padding any new field would
require closing and re-initialising it — losing every role assignment and the
accrual anchor. `reserved` is 128 bytes of slack (≈4 more pubkeys or 16 more
`u64`s, ~0.0009 SOL of rent). **Consume from the FRONT when adding a field and
shrink the array to match, keeping `LEN` constant.**

Holding `LEN` constant is what makes this work without any resize machinery:
a field added this way changes no existing byte offset and leaves every
deployed account already the right size. There is deliberately **no resize /
migration instruction** — one existed and was removed, because it had no
reachable target and no test coverage. Should
`reserved` ever be exhausted on a live deployment, a resize path would have to
be reintroduced against the struct shape of that day rather than a guessed one.

The `PsmConfig` PDA holds mint, freeze and ScaledUiAmount authority; its seed
string is defined once as `PsmConfig::SEED` and mirrored for clients in
`scripts/utils/pdaHelpers.ts`.

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

### Yield (streaming rate schedule)

```rust
// Set the active per-second rate and its bounded window — REBASER only.
// EVM: OkuMoney.setOkuMYieldRate
pub fn set_okum_yield_rate(new_rate: u64, end_timestamp: i64)

// Pre-stage the successor that takes over at `okum_rate_end` with NO
// transaction at the boundary — REBASER only.
// EVM: OkuMoney.setNextOkuMYieldRate
pub fn set_next_okum_yield_rate(new_rate: u64, pending_end_timestamp: i64)

// Both atomically. This is what the epoch orchestrator uses.
// EVM: OkuMoney.setOkuMYieldRateWithSuccessor
pub fn set_okum_yield_rate_with_successor(
    new_rate: u64, end_timestamp: i64, next_rate: u64, next_end_timestamp: i64)

// EMERGENCY ONLY: force the multiplier and halt the schedule — REBASER only.
// The one instruction that produces a discrete jump, and therefore the only
// one that stamps the sandwich lock.
// EVM: OkuMoney.setOkuMMultiplier
pub fn set_okum_multiplier(new_multiplier: u128)

// Refresh the wallet display mirror. PERMISSIONLESS — the value written is
// fully determined by on-chain state. No EVM counterpart.
pub fn sync_display_multiplier()
```

Rates are WAD-scaled (1e18), identical to EVM. `distribute_yield` no
longer exists: under rear-facing epochs the operator measures realised
yield off-chain and publishes a *rate*, so there is no on-chain
"distribute N dollars" primitive.

Only `set_okum_multiplier` stamps `last_yield_distribution_slot`.
Routine accrual produces no discrete jump to sandwich, and the display
sync deliberately does not stamp it — doing so would make the PSM
unavailable for one slot per sync interval for no security benefit.

The multiplier is computed from the rate schedule by
`helpers::multiplier::current` (`helpers/multiplier.rs`), which projects
`PsmConfig`'s six schedule fields into `oku_shared::rate::Schedule` and
compounds against `Clock::unix_timestamp`. **That is the only path for reading
the current multiplier.** It does not touch the mint's `ScaledUiAmountConfig`
extension, and there is no duplicate multiplier field on `PsmConfig`.

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

All protected by yield-lock. `min_usdc_out` is slippage protection —
pass `0` to disable the check.

**Why this exists when the multiplier is monotonic.** Slippage is not
structurally reachable here any more than on EVM — the rate floor
(`rate >= PRECISION`, `instructions/yield_ops.rs`) and the emergency
override's strictly-increasing check (`MultiplierCannotDecrease`) mean the
multiplier never moves against a redeemer between quote and execution.
`min_usdc_out` is kept as defense-in-depth (see the NatSpec on
`redeem_oku_m` in `instructions/psm.rs`), not because a real price-movement
risk exists. EVM's `LitePSM.redeemOkuM` has no equivalent parameter for
exactly that reason — see `EVM/README.md § LitePSM.sol` for the full
argument, including the one precondition (no PSM fee) it depends on.

The one genuine platform difference: Solana has no view functions, so
there is no `okuMMultiplier()`-style call a client can make to observe
on-chain pricing directly the way it can on EVM. `min_usdc_out` gets
reused for exactly that gap — `scripts/test/test-devnet.ts`'s redeem step
derives its floor from an independent TypeScript mirror of the multiplier
math and passes it in, turning every redeem into a live Rust-vs-TS
differential check: if the on-chain accrual path disagrees with the TS
reference beyond a small tolerance, the transaction reverts on-chain
instead of silently succeeding at the wrong price. Every other caller
(`scripts/admin/redeem-oku-m.ts`, the bankrun suite) passes `0`.

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
const PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18 (WAD) — identical to EVM

// The multiplier is COMPUTED, not stored: a pure function of the six-field
// rate schedule on PsmConfig plus Clock::unix_timestamp.
// Token amounts remain u64 (6 decimals). Multipliers and rates are u128/u64
// at WAD scale. All multiplier math carries a 256-bit intermediate.
// Rounding favours the protocol (floor) everywhere except rpow, which
// reproduces MakerDAO's half-up.
```

**Why 1e18 and not a narrower scale.** A `u64`-friendly `PRECISION = 1e9`
would keep `raw_amount x multiplier` inside `u128`, and that is sufficient for
a *static* multiplier bumped in discrete ticks. It is fatal for a per-second
rate:

```text
one ulp of a per-second rate at 1e9  = 3.20385 % APY
one ulp of a per-second rate at 1e18 = 0.00000000315 % APY
```

At 1e9 the smallest expressible non-zero yield rate is over **3% APY** — the
rate schedule is not merely imprecise at that scale, it is inexpressible. 1e18
is therefore forced by the streaming model, not chosen for elegance. It also
buys cross-stack parity: because `PRECISION`, `MAX_RATE` and the `rpow`
rounding match EVM exactly, a schedule broadcast to every chain produces a
**bit-identical** multiplier at the same wall-clock second, with no messaging.

**The cost.** Every multiplier-bearing value is `u128` rather than `u64`, and
`raw_amount x multiplier` (up to ~1.8e43) does not fit `u128`. Multiplier math
routes through
[`crates/oku-shared/src/wad.rs`](oku-programs/crates/oku-shared/src/wad.rs),
which carries a full 256-bit intermediate — `full_mul` plus a
small-divisor long division, the same decomposition OpenZeppelin's
`Math.mulDiv` implements. Because `1e18 < 2^60` the divisor fits a
`u64`, so this is *not* general bignum division.

**Compute cost is real and was measured, not estimated.** The multiplier
is computed on every mint and redeem; `rpow` runs ~20-25 squaring
iterations. See § Compute budget below — the first implementation cost
over 150k CU and exceeded Solana's 200k limit outright after an epoch
handover.

**Agreement with the other two implementations is enforced, not assumed.**
`compute_multiplier` exists in Solidity, Rust and TypeScript, and nothing
on-chain on either stack can detect a divergence. A committed corpus of
3,867 vectors is generated from the Solidity reference and replayed
against the other two, reverts included:

```bash
npm run test:differential   # from the repo root
```

See `EVM/test/differential/GenerateVectors.t.sol`.

**f64 for ScaledUiAmount.** The Token-2022 extension stores an IEEE 754
`f64`. It is a **write-only display mirror** — the program pushes to it
and never reads it back, so its precision is a display concern only. The
conversion is biased ~4.4e-16 downward to keep `display <= canonical`;
at 6 token decimals that bias cannot change a rendered figure below
roughly $2.3B of balance, and costs under a cent even at the largest
position a `u64` can express.

**The mirror is a pure lag.** Each sync writes exactly one point —
`m(now)`, effective immediately — so the display is flat between cranks
and steps up at each one, never ahead of a monotonically-increasing
curve. `display <= canonical` therefore holds **unconditionally**.

Deliberately **no pre-armed second step.** Arming `m(now + 60s)` would keep
the display advancing if the crank stopped, but a step armed under one
schedule fires under whatever schedule is live when its timestamp arrives —
so after a rate *decrease* (routine at an epoch roll) the armed value lands
**above** the new canonical. Small ($0.25 per $1M on a 20%→5% roll) and
self-correcting, but the wrong direction. Writing one point keeps the
invariant unconditional, halves the crank cost, and avoids depending on
Token-2022's future-timestamp resolve semantics.

The crank cadence is **not a protocol constant** — nothing on-chain
enforces or assumes one. 60s is the operational recommendation.

---

## Compute budget

Measured in `tests/bankrun/compute-budget.ts` and pinned there, so a
regression fails CI rather than surfacing in production.

| Path | CU |
|---|---|
| `mint_oku_m` (7-day window) | ~53,000 |
| `mint_oku_m` (90-day window) | ~62,000 |
| `mint_oku_m` (two-`rpow` overhang branch) | ~81,000 |
| `redeem_oku_m` (two-`rpow` overhang branch) | ~74,000 |
| `set_okum_yield_rate_with_successor` | ~6,800 |
| `sync_display_multiplier` (1 CPI) | ~54,000 |

The overhang branch — active window closed, successor running — is the
normal state of every chain between a handover and the next schedule
write, so it is the number that matters, not the best case.

Two things were necessary to get here:

1. `wad.rs` types its limbs `u64` and widens at the multiply, so LLVM
   emits native 64x64→128 multiplies instead of `__multi3` libcalls, and
   takes a fast path (one multiply, one division) whenever the product
   fits `u128` — which covers essentially every real operation.
2. `mint_oku_m` / `redeem_oku_m` carry **no opportunistic display sync**. A
   piggybacked refresh costs ~31k CU for a cosmetic update on an
   already-tight path.
3. The display mirror writes **one point per sync**, not two, which halves
   `sync_display_multiplier` (103,753 → 54,309 CU). That is a correctness
   decision that happens to pay for itself — see § Precision model.

**Operational consequence of (2):** display freshness is entirely the
permissionless crank's job. An idle PSM with nobody running
`scripts/admin/sync-display.ts` shows a stale balance. This is bounded and
safe in one direction only — the mirror reads **low**, never high, so a redeem
always pays at least what the wallet showed — but it is an operational
responsibility rather than a self-maintaining property. The crank needs no key
material, so it can run anywhere the deployment is already monitored.

**Why the program computes `rpow` at all, rather than verifying a
backend-signed `(multiplier, timestamp)` quote** — which would cut the hot path
to ~5k CU. A quote valid for *N* seconds is a free option: hold it, submit when
favourable, discard otherwise. That hands back exactly the MEV the streaming
design removes, and adds replay/expiry/nonce handling that is subtler than the
arithmetic it replaces. It would also make every mint and redeem depend on
backend liveness, precisely on the day everything else is going wrong. The
compute saving buys nothing: ~80k against a 200k limit. The multiplier is
on-chain because the PSM must price **atomically inside the user's own
transaction**, and a Solana instruction cannot call out mid-execution.

## Hardcoded constants

Shared protocol constants live in
[`crates/oku-shared/src/constants.rs`](oku-programs/crates/oku-shared/src/constants.rs);
program-specific constants live in the program's own `constants.rs`.
None can be changed without a program upgrade.

### Shared (`oku-shared`)

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1_000_000_000_000_000_000` (1e18, WAD) | Fixed-point base for multipliers and per-second rates. **Byte-identical to EVM `Constants.PRECISION`** — that equality is what makes cross-chain agreement work without messaging. |
| `MAX_RATE` | `PRECISION + 1e11` (~2242% APY) | Sanity bound on `rpow` inputs. Mirrors EVM `Constants.MAX_RATE`. |
| `MAX_MULTIPLIER` | `1_000_000_000_000_000_000_000_000` (1e24, = $1M/token) | Math-sanity bound. `compound_for` CLAMPS here; the emergency override REJECTS above it. Mirrors EVM `Constants.MAX_MULTIPLIER`. |
| `TOKEN_DECIMALS` | `6` | OkuM uses 6 decimals on SVM (matches USDC). Asserted at init. **Unrelated to `PRECISION`** — token decimals govern raw balances, `PRECISION` governs multiplier/rate fixed-point. Do not conflate them. |

### Lite-PSM

`lite-psm/src/constants.rs` re-exports the shared constants from
`oku-shared` and defines the on-chain OkuM metadata identity
(`OKU_M_METADATA_NAME` / `OKU_M_METADATA_SYMBOL`).

---

## Authority model

**Canonical: [`../AUTHORITY-MATRIX.md`](../AUTHORITY-MATRIX.md)** — every
role-gated instruction with its guard, blast radius and reversibility, plus the
EVM↔SVM authority asymmetries a reviewer should not mistake for bugs.

The SVM-specific *mechanism*, which the matrix assumes rather than explains:
roles are **pubkey fields on the `PsmConfig` PDA**, enforced by Anchor
`has_one` constraints — not an `AccessControl` mapping. There is no role
enumeration and no grant/revoke events; rotation is `set_authority` by
`role_admin`, and `role_admin`'s own transfer is a two-step
propose/`accept_role_admin` handshake so a typo cannot strand the meta-role.

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

### Two binding authority constraints at init

`initialize` enforces two rules that, taken together, force the deployer
and the operational roles onto **different keys**:

1. **`role_admin` must be the BPF upgrade authority.** `contexts/init.rs`
   constrains `program_data.upgrade_authority_address ==
   Some(role_admin.key())`. The account that signs `initialize` and becomes
   `config.role_admin` is therefore always the deploying wallet. This also
   stops a third party racing to claim the config PDA.
2. **No granular authority may equal `role_admin`** (nor the zero pubkey).
   `instructions/init.rs` checks all 9 — `pauser`, `unpauser`, `freezer`,
   `unfreezer`, `buffer_depositor`, `buffer_withdrawer`, `cap_manager`,
   `allowance_manager`, `rebaser` — mirroring `set_authority`'s
   separation-of-duties guard in `psm_admin.rs`.

So on devnet/localnet the deployer holds `role_admin` and a **separate,
locally-held operator key** (`keys/devnet-authority.json`, gitignored)
holds all 9 granular roles. One key still signs every operational call
during smoke testing, so the convenience of the old single-key setup is
preserved; the deployer keeps unconditional claw-back via `set_authority`.
`direct_minter` / `direct_burner` sit on a third key (the delegate EOA) —
they model an external fiat/bridge operator and are wired by
`grant-roles.ts`.

Generate and fund the operator key before the first deploy:

```bash
solana-keygen new --outfile keys/devnet-authority.json
solana transfer $(solana-keygen pubkey keys/devnet-authority.json) 0.5 \
    --url devnet --allow-unfunded-recipient
```

Override the path with `DEVNET_AUTHORITY_PATH` if CI stages it elsewhere.

> **Trap:** pointing any of the 9 granular roles at the deployer makes
> `initialize` revert with `InvalidAuthority` (6024) and the deploy cannot
> complete at all. `scripts/config/authorities.ts` must keep them on the
> operator key.

---

## Error codes

Full list (26 variants) in `programs/lite-psm/src/errors.rs`. Key errors:

- `YieldDistributionInProgress` — operation blocked during yield lock.
- `MultiplierCannotDecrease` — ScaledUiAmount multiplier is monotonically increasing.
- `InsufficientUserBalance` — user balance shortfall on redeem.
- `InsufficientBuffer` — PSM USDC vault can't cover a redeem or withdraw_buffer.
- `ZeroOutput` — redeem output rounds down to zero.
- `SlippageExceeded` — redeem output is below the caller's `min_usdc_out` floor.
- `InvalidRate` / `RateTooHigh` — rate outside `[PRECISION, MAX_RATE]`.
- `EndTimestampInPast` / `EndTimestampNotAllowed` — window rails.
- `NoRateEndSet` / `RateAlreadyExpired` / `PendingEndNotAfterRateEnd` — successor rails.
- `Paused` — operation attempted while system is paused.
- `Unauthorized` — caller lacks the required role.

---

## Accepted Risks

Trust assumptions and design decisions the SVM side makes
deliberately. A third-party reviewer or auditor should not re-flag
these; they are the considered output of design discussion.

### 1. Operator-compromise is out of scope

The threat model does NOT include "what if the cold multisig is malicious" —
see [`../README.md` § Signer trust implications](../README.md#signer-trust-implications)
for the model that applies to both stacks. SVM-specific consequence: guards
like `MAX_MULTIPLIER` and the per-role allowance caps are **math-sanity
bounds** (keeping the widening-multiply paths in the overflow-safe region, and
stopping operator typos), not defence against a compromised rebaser key.

### 2. No on-chain Proof-of-Reserves or oracle

Same posture as EVM (see `EVM/README.md` Accepted Risk 3): no PoR feed and no
USDC-peg circuit-breaker on-chain. A PoR feed controlled by the operator cannot
detect operator-side reserve fraud, and depeg handling is a monitoring concern.
`lite-psm` carries no oracle relay and no storage reserved for one.

### 3. Buffer-only PSM (no redemption queue)

A redeem the buffer cannot cover **reverts** rather than being escrowed. This
is a deliberate divergence from EVM, not a parity gap — rationale in § Why no
redemption queue. The accepted consequence: redemption availability is an
operational property (keep `vault_usdc` topped up), not a protocol guarantee.

### 4. SVM ↔ EVM constant parity

`PRECISION` (1e18), `MAX_RATE`, `MAX_MULTIPLIER` (1e24) and the `rpow`
rounding are **byte-identical** across the two stacks, which is what lets a
single broadcast schedule produce the same multiplier everywhere with no
messaging. There is no constant-scale divergence.

What genuinely remains is narrower:

- `rpow`'s overflow threshold differs in the far tail: EVM reverts when an
  intermediate *product* exceeds `uint256`; SVM returns `None` when a
  *quotient* exceeds `u128`, and the Rust bound binds first. Both sit ~17
  orders of magnitude outside the reachable domain — proven by the
  `reachability` test module in `oku-shared/src/rate.rs`.
- `Clock::unix_timestamp` can lag wall clock. Because the multiplier is a pure
  function of it, this is a self-correcting lag, not a drift — but drift
  monitoring must compare at equal *chain* timestamps.
- Wallet *display* still steps, because `ScaledUiAmount` cannot stream.

---

## Testing

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
the streaming-accrual and display-mirror tests will fail with an
"invalid instruction" error from the Token-2022 program.

### Suites

The bankrun suite is **124 tests** (`npm run test:bankrun`); the pure-Rust
suite is **60** (`npm run test:rust`). `npm test` runs both. The cross-language
agreement of `compute_multiplier` is enforced separately by the 3,867-vector
differential corpus (`npm run test:differential` from the repo root).

`tests/bankrun/streaming-accrual.ts` covers the model:

- The multiplier advances with **no transaction** as time passes
- A pre-staged successor activates at `rateEnd` with **no transaction**
- Accrual **halts** at `rateEnd` / `pendingRateEnd` when unattended —
  a missed epoch stops paying rather than running on or diverging
- Redeem payout tracks the streamed multiplier exactly
- On-chain state matches the TypeScript mirror across both boundaries
- Every write rail: sub-PRECISION rate, above `MAX_RATE`, yielding rate
  without a window, halted rate with one, successor against an expired
  or missing window, non-rebaser
- Pause gate blocks rate increases but permits decreases and halts

`tests/bankrun/display-mirror.ts` covers the mirror:

- `display <= canonical` across a full sync interval, unconditionally
- Permissionless cranking
- A single point written per sync (no pre-armed second step)
- The sync NOT stamping the sandwich lock
- The emergency override force-syncing the display

`tests/bankrun/config-layout.ts` pins `PsmConfig`'s total size and the byte
offsets of the accrual block, decoding a real account with the exact offsets
`EVM/scripts/utils/svmValue.ts` uses and comparing against Anchor's own
decoding — so a field reorder cannot silently mis-size the global V(t).

The `readMultiplierFromMint()` helper in the test shared code reads
the `ScaledUiAmountConfig` extension directly from a mint account's
data, parsing the TLV structure to extract the f64 multiplier — i.e. it reads
the *display mirror*. For the CANONICAL value use
`computeCanonicalMultiplier()`, which recomputes from the rate schedule via
`packages/yield-tooling` (`@okumoney/yield-tooling`, the same TypeScript
implementation held bit-identical to the Solidity and Rust ones by the
differential corpus).

### Runner notes

The entire unit suite runs on
[`solana-bankrun`](https://github.com/kevinheavey/solana-bankrun)
via the thin `anchor-bankrun` adapter — in-process BPF execution on
`litesvm`, so there is no confirmation-polling window and no wall-clock wait
for slot rollover.

**`autoBumpSlot` (default on).** `startBankrun()` wraps
`provider.sendAndConfirm` so every transaction advances the bankrun
slot by 1 before submission. This handles two unrelated annoyances:

- `check_yield_lock` rejects any op in the same slot as the last
  `set_okum_multiplier` — without auto-bump, any
  test ordering that follows a yield op hits `YieldDistributionInProgress`.
- Bankrun caches identical-byte transactions and replays the prior
  result ("This transaction has already been processed") — auto-bump
  forces a fresh blockhash on every submission.

Tests needing strict slot semantics pass
`startBankrun({ autoBumpSlot: false })` and call `warpSlots(h, n)`
explicitly.

---

## Deployment

> **The deployment runbook — prerequisites, Surfpool fork pre-flight, the
> two-phase `deploy:programs` → `deploy:init` sequence, stale-deployment
> recovery, verification smoke, and the mainnet upgrade-authority ceremony —
> is documented once for both stacks in
> [`../README.md` § Deployment runbook`](../README.md#deployment-runbook).**

SVM-specific gotchas not covered there are the two binding authority
constraints at init (below) and the `Anchor.toml [programs.<network>]` /
`deployments/<network>.json` mismatch warning.

---

## Runbook (SVM-specific)

### Pre-mainnet checklist

- [ ] `MAINNET_ORCHESTRATOR` env var points at a KMS-backed signer, not the deployer wallet.
- [ ] BPF loader upgrade authority transferred to the cold multisig.
- [ ] `Anchor.toml [programs.<network>]` matches the freshly-deployed program ID (`4k5gmUhtp3XqW2zf3XzdquMTSyMVfgA5TubuinTSUjNN`).
- [ ] Token-2022 binary override applied if bankrun tests are part of CI (`make fetch-token-2022`).

### Delegated operation vs. retained ownership (devnet/testnet)

On mainnet, roles map to the Squads multisig tiers per the Authority
model table above. On devnet/testnet it's common to delegate
day-to-day operation of the app to a coworker or CI-owned key (the
"delegate") while governance retains ownership.

On devnet the starting point is the two-key split described under
[Initialization](#two-binding-authority-constraints-at-init): deployer =
`role_admin`, operator key = the 9 granular roles. `grant-roles.ts` then
moves the 4 *operational* roles onto the delegate EOA. Note the ordering
consequence: once `rebaser` and `buffer_depositor` have moved to a
delegate you do not hold, `npm run test:onchain` can no longer run its
`streamingAccrual` and `redeem` steps. **Run the smoke test before
`grant-roles`**, or claw the roles back first with `set-authority.ts`
(`role_admin` can do this unilaterally, in one tx per role).

The rule of thumb:

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

In v1 the orchestrator holds a single Solana keypair granted
`buffer_depositor`, `rebaser`, `direct_minter` and `direct_burner`, plus the
matching EVM EOA (`PSM_BUFFER_DEPOSITOR`, `PSM_QUEUE_PROCESSOR`,
`OKUM_REBASER` — SVM has no queue-processor equivalent). Both KMS-backed.
Cross-chain settlement on the SVM side is `burn_oku_m_direct` /
`mint_oku_m_direct`. There is no on-chain bridge state, chain whitelist, nonce
or refund flow; all coordination is off-chain.

A future on-chain bridge (NTT, CCIP, native OkuBridge port) would add a
separate signing scheme — out of v1 scope.

### Buffer discipline

- Keep `vault_usdc.amount` topped up via `deposit_buffer` so
  `redeem_oku_m` always succeeds for expected redemption volume.
- Monitor buffer balance against a rolling estimate of daily
  redemption volume; alert well before it's depleted (thresholds:
  [`../README.md` § Monitoring SLAs](../README.md#monitoring-slas)).
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
| `admin:set-yield-rate` | `set_okum_yield_rate` / `_next_` / `_with_successor` | `rebaser` |
| `admin:read-schedule` | (read-only) | none — exits non-zero if accrual has HALTED |
| `admin:sync-display` | `sync_display_multiplier` | none — permissionless |
| `admin:freeze-account` / `admin:thaw-account` | `freeze_account` / `thaw_account` | `freezer` / `unfreezer` |
| `admin:deposit-buffer` / `admin:withdraw-buffer` | `deposit_buffer` / `withdraw_buffer` | `buffer_depositor` / `buffer_withdrawer` |
| `admin:close-programs` | `solana program close` (BPF loader) — recover rent from stale program deployments. | BPF upgrade authority (deployer wallet) |

---

## EVM vs SVM — divergence catalogue

This section catalogues SVM-specific deliberate departures from the
EVM implementation. See the EVM-side mirror in
[`../EVM/README.md`](../EVM/README.md) for the symmetric perspective.

### Workspace layout — where the EVM libs went

EVM groups protocol-wide invariants into `EVM/src/lib/`:

| EVM file | SVM equivalent |
|---|---|
| `lib/Constants.sol` | `crates/oku-shared/src/constants.rs` |
| `lib/MathLib.sol` | `crates/oku-shared/src/math.rs` |
| `lib/YieldSandwichGuard.sol` | `crates/oku-shared/src/yield_lock.rs` + `lite-psm/src/helpers/yield_lock.rs` wrapper |
| `lib/Roles.sol` | `programs/lite-psm/src/roles.rs` (single program owns all RBAC) |
| `lib/Errors.sol` | `programs/lite-psm/src/errors.rs` |
| `lib/events/*.sol` | `programs/lite-psm/src/events.rs` |
| `lib/ReentrancyGuardUpgradeable.sol` | not ported — Solana's account-lock model + no fallback fns means reentrancy isn't reachable the same way |

### Single-token architecture

EVM has two tokens; SVM has one. Raw `OkuM` balances are static (like EVM
`OkuMoney`); displayed dollar values scale with the multiplier (like EVM
`OkuDollar`). Rationale and consequences: § Why a single token on SVM.

### Where the canonical multiplier lives — NOT a divergence

On both stacks it is **computed**, never stored: EVM's
`OkuMoney.okuMMultiplier()` and SVM's `helpers::multiplier::current` are the
same `rpow` accumulator over the same six schedule fields at the same
`PRECISION = 1e18` (`oku-shared/src/rate.rs` is a line-for-line port of
`MathLib.sol` over a 256-bit `mul_div`). Identical schedule state returns
bit-identical multipliers on both.

The genuine divergence is only in **display**. EVM exposes the streamed value
directly through `OkuDollar`'s rebasing `balanceOf()`. SVM cannot: the
Token-2022 `ScaledUiAmount` extension stores a flat `f64` scalar with no
per-second compounding, so it is maintained as a write-only, lagging mirror
that nothing prices against. There is no multiplier field on `PsmConfig` and
no read path from the extension.

### No `distributeYield` on either stack

Neither stack has a "distribute N dollars" primitive. Such a call must divide
by local supply, which produces a different multiplier delta per chain — the
exact cross-chain divergence the streaming model exists to remove. Dollars→rate
conversion is off-chain, against a *global* value, on both sides.

### Pause-bypass deltas

| Operation | EVM | SVM |
|---|---|---|
| `freeze_account` / `thaw_account` | bypasses pause (Token-2022 freeze authority independent of `Pausable`) | bypasses pause (Token-2022 freeze CPI signed by config PDA; pause check intentionally omitted) |
| `processQueue` when paused | proceeds — pause must not lock users in the queue | N/A — SVM has no queue |

### Bridging model asymmetry

| Aspect | EVM | SVM |
|---|---|---|
| Bridge mechanism | PSM-mediated USDC flow (`mint` / `redeem`) | Direct raw-amount `burn_oku_m_direct` / `mint_oku_m_direct` |
| USDC intermediate | yes | no |
| Multiplier during bridge | not applicable (USDC is 1:1) | raw amounts conserved; multiplier synced separately by rebaser |

The orchestrator handles this asymmetry transparently.

### DeFi compatibility

The single-token SVM design is the one with better native composability:
raw balances are static, so standard AMM pools work without a wrapper.
Raydium's CPMM/CLMM explicitly allow `ScaledUiAmount` tokens and Jupiter
routes through them natively. EVM's rebasing `usdOku` needs a wrapper or
custom pool logic, which is why `OkuMoney` (non-rebasing) is the asset to
integrate against there.

### Round-trip drift

PSM mint/redeem rounding direction is identical on both sides
(round down, favouring the protocol). End-to-end USDC → OkuM → USDC
round-trips lose at most 1 wei (EVM) / 1 micro-USDC (SVM) of dust
per round-trip from integer-division truncation.

### Programs that exist on one side only

| Component | EVM | SVM | Notes |
|---|---|---|---|
| `OkuMoney` (ERC-20) | yes | no | SVM uses single `OkuM` token |
| `OkuDollar` (rebasing vault) | yes (separate contract) | no | SVM uses `ScaledUiAmount` instead |
| `OkuM` (Token-2022 + ScaledUiAmount) | no | yes | SVM-only single token |
| `LitePSM` | yes (`EVM/src/psm/LitePSM.sol`) | yes (`programs/lite-psm`) | parity (different token model) |
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
