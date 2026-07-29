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

### Cross-chain transfers (noBridge model, v1)

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

### The platform constraint

Solana's SPL Token program stores balances as a literal `u64` in each
token account. There is no `balanceOf()` override -- programs and
wallets read `token_account.amount` directly. This means **true
on-chain rebasing is impossible on SVM**. No mechanism exists to make
stored balances grow over time without explicit mint/burn/transfer
instructions.

On EVM, projects like Lido (stETH), Mountain Protocol (USDM), and
Ondo (rUSDY) implement rebasing by overriding `balanceOf()` to return
`shares * exchangeRate`, giving users a $1-pegged token whose balance
grows. This technique is unavailable on SVM.

### How every project handles this today

Every yield-bearing token on Solana uses the **value-appreciating
(exchange-rate) model**: raw balances are static, and the value per
token increases over time.

| Project | Token | Model | $1 Peg? |
|---------|-------|-------|---------|
| Jito | JitoSOL | Value-appreciating (stake pool) | No |
| Marinade | mSOL | Value-appreciating | No |
| Sanctum | INF, jupSOL, etc. | Value-appreciating (stake pool) | No |
| Lido (sunset) | stSOL | Value-appreciating | No |
| Ondo | USDY | Value-appreciating | No (>$1) |

Notably, Ondo offers rUSDY (rebasing, $1 peg) on EVM but ships only
the value-appreciating USDY on Solana -- users see a token priced at
>$1 that keeps rising, which does not feel like a stablecoin.

No project rebases on Solana. None use Token-2022 extensions for
yield display.

### What ScaledUiAmountConfig changes

Token-2022's `ScaledUiAmountConfig` extension stores an updatable f64
multiplier on the mint. Wallets and RPCs that support it return
`raw_amount * multiplier` as the user's displayed balance. The raw
`token_account.amount` is unchanged -- DeFi protocols see static
balances (AMM/lending compatible by construction).

This gives us the best of both models:

- **Under the hood:** value-appreciating shares, identical to
  JitoSOL/mSOL/USDY -- industry standard, DeFi compatible.
- **User-facing:** $1-pegged stablecoin display. Deposit 100 USDC,
  see 100.00 OkuM. After 5% yield, see 105.00 OkuM. Each
  displayed unit is $1.

The Solana ecosystem is actively standardizing on this pattern.
The official [ScaledUiAmount integration guide](https://solana.com/docs/tokens/extensions/scaled-ui-amount/integration-guide)
assigns P0 priority to wallet, DEX, explorer, and CEX support,
and explicitly describes yield distribution as a primary use case.

### First-mover status

As of July 2026, **no production project has shipped a yield-bearing
stablecoin using `ScaledUiAmountConfig` on Solana**. OkuMoney's
single-token design would be the first to use this extension for its
intended purpose: a T-Bill-backed token that displays as a $1
stablecoin while accumulating yield through multiplier updates. The
extension was designed for this use case -- we are simply the first to
ship it.

### Naming convention

The on-chain token is **OkuM (OkuMoney)** in all code, instruction
names, field names, and developer-facing surfaces (`oku_m_mint`,
`mint_oku_m`, `MintOkuM`, etc.). The `TokenMetadata` extension on
the mint stores `name: "OkuDollar", symbol: "usdOku"` so wallets
display the $1 stablecoin brand. This split is intentional: the
codebase uses OkuM naming because the on-chain token IS OkuM (a
value-appreciating T-Bill-backed token), while the wallet display
layer presents it as usdOku (a $1-pegged stablecoin) via the
`ScaledUiAmountConfig` multiplier.

---

## Key SVM design choices

**Single token with ScaledUiAmount.** `OkuM` ("OkuMoney") is the
sole protocol token. It is a Token-2022 mint with the
`ScaledUiAmountConfig` extension, which stores an f64 multiplier.
Wallets and explorers that support `ScaledUiAmount` render the
dollar-value balance automatically (e.g. 1 000 000 raw tokens at
multiplier 1.05 displays as "1.05 usdOku"). The multiplier on the
mint extension is the **single source of truth** — there is no
`oku_m_price` PDA field or dual-write path.

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
        oku_m_to_dollars.rs
        dollars_to_oku_m.rs
        calculate_fee.rs

programs/
  lite-psm/
    src/
      lib.rs                       # 18 instruction entry points
      state.rs                     # PsmConfig only (seed: psm_config_v6, 562B) —
                                   # no RedemptionQueue account; buffer-only PSM
      errors.rs                    # 23 error variants
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
                                   # cancel_role_admin_transfer, set_max_supply,
                                   # set_minter_allowance, set_direct_minter_allowance,
                                   # set_direct_burner_allowance
        direct_mint.rs             # mint_oku_m_direct (bridge/fiat on-ramp)
        direct_burn.rs             # burn_oku_m_direct (bridge off-ramp)
        yield_ops.rs               # set_multiplier, distribute_yield (CPI to Token-2022 UpdateMultiplier)
      contexts/                    # Per-instruction account contexts

tests/
  bankrun/                  # Default in-process suite (npm test, 85 bankrun tests)
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

### PsmConfig PDA (`b"psm_config_v6"`)

```rust
pub struct PsmConfig {
    pub bump: u8,
    // 10 authority pubkeys: role_admin, pauser, unpauser, freezer, unfreezer,
    //   buffer_depositor, buffer_withdrawer, cap_manager, allowance_manager,
    //   rebaser
    // Token references: usdc_mint, oku_m_mint, vault_usdc
    // Limits: max_supply, minter_allowance, direct_minter_allowance,
    //   direct_burner_allowance, is_paused
    // Yield: last_yield_distribution_slot
    // Two-step RoleAdmin: pending_role_admin
    // Direct mint/burn: direct_minter, direct_burner
}
```

LEN pinned at 562 bytes by compile-time `assert!`. There is no
`RedemptionQueue` account and no on-chain escrow-vault field — the
PSM is buffer-only (see "Why no redemption queue" below), and the
OkuM escrow ATA is derived client-side, not stored on `PsmConfig`.

The PsmConfig PDA is the **mint authority**, **freeze authority**, and
**ScaledUiAmount authority** for the `OkuM` mint. All mint/freeze/
multiplier-update CPIs are signed by the PDA's seeds.

### Why no redemption queue

Earlier design iterations included a zero-copy ring-buffer
`RedemptionQueue` account (mirroring the EVM side) so `redeem_oku_m`
could escrow a request when the USDC buffer was insufficient rather
than reverting outright. This was removed entirely in the
single-token refactor: `redeem_oku_m` now reverts with
`InsufficientBuffer` if `vault_usdc.amount` can't cover the redemption.
This matches how every other stablecoin issuer on Solana operates
(buffer-only, no on-chain queue) and removes an entire class of
queue-management operational surface (`process_queue`,
`rescue_queue_entry`, `user_self_rescue_queue_entry`, queue capacity
SLAs, `queue_processor` role). Operators keep the buffer topped up via
`deposit_buffer` / `withdraw_buffer`; there is no queue to drain.

### PDA seed history

| Migration date | Affected seeds | Cause |
|---|---|---|
| 2026-06-05 (noBridge phase C) | `psm_config → psm_config_v2`, `redemption_queue → redemption_queue_v2`, `oku_money_config → oku_money_config_v2`, `oku_m_mint → oku_m_mint_v2` | `PsmConfig` storage shrank from 722 → 658 bytes after the `blacklist_exempt_*` fields were removed. In-place BPF upgrade would have re-interpreted old slots — security-relevant corruption. Forced PDA rotation via seed bump. |
| 2026-06-12 (audit-prep cycle) | `psm_config_v2 → psm_config_v3` | PoR fields removed, USDC peg circuit-breaker fields added. Net layout delta: 658 → 674 bytes. Other three SVM seeds unchanged. |
| 2026-07-01 (direct-mint) | No seed change (in-place realloc) | `direct_minter: Pubkey` + `direct_minter_allowance: u64` appended to `PsmConfig`. Layout delta: 674 → 714 bytes (+40). First in-place `realloc` migration — `migrate_psm_config` extends the account without rotating the PDA seed. All other seeds unchanged. |
| 2026-07 (single-token refactor) | `psm_config_v4 → psm_config_v5` | OkuMoney eliminated; `oku_money_mint`/`vault_oku_money`/`oku_m_price` removed from PsmConfig; `oku_m_mint` added. `oku-dollar` program deleted entirely. Redemption queue still present at this point (`redemption_queue_v3`). |
| 2026-07 (queue removal) | `psm_config_v5 → psm_config_v6` | `RedemptionQueue` account, `queue_processor` role, and all queue instructions (`process_queue`, `rescue_queue_entry`, `user_self_rescue_queue_entry`, `setup_redemption_queue`) removed entirely — buffer-only PSM. Layout delta: 594 → 562 bytes (−32, the removed `queue_processor: Pubkey` field). Fresh program ID (`BUQ1ULxnJ1C4vuXD3gdrf9QEYo2juHzwVGCGZuQLJX2g`). |

**Orphan-PDA inventory** (devnet, post-rotation): pre-rotation PDAs +
SPL mints are orphaned because their `owner` field still references
the old program ID, but the program no longer derives those addresses
for any instruction. Not material; tracked for completeness, not
urgency.

#### Seed-rotation checklist

Every rotation must update ALL of these sites in lockstep. A drift
between any pair produces silent PDA-address mismatches that would
brick clients without a compile-time error.

| Site | Path | What to change |
|---|---|---|
| PSM config seed | `programs/lite-psm/src/state.rs` | `PsmConfig::SEED` byte-string |
| Client seed mirror | `scripts/utils/pdaHelpers.ts` | `PDA_SEEDS` map (must match the Rust constants byte-for-byte) |
| Address-book | `deployments/{devnet,mainnet}.json` | Update PDA addresses post-redeploy; flag old entries as orphan |
| Seed-history table | `contracts/SVM/README.md § PDA seed history` | New row documenting cause + layout delta |

Verification step: after rotation, run `npm test` (bankrun) — the PDA
derivations are exercised by every test, and a drift produces an
`AccountOwnedByWrongProgram` or `AccountNotInitialized` error on the
first test that touches the rotated PDA.

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

Both set `last_yield_distribution_slot = Clock::get().slot` for
sandwich prevention, and self-fence to reject same-slot re-entry.

The multiplier is read back from the mint via `read_multiplier()`
(in `helpers/scaled_ui.rs`), which calls
`get_extension::<ScaledUiAmountConfig>()` on the mint account data.
This is the only path for reading the current multiplier — there is
no duplicate field on `PsmConfig`.

### PSM

```rust
// raw_oku_m_amount = usdc_amount (1:1 at raw level; ScaledUiAmount handles display)
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

### Cross-chain (noBridge, v1)

No on-chain bridge instructions. The orchestrator uses
`burn_oku_m_direct` on the source chain and `mint_oku_m_direct`
on the destination chain, conserving raw token amounts directly.

**SVM ≠ EVM bridging model:** SVM uses direct raw-amount
burn/mint (no USDC intermediate). EVM still uses PSM-mediated USDC
flow. The orchestrator handles this asymmetry.

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

After the single-token refactor `lite-psm/src/constants.rs` only
re-exports shared constants from `oku-shared`; no program-specific
values remain.

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
`setup_oku_m_escrow` instruction.

No on-chain bridge, router, or redemption queue is deployed (noBridge,
buffer-only model).

---

## Error codes

Full list (23 variants) in `programs/lite-psm/src/errors.rs`. Key errors:

- `YieldDistributionInProgress` — operation blocked during yield lock.
- `MultiplierCannotDecrease` — ScaledUiAmount multiplier is monotonically increasing.
- `InsufficientUserBalance` — user balance shortfall on redeem.
- `InsufficientBuffer` — PSM USDC vault can't cover a redeem or withdraw_buffer (no queue fallback — the tx reverts).
- `OutputBelowMinimum` — redeem output is zero, or below the caller's `min_usdc_out` slippage floor.
- `YieldTooSmall` — `distribute_yield` amount truncates to zero.
- `Paused` — operation attempted while system is paused.
- `Unauthorized` — caller lacks the required role.

---

## Testing

```bash
# Full bankrun suite — 85 bankrun tests + 16 Rust unit tests = 101 total
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
cargo test --workspace                # 16 unit tests

# Anchor build
anchor build

# Self-audit toolkit (../../audit/SVM/)
cd ../../audit/SVM && make all    # clippy + cargo-audit + anchor-test
cd ../../audit/SVM && make doctor # verify toolchain pins match installed binaries
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

### Orchestrator key

In v1 (noBridge) the orchestrator holds a single Solana keypair that
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
| `admin:set-authority` | `set_authority` | `role_admin` |
| `admin:pause-psm` / `admin:unpause-psm` | `pause` / `unpause` | `pauser` / `unpauser` |
| `admin:set-max-supply` | `set_max_supply` | `cap_manager` |
| `admin:set-minter-allowance` | `set_minter_allowance` | `allowance_manager` |
| `admin:set-multiplier` | `set_multiplier` | `rebaser` (stamps yield-distribution slot) |
| `admin:distribute-yield` | `distribute_yield` | `rebaser` |
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
source of truth. `read_multiplier()` reads it; `set_multiplier()`
and `distribute_yield()` write it via CPI to the Token-2022 program.

### Rebasing model

EVM `OkuMoney` accrues USD yield continuously between calls via
`MathLib._rpow`. SVM uses discrete `set_multiplier` updates driven
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
- SVM: `distribute_yield` reverts `LitePsmError::YieldTooSmall`.

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

EVM keeps a `RedemptionQueue` (unbounded `mapping(uint256 →
RedemptionEntry)`, strict FIFO via `head`/`tail`) so a redeem can be
escrowed when the PSM's USDC buffer is insufficient, then drained
later via `processQueue`. SVM has **no queue at all** — `redeem_oku_m`
simply reverts with `InsufficientBuffer` if the vault can't cover it
(see "Why no redemption queue" in the state-accounts section above).
This is a deliberate SVM-specific simplification, not a parity gap
the two sides are expected to close.

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

### Cross-chain operational requirements (v1 noBridge)

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
| `RedemptionQueue` | yes (`EVM/src/psm/RedemptionQueue.sol`) | no — removed entirely, buffer-only PSM | SVM-only deliberate simplification |
| On-chain bridge | removed in noBridge | removed in noBridge | both sides v1 are off-chain orchestrator-mediated |

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
- **In-repo audit package** (accepted risks, clippy triage): [`oku-programs/audit/README.md`](oku-programs/audit/README.md)
- **EVM-side docs:** [`../EVM/README.md`](../EVM/README.md)
