# OkuMoney Solana Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solana implementation of OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Rust
- **Framework**: Anchor 0.31.x
- **Token Standard**: Token-2022 (both OkuMoney and usdOku)
- **Oracle**: Pyth (manual account parsing, no SDK dependency)
- **Multisig**: Squads Protocol

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

**No Pyth SDK dependency.** The oracle check manually parses Pyth V2 price account bytes (price at offset 208, publish_time at offset 232) to avoid transitive dependency conflicts.

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
      helpers/
        yield_lock.rs       # check_yield_lock() — sandwich prevention
        oracle.rs           # check_oracle_reserves() — Pyth V2 manual parsing
        ed25519.rs          # verify_ed25519_signature() — instruction introspection
        mod.rs
      instructions/
        init.rs             # initialize, setup_redemption_queue, setup_oku_money_escrow
        psm.rs              # mint_oku_m, redeem_oku_m, process_queue, rescue_queue_entry, buffer ops
        psm_admin.rs        # pause, freeze/thaw, set_authority, blacklist_exempt, set_oracle
        yield_ops.rs        # set_oku_m_price, distribute_yield
        bridge.rs           # bridge_mint, bridge_burn, refund_bridge_request
        bridge_admin.rs     # initialize_bridge, chain mgmt, fee mgmt, nonce admin
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
  lite-psm.ts              # PSM + bridge + yield ops tests
  oku-dollar.ts            # Vault wrap/unwrap/collateral tests
  oku-bridge-router.ts     # Router CPI integration tests
  bridge_security.ts       # Ed25519, replay, nonce security tests
  shared/
    setup.ts               # Test helpers, keypairs, initialization
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

- `BridgeConfig` PDA — 11 bridge authorities, fee config, chain whitelist `[u16; 32]`
- `BridgeNonce` PDA per destination chain — sequential nonce tracking
- `ProcessedRequest` PDA per request ID — replay prevention via init constraint
- `RefundedRequest` PDA per refunded request ID

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

pub fn refund_bridge_request(message_bytes: Vec<u8>, request_id: [u8; 32])
```

80-byte message format (cross-chain consistent): `source_chain_id(2) + dest_chain_id(2) + sender(20/32) + recipient(20/32) + amount(8) + nonce(8) + deadline(8)`. Request ID = `keccak256(message_bytes)`.

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

PSM initialization is three steps (to avoid BPF stack overflow with large account contexts):
1. `initialize` — creates PsmConfig and USDC vault
2. `setup_redemption_queue` — creates the RedemptionQueue PDA
3. `setup_oku_money_escrow` — creates the OkuMoney escrow vault for queued redemptions
4. `initialize_bridge` — creates BridgeConfig (separate step)

OkuDollar vault initialization:
1. `initialize` — creates OkuDollarConfig, usdOku mint (authority = config PDA), reserve vault

## Deployment

```bash
# 1. Create OkuMoney mint (Token-2022 with Freeze extension)
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --enable-freeze

# 2. Build and deploy programs
anchor build
anchor deploy

# 3. Transfer mint/freeze authorities to PSM PDA
spl-token authorize <OKU_MONEY_MINT> mint <PSM_CONFIG_PDA>
spl-token authorize <OKU_MONEY_MINT> freeze <PSM_CONFIG_PDA>

# 4. Initialize programs
# (PSM, redemption queue, escrow, bridge, vault — see scripts/)

# 5. Set program upgrade authorities to cold multisig
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_DOLLAR_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <OKU_BRIDGE_ROUTER_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
```

## EVM vs SVM Differences

| Aspect | EVM | SVM |
|--------|-----|-----|
| OkuMoney price | Stored `uint256`, 18 decimals | Stored `u64`, 1e9 precision |
| OkuDollar multiplier | Continuous `_rpow` streaming | Discrete orchestrator updates |
| Yield lock | `block.number` | `Clock::slot` |
| Signature scheme | ECDSA (EIP-712) | Ed25519 (instruction introspection) |
| Token decimals | 18 | 6 |
| Convenience functions | On LitePSM | On OkuBridgeRouter (CPI) |
| Bridge refund | Two-step (initiator + confirmer) | Single-step (refund admin, after deadline) |
| Wallet price display | Frontends read `okuMPrice()` view | Frontends read PsmConfig PDA |
| Third-party bridge adapters | NttAdapter, future CCIP | Not implemented (native bridge only) |

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
# All tests
anchor test

# Specific test files
npx mocha --require tsx --timeout 1000000 'tests/lite-psm.ts'
npx mocha --require tsx --timeout 1000000 'tests/oku-dollar.ts'
npx mocha --require tsx --timeout 1000000 'tests/bridge_security.ts'
```