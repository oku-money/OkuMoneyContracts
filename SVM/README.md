# OkuMoney Solana Implementation

> See [`../README.md`](../README.md) for shared architecture, RBAC,
> business logic, the orchestrator runbook, and the deployment
> end-to-end guide.

Solana implementation of OkuMoney — institutional-grade yield
infrastructure backed by US Treasury Bills. Cycle 4 (2026-06-15)
audit-handoff baseline.

## Stack

- **Language:** Rust 1.90.0 (pinned in `oku-programs/rust-toolchain.toml`)
- **Framework:** Anchor 1.0.2 (`Anchor.toml` + workspace `Cargo.toml`)
- **Solana crates:** 3.x series (`solana_version = "3.1.10"` in `Anchor.toml`)
- **Token standard:** Token-2022 (both OkuMoney and usdOku)
- **Oracle:** Pyth V2 (manual account parsing, no SDK dependency)
- **Multisig:** Squads Protocol
- **JavaScript bindings:** `@anchor-lang/core 1.0.x`

## Programs

### lite-psm

The core program housing the Peg Stability Module, redemption queue,
yield distribution, compliance (freeze / thaw), and the embedded
USDC peg circuit-breaker. Holds mint and freeze authority over
OkuMoney. All program authority is held by a PDA — no EOA controls
minting.

### oku-dollar

Rebasing vault that wraps OkuMoney into usdOku. Users deposit
OkuMoney and receive usdOku shares that appreciate as the
`usd_multiplier` is updated by the orchestrator. Manages
collateralization, reserve deposits / withdrawals, and enforces
minimum collateral ratios.

### oku-shared (workspace crate)

Pure-Rust workspace lib with **zero dependencies** (no `solana-*`,
no `anchor-lang`). Houses the protocol-wide constants and pure-math
primitives (`math.rs` + `vault_math.rs` + `yield_lock.rs` +
`constants.rs`). Re-exported by both programs through their
`constants.rs` modules so call sites still write `use
crate::constants::*` without caring where the value is authored.

Lives in `crates/` rather than `programs/` because `anchor build`
walks `programs/*` and requires every member to declare an
`idl-build` feature; `crates/*` is for ordinary workspace libs.

### Cross-chain transfers (noBridge model, v1)

There is no on-chain bridge program. Cross-chain transfers are
mediated by an off-chain orchestrator that holds the standard PSM
operational roles (`buffer_depositor`, `queue_processor`, `rebaser`)
and signs `mint_oku_m` / `redeem_oku_m` on each chain against its
own ATAs. After mint on the destination chain the orchestrator does
a normal SPL `transfer` to the recipient; after redeem on the source
chain it custodies USDC and reflects the value on the other chain.
See [`../README.md` § Orchestrator runbook](../README.md) for
operational procedures.

---

## Key SVM design choices

**Non-rebasing OkuMoney with stored price.** OkuMoney is a standard
Token-2022 token with a static balance. The price is a stored `u64`
value (`oku_m_price`) in the PsmConfig PDA, updated discretely by
the orchestrator via `set_oku_m_price()` or `distribute_yield()`.
Wallets and frontends read the config PDA to compute dollar values.
No token extension is used for price display (Scaled UI Amount
deferred pending ecosystem support).

**Discrete OkuDollar multiplier.** Unlike EVM where OkuDollar uses
continuous `_rpow` streaming, the SVM implementation uses discrete
`usd_multiplier` updates driven by the orchestrator. Solana's Token-2022
extensions can't replicate the "balance grows every second" UX (the
Scaled UI Amount extension stores a flat scalar). Discrete updates
are economically identical between orchestrator calls.

**Single-slot yield distribution lock.** Both `set_oku_m_price()`
and `distribute_yield()` set `last_yield_distribution_slot =
Clock::get().slot`. PSM and vault operations check `current_slot !=
last_yield_distribution_slot` before executing. Cycle 4 (OKUD-06)
added self-fence on `update_usd_multiplier` and on the lite-psm
yield ix. Mirrors EVM's `lastYieldDistributionBlock`.

**Pyth confidence band (cycle 4 / PSM-04).** The relay rejects
rounds where the publisher set's stated uncertainty exceeds
`MAX_ORACLE_CONFIDENCE_BPS = 200` (= 2 %) of the price. EVM Chainlink
has no analogous field. Defends against publisher-degradation rounds
whose `price` is in-band but whose `conf` is unbounded.

**Token-2022 mint-extension allow-list (cycle 4 / PSM-13 / OKUD-02).**
Both programs verify at init that the OkuMoney mint carries only
whitelisted Token-2022 extensions (`MintCloseAuthority`,
`MetadataPointer`, `TokenMetadata`, `InterestBearingConfig`, group-*).
Single source of truth lives in
`lite-psm/src/helpers/mint_extensions.rs` and is also called from
`oku-dollar::initialize` so both programs agree on the policy.

**No Pyth SDK dependency.** The oracle check manually parses Pyth V2
price account bytes to avoid transitive dependency conflicts. The
accepted Pyth program owner pubkey is **per-deployment**
(`PsmConfig::oracle_relay_pyth_program_owner`), so deployments can
target the legacy Pyth program (mainnet `FsJ3...`, devnet `gSbe...`)
or any future Pyth deployment without recompilation. The modern Pyth
Solana Receiver (`PriceUpdateV2`) uses a different layout and is
NOT supported in v1.

**6-decimal tokens.** Both OkuMoney and usdOku use 6 decimals,
matching USDC on Solana. EVM uses 18 decimals. The off-chain
orchestrator handles decimal conversion when reflecting value across
chains.

---

## Program structure

```
crates/
  oku-shared/                # Pure-Rust workspace lib (no solana-*, no anchor-lang)
    src/
      lib.rs
      constants.rs           # PRECISION, BASIS_POINTS, MAX_MULTIPLIER,
                             # MIN_COLLATERAL_RATIO_FLOOR, ORACLE_*, MAX_ORACLE_CONFIDENCE_BPS
      math.rs                # mul_div_floor, mul_div_ceil + siblings, overflow-safe Option<u64>
                             # + Kani harnesses gated on #[cfg(kani)]
      vault_math.rs          # Two-multiplier vault primitives (cycle 4 / M-28: moved out of oku-dollar)
      yield_lock.rs          # Pure slot-comparison primitive (cycle 4 / OKUD-20)
    fuzz/                    # cargo-fuzz workspace
      fuzz_targets/
        mul_div_floor.rs
        mul_div_ceil.rs           # cycle 4
        oku_m_to_dollars.rs
        dollars_to_oku_m.rs
        calculate_fee.rs
        vault_share_round_trip.rs
        collateral_ratio.rs       # cycle 4

programs/
  lite-psm/
    src/
      lib.rs                       # Instruction entry points
      state.rs                     # PsmConfig (seed: psm_config_v3),
                                   # RedemptionQueue (zero-copy, MAX_ENTRIES=200)
      errors.rs
      events.rs
      roles.rs                     # AuthorityRole enum
      constants.rs                 # Re-exports oku_shared::*
      helpers/
        yield_lock.rs              # check_yield_lock (delegates to shared yield_lock_engaged)
        oracle_relay.rs            # Pyth V2 manual parsing + peg-band + confidence-interval check
        math.rs                    # Anchor-error-flavoured wrappers over oku_shared::math
        mint_extensions.rs         # Cycle 4: Token-2022 allow-list
      instructions/
        init.rs                    # initialize (InitializeParams struct, cycle 4 / PSM-17),
                                   # setup_redemption_queue, setup_oku_money_escrow
        psm.rs                     # mint_oku_m, redeem_oku_m, process_queue, rescue_queue_entry,
                                   # user_self_rescue_queue_entry (cycle 4 / PSM-06),
                                   # deposit_buffer, withdraw_buffer (ceil-rounded, cycle 4 / PSM-05)
        psm_admin.rs               # pause/unpause, freeze/thaw, set_authority (macro-driven, no-op reject — cycle 4),
                                   # set_oracle_relay_*, set_max_supply, set_minter_allowance
        yield_ops.rs               # set_oku_m_price, distribute_yield (self-fenced, cycle 4)
      contexts/                    # Per-instruction account contexts

  oku-dollar/
    src/
      lib.rs
      constants.rs                 # Re-exports oku_shared::* + vault-specific MINIMUM_LIQUIDITY
      state.rs                     # OkuDollarConfig (seed: oku_dollar_config_v2)
      errors.rs
      events.rs
      roles.rs
      helpers.rs                   # Thin wrappers around oku_shared::vault_math + check_vault_yield_lock
      instructions/
        core.rs                    # initialize (decimals + oku_m_price > 0 invariants, cycle 4),
                                   # wrap (dead-shares first deposit), unwrap,
                                   # update_usd_multiplier (self-fenced, cycle 4 / OKUD-06),
                                   # deposit_reserves, withdraw_reserves
        admin.rs                   # pause/unpause, set_authority, set_min_collateral_ratio
      contexts.rs                  # All account contexts

tests/
  bankrun/                  # Default in-process suite (npm test, ~12 s, 129 tests)
    smoke.ts
    lite-psm.ts
    oku-dollar.ts
    pyth-oracle.ts
    oracle-relay.ts
    init-invariants.ts             # Token-2022 extension whitelist
    rate-over-time.ts
    crossChainBridging.ts
  fork/                            # surfpool-based, ad-hoc (npm run test:fork)
    pyth-oracle.ts                 # Mainnet-fork live Pyth
  shared/
    setup.ts                       # Shared authority keypairs + initializePsm
    bankrun.ts                     # Harness, helpers, autoBumpSlot wrapper
    pythFixture.ts                 # Pyth-V2 SolanaPriceAccount fixture builder
```

---

## State accounts

### PsmConfig PDA (`b"psm_config_v3"`)

```rust
pub struct PsmConfig {
    pub bump: u8,
    // 12 authority pubkeys: role_admin, pauser, unpauser, freezer, unfreezer,
    //   queue_processor, buffer_depositor, buffer_withdrawer, oracle_manager,
    //   cap_manager, allowance_manager, rebaser
    // Token references: usdc_mint, oku_money_mint, vault_usdc, vault_oku_money
    // Limits: max_supply, minter_allowance, is_paused
    // Oracle relay (cycle 2 — replaced cycle-1 PoR):
    //   oracle_relay_feed, oracle_relay_pyth_program_owner,
    //   oracle_relay_staleness, oracle_relay_min_price_e9, oracle_relay_max_price_e9
    // Yield: last_yield_distribution_slot, oku_m_price
    // Two-step RoleAdmin: pending_role_admin
}
```

LEN pinned at 674 bytes by compile-time `assert!`.

### OkuDollarConfig PDA (`b"oku_dollar_config_v2"`)

```rust
pub struct OkuDollarConfig {
    pub bump: u8,
    // Authorities: role_admin, pauser, unpauser, usd_rebaser, reserve_manager
    // Token references: oku_money_mint, usd_oku_mint, reserve_vault, psm_config
    // USD multiplier: usd_multiplier, usd_last_update_time, last_yield_distribution_slot
    // Collateralization: min_collateral_ratio
    // State: is_paused
    // Two-step RoleAdmin: pending_role_admin
}
```

LEN pinned at 362 bytes by compile-time `assert!`.

### RedemptionQueue PDA (`b"redemption_queue_v2"`)

Zero-copy ring buffer (200 entries max — `MAX_ENTRIES`). Each entry:
`{ user: Pubkey, oku_m_amount: u64, timestamp: i64 }` = 48 bytes.
Total account size 9 640 bytes; rent ~0.067 SOL one-time at deploy.
Cap of 200 (vs the EVM spec target of 500) is bounded by Solana's
`MAX_PERMITTED_DATA_INCREASE = 10_240`-byte single-CPI allocation
budget. Strict FIFO preserved via `head` / `tail` `u64` absolute
indices. Cycle 4 added `RedemptionQueue::ring_index(abs_index)` +
`MAX_BATCH_ENTRIES` helpers on the impl block.

### PDA seed history

| Migration date | Affected seeds | Cause |
|---|---|---|
| 2026-06-05 (noBridge phase C) | `psm_config → psm_config_v2`, `redemption_queue → redemption_queue_v2`, `oku_dollar_config → oku_dollar_config_v2`, `usd_oku_mint → usd_oku_mint_v2` | `PsmConfig` storage shrank from 722 → 658 bytes after the `blacklist_exempt_*` fields were removed. In-place BPF upgrade would have re-interpreted old slots — security-relevant corruption. Forced PDA rotation via seed bump. |
| 2026-06-12 (audit-prep cycle) | `psm_config_v2 → psm_config_v3` | PoR fields removed, USDC peg circuit-breaker fields added. Net layout delta: 658 → 674 bytes. Other three SVM seeds unchanged. |

**Orphan-PDA inventory** (devnet, post-rotation): pre-rotation PDAs +
SPL mints are orphaned because their `owner` field still references
the same program ID, but the program no longer derives those addresses
for any instruction. Total rent locked ~0.085 SOL across ~9 accounts
per rotation — not material; tracked for completeness, not urgency.
A future one-shot `admin_close_legacy_pda(seed_str)` ix gated by
`role_admin` could recover the rent (post-launch enhancement).

#### Seed-rotation checklist

Every rotation must update ALL of these sites in lockstep. A drift
between any pair produces silent PDA-address mismatches that would
brick clients without a compile-time error.

| Site | Path | What to change |
|---|---|---|
| PSM config seed | `oku-programs/programs/lite-psm/src/state.rs` | `PsmConfig::SEED` byte-string |
| Queue seed | `oku-programs/programs/lite-psm/src/state.rs` | `RedemptionQueue::SEED` |
| Vault config seed | `oku-programs/programs/oku-dollar/src/state.rs` | `OkuDollarConfig::SEED` |
| usdOku mint seed | `oku-programs/programs/oku-dollar/src/state.rs` | `USD_OKU_MINT_SEED` |
| Client seed mirror | `oku-programs/scripts/utils/pdaHelpers.ts` | `PDA_SEEDS` map (must match the Rust constants byte-for-byte) |
| Address-book | `oku-programs/deployments/{devnet,mainnet}.json` | Update PDA addresses post-redeploy; flag old entries as orphan |
| Seed-history table | `contracts/SVM/README.md § PDA seed history` | New row documenting cause + layout delta |

Verification step: after rotation, run `npm test` (bankrun) — the PDA
derivations are exercised by every test, and a drift produces an
`AccountOwnedByWrongProgram` or `AccountNotInitialized` error on the
first test that touches the rotated PDA.

---

## Core operations

### OkuMoney price updates

```rust
// Direct price set — REBASER only, monotonic, sets yield lock
pub fn set_oku_m_price(new_multiplier: u64)

// Dollar-denominated yield distribution — REBASER only
// new_price = old_price + (yield_amount * PRECISION / total_supply)
pub fn distribute_yield(yield_amount: u64)
```

Both set `last_yield_distribution_slot = Clock::get().slot` for
sandwich prevention. Cycle 4 added self-fence — both reject same-slot
re-entry by the rebaser.

### PSM (price-aware)

```rust
// oku_m_amount = usdc_amount * PRECISION / oku_m_price
pub fn mint_oku_m(usdc_amount: u64)

// usdc_amount = oku_m_amount * oku_m_price / PRECISION
pub fn redeem_oku_m(oku_m_amount: u64)             // instant or queued

pub fn process_queue(max_entries: u32)             // price cached once per batch; hard-capped at MAX_BATCH_ENTRIES=50
pub fn rescue_queue_entry(queue_index: u64)        // operator: return OkuM for stuck entries
pub fn user_self_rescue_queue_entry(queue_index: u64)  // cycle 4: permissionless self-rescue
```

All protected by yield-lock and peg-band check (when relay wired).

### OkuDollar vault (price-aware)

```rust
// shares = oku_m_amount * oku_m_price / usd_multiplier
pub fn wrap(oku_m_amount: u64, min_shares_out: u64) -> Result<u64>

// oku_m_returned = shares * usd_multiplier / oku_m_price
pub fn unwrap(shares: u64)

pub fn update_usd_multiplier(new_usd_multiplier: u64)  // USD_REBASER, monotonic, self-fenced
pub fn deposit_reserves(amount: u64)                   // RESERVE_MANAGER, no shares minted
pub fn withdraw_reserves(amount: u64)                  // RESERVE_MANAGER, enforces min collateral
```

`wrap` + `unwrap` protected by both PSM and vault yield locks
(reads `oku_m_price` cross-program). `unwrap` blocked when paused.
First deposit enforces `MINIMUM_LIQUIDITY` dead shares for
inflation-attack prevention.

### Collateralization (price-aware)

```
ratio = (reserve_balance × oku_m_price × PRECISION) / (total_supply × usd_multiplier)
```

`withdraw_reserves` enforces `ratio >= min_collateral_ratio` after
withdrawal. `update_usd_multiplier` verifies sufficient
collateralization after the update.

### Cross-chain (noBridge, v1)

No on-chain bridge instructions. **`mint_oku_m` is fully
permissionless.** Any USDC holder can call it; the orchestrator
does NOT hold a privileged mint authority. The PSM config PDA is
the OkuMoney mint authority and signs the inner `mint_to` CPI.
Orchestrator key compromise does not grant mint privilege beyond
the orchestrator's USDC custody. This property is load-bearing;
`tests/bankrun/crossChainBridging.ts § 'a random key can call mint_oku_m'`
asserts it.

**Cross-chain USDC flow conservation invariant (per bridge):**

```
|usdc_out_A - usdc_in_B| ≤ 1 micro-USDC per bridge
```

See [`../README.md` § Orchestrator runbook](../README.md) for
operational procedures.

---

## Precision model

```rust
const PRECISION: u64 = 1_000_000_000; // 1e9

// oku_m_price: 1_000_000_000 = $1.00, 1_045_000_000 = $1.045
// usd_multiplier: 1_000_000_000 = 1:1
//
// All intermediate calculations use u128 to prevent overflow.
// Rounding favours protocol/vault (round DOWN throughout).
```

**Why 1e9 on SVM vs 1e18 on EVM:** SVM uses `u64` for token amounts
and BPF natively widens to `u128` for intermediates. `1e9 × u64`
peaks around `1.8e28`, comfortably within `u128::MAX (≈ 3.4e38)`.
A 1e18 precision would require either `u128` token amounts (no SPL
Token-2022 support) or aggressive precision loss on every operation.
The decimal-count coincidence (both EVM and SVM use 9 decimal
digits less than the token's stated precision) is just that — a
coincidence.

---

## Hardcoded constants

Shared protocol constants live in
[`crates/oku-shared/src/constants.rs`](oku-programs/crates/oku-shared/src/constants.rs);
program-specific constants live in each program's own `constants.rs`.
None can be changed without a program upgrade.

### Shared (`oku-shared`)

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1_000_000_000` (1e9) | Fixed-point base for all multiplier math. |
| `BASIS_POINTS` | `10_000` | Universal bps denominator. |
| `MIN_COLLATERAL_RATIO_FLOOR` | `900_000_000` (90 %) | Hard floor below which `min_collateral_ratio` can never be configured. Round-number convention; gates `withdraw_reserves` only. Mirrors EVM. |
| `MAX_MULTIPLIER` / `MAX_OKU_M_PRICE` / `MAX_USD_MULTIPLIER` | `1_000_000_000_000_000` (1e15, = $1M/token) | Overflow guard. Aliases compile-time-asserted equal (cycle 4 / C-16). Math-sanity bound. |
| `ORACLE_MIN_STALENESS_SECS` | `60` | Lower bound on configurable Pyth staleness. Mirrors EVM. |
| `ORACLE_MAX_STALENESS_SECS` | `604_800` (7 days) | Upper bound on configurable staleness. Mirrors EVM. |
| `ORACLE_USDC_PRICE_FLOOR` | `950_000_000` (= $0.95) | Hard floor for USDC peg band. Mirrors EVM 0.95e18. |
| `ORACLE_USDC_PRICE_CEILING` | `1_050_000_000` (= $1.05) | Hard ceiling. Mirrors EVM 1.05e18. |
| `MAX_FEED_EXPO_MAGNITUDE` | `18` | Bounds the Pyth `expo` magnitude. EVM analogue is `MAX_FEED_DECIMALS = 18`. |
| `MAX_ORACLE_CONFIDENCE_BPS` | `200` (cycle 4) | Pyth `conf / price` ratio cap (= 2 %). SVM-only — Chainlink has no equivalent. |
| `TOKEN_DECIMALS` | `6` | Both OkuMoney and OkuDollar use 6 decimals on SVM (matches USDC). Asserted at init. |

### Lite-PSM

After the noBridge refactor `lite-psm/src/constants.rs` only
re-exports shared constants from `oku-shared`; no program-specific
values remain.

### OkuDollar

| Constant | Value | Rationale |
|---|---|---|
| `MINIMUM_LIQUIDITY` | `1_000_000` (1 usdOku at 6 decimals) | Dead shares permanently locked in a System-Program ATA on first deposit, preventing the first-depositor share-inflation attack. Uniswap-V2 pattern. |

### Queue / batch limits

| Constant | Value | Location | Rationale |
|---|---|---|---|
| `RedemptionQueue::MAX_ENTRIES` | `200` | `lite-psm/src/state.rs` | Maximum entries in the zero-copy ring. Bounded by Solana's ~10 KB single-CPI allocation budget. |
| `RedemptionQueue::MAX_BATCH_ENTRIES` | `50` | `lite-psm/src/state.rs` (cycle 4 / PSM-18 — moved from a free `pub const`) | Max entries `process_queue` walks per call. Bounded by BPF compute-unit budget. |

---

## Authority model

For the full centralized trust model and what each key tier
can / can't do see [`../README.md § Signer trust implications`](../README.md).
SVM-specific table:

| Role | Program | Held by | What it can do | On-chain prevention |
|---|---|---|---|---|
| `role_admin` | PSM + Vault | Cold Multisig (Squads) | Rotate any other role via `set_authority` (two-step `accept_role_admin` handshake for its own transfer) | Meta-role. Quorum breach = full system compromise. Two-step rotation catches typos. Cycle 4 (PSM-02) added no-op rejection. |
| `pauser` | PSM + Vault | Warm Multisig | Set `is_paused = true`, halting mint/redeem/wrap/unwrap | Cannot unpause (requires `unpauser`). Cannot access funds. |
| `unpauser` | PSM + Vault | Cold Multisig | Clear `is_paused` | — |
| `freezer` | PSM | Warm Multisig | CPI-freeze any OkuMoney ATA via Token-2022 freeze authority | Cannot drain or redirect frozen tokens. |
| `unfreezer` | PSM | Cold Multisig | CPI-thaw a frozen ATA | — |
| `rebaser` | PSM | Orchestrator (KMS) | Update `oku_m_price` (non-decreasing) and call `distribute_yield` | Cannot decrease; capped at `MAX_OKU_M_PRICE` (1e15). Cycle 4: self-fenced. |
| `usd_rebaser` | Vault | Orchestrator (KMS) | Update `usd_multiplier` (non-decreasing) | Cannot decrease; capped at `MAX_USD_MULTIPLIER`. Cannot push vault below `min_collateral_ratio`. Cycle 4: self-fenced. |
| `reserve_manager` | Vault | Cold Multisig | `deposit_reserves` / `withdraw_reserves` | Cannot withdraw below `min_collateral_ratio` floor. |
| `queue_processor` | PSM | Orchestrator | `process_queue` (pays USDC to queued entries) + `rescue_queue_entry` | Pays the entry's `user` field; cannot reroute. Rescue per-entry only. |
| `buffer_depositor` | PSM | Orchestrator | Transfer USDC from caller's ATA into the PSM vault | Caller must hold USDC; no damage possible. |
| `buffer_withdrawer` | PSM | Cold Multisig | Drain USDC from the PSM vault | Cannot withdraw below USDC reserved for pending queue entries. Cycle 4: ceil-rounded reservation. |
| `oracle_manager` | PSM | Cold Multisig | Set `oracle_relay_feed` (`Pubkey::default()` disables), `oracle_relay_staleness`, `oracle_relay_min/max_price_e9`, `pyth_program_owner` | Staleness ∈ `[60 s, 7 days]`. Band ⊆ `[0.95e9, 1.05e9]`. `set_oracle_relay_feed` validates Pyth header magic + version. |
| `cap_manager` | PSM | Cold Multisig | Set `max_supply` | Cannot set below current circulating supply. |
| `allowance_manager` | PSM | Cold Multisig | Set `minter_allowance` | Bounded by `max_supply`; PSM PDA is the mint authority. |

Key separation: `rebaser` (rear-facing — updates OkuMoney price
from realized T-Bill returns) ≠ `usd_rebaser` (forward-facing —
policy yield multiplier set by Oku).

---

## Initialization

PSM initialization is split into three instructions to avoid BPF
stack overflow on the large account contexts:

1. `initialize(InitializeParams)` — creates `PsmConfig` and the USDC
   vault. Cycle 4 (PSM-17) collapsed the previous 15 positional
   pubkey args into a single `InitializeParams` struct (IDL break
   accepted pre-audit). Pyth program-owner pubkey supplied here,
   rotatable post-deploy. Also enforces the Token-2022 mint-extension
   allow-list (cycle 4 / PSM-13).
2. `setup_redemption_queue` — creates the `RedemptionQueue` PDA.
   Emits `QueueInitializedEvent` (cycle 4 / PSM-22).
3. `setup_oku_money_escrow` — creates the OkuMoney escrow vault.
   Emits `EscrowInitializedEvent` (cycle 4 / PSM-22).

OkuDollar vault initialization is a single call:

- `initialize` — creates `OkuDollarConfig`, the usdOku mint
  (authority = config PDA), the OkuMoney reserve vault. Asserts
  OkuMoney mint decimals (cycle 4 / OKUD-01), `psm_config.oku_m_price > 0`
  (cycle 4 / OKUD-04), and the same Token-2022 mint-extension
  allow-list (cycle 4 / OKUD-02).

No on-chain bridge or router is deployed (noBridge model).

---

## Error codes

Full list in `programs/lite-psm/src/errors.rs` and
`programs/oku-dollar/src/errors.rs`. Key errors:

- `YieldDistributionInProgress` — operation blocked during yield lock.
- `PriceCannotDecrease` — `oku_m_price` is monotonically increasing.
- `MultiplierCannotDecrease` — `usd_multiplier` is monotonically increasing.
- `InsufficientReserves` — vault cannot cover unwrap.
- `InsufficientCollateral` — withdrawal would breach `min_collateral_ratio`.
- `InsufficientUserBalance` — user balance shortfall on redeem (cycle 4 / PSM-11; was misleadingly `InsufficientBuffer`).
- `IncompatibleMintExtension` — OkuMoney mint carries a Token-2022 extension that's not on the allow-list (cycle 4).
- `OracleConfidenceTooWide` — Pyth `conf / price` exceeds `MAX_ORACLE_CONFIDENCE_BPS` (cycle 4 / PSM-04).
- `SlippageExceeded` — output below user-specified minimum.

---

## Testing

```bash
# Full bankrun suite — 129 tests, ~12 s in-process.
npm test
# or directly:
npx mocha --require tsx --timeout 60000 'tests/bankrun/**/*.ts'

# Individual bankrun test files
npx mocha --require tsx --timeout 60000 'tests/bankrun/lite-psm.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/oku-dollar.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/pyth-oracle.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/rate-over-time.ts'

# Cargo unit tests (math primitives, vault math, helpers)
cargo test --workspace                # 36 / 36

# Anchor build
anchor build

# Fork tests — exercises real mainnet Pyth state via Surfpool.
#   1. Start Surfpool: npm run surfpool:mainnet
#   2. Run fork tests: npm run test:fork

# Trident property-based fuzz harnesses (#[init] wired cycle 3)
trident fuzz run fuzz_lite_psm   # oku_m_price monotonicity + ceiling
trident fuzz run fuzz_oku_dollar  # usd_multiplier monotonicity + ceiling

# Self-audit toolkit (../../audit/SVM/)
cd ../../audit/SVM && make all    # clippy + cargo-audit + anchor-test
cd ../../audit/SVM && make doctor # verify toolchain pins match installed binaries
cd ../../audit/SVM && make slow   # trident + cargo-fuzz + kani
```

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
  `distribute_yield` / `set_oku_m_price` — without auto-bump, any
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
npm run cost                  # ~0.067 SOL for the queue rent alone

# Phase 1 — deploy program .so files
NETWORK=devnet npm run deploy:programs

# Phase 2 — create tokens + initialize PSM and OkuDollar vault
NETWORK=devnet npm run deploy:init

# Mainnet — transfer program upgrade authorities to cold multisig
solana program set-upgrade-authority <LITE_PSM_PROGRAM>   --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

---

## Runbook (SVM-specific)

### Pre-mainnet checklist

- [ ] `security_txt!` contact in both programs — currently points at the GitHub security advisory URL; replace with a dedicated `email:security@<domain>` if available.
- [ ] `MAINNET_ORCHESTRATOR` env var points at a KMS-backed signer, not the deployer wallet.
- [ ] BPF loader upgrade authority transferred to the cold multisig.
- [ ] Pyth feed configured (`scripts/admin/set-oracle-relay.ts --feed=<feed>`). Legacy Pyth V2 `SolanaPriceAccount` required; modern Receiver `PriceUpdateV2` is NOT supported.
- [ ] `Anchor.toml [programs.<network>]` matches the freshly-deployed keypair IDs (devnet and localnet sections kept separate on purpose).

### Orchestrator key

In v1 (noBridge) the orchestrator holds a single Solana keypair that
signs `mint_oku_m` / `redeem_oku_m` and the operational PSM ops it
has been granted roles for (`buffer_depositor` / `queue_processor` /
`rebaser`). It also holds the matching EVM key on the other side.
Both keys KMS-backed.

A future on-chain bridge (NTT, CCIP, native OkuBridge port) would
add a separate signing scheme — out of v1 scope.

### Queue capacity SLA

The `RedemptionQueue` is a fixed 200-entry zero-copy ring. Operations
discipline:

- Keep `vault_usdc.amount` topped up so `redeem_oku_m` falls into
  the instant path.
- If the queue fills (200 simultaneously-pending redemptions), the
  201st `redeem_oku_m` reverts with `QueueFull`. The fix is to call
  `process_queue` from a `queue_processor`-keyed orchestrator.
- `process_queue` is hard-capped at `MAX_BATCH_ENTRIES = 50` per tx.
  To drain 200 entries you need at least 4 `process_queue` calls.
- Cycle 4 (PSM-06) added a permissionless `user_self_rescue_queue_entry`
  so users can unblock their own stuck entries without operator
  intervention.

Cron template (orchestrator side):

```bash
while true; do
    npm run admin:process-queue   # auto-loops until empty
    sleep 60
done
```

`scripts/admin/process-queue.ts` auto-batches across multiple txs in
a single invocation. Pass `--max=<N>` to cap how many entries a
single invocation drains.

### Pyth feed requirements

The on-chain oracle parser at
`lite_psm::helpers::oracle_relay::check_usdc_peg` expects the legacy
Pyth V2 `SolanaPriceAccount` layout. The feed must:

1. Be owned by `PsmConfig::oracle_relay_pyth_program_owner` (set at
   init, rotatable via `set_oracle_relay_pyth_program_owner`).
2. Have the canonical Pyth header: `magic == 0xa1b2c3d4`,
   `ver == 2`, `atype == 3` (Price).
3. Have `agg.status == Trading` (1). Halted / Auction / Unknown /
   Ignored states are rejected.
4. Have `|expo| ≤ MAX_FEED_EXPO_MAGNITUDE` (= 18). USDC/USD feeds
   typically use `expo == -8`.
5. Be fresh per `oracle_relay_staleness` (bounded to `[60 s, 7 days]`,
   default `ORACLE_MAX_STALENESS_SECS` post-cycle-4 / PSM-08).
6. Have `conf / price ≤ MAX_ORACLE_CONFIDENCE_BPS / 10_000` (= 2 %)
   (cycle 4 / PSM-04).

### Cross-chain refund / recovery

In v1 there is no on-chain refund flow because there is no on-chain
bridge. If an off-chain cross-chain transfer is interrupted (e.g.
orchestrator outage between source redeem and destination mint), the
orchestrator reconciles state by re-running the mint on the
destination once it has the USDC, or by re-minting on the source if
it never actually redeemed.

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
| `admin:set-oracle-relay` (four subcommands) | `set_oracle_relay_{feed,staleness,band,pyth_program_owner}` | `oracle_manager` |
| `admin:set-max-supply` | `set_max_supply` | `cap_manager` |
| `admin:set-minter-allowance` | `set_minter_allowance` | `allowance_manager` |
| `admin:set-oku-m-price` | `set_oku_m_price` | `rebaser` (stamps yield-distribution slot) |
| `admin:distribute-yield` | `distribute_yield` | `rebaser` |
| `admin:freeze-account` / `admin:thaw-account` | `freeze_account` / `thaw_account` | `freezer` / `unfreezer` |
| `admin:process-queue` | `process_queue` (auto-batches to drain-to-empty) | `queue_processor` |
| `admin:close-programs` | `solana program close` (BPF loader) — recover rent from stale program deployments. | BPF upgrade authority (deployer wallet) |

---

## EVM vs SVM — divergence catalogue

Companion to the cross-chain parity matrix in
[`../../audit/README.md`](../../audit/README.md). This section
catalogues SVM-specific deliberate departures from the EVM
implementation; pair with the parity matrix when comparing the two
stacks.

### Workspace layout — where the EVM libs went

EVM groups protocol-wide invariants into `EVM/src/lib/`:

| EVM file | SVM equivalent |
|---|---|
| `lib/Constants.sol` | `crates/oku-shared/src/constants.rs` |
| `lib/MathLib.sol` | `crates/oku-shared/src/math.rs` + `vault_math.rs` |
| `lib/YieldSandwichGuard.sol` | `crates/oku-shared/src/yield_lock.rs` + per-program `helpers/yield_lock.rs` wrappers |
| `lib/Roles.sol` | `programs/lite-psm/src/roles.rs`, `programs/oku-dollar/src/roles.rs` (split — each program owns its own RBAC enum) |
| `lib/Errors.sol` | `programs/{lite-psm,oku-dollar}/src/errors.rs` (split — Anchor expects per-program `#[error_code]` enums) |
| `lib/events/*.sol` | `programs/*/src/events.rs` (split; same reason as errors) |
| `lib/SafeApprove.sol` | not ported — SPL Token-2022 doesn't have the EIP-20 allowance-zeroing footgun |
| `lib/ReentrancyGuardUpgradeable.sol` | not ported — Solana's account-lock model + no fallback fns means reentrancy isn't reachable the same way; the Token-2022 mint-extension allow-list closes the one residual path |

### OkuDollar rebasing model

EVM `OkuDollar` accrues USD yield continuously between calls via
`MathLib._rpow`. SVM `oku-dollar` uses a discrete `usd_multiplier`
bumped per orchestrator call (`update_usd_multiplier`). Reasons:

- Solana's Token-2022 `Scaled UI Amount` extension stores a flat
  scalar (no per-second compounding), so wallets cannot show
  continuously-growing balances anyway.
- Recomputing `_rpow` on every wrap / unwrap blows the BPF compute
  budget.

Economic effect: identical between calls, indistinguishable to users.

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
| `unwrap` when paused | reverts (full freeze) | reverts (full freeze) |
| `process_queue` when paused | proceeds — pause must not lock users in the queue | proceeds, same rationale |

### Oracle (USDC peg circuit-breaker)

Both sides ship a USDC peg circuit-breaker — **not** a Proof-of-Reserves
attestation. The audit-prep cycle deleted PoR on both sides because
operator-side reserve fraud is not a threat the on-chain code can
detect (managed via off-chain MSB controls). The remaining peg check
defends against USDC depeg events.

| Aspect | EVM | SVM |
|---|---|---|
| Oracle source | Chainlink AggregatorV3 | Pyth V2 (`SolanaPriceAccount`) |
| Where it lives | Separate UUPS proxy (`OracleRelay.sol`) | Embedded in `lite-psm` (`helpers/oracle_relay.rs`) |
| Upgradeability | UUPS proxy (flagged for simplification in EVM tracker) | None — operator redeploys `lite-psm` for changes |
| Round validity | answeredInRound, updatedAt, startedAt, staleness, positive answer | `agg.status == Trading`, freshness, positive answer, owner, header magic+version+atype |
| Decimal / expo normalization | `decimals` clamped to `MAX_FEED_DECIMALS = 18` | `|expo|` clamped to `MAX_FEED_EXPO_MAGNITUDE = 18` |
| Confidence band | n/a (Chainlink doesn't expose `conf`) | `conf / price ≤ MAX_ORACLE_CONFIDENCE_BPS = 200 bps` (cycle 4 / PSM-04) |
| Kill switch | `setOracleRelay(address(0))` on PSM + RedemptionQueue | `set_oracle_relay_feed(Pubkey::default())` on PSM |
| Pyth Receiver `PriceUpdateV2` support | n/a (EVM uses Chainlink) | NOT supported in v1; rotate via `set_oracle_relay_pyth_program_owner` when added |

### Inflation defense (vault first deposit)

Both sides reject zero-share mints via `AmountTooSmall`. SVM
additionally locks `MINIMUM_LIQUIDITY = 1_000_000` of dead shares
into a System-Program ATA on the first deposit, à la Uniswap V2.
EVM relies on the OZ ERC-4626 `previewDeposit` rounding +
`_decimalsOffset` only.

### Queue model

| Aspect | EVM | SVM |
|---|---|---|
| Storage | unbounded `mapping(uint256 → RedemptionEntry)` | fixed `[QueueEntry; 200]` zero-copy ring |
| Cap | none | 200 (10 KB single-CPI alloc budget) |
| Strict FIFO | yes (`head` / `tail`) | yes (`head` / `tail` u64 absolute indices) |
| Batch limit | none | `MAX_BATCH_ENTRIES = 50` per `process_queue` tx (CU budget) |
| Head-pin recovery | random-access `[startIndex, endIndex]` ranges | cycle 4 (PSM-06): permissionless `user_self_rescue_queue_entry` |

### Convenience functions

EVM `LitePSM` ships single-tx convenience flows (e.g. `mintUsdOku`,
`redeemUsdOku`). SVM previously housed these in a separate
`oku-bridge-router` program; that program was removed in the
noBridge refactor. SVM SDK consumers now compose multi-step flows
from the raw `mint_oku_m` / `wrap` / `unwrap` / `redeem_oku_m`
instructions.

### Events

PSM, vault, and queue events have matching shapes across EVM and SVM
with minor naming differences (e.g. `BufferRefilled` ↔
`BufferRefilledEvent`). For the field-by-field event-schema diff
see [`../../audit/README.md § Event schema differences`](../../audit/README.md).

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

- A Solana keypair with `buffer_depositor`, `queue_processor`, and
  `rebaser` roles. Same key signs `mint_oku_m` / `redeem_oku_m` for
  cross-chain settlement using its own ATAs as source/destination.
- An EVM EOA with `PSM_BUFFER_DEPOSITOR`, `PSM_QUEUE_PROCESSOR`,
  `OKUM_REBASER` (and a separate EVM owner key for relevant LitePSM
  admin actions).

Both KMS-backed. No on-chain bridge state, no chain whitelist, no
nonces, no refund flow — all cross-chain coordination is off-chain.

### Programs that exist on one side only

| Component | EVM | SVM | Notes |
|---|---|---|---|
| `OkuMoney` (ERC-20 / SPL Token-2022) | yes | yes | parity |
| `OkuDollar` vault | yes | yes (separate `oku-dollar` program) | parity |
| `LitePSM` | yes (`EVM/src/psm/LitePSM.sol`) | yes (`programs/lite-psm`) | parity |
| `RedemptionQueue` | inside `LitePSM` (separate file) | inside `lite-psm` (`state::RedemptionQueue`) | parity |
| `oku-bridge-router` convenience program | n/a | removed in noBridge | EVM never had a router program |
| On-chain bridge | removed in noBridge (`OkuBridge`, `OkuBridgeRouter`, `NttAdapter` deleted) | removed in noBridge | both sides v1 are off-chain orchestrator-mediated |

### Cross-program coupling — `oku-dollar` static-links `lite-psm` helpers

`programs/oku-dollar/src/instructions/core.rs` imports two helpers
directly from the `lite-psm` crate:

```rust
use lite_psm::helpers::mint_extensions::assert_oku_money_mint_extensions_whitelisted;
use lite_psm::helpers::yield_lock::check_yield_lock;
```

These are **NOT cross-program invocations.** The two programs share
the Cargo workspace; the helpers are linked at build time and run
inside the `oku-dollar` program's own runtime context (its own clock
sysvar read, its own account view). The functions are pure-Rust
predicates — no on-chain state mutation, no signer seeds, no CPI.

**Why it's done this way:** the mint-extension allow-list and the
yield-lock predicate must be byte-for-byte identical on both
programs so an OkuMoney mint accepted by `lite-psm::initialize` is
also accepted by `oku-dollar::initialize`, and any same-slot
`set_oku_m_price` blocks `wrap`/`unwrap` exactly as it blocks
`mint_oku_m`/`redeem_oku_m`. Duplicating the logic into both
programs would introduce drift risk; sharing via a CPI would
require a `lite-psm` instruction whose only job is to read state
the caller already has. Static-link is the cheapest correct option.

**Trust implication:** the `oku-dollar` program's logic is partly
"defined by" the `lite-psm` crate's source. A `lite-psm` source
change that subtly mutates either helper would propagate to
`oku-dollar` at the next workspace build. Reviewers should treat
the two crates as a single audit unit; the helper-import boundary
is a developer-ergonomics convenience, not a security one.

### `ScaledUiAmount` deferral

The Token-2022 `ScaledUiAmount` extension would let wallets render
OkuMoney with the on-chain multiplier baked into the displayed
balance (1 OkuM at `oku_m_price = 1.05e9` displays as "1.05" without
client-side math). The extension is explicitly REJECTED by
`assert_oku_money_mint_extensions_whitelisted` today because:

1. Wallet support is uneven across the major Solana wallet ecosystem
   (Phantom, Backpack, Solflare) as of cycle 4.
2. PSM math assumes a non-scaled mint — the `oku_m_price` field on
   `PsmConfig` is the protocol's source of truth for OkuM-to-dollar
   pricing, and `ScaledUiAmount` would introduce a second multiplier
   layer at the SPL level that the protocol math doesn't account for.

**Migration path if/when re-enabled:**

1. Add `ScaledUiAmount` to the allow-list in
   `lite-psm/src/helpers/mint_extensions.rs`.
2. Pin the Token-2022 multiplier value to `1` (no UI scaling) in
   `initialize` so the PSM-side `oku_m_price` remains the canonical
   pricing source; OR refactor PSM math to read the mint's
   ui-amount-multiplier and combine it with `oku_m_price`. The
   former is the conservative path — the extension's authority field
   is left unset so the multiplier cannot be changed later.
3. Redeploy under a new PDA seed (`psm_config_v4`, etc.), since
   changing the accepted-extension set on a live OkuMoney mint is
   not a property the existing init flow supports.

Deferred per cycle 4; revisit if/when major Solana wallets ship
`ScaledUiAmount` rendering and the marketing team prefers it over
the orchestrator-driven `okuMMultiplier` displayed in the dApp.

---

## Pointers

- **Workspace overview + cross-chain parity matrix:** [`../../audit/README.md`](../../audit/README.md)
- **Orchestrator runbook + deployment guide:** [`../README.md`](../README.md)
- **Open issues:** [`TRACKER.md`](TRACKER.md)
- **In-repo audit package** (accepted risks, clippy triage): [`oku-programs/audit/README.md`](oku-programs/audit/README.md)
- **Self-audit toolkit:** [`../../audit/SVM/README.md`](../../audit/SVM/README.md)
- **EVM-side docs:** [`../EVM/README.md`](../EVM/README.md)
