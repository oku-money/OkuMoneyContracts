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

### wOkuUSD.sol (Non-Rebasing Wrapper)
- **Standard**: ERC-4626 Tokenized Vault
- **Holds**: Real OkuUSD backing all outstanding wOkuUSD
- **Exchange rate**: Grows as underlying OkuUSD rebases
- **Use case**: External protocol integrations (Uniswap V3, lending, aggregators)

### LitePSM.sol (Peg Stability Module)
- **Function**: 1:1 USDC ↔ OkuUSD swaps, zero slippage
- **Initial**: USDC only (add USDT later as separate contract)
- **PoR Check**: Where oracle exists, verify reserves before minting new supply
- **Queue**: When buffer depleted, lock user's shares in FIFO queue; process when refilled

### OkuBridgeRouter.sol
- **Function**: Convenience wrapper for bridging wOkuUSD
- **Flow**: Unwrap wOkuUSD → burn OkuUSD → bridge → mint on destination
- **No modifications**: Third-party bridges only see vanilla OkuUSD

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