# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil) for unit + invariant tests; Hardhat for fork + gas-regression tests
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy pattern**: UUPS (all upgradeable contracts: `OkuMoney`, `OkuDollar`, `LitePSM`, `RedemptionQueue`, `OkuBridge`, `OkuBridgeRouter`)
- **Oracle**: Chainlink `AggregatorV3` (subset interface at `src/interfaces/IAggregatorV3.sol`)
- **Storage**: ERC-7201 namespaced storage across every upgradeable contract (canonical slots — see any `*_STORAGE_LOCATION` literal)

## Contracts

| Contract | Description |
|----------|-------------|
| `src/token/OkuMoney.sol` | Non-rebasing base token (OkuM) — static balance, discrete multiplier appreciation via stored `okuMMultiplier` |
| `src/token/OkuDollar.sol` | Rebasing $1-pegged stablecoin (usdOku) — growing balance via continuous `_rpow` USD multiplier |
| `src/psm/LitePSM.sol` | Peg Stability Module — multiplier-aware USDC ↔ OkuM + usdOku convenience functions |
| `src/psm/RedemptionQueue.sol` | FIFO queue for OkuMoney redemptions when the PSM buffer is depleted |
| `src/bridge/OkuBridge.sol` | Native cross-chain bridge (burn/mint with EIP-712 orchestrator signatures) |
| `src/bridge/OkuBridgeRouter.sol` | User entry point for bridging OkuMoney and OkuDollar across chains |
| `src/bridge/adapters/NttAdapter.sol` | Wormhole NTT adapter (third-party adapter path) — AccessControl-gated |
| `src/lib/YieldSandwichGuard.sol` | Shared abstract enforcing per-block sandwich protection around yield distribution |
| `src/lib/MathLib.sol` | Multiplier conversion helpers (`okuMToDollars`, `dollarsToOkuM`, `usdcToDollars`, `dollarsToUsdc`, `rpow`) |
| `src/lib/Constants.sol` | Shared constants + canonical terminology legend |
| `src/lib/Roles.sol` | Shared RBAC role constants (namespaced by contract prefix) |
| `src/lib/ReentrancyGuardUpgradeable.sol` | OZ v5-compatible upgradeable reentrancy guard (OZ dropped the upgradeable variant in v5) |

## Quick Start

```bash
forge install
forge build
forge test                                    # All unit + invariant tests
forge test --match-path "test/invariants/*"   # Invariant suite only (256 runs, 500 depth)
forge test --match-contract OkuMoneyTest -vv  # Targeted

npx hardhat compile                           # Required before fork tests
npx hardhat test                              # Fork + gas-regression tests
npx hardhat test test/hardhat/gas/            # Gas-regression only
```

## Contract Structure

```
src/
  token/
    OkuMoney.sol            # Non-rebasing base token (stored okuMMultiplier, discrete updates)
    OkuDollar.sol           # Rebasing stablecoin vault (continuous _rpow usdMultiplier)
  psm/
    LitePSM.sol             # USDC ↔ OkuM (multiplier-aware) + usdOku convenience functions
    RedemptionQueue.sol     # Queue for when PSM USDC buffer is insufficient
  bridge/
    OkuBridge.sol           # Native cross-chain bridge (full burn/mint protocol)
    OkuBridgeRouter.sol     # Entry point: token normalization + bridge path selection
    adapters/
      IBridgeAdapter.sol    # Canonical interface for third-party message-only adapters
      INttManager.sol       # Wormhole NTT manager interface
      NttAdapter.sol        # Wormhole NTT adapter (AccessControl-gated)
  interfaces/
    IOkuMoney.sol           # OkuMoney interface (used by PSM, vault, bridge)
    IOkuDollar.sol          # OkuDollar vault interface
    IOkuBridgeNative.sol    # OkuBridge subset surface used by the router
    IAggregatorV3.sol       # Chainlink PoR oracle subset used by LitePSM
  lib/
    Roles.sol               # Shared RBAC role constants (prefix-namespaced)
    Constants.sol           # PRECISION, DECIMAL_MULTIPLIER, MAX_RATE, BASIS_POINTS + terminology legend
    MathLib.sol             # Multiplier math + rpow
    ReentrancyGuardUpgradeable.sol  # OZ-5.x-compatible upgradeable reentrancy guard
    YieldSandwichGuard.sol  # Shared whenYieldNotDistributing modifier (OkuDollar + LitePSM)

test/
  mocks/                    # Test-only mocks (live under test/, never compiled into production artifacts)
    MockUSDC.sol            # 6-decimal ERC-20; used on testnets + in tests
    MockBridgeAdapter.sol   # Test double for IBridgeAdapter (used by both Foundry and Hardhat)
    MockNttManager.sol      # Test double for INttManager
```

---

## Terminology (canonical)

Every contract's NatSpec references `src/lib/Constants.sol` for the authoritative terminology legend. Brief excerpt for quick reference:

**Multipliers (dollar value per token)**
- `okuMMultiplier` — dollar value of 1 OkuMoney token (starts 1e18 = $1.00, grows with yield, only increases)
- `usdMultiplier` — dollar value of 1 OkuDollar share (starts 1e18 = $1.00, grows via `_rpow` accrual)

**Token amounts**
- `okuMAmount` — raw OkuMoney token count (18 decimals, non-rebasing)
- `usdAmount` — OkuDollar amount in dollar terms (18 decimals, rebasing)
- `usdcAmount` — USDC amount (6 decimals)

**Conversion constants**
- `PRECISION = 1e18` — base unit for multiplier math
- `DECIMAL_MULTIPLIER = 1e12` — converts USDC (6 dec) ↔ dollars (18 dec)
- `MAX_RATE = PRECISION + 1e11` — safety cap on vault `usdRatePerSecond`
- `BASIS_POINTS = 10_000` — fee denominator

**Key formulas**
```
USDC → OkuMoney:         okuMAmount   = (usdcAmount × 1e12) × PRECISION / okuMMultiplier
OkuMoney → USDC:         usdcAmount   = (okuMAmount × okuMMultiplier / PRECISION) / 1e12
OkuMoney → usdOku share: shares       = okuMAmount × okuMMultiplier / usdMultiplier
usdOku → OkuMoney:       okuMAmount   = usdAmount × PRECISION / okuMMultiplier
```

See [`src/lib/Constants.sol`](src/lib/Constants.sol) for the canonical version.

---

## Dual-Token Split-Economy Model

OkuMoney and OkuDollar have **independent yield rates** controlled by separate roles:

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

OkuMoney is the solvency anchor (rear-facing, always backed). OkuDollar is the policy lever.

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20, multiplier appreciates discretely). OkuDollar is **rebasing** ($1-pegged, balance grows continuously via `_rpow`).

---

## OkuMoney.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`.

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through multiplier appreciation tracked by a stored `okuMMultiplier` value, updated discretely by the orchestrator.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuMoneyStorage {
    uint256 okuMMultiplier;                     // Stored dollar value per token (starts 1e18, only increases)
    mapping(address => uint256) minterAllowance;
    uint256 maxSupply;
    mapping(address => bool) isBlacklisted;
    uint256 lastYieldDistributionBlock;         // Sandwich attack prevention
}
```

### Multiplier Model

`okuMMultiplier()` is a **stored value** — not a computed view. There is no `_rpow`, no `ratePerSecond`, no rate scheduling on OkuMoney. The multiplier is written discretely by the orchestrator via two functions:

- `setOkuMMultiplier(newMultiplier)` — OKUM_REBASER. Direct override, enforces `newMultiplier >= current`.
- `distributeYield(yieldAmount)` — OKUM_REBASER. Dollar-denominated: `newMultiplier = oldMultiplier + (yieldAmount × PRECISION / totalSupply)`. E.g., $1000 yield on 10000 tokens → +$0.10/token.

Both set `lastYieldDistributionBlock = block.number` (sandwich prevention — see [YieldSandwichGuard](#yieldsandwichguard)).

**Rear-facing yield**: The orchestrator feeds realized T-Bill returns. January's actual yield gets distributed in February via `distributeYield()`. OkuMoney only ever distributes what was already earned — the multiplier reflects reality, never a projection.

### IOkuMoney Interface

```solidity
interface IOkuMoney {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function okuMMultiplier() external view returns (uint256);
    function setOkuMMultiplier(uint256 newMultiplier) external;
    function distributeYield(uint256 yieldAmount) external;
    function lastYieldDistributionBlock() external view returns (uint256);
}
```

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not multiplier-adjusted).
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion).
- `okuMMultiplier()` is a stored value for pricing — used by PSM and vault, not by `balanceOf`.
- `mint()` creates raw tokens; minting 100 tokens when `okuMMultiplier = $1.05` creates $105 of value.
- The PSM handles USDC ↔ OkuMoney conversion using `okuMMultiplier()` (dollar-value aware).
- `TransferValue` event emitted alongside the standard `Transfer` with the dollar-denominated amount.
- Blacklist and pause checks apply to transfers; self-burn works while paused.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20; emitted on mint/burn/transfer. |
| `TransferValue(from, to, amount, dollarValue)` | Alongside `Transfer`; `dollarValue = amount × okuMMultiplier / PRECISION`. |
| `OkuMMultiplierUpdated(oldMultiplier, newMultiplier, totalSupply)` | Emitted by `setOkuMMultiplier` and `distributeYield`. |
| `YieldDistributed(yieldAmount, oldMultiplier, newMultiplier, totalSupply)` | Emitted by `distributeYield` only; `yieldAmount` is the dollar input. |
| `MinterAllowanceUpdated(minter, oldAllowance, newAllowance)` | Emitted by `configureMinterAllowance`. |
| `MaxSupplyUpdated(oldMaxSupply, newMaxSupply)` | Emitted by `setMaxSupply`. |
| `Blacklisted(account)` / `Unblacklisted(account)` | Blacklist state changes. |
| `Approval(owner, spender, value)` | Standard ERC-20 approval. |

### Blacklist Exemption

`blacklist()` deliberately does NOT use `whenNotPaused` — critical for the pause-to-blacklist protocol so operators can act during a paused incident.

### Role Constants

```solidity
bytes32 public constant OKUM_UPGRADER          = keccak256("OKUM_UPGRADER");
bytes32 public constant OKUM_PAUSER            = keccak256("OKUM_PAUSER");
bytes32 public constant OKUM_UNPAUSER          = keccak256("OKUM_UNPAUSER");
bytes32 public constant OKUM_MINTER            = keccak256("OKUM_MINTER");
bytes32 public constant OKUM_REBASER           = keccak256("OKUM_REBASER");
bytes32 public constant OKUM_BLACKLISTER       = keccak256("OKUM_BLACKLISTER");
bytes32 public constant OKUM_UNBLACKLISTER     = keccak256("OKUM_UNBLACKLISTER");
bytes32 public constant OKUM_CAP_MANAGER       = keccak256("OKUM_CAP_MANAGER");
bytes32 public constant OKUM_ALLOWANCE_MANAGER = keccak256("OKUM_ALLOWANCE_MANAGER");
```

See [Role Grants Policy](#role-grants-policy) below for how roles are distributed at init.

---

## OkuDollar.sol

**Inherits**: `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`, `YieldSandwichGuard`, `UUPSUpgradeable`.

**Concept**: Rebasing $1-pegged stablecoin with an independent yield rate. Holds OkuMoney as reserves. Has its own USD shares mapping and its own **continuous** `_rpow` multiplier, decoupled from OkuMoney's multiplier. NOT an ERC-4626 vault — a custom rebasing token with reserve management.

### Storage (ERC-7201 Namespaced)

```solidity
struct OkuDollarStorage {
    IOkuMoney okuMoney;
    mapping(address => uint256) usdShares;
    uint256 totalUsdShares;
    uint256 usdBaseMultiplier;        // Last snapshot (starts 1e18)
    uint256 usdRatePerSecond;         // Compound rate (1e18 = no yield)
    uint256 usdLastAccrualTime;
    uint256 usdRateEnd;               // When current rate expires (0 = no expiry)
    uint256 usdPendingRatePerSecond;  // Next rate (activates at usdRateEnd)
    uint256 minCollateralRatio;       // e.g. 95e16 = 95%
}
```

### USD Multiplier (Continuous `_rpow` Streaming)

```
usdMultiplier() = usdBaseMultiplier × _rpow(usdRatePerSecond, elapsed, PRECISION) / PRECISION
```

Unlike OkuMoney (stored discrete multiplier), OkuDollar uses continuous `_rpow` accrual. `balanceOf(user)` returns `usdShares[user] × usdMultiplier() / PRECISION` — this value changes every second without any transaction.

**Rate scheduling**: Head-to-tail chaining via `setUsdYieldRate(rate, endTimestamp)` and `setNextUsdYieldRate(rate)` (rejects if the current `usdRateEnd` has already elapsed — `RateAlreadyExpired`).

### Wrap / Unwrap (Multiplier-Aware)

```solidity
// wrap:   sharesToMint = actualReceived × okuMMultiplier / usdMultiplier
//         usdMinted    = sharesToMint × usdMultiplier / PRECISION
function wrap(uint256 okuMAmount, address receiver, uint256 minAmountOut)
    external returns (uint256 usdMinted);

// unwrap: okuMReturned = usdAmount × PRECISION / okuMMultiplier
//         sharesToBurn = ceil(usdAmount × PRECISION / usdMultiplier)  -- rounded UP to favour vault
function unwrap(uint256 usdAmount, address receiver)
    external returns (uint256 okuMReturned);
```

Both are protected by `whenYieldNotDistributing` (via `YieldSandwichGuard`) and `whenNotPaused` (full freeze). `unwrap` reverts with `InsufficientBalance` if the caller's share balance is below `sharesToBurn`, or `InsufficientReserves` if the vault's OkuMoney reserves are below `okuMReturned`. These two errors are intentionally distinct — the first is a user balance check, the second is a vault-collateralization check.

### Reserve Management (`VAULT_RESERVE_MANAGER`)

```solidity
function depositReserves(uint256 okuMAmount) external;   // Top up, no shares minted. whenNotPaused.
function withdrawSurplus(uint256 okuMAmount) external;   // Extract, enforces minCollateralRatio. whenNotPaused.
```

### Collateralization (Multiplier-Aware)

```
collateralizationRatio = (OkuMoney.balanceOf(this) × okuMMultiplier / PRECISION) × PRECISION / totalSupply()
```

Numerator is dollar value of reserves. Denominator (`totalSupply()`) is dollar value of obligations (shares × multiplier). `surplus()` returns extractable OkuM tokens (0 if undercollateralized), computed as `max(0, reservesDollarValue - obligations) × PRECISION / okuMMultiplier`.

### Pause Behavior

Pause is a **full freeze**. The following are gated behind `whenNotPaused`:

- OkuMoney: peer-to-peer `transfer` / `transferFrom` (mint also; burn is NOT gated — self-burn works while paused to support the pause-to-blacklist protocol).
- OkuDollar: `transfer` / `transferFrom`, `wrap`, `unwrap`, `depositReserves`, `withdrawSurplus`.
- LitePSM: `mintOkuM`, `redeemOkuM`, `mintUsdOku`, `redeemUsdOku`, `redeemOkuMWithPermit`, `redeemUsdOkuWithPermit`, `processQueue`.
- OkuBridge: `bridgeBurn`, `bridgeMint`, `initiateRefund`, `confirmRefund`, `cancelRefund`.
- OkuBridgeRouter: `bridgeUsdOku`, `bridgeOkuM`, `bridgeWrappedVia`, `bridgeVia`.

**Intentionally NOT pause-gated**: the vault's yield-rate setters (`setUsdYieldRate`, `setNextUsdYieldRate`) and `setMinCollateralRatio` — these are admin emergency levers that must remain callable during a pause.

### Events

| Event | Parameters |
|---|---|
| `Transfer(from, to, amount)` | Standard ERC-20, with the caller-specified amount (NOT share-reconverted — avoids 1-wei drift). |
| `TransferValue(from, to, shares, dollarValue)` | Emitted alongside `Transfer`, exposing the share-level accounting. |
| `Wrapped(user, receiver, okuMAmount, usdMinted, okuMMultiplier, usdMultiplier)` | Both multipliers snapshotted for rate reconstruction. |
| `Unwrapped(user, receiver, usdAmount, okuMReturned, okuMMultiplier, usdMultiplier)` | Both multipliers snapshotted. |
| `UsdYieldRateUpdated(oldRatePerSecond, newRatePerSecond, endTimestamp, snapshotMultiplier)` | Rate change with snapshot for off-chain reconstruction. |
| `NextUsdYieldRateSet(newRatePerSecond, activatesAt)` | Pending rate staged. |
| `MinCollateralRatioUpdated(oldRatio, newRatio)` | Collateralization floor changed. |
| `ReservesDeposited(depositor, okuMAmount, dollarValue, collateralizationRatio)` | Reserve top-up with post-deposit ratio. |
| `SurplusWithdrawn(to, okuMAmount, dollarValue, collateralizationRatio)` | Revenue extraction with post-withdrawal ratio. |

---

## LitePSM.sol

**Concept**: Multiplier-aware USDC ↔ OkuMoney swaps with usdOku convenience functions.

### OkuMoney Swap Functions

```solidity
// okuMAmount = usdcValue18 × PRECISION / okuMMultiplier()
function mintOkuM(uint256 usdcAmount) external;

// usdcAmount = okuMAmount × okuMMultiplier() / PRECISION (scaled to 6 decimals)
function redeemOkuM(uint256 okuMAmount) external;
function redeemOkuMWithPermit(uint256 okuMAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
```

At `okuMMultiplier = $1.05`: depositing 100 USDC gives ~95.24 OkuM; redeeming 95.24 OkuM returns ~100 USDC.

### Convenience Functions (usdOku ↔ USDC via Vault)

```solidity
function mintUsdOku(uint256 usdcAmount) external;           // USDC → mint OkuM → wrap → usdOku to user
function redeemUsdOku(uint256 usdAmount) external;          // usdOku → unwrap → redeem → USDC to user
function redeemUsdOkuWithPermit(...) external;              // Permit variant
```

`redeemUsdOku` has two distinct failure modes: (a) vault undercollateralized → `unwrap` reverts with `InsufficientReserves` → entire tx reverts; (b) vault has OkuM but PSM buffer insufficient → OkuM goes to the redemption queue.

Every user-facing PSM function is protected by `whenYieldNotDistributing` + `whenNotPaused`.

### Oracle Configuration

`configureOracle(oracle, stalenessThreshold, enabled)` — `PSM_ORACLE_MANAGER`:
- Reverts with `ZeroAddress` if `enabled && oracle == 0` (prevents silent bypass via mis-config).
- Reverts with `InvalidStaleness(provided, min, max)` if `stalenessThreshold` is outside `[ORACLE_MIN_STALENESS=60, ORACLE_MAX_STALENESS=7 days]`.

Runtime oracle check (on `mintOkuM` / `mintUsdOku` when enabled):
- `answeredInRound < roundId` → `IncompleteOracleRound`.
- `block.timestamp - updatedAt >= stalenessThreshold` → `StaleOracleData`.
- `answer < 0` → `InvalidOracleResponse`.
- `reserves < totalSupply + mintAmount` → `ExceedsReserves(newSupply, reserves)`.

### Admin / Operator Surface

```solidity
function depositBuffer(uint256 amount) external;                           // PSM_BUFFER_DEPOSITOR
function withdrawUsdc(address to, uint256 amount) external;                // PSM_BUFFER_WITHDRAWER — reverts with ZeroAddress on to == 0; WouldStrandQueue protection
function processQueue(uint256 startIndex, uint256 endIndex, uint256 approveAmount) external;  // PSM_QUEUE_PROCESSOR. whenNotPaused + nonReentrant.
function pause() / unpause() external;                                     // PSM_PAUSER / PSM_UNPAUSER
```

### Events

| Event | Parameters |
|---|---|
| `OkuMMinted(user, usdcAmount, okuMAmount, okuMMultiplier)` | `mintOkuM` success. |
| `OkuMRedeemed(user, okuMIn, usdcOut, okuMMultiplier)` | `redeemOkuM` instant path only. Queued path emits `RedemptionQueued` instead. |
| `UsdOkuMinted(user, usdcAmount, usdAmount, okuMMultiplier)` | `mintUsdOku` success. |
| `UsdOkuRedeemed(user, usdIn, usdcOut, okuMMultiplier)` | `redeemUsdOku` — sole event for this path; no inner `OkuMRedeemed` is emitted. |
| `OracleConfigured(oracle, stalenessThreshold, enabled)` | `configureOracle`. |
| `BufferRefilled(newBufferBalance, processedStart, processedEnd)` | After `processQueue`. |
| `BufferDeposited(depositor, amount, newBufferBalance)` | After `depositBuffer`. |
| `BufferWithdrawn(to, amount, newBufferBalance)` | After `withdrawUsdc`. |

---

## RedemptionQueue.sol

Stores raw OkuMoney token amounts. Since OkuMoney is non-rebasing, queued tokens don't grow in balance — but they appreciate in dollar value via `okuMMultiplier()`. At processing time, `usdcAmount = okuMAmount × okuMMultiplier() / PRECISION` (scaled to 6 decimals). The multiplier is cached once per batch for gas efficiency and cross-entry consistency.

`enqueue(user, okuMTokenAmount)` is record-only — the PSM transfers OkuMoney into the queue before calling. `processQueue(startIndex, endIndex)` (called by the PSM via `QUEUE_PSM`) burns OkuMoney, pulls USDC from the PSM, and pays users. `rescueQueueEntry(index, alternateRecipient)` returns OkuMoney to a stuck entry (e.g., USDC-blacklisted recipient) — called by `QUEUE_RESCUER`.

### Events

| Event | Parameters |
|---|---|
| `RedemptionQueued(user, okuMAmount, dollarValue, position, queueLength)` | `enqueue`. |
| `RedemptionProcessed(user, okuMAmount, dollarValue, usdcAmount, waitTime)` | `processQueue` success. |
| `RedemptionSkipped(index, reason)` | `reason` is `AlreadyCleared` or `InsufficientFunds`. |
| `RedemptionRescued(index, originalUser, recipient, okuMAmount, dollarValue)` | `rescueQueueEntry`. |

---

## Bridge Architecture

Three-tier hierarchy:

```
OkuBridgeRouter          ← single user entry point; token normalization + path selection
  ├── native path        → OkuBridge.bridgeBurn() (bridge owns burn lifecycle)
  └── adapter path       → router pre-burns OkuMoney → IBridgeAdapter.bridge() (message-only shim)

OkuBridge                ← full native protocol (source burn + destination mint)
  bridgeBurn()           ← burns from caller, subtractive fee, EIP-712 BridgeBurn event
  bridgeMint()           ← validates orchestrator EIP-712 sig, mints on destination

IBridgeAdapter shims     ← third-party protocol adapters (NTT today, CCIP / OFT future)
```

Bridge operates on raw OkuMoney token amounts — no share conversion. MINTER on OkuMoney is granted to LitePSM, OkuBridge, and OkuBridgeRouter (the router holds MINTER so its adapter-path burns succeed).

### Refund Flow (two-step, keyed dual-control)

`BRIDGE_REFUND_INITIATOR` calls `initiateRefund(request)` → `BRIDGE_REFUND_CONFIRMER` calls `confirmRefund(request)`. The confirmer MUST be a different address than the initiator (`InitiatorCannotConfirm`). `cancelRefund(request)` can be called by the original initiator or an admin to drop a pending proposal. All three are `whenNotPaused`.

### `bridgeMint` Validation

Validates in order:
1. `destChainId == block.chainid` (`WrongChain`).
2. `sourceChainId != block.chainid` (`CannotBridgeToSelf`).
3. `request.amount > 0` (`ZeroAmount`) — a signed zero-amount mint would permanently mark the `requestId` as processed while being a no-op.
4. `uint256(recipient) >> 160 == 0` (`InvalidRecipient`) — for EVM destinations, reject any `bytes32` with non-zero high bytes (guards against a Solana-style 32-byte pubkey being silently truncated into an EVM address).
5. `supportedChains[sourceChainId]` (`UnsupportedChain`).
6. `block.timestamp <= request.deadline` (`SignatureExpired`).
7. `!processedRequests[requestId]` (`AlreadyProcessed`).
8. EIP-712 signature verified against `authorizedSigner` (`InvalidSignature`).
9. Extracted low-20-byte recipient != `address(0)` (`ZeroAddress`).

### OkuBridge Events

| Event | Parameters |
|---|---|
| `BridgeBurn(requestId, sender, recipient, sourceChainId, destChainId, grossAmount, netAmount, feeAmount, nonce, deadline)` | Source-chain burn. |
| `BridgeMint(requestId, recipient, sourceChainId, destChainId, amount)` | Destination-chain mint. |
| `SignerUpdated(oldSigner, newSigner)` | Orchestrator key rotation. |
| `FeeUpdated(oldFee, newFee)` | Basis-point fee change. |
| `FeeRecipientUpdated(oldRecipient, newRecipient)` | Fee recipient change. |
| `ChainAdded(chainId)` / `ChainRemoved(chainId)` | Supported-chain set changes. |
| `LimitsUpdated(oldMin, oldMax, newMin, newMax)` | Bridge amount limits. |
| `NonceSkipped(destChainId, skippedNonce)` | Admin forcibly advanced a stuck nonce. |
| `DeadlineUpdated(oldDeadline, newDeadline)` | Signature-window TTL. |
| `RefundInitiated(requestId, initiator, sender, amount)` | Step 1 of refund flow. |
| `RefundConfirmed(requestId, sender, amount)` | Step 2 — tokens returned. |
| `RefundCancelled(requestId, initiator, cancelledBy)` | Pending proposal dropped. |

### OkuBridgeRouter Events

| Event | Parameters |
|---|---|
| `NativeBridgeInitiated(user, requestId, inputAmount, bridgedAmount, feeAmount, destinationChain, recipient)` | Native path — `bridgeUsdOku` / `bridgeOkuM`. `inputAmount` is in the input token's units (usdOku or OkuM). |
| `BridgeInitiated(user, adapter, sourceToken, amount, destinationChain, recipient)` | Adapter path — `bridgeWrappedVia` / `bridgeVia`. |
| `AdapterConfigured(adapter, supported)` | Registered/unregistered an adapter. |
| `OkuBridgeUpdated(oldBridge, newBridge)` | Router re-pointed at a different OkuBridge (e.g. after upgrade). |
| `Swept(token, to, amount)` | Admin pulled a stuck third-party ERC-20 out of the router (`sweep` — blocks OkuMoney + OkuDollar). |

---

## NttAdapter.sol

**Inherits**: `AccessControl` (migrated from `Ownable` in Phase 4 for consistency with the rest of the protocol).

Adapter integrating Wormhole NTT with `OkuBridgeRouter`. The router pre-burns OkuMoney before calling this adapter, so the adapter only handles cross-chain message delivery. Conversions: `uint256 destinationChain → uint16 wormholeChainId`, `address recipient → bytes32` (left-padded for EVM destinations).

Roles (Anchor-equivalent `DEFAULT_ADMIN_ROLE` / `NTT_CONFIGURATOR` / `NTT_RESCUER`):

```solidity
bytes32 public constant NTT_CONFIGURATOR = keccak256("NTT_CONFIGURATOR"); // configureChainId
bytes32 public constant NTT_RESCUER      = keccak256("NTT_RESCUER");      // withdrawEth / withdrawTokens
```

### Events

| Event | Parameters |
|---|---|
| `NttBridgeInitiated(amount, wormholeChainId, recipient, sequence)` | NTT `transfer` call from the router. |
| `ChainIdConfigured(evmChainId, wormholeChainId)` | EVM → Wormhole chain-id mapping added/updated. |

`IOFTAdapter.sol` was removed in Phase 1 (unused). Only `IBridgeAdapter` + `NttAdapter` + `INttManager` remain in `src/bridge/adapters/`.

---

## YieldSandwichGuard

Shared abstract at `src/lib/YieldSandwichGuard.sol`, inherited by both `OkuDollar` and `LitePSM`. Exposes the `whenYieldNotDistributing` modifier and the `YieldDistributionInProgress` error.

```solidity
abstract contract YieldSandwichGuard {
    error YieldDistributionInProgress();

    modifier whenYieldNotDistributing() {
        if (block.number == _yieldSandwichOkuMoney().lastYieldDistributionBlock()) {
            revert YieldDistributionInProgress();
        }
        _;
    }

    function _yieldSandwichOkuMoney() internal view virtual returns (IOkuMoney);
}
```

OkuMoney records `lastYieldDistributionBlock = block.number` inside `setOkuMMultiplier` and `distributeYield`. OkuDollar and LitePSM inherit the guard and override `_yieldSandwichOkuMoney()` to return their stored `okuMoney` reference. Result: **any** PSM mint/redeem or vault wrap/unwrap that lands in the same block as a yield distribution reverts with `YieldDistributionInProgress`. The lock releases automatically on the next block.

**Protected operations**:
- `LitePSM.mintOkuM` / `redeemOkuM` / `mintUsdOku` / `redeemUsdOku` (+ permit variants)
- `OkuDollar.wrap` / `unwrap`

**Unaffected**: OkuMoney transfers, OkuDollar transfers, operations in subsequent blocks.

---

## Role Grants Policy

As of Phase 4, every contract's `initialize` grants its **full** role set to `admin`. Admin is expected to redistribute operational roles (minters, rebasers, reserve managers, refund confirmers, etc.) to other parties (multisigs, bots, bridge contracts) post-deployment. This removes contract-specific role plumbing from deployment scripts.

One intentional exception:
- `RedemptionQueue.QUEUE_PSM` is NOT granted at init — it is granted post-deploy to the `LitePSM` proxy address. This avoids a circular deployment dependency AND keeps admin from being able to call `enqueue` / `processQueue` directly (bypassing the PSM).

---

## Key Invariants

Maintained by the contracts and verified by the test suites at `test/invariants/`:

**Token / multiplier**
```
balanceOf(user) == _balances[user]                              // OkuMoney: standard ERC-20
okuMMultiplier() >= previousOkuMMultiplier                      // Multiplier never decreases
totalSupply() <= maxSupply                                      // Supply cap respected
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION  // OkuDollar: share conversion
```

**Vault**
```
collateralizationRatio >= minCollateralRatio (after withdrawSurplus)
reservesDollarValue + <100 wei rounding> >= totalSupply         // Vault-backed within tolerance
unwrap(wrap(okuMAmount)) >= okuMAmount - 1                      // Round-trip accuracy
totalOkuMReserves() == OkuMoney.balanceOf(address(okuDollar))   // Reserve accounting
```

**Minter allowance**
```
minterAllowance only decreases unless admin resets
allowanceConsumed <= mintedTotal + 1                            // Burns don't restore allowance
```

**PSM**
```
okuMoney.balanceOf(litePsm) <= 1 wei                            // No stale OkuM held between calls
redemptionQueue.totalQueuedOkuM == okuMoney.balanceOf(queue)    // Queue backed exactly by its OkuM
psmUsdcOutflow <= seededBuffer + trackedDeposits + tolerance    // USDC outflow bounded by inflow
```

**Bridge (stateful)**
```
okuMoney.balanceOf(okuBridge) == 0                              // Bridge never holds OkuMoney
outboundNonce[chain] == sum(bridgeBurn calls to chain)          // Nonce monotonic, exact count
processedRequests ∩ refundedRequests == ∅                       // No double-finalisation
okuMoney.balanceOf(feeRecipient) == ghostFeesCollected          // Exact fee accounting
netMinted <= netBurned + netRefunded                            // Value conservation
```

---

## Testing

```bash
forge test                                         # All unit + invariant tests (~610 total)
forge test --match-path "test/invariants/*"        # Invariant suite (256 runs × 500 depth by default)
forge test --match-contract OkuMoneyTest -vv       # OkuMoney unit tests
forge test --match-contract VaultInvariants        # OkuDollar backing invariants
forge test --match-contract BridgeInvariants       # Stateful bridge invariants (requires OkuBridgeHandler)
forge test --match-contract HandlerSanityTest      # Handler success-rate sanity checks

npx hardhat compile                                # Regenerates typechain before fork tests
npx hardhat test                                   # Fork tests (mainnet/Sepolia) + gas regression
npx hardhat test test/hardhat/gas/                 # Gas-regression only
```

The Foundry suite is the authoritative functional coverage (~610 tests). The Hardhat suite (33 tests) exists for two specific purposes only:
1. **Fork tests** (`test/hardhat/fork/`, `test/hardhat/happyPath/`): exercise the protocol against real mainnet/Sepolia state that Foundry can't easily reach in CI.
2. **Gas regression** (`test/hardhat/gas/`): assert that real-deployment gas costs (under the `@openzeppelin/hardhat-upgrades` plugin and full proxy machinery) stay within published targets.

Any non-fork functional test should be added to the Foundry suite.
