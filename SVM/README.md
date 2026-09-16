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
the scaled figure).

**The mint extension is NOT the source of truth.** It used to be. Since
the streaming-accrual port it is a **write-only display mirror**: the
program pushes values into it for wallets to render and never reads
them back. The canonical multiplier is computed on read from the rate
schedule on `PsmConfig` — see § Streaming accrual below.

The reason is structural. `ScaledUiAmountConfig::current_multiplier()`
is a step function with exactly one pre-armable future step, so it
cannot represent a continuously-accruing value. The extension that
*can* (`InterestBearingConfig`) is mutually exclusive with it on-chain
(`spl-token-2022-interface` `extension/mod.rs:1359-1361`) and would
cost the bounded rate window, the pre-staged successor, and the ability
to re-anchor — three correctness properties traded for one cosmetic
one.

`helpers/scaled_ui.rs` and its `read_multiplier()` were deleted with
the port, taking the zero-init edge case with them.

**f64 precision characteristics.** The `ScaledUiAmountConfig`
extension stores the multiplier as an IEEE 754 `f64`. f64 has ~15.9
significant decimal digits; for practical stablecoin multipliers
(1.0 to ~2.0 over years of yield), this provides sub-nano-dollar
precision. The `MAX_MULTIPLIER` constant documents the upper bound
where precision degrades, but the practical operating range is well
within f64's capabilities.

**Continuous accrual, discrete display.** The canonical multiplier
compounds every second with no transactions at all. The display mirror
is a staircase refreshed roughly every 60 seconds by a permissionless
crank, always at or below the canonical value — so a redeem pays at
least what the wallet showed. At 20% APY the under-read is about $0.35
per $1,000,000.

**DeFi compatible by construction.** Raw token amounts are static —
AMMs, lending protocols, and orderbooks operate on raw balances that
never change from yield accrual. UI amounts (dollar values) are
derived from the `ScaledUiAmount` extension. Raydium CPMM/CLMM
explicitly allow `ScaledUiAmount` tokens; Jupiter routes through
them natively.

**Single-slot sandwich lock.** Only `set_okum_multiplier()` (the
emergency override) sets `last_yield_distribution_slot =
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
      lib.rs                       # 21 instruction entry points
      state.rs                     # PsmConfig only (seed: psm_config, 562B) —
                                   # no RedemptionQueue account; buffer-only PSM
      errors.rs                    # 26 error variants
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
  bankrun/                  # Default in-process suite (npm test, 94 bankrun tests)
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
}
```

`PsmConfig` is the only state account. Its byte length is pinned at 562
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

The multiplier is computed from the rate schedule via `helpers::multiplier`
(in `helpers/multiplier.rs`), which calls
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

All protected by yield-lock. `min_usdc_out` is slippage protection —
pass `0` to disable the check.

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

**Why 1e18, and why it used to be 1e9.** This crate previously used
`PRECISION = 1e9`, on the reasoning that `u64` token amounts times 1e9
peak around `1.8e28` and stay comfortably inside `u128`. That reasoning
was sound for a *static* multiplier an operator bumped in discrete
ticks. It is fatal for a per-second rate:

```text
one ulp of a per-second rate at 1e9  = 3.20385 % APY
one ulp of a per-second rate at 1e18 = 0.00000000315 % APY
```

At 1e9 the smallest expressible non-zero yield rate is over **3% APY**.
The rate schedule is not merely imprecise at that scale — it is
inexpressible. Moving to 1e18 was therefore forced by the streaming
model, not chosen for elegance.

It also buys something the old scale could not: because `PRECISION`,
`MAX_RATE` and the `rpow` rounding now match EVM exactly, a schedule
broadcast to every chain produces a **bit-identical** multiplier at the
same wall-clock second, with no messaging.

**The cost.** Every multiplier-bearing value widened from `u64` to
`u128`, and `raw_amount x multiplier` (up to ~1.8e43) no longer fits
`u128`. Multiplier math routes through
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
3,290 vectors is generated from the Solidity reference and replayed
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
| `sync_display_multiplier` (2 CPIs) | ~104,000 |

The overhang branch — active window closed, successor running — is the
normal state of every chain between a handover and the next schedule
write, so it is the number that matters, not the best case.

Two things were necessary to get here:

1. `wad.rs` types its limbs `u64` and widens at the multiply, so LLVM
   emits native 64x64→128 multiplies instead of `__multi3` libcalls, and
   takes a fast path (one multiply, one division) whenever the product
   fits `u128` — which covers essentially every real operation.
2. The opportunistic "piggyback" display sync was **removed** from
   `mint_oku_m` / `redeem_oku_m`. It cost ~31k CU for a cosmetic refresh
   on an already-tight path.

**Operational consequence of (2):** display freshness is now entirely the
permissionless crank's job. An idle PSM with nobody running
`scripts/admin/sync-display.ts` shows a stale balance. This is bounded and
safe in one direction only — the mirror reads **low**, never high, so a redeem
always pays at least what the wallet showed — but it is an operational
responsibility rather than a self-maintaining property. The crank needs no key
material, so it can run anywhere the deployment is already monitored.

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
| `BASIS_POINTS` | `10_000` | Universal bps denominator. Unused on-chain; retained for EVM constant parity. |
| `MAX_MULTIPLIER` | `1_000_000_000_000_000_000_000_000` (1e24, = $1M/token) | Math-sanity bound. `compound_for` CLAMPS here; the emergency override REJECTS above it. Mirrors EVM `Constants.MAX_MULTIPLIER`. |
| `TOKEN_DECIMALS` | `6` | OkuM uses 6 decimals on SVM (matches USDC). Asserted at init. Unrelated to `PRECISION` — these were confusingly adjacent at the old 1e9 scale and are now unambiguously distinct. |

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
| `rebaser` | Orchestrator (KMS) | Publish the rate schedule; emergency multiplier override | Rates must be >= PRECISION (monotonic) and <= `MAX_RATE`; yielding rates must carry a bounded future window. Override is strict-increase, capped at `MAX_MULTIPLIER`, and self-fenced. |
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

### 4. SVM ↔ EVM constant parity — RESOLVED

This entry used to record SVM's `PRECISION = 1e9` against EVM's 1e18 as
a permanent, structural divergence, justified by `u64` token amounts.

It is gone. SVM now uses 1e18, because the streaming rate schedule is
inexpressible at 1e9 (one ulp = 3.2% APY). `PRECISION`, `MAX_RATE`,
`MAX_MULTIPLIER` and the `rpow` rounding are now byte-identical across
the two stacks, which is what lets a single broadcast schedule produce
the same multiplier everywhere with no messaging.

What genuinely remains is narrower and documented in
[`DECISIONS.md`](DECISIONS.md):

- **D-04** `rpow`'s overflow threshold differs in the far tail (EVM
  reverts when an intermediate *product* exceeds `uint256`; SVM returns
  `None` when a *quotient* exceeds `u128`). Both sit far outside the
  reachable domain.
- **D-03** `Clock::unix_timestamp` can lag wall clock. Because the
  multiplier is a pure function of it, this is a self-correcting lag,
  not a drift — but drift monitoring must compare at equal *chain*
  timestamps.
- Wallet *display* still steps, because `ScaledUiAmount` cannot stream.

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

### Streaming-accrual test suites

`tests/bankrun/streaming-accrual.ts` (18 tests) covers the model:

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

`tests/bankrun/display-mirror.ts` (8 tests) covers the mirror:

- `display <= canonical` across a full sync interval
- Permissionless cranking
- The pre-armed step advancing with no further transaction
- The sync NOT stamping the sandwich lock
- The emergency override force-syncing, leaving no stale armed step

`rate-over-time.ts` and `scaled-ui-amount.ts` were deleted as
superseded. The former is worth noting: its central assertion was that
wall-clock progression alone does *not* move the multiplier. That was
correct for the discrete model and is now exactly backwards.

The `readMultiplierFromMint()` helper in the test shared code reads
the `ScaledUiAmountConfig` extension directly from a mint account's
data, parsing the TLV structure to extract the f64 multiplier. This
mirrors `ScaledUiAmountConfig::current_multiplier()`. For the CANONICAL
value use `computeCanonicalMultiplier()`, which recomputes from the rate
schedule via `scripts/utils/multiplier.ts`.

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
| `lib/SafeApprove.sol` | not ported — SPL Token-2022 doesn't have the EIP-20 allowance-zeroing footgun |
| `lib/ReentrancyGuardUpgradeable.sol` | not ported — Solana's account-lock model + no fallback fns means reentrancy isn't reachable the same way |

### Single-token architecture

EVM has two tokens: `OkuMoney` (non-rebasing, stored price) and
`OkuDollar` (rebasing wrapper vault). SVM has a single token:
`OkuM`, which is a Token-2022 mint with the `ScaledUiAmountConfig`
extension. Raw balances are static (like EVM OkuMoney); displayed
dollar values scale with the multiplier (like EVM OkuDollar).

This eliminates the need for wrap/unwrap, the vault program, dead
shares, collateral ratios, and the two-program CPI chain.

### ScaledUiAmount vs stored price

EVM stores `okumPrice` as a `uint256` in the PSM contract storage.
SVM stores the multiplier as an `f64` in the Token-2022
`ScaledUiAmountConfig` extension on the mint itself. There is no
PsmConfig field for the price — the mint extension is the single
a WRITE-ONLY display mirror. The canonical multiplier is computed from
the `PsmConfig` rate schedule; nothing reads the extension back.

### Rebasing model

EVM `OkuMoney` accrues USD yield continuously between calls via
`MathLib.rpow`. SVM now uses the SAME `rpow`, ported line-for-line into
`oku-shared/src/rate.rs` over a 256-bit `mul_div`, so both stacks return
bit-identical multipliers from identical schedule state.
by the orchestrator. Solana's Token-2022 `ScaledUiAmount` extension
stores a flat scalar (no per-second compounding), so wallets cannot
show continuously-growing balances. Discrete updates are
economically identical between orchestrator calls.

### `distributeYield` zero-yield guard

Both EVM and SVM reject a `yieldAmount` / `yield_amount` that
truncates to zero per token. Without this guard, a sub-threshold
yield call would stamp `lastYieldDistributionBlock` /
`last_yield_distribution_slot` without actually moving the
multiplier, wasting the sandwich-lock window for the entire
block/slot.

- EVM: `OkuMoney.distributeYield` reverts `YieldTooSmall()`.

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
  `OKUM_REBASER` (and a separate EVM owner key for relevant LitePSM
  admin actions). SVM has no queue-processor equivalent.

Both KMS-backed. No on-chain bridge state, no chain whitelist, no
nonces, no refund flow — all cross-chain coordination is off-chain.

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
