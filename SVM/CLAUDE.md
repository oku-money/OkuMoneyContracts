# OkuUSD Solana Implementation

> See `CLAUDE.md` for architecture, business logic, and RBAC design.

This document covers Solana-specific implementation details.

## Stack

- **Language**: Rust
- **Framework**: Anchor 0.31.x
- **Token Standard**: Token-2022 (OkuUSD), SPL Token (wOkuUSD)
- **Oracle**: Pyth (manual account parsing, no SDK dependency)
- **Multisig**: Squads Protocol

## Key Solana Difference: Native Rebasing

Unlike EVM where we implement custom `balanceOf()`, Solana's **Token-2022 Interest-Bearing Extension** provides native rebasing:

```
Stored balance (amount) remains static
UI amount = amount × e^(rate × time_elapsed)
Wallets display ui_amount automatically
```

This gives full feature parity with EVM's rebasing OkuUSD.

## Token Standards

| Token | Program | Extensions | Compatibility |
|-------|---------|------------|---------------|
| OkuUSD | Token-2022 | InterestBearing, FreezeAccount | Modern wallets, Jupiter, Raydium, Orca |
| wOkuUSD | SPL Token (original) | None | Universal (all DEXs, legacy protocols) |

Users on older/incompatible protocols wrap OkuUSD → wOkuUSD.

## Program Structure

All instructions and events live in each program's `lib.rs` (no `instructions/` subdirectory).

```
programs/
  lite-psm/
    src/
      lib.rs        (all instructions + events)
      state.rs
      errors.rs
  wokusd-vault/
    src/
      lib.rs        (all instructions + events)
      state.rs
      errors.rs
  oku-bridge-router/
    src/
      lib.rs        (bridge_wrapped: unwrap + bridge_burn in one tx)
tests/
  lite-psm.ts
  wokusd-vault.ts
  integration.ts
scripts/
  initialize-okusd-mint.ts
  deploy.ts
Anchor.toml
```

## OkuUSD Mint (Token-2022)

**Not a custom program**—uses native Token-2022 with extensions.

**Mint creation**:
```bash
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --enable-freeze \
  --enable-interest-bearing \
  --interest-rate 450  # 4.5% APY in basis points
```

**Authorities**:
| Authority | Holder | Action |
|-----------|--------|--------|
| Mint Authority | PSM Program PDA | Mint new OkuUSD |
| Freeze Authority | PSM Program PDA | Freeze/thaw (proxied via config authorities) |
| Rate Authority | Rebaser (Orchestrator/KMS) | Update interest rate via `update_interest_rate` |

**Rate updates** via the PSM `update_interest_rate` instruction (rebaser role):
```rust
// Token-2022 InterestBearingMintExtension::UpdateRate CPI
// Byte 0: 33 (InterestBearingMintExtension discriminator)
// Byte 1: 1  (UpdateRate discriminator)
// Bytes 2-3: new_rate as i16 little-endian
pub fn update_interest_rate(ctx: Context<UpdateInterestRate>, new_rate: i16) -> Result<()>
```
The new rate is also stored in `PsmConfig.current_rate_bps` for queue interest calculations.

## wOkuUSD Vault Program

### VaultConfig (PDA seeds: `["vault_config"]`)

```rust
#[account]
pub struct VaultConfig {
    pub bump: u8,
    // Granular authorities
    pub role_admin: Pubkey,         // Cold Multisig
    pub pauser: Pubkey,             // Warm Multisig
    pub unpauser: Pubkey,           // Cold Multisig
    // Token references
    pub okusd_mint: Pubkey,         // Token-2022
    pub wokusd_mint: Pubkey,        // SPL Token
    pub vault_okusd: Pubkey,        // Vault's OkuUSD ATA
    pub total_shares: u64,
    pub is_paused: bool,
}
```

### Instructions

```rust
pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()>
pub fn wrap(ctx: Context<Wrap>, okusd_amount: u64) -> Result<()>
pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()>
pub fn pause(ctx: Context<Pause>) -> Result<()>
pub fn unpause(ctx: Context<Unpause>) -> Result<()>
pub fn set_authority(ctx: Context<SetAuthority>, role: AuthorityRole, new_authority: Pubkey) -> Result<()>
```

Note: `unwrap` is always allowed even when paused—users must always be able to exit.

### Share Math

```rust
// Wrap
let shares = if config.total_shares == 0 {
    okusd_amount  // First deposit: 1:1
} else {
    okusd_amount.checked_mul(config.total_shares)?
        .checked_div(vault_okusd_balance)?
};

// Unwrap
let okusd_out = shares.checked_mul(vault_okusd_balance)?
    .checked_div(config.total_shares)?;
```

## LitePSM Program

### PsmConfig (PDA seeds: `["psm_config"]`)

```rust
#[account]
pub struct PsmConfig {
    pub bump: u8,
    // Granular authorities - one per action
    pub role_admin: Pubkey,             // Cold Multisig
    pub pauser: Pubkey,                 // Warm Multisig
    pub unpauser: Pubkey,               // Cold Multisig
    pub freezer: Pubkey,                // Warm Multisig
    pub unfreezer: Pubkey,              // Cold Multisig
    pub queue_processor: Pubkey,        // Orchestrator
    pub buffer_depositor: Pubkey,       // Orchestrator
    pub buffer_withdrawer: Pubkey,      // Cold Multisig
    pub oracle_manager: Pubkey,         // Cold Multisig
    pub cap_manager: Pubkey,            // Cold Multisig
    pub allowance_manager: Pubkey,      // Cold Multisig
    pub rebaser: Pubkey,                // Orchestrator/KMS - update interest rate
    // Token references
    pub usdc_mint: Pubkey,
    pub okusd_mint: Pubkey,
    pub vault_usdc: Pubkey,             // USDC buffer vault (ATA)
    pub vault_okusd: Pubkey,            // OkuUSD escrow vault for queued redemptions (ATA)
    // Limits
    pub max_supply: u64,
    pub minter_allowance: u64,
    pub is_paused: bool,
    // Oracle
    pub oracle: Pubkey,                 // Pyth feed or Pubkey::default()
    pub staleness_threshold: i64,
    pub current_rate_bps: i16,          // Stored for queue interest calculations
}
```

### RedemptionQueue (PDA seeds: `["redemption_queue"]`)

```rust
#[account]
pub struct RedemptionQueue {
    pub bump: u8,
    pub head: u32,
    pub tail: u32,
    pub entries: [QueueEntry; 10],      // Fixed 10 entries
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct QueueEntry {
    pub user: Pubkey,
    pub okusd_raw_amount: u64,          // Raw stored amount (not UI amount)
    pub timestamp: i64,                 // Used to calculate accrued yield at processing time
}
```

**Queue size rationale**: Capped at 10 entries due to Solana's 4KB BPF stack limit—complex account contexts with 15+ accounts leave insufficient stack for larger arrays. Queue is a safety valve; if it fills, operational intervention is needed regardless.

**Yield alignment**: When queued, OkuUSD is transferred to an escrow vault (`vault_okusd`) rather than burned. At `process_queue` time the interest-bearing USDC payout is calculated using `current_rate_bps` and `time_elapsed`, so users continue to earn yield while waiting.

### Instructions

```rust
// Initialization (3-step)
pub fn initialize(ctx: Context<Initialize>, max_supply: u64, minter_allowance: u64,
    pauser: Pubkey, unpauser: Pubkey, freezer: Pubkey, unfreezer: Pubkey,
    queue_processor: Pubkey, buffer_depositor: Pubkey, buffer_withdrawer: Pubkey,
    oracle_manager: Pubkey, cap_manager: Pubkey, allowance_manager: Pubkey,
    rebaser: Pubkey) -> Result<()>
pub fn setup_redemption_queue(ctx: Context<SetupRedemptionQueue>) -> Result<()>
pub fn setup_okusd_escrow(ctx: Context<SetupOkusdEscrow>) -> Result<()>

// User operations
pub fn mint(ctx: Context<MintOkusd>, usdc_amount: u64) -> Result<()>
pub fn redeem(ctx: Context<Redeem>, okusd_amount: u64) -> Result<()>

// Orchestrator operations
pub fn process_queue(ctx: Context<ProcessQueue>, max_entries: u32) -> Result<()>
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()>

// Bridge operations
pub fn bridge_mint(ctx: Context<BridgeMint>, message_bytes: Vec<u8>, signature: Vec<u8>, request_id: [u8; 32]) -> Result<()>
pub fn bridge_burn(ctx: Context<BridgeBurn>, amount: u64, recipient: [u8; 20], destination_chain_id: u16) -> Result<()>

// Compliance (freeze authority held by PSM PDA, proxied via config)
pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()>
pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()>

// Admin operations
pub fn pause(ctx: Context<Pause>) -> Result<()>
pub fn unpause(ctx: Context<Unpause>) -> Result<()>
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()>
pub fn set_max_supply(ctx: Context<CapManager>, new_max_supply: u64) -> Result<()>
pub fn set_minter_allowance(ctx: Context<AllowanceManager>, amount: u64) -> Result<()>
pub fn set_oracle(ctx: Context<OracleManager>, oracle: Pubkey, staleness_threshold: i64) -> Result<()>
pub fn update_interest_rate(ctx: Context<UpdateInterestRate>, new_rate: i16) -> Result<()>
pub fn set_authority(ctx: Context<SetAuthority>, role: AuthorityRole, new_authority: Pubkey) -> Result<()>
```

## Pyth Oracle Integration

Oracle is checked on `mint()` only (new supply creation). The implementation manually parses the Pyth price account rather than using the Pyth SDK, to avoid dependency conflicts:

```rust
// Manual Pyth V2 price account parsing
// price at byte offset 208, publish_time at byte offset 232
// Verifies account key matches config.oracle
// Checks age <= config.staleness_threshold
// Checks reserves (price) >= current_supply + mint_amount
fn check_oracle_reserves(price_account_info, oracle_feed, staleness_threshold, current_supply, mint_amount) -> Result<()>
```

- Oracle check on `mint()` only (new supply creation)
- No check on redeem, bridge, or queue operations
- If `oracle == Pubkey::default()`, skip check (oracle disabled)
- Price account passed as `Option<UncheckedAccount>` in `MintOkusd` context

## Error Codes

```rust
#[error_code]
pub enum OkuError {
    // PSM errors
    Unauthorized,
    Paused,
    MaxSupplyExceeded,
    AllowanceExceeded,
    StaleOracle,
    InsufficientReserves,
    InsufficientBuffer,
    AccountFrozen,
    QueueEmpty,
    QueueFull,
    Overflow,
    ZeroAmount,
    InsufficientAccounts,
    RecipientMismatch,
    OracleAccountMissing,
    InvalidOracleResponse,
    // Bridge errors
    BridgePaused,
    SignatureExpired,
    InvalidSignature,
    InvalidRecipient,
    InvalidRequestId,
    InvalidMessageLength,
    WrongDestinationChain,
    UnsupportedChain,
    RequestAlreadyProcessed,
    BelowMinimum,
    AboveMaximum,
    ChainAlreadySupported,
    ChainListFull,
    ChainNotFound,
}
```

## Events

```rust
// PSM Events
#[event]
pub struct MintEvent { pub user: Pubkey, pub usdc_amount: u64, pub okusd_amount: u64 }
#[event]
pub struct RedeemEvent { pub user: Pubkey, pub okusd_amount: u64, pub usdc_amount: u64 }
#[event]
pub struct RedemptionQueuedEvent { pub user: Pubkey, pub okusd_amount: u64, pub queue_position: u32 }
#[event]
pub struct RedemptionProcessedEvent { pub user: Pubkey, pub usdc_amount: u64 }
#[event]
pub struct BufferDepositEvent { pub orchestrator: Pubkey, pub amount: u64 }
#[event]
pub struct BufferWithdrawEvent { pub role_admin: Pubkey, pub amount: u64 }
#[event]
pub struct BridgeMintEvent {
    pub request_id: [u8; 32],
    pub source_chain_id: u16,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}
#[event]
pub struct BridgeBurnEvent {
    pub request_id: [u8; 32],
    pub user: Pubkey,
    pub recipient: [u8; 20],        // EVM address
    pub source_chain_id: u16,
    pub destination_chain: u16,
    pub amount: u64,                // Excluding fee
    pub nonce: u64,
    pub deadline: i64,
}
#[event]
pub struct FreezeEvent { pub account: Pubkey, pub target_owner: Pubkey }
#[event]
pub struct ThawEvent { pub account: Pubkey, pub target_owner: Pubkey }
#[event]
pub struct PauseEvent { pub pauser: Pubkey, pub paused: bool }
#[event]
pub struct UnpauseEvent { pub unpauser: Pubkey }
#[event]
pub struct MaxSupplyUpdatedEvent { pub role_admin: Pubkey, pub new_max_supply: u64 }
#[event]
pub struct MinterAllowanceUpdatedEvent { pub role_admin: Pubkey, pub new_allowance: u64 }
#[event]
pub struct OracleUpdatedEvent { pub role_admin: Pubkey, pub oracle: Pubkey, pub staleness_threshold: i64 }
#[event]
pub struct InterestRateUpdatedEvent { pub rate_authority: Pubkey, pub new_rate: i16 }
#[event]
pub struct AuthorityUpdatedEvent { pub role: AuthorityRole, pub old_authority: Pubkey, pub new_authority: Pubkey }

// Bridge Admin Events
#[event]
pub struct BridgeInitializedEvent { pub bridge_admin: Pubkey, pub orchestrator_signer: Pubkey, pub fee_bps: u16 }
#[event]
pub struct ChainAddedEvent { pub chain_id: u16 }
#[event]
pub struct ChainRemovedEvent { pub chain_id: u16 }
#[event]
pub struct BridgeFeeUpdatedEvent { pub new_fee_bps: u16 }
#[event]
pub struct FeeRecipientUpdatedEvent { pub new_recipient: Pubkey }
#[event]
pub struct BridgeLimitsUpdatedEvent { pub min_amount: u64, pub max_amount: u64 }
#[event]
pub struct BridgePauseEvent { pub pauser: Pubkey, pub paused: bool }
#[event]
pub struct BridgeUnpauseEvent { pub unpauser: Pubkey }
#[event]
pub struct NonceSkippedEvent { pub destination_chain_id: u16, pub old_nonce: u64, pub new_nonce: u64 }
#[event]
pub struct OrchestratorSignerUpdatedEvent { pub new_signer: Pubkey }

// Vault Events
#[event]
pub struct WrapEvent { pub user: Pubkey, pub okusd_amount: u64, pub shares_minted: u64 }
#[event]
pub struct UnwrapEvent { pub user: Pubkey, pub shares_burned: u64, pub okusd_amount: u64 }
```

## Cross-Chain Bridging

### OkuBridge (Proprietary) Flow
```
EVM → Solana:
1. User burns via bridgeOut() on EVM
2. Orchestrator observes, waits for finality
3. Orchestrator signs BridgeRequest message (Ed25519)
4. Orchestrator submits tx: [Ed25519Program ix, bridge_mint ix]

Solana → EVM:
1. User calls bridge_burn() on Solana
2. Orchestrator observes BridgeBurnEvent, waits for finality
3. Orchestrator signs for EVM bridgeIn()
```

### oku-bridge-router Program

A convenience program that atomically combines unwrap + bridge_burn in a single transaction for wOkuUSD holders:

```rust
pub fn bridge_wrapped(
    ctx: Context<BridgeWrapped>,
    wokusd_shares: u64,
    recipient: [u8; 20],      // EVM address
    destination_chain: u16,
) -> Result<()>
// 1. CPI to wokusd-vault: unwrap(wokusd_shares)
// 2. CPI to lite-psm: bridge_burn(okusd_balance, recipient, destination_chain)
```

## Bridge Security Architecture

The SVM bridge implements production-grade security matching the EVM bridge's OkuBridge.sol design.

### Core Security Features

**1. Ed25519 Signature Verification**
- Orchestrator signs mint requests with Ed25519 keypair (Solana native)
- Signature covers all 80 bytes of request message to prevent tampering
- Transaction must include an Ed25519Program instruction at index 0; `bridge_mint` introspects the instruction sysvar and byte-for-byte compares the expected Ed25519 instruction data
- Invalid signatures cause transaction failure

**2. Sequential Nonces Per Destination**
- Each destination chain has independent nonce counter (BridgeNonce PDA)
- Nonces increment sequentially on each burn
- Prevents message ordering issues
- Emergency nonce skip function for stuck nonces

**3. Request ID-Based Replay Prevention**
- Request ID = keccak256(80-byte message)
- ProcessedRequest PDA created on mint (init constraint enforces uniqueness)
- Duplicate request IDs rejected automatically
- Cross-chain consistency with EVM bridge

**4. Deadline Validation**
- All mint requests include expiration timestamp
- Expired signatures rejected via Clock sysvar check
- Burns auto-assign a 1-hour deadline

**5. Fee Collection**
- Bridge fee in basis points (default 10 bps = 0.1%)
- Total burn = amount + fee; fee re-minted to fee_recipient
- Collected on source chain (burn side)

**6. Chain Whitelisting**
- BridgeConfig tracks supported destination chains (max 32)
- Burns to unsupported chains rejected
- Admin can add/remove chains dynamically

**7. Amount Limits**
- Min/max bridge amounts enforced
- Configurable per-deployment
- Prevents dust attacks and excessive single-tx exposure

**8. Bridge-Specific Pause**
- Independent from PSM pause
- Emergency stop for bridge operations only
- Separate pause/unpause authorities

### Bridge State Structures

**BridgeConfig PDA** (seeds: `["bridge_config"]`, 349 bytes):
```rust
pub struct BridgeConfig {
    pub bump: u8,
    // 8 bridge-specific authorities
    pub bridge_admin: Pubkey,
    pub bridge_pauser: Pubkey,
    pub bridge_unpauser: Pubkey,
    pub orchestrator_signer: Pubkey,       // Ed25519 pubkey
    pub fee_recipient: Pubkey,
    pub chain_manager: Pubkey,
    pub fee_manager: Pubkey,
    pub nonce_admin: Pubkey,
    // Configuration
    pub bridge_fee_bps: u16,
    pub min_bridge_amount: u64,
    pub max_bridge_amount: u64,
    pub is_paused: bool,
    // Chain whitelist
    pub supported_chains: [u16; 32],
    pub supported_chains_count: u8,
}
```

**BridgeNonce PDA** (seeds: `["bridge_nonce", chain_id]`, 19 bytes):
```rust
pub struct BridgeNonce {
    pub bump: u8,
    pub destination_chain: u16,
    pub next_nonce: u64,
}
```

**ProcessedRequest PDA** (seeds: `["bridge_request", request_id]`, 89 bytes):
```rust
pub struct ProcessedRequest {
    pub bump: u8,
    pub request_id: [u8; 32],
    pub processed_at: i64,
    pub recipient: Pubkey,
    pub amount: u64,
}
```

### Bridge Instructions

**Core Operations:**
```rust
// Secure mint with Ed25519 signature verification via instruction introspection.
// Transaction must have Ed25519Program ix at index 0 signing over message_bytes.
pub fn bridge_mint(
    ctx: Context<BridgeMint>,
    message_bytes: Vec<u8>,     // 80-byte serialized BridgeRequest
    signature: Vec<u8>,          // 64-byte Ed25519 signature (also in Ed25519Program ix)
    request_id: [u8; 32],       // keccak256(message_bytes) — used for PDA derivation
) -> Result<()>

// Burn with fee collection and nonce tracking
pub fn bridge_burn(
    ctx: Context<BridgeBurn>,
    amount: u64,
    recipient: [u8; 20],        // EVM address on destination chain
    destination_chain_id: u16,
) -> Result<()>
```

**Admin Functions:**
```rust
pub fn initialize_bridge(ctx: Context<InitializeBridge>) -> Result<()>
pub fn add_supported_chain(ctx: Context<BridgeChainManager>, chain_id: u16) -> Result<()>
pub fn remove_supported_chain(ctx: Context<BridgeChainManager>, chain_id: u16) -> Result<()>
pub fn update_bridge_fee(ctx: Context<BridgeFeeManager>, new_fee_bps: u16) -> Result<()>
pub fn update_fee_recipient(ctx: Context<BridgeAdmin>, new_recipient: Pubkey) -> Result<()>
pub fn update_bridge_limits(ctx: Context<BridgeAdmin>, min_amount: u64, max_amount: u64) -> Result<()>
pub fn pause_bridge(ctx: Context<BridgePause>) -> Result<()>
pub fn unpause_bridge(ctx: Context<BridgeUnpause>) -> Result<()>
pub fn skip_nonce(ctx: Context<BridgeNonceAdmin>, destination_chain_id: u16, new_nonce: u64) -> Result<()>
pub fn update_orchestrator_signer(ctx: Context<BridgeAdmin>, new_signer: Pubkey) -> Result<()>
```

### Message Format (Must Match Orchestrator)

**Mint Message** (80 bytes, EVM→SVM):
```
source_chain_id      u16      (2 bytes, little-endian)
destination_chain_id u16      (2 bytes, little-endian)
sender               [u8; 20] (20 bytes, EVM address)
recipient            [u8; 32] (32 bytes, Solana Pubkey)
amount               u64      (8 bytes, little-endian)
nonce                u64      (8 bytes, little-endian)
deadline             i64      (8 bytes, little-endian)
```

For SVM→EVM burns, the layout mirrors this with `sender` as the 32-byte Solana pubkey and `recipient` as the 20-byte EVM address (same 80-byte total).

**Request ID Calculation:**
```rust
let request_id = anchor_lang::solana_program::keccak::hash(&message_bytes).to_bytes();
```

### RBAC: Bridge-Specific Roles

Separate from PSM roles for security isolation:

| Role | Authority | Operations |
|------|-----------|------------|
| BRIDGE_ADMIN | Cold Multisig | Update orchestrator signer, fee recipient, limits |
| BRIDGE_PAUSER | Warm Multisig | Emergency pause |
| BRIDGE_UNPAUSER | Cold Multisig | Resume operations |
| BRIDGE_CHAIN_MANAGER | Warm Multisig | Add/remove supported chains |
| BRIDGE_FEE_MANAGER | Cold Multisig | Update fee configuration |
| BRIDGE_NONCE_ADMIN | Cold Multisig | Emergency nonce management |
| Orchestrator Signer | KMS-backed key | Sign mint requests (Ed25519) |
| Fee Recipient | Treasury/DAO | Receive bridge fees |

### Key Differences from EVM Bridge

| Aspect | EVM (OkuBridge.sol) | SVM (lite-psm) |
|--------|---------------------|----------------|
| **Signature** | ECDSA (EIP-712) | Ed25519 (instruction introspection) |
| **Bridged Value** | Shares (manual conversion) | Token amounts (Token-2022 native rebasing) |
| **Address Format** | 20 bytes (EVM) | 32 bytes (Pubkey) |
| **Hash Function** | Keccak256 (both) | Keccak256 (both) |
| **Nonce Tracking** | Sequential per destination | Sequential per destination |
| **Replay Prevention** | Mapping (requestId => bool) | PDA init constraint |
| **Fee Collection** | On source chain | On source chain |

### Token Amounts vs Shares

**Critical Design Decision:**

EVM uses shares because `balanceOf()` implements custom rebasing logic. SVM uses **raw token amounts** because Token-2022's Interest-Bearing extension handles rebasing natively:

```rust
// SVM: Bridge raw amounts directly
bridge_burn(amount: 1_000_000)  // 1 token (6 decimals)

// Token-2022 automatically calculates UI amount:
// ui_amount = amount × e^(rate × time_elapsed)
// Wallets display ui_amount, contracts work with amount
```

This maintains value parity across chains without manual share conversion.

### Orchestrator Integration

**Orchestrator Workflow:**

1. Monitor Solana for `BridgeBurnEvent`
2. Wait for finality (32 confirmed blocks)
3. Extract event data (request_id, user, recipient, amount, nonce, deadline)
4. Sign the 80-byte message with Ed25519 keypair
5. Construct transaction: [Ed25519Program instruction at index 0, bridge_mint instruction]
6. Submit to Solana
7. Log completion

**Ed25519 Signature Creation:**
```typescript
import nacl from 'tweetnacl';
import { Ed25519Program } from '@solana/web3.js';

// Sign the 80-byte message
const signature = nacl.sign.detached(message, orchestratorKeypair.secretKey);

// Ed25519Program instruction MUST be at index 0
const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
  publicKey: orchestratorKeypair.publicKey.toBytes(),
  message: message,
  signature: signature,
});

transaction.add(ed25519Ix);    // index 0 — introspected by bridge_mint
transaction.add(bridgeMintIx); // passes message_bytes + signature as args
```

### Security Considerations

- **Ed25519 vs ECDSA**: Solana uses Ed25519 natively, verification is ~34K compute units
- **Signature placement**: Ed25519Program instruction must be at tx index 0; `bridge_mint` introspects `instructions_sysvar` and byte-compares expected instruction data
- **Request ID consistency**: Both chains must calculate request_id identically (keccak256)
- **Nonce gaps**: Emergency `skip_nonce` function for stuck nonces (requires NONCE_ADMIN)
- **Fee manipulation**: Fee collected before orchestrator relay prevents fee avoidance
- **Chain ID validation**: Destination chain check prevents minting tokens meant for other chains
- **Deadline enforcement**: Expired signatures rejected, prevents delayed replay

### Compute Budget

Typical compute usage:
- Ed25519 verification: ~34,000 CU
- Mint operation: ~5,000 CU
- PDA creation: ~5,000 CU
- **Total**: ~44,000 CU (well under 200K limit)

## Deployment

```bash
# 1. Create OkuUSD mint (Token-2022)
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --enable-freeze --enable-interest-bearing --interest-rate 450

# 2. Build and deploy programs
anchor build
anchor deploy

# 3. Transfer mint/freeze authorities to PSM PDA
spl-token authorize <OKUSD_MINT> mint <PSM_CONFIG_PDA>
spl-token authorize <OKUSD_MINT> freeze <PSM_CONFIG_PDA>
# Rate authority stays with the rebaser key (orchestrator/KMS)
# and is managed via the update_interest_rate instruction

# 4. Set program upgrade authorities to cold multisig
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <WOKUSD_VAULT_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>

# 5. Initialize program configs (3-step for PSM)
anchor run initialize
# Step 1: initialize
# Step 2: setup_redemption_queue
# Step 3: setup_okusd_escrow
# Then: initialize_bridge
```

## Dependencies

```toml
[dependencies]
anchor-lang = { version = "0.31.1", features = ["init-if-needed"] }
anchor-spl = "0.31.1"
```

## Security Considerations

- **Token-2022 support**: Verify integrated protocols support Token-2022 before launch
- **Interest rate authority**: `rebaser` role must be KMS-backed; rate changes affect queue payout calculations
- **Freeze authority**: Held by PSM PDA, program implements granular freeze/unfreeze
- **Mint authority**: Held by PSM PDA, not EOA
- **Rent exemption**: All PDAs must be rent-exempt
- **Integer overflow**: Use checked_* math everywhere
- **Time manipulation**: Interest-Bearing uses on-chain clock, minimal risk
- **Queue escrow**: OkuUSD is held in `vault_okusd` during queue processing; ensure escrow is initialized before first redeem

## Testing

```bash
# Build
anchor build

# Test
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

**Key test scenarios**:
- Interest-bearing rate updates affect ui_amount and queue payout calculations
- Wrap/unwrap round-trip with growing vault balance
- Queue entry when buffer empty, processing when refilled (yield earned while queued)
- Freeze via PSM (config.freezer), thaw via PSM (config.unfreezer)
- Authority separation enforcement
- Bridge mint replay rejection (duplicate request_id)
- Bridge mint with expired deadline rejection
- bridge_wrapped: wOkuUSD → EVM in single tx via oku-bridge-router
