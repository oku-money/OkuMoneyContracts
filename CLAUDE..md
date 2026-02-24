# OkuUSD Protocol

Yield-bearing stablecoin backed 1:1 by US T-Bills. Centralized B2B infrastructure—registered MSB, not a DeFi protocol.

## Design Philosophy

**Off-chain orchestrator architecture** for maximum operational agility:
- **Orchestrator**: Coordinates all protocol operations. Never stores private keys—constructs payloads and requests Cloud KMS signatures.
- **Direct Chain Operations**: Interacts directly with contracts via KMS-signed transactions.
- **Trust Model**: Openly centralized product for safe government yield. Users trust Oku Money to manage RWA backing and operate infrastructure responsibly.
- **Legal Framework**: Registered with FinCEN as an MSB. Licensed as a money transmitter in states where we onboard users.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Off-Chain Orchestrator                       │
│         (Coordinates operations, requests KMS signatures)        │
└─────────────────────┬───────────────────────────────────────────┘
                      │ KMS-signed txs
┌─────────────────────▼───────────────────────────────────────────┐
│                        On-Chain Contracts                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   OkuUSD    │◄─┤   wOkuUSD   │  │   LitePSM   │              │
│  │  (Rebase)   │  │   (Vault)   │  │   (USDC)    │              │
│  └──────┬──────┘  └─────────────┘  └─────────────┘              │
│         │                                                        │
│  ┌──────▼──────────────────────────────────────────┐            │
│  │                   OkuBridge                      │            │
│  │  (Burn on source → Orchestrator signs →          │            │
│  │   Mint on destination)                           │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

## Dual-Token Model

| Token | Type | Purpose | DeFi Compatibility |
|-------|------|---------|-------------------|
| OkuUSD | Rebasing | Retail UX, balance grows automatically | Modern protocols only |
| wOkuUSD | Static (Vault) | DeFi integrations | Universal |

**User flows**:
- Retail: Hold OkuUSD → watch balance grow
- DeFi: Wrap OkuUSD → wOkuUSD → use in AMMs, lending, etc.
- Bridge: OkuUSD via OkuBridge (wOkuUSD users unwrap first, or use OkuBridgeRouter)

## Core Components

### OkuUSD (Rebasing Token)

**Concept**: User balances stored as static shares; displayed balance calculated dynamically.

```
balanceOf(user) = shares[user] × rewardMultiplier / PRECISION
```

**Requirements**:

*Minting*
- MUST only allow addresses with minter role to mint
- MUST revert if mint would cause totalSupply to exceed maxSupply
- MUST revert if mint amount exceeds caller's minterAllowance
- MUST decrement caller's minterAllowance by mint amount on success
- MUST NOT restore minterAllowance on burn
- MUST correctly convert token amount to shares when minting

*Burning*
- MUST allow any holder to burn their own tokens
- MUST correctly convert token amount to shares when burning
- MUST reduce totalSupply by burned amount
- MUST NOT affect minterAllowance of any address

*Transfers*
- MUST transfer shares internally, not token amounts
- MUST revert if sender is blacklisted
- MUST revert if recipient is blacklisted
- MUST revert if contract is paused
- MUST emit Transfer event with token amounts (not shares) for compatibility

*Rebasing*
- MUST only allow rebaser role to update rewardMultiplier
- MUST NOT check maxSupply during rebase (supply grows organically)
- MUST affect all balanceOf() return values immediately
- MUST NOT change any user's share count
- MUST emit RebaseEvent with old and new multiplier

*Balance Queries*
- balanceOf(user) MUST return shares[user] × rewardMultiplier / PRECISION
- sharesOf(user) MUST return raw shares[user]
- totalSupply() MUST return totalShares × rewardMultiplier / PRECISION

### wOkuUSD (Non-Rebasing Wrapper)

**Concept**: Vault that holds OkuUSD, issues static wOkuUSD shares. Exchange rate grows as underlying rebases.

**Requirements**:

*Deposits (Wrap)*
- MUST transfer OkuUSD from depositor to vault
- MUST mint wOkuUSD shares proportional to deposit / totalAssets ratio
- MUST handle first deposit correctly (no division by zero)
- MUST emit Deposit event

*Withdrawals (Unwrap)*
- MUST burn wOkuUSD shares from owner
- MUST transfer OkuUSD to receiver
- MUST correctly calculate withdrawal amount based on current exchange rate
- MUST emit Withdraw event

*Exchange Rate*
- Exchange rate MUST increase when underlying OkuUSD rebases
- MUST NOT decrease exchange rate under normal operation
- Rounding MUST favor the vault (protect against share inflation attacks)

*Access Control*
- MUST NOT have any admin functions that can drain vault
- MUST NOT have pausability (always available as exit path)
- MUST NOT have blacklist functionality (inherits from underlying OkuUSD)

### LitePSM (Peg Stability Module)

**Concept**: 1:1 USDC ↔ OkuUSD swaps with zero slippage. Queue handles insufficient buffer.

**Requirements**:

*Minting (USDC → OkuUSD)*
- MUST accept USDC and mint equivalent OkuUSD 1:1
- MUST transfer USDC from user to PSM
- MUST check PoR oracle before minting (where oracle configured)
- MUST revert if oracle reports insufficient reserves
- MUST revert if oracle data is stale (exceeds staleness threshold)
- MUST revert if mint would exceed maxSupply
- MUST work without oracle on chains where not configured
- MUST emit Mint event

*Instant Redemption (OkuUSD → USDC)*
- MUST accept OkuUSD and return equivalent USDC 1:1 when buffer sufficient
- MUST burn user's OkuUSD on successful redemption
- MUST transfer USDC from PSM to user
- MUST emit Redeem event

*Queue Entry (Insufficient Buffer)*
- MUST lock user's shares (not token amount) when buffer insufficient
- MUST transfer shares to contract custody
- MUST record queue entry with user address, share count, timestamp
- MUST emit RedemptionQueued event with queue position
- MUST NOT burn tokens at queue entry time
- User MUST continue earning yield on queued shares

*Queue Processing*
- MUST process queue in FIFO order
- MUST calculate payout as: lockedShares × currentMultiplier
- MUST burn locked shares when processing
- MUST transfer calculated USDC amount to user
- MUST only allow queue processor role to call
- MUST handle partial queue processing if buffer insufficient

*Oracle Integration*
- MUST support configurable oracle address (can be zero for no oracle)
- MUST support configurable staleness threshold
- MUST query oracle before each mint operation (if configured)
- MUST compare totalSupply + mintAmount against oracle reserve value
- MUST NOT check oracle for burn/redeem/queue operations

*Buffer Management*
- MUST only allow buffer depositor role to deposit USDC buffer
- MUST only allow buffer withdrawer role to withdraw excess buffer
- MUST NOT allow buffer withdrawal that would strand queued redemptions

### OkuBridgeRouter

**Concept**: Convenience wrapper for bridging wOkuUSD cross-chain via OkuBridge.

**Flow**: Unwrap wOkuUSD → call OkuBridge.bridgeBurn() → mint OkuUSD on destination → user wraps if desired

**Requirements**:
- MUST accept wOkuUSD, unwrap to OkuUSD shares, call bridgeBurn
- MUST support direct OkuUSD bridging (skip unwrap)
- MUST NOT hold user funds beyond single transaction
- MUST revert entire transaction if any step fails

## Granular Access Control (RBAC)

**Principle**: One role per action. No role performs more than one function. Multiple roles can be assigned to the same address.

### OkuUSD Token Roles

| Role | Single Action |
|------|---------------|
| MINTER | mint() |
| REBASER | setRewardMultiplier() / updateRate() |
| PAUSER | pause() |
| UNPAUSER | unpause() |
| BLACKLISTER | blacklist() / freeze() |
| UNBLACKLISTER | unblacklist() / thaw() |
| CAP_MANAGER | setMaxSupply() |
| ALLOWANCE_MANAGER | setMinterAllowance() |
| OKUSD_UPGRADER | upgrade OkuUSD |

### wOkuUSD Vault Roles

| Role | Single Action |
|------|---------------|
| VAULT_PAUSER | pause vault |
| VAULT_UNPAUSER | unpause vault |
| WOKUSD_UPGRADER | upgrade wOkuUSD |

### LitePSM Roles

| Role | Single Action |
|------|---------------|
| PSM_PAUSER | pause PSM |
| PSM_UNPAUSER | unpause PSM |
| QUEUE_PROCESSOR | processQueue() |
| BUFFER_DEPOSITOR | depositBuffer() |
| BUFFER_WITHDRAWER | withdrawBuffer() |
| ORACLE_MANAGER | setOracle(), setStalenessThreshold() |
| PSM_UPGRADER | upgrade PSM |

### OkuBridgeRouter

No privileged roles — stateless convenience wrapper that calls OkuBridge.

### Meta Role

| Role | Single Action |
|------|---------------|
| ADMIN | grant/revoke any role |

### Role Assignment by Entity

| Entity | Roles Held |
|--------|------------|
| Cold Multisig | ADMIN, all UNPAUSER, all UNBLACKLISTER, CAP_MANAGER, ALLOWANCE_MANAGER, all UPGRADER, BUFFER_WITHDRAWER, ORACLE_MANAGER, BRIDGE_SIGNER_MANAGER, BRIDGE_UNPAUSER, BRIDGE_NONCE_ADMIN, BRIDGE_CHAIN_MANAGER, BRIDGE_LIMITS_MANAGER, BRIDGE_REFUND_ADMIN |
| Warm Multisig | all PAUSER, all BLACKLISTER, BRIDGE_PAUSER |
| Orchestrator | REBASER, QUEUE_PROCESSOR, BUFFER_DEPOSITOR, BRIDGE_FEE_MANAGER |
| OkuBridge | MINTER (bridge contract has minter role on each chain) |

### Security Rules

- **Key Isolation**: Cold and Warm multisigs MUST use different signers/devices
- **Orchestrator Limits**: NEVER granted Admin, Upgrader, Unpauser, or Unblacklister rights
- **Pause/Unpause Separation**: Prevents griefing where compromised pauser immediately unpauses
- **Blacklist/Unblacklist Separation**: Ensures deliberate review before removing addresses
- **Per-Contract Upgraders**: Each contract has its own upgrader role for granular control
- **Blacklist While Paused**: blacklist() MUST execute even when paused

## Minter Allowance System

Circle's pattern—primary defense against compromised adapters:

```
minterAllowance[minter] -= amount  // One-way decrement on mint
// Burns do NOT restore allowance
// ALLOWANCE_MANAGER manually resets after review
```

## Supply Caps

- **Per-chain maxSupply**: Token-denominated hard ceiling
- **Checked**: On mint
- **Skipped**: During rebase (supply grows organically)
- **Readable**: On block explorers for transparency

Distinct from minter allowances—caps are ceiling, allowances are rate limiter.

## Circuit Breakers

All mints must pass:
1. `totalSupply + amount <= maxSupply` (supply cap)
2. `minterAllowance[caller] >= amount` (allowance check)

PSM mints additionally check (where oracle configured):
3. `oracle.reserves >= totalSupply + amount` (PoR check)
4. `oracle.timestamp` within staleness threshold

## Redemption Queue

```
QueueEntry {
    user: address
    shares: uint256  // NOT tokens—user earns yield while waiting
    timestamp: uint256
}

// On redemption when buffer insufficient:
// 1. Lock user's shares (transfer to contract)
// 2. Emit RedemptionQueued(user, shares)

// On processQueue() when refilled:
// 1. Calculate payout: shares × currentMultiplier
// 2. Burn shares, transfer USDC to user
```

Queue is a **safety valve**, not normal operation. Fixed capacity is sufficient.

## Pause-to-Blacklist Protocol

Prevent front-running of blacklist transactions:

1. `pause()` — PAUSER freezes all transfers
2. Identify current holder of illicit funds
3. `blacklist(holder)` — BLACKLISTER traps funds (MUST work while paused)
4. `unpause()` — UNPAUSER resumes operations

**Critical**: blacklist() cannot inherit pause checks.

## Cross-Chain Bridging (OkuBridge)

OkuBridge is our proprietary, orchestrator-signed bridge. No third-party bridge dependencies.

### Design Principles

- **Centralized by design**: Orchestrator controls message passing, consistent with overall trust model
- **Shares, not tokens**: Bridge OkuUSD shares to avoid rebasing issues mid-flight
- **OkuUSD only**: wOkuUSD users unwrap → bridge → rewrap via OkuBridgeRouter
- **Burn-and-mint**: No liquidity fragmentation, no lock escrow

### Bridge Flow

```
1. User calls bridgeBurn(destChainId, recipient, shares) on source
2. Source contract:
   - Validates destination chain, amounts
   - Burns shares from user
   - Transfers fee to treasury
   - Increments nonce
   - Emits BridgeBurnEvent

3. Orchestrator:
   - Observes event
   - Waits for source chain finality
   - Signs BridgeRequest with KMS (EIP-712)
   - Submits to destination (or returns signature to user as fallback)

4. Destination contract:
   - Verifies signature against authorizedSigner
   - Verifies deadline not passed
   - Verifies requestId not processed
   - Marks requestId as processed
   - Mints shares to recipient
   - Emits BridgeMintEvent
```

### Request Structure

```
BridgeRequest {
    sourceChainId: uint256
    destChainId: uint256
    sender: address
    recipient: address
    shares: uint256        // Shares, not tokens
    nonce: uint256
    deadline: uint256
}

requestId = keccak256(abi.encode(request))
```

### Replay Prevention

- Sequential nonces per (source chain, destination chain) pair
- Nonce tracked on source chain
- Destination tracks processed requestIds
- Admin can skip stuck nonces via BRIDGE_NONCE_ADMIN_ROLE

### Transaction Submission

| Path | Who Pays Gas | Fee Treatment |
|------|--------------|---------------|
| Orchestrator submits (default) | Orchestrator | Full fee retained |
| User submits (fallback) | User | Partial fee refund |

### Fee Handling

- Fee set by BRIDGE_FEE_MANAGER_ROLE (Orchestrator)
- Collected on source chain in OkuUSD shares
- Orchestrator adjusts based on destination gas costs
- User sees total cost upfront

### Request Validation

| Check | Where | Enforcement |
|-------|-------|-------------|
| Destination chain supported | Source | `supportedChains[destChainId]` |
| Minimum amount | Source | `shares >= minBridgeShares` |
| Maximum amount | Source | `shares <= maxBridgeShares` |
| Signature valid | Destination | `signer == authorizedSigner` |
| Signature not expired | Destination | `block.timestamp <= deadline` |
| Not already processed | Destination | `!processedRequests[requestId]` |

### Finality Requirements

Orchestrator waits for source chain finality before signing:

| Chain | Finality Wait |
|-------|---------------|
| Ethereum | ~12-15 minutes |
| Arbitrum | ~1 minute |
| Base | ~1 minute |
| Optimism | ~1 minute |

### Failure Handling

| Failure | Resolution |
|---------|------------|
| Destination paused | Orchestrator retries when unpaused |
| Recipient blacklisted | Admin refunds shares on source |
| Signature expired | User requests new signature |
| Orchestrator down | User submits with signed payload |

### OkuBridge Roles

| Role | Action | Typical Holder |
|------|--------|----------------|
| BRIDGE_SIGNER_MANAGER_ROLE | Update authorized signer | Cold Multisig |
| BRIDGE_PAUSER_ROLE | Pause bridge | Warm Multisig |
| BRIDGE_UNPAUSER_ROLE | Unpause bridge | Cold Multisig |
| BRIDGE_FEE_MANAGER_ROLE | Update fee, fee recipient | Orchestrator |
| BRIDGE_NONCE_ADMIN_ROLE | Skip stuck nonces | Cold Multisig |
| BRIDGE_CHAIN_MANAGER_ROLE | Add/remove supported chains | Cold Multisig |
| BRIDGE_LIMITS_MANAGER_ROLE | Update min/max amounts | Cold Multisig |
| BRIDGE_REFUND_ADMIN_ROLE | Process refunds for failed requests | Cold Multisig |

### Why Not Third-Party Bridges?

- **Trust model alignment**: Users already trust us; adding bridge trust assumptions adds complexity without benefit
- **Rebasing complexity**: Third-party bridges assume static balances; handling shares requires customization they don't support
- **Intent protocols fill UX gaps**: Solvers use our bridge for rebalancing; users get instant fills regardless of bridge speed
- **Simplicity**: One bridge to maintain, audit, and secure

## Key Invariants

```
// wOkuUSD vault is always fully backed
okuUSD.balanceOf(vault) == wOkuUSD.totalAssets()

// Share/token conversion round-trips
balanceOf(user) == sharesOf(user) * rewardMultiplier / PRECISION

// Wrap/unwrap round-trip (max 1 unit rounding loss)
unwrap(wrap(amount)) >= amount - 1

// Supply cap respected (except rebase)
totalSupply() <= maxSupply || lastOperationWasRebase

// Minter allowance only decreases (until admin reset)
newAllowance <= previousAllowance || caller == ALLOWANCE_MANAGER

// Queue integrity
queue.head <= queue.tail
```

## Non-Goals

- No governance/DAO—all decisions are internal company operations
- No timelock—upgrades execute immediately via Cold Multisig
- No lock-and-mint bridging—burn-and-mint only
- No decentralization roadmap—openly centralized, MSB-regulated product

## Implementation

See chain-specific documentation:
- **EVM**: `EVM/CLAUDE.md` — Solidity, OpenZeppelin, Foundry, ERC-4626
- **SVM**: `SVM/CLAUDE.md` — Anchor, Token-2022, Pyth, Squads