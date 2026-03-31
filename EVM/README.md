# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil)
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy Pattern**: TransparentUpgradeableProxy (token/PSM) / UUPS (bridge contracts)
- **Oracle**: Chainlink AggregatorV3Interface
- **Storage**: ERC-7201 namespaced storage pattern

## Contracts

| Contract | Description |
|----------|-------------|
| `OkuMoney.sol` | Non-rebasing base token (OkuM) — static balance, discrete price appreciation via stored `okuMPrice` |
| `OkuDollar.sol` | Rebasing $1-pegged stablecoin (usdOku) — growing balance via continuous `_rpow` multiplier |
| `LitePSM.sol` | Peg Stability Module — price-aware USDC ↔ OkuM + usdOku convenience functions |
| `RedemptionQueue.sol` | FIFO queue for OkuMoney redemptions when PSM buffer is depleted |
| `OkuBridge.sol` | Native cross-chain bridge (burn/mint with EIP-712 orchestrator signatures) |
| `OkuBridgeRouter.sol` | User entry point for bridging OkuMoney and OkuDollar |
| `NttAdapter.sol` | Wormhole NTT bridge adapter (third-party adapter path) |

## Quick Start

```bash
forge install
forge build
forge test

# Specific contract tests
forge test --match-contract OkuMoneyTest -vv
forge test --match-contract OkuDollarTest -vv
forge test --match-contract LitePSMTest -vv
forge test --match-contract OkuBridgeTest -vv
```

## Contract Structure

```
src/
  token/
    OkuMoney.sol            # Non-rebasing base token (stored okuMPrice, discrete updates)
    OkuDollar.sol           # Rebasing stablecoin vault (continuous _rpow usdMultiplier)
  psm/
    LitePSM.sol             # USDC ↔ OkuM (price-aware) + usdOku convenience functions
    RedemptionQueue.sol     # Queue for when PSM USDC buffer is insufficient
  bridge/
    OkuBridge.sol           # Native cross-chain bridge (full burn/mint protocol)
    OkuBridgeRouter.sol     # Entry point: token normalization + bridge path selection
    adapters/
      IBridgeAdapter.sol    # Interface for third-party message-only adapters
      NttAdapter.sol        # Wormhole NTT adapter implementation
  interfaces/
    IOkuMoney.sol           # OkuMoney interface
    IOkuDollar.sol          # OkuDollar vault interface
  lib/
    Roles.sol               # Shared RBAC role constants
    Constants.sol           # Shared constants (PRECISION, DECIMAL_MULTIPLIER)
    MathLib.sol             # Price conversion helpers (okuMToDollars, dollarsToOkuM, rpow)
```

## Dual-Token Split-Economy Model

OkuMoney and OkuDollar have **independent yield rates** controlled by separate roles:

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

OkuMoney is the solvency anchor (rear-facing, always backed). OkuDollar is a policy lever.

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20, price appreciates discretely). OkuDollar is **rebasing** ($1-pegged, balance grows continuously via `_rpow`).

---

## OkuMoney.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through price appreciation tracked by a stored `okuMPrice` value, updated discretely by the orchestrator.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuMoneyStorage {
    uint256 okuMPrice;                          // Stored ratio (starts 1e18, only increases)
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
    uint256 lastYieldDistributionBlock;          // Sandwich attack prevention
}
```

### Price Model

`okuMPrice()` is a **stored value** — not a computed view. There is no `_rpow`, no `ratePerSecond`, no rate scheduling on OkuMoney. The price is written discretely by the orchestrator via two functions:

- `setOkuMPrice(newPrice)` — OKUM_REBASER. Direct override, enforces `newPrice >= current`.
- `distributeYield(yieldAmount)` — OKUM_REBASER. Dollar-denominated: `newPrice = oldPrice + (yieldAmount × PRECISION / totalSupply)`. E.g., $1000 yield on 10000 tokens → +$0.10/token.

Both set `lastYieldDistributionBlock = block.number` for sandwich prevention.

**Rear-facing yield**: The orchestrator feeds realized T-Bill returns. January's actual yield gets distributed in February via `distributeYield()`. OkuMoney only ever distributes what was already earned — the price reflects reality, never a projection.

### IOkuMoney Interface

```solidity
interface IOkuMoney {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function okuMPrice() external view returns (uint256);
    function setOkuMPrice(uint256 newPrice) external;
    function distributeYield(uint256 yieldAmount) external;
    function lastYieldDistributionBlock() external view returns (uint256);
}
```

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not price-adjusted)
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion)
- `okuMPrice()` is a stored value for pricing — used by PSM and vault, not by `balanceOf`
- `mint()` creates raw tokens; minting 100 tokens when okuMPrice = $1.05 creates $105 of value
- The PSM handles USDC ↔ OkuMoney conversion using `okuMPrice()`
- `TransferValue` event emitted on every transfer with dollar-denominated amount
- Blacklist and pause checks apply to transfers; burn works while paused

### Yield Distribution Lock (Sandwich Attack Prevention)

OkuMoney uses discrete yield distribution via `distributeYield()` or `setOkuMPrice()`. Without protection, this creates an arbitrage window where attackers can frontrun the price update with a mint and backrun with a redeem to capture unearned yield.

**Solution**: Single-block enforcement via `lastYieldDistributionBlock`:

```solidity
// OkuMoney records the block number when yield is distributed
function distributeYield(uint256 yieldAmount) external onlyRole(OKUM_REBASER) {
    $.lastYieldDistributionBlock = block.number;
    // ... yield distribution logic
}

// LitePSM and OkuDollar check before allowing operations
modifier whenYieldNotDistributing() {
    if (block.number == $.okuMoney.lastYieldDistributionBlock()) {
        revert YieldDistributionInProgress();
    }
    _;
}
```

**Protected operations** (blocked in same block as yield distribution):
- `LitePSM.mintOkuM()` / `redeemOkuM()` / `mintUsdOku()` / `redeemUsdOku()`
- `OkuDollar.wrap()` / `unwrap()`

**Unaffected operations**: OkuMoney transfers, OkuDollar transfers, operations in subsequent blocks (lock auto-releases).

### Blacklist Exemption

Bridge and router addresses can be marked exempt from blacklisting via `initializeBlacklistExempt(bridge, router)` (one-time, `DEFAULT_ADMIN_ROLE`). Prevents accidental blacklisting of infrastructure contracts. `blacklist()` must NOT use `whenNotPaused` — critical for the pause-to-blacklist protocol.

### Role Constants

```solidity
bytes32 public constant OKUM_UPGRADER = keccak256("OKUM_UPGRADER");
bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
bytes32 public constant OKUM_MINTER = keccak256("OKUM_MINTER");
bytes32 public constant OKUM_REBASER = keccak256("OKUM_REBASER");
bytes32 public constant OKUM_BLACKLISTER = keccak256("OKUM_BLACKLISTER");
bytes32 public constant OKUM_UNBLACKLISTER = keccak256("OKUM_UNBLACKLISTER");
bytes32 public constant OKUM_CAP_MANAGER = keccak256("OKUM_CAP_MANAGER");
bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");
```

---

## OkuDollar.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Rebasing $1-pegged stablecoin with an independent yield rate. Holds OkuMoney as reserves. Has its own USD shares mapping and its own **continuous** `_rpow` multiplier, decoupled from OkuMoney's price. This is NOT an ERC-4626 vault — it is a custom rebasing token with reserve management.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuDollarStorage {
    IOkuMoney okuMoney;
    mapping(address => uint256) usdShares;
    uint256 totalUsdShares;
    uint256 usdBaseMultiplier;          // Last snapshot (starts 1e18)
    uint256 usdRatePerSecond;           // Compound rate (1e18 = no yield)
    uint256 usdLastAccrualTime;
    uint256 usdRateEnd;                 // When current rate expires (0 = no expiry)
    uint256 usdPendingRatePerSecond;    // Next rate (activates at usdRateEnd)
    uint256 minCollateralRatio;         // e.g. 95e16 = 95%
}
```

### USD Multiplier (Continuous `_rpow` Streaming)

```
usdMultiplier() = usdBaseMultiplier × _rpow(usdRatePerSecond, elapsed, PRECISION) / PRECISION
```

Unlike OkuMoney (stored discrete price), OkuDollar uses continuous `_rpow` accrual. `balanceOf(user)` returns `usdShares[user] × usdMultiplier() / PRECISION` — this value changes every second without any transaction.

**Rate scheduling**: Full head-to-tail chaining via `setUsdYieldRate(rate, endTimestamp)`, `setNextUsdYieldRate(rate)`, and `updateUsdMultiplier(newMultiplier)` (emergency override that snapshots and resets).

### Wrap/Unwrap (Price-Aware)

```solidity
// wrap: sharesToMint = okuMAmount × okuMPrice() / usdMultiplier()
function wrap(uint256 okuMAmount, address receiver, uint256 minAmountOut)
    external returns (uint256 usdMinted);

// unwrap: okuMReturned = usdAmount × usdMultiplier() / okuMPrice()
function unwrap(uint256 usdAmount, address receiver)
    external returns (uint256 okuMReturned);
```

Both are protected by `whenYieldNotDistributing` (sandwich prevention) and `whenNotPaused` (full freeze).

### Reserve Management (VAULT_RESERVE_MANAGER)

```solidity
function depositReserves(uint256 okuMAmount) external;    // Top up, no shares minted
function withdrawSurplus(uint256 okuMAmount) external;     // Extract, enforces minCollateralRatio
```

### Collateralization (Price-Aware)

```
collateralizationRatio = (OkuMoney.balanceOf(this) × okuMPrice() / PRECISION) × PRECISION / totalSupply()
```

Numerator is dollar value of reserves. Denominator (`totalSupply()`) is dollar value of obligations (shares × multiplier). `surplus()` returns extractable OkuM tokens (0 if undercollateralized).

### Pause Behavior

Pause is a **full freeze**: peer-to-peer transfers, `wrap`, and `unwrap` are all blocked. As a consequence, `redeemUsdOku` in LitePSM is also blocked (it calls `unwrap` internally).

---

## LitePSM.sol

**Concept**: Price-aware USDC ↔ OkuMoney swaps with usdOku convenience functions.

### OkuMoney Swap Functions

```solidity
// okuMAmount = usdcValue18 × PRECISION / okuMPrice()
function mintOkuM(uint256 usdcAmount) external;

// usdcAmount = okuMAmount × okuMPrice() / PRECISION (scaled to 6 decimals)
function redeemOkuM(uint256 okuMAmount) external;
```

At okuMPrice = $1.05: depositing 100 USDC gives ~95.24 OkuM; redeeming 95.24 OkuM returns ~100 USDC.

### Convenience Functions (usdOku ↔ USDC via Vault)

```solidity
function mintUsdOku(uint256 usdcAmount) external;          // USDC → mint OkuM → wrap → usdOku
function redeemUsdOku(uint256 usdAmount) external;          // usdOku → unwrap → redeem → USDC
function redeemUsdOkuWithPermit(...) external;              // Permit variant
```

`redeemUsdOku` has two distinct failure modes: (a) vault undercollateralized → unwrap reverts → entire tx reverts, (b) vault has OkuM but PSM buffer insufficient → OkuM goes to queue.

All PSM operations are protected by `whenYieldNotDistributing` (sandwich prevention).

### Redemption Queue

Stores OkuMoney token amounts. Since OkuMoney is non-rebasing, queued tokens don't grow in balance — but they appreciate in price via `okuMPrice()`. At processing time, USDC payout = `okuMAmount × okuMPrice() / PRECISION`. Price is cached once per batch for gas efficiency and cross-entry consistency.

`rescueQueueEntry(index, alternateRecipient)` returns OkuMoney for stuck entries (e.g., USDC-blacklisted recipient).

---

## Bridge Architecture

Three-tier hierarchy:

```
OkuBridgeRouter          ← single user entry point; token normalization
  ├── native path        → OkuBridge.bridgeBurn() (bridge owns burn lifecycle)
  └── adapter path       → pre-burn → IBridgeAdapter.bridge() (message-only shims)

OkuBridge                ← full native protocol (source burn + destination mint)
  bridgeBurn()           ← burns from caller, subtractive fee, emits event
  bridgeMint()           ← validates EIP-712 sig, mints tokens

IBridgeAdapter shims     ← third-party protocol adapters (NTT, CCIP, etc.)
```

Bridge operates on raw OkuMoney token amounts — no share conversion. Three MINTER holders: LitePSM, OkuBridge, OkuBridgeRouter (adapter path only). Refund is two-step: `BRIDGE_REFUND_INITIATOR` proposes, `BRIDGE_REFUND_CONFIRMER` executes.

---

## Key Invariants

```
balanceOf(user) == _balances[user]                              // OkuMoney: standard ERC-20
okuMPrice() >= previousOkuMPrice                                // Price never decreases
totalSupply() <= maxSupply                                      // Supply cap
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION // OkuDollar: share conversion
collateralizationRatio >= minCollateralRatio (post-withdrawSurplus)
unwrap(wrap(okuMAmount)) >= okuMAmount - 1                      // Round-trip accuracy
totalOkuMReserves() == OkuMoney.balanceOf(address(okuDollar))   // Reserve accounting
```

## Testing

```bash
forge test                                    # All tests
forge test --match-contract OkuMoneyTest -vv  # OkuMoney unit tests
forge test --match-contract VaultInvariants   # Invariant tests
npx hardhat test                              # Fork tests
```