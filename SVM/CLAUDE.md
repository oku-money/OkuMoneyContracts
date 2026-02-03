# OkuUSD Solana Implementation

> See `CLAUDE.md` for architecture, business logic, and RBAC design.

This document covers Solana-specific implementation details.

## Stack

- **Language**: Rust
- **Framework**: Anchor 0.30.x
- **Token Standard**: Token-2022 (OkuUSD), SPL Token (wOkuUSD)
- **Oracle**: Pyth Network
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
| Rate Authority | Orchestrator (KMS) | Update interest rate |

**Rate updates** (Orchestrator calls):
```rust
update_rate_interest_bearing_mint(
    &token_2022_program,
    &okusd_mint,
    &rate_authority,
    new_rate_bps,
)?;
```

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
pub fn wrap(ctx: Context<Wrap>, okusd_amount: u64) -> Result<()>
pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()>
pub fn pause(ctx: Context<Pause>) -> Result<()>
pub fn unpause(ctx: Context<Unpause>) -> Result<()>
pub fn set_authority(ctx: Context<SetAuthority>, role: AuthorityRole, new_auth: Pubkey) -> Result<()>
```

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
    // Token references
    pub usdc_mint: Pubkey,
    pub okusd_mint: Pubkey,
    pub vault_usdc: Pubkey,
    // Limits
    pub max_supply: u64,
    pub minter_allowance: u64,
    pub is_paused: bool,
    // Oracle
    pub oracle: Pubkey,                 // Pyth feed or Pubkey::default()
    pub staleness_threshold: i64,
}
```

### RedemptionQueue (PDA seeds: `["redemption_queue"]`)

```rust
#[account]
pub struct RedemptionQueue {
    pub bump: u8,
    pub head: u32,
    pub tail: u32,
    pub entries: [QueueEntry; 500],     // Fixed 500 entries (~24KB)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct QueueEntry {
    pub user: Pubkey,
    pub okusd_amount: u64,              // Amount owed
    pub timestamp: i64,
}
```

**Queue size rationale**: 500 entries is sufficient—queue is a safety valve, not normal operation. If hitting capacity, operational intervention needed anyway.

### Instructions

```rust
// User operations
pub fn mint(ctx: Context<Mint>, usdc_amount: u64) -> Result<()>
pub fn redeem(ctx: Context<Redeem>, okusd_amount: u64) -> Result<()>

// Orchestrator operations
pub fn process_queue(ctx: Context<ProcessQueue>, max_entries: u32) -> Result<()>
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()>

// Bridge operations
pub fn bridge_mint(ctx: Context<BridgeMint>, amount: u64, recipient: Pubkey) -> Result<()>
pub fn bridge_burn(ctx: Context<BridgeBurn>, amount: u64, dest_chain: u16) -> Result<()>

// Compliance (freeze authority held by PSM PDA, proxied via config)
pub fn freeze_account(ctx: Context<FreezeAccount>, target: Pubkey) -> Result<()>
pub fn thaw_account(ctx: Context<ThawAccount>, target: Pubkey) -> Result<()>

// Admin operations
pub fn pause(ctx: Context<Pause>) -> Result<()>
pub fn unpause(ctx: Context<Unpause>) -> Result<()>
pub fn set_max_supply(ctx: Context<SetMaxSupply>, new_cap: u64) -> Result<()>
pub fn set_minter_allowance(ctx: Context<SetMinterAllowance>, amount: u64) -> Result<()>
pub fn set_oracle(ctx: Context<SetOracle>, oracle: Pubkey, staleness: i64) -> Result<()>
pub fn set_authority(ctx: Context<SetAuthority>, role: AuthorityRole, new_auth: Pubkey) -> Result<()>
```

## Pyth Oracle Integration

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

- Oracle check on `mint()` only (new supply creation)
- No check on redeem, bridge, or queue operations
- If `oracle == Pubkey::default()`, skip check

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
    #[msg("Queue is full")]
    QueueFull,
    #[msg("Arithmetic overflow")]
    Overflow,
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
pub struct BridgeMintEvent { pub recipient: Pubkey, pub amount: u64, pub source_chain: u16 }
#[event]
pub struct BridgeBurnEvent { pub user: Pubkey, pub amount: u64, pub destination_chain: u16 }
#[event]
pub struct FreezeEvent { pub account: Pubkey }
#[event]
pub struct ThawEvent { pub account: Pubkey }

// Vault Events
#[event]
pub struct WrapEvent { pub user: Pubkey, pub okusd_amount: u64, pub shares_minted: u64 }
#[event]
pub struct UnwrapEvent { pub user: Pubkey, pub shares_burned: u64, pub okusd_amount: u64 }
```

## Cross-Chain Bridging

### Wormhole NTT Flow
```
EVM → Solana:
1. Burn OkuUSD on EVM
2. Guardians attest
3. NTT calls bridge_mint() on Solana

Solana → EVM:
1. User calls bridge_burn() on Solana
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

## Deployment

```bash
# 1. Create OkuUSD mint (Token-2022)
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --enable-freeze --enable-interest-bearing --interest-rate 450

# 2. Set rate authority to orchestrator
spl-token authorize <OKUSD_MINT> rate <ORCHESTRATOR_PUBKEY>

# 3. Build and deploy programs
anchor build
anchor deploy

# 4. Transfer mint/freeze authorities to PSM PDA
spl-token authorize <OKUSD_MINT> mint <PSM_CONFIG_PDA>
spl-token authorize <OKUSD_MINT> freeze <PSM_CONFIG_PDA>

# 5. Set program upgrade authorities to cold multisig
solana program set-upgrade-authority <LITE_PSM_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>
solana program set-upgrade-authority <WOKUSD_VAULT_PROGRAM> --new-upgrade-authority <SQUADS_COLD_VAULT>

# 6. Initialize program configs
anchor run initialize
```

## Dependencies

```toml
[dependencies]
anchor-lang = "0.30.1"
anchor-spl = "0.30.1"
spl-token-2022 = "4.0"
pyth-solana-receiver-sdk = "0.3"

[dev-dependencies]
solana-program-test = "1.18"
```

## Security Considerations

- **Token-2022 support**: Verify integrated protocols support Token-2022 before launch
- **Interest rate authority**: Must be KMS-backed, rate changes are sensitive
- **Freeze authority**: Held by PSM PDA, program implements granular freeze/unfreeze
- **Mint authority**: Held by PSM PDA, not EOA
- **Rent exemption**: All PDAs must be rent-exempt
- **Integer overflow**: Use checked_* math everywhere
- **Time manipulation**: Interest-Bearing uses on-chain clock, minimal risk

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
- Interest-bearing rate updates affect ui_amount
- Wrap/unwrap round-trip with growing vault balance
- Queue entry when buffer empty, processing when refilled
- Freeze via PSM (config.freezer), thaw via PSM (config.unfreezer)
- Authority separation enforcement