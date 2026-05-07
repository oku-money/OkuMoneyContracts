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

**No Pyth SDK dependency.** The oracle check manually parses Pyth V2 price account bytes (price at offset 208, publish_time at offset 232) to avoid transitive dependency conflicts. The accepted Pyth program owner pubkey is **per-deployment** (`PsmConfig::pyth_program_owner`, set at `initialize` and rotatable via `set_pyth_program_owner`), so deployments can target the legacy Pyth program (mainnet `FsJ3...`, devnet `gSbe...`) or any future Pyth deployment without recompilation. Source attribution and offsets are documented in `programs/lite-psm/src/helpers/oracle.rs`.

**Ed25519 introspection, not native verification.** `bridge_mint` requires an `Ed25519Program` instruction at transaction index 0 and compares its data byte-for-byte against the expected instruction. This is the canonical Solana pattern for signature verification.

**6-decimal tokens.** Both OkuMoney and usdOku use 6 decimals, matching USDC on Solana. EVM uses 18 decimals. The bridge layer handles decimal conversion.

## Program Structure

```
programs/
  lite-psm/
    src/
      lib.rs                # Instruction entry points
      state.rs              # PsmConfig, RedemptionQueue, BridgeConfig, BridgeNonce, etc.
      errors.rs             # Error codes
      events.rs             # Event definitions
      roles.rs              # AuthorityRole, BridgeAuthorityRole enums
      constants.rs          # PRECISION, BASIS_POINTS, BRIDGE_DEADLINE bounds
      helpers/
        yield_lock.rs       # check_yield_lock() — sandwich prevention
        oracle.rs           # check_oracle_reserves() — Pyth V2 manual parsing
        ed25519.rs          # verify_ed25519_signature() — instruction introspection
        math.rs             # oku_m <-> dollars conversion helpers
        mod.rs
      instructions/
        init.rs             # initialize (now takes pyth_program_owner), setup_redemption_queue, setup_oku_money_escrow
        psm.rs              # mint_oku_m, redeem_oku_m, process_queue, rescue_queue_entry, buffer ops
        psm_admin.rs        # pause, freeze/thaw, set_authority, initialize_blacklist_exempt, set_oracle, set_pyth_program_owner, set_max_supply, set_minter_allowance
        yield_ops.rs        # set_oku_m_price, distribute_yield
        bridge.rs           # bridge_mint, bridge_burn, refund_bridge_request
        bridge_admin.rs     # initialize_bridge (BridgeInitConfig), chain mgmt, fee mgmt, nonce admin
        mod.rs
      contexts/
        init.rs             # Initialize, SetupRedemptionQueue, SetupOkuMoneyEscrow
        psm.rs              # MintOkuM, RedeemOkuM, ProcessQueue, RescueQueueEntry, Buffer
        psm_admin.rs        # Pause, Unpause, FreezeAccount, ThawAccount, SetAuthority
        yield_ops.rs        # SetOkuMPrice, DistributeYield
        bridge.rs           # BridgeMint, BridgeBurn, RefundBridgeRequest
        bridge_admin.rs     # BridgeAdmin contexts
        mod.rs

  oku-dollar/
    src/
      lib.rs                # Instruction entry points
      constants.rs          # PRECISION, MINIMUM_LIQUIDITY, MIN_COLLATERAL_RATIO_FLOOR
      state.rs              # OkuDollarConfig
      errors.rs
      events.rs
      roles.rs              # AuthorityRole enum
      helpers.rs            # Price math, collateralization, share conversion
      instructions/
        core.rs             # initialize, wrap, unwrap, update_usd_multiplier, reserves
        admin.rs            # pause, unpause, set_authority, set_min_collateral_ratio
        mod.rs
      contexts.rs           # All account contexts

  oku-bridge-router/
    src/
      lib.rs                # bridge_oku_m, bridge_usd_oku, mint_usd_oku, redeem_usd_oku
      state.rs              # RouterConfig
      errors.rs
      events.rs
      roles.rs
      instructions/
        core.rs             # All CPI-based instruction handlers
        admin.rs
        mod.rs
      contexts.rs           # All account contexts

tests/
  unit/
    lite-psm.ts            # PSM + bridge + yield ops tests
    oku-dollar.ts          # Vault wrap/unwrap/collateral tests
    oku-bridge-router.ts   # Router CPI integration tests
    bridge_security.ts     # Ed25519, replay, nonce security tests
  fork/
    pyth-oracle.ts         # Mainnet-fork Pyth integration (requires Surfpool)
  shared/
    setup.ts               # Shared keypairs, airdrop helpers, PSM init
    surfpool.ts            # Surfpool cheatcode client + mainnet addresses
    assertions.ts          # expectError helper
    fixtures.ts            # fundUser, expireDeadline, freeze/thaw helpers

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

Fixed-size circular buffer (10 entries max). Each entry: `{ user: Pubkey, oku_m_amount: u64, timestamp: i64 }`.

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

pub fn process_queue(max_entries: u32)   // price cached once per batch
pub fn rescue_queue_entry(queue_index: u32)  // return OkuM for stuck entries
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
| Queue size | Unbounded (mapping) | Fixed `[QueueEntry; 10]` (prototype limitation) |

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
# Unit tests (boots solana-test-validator, no external deps)
anchor test
# or equivalently:
npx mocha --require tsx --timeout 180000 'tests/unit/**/*.ts'

# Individual unit test files
npx mocha --require tsx --timeout 180000 'tests/unit/lite-psm.ts'
npx mocha --require tsx --timeout 180000 'tests/unit/oku-dollar.ts'
npx mocha --require tsx --timeout 180000 'tests/unit/bridge_security.ts'

# Fork tests (requires Surfpool running with mainnet fork)
#   1. Start Surfpool: npm run surfpool:mainnet
#   2. Run fork tests: npm run test:fork
npm run test:fork
```

### Test runtime notes

`tests/unit/bridge_security.ts` contains a number of end-to-end `bridge_mint`
tests that exercise the heaviest path in the program (Ed25519 sigverify
precompile + instruction-sysvar introspection + keccak256 + PDA `init` +
Token-2022 mint CPI in a single transaction). On a freshly-spawned
`solana-test-validator` with a cold BPF cache, some of these transactions
exceed `@solana/web3.js@1.x`'s hard-coded 30s confirmation polling window:

```
TransactionExpiredTimeoutError: Transaction was not confirmed in 30.00 seconds.
```

The transactions are valid; the client gives up before confirmation arrives.
The heaviest sub-set is gated behind `RUN_HEAVY_BRIDGE_TESTS=1` so default
`anchor test` runs stay around ~10-15 seconds:

```bash
RUN_HEAVY_BRIDGE_TESTS=1 npx mocha --require tsx --timeout 300000 \
    'tests/unit/bridge_security.ts'
```

Note: of the four `Ed25519 Signature Verification` tests behind that flag,
three actually fail at the Ed25519 precompile (rejecting the bad sig before
ever reaching `bridge_mint`) and don't need the heavy path; only the
"accepts valid orchestrator signature" case truly requires it. The flag is
applied at the describe-block level, not per-test.

**Tracked migration to `anchor-bankrun`.** Surfpool already runs on
`litesvm` in this repo (visible in `.surfpool/logs/*.log`), so the
groundwork for an in-process test runner is present. Migrating
`bridge_security.ts` to `anchor-bankrun` would:

- eliminate the 30s confirmation window entirely (`processTransaction` is sync)
- drop the `RUN_HEAVY_BRIDGE_TESTS` gate
- replace `setTimeout(500)` clock waits with `client.warpToTimestamp(...)`

Status: scoped as a Phase 4b follow-up. Not blocking review of the program code.

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