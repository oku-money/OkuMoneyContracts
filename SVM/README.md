# OkuMoney Solana Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solana implementation of OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Rust 1.85.0 (pinned in `rust-toolchain.toml`)
- **Framework**: Anchor 1.0.0 (`anchor_version` in `Anchor.toml`; `anchor-lang = "1.0.0"` in all `Cargo.toml`s)
- **Solana crates**: 3.x series (`solana_version = "3.1.10"` in `Anchor.toml`)
- **Token Standard**: Token-2022 (both OkuMoney and usdOku)
- **Oracle**: Pyth (manual account parsing, no SDK dependency)
- **Multisig**: Squads Protocol
- **JavaScript bindings**: `@anchor-lang/core ^1.0.0`

## Programs

### lite-psm
The core program housing the Peg Stability Module, redemption queue, yield distribution, and compliance (freeze/thaw). Holds mint and freeze authority over OkuMoney. All program authority is held by a PDA — no EOA controls minting.

### oku-dollar
Rebasing vault that wraps OkuMoney into usdOku. Users deposit OkuMoney and receive usdOku shares that appreciate as the `usd_multiplier` is updated by the orchestrator. Manages collateralization, reserve deposits/withdrawals, and enforces minimum collateral ratios.

### Cross-chain transfers (noBridge model, v1)
There is no on-chain bridge program. Cross-chain transfers are mediated by an off-chain orchestrator that holds the standard PSM operational roles (`buffer_depositor`, `queue_processor`, `rebaser`) and signs `mint_oku_m` / `redeem_oku_m` on each chain against its own ATAs. After mint on the destination chain the orchestrator does a normal SPL `transfer` to the recipient; after redeem on the source chain it custodies USDC and reflects the value on the other chain. See `../EVM/README.md` for the matching EVM side.

## Key Solana Design Choices

**Non-rebasing OkuMoney with stored price.** OkuMoney is a standard Token-2022 token with a static balance. The price is a stored `u64` value (`oku_m_price`) in the PsmConfig PDA, updated discretely by the orchestrator via `set_oku_m_price()` or `distribute_yield()`. Wallets and frontends read the config PDA to compute dollar values. No token extension is used for price display (Scaled UI Amount deferred pending ecosystem support).

**Discrete OkuDollar multiplier.** Unlike EVM where OkuDollar uses continuous `_rpow` streaming, the SVM implementation uses discrete `usd_multiplier` updates driven by the orchestrator. This is because Solana's token extensions cannot replicate the "balance grows every second" UX — the Scaled UI Amount extension stores a flat multiplier. Discrete updates are economically identical between orchestrator calls.

**Single-slot yield distribution lock.** Both `set_oku_m_price()` and `distribute_yield()` set `last_yield_distribution_slot = Clock::get().slot`. PSM and vault operations check `current_slot != last_yield_distribution_slot` before executing. This prevents sandwich attacks around discrete price updates, matching the EVM's `lastYieldDistributionBlock` pattern.

**No Pyth SDK dependency.** The oracle check manually parses Pyth V2 price account bytes (aggregate `price` at offset 208, `status` u8 at offset 224, aggregate-publish `timestamp` i64 at offset 96) to avoid transitive dependency conflicts. The accepted Pyth program owner pubkey is **per-deployment** (`PsmConfig::pyth_program_owner`, set at `initialize` and rotatable via `set_pyth_program_owner`), so deployments can target the legacy Pyth program (mainnet `FsJ3...`, devnet `gSbe...`) or any future Pyth deployment without recompilation. Source attribution and offsets are documented in `programs/lite-psm/src/helpers/oracle.rs` (note: offset 232 is `agg.pub_slot`, a Solana slot — NOT the publish timestamp; a previous revision used it by accident, see the `IMPORTANT` block at the top of `oracle.rs`).

**6-decimal tokens.** Both OkuMoney and usdOku use 6 decimals, matching USDC on Solana. EVM uses 18 decimals. The off-chain orchestrator handles decimal conversion when reflecting value across chains.

**No-TransferHook invariant on OkuMoney.** The PSM's effects-checks-interactions ordering and `check_yield_lock` sandwich guard both assume Token-2022 transfers/burns do NOT re-enter the PSM. A `TransferHook` extension would invalidate that assumption (the hook program runs mid-transfer with access to the caller's accounts). `initialize` parses the OkuMoney mint's Token-2022 extension list at init time and refuses any mint that has `ExtensionType::TransferHook` enabled (Phase 10; previously held only by operational discipline).

## Program Structure

```
crates/
  oku-shared/              # Pure-Rust workspace lib (no solana-*, no anchor-lang)
    src/
      lib.rs               # Re-exports
      constants.rs         # PRECISION, BASIS_POINTS, MAX_MULTIPLIER,
                           # MIN_COLLATERAL_RATIO_FLOOR, ORACLE_{MIN,MAX}_STALENESS_SECS
      math.rs              # mul_div_floor, oku_m_to_dollars, dollars_to_oku_m,
                           # calculate_fee — overflow-safe primitives returning Option<u64>

programs/
  lite-psm/
    src/
      lib.rs                # Instruction entry points
      state.rs              # PsmConfig, RedemptionQueue (zero-copy, MAX_ENTRIES=200)
      errors.rs             # Error codes
      events.rs             # Event definitions
      roles.rs              # AuthorityRole enum
      constants.rs          # Re-exports oku_shared::*
      helpers/
        yield_lock.rs       # check_yield_lock() — sandwich prevention
        oracle.rs           # check_oracle_reserves() — Pyth V2 manual parsing
        math.rs             # Anchor-error-flavoured wrappers over oku_shared::math
        mod.rs
      instructions/
        init.rs             # initialize (takes pyth_program_owner; rejects TransferHook mints),
                            # setup_redemption_queue, setup_oku_money_escrow
        psm.rs              # mint_oku_m, redeem_oku_m, process_queue, rescue_queue_entry,
                            # deposit_buffer, withdraw_buffer
        psm_admin.rs        # pause/unpause, freeze/thaw, set_authority (macro-driven),
                            # set_oracle, set_pyth_program_owner,
                            # set_max_supply, set_minter_allowance
        yield_ops.rs        # set_oku_m_price, distribute_yield
        mod.rs
      contexts/
        init.rs             # Initialize, SetupRedemptionQueue, SetupOkuMoneyEscrow
        psm.rs              # MintOkuM, RedeemOkuM, ProcessQueue, RescueQueueEntry, Buffer
        psm_admin.rs        # Pause, Unpause, FreezeAccount, ThawAccount, SetAuthority, ...
        yield_ops.rs        # SetOkuMPrice, DistributeYield
        mod.rs

  oku-dollar/
    src/
      lib.rs                # Instruction entry points
      constants.rs          # Re-exports oku_shared::* + vault-specific MINIMUM_LIQUIDITY
      state.rs              # OkuDollarConfig
      errors.rs
      events.rs
      roles.rs              # AuthorityRole enum
      helpers.rs            # Vault math: collateral ratio, surplus, share conversions,
                            # vault yield-lock guard. Single-multiplier helpers delegate to
                            # oku_shared::math.
      instructions/
        core.rs             # initialize, wrap, unwrap, update_usd_multiplier, reserves
        admin.rs            # pause/unpause, set_authority, set_min_collateral_ratio
        mod.rs
      contexts.rs           # All account contexts

tests/
  bankrun/                  # Default in-process suite (npm test, ~5s)
    smoke.ts
    lite-psm.ts
    oku-dollar.ts
    pyth-oracle.ts          # Hand-built Pyth V2 fixture
    init-invariants.ts      # TransferHook reject
    rate-over-time.ts       # Explicit slot/time warps + multi-tick rate accrual
    crossChainBridging.ts   # Orchestrator-mediated PSM mint/burn (noBridge v1)
  fork/                     # surfpool-based, ad-hoc (npm run test:fork)
    pyth-oracle.ts          # Mainnet-fork live Pyth
    _shared/
      surfpool.ts
      assertions.ts
      legacy-funder.ts
  shared/
    setup.ts                # Shared authority keypairs + initializePsm
    bankrun.ts              # Harness, helpers, autoBumpSlot wrapper

scripts/
  deploy/
    deploy-programs.ts     # Phase 1: build + deploy .so files, save program IDs
    deploy-init.ts         # Phase 2: create tokens + initialize PSM / Vault
    lib/                   # Worker modules (build, config, programs, tokens, initialize, verify)
  test/
    test-devnet.ts         # On-chain smoke tests (devnet / fork)
  config/
    constants.ts           # Supply limits, oracle config
    networks.ts            # RPC endpoints, network type, per-network USDC/Pyth
    authorities.ts         # Role→pubkey mapping (deployer on testnet, multisigs on mainnet)
  utils/
    network.ts             # detectNetwork, createProvider, loadKeypair, isForkNetwork
    logger.ts              # Colored console logger
    addressBook.ts         # Load/save deployments/*.json
    pdaHelpers.ts          # Canonical PDA derivation functions
    tokenHelpers.ts        # createToken2022Mint, createSPLTokenMint
    surfpool.ts            # logSurfpoolStatus (script-layer only)
    testnetRegistry.ts     # syncSvmRegistry — mirror deployments into repo-root testnet-addresses.json
    exportIdls.ts          # Copy generated Anchor IDLs into the off-chain SDK
    check-wallet.ts        # CLI: print SOL balance
    calculateDeploymentCost.ts  # CLI: estimate .so rent cost
```

## State Accounts

### PsmConfig PDA (`b"psm_config"`)

```rust
pub struct PsmConfig {
    pub bump: u8,
    // 12 authority pubkeys: role_admin, pauser, unpauser, freezer, unfreezer,
    //   queue_processor, buffer_depositor, buffer_withdrawer, oracle_manager,
    //   cap_manager, allowance_manager, rebaser
    // Token references: usdc_mint, oku_money_mint, vault_usdc, vault_oku_money
    // Limits: max_supply, minter_allowance, is_paused
    // Oracle: oracle (Pubkey), staleness_threshold (i64)
    // Yield: last_yield_distribution_slot (u64), oku_m_price (u64)
    // Pyth: pyth_program_owner (Pubkey)
    // RoleAdmin two-step: pending_role_admin (Pubkey)
}
```

### OkuDollarConfig PDA (`b"oku_dollar_config"`)

```rust
pub struct OkuDollarConfig {
    pub bump: u8,
    // Authorities: role_admin, pauser, unpauser, usd_rebaser, reserve_manager
    // Token references: oku_money_mint, usd_oku_mint, reserve_vault, psm_config
    // USD multiplier: usd_multiplier (u64), usd_last_update_time (i64)
    // Collateralization: min_collateral_ratio (u64)
    // State: is_paused (bool)
}
```

### RedemptionQueue PDA (`b"redemption_queue"`)

Zero-copy ring buffer (200 entries max — `MAX_ENTRIES`). Each entry:
`{ user: Pubkey, oku_m_amount: u64, timestamp: i64 }` = 48 bytes.
Total account size 9 640 bytes; rent ~0.067 SOL one-time at deploy.
Cap of 200 (vs the EVM spec target of 500) is bounded by Solana's
10 KB single-CPI allocation budget — see `EVM_VS_SVM.md` and
the queue capacity section in `TRACKER.md`. Strict FIFO is preserved via the
`head`/`tail` `u64` absolute indices.

## Core Operations

### OkuMoney Price Updates

```rust
// Direct price set — REBASER only, monotonic, sets yield lock
pub fn set_oku_m_price(new_multiplier: u64)

// Dollar-denominated yield distribution — REBASER only
// new_price = old_price + (yield_amount * PRECISION / total_supply)
pub fn distribute_yield(yield_amount: u64)
```

Both set `last_yield_distribution_slot = Clock::get().slot` for sandwich prevention.

### PSM (Price-Aware)

```rust
// oku_m_amount = usdc_amount * PRECISION / oku_m_price
pub fn mint_oku_m(usdc_amount: u64)

// usdc_amount = oku_m_amount * oku_m_price / PRECISION
pub fn redeem_oku_m(oku_m_amount: u64)  // instant or queued

pub fn process_queue(max_entries: u32)   // price cached once per batch; hard-capped at MAX_BATCH_ENTRIES=50
pub fn rescue_queue_entry(queue_index: u64)  // return OkuM for stuck entries; queue_index is absolute u64
```

All protected by yield distribution lock.

### OkuDollar Vault (Price-Aware)

```rust
// shares = oku_m_amount * oku_m_price / usd_multiplier
pub fn wrap(oku_m_amount: u64, min_shares_out: u64) -> Result<u64>

// oku_m_returned = shares * usd_multiplier / oku_m_price
pub fn unwrap(shares: u64)

pub fn update_usd_multiplier(new_usd_multiplier: u64)  // USD_REBASER, monotonic
pub fn deposit_reserves(amount: u64)       // RESERVE_MANAGER, no shares minted
pub fn withdraw_reserves(amount: u64)      // RESERVE_MANAGER, enforces min collateral
```

Wrap and unwrap are both protected by the yield distribution lock (reads PsmConfig cross-program). Unwrap is blocked when paused (full freeze, matching EVM behavior). First deposit enforces MINIMUM_LIQUIDITY dead shares for inflation attack prevention.

### Collateralization (Price-Aware)

```
ratio = (reserve_balance × oku_m_price × PRECISION) / (total_supply × usd_multiplier)
```

`withdraw_reserves` enforces `ratio >= min_collateral_ratio` after withdrawal. `update_usd_multiplier` verifies sufficient collateralization after the update.

### Cross-Chain (noBridge, v1)

No on-chain bridge instructions. The orchestrator calls `mint_oku_m` /
`redeem_oku_m` against its own ATAs on each chain and reconciles value
off-chain. If a future on-chain bridge is needed (NTT, CCIP, native
OkuBridge port), it ships as a *new* program that's granted `OKUM_MINTER`
authority via PSM — additive, not a `lite-psm` upgrade.

**`mint_oku_m` is fully permissionless.** Any USDC holder can call it; the
orchestrator does NOT hold a privileged mint authority. The PSM config PDA
is the OkuMoney mint authority and signs the inner `mint_to` CPI.
Orchestrator key compromise does not grant mint privilege beyond the
orchestrator's USDC custody. This property is load-bearing; the bankrun test
`crossChainBridging.ts § 'a random key can call mint_oku_m'` asserts it.

**Cross-chain USDC flow conservation invariant (per bridge):**

```
|usdc_out_A - usdc_in_B| ≤ 1 micro-USDC per bridge
```

See [`docs/orchestrator-runbook.md`](../docs/orchestrator-runbook.md) for
operational procedures (preflight, failure recovery, multiplier sequencing,
minterAllowance rotation, monitoring SLAs).

## Precision Model

```rust
const PRECISION: u64 = 1_000_000_000; // 1e9

// oku_m_price: 1_000_000_000 = $1.00, 1_045_000_000 = $1.045
// usd_multiplier: 1_000_000_000 = 1:1

// All intermediate calculations use u128 to prevent overflow
// Rounding favors protocol/vault (round DOWN throughout)
```

## Hardcoded Constants

Constants are split across two locations: shared protocol constants live in [`crates/oku-shared/src/constants.rs`](oku-programs/crates/oku-shared/src/constants.rs); program-specific constants live in each program's own `constants.rs`. None can be changed without a program upgrade.

### Shared (`oku-shared`)

| Constant | Value | Rationale |
|---|---|---|
| `PRECISION` | `1_000_000_000` (1e9) | Fixed-point base for all multiplier math. SVM tokens are 6 decimal; 1e9 gives 3 fractional digits of price precision above the token unit. Mirrors EVM's 1e18 at a scale appropriate for `u64`. Not arbitrary — changing it rewrites all math. |
| `BASIS_POINTS` | `10_000` | Universal basis-points denominator. Industry convention. |
| `MIN_COLLATERAL_RATIO_FLOOR` | `900_000_000` (90% of PRECISION) | Hard floor below which `min_collateral_ratio` can never be configured. **The 90% value is a round-number convention** — see EVM README for full rationale. Mirrors EVM `Constants.MIN_COLLATERAL_RATIO_FLOOR`. Only gates `withdraw_reserves`; does not automatically halt other operations if the live ratio drifts below it. |
| `MAX_MULTIPLIER` / `MAX_OKU_M_PRICE` / `MAX_USD_MULTIPLIER` | `1_000_000_000_000_000` (1e15, = $1,000,000/token) | Overflow guard on both `oku_m_price` and `usd_multiplier`. Chosen as a round number far above realistic yield trajectories. Arbitrary — any large value that keeps `u64 * u64 -> u128` away from overflow would work. Defense-in-depth against a compromised rebaser key. |
| `ORACLE_MIN_STALENESS_SECS` | `60` seconds | Lower bound on the configurable Pyth staleness threshold. Prevents a window so tight that benign jitter causes every mint to fail. Value is arbitrary within the constraint of "below any realistic Pyth update interval." Mirrors EVM `ORACLE_MIN_STALENESS`. |
| `ORACLE_MAX_STALENESS_SECS` | `604_800` (7 days) | Upper bound on the configurable staleness threshold. Prevents a misconfiguration that makes the oracle check a no-op. 7 days is a conventional sentinel; any value of hours-to-days would serve the same purpose. Mirrors EVM `ORACLE_MAX_STALENESS`. |
| `TOKEN_DECIMALS` | `6` | Both OkuMoney and OkuDollar use 6 decimals on SVM, matching USDC on Solana. Not arbitrary — hardcoded to prevent misconfiguration and asserted at `initialize`. |

### Lite-PSM (`programs/lite-psm/src/constants.rs`)

After the noBridge refactor `lite-psm/src/constants.rs` only re-exports
shared constants from `oku-shared`; no program-specific values remain.

### OkuDollar (`programs/oku-dollar/src/constants.rs`)

| Constant | Value | Rationale |
|---|---|---|
| `MINIMUM_LIQUIDITY` | `1_000_000` (1 usdOku at 6 decimals) | Dead shares permanently locked in a System Program ATA on first deposit, preventing the first-depositor share-inflation attack. Pattern from Uniswap V2 `MINIMUM_LIQUIDITY`. The value of 1 full token (10^6) is a conventional choice — large enough to make inflation attacks economically infeasible, small enough to not meaningfully dilute early depositors. Arbitrary above a minimum threshold. |

### Queue / Batch Limits (embedded in `state.rs` / `instructions/`)

| Constant | Value | Location | Rationale |
|---|---|---|---|
| `MAX_ENTRIES` | `200` | `lite-psm/src/state.rs` | Maximum entries in the `RedemptionQueue` zero-copy ring buffer. Bounded by Solana's ~10 KB single-CPI allocation budget (200 × 48 bytes = 9 600 bytes + header). The exact value is a practical ceiling given the allocation constraint, not a free choice. Increasing it requires a multi-step `realloc` upgrade. |
| `MAX_BATCH_ENTRIES` | `50` | `lite-psm/src/instructions/psm.rs` | Maximum queue entries processed in a single `process_queue` call. Bounded by the BPF compute-unit budget per transaction. 50 is a conservative round number; the exact limit depends on per-entry CU cost and may be tightened or loosened without a program upgrade if the instruction is refactored. |

---

## Authority Model

Granular per-action roles — no single admin key. For the full centralized
trust model and what each key tier can/cannot do see
`README.md § Signer trust implications`. SVM-specific table:

| Role | Program | Held By | What it can do | What on-chain code prevents |
|------|---------|---------|---|---|
| `role_admin` | PSM + Vault | Cold Multisig (Squads) | Rotate any other role via `set_authority`; also triggers the two-step `accept_role_admin` handshake for its own transfer | Nothing — this is the meta-role. Quorum breach = full system compromise. SVM adds a propose/accept pattern for rotating `role_admin` itself (so accidental rotation to a typo'd address is recoverable) |
| `pauser` | PSM + Vault | Warm Multisig | Set `is_paused = true`, halting mint/redeem/wrap/unwrap | Cannot unpause — that requires `unpauser` (cold multisig). Cannot access funds. |
| `unpauser` | PSM + Vault | Cold Multisig | Clear `is_paused`. Deliberate-review path — should require quorum discussion before resuming a paused protocol | — |
| `freezer` | PSM | Warm Multisig | CPI-freeze any OkuMoney ATA via Token-2022 freeze authority (PDA-signed). Blocks the ATA holder from all transfers | Cannot drain or redirect the frozen tokens |
| `unfreezer` | PSM | Cold Multisig | CPI-thaw a frozen ATA | — |
| `rebaser` | PSM | Orchestrator (KMS) | Update `oku_m_price` (non-decreasing OkuMoney multiplier) and call `distribute_yield` | Cannot decrease `oku_m_price`; hard-capped at `MAX_OKU_M_PRICE` (1e15). Cannot access funds or admin params. |
| `usd_rebaser` | Vault | Orchestrator (KMS) | Update `usd_multiplier` (non-decreasing usdOku multiplier) | Cannot decrease `usd_multiplier`; hard-capped at `MAX_USD_MULTIPLIER`. Cannot push vault below `min_collateral_ratio`. |
| `reserve_manager` | Vault | Cold Multisig | `deposit_reserves` (adds OkuM backing) and `withdraw_reserves` (extracts surplus) | Cannot withdraw below `min_collateral_ratio` floor (enforced post-withdrawal by on-chain check) |
| `queue_processor` | PSM | Orchestrator | Run `process_queue` (pays out USDC to queued redemption entries) and `rescue_queue_entry` (redirects stuck OkuM to alternate recipient on a specific entry) | `process_queue` pays the entry's `user` field — cannot reroute. `rescue_queue_entry` can redirect OkuM but only per-entry, not in bulk; requires the specific queue index |
| `buffer_depositor` | PSM | Orchestrator | Transfer USDC from caller's ATA into the PSM vault | Caller must hold USDC; no damage possible |
| `buffer_withdrawer` | PSM | Cold Multisig | Drain USDC from the PSM vault | Cannot withdraw below the USDC reserved for pending queue entries |
| `oracle_manager` | PSM | Cold Multisig | Set `config.oracle` and `staleness_threshold`; also `set_pyth_program_owner`. A swap to an attacker-controlled oracle could allow unbacked mints up to `max_supply` | Staleness bounded to `[ORACLE_MIN_STALENESS_SECS, ORACLE_MAX_STALENESS_SECS]`. `set_oracle` validates Pyth header magic + version before persisting |
| `cap_manager` | PSM | Cold Multisig | Set `max_supply` | Cannot set below current circulating supply |
| `allowance_manager` | PSM | Cold Multisig | Set `minter_allowance`. The PSM PDA is the OkuMoney mint authority — mints still flow through program logic even at high allowance | Bounded above by `max_supply`; mint authority lives on the config PDA, not on any EOA |

Key separation: `rebaser` (rear-facing, factual — updates OkuMoney price from realized T-Bill returns) ≠ `usd_rebaser` (forward-facing, policy — updates usdOku yield multiplier set by Oku).

Cross-chain transfers (v1) re-use this same orchestrator: it holds
`queue_processor` + `buffer_depositor` + `rebaser` and drives both
PSM-side queue ops *and* off-chain bridging by calling `mint_oku_m` /
`redeem_oku_m` on each chain.

## Initialization

PSM initialization is split into three instructions to avoid BPF stack overflow
on the large account contexts:

1. `initialize(... pyth_program_owner)` — creates `PsmConfig` and the USDC
   vault. The Pyth program-owner pubkey accepted by the on-chain oracle check
   is supplied here (rotatable post-deploy via `set_pyth_program_owner`).
2. `setup_redemption_queue` — creates the `RedemptionQueue` PDA.
3. `setup_oku_money_escrow` — creates the OkuMoney escrow vault for queued
   redemptions.

OkuDollar vault initialization is a single call:

- `initialize` — creates `OkuDollarConfig`, the usdOku mint (authority = config
  PDA), and the OkuMoney reserve vault.

No on-chain bridge or router is deployed (noBridge model — see top of
this file).

## EVM vs SVM Differences

For the full divergence table see [`EVM_VS_SVM.md`](./EVM_VS_SVM.md).
Quick summary:

| Aspect | EVM | SVM |
|--------|-----|-----|
| OkuMoney price | Stored `uint256`, 18 decimals | Stored `u64`, 1e9 precision |
| OkuDollar multiplier | Continuous `_rpow` streaming | Discrete orchestrator updates |
| Yield lock | `block.number` | `Clock::slot` (PSM **and** vault) |
| Token decimals | 18 | 6 |
| Oracle | Chainlink AggregatorV3 | Pyth V2 (status, expo, staleness all checked) |
| Inflation defense | `AmountTooSmall` on zero shares | Same + Uniswap-V2-style dead shares |
| Convenience functions | On LitePSM | Composed off-chain by the SDK (no router program) |
| Wallet price display | Frontends read `okuMMultiplier()` view | Frontends read `PsmConfig.oku_m_price` from the config PDA |
| Cross-chain transfers (v1) | Off-chain orchestrator + PSM mint/burn | Off-chain orchestrator + PSM mint/burn |
| Queue size | Unbounded (mapping) | Fixed `[QueueEntry; 200]` zero-copy ring (capped by Solana's 10 KB single-CPI alloc budget; see TRACKER.md for 200→500 upgrade path) |

## Error Codes

Full list in `programs/lite-psm/src/errors.rs` and `programs/oku-dollar/src/errors.rs`. Key errors:

- `YieldDistributionInProgress` — operation blocked during yield lock
- `PriceCannotDecrease` — `oku_m_price` is monotonically increasing
- `MultiplierCannotDecrease` — `usd_multiplier` is monotonically increasing
- `InsufficientReserves` — vault cannot cover unwrap
- `InsufficientCollateral` — withdrawal would breach minimum collateral ratio
- `SlippageExceeded` — output below minimum specified by user

## Testing

```bash
# Full bankrun suite — 119 tests, ~14 seconds in-process.
npm test
# or directly:
npx mocha --require tsx --timeout 60000 'tests/bankrun/**/*.ts'

# Individual bankrun test files
npx mocha --require tsx --timeout 60000 'tests/bankrun/lite-psm.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/oku-dollar.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/pyth-oracle.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/rate-over-time.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/crossChainBridging.ts'
npx mocha --require tsx --timeout 120000 'tests/bankrun/scenarios/realWorldUsage.ts'  # 60-day sim

# Fork tests — exercises real mainnet Pyth state via Surfpool.
#   1. Start Surfpool: npm run surfpool:mainnet
#   2. Run fork tests: npm run test:fork

# Trident property-based fuzz harnesses (WS4.1/4.2 / WS8.3)
# types.rs has been regenerated and split (one per harness).
# #[init] is not yet wired (PsmConfig/OkuDollarConfig won't be pre-initialised).
# The #[end] invariants are guarded by data-length checks and are no-ops until
# #[init] is wired. See TODO in each test_fuzz.rs for the init procedure.
trident fuzz run fuzz_lite_psm   # oku_m_price monotonicity + ceiling
trident fuzz run fuzz_oku_dollar  # usd_multiplier monotonicity + ceiling
```

### Runner notes

The entire unit suite runs on
[`solana-bankrun`](https://github.com/kevinheavey/solana-bankrun) via the
thin `anchor-bankrun` adapter. Bankrun executes the BPF programs
in-process on `litesvm`, eliminating:

- the 30 s confirmation-polling window in `@solana/web3.js@1.x` (no validator → no RPC → no polling);
- wall-clock waits for slot rollover (handled by the harness's `autoBumpSlot` option).

**`autoBumpSlot` (default on).** `startBankrun()` wraps
`provider.sendAndConfirm` so every transaction advances the bankrun
slot by 1 before submission. This handles two unrelated annoyances at
once:

- `check_yield_lock` rejects any op in the same slot as the last
  `distribute_yield` / `set_oku_m_price`. Without auto-bump, any test
  ordering that follows a yield op hits `YieldDistributionInProgress`.
- Bankrun caches identical-byte transactions and replays the prior
  result ("This transaction has already been processed"). Auto-bump
  forces a fresh blockhash on every submission.

Tests that need strict slot semantics can pass
`startBankrun({ autoBumpSlot: false })` and call `warpSlots(h, n)`
explicitly.


## Deployment

Deployment is two phases. Phase 1 builds and deploys the program `.so` files;
Phase 2 creates the token mints (Token-2022 with `InterestBearingConfig`
extension for OkuMoney, standard SPL for mock USDC on devnet) and initializes
all program state. The PSM `config` PDA is set as both mint and freeze
authority on the OkuMoney mint at creation time — no manual `spl-token
authorize` step is needed.

```bash
# 1. Build and deploy programs (Phase 1)
npm run deploy:programs            # devnet
npm run deploy:programs:mainnet    # mainnet-beta

# 2. Create tokens + initialize PSM / Vault (Phase 2)
npm run deploy:init                # devnet
npm run deploy:init:mainnet        # mainnet-beta

# 3. Set program upgrade authorities to the cold multisig (mainnet only)
solana program set-upgrade-authority <LITE_PSM_PROGRAM>   --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

On mainnet, `OkuMoney` is created with mint authority = PSM config PDA. There
is no path for an EOA to mint OkuMoney post-deployment.

## Runbook

This section captures operational requirements and one-time setup steps
that aren't enforced by code. Treat this as a checklist for any
external-facing deployment.

### Pre-mainnet checklist

- [ ] Verify `security_txt!` contact in both programs. Currently points
      at the GitHub security advisory URL; replace with a dedicated
      `email:security@<domain>` if one exists before mainnet deploy.
      (`programs/{lite-psm,oku-dollar}/src/lib.rs`)
- [ ] `MAINNET_ORCHESTRATOR` env var (used by the v1 noBridge cross-chain
      flow) points at a KMS-backed signer, not the deployer wallet.
- [ ] BPF loader upgrade authority transferred to the cold multisig:
      ```bash
      solana program set-upgrade-authority <LITE_PSM_PROGRAM>   --new-upgrade-authority <SQUADS_COLD_VAULT>
      solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
      ```
- [ ] Pyth feed configured (`scripts/admin/set-oracle.ts --oracle=<feed>
      --staleness=300`). The feed MUST publish reserves in OkuMoney base
      units (6 decimals) with `expo == 0` and `agg.status == Trading`.
      The legacy Pyth V2 `SolanaPriceAccount` layout is required; the
      modern Pyth Solana Receiver (`PriceUpdateV2`) is NOT supported.
- [ ] Anchor.toml `[programs.<network>]` matches the freshly-deployed
      keypair IDs (printed at the end of `deploy:programs`). Devnet
      and localnet sections are kept SEPARATE on purpose — preserves
      the option to rotate one cluster without touching the other.

### Orchestrator key

In v1 (noBridge) the orchestrator holds a single Solana keypair that
signs `mint_oku_m` / `redeem_oku_m` and the operational PSM ops it has
granted roles for (`buffer_depositor` / `queue_processor` / `rebaser`).
It also holds the matching EVM key on the other side. Both keys should
be KMS-backed.

A future on-chain bridge (NTT, CCIP, native OkuBridge port) would add a
separate signing scheme — kept out of the v1 deployment.

### Queue capacity SLA

The `RedemptionQueue` is a fixed 200-entry zero-copy ring buffer.
Operations discipline:

- Keep `vault_usdc.amount` topped up so `redeem_oku_m` falls into the
  instant path (buffer >= queued obligations + new redemption).
- If the queue ever fills (200 simultaneously-pending redemptions), the
  201st `redeem_oku_m` reverts with `QueueFull`. The fix is to call
  `process_queue` from a `queue_processor`-keyed orchestrator.
- `process_queue` is hard-capped at `MAX_BATCH_ENTRIES = 50` per tx (CU
  budget). To drain 200 entries you need at least 4 `process_queue`
  calls. The orchestrator is responsible for batching.
- Cron template (orchestrator side):
  ```bash
  while true; do
      npm run admin:process-queue   # auto-loops until empty, batching at MAX_BATCH_ENTRIES=50
      sleep 60
  done
  ```
  `scripts/admin/process-queue.ts` auto-batches across multiple txs in a
  single invocation, so the cron is a thin "kick it periodically"
  wrapper. Pass `--max=<N>` to cap how many entries a single invocation
  drains (defaults to drain-to-empty).

A future redesign could lift the cap from 200 → 500 via a multi-step
`init + 2× realloc` deploy flow OR per-user PDAs. See TRACKER.md.
Defer until telemetry shows the 200-entry cap is a real production constraint.

### Pyth feed requirements

The on-chain oracle parser at `lite_psm::helpers::oracle::check_oracle_reserves`
expects the legacy Pyth V2 `SolanaPriceAccount` layout. The feed must:

1. Be owned by `PsmConfig::pyth_program_owner` (set at init via
   `initialize`, rotatable via
   `npm run admin:set-pyth-program-owner -- --new=<pubkey>`).
2. Have the canonical Pyth header: `magic == 0xa1b2c3d4`, `ver == 2`,
   `atype == 3` (Price). The parser rejects non-canonical headers.
3. Have `agg.status == Trading` (1). Halted, Auction, Unknown, and
   Ignored states are rejected. The byte-width is `u8`.
4. Have `expo == 0`. The price is interpreted directly as a raw
   token-count of reserves with no scaling. A custom feed publishing
   reserves in OkuMoney base units (6 decimals) is the expected
   configuration.
5. Be fresh per `staleness_threshold` (set via
   `npm run admin:set-oracle -- --oracle=<feed> --staleness=<secs>`,
   bounded to `[60s, 7 days]`).

The modern Pyth Solana Receiver (`PriceUpdateV2`) uses a different
layout and is NOT supported until a parallel parser is added.

### Cross-chain refund / recovery

In v1 there is no on-chain refund flow because there is no on-chain
bridge. If an off-chain cross-chain transfer is interrupted (e.g.
orchestrator outage between the source redeem and the destination
mint), the orchestrator reconciles state by re-running the mint on the
destination once it has the USDC, or by re-minting on the source if it
never actually redeemed.

### Admin scripts

All admin scripts live under `scripts/admin/`. Each:

- prints a human-readable summary block before any state change
- honors `--dry-run` (build the tx, simulate, don't submit)
- on `mainnet-beta` / `mainnet-fork`, requires
  `--yes-i-mean-it-on-mainnet` OR an interactive `yes` prompt

| Script | Wraps | Role gate |
|---|---|---|
| `admin:set-authority` | `set_authority` | `role_admin` |
| `admin:pause-psm` / `admin:unpause-psm` | `pause` / `unpause` | `pauser` / `unpauser` |
| `admin:set-oracle` | `set_oracle` | `oracle_manager` |
| `admin:set-pyth-program-owner` | `set_pyth_program_owner` | `oracle_manager` |
| `admin:set-max-supply` | `set_max_supply` | `cap_manager` |
| `admin:set-minter-allowance` | `set_minter_allowance` | `allowance_manager` |
| `admin:set-oku-m-price` | `set_oku_m_price` | `rebaser` (stamps yield-distribution slot) |
| `admin:distribute-yield` | `distribute_yield` | `rebaser` |
| `admin:freeze-account` / `admin:thaw-account` | `freeze_account` / `thaw_account` | `freezer` / `unfreezer` |
| `admin:process-queue` | `process_queue` (orchestrator drain; auto-batches to drain-to-empty) | `queue_processor` |
| `admin:close-programs` | `solana program close` (BPF loader) — recover rent from stale program deployments. Default targets are `deployments/<network>.json::programs.*`; pass `--ids=A,B,C` for explicit IDs. Refuses to close IDs currently in `Anchor.toml [programs.<network>]` unless `--allow-anchor-toml-ids`. | BPF upgrade authority (deployer wallet) |

### Smaller follow-ups

See [`SVM/TRACKER.md`](./TRACKER.md) for all open and deferred items.