# OkuUSD Contracts

Yield-bearing stablecoin backed 1:1 by US T-Bills. Centralized B2B infrastructure—registered MSB, not a DeFi protocol.

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
│  │  (Rebase)   │  │  (ERC-4626) │  │   (USDC)    │              │
│  └──────┬──────┘  └─────────────┘  └─────────────┘              │
│         │ MINTER_ROLE                                            │
│  ┌──────▼──────────────────────────────────────────┐            │
│  │              Bridge Adapters                     │            │
│  │  OkuBridge | NttManager | OFTAdapter | CCIP     │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

## Core Contracts

### OkuUSD.sol (Rebasing Token)
- **Storage**: User balances as `_shares` (static); global `rewardMultiplier` (dynamic)
- **Logic**: `balanceOf(user) = _shares[user] × rewardMultiplier`
- **Transfers**: Operate on shares, not token amounts (MEV protection)
- **Upgradeability**: OpenZeppelin TransparentUpgradeableProxy

#### Requirements

**Minting**
- MUST only allow addresses with MINTER_ROLE to call mint()
- MUST revert if mint would cause totalSupply() to exceed maxSupply
- MUST revert if mint amount exceeds caller's minterAllowance
- MUST decrement caller's minterAllowance by mint amount on success
- MUST NOT restore minterAllowance on burn
- MUST correctly convert token amount to shares when minting

**Burning**
- MUST allow any holder to burn their own tokens
- MUST correctly convert token amount to shares when burning
- MUST reduce totalSupply by burned amount
- MUST NOT affect minterAllowance of any address

**Transfers**
- MUST transfer shares internally, not token amounts
- MUST revert if sender is blacklisted
- MUST revert if recipient is blacklisted
- MUST revert if contract is paused (except for whitelisted operations)
- MUST emit Transfer event with token amounts (not shares) for ERC20 compatibility

**Rebasing**
- MUST only allow authorized role to update rewardMultiplier
- MUST NOT check maxSupply during rebase (supply grows organically)
- MUST affect all balanceOf() return values immediately
- MUST NOT change any user's share count
- MUST emit RebaseEvent with old and new multiplier

**Balance Queries**
- balanceOf(user) MUST return _shares[user] × rewardMultiplier / PRECISION
- sharesOf(user) MUST return raw _shares[user]
- totalSupply() MUST return totalShares × rewardMultiplier / PRECISION
- MUST handle zero balances without reverting

**Pausing**
- MUST only allow PAUSER_ROLE to call pause() and unpause()
- MUST prevent transfers when paused
- MUST prevent minting when paused
- MUST prevent burning when paused
- MUST allow blacklist() to execute while paused
- MUST allow admin functions while paused

**Blacklisting**
- MUST only allow PAUSER_ROLE to call blacklist() and unblacklist()
- MUST execute blacklist() even when contract is paused
- MUST prevent blacklisted address from sending tokens
- MUST prevent blacklisted address from receiving tokens
- MUST NOT prevent admin from adjusting blacklisted address's allowances

**Admin Functions**
- MUST only allow DEFAULT_ADMIN_ROLE to adjust maxSupply
- MUST only allow DEFAULT_ADMIN_ROLE to set/reset minterAllowance
- MUST only allow DEFAULT_ADMIN_ROLE to grant/revoke roles
- MUST emit events for all admin state changes

### wOkuUSD.sol (Non-Rebasing Wrapper)
- **Standard**: ERC-4626 Tokenized Vault
- **Holds**: Real OkuUSD backing all outstanding wOkuUSD
- **Exchange rate**: Grows as underlying OkuUSD rebases
- **Use case**: External protocol integrations (Uniswap V3, lending, aggregators)

#### Requirements

**ERC-4626 Compliance**
- MUST implement all ERC-4626 functions (deposit, mint, withdraw, redeem, etc.)
- MUST return OkuUSD address from asset()
- MUST correctly report totalAssets() as vault's OkuUSD balance
- MUST correctly calculate convertToShares() and convertToAssets()

**Deposits**
- MUST transfer OkuUSD from depositor to vault
- MUST mint wOkuUSD shares proportional to deposit / totalAssets ratio
- MUST NOT mint shares without receiving OkuUSD
- MUST handle first deposit correctly (no division by zero)
- MUST emit Deposit event

**Withdrawals**
- MUST burn wOkuUSD shares from owner
- MUST transfer OkuUSD to receiver
- MUST NOT allow withdrawing more OkuUSD than vault holds
- MUST correctly calculate withdrawal amount based on current exchange rate
- MUST emit Withdraw event

**Exchange Rate**
- Exchange rate MUST increase when underlying OkuUSD rebases
- MUST NOT decrease exchange rate under normal operation
- Rounding MUST favor the vault (protect against share inflation attacks)

**Invariants**
- okuUSD.balanceOf(vault) MUST always equal totalAssets()
- User cannot extract more OkuUSD than they are entitled to based on shares
- Wrap then immediate unwrap MUST return original amount (minus max 1 wei rounding)

**Access Control**
- MUST NOT have any admin functions that can drain vault
- MUST NOT have pausability (always available as exit path)
- MUST NOT have blacklist functionality (inherits from underlying OkuUSD)

### LitePSM.sol (Peg Stability Module)
- **Function**: 1:1 USDC ↔ OkuUSD swaps, zero slippage
- **Initial**: USDC only (add USDT later as separate contract)
- **PoR Check**: Where oracle exists, verify reserves before minting new supply
- **Queue**: When buffer depleted, lock user's shares in FIFO queue; process when refilled

#### Requirements

**Minting (USDC → OkuUSD)**
- MUST accept USDC and mint equivalent OkuUSD 1:1
- MUST transfer USDC from user to PSM
- MUST check PoR oracle before minting (where oracle configured)
- MUST revert if oracle reports insufficient reserves
- MUST revert if oracle data is stale (exceeds staleness threshold)
- MUST revert if mint would exceed maxSupply
- MUST work without oracle on chains where oracle is not configured
- MUST emit Mint event with user, USDC amount, OkuUSD amount

**Instant Redemption (OkuUSD → USDC)**
- MUST accept OkuUSD and return equivalent USDC 1:1 when buffer sufficient
- MUST burn user's OkuUSD on successful redemption
- MUST transfer USDC from PSM to user
- MUST revert if requesting more than user's balance
- MUST emit Redeem event

**Queue Entry (Insufficient Buffer)**
- MUST lock user's shares (not token amount) when buffer insufficient
- MUST transfer shares to contract custody
- MUST record queue entry with user address, share count, timestamp
- MUST emit RedemptionQueued event with queue position
- MUST NOT burn tokens at queue entry time
- User MUST continue earning yield on queued shares

**Queue Processing**
- MUST process queue in FIFO order
- MUST calculate payout as: lockedShares × currentMultiplier
- MUST burn locked shares when processing
- MUST transfer calculated USDC amount to user
- MUST only allow authorized role to call processQueue()
- MUST emit RedemptionProcessed event
- MUST handle partial queue processing if buffer insufficient for full queue

**Oracle Integration**
- MUST support configurable oracle address (can be zero for no oracle)
- MUST support configurable staleness threshold
- MUST query oracle before each mint operation (if configured)
- MUST compare totalSupply + mintAmount against oracle reserve value
- MUST NOT check oracle for burn/redeem operations
- MUST NOT check oracle for queue processing (not new supply)

**Buffer Management**
- MUST only allow authorized role to deposit USDC buffer
- MUST only allow authorized role to withdraw excess buffer
- MUST correctly report available buffer
- MUST NOT allow buffer withdrawal that would strand queued redemptions

**Admin Functions**
- MUST only allow admin to configure oracle address
- MUST only allow admin to configure staleness threshold
- MUST only allow admin to pause PSM operations
- MUST emit events for all configuration changes

### OkuBridgeRouter.sol
- **Function**: Convenience wrapper for bridging wOkuUSD
- **Flow**: Unwrap wOkuUSD → burn OkuUSD → bridge → mint on destination
- **No modifications**: Third-party bridges only see vanilla OkuUSD

#### Requirements

**Bridging wOkuUSD**
- MUST accept wOkuUSD from user
- MUST unwrap wOkuUSD to OkuUSD via vault.redeem()
- MUST approve bridge adapter to spend OkuUSD
- MUST call appropriate bridge adapter with OkuUSD amount
- MUST pass destination chain and recipient to bridge
- MUST emit BridgeInitiated event

**Bridge Adapter Support**
- MUST support OkuBridge (proprietary)
- MUST support Wormhole NttManager
- MUST support LayerZero OFTAdapter  
- MUST support Chainlink CCIP BurnMintTokenPool
- MUST allow admin to register/deregister bridge adapters
- MUST revert if requested bridge adapter not registered

**Direct OkuUSD Bridging**
- MUST also support bridging OkuUSD directly (skip unwrap step)
- MUST accept OkuUSD from user
- MUST call appropriate bridge adapter

**Access Control**
- MUST NOT hold user funds beyond single transaction
- MUST NOT have admin functions that can redirect bridge destinations
- MUST only allow admin to manage adapter registry

**Error Handling**
- MUST revert entire transaction if unwrap fails
- MUST revert entire transaction if bridge call fails
- MUST NOT leave tokens stranded in router contract

## Access Control (RBAC)

| Role | Assigned To | Capabilities |
|------|-------------|--------------|
| DEFAULT_ADMIN_ROLE | Cold Multisig | Grant/revoke roles, adjust maxSupply, revoke KMS |
| UPGRADER_ROLE | Cold Multisig | Execute proxy upgrades |
| PAUSER_ROLE | Warm 2/3 Multisig | globalPause, blacklist, Read-Only Mode |
| MINTER_ROLE | Bridge Adapters + Orchestrator | Mint tokens (bound by allowance) |

**Security rules**:
- Orchestrator never gets Admin or Upgrader rights
- Cold and Warm multisigs use different signers/devices
- `blacklist()` must NOT inherit Pausable—must execute while paused

## Minter Allowance System

Circle's pattern—primary defense against compromised adapters:

```solidity
mapping(address => uint256) public minterAllowance;

function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
    require(minterAllowance[msg.sender] >= amount, "Exceeds allowance");
    minterAllowance[msg.sender] -= amount;  // One-way decrement
    _mint(to, amount);
}
// Burns do NOT restore allowance. Admin manually resets after review.
```

## Supply Caps

- **Per-chain maxSupply**: Token-denominated hard ceiling
- **Checked**: On mint
- **Skipped**: During rebase (supply grows organically)
- **Readable**: On block explorers for transparency

Distinct from minter allowances—caps are ceiling, allowances are rate limiter.

## Circuit Breakers (On-Chain)

```solidity
// All mints must pass:
require(totalSupply() + amount <= maxSupply, "Exceeds supply cap");
require(minterAllowance[msg.sender] >= amount, "Exceeds allowance");

// PSM mints additionally check (where oracle exists):
require(oracle.latestAnswer() >= totalSupply() + amount, "Exceeds reserves");
require(block.timestamp - oracle.latestTimestamp() < stalenessThreshold, "Stale oracle");
```

## Redemption Queue (LitePSM)

```solidity
struct QueueEntry {
    address user;
    uint256 shares;  // NOT tokens—user earns yield while waiting
    uint256 timestamp;
}

// On redemption when buffer insufficient:
// 1. Lock user's shares (transfer to contract)
// 2. Emit RedemptionQueued(user, shares)

// On processQueue() when refilled:
// 1. Calculate payout: shares × currentMultiplier
// 2. Burn shares, transfer USDC to user
```

## Pause-to-Blacklist Protocol

Prevent front-running of blacklist transactions:

1. `globalPause()` — Freeze all transfers
2. Identify current holder of illicit funds
3. `blacklist(holder)` — Must work while paused
4. `unpause()` — Resume operations

**Contract requirement**: `blacklist()` cannot inherit `whenNotPaused` modifier.

## Key Invariants (Fuzz/Invariant Test Priorities)

```solidity
// wOkuUSD vault is always fully backed
assert(okuUSD.balanceOf(address(wOkuUSD)) == wOkuUSD.totalAssets());

// Share/token conversion round-trips
uint256 shares = okuUSD.sharesOf(user);
assert(okuUSD.balanceOf(user) == shares * rewardMultiplier / PRECISION);

// Wrap/unwrap round-trip (account for rounding)
uint256 deposited = vault.deposit(amount, user);
uint256 withdrawn = vault.redeem(deposited, user, user);
assert(withdrawn >= amount - 1);  // Max 1 wei rounding loss

// Supply cap never exceeded (except by rebase)
assert(okuUSD.totalSupply() <= maxSupply || lastOperationWasRebase);

// Minter allowance only decreases (until admin reset)
assert(newAllowance <= previousAllowance || msg.sender == admin);
```

## Deployment

- **Pattern**: CREATE2 via deterministic deployer for same addresses across chains
- **Proxy**: TransparentUpgradeableProxy per contract
- **Initialization**: Single `initialize()` call setting admin roles, initial caps

## Dependencies

- OpenZeppelin Contracts (Upgradeable): AccessControl, Pausable, ERC20, ERC4626
- Chainlink (optional): AggregatorV3Interface for PoR oracles

## Project Structure

```
src/
  token/
    OkuUSD.sol
    wOkuUSD.sol
  psm/
    LitePSM.sol
    RedemptionQueue.sol
  bridge/
    OkuBridgeRouter.sol
    adapters/
      IOkuBridge.sol
      INttManager.sol
      IOFTAdapter.sol
test/
  OkuUSD.t.sol
  wOkuUSD.t.sol
  LitePSM.t.sol
  invariants/
    VaultInvariants.t.sol
    SupplyInvariants.t.sol
script/
  Deploy.s.sol
```

## Non-Goals

- No governance/DAO—all decisions are internal company operations
- No timelock—upgrades execute immediately via Cold Multisig
- No lock-and-mint bridging—burn-and-mint only
- No decentralization roadmap—openly centralized, MSB-regulated product