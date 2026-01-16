# OkuUSD Solana Programs

Yield-bearing stablecoin on Solana. Dual-token model matching EVM: OkuUSD (rebasing) + wOkuUSD (wrapped).

## Design Philosophy

Full feature parity with EVM using Solana-native primitives:
- **OkuUSD** — Token-2022 with Interest-Bearing Extension (magic balance UX)
- **wOkuUSD** — Standard SPL Token via vault program (universal DeFi compatibility)
- **LitePSM** — USDC ↔ OkuUSD swaps with queue for insufficient buffer
- **Token-2022 freeze authority** — Compliance/blacklisting for OkuUSD

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Off-Chain Orchestrator                       │
│       (Updates interest rate, processes queue, KMS signs)        │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Ed25519 signed txs
┌─────────────────────▼───────────────────────────────────────────┐
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    OkuUSD Mint                            │   │
│  │            Token-2022 + Interest-Bearing Extension        │   │
│  │         (Rate updated by orchestrator, magic balance)     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   wOkuUSD Vault Program                   │   │
│  │                                                           │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │   │
│  │   │   Config    │  │  wOkuUSD    │  │ Vault OkuUSD│      │   │
│  │   │   (PDA)     │  │ Mint (SPL)  │  │   (ATA)     │      │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      LitePSM Program                      │   │
│  │                                                           │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │   │
│  │   │ PSM Config  │  │ USDC Vault  │  │ Redemption  │      │   │
│  │   │   (PDA)     │  │   (ATA)     │  │   Queue     │      │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Token Standards

| Token | Program | Extensions | Compatibility |
|-------|---------|------------|---------------|
| OkuUSD | Token-2022 | InterestBearing, FreezeAuthority | Modern wallets (Phantom, Solflare), Jupiter, Raydium, Orca |
| wOkuUSD | Original SPL Token | None | Universal (all DEXs, lending, legacy protocols) |

Users on older/incompatible protocols wrap OkuUSD → wOkuUSD. Everyone else uses OkuUSD directly.

## EVM vs Solana Comparison

| Aspect | EVM | Solana |
|--------|-----|--------|
| Rebasing token | OkuUSD (custom balanceOf) | OkuUSD (Token-2022 Interest-Bearing) |
| Wrapped token | wOkuUSD (ERC-4626) | wOkuUSD (standard SPL via vault) |
| Yield mechanism | rewardMultiplier storage var | Interest-Bearing extension rate |
| Vault standard | ERC-4626 | Custom program |
| Blacklisting | Custom mapping + modifier | Token-2022 freeze authority |
| Access control | OZ AccessControl | Config account authorities |
| Upgradeability | TransparentProxy | Native program upgrade |
| Multisig | Gnosis Safe | Squads Protocol |
| Oracle | Chainlink | Pyth Network |

## Token-2022 Interest-Bearing Extension

The Interest-Bearing extension provides native rebasing without custom balance logic:

```rust
// Initialize OkuUSD mint with Interest-Bearing extension
let extensions = vec![
    ExtensionType::InterestBearingConfig,
    ExtensionType::FreezeAccount,
];

// Set initial rate (basis points, e.g., 450 = 4.5% APY)
initialize_interest_bearing_mint(
    &token_2022_program,
    &okusd_mint,
    Some(rate_authority),  // Orchestrator
    450,                   // Initial rate in bps
)?;
```

**How it works:**
- Stored balance (`amount`) remains static
- UI amount calculated: `ui_amount = amount × e^(rate × time_elapsed)`
- Wallets display `ui_amount` automatically
- Rate updated by orchestrator to match current T-Bill APY

**Updating the rate:**
```rust
// Orchestrator calls this when T-Bill yield changes
update_rate_interest_bearing_mint(
    &token_2022_program,
    &okusd_mint,
    &rate_authority,
    new_rate_bps,
)?;
```

## Programs

### 1. OkuUSD Mint (Token-2022)

Not a custom program — uses native Token-2022 with extensions. Authorities managed via Squads multisig.

**Authorities:**
| Authority | Assigned To | Capability |
|-----------|-------------|------------|
| Mint Authority | LitePSM Program (PDA) | Mint new OkuUSD |
| Freeze Authority | Warm Multisig (Squads) | Freeze accounts for compliance |
| Rate Authority | Orchestrator | Update interest rate |

**Extensions enabled:**
- `InterestBearingConfig` — Rebasing yield
- `FreezeAccount` — Compliance blacklisting

### 2. wOkuUSD Vault Program

Custom Anchor program. Holds OkuUSD, mints/burns standard SPL wOkuUSD.

#### Config Account (PDA)
```rust
#[account]
pub struct VaultConfig {
    pub bump: u8,
    pub admin: Pubkey,              // Cold multisig (Squads)
    pub okusd_mint: Pubkey,         // Token-2022 OkuUSD mint
    pub wokusd_mint: Pubkey,        // Standard SPL wOkuUSD mint
    pub vault_okusd: Pubkey,        // Vault's OkuUSD token account
    pub total_shares: u64,          // Total wOkuUSD outstanding
    pub is_paused: bool,
}
```

#### Instructions

```rust
/// Wrap OkuUSD → wOkuUSD
pub fn wrap(ctx: Context<Wrap>, okusd_amount: u64) -> Result<()>

/// Unwrap wOkuUSD → OkuUSD
pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()>

/// Pause/unpause vault
pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()>
```

#### Requirements

**Wrap (OkuUSD → wOkuUSD)**
- MUST transfer OkuUSD from user to vault
- MUST calculate shares: `shares = okusd_amount * total_shares / vault_okusd_balance`
- MUST handle first deposit (when total_shares == 0, shares = okusd_amount)
- MUST mint wOkuUSD shares to user
- MUST revert if paused
- MUST emit WrapEvent

**Unwrap (wOkuUSD → OkuUSD)**
- MUST burn wOkuUSD shares from user
- MUST calculate OkuUSD: `okusd = shares * vault_okusd_balance / total_shares`
- MUST transfer OkuUSD from vault to user
- MUST revert if paused
- MUST revert if user's OkuUSD account is frozen
- MUST emit UnwrapEvent

**Exchange Rate**
- Rate = vault's OkuUSD balance / total wOkuUSD shares
- Vault's OkuUSD balance grows automatically via Interest-Bearing extension
- Therefore wOkuUSD exchange rate grows without any action

**Invariants**
- `vault_okusd_balance >= total_shares` (at 1:1 or better)
- Rounding favors vault (protect against share inflation)

### 3. LitePSM Program

Custom Anchor program. USDC ↔ OkuUSD swaps with redemption queue.

#### Config Account (PDA)
```rust
#[account]
pub struct PsmConfig {
    pub bump: u8,
    pub admin: Pubkey,              // Cold multisig (Squads)
    pub pauser: Pubkey,             // Warm multisig (Squads)
    pub orchestrator: Pubkey,       // KMS-backed signer
    pub usdc_mint: Pubkey,          // USDC mint
    pub okusd_mint: Pubkey,         // OkuUSD mint (Token-2022)
    pub vault_usdc: Pubkey,         // PSM's USDC buffer
    pub max_supply: u64,            // Cap on total OkuUSD
    pub minter_allowance: u64,      // Bridge mint limit
    pub is_paused: bool,
    pub oracle: Pubkey,             // Pyth feed (or Pubkey::default())
    pub staleness_threshold: i64,   // Max oracle age in seconds
}
```

#### Redemption Queue Account (PDA)
```rust
#[account]
pub struct RedemptionQueue {
    pub bump: u8,
    pub head: u32,
    pub tail: u32,
    pub entries: Vec<QueueEntry>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct QueueEntry {
    pub user: Pubkey,
    pub okusd_amount: u64,          // OkuUSD amount owed (calculated at queue time)
    pub timestamp: i64,
}
```

#### Instructions

```rust
/// Mint OkuUSD with USDC (1:1)
pub fn mint(ctx: Context<Mint>, usdc_amount: u64) -> Result<()>

/// Redeem OkuUSD for USDC (instant or queued)
pub fn redeem(ctx: Context<Redeem>, okusd_amount: u64) -> Result<()>

/// Process redemption queue
pub fn process_queue(ctx: Context<ProcessQueue>, max_entries: u32) -> Result<()>

/// Deposit USDC buffer (orchestrator)
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()>

/// Bridge mint (from cross-chain)
pub fn bridge_mint(ctx: Context<BridgeMint>, amount: u64, recipient: Pubkey) -> Result<()>

/// Bridge burn (to cross-chain)
pub fn bridge_burn(ctx: Context<BridgeBurn>, amount: u64, destination_chain: u16) -> Result<()>

/// Freeze OkuUSD account (compliance)
pub fn freeze_account(ctx: Context<FreezeAccount>, target: Pubkey) -> Result<()>

/// Thaw OkuUSD account
pub fn thaw_account(ctx: Context<ThawAccount>, target: Pubkey) -> Result<()>

/// Pause/unpause PSM
pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()>

/// Update max supply
pub fn set_max_supply(ctx: Context<SetMaxSupply>, new_cap: u64) -> Result<()>

/// Reset minter allowance
pub fn set_minter_allowance(ctx: Context<SetMinterAllowance>, amount: u64) -> Result<()>

/// Update oracle config
pub fn set_oracle(ctx: Context<SetOracle>, oracle: Pubkey, staleness: i64) -> Result<()>
```

#### Requirements

**Mint (USDC → OkuUSD)**
- MUST transfer USDC from user to PSM vault
- MUST mint OkuUSD 1:1 to user
- MUST check Pyth oracle if configured
- MUST revert if oracle reports insufficient reserves
- MUST revert if oracle data stale
- MUST revert if mint would exceed max_supply
- MUST revert if paused
- MUST emit MintEvent

**Redeem (OkuUSD → USDC)**
- MUST calculate USDC amount 1:1 with OkuUSD ui_amount
- If buffer sufficient:
  - MUST burn user's OkuUSD
  - MUST transfer USDC to user
  - MUST emit RedeemEvent
- If buffer insufficient:
  - MUST burn user's OkuUSD immediately
  - MUST record USDC owed in queue
  - MUST emit RedemptionQueuedEvent
- MUST revert if paused
- MUST revert if user's OkuUSD account is frozen

**Process Queue**
- MUST only allow orchestrator to call
- MUST process in FIFO order
- MUST transfer recorded USDC amount to user
- MUST handle partial processing
- MUST emit RedemptionProcessedEvent

**Bridge Mint**
- MUST only allow authorized bridge adapter or orchestrator
- MUST revert if exceeds minter_allowance
- MUST decrement minter_allowance
- MUST revert if exceeds max_supply
- MUST NOT check oracle (supply-neutral)
- MUST emit BridgeMintEvent

**Bridge Burn**
- MUST burn OkuUSD from user
- MUST NOT restore minter_allowance
- MUST emit BridgeBurnEvent

**Freeze/Thaw**
- MUST only allow pauser to call
- MUST invoke Token-2022 freeze/thaw instruction
- MUST work even when paused
- MUST emit FreezeEvent/ThawEvent

**Pause**
- MUST only allow pauser to call
- When paused:
  - MUST block mint()
  - MUST block redeem()
  - MUST block bridge_mint()
  - MUST block bridge_burn()
  - MUST allow freeze/thaw
  - MUST allow admin functions
  - MUST allow process_queue()

### 4. OkuBridgeRouter Program (Optional)

Convenience wrapper for bridging wOkuUSD. Unwraps before bridging.

```rust
/// Bridge wOkuUSD cross-chain
pub fn bridge_wrapped(
    ctx: Context<BridgeWrapped>,
    amount: u64,
    destination_chain: u16,
) -> Result<()>
```

**Flow:**
1. Transfer wOkuUSD from user to router
2. Call vault.unwrap() → receive OkuUSD
3. Call psm.bridge_burn() → burn OkuUSD
4. Orchestrator observes, mints on destination

## Cross-Chain Bridging

### Exchange Rate Consistency

Both OkuUSD and wOkuUSD represent the same underlying value:
- OkuUSD: `stored_amount × e^(rate × time)` = current value
- wOkuUSD: `shares × (vault_okusd_balance / total_shares)` = current value

When bridging:
- OkuUSD bridged by **ui_amount** (current value after interest)
- wOkuUSD bridged by **share count** (unwrap → bridge OkuUSD → wrap on destination)

Global rate derived from: `Total T-Bill NAV / Total OkuUSD ui_amount (all chains)`

### Wormhole NTT Flow

```
EVM → Solana:
1. Burn OkuUSD on EVM
2. Guardians attest
3. NTT mints OkuUSD on Solana (calls bridge_mint)

Solana → EVM:
1. User calls bridge_burn on Solana
2. Guardians attest
3. NTT mints OkuUSD on EVM
```

### OkuBridge (Proprietary) Flow

```
EVM → Solana:
1. User burns via bridgeOut() on EVM
2. Orchestrator observes, waits for finality
3. Orchestrator calls bridge_mint() on Solana

Solana → EVM:
1. User calls bridge_burn() on Solana
2. Orchestrator observes, waits for finality
3. Orchestrator signs for EVM bridgeIn()
```

## Oracle Integration (Pyth)

```rust
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub fn check_oracle(price_update: &PriceUpdateV2, config: &PsmConfig) -> Result<u64> {
    let price = price_update.get_price_no_older_than(
        &Clock::get()?,
        config.staleness_threshold as u64,
        &config.oracle,
    )?;
    Ok(price.price as u64)
}
```

- Oracle check on PSM mint() only
- No check on redeem, bridge operations
- If oracle == Pubkey::default(), skip check

## Error Codes

```rust
#[error_code]
pub enum OkuError {
    #[msg("Caller not authorized")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Mint would exceed max supply")]
    MaxSupplyExceeded,
    #[msg("Mint would exceed minter allowance")]
    AllowanceExceeded,
    #[msg("Oracle data is stale")]
    StaleOracle,
    #[msg("Insufficient reserves per oracle")]
    InsufficientReserves,
    #[msg("Insufficient buffer for redemption")]
    InsufficientBuffer,
    #[msg("Account is frozen")]
    AccountFrozen,
    #[msg("Queue is empty")]
    QueueEmpty,
    #[msg("Arithmetic overflow")]
    Overflow,
}
```

## Events

```rust
// PSM Events
#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
    pub okusd_amount: u64,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub usdc_amount: u64,
}

#[event]
pub struct RedemptionQueuedEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub queue_position: u32,
}

#[event]
pub struct RedemptionProcessedEvent {
    pub user: Pubkey,
    pub usdc_amount: u64,
}

#[event]
pub struct BridgeMintEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub source_chain: u16,
}

#[event]
pub struct BridgeBurnEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub destination_chain: u16,
}

#[event]
pub struct FreezeEvent {
    pub account: Pubkey,
}

#[event]
pub struct ThawEvent {
    pub account: Pubkey,
}

// Vault Events
#[event]
pub struct WrapEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct UnwrapEvent {
    pub user: Pubkey,
    pub shares_burned: u64,
    pub okusd_amount: u64,
}
```

## Project Structure

```
programs/
  lite-psm/
    src/
      lib.rs
      state.rs
      instructions/
        mint.rs
        redeem.rs
        process_queue.rs
        bridge.rs
        admin.rs
      errors.rs
      events.rs
  wokusd-vault/
    src/
      lib.rs
      state.rs
      instructions/
        wrap.rs
        unwrap.rs
        admin.rs
      errors.rs
      events.rs
  oku-bridge-router/
    src/
      lib.rs
tests/
  lite-psm.ts
  wokusd-vault.ts
  integration.ts
scripts/
  initialize-okusd-mint.ts
  deploy.ts
Anchor.toml
```

## Dependencies

```toml
[dependencies]
anchor-lang = "0.29"
anchor-spl = "0.29"
spl-token-2022 = "0.9"
pyth-solana-receiver-sdk = "0.3"

[dev-dependencies]
solana-program-test = "1.18"
```

## Deployment

```bash
# 1. Create OkuUSD mint (Token-2022 with extensions)
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --enable-freeze \
  --enable-interest-bearing \
  --interest-rate 450

# 2. Set rate authority to orchestrator
spl-token authorize <OKUSD_MINT> rate <ORCHESTRATOR_PUBKEY>

# 3. Set freeze authority to warm multisig
spl-token authorize <OKUSD_MINT> freeze <SQUADS_VAULT_PDA>

# 4. Build and deploy programs
anchor build
anchor deploy

# 5. Set program upgrade authorities to cold multisig
solana program set-upgrade-authority <LITE_PSM_PROGRAM> \
  --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <WOKUSD_VAULT_PROGRAM> \
  --new-upgrade-authority <SQUADS_COLD_VAULT>

# 6. Initialize program configs
anchor run initialize
```

## Security Considerations

- **Token-2022 support**: Verify all integrated protocols support Token-2022 before launch
- **Interest rate authority**: Must be KMS-backed, rate changes are sensitive
- **Freeze authority**: Must be warm multisig, enables compliance actions
- **Mint authority**: Held by PSM program PDA, not EOA
- **Rent exemption**: All PDAs must be rent-exempt
- **Integer overflow**: Use checked_* math, especially for interest calculations
- **Time manipulation**: Interest-Bearing uses on-chain clock, minimal manipulation risk

## Invariants

```rust
// PSM: Supply cap respected
assert!(okusd_mint.supply <= config.max_supply);

// PSM: Minter allowance only decreases until reset
assert!(new_allowance <= old_allowance || signer == admin);

// PSM: Queue integrity
assert!(queue.head <= queue.tail);

// Vault: Backing ratio >= 1:1
assert!(vault_okusd_balance >= total_wokusd_shares);

// Vault: Round-trip accuracy
let shares = wrap(okusd_amount);
let returned = unwrap(shares);
assert!(returned >= okusd_amount - 1); // Max 1 unit rounding
```

## Non-Goals

- Custom token program for OkuUSD — Token-2022 Interest-Bearing is sufficient
- Governance — all decisions are internal company operations
- Timelock — immediate upgrades via multisig
- Complex RBAC — simple authority pubkeys sufficient