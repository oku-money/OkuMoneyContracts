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
The core program housing the Peg Stability Module, cross-chain bridge, redemption queue, yield distribution, and compliance (freeze/thaw). Holds mint and freeze authority over OkuMoney. All program authority is held by a PDA — no EOA controls minting.

### oku-dollar
Rebasing vault that wraps OkuMoney into usdOku. Users deposit OkuMoney and receive usdOku shares that appreciate as the `usd_multiplier` is updated by the orchestrator. Manages collateralization, reserve deposits/withdrawals, and enforces minimum collateral ratios.

### oku-bridge-router
Convenience program providing single-transaction flows: `bridge_oku_m` (direct bridge), `bridge_usd_oku` (unwrap + bridge), `mint_usd_oku` (USDC → usdOku), `redeem_usd_oku` (usdOku → USDC). Combines CPI calls to lite-psm and oku-dollar.

## Key Solana Design Choices

**Non-rebasing OkuMoney with stored price.** OkuMoney is a standard Token-2022 token with a static balance. The price is a stored `u64` value (`oku_m_price`) in the PsmConfig PDA, updated discretely by the orchestrator via `set_oku_m_price()` or `distribute_yield()`. Wallets and frontends read the config PDA to compute dollar values. No token extension is used for price display (Scaled UI Amount deferred pending ecosystem support).

**Discrete OkuDollar multiplier.** Unlike EVM where OkuDollar uses continuous `_rpow` streaming, the SVM implementation uses discrete `usd_multiplier` updates driven by the orchestrator. This is because Solana's token extensions cannot replicate the "balance grows every second" UX — the Scaled UI Amount extension stores a flat multiplier. Discrete updates are economically identical between orchestrator calls.

**Single-slot yield distribution lock.** Both `set_oku_m_price()` and `distribute_yield()` set `last_yield_distribution_slot = Clock::get().slot`. PSM and vault operations check `current_slot != last_yield_distribution_slot` before executing. This prevents sandwich attacks around discrete price updates, matching the EVM's `lastYieldDistributionBlock` pattern.

**No Pyth SDK dependency.** The oracle check manually parses Pyth V2 price account bytes (aggregate `price` at offset 208, `status` u8 at offset 224, aggregate-publish `timestamp` i64 at offset 96) to avoid transitive dependency conflicts. The accepted Pyth program owner pubkey is **per-deployment** (`PsmConfig::pyth_program_owner`, set at `initialize` and rotatable via `set_pyth_program_owner`), so deployments can target the legacy Pyth program (mainnet `FsJ3...`, devnet `gSbe...`) or any future Pyth deployment without recompilation. Source attribution and offsets are documented in `programs/lite-psm/src/helpers/oracle.rs` (note: offset 232 is `agg.pub_slot`, a Solana slot — NOT the publish timestamp; a previous revision used it by accident, see the `IMPORTANT` block at the top of `oracle.rs`).

**Ed25519 introspection, not native verification.** `bridge_mint` requires an `Ed25519Program` instruction at transaction index 0 and compares its data byte-for-byte against the expected instruction. This is the canonical Solana pattern for signature verification.

**6-decimal tokens.** Both OkuMoney and usdOku use 6 decimals, matching USDC on Solana. EVM uses 18 decimals. The bridge layer handles decimal conversion.

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
      state.rs              # PsmConfig, RedemptionQueue (zero-copy, MAX_ENTRIES=200),
                            # BridgeConfig, BridgeNonce, ProcessedRequest,
                            # RefundedRequest, PendingRefund, etc.
      errors.rs             # Error codes
      events.rs             # Event definitions
      roles.rs              # AuthorityRole, BridgeAuthorityRole enums
      constants.rs          # Re-exports oku_shared::* + bridge-specific bounds
      helpers/
        yield_lock.rs       # check_yield_lock() — sandwich prevention
        oracle.rs           # check_oracle_reserves() — Pyth V2 manual parsing
        ed25519.rs          # verify_ed25519_signature() — instruction introspection
        math.rs             # Anchor-error-flavoured wrappers over oku_shared::math
        mod.rs
      instructions/
        init.rs             # initialize (takes pyth_program_owner; rejects TransferHook mints),
                            # setup_redemption_queue, setup_oku_money_escrow
        psm.rs              # mint_oku_m, redeem_oku_m, process_queue, rescue_queue_entry,
                            # deposit_buffer, withdraw_buffer
        psm_admin.rs        # pause/unpause, freeze/thaw, set_authority (macro-driven),
                            # initialize_blacklist_exempt, set_oracle,
                            # set_pyth_program_owner, set_max_supply, set_minter_allowance
        yield_ops.rs        # set_oku_m_price, distribute_yield
        bridge.rs           # bridge_mint, bridge_burn, initiate_refund, confirm_refund,
                            # cancel_refund
        bridge_admin.rs     # initialize_bridge (BridgeInitConfig), add/remove_supported_chain,
                            # update_bridge_fee/limits/deadline, pause/unpause_bridge,
                            # skip_nonce, update_orchestrator_signer, update_fee_recipient,
                            # set_bridge_authority (macro-driven)
        mod.rs
      contexts/
        init.rs             # Initialize, SetupRedemptionQueue, SetupOkuMoneyEscrow
        psm.rs              # MintOkuM, RedeemOkuM, ProcessQueue, RescueQueueEntry, Buffer
        psm_admin.rs        # Pause, Unpause, FreezeAccount, ThawAccount, SetAuthority, ...
        yield_ops.rs        # SetOkuMPrice, DistributeYield
        bridge.rs           # BridgeMint, BridgeBurn, InitiateRefund, ConfirmRefund, ...
        bridge_admin.rs     # BridgeAdmin contexts
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

  oku-bridge-router/
    src/
      lib.rs                # bridge_oku_m, bridge_usd_oku, mint_usd_oku, redeem_usd_oku
      state.rs              # RouterConfig
      errors.rs
      events.rs
      roles.rs
      validation.rs         # Defence-in-depth cross-program PDA checks
      instructions/
        core.rs             # CPI-based instruction handlers
        admin.rs
        mod.rs
      contexts.rs           # All account contexts

tests/
  bankrun/                  # Default in-process suite (npm test, ~5s)
    smoke.ts
    lite-psm.ts
    bridge_security.ts
    oku-bridge-router.ts
    oku-dollar.ts
    pyth-oracle.ts          # Hand-built Pyth V2 fixture
    init-invariants.ts      # TransferHook reject
  fork/                     # surfpool-based, ad-hoc (npm run test:fork)
    pyth-oracle.ts          # Mainnet-fork live Pyth
    _shared/
      surfpool.ts
      assertions.ts
      legacy-funder.ts
  shared/
    setup.ts                # Shared authority keypairs + initializePsm
    bankrun.ts              # Harness, helpers, autoBumpSlot wrapper
    bridge-helpers.ts       # Bridge-test helpers (Ed25519 + mint tx construction)

scripts/
  deploy/
    deploy-programs.ts     # Phase 1: build + deploy .so files, save program IDs
    deploy-init.ts         # Phase 2: create tokens + initialize PSM/Vault/Router
    lib/                   # Worker modules (build, config, programs, tokens, initialize, verify)
  bridge/
    bridge-burn-to-evm.ts  # Call bridgeBurn, write bridge-request.json
    bridge-mint-from-evm.ts # Sign + submit bridgeMint from bridge-request.json
    check-bridge-state.ts  # Read-only diagnostics
  test/
    test-devnet.ts         # 8-step on-chain smoke tests (devnet/fork)
  config/
    constants.ts           # Chain IDs, supply limits, oracle config
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
    // Blacklist exemption: blacklist_exempt_bridge, blacklist_exempt_router
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
Phase 13b in `TRACKER.md`. Strict FIFO is preserved via the
`head`/`tail` `u64` absolute indices.

### Bridge State

- `BridgeConfig` PDA — 12 bridge authorities (`bridge_admin`, `bridge_pauser`,
  `bridge_unpauser`, `orchestrator_signer`, `fee_recipient`, `chain_manager`,
  `fee_manager`, `nonce_admin`, `refund_initiator`, `refund_confirmer`,
  `signer_manager`, `limits_manager`), fee config, configurable deadline,
  source chain ID, chain whitelist `[u16; 32]`
- `BridgeNonce` PDA per destination chain — sequential nonce tracking
- `ProcessedRequest` PDA per request ID — replay prevention via init constraint
- `RefundedRequest` PDA per refunded request ID — prevents double-refund
- `PendingRefund` PDA per request ID — two-step refund handoff between
  `refund_initiator` and `refund_confirmer`

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
pub fn rescue_queue_entry(queue_index: u64)  // return OkuM for stuck entries (u64 since Phase 13b)
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

### Bridge

```rust
// Ed25519 signature verification via instruction introspection
pub fn bridge_mint(message_bytes: Vec<u8>, signature: Vec<u8>, request_id: [u8; 32])

// Subtractive fee: net_amount = amount - fee, fee re-minted to fee_recipient
pub fn bridge_burn(amount: u64, recipient: [u8; 20], destination_chain_id: u16)

// Two-step refund (matching EVM OkuBridge). No single key can complete a refund.
pub fn initiate_refund(message_bytes: Vec<u8>, request_id: [u8; 32]) // refund_initiator
pub fn confirm_refund(request_id: [u8; 32])                          // refund_confirmer
pub fn cancel_refund(request_id: [u8; 32])                           // either party
```

80-byte message format (cross-chain consistent): `source_chain_id(2) + dest_chain_id(2) + sender(32) + recipient(20) + amount(8) + nonce(8) + deadline(8)` for SVM→EVM (burn), and `source_chain_id(2) + dest_chain_id(2) + sender(20) + recipient(32) + amount(8) + nonce(8) + deadline(8)` for EVM→SVM (mint). Total layout is always 80 bytes; the 32-byte slot holds the Solana pubkey and the 20-byte slot holds the EVM address. Request ID = `keccak256(message_bytes)`.

### Router (CPI Convenience)

```rust
pub fn bridge_oku_m(amount, recipient, dest_chain)         // Direct OkuMoney bridge
pub fn bridge_usd_oku(shares, recipient, dest_chain, min_oku_m_out)  // Unwrap + bridge
pub fn mint_usd_oku(usdc_amount, min_shares_out)           // USDC → OkuMoney → usdOku
pub fn redeem_usd_oku(shares, min_oku_m_out)               // usdOku → OkuMoney → USDC
```

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

| Constant | Value | Rationale |
|---|---|---|
| `BRIDGE_DEADLINE_MIN_SECS` | `60` seconds | Lower bound on the bridge signature deadline. Deadlines shorter than ~1 minute would routinely expire before the orchestrator finishes signing. Arbitrary within the constraint of "enough time for an orchestrator round-trip." |
| `BRIDGE_DEADLINE_MAX_SECS` | `604_800` (7 days) | Upper bound on the bridge deadline. Prevents a misconfiguration that would allow signatures to be replayed weeks after a burn. Arbitrary sentinel; any value of hours-to-days would serve the same purpose. |
| `BRIDGE_MESSAGE_LEN` | `80` bytes | Canonical wire-format length for a `BridgeRequest` message in both directions. Derived from the fixed field layout (`2+2+32+20+8+8+8` or `2+2+20+32+8+8+8`); not arbitrary. |
| `ED25519_SIGNATURE_LEN` | `64` bytes | Ed25519 detached signature length. Not arbitrary — fixed by the Ed25519 spec. |
| `ED25519_INSTRUCTION_SCAN_LIMIT` | `16` | Maximum number of leading instructions the `verify_ed25519_signature` helper will scan looking for a matching sigverify ix. Chosen to comfortably fit real transaction shapes (compute-budget + ATA create + bridge_mint + ...) while bounding worst-case scan cost. Arbitrary in the sense that 8 or 32 would also work; 16 is a conservative round number. |
| `MAX_SUPPORTED_CHAINS` | `32` | Maximum number of destination chains in `BridgeConfig`'s whitelist array (`[u16; 32]`). Arbitrary — sized to cover foreseeable chain expansion without bloating the account. Increasing it requires a `BridgeConfig` realloc. |
| `MAX_NONCE_SKIP` | `10_000` | Maximum nonces `skip_nonce` may advance in a single call. Guards against an admin accidentally jumping `next_nonce` near `u64::MAX`, which would cause `bridge_burn`'s `checked_add(1)` to overflow. The EVM equivalent skips exactly 1; SVM allows a delta but caps it here. Value is arbitrary within "large enough to recover any realistic stuck-nonce scenario." |

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

Granular per-action roles — no single admin key:

| Role | Program | Held By |
|------|---------|---------|
| role_admin | PSM + Vault | Cold Multisig (Squads) |
| pauser | PSM + Vault | Warm Multisig |
| unpauser | PSM + Vault | Cold Multisig |
| freezer / unfreezer | PSM | Warm / Cold Multisig |
| rebaser | PSM | Orchestrator (KMS-backed) |
| usd_rebaser | Vault | Orchestrator (KMS-backed) |
| reserve_manager | Vault | Cold Multisig |
| queue_processor, buffer_depositor | PSM | Orchestrator |
| buffer_withdrawer, oracle_manager, cap_manager, allowance_manager | PSM | Cold Multisig |
| 11 bridge-specific roles | PSM (bridge) | Various (see BridgeConfig) |

Key separation: `rebaser` (rear-facing, factual — updates OkuMoney price) ≠ `usd_rebaser` (forward-facing, policy — updates usdOku multiplier).

## Initialization

PSM initialization is split into three instructions to avoid BPF stack overflow
on the large account contexts:

1. `initialize(... pyth_program_owner)` — creates `PsmConfig` and the USDC
   vault. The Pyth program-owner pubkey accepted by the on-chain oracle check
   is supplied here (rotatable post-deploy via `set_pyth_program_owner`).
2. `setup_redemption_queue` — creates the `RedemptionQueue` PDA.
3. `setup_oku_money_escrow` — creates the OkuMoney escrow vault for queued
   redemptions.

The bridge subsystem is initialized separately by:

- `initialize_bridge(BridgeInitConfig { source_chain_id, fee_bps, min/max
  amounts, deadline_secs, refund_initiator, refund_confirmer })` — creates
  `BridgeConfig`. All chain-specific defaults are caller-supplied; refund
  roles are validated to differ from each other and from `bridge_admin` (key
  separation enforced at init).

After init, the freeze-blacklist is locked in via:

- `initialize_blacklist_exempt(bridge, router)` — one-shot writer for the two
  pubkeys that `freeze_account` must refuse to freeze (the bridge PDA and the
  router PDA). Re-call is rejected once both fields are non-default.

OkuDollar vault initialization is a single call:

- `initialize` — creates `OkuDollarConfig`, the usdOku mint (authority = config
  PDA), and the OkuMoney reserve vault.

The router initializes with `oku_bridge_router::initialize(pauser, unpauser)`.

## EVM vs SVM Differences

For the full divergence table — including bridge wire format, oracle parser,
pause-bypass policy, and dead-shares semantics — see
[`EVM_VS_SVM.md`](./EVM_VS_SVM.md). Quick summary:

| Aspect | EVM | SVM |
|--------|-----|-----|
| OkuMoney price | Stored `uint256`, 18 decimals | Stored `u64`, 1e9 precision |
| OkuDollar multiplier | Continuous `_rpow` streaming | Discrete orchestrator updates |
| Yield lock | `block.number` | `Clock::slot` (PSM **and** vault) |
| Signature scheme | ECDSA (EIP-712) | Ed25519 (instruction introspection) |
| Token decimals | 18 | 6 |
| Bridge wire format | EIP-712 struct hash | Two distinct 80-byte LE layouts (see `EVM_VS_SVM.md`) |
| Oracle | Chainlink AggregatorV3 | Pyth V2 (status, expo, staleness all checked) |
| Inflation defense | `AmountTooSmall` on zero shares | Same + Uniswap-V2-style dead shares |
| Convenience functions | On LitePSM | On OkuBridgeRouter (CPI) |
| Bridge refund | Two-step (initiator + confirmer) | Two-step (with per-call `InitiatorCannotConfirm`) |
| Wallet price display | Frontends read `okuMPrice()` view | Frontends read PsmConfig PDA |
| Third-party bridge adapters | NttAdapter, future CCIP | Not implemented (native bridge only) |
| Queue size | Unbounded (mapping) | Fixed `[QueueEntry; 200]` zero-copy ring (Phase 13b; capped by Solana's 10 KB single-CPI alloc budget) |

## Error Codes

Full list in `programs/lite-psm/src/errors.rs`, `programs/oku-dollar/src/errors.rs`, and `programs/oku-bridge-router/src/errors.rs`. Key errors:

- `YieldDistributionInProgress` — operation blocked during yield lock
- `PriceCannotDecrease` — `oku_m_price` is monotonically increasing
- `MultiplierCannotDecrease` — `usd_multiplier` is monotonically increasing
- `InsufficientReserves` — vault cannot cover unwrap
- `InsufficientCollateral` — withdrawal would breach minimum collateral ratio
- `BlacklistExempt` — cannot freeze infrastructure addresses
- `SlippageExceeded` — output below minimum specified by user

## Testing

```bash
# Unit suite — bankrun in-process runner, ~5 seconds.
npm test
# or equivalently:
anchor test
# or directly:
npx mocha --require tsx --timeout 60000 'tests/bankrun/**/*.ts'

# Individual bankrun test files
npx mocha --require tsx --timeout 60000 'tests/bankrun/lite-psm.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/bridge_security.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/oku-bridge-router.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/oku-dollar.ts'
npx mocha --require tsx --timeout 60000 'tests/bankrun/pyth-oracle.ts'

# Fork tests — exercises real mainnet Pyth state via Surfpool.
#   1. Start Surfpool: npm run surfpool:mainnet
#   2. Run fork tests: npm run test:fork
```

### Runner notes

The entire unit suite runs on
[`solana-bankrun`](https://github.com/kevinheavey/solana-bankrun) via the
thin `anchor-bankrun` adapter. Bankrun executes the BPF programs
in-process on `litesvm`, eliminating:

- the 30 s confirmation-polling window in `@solana/web3.js@1.x` (no validator → no RPC → no polling);
- wall-clock waits for slot rollover (handled by the harness's `autoBumpSlot` option);
- wall-clock waits for deadline elapse (`warpBy(h, 3601)` in the refund test).

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

**Known in-process-SVM limitation: Ed25519 precompile not enforced.**
`litesvm@1.0.0` ships a `with_precompiles` toggle that's OFF by
default and not exposed by `solana-bankrun@0.4.0` (or by Surfpool 1.1.2,
which uses the same backend). When that toggle is off the Ed25519
precompile is a no-op: a transaction containing an invalid signature
in its precompile instruction is silently accepted at the harness
level, and our `bridge_mint`'s sysvar-introspection check then accepts
the (consistent, invalid-but-byte-matching) ix data and proceeds to
mint.

This is the canonical Solana pattern: the program trusts the precompile
to have validated the curve25519 math (re-implementing it in BPF
costs ~200K CU per call). On a real validator the precompile rejects
before our program runs.

Affected coverage:

- `tests/bankrun/bridge_security.ts` — the "rejects invalid signature"
  test is `it.skip` with a comment.
- `scripts/test/test-devnet.ts` includes a `bridgeMintInvalidSig` step
  that runs against real devnet / localnet's `solana-test-validator`,
  where the precompile DOES execute. This is the canonical coverage
  for the path; run via `npm run test:onchain -- --step=bridgeMintInvalidSig`
  before any mainnet deploy.

What's still caught in bankrun:

- Wrong orchestrator pubkey in the precompile ix (our program rejects
  with `InvalidSignature` because `verify_ed25519_signature` byte-
  compares against `bridge_config.orchestrator_signer`).
- Tampered message bytes (the on-chain message hash check trips
  `InvalidRequestId`).
- Expired signature (deadline elapsed at submission time).
- Post-rotation: an old-orchestrator-signed message after
  `update_orchestrator_signer` (the byte-compare fails on pubkey).

What's NOT caught in bankrun (and therefore covered by
`bridgeMintInvalidSig`): the pure case of a signature whose
curve25519 math fails but whose bytes are otherwise well-formed.

**No validator escape hatch.** The legacy `solana-test-validator` path
was retired in Phase 11; `tests/shared/setup.ts` is now bankrun-only.
The surfpool fork tests have their own local copy of
`safeAirdrop` in `tests/fork/_shared/legacy-funder.ts`. If you ever
need to debug against a real cluster, run `npm run test:onchain`
(devnet) or `npm run test:fork` (surfpool).

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

# 2. Create tokens + initialize PSM / Vault / Router (Phase 2)
npm run deploy:init                # devnet
npm run deploy:init:mainnet        # mainnet-beta

# 3. Set program upgrade authorities to the cold multisig (mainnet only)
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_BRIDGE_ROUTER_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

On mainnet, `OkuMoney` is created with mint authority = PSM config PDA. There
is no path for an EOA to mint OkuMoney post-deployment.

## Runbook

This section captures operational requirements and one-time setup steps
that aren't enforced by code. Treat this as a checklist for any
external-facing deployment.

### Pre-mainnet checklist

- [ ] Real `security@` email in all three programs' `security_txt!`
      blocks. The current values
      (`programs/{lite-psm,oku-dollar,oku-bridge-router}/src/lib.rs`) are
      placeholders (`security@okumoney.example`); replace before mainnet
      deploy.
- [ ] `sourceChainIdForNetwork(network)` returns 101 for `mainnet-beta`.
      Verified by Phase 8.0; do not re-introduce a hardcoded
      `SOLANA_CHAIN_ID` alias.
- [ ] `ORCHESTRATOR_KEYPAIR_PATH` env var points at a KMS-backed signer,
      NOT the deployer wallet. The bridge-mint script will refuse to run
      if the loaded keypair doesn't match the on-chain
      `bridge_config.orchestrator_signer`.
- [ ] `scripts/admin/set-bridge-authority.ts` has been used to rotate
      `refund_initiator` and `refund_confirmer` away from the testnet
      PDA placeholders (which cannot sign top-level instructions).
      Rotation must produce two DISTINCT keys, both DISTINCT from
      `bridge_admin` — the on-chain handler enforces this.
- [ ] **Verify** `initialize_blacklist_exempt` succeeded during
      `deploy:init` — Phase 13c wired this in as an idempotent
      final step. `PsmConfig.blacklist_exempt_bridge` and
      `blacklist_exempt_router` should be non-default. Re-run with
      `npm run admin:blacklist-exempt` if the wired step printed a
      `non-fatal` warning.
- [ ] BPF loader upgrade authority transferred to the cold multisig:
      ```bash
      solana program set-upgrade-authority <LITE_PSM_PROGRAM>           --new-upgrade-authority <SQUADS_COLD_VAULT>
      solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM>         --new-upgrade-authority <SQUADS_COLD_VAULT>
      solana program set-upgrade-authority <OKU_BRIDGE_ROUTER_PROGRAM>  --new-upgrade-authority <SQUADS_COLD_VAULT>
      ```
- [ ] Pyth feed configured (`scripts/admin/set-oracle.ts --oracle=<feed>
      --staleness=300`). The feed MUST publish reserves in OkuMoney base
      units (6 decimals) with `expo == 0` and `agg.status == Trading`.
      Phase 8.0 corrected the parser; the modern Pyth Solana Receiver
      layout is NOT supported.
- [ ] **Verify** router ALT exists in `deployments/<network>.json` under
      `addressLookupTables.router` — Phase 13c wired the create step
      into `deploy:init`. SDK consumers MUST include this ALT in every
      router CPI tx — the raw `mint_usd_oku` / `redeem_usd_oku`
      account list is at the v0-tx-size ceiling. Re-run with
      `npm run admin:setup-router-alt` if the wired step printed a
      `non-fatal` warning. For mainnet, also rotate the ALT authority
      from the deployer to a multisig.
- [ ] Anchor.toml `[programs.<network>]` matches the freshly-deployed
      keypair IDs (printed at the end of `deploy:programs`). Devnet
      and localnet sections are kept SEPARATE on purpose — preserves
      the option to rotate one cluster without touching the other.

### Orchestrator dual-key requirement

The bridge orchestrator must hold TWO distinct signing keys:

- **secp256k1** (EIP-712) for SVM-bound mint requests. Signs the EIP-712
  struct hash defined on the EVM side.
- **Ed25519** (raw 80-byte payload) for EVM-bound mint requests. Verified
  on-chain by `lite_psm::helpers::ed25519` via Solana's Ed25519
  precompile + instruction introspection.

Key material MUST NOT be reused across schemes. Different elliptic
curves, different addresses; even if both could be derived from the
same 256-bit seed, conflating them weakens the bridge's
separation-of-concerns model.

Both keys should be KMS-backed (or AWS KMS / GCP KMS-equivalent on
hardware). Rotation:

- secp256k1: through the EVM-side `update_signer` admin tx.
- Ed25519: `npm run admin:rotate-orchestrator -- --new=<pubkey>`. After
  rotation, any in-flight signed messages from the old key are
  invalidated automatically (the on-chain `bridge_mint` reads
  `bridge_config.orchestrator_signer` at execution time, not signing
  time).

### Queue capacity SLA

The `RedemptionQueue` is a fixed 200-entry zero-copy ring buffer
(Phase 13b raised the cap from 10 → 200). Operations discipline:

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

A future redesign (deferred Phase 13b followup) could lift the cap from
200 → 500 via a multi-step `init + 2× realloc` deploy flow OR migrate
the ring to per-user PDAs. Telemetry-gated: defer until the 200-entry
SLA is shown to be a real production constraint.

### Pyth feed requirements

The on-chain oracle parser at `lite_psm::helpers::oracle::check_oracle_reserves`
expects the legacy Pyth V2 `SolanaPriceAccount` layout. The feed must:

1. Be owned by `PsmConfig::pyth_program_owner` (set at init via
   `initialize`, rotatable via
   `npm run admin:set-pyth-program-owner -- --new=<pubkey>`).
2. Have the canonical Pyth header: `magic == 0xa1b2c3d4`, `ver == 2`,
   `atype == 3` (Price). The parser rejects non-canonical headers.
3. Have `agg.status == Trading` (1). Halted, Auction, Unknown, and
   Ignored states are rejected. The byte-width is u8 (Phase 8.0 fixed
   a regression that read it as u32).
4. Have `expo == 0`. The price is interpreted directly as a raw
   token-count of reserves with no scaling. A custom feed publishing
   reserves in OkuMoney base units (6 decimals) is the expected
   configuration.
5. Be fresh per `staleness_threshold` (set via
   `npm run admin:set-oracle -- --oracle=<feed> --staleness=<secs>`,
   bounded to `[60s, 7 days]`).

The modern Pyth Solana Receiver (`PriceUpdateV2`) uses a different
layout and is NOT supported until a parallel parser is added.

### Refund flow operational steps

The two-step refund covers a bridge-burn whose corresponding
destination-chain mint never landed (e.g., orchestrator outage).

1. **Verify the request was burned but never minted.** Read the
   destination-chain `ProcessedRequest` PDA — if it's empty, the mint
   never happened. Wait until `bridge_config.bridge_deadline_secs`
   seconds past burn time.
2. **Initiate** (signed by `refund_initiator`):
   ```bash
   npm run bridge:refund-initiate -- --request=./scripts/bridge/bridge-request.json
   ```
   The script reads the canonical message from `bridge-request.json`
   (produced by `bridge:burn`) and asserts `request_id` matches.
3. **Confirm** (signed by `refund_confirmer`, MUST be a different
   physical key than the initiator):
   ```bash
   npm run bridge:refund-confirm -- --request-id=0x<hex>
   ```
   The on-chain `InitiatorCannotConfirm` check enforces the
   distinct-keys invariant.
4. **Cancel** (any time before confirm; signed by the original
   initiator OR `bridge_admin`):
   ```bash
   npm run bridge:refund-cancel -- --request-id=0x<hex>
   ```

### Admin scripts

All admin scripts live under `scripts/admin/`. Each:

- prints a human-readable summary block before any state change
- honors `--dry-run` (build the tx, simulate, don't submit)
- on `mainnet-beta` / `mainnet-fork`, requires
  `--yes-i-mean-it-on-mainnet` OR an interactive `yes` prompt

| Script | Wraps | Role gate |
|---|---|---|
| `admin:set-authority` | `set_authority` | `role_admin` |
| `admin:set-bridge-authority` | `set_bridge_authority` | `bridge_admin` |
| `admin:pause-psm` / `admin:unpause-psm` | `pause` / `unpause` | `pauser` / `unpauser` |
| `admin:pause-bridge` / `admin:unpause-bridge` | `pause_bridge` / `unpause_bridge` | `bridge_pauser` / `bridge_unpauser` |
| `admin:rotate-orchestrator` | `update_orchestrator_signer` | `signer_manager` |
| `admin:set-oracle` | `set_oracle` | `oracle_manager` |
| `admin:set-pyth-program-owner` | `set_pyth_program_owner` | `oracle_manager` |
| `admin:set-max-supply` | `set_max_supply` | `cap_manager` |
| `admin:set-minter-allowance` | `set_minter_allowance` | `allowance_manager` |
| `admin:set-oku-m-price` | `set_oku_m_price` | `rebaser` (stamps yield-distribution slot) |
| `admin:distribute-yield` | `distribute_yield` | `rebaser` |
| `admin:freeze-account` / `admin:thaw-account` | `freeze_account` / `thaw_account` | `freezer` / `unfreezer` |
| `admin:update-bridge-fee` | `update_bridge_fee` | `fee_manager` |
| `admin:update-fee-recipient` | `update_fee_recipient` | `fee_manager` |
| `admin:update-bridge-limits` | `update_bridge_limits` | `limits_manager` |
| `admin:update-bridge-deadline` | `update_bridge_deadline` | `limits_manager` |
| `admin:add-supported-chain` / `admin:remove-supported-chain` | `add_supported_chain` / `remove_supported_chain` | `chain_manager` |
| `admin:skip-nonce` | `skip_nonce` (bounded by `MAX_NONCE_SKIP`) | `nonce_admin` |
| `admin:blacklist-exempt` | `initialize_blacklist_exempt` (auto-run by `deploy:init` since Phase 13c; re-runs are idempotent no-ops) | `role_admin` (one-shot) |
| `admin:setup-router-alt` | creates an Address Lookup Table (auto-run by `deploy:init` since Phase 13c; re-runs skip if the ALT pubkey in `deployments/<network>.json::addressLookupTables.router` is alive on chain) | deployer (initially) |
| `admin:process-queue` | `process_queue` (orchestrator drain; auto-batches to drain-to-empty) | `queue_processor` |
| `admin:close-programs` | `solana program close` (BPF loader) — recover rent from stale program deployments. Default targets are `deployments/<network>.json::programs.*`; pass `--ids=A,B,C` for explicit IDs. Refuses to close IDs currently in `Anchor.toml [programs.<network>]` unless `--allow-anchor-toml-ids`. | BPF upgrade authority (deployer wallet) |

Refund operator scripts under `scripts/bridge/`:

| Script | Wraps | Role gate |
|---|---|---|
| `bridge:refund-initiate` | `initiate_refund` | `refund_initiator` |
| `bridge:refund-confirm` | `confirm_refund` | `refund_confirmer` |
| `bridge:refund-cancel` | `cancel_refund` | original initiator OR `bridge_admin` |

### Smaller follow-ups

See [`SVM/TRACKER.md`](./TRACKER.md) for items deferred from the Phase 7
and Phase 8 review passes.