# OkuMoney EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuMoney — institutional-grade yield infrastructure backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil)
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy Pattern**: TransparentUpgradeableProxy (token/PSM) / UUPS (bridge contracts)
- **Oracle**: Chainlink AggregatorV3Interface

## Contracts

| Contract | Description |
|----------|-------------|
| `OkuMoney.sol` | Non-rebasing base token (OkuM) — static balance, appreciating price via `okuMPrice()` |
| `OkuDollar.sol` | Rebasing $1-pegged stablecoin (usdOku) — growing balance, independent yield rate |
| `LitePSM.sol` | Peg Stability Module — price-aware USDC ↔ OkuM + usdOku convenience functions |
| `OkuBridge.sol` | Native cross-chain bridge (burn/mint with EIP-712 orchestrator signatures) |
| `OkuBridgeRouter.sol` | User entry point for bridging OkuMoney and OkuDollar |
| `NttAdapter.sol` | Wormhole NTT bridge adapter (third-party adapter path) |

## Quick Start

```bash
# Install dependencies
forge install

# Build
forge build

# Run all tests
forge test

# Run specific contract tests
forge test --match-contract OkuMoneyTest -vv
forge test --match-contract OkuDollarTest -vv
forge test --match-contract OkuBridgeTest -vv
forge test --match-contract OkuBridgeRouterTest -vv
```

### Hardhat (Fork Tests)

```bash
npm install
npx hardhat test
```

## Contract Structure

```
src/
  token/
    OkuMoney.sol            # Non-rebasing base token (price appreciates via okuMPrice())
    OkuDollar.sol           # Rebasing stablecoin vault (independent yield rate, $1 peg)
  psm/
    LitePSM.sol             # USDC ↔ OkuM (price-aware) + usdOku convenience functions
    RedemptionQueue.sol     # Queue for when PSM USDC buffer is insufficient
  bridge/
    OkuBridge.sol           # Native cross-chain bridge (full burn/mint protocol)
    OkuBridgeRouter.sol     # Entry point: token normalization + bridge path selection
    adapters/
      IBridgeAdapter.sol    # Interface for third-party message-only adapters
      IOFTAdapter.sol       # LayerZero OFT interface
      INttManager.sol       # Wormhole NTT interface
      NttAdapter.sol        # Wormhole NTT adapter implementation
  interfaces/
    IOkuMoney.sol           # OkuMoney interface
    IOkuDollar.sol          # OkuDollar vault interface
  mocks/
    MockBridgeAdapterHH.sol # Hardhat-compatible IBridgeAdapter mock
    MockNttManagerHH.sol    # Hardhat-compatible NTT Manager mock
test/
  token/
    OkuMoney.t.sol
    OkuMoney.fuzz.t.sol
    OkuDollar.t.sol
    OkuDollar.fuzz.t.sol
  psm/
    LitePSM.t.sol
    RedemptionQueue.t.sol
  bridge/
    OkuBridge.t.sol
    OkuBridgeRouter.t.sol
  hardhat/
    bridge/
      OkuBridge.test.ts
      OkuBridgeRouter.test.ts
    fork/
      OkuDollar.ts
  invariants/
    VaultInvariants.t.sol
    SupplyInvariants.t.sol
    OkuMPriceInvariants.t.sol
    MinterAllowanceInvariants.t.sol
  handlers/
    OkuMoneyHandler.sol
    OkuDollarHandler.sol
  Base.t.sol
script/
  Deploy.s.sol
```

## Dual-Token Split-Economy Model

OkuMoney and OkuDollar have **independent yield rates** controlled by separate roles. This enables three operational modes:

```
usdOku rate > OkuM rate  →  Vault undercollateralized → Oku tops up (depositReserves)
usdOku rate = OkuM rate  →  Vault fully collateralized → No action needed
usdOku rate < OkuM rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

OkuMoney is the solvency anchor (rear-facing, always backed). OkuDollar is a policy lever.

**Key distinction**: OkuMoney is **non-rebasing** (standard ERC-20, price appreciates). OkuDollar is **rebasing** ($1-pegged, balance grows).

## Bridge Architecture

The bridge system has a clear three-tier hierarchy:

```
OkuBridgeRouter          ← single user entry point; token normalization layer
  ├── native path        → OkuBridge.bridgeBurn() directly (no pre-burn by router)
  └── adapter path       → pre-burn → IBridgeAdapter.bridge() (message-only shims)

OkuBridge                ← full native protocol (source burn + destination mint)
  bridgeBurn()           ← burns from caller, collects fee, emits event for orchestrator
  bridgeMint()           ← destination: validate EIP-712 sig, mint tokens

IBridgeAdapter shims     ← third-party protocol adapters (NTT, CCIP, etc.)
  NttAdapter             ← translates IBridgeAdapter → Wormhole NTT
  (future CcipAdapter)
```

### Two Bridge Models

**Native path** — OkuBridge owns its own burn lifecycle:
- Router unwraps OkuDollar to OkuMoney if needed, then calls `OkuBridge.bridgeBurn()`
- OkuBridge (as MINTER on OkuMoney) burns from the router, collects fee, increments nonce, emits `BridgeBurn`
- Orchestrator observes the event, waits for finality, signs a `BridgeRequest` (EIP-712)
- Anyone calls `OkuBridge.bridgeMint()` on destination with the signed request

**Adapter path** — Router is the burn authority:
- Router burns OkuMoney itself, then calls `IBridgeAdapter.bridge()` (message-only)
- Adapter translates the call to the third-party protocol (Wormhole VAA, CCIP message, etc.)
- The third-party protocol handles destination minting natively (no OkuBridge.bridgeMint involved)

### Key Design Distinctions

| | Native (OkuBridge) | Third-party (NTT/CCIP) |
|---|---|---|
| Who burns on source | OkuBridge (called by router) | OkuBridgeRouter |
| Destination mint | OkuBridge.bridgeMint() + EIP-712 | Protocol-native |
| Fee model | Oku-controlled (bps in tokens) | Protocol-native |
| Recovery | skipNonce, initiateRefund + confirmRefund | Protocol-native |
| Trust model | Oku orchestrator key | Wormhole Guardians / CCIP DON |

### Router Functions

```
bridgeOkuM(amount, destChain, recipient)      — direct bridge of OkuMoney tokens
bridgeUsdOku(amount, destChain, recipient)    — unwrap usdOku → OkuM → bridge
                                                 destination: mint OkuM → wrap → deliver usdOku
bridgeVia(amount, adapter, destChain, recipient)  — OkuM bridge via third-party adapter
bridgeWrappedVia(amount, adapter, destChain, recipient) — unwrap usdOku → adapter bridge
```

All four bridge functions are guarded with `nonReentrant` to prevent reentrant calls through external adapter contracts.

### Two-Step Refund

Failed bridge requests (where the destination mint did not occur) are recovered via a two-step refund process requiring two separate keys:

1. `initiateRefund(request)` — called by `BRIDGE_REFUND_INITIATOR` after the request deadline has passed and after independently verifying no destination mint occurred. Records the proposal on-chain.
2. `confirmRefund(request)` — called by `BRIDGE_REFUND_CONFIRMER` (must be a **different address** than the initiator) after its own independent verification. Executes the mint back to the original sender.

This 2-of-2 design prevents a single compromised key from minting a fraudulent refund for a request that was already minted on the destination chain. The confirmer cannot be the same address as the initiator — enforced at execution time via `InitiatorCannotConfirm` error.

**DeFi & bridge compatibility**: Since OkuMoney is a standard non-rebasing ERC-20, third-party bridges (LayerZero OFT, Wormhole NTT, CCIP) can handle it natively without share conversion.

---

## OkuMoney.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through price appreciation tracked by an internal `okuMPrice()` view function using `_rpow` continuous accrual. DeFi and bridge compatible out of the box.

### Storage

```solidity
// Standard ERC-20 balances managed by parent ERC20Upgradeable (no custom _shares mapping)

// Price accrual mechanism (continuous)
uint256 internal _basePrice;            // last snapshot of price (starts at 1e18 = $1.00)
uint256 public ratePerSecond;           // compound rate per second (1e18 = no yield)
uint256 public lastAccrualTime;         // timestamp of last _basePrice snapshot
uint256 public rateEnd;                 // when current rate expires (0 = no expiry)
uint256 public pendingRatePerSecond;    // next rate, activates at rateEnd

uint256 public maxSupply;               // supply cap in token units
mapping(address => uint256) public minterAllowance;
mapping(address => bool) public isBlacklisted;
```

### Price Accrual

`okuMPrice()` is a computed view function. Yield accrues continuously via `_rpow(ratePerSecond, elapsed, PRECISION)` (MakerDAO DSS exponentiation by squaring):

```
okuMPrice() = _basePrice × _rpow(ratePerSecond, elapsed, PRECISION) / PRECISION
```

The token starts at `okuMPrice() = 1e18` ($1.00). Over time, `okuMPrice()` grows as rear-facing T-Bill yield accrues. After one year at 4.5% APY, `okuMPrice()` returns ~1.045e18 ($1.045).

**Key difference from old design**: `balanceOf()` returns raw token count (standard ERC-20). It is NOT affected by `okuMPrice()`. Price appreciation is tracked separately for use by the PSM and vault.

### Rate Management

- `setYieldRate(rate, endTimestamp)` — OKUM_REBASER sets active rate with optional end time. Snapshots current price before switching.
- `setNextYieldRate(rate)` — OKUM_REBASER schedules next rate that activates when current expires (head-to-tail chaining, no tx needed at transition).
- `updateOkuMPrice(newPrice)` — Emergency override. Snapshots computed price, resets rate to zero yield.
- `okuMPrice()` — Computed view function. Handles current rate, expiry crossover, and pending rate seamlessly.
- `_rpow(x, n, b)` — Exponentiation by squaring (MakerDAO DSS, battle-tested since 2017).

**Rear-facing yield**: The orchestrator feeds realized T-Bill returns (not projected). January's actual yield gets distributed as February's `ratePerSecond`. The contract does not know or care whether the rate is forward or rear-derived — this is purely an orchestrator-side operational choice. OkuMoney is always fully backed because it only distributes yield that has already been earned.

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not price-adjusted)
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion)
- `okuMPrice()` is a view function for pricing — used by PSM and vault, not by `balanceOf`
- `mint()` creates raw tokens; minting 100 tokens when okuMPrice = $1.05 creates $105 of value
- The PSM handles USDC ↔ OkuMoney conversion using `okuMPrice()`
- Blacklist and pause checks apply to transfers

### Yield Distribution Lock (Sandwich Attack Prevention)

OkuMoney uses discrete yield distribution via `distributeYield()` or `setOkuMPrice()`. Without protection, this creates an arbitrage window where attackers can:

1. Watch mempool for `distributeYield()` transactions
2. Frontrun: Call `mintOkuM()` at the current (lower) price
3. Let the yield distribution execute: Price increases
4. Backrun: Call `redeemOkuM()` at the new (higher) price
5. Capture yield they didn't earn by holding

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

**Unaffected operations**:
- OkuMoney transfers (no price sensitivity)
- OkuDollar transfers (no price sensitivity)
- Operations in subsequent blocks (lock auto-releases)

**Backend impact**: None. The orchestrator calls `distributeYield()` as before. Protection is automatic — no additional transactions needed.

### Role Constants

```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant OKUM_PAUSER = keccak256("OKUM_PAUSER");
bytes32 public constant OKUM_UNPAUSER = keccak256("OKUM_UNPAUSER");
bytes32 public constant MINTER = keccak256("MINTER");
bytes32 public constant OKUM_REBASER = keccak256("OKUM_REBASER");
bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");
```

**Critical**: `blacklist()` must NOT use `whenNotPaused` modifier.

**Blacklist and infrastructure addresses**: There is no contract-level blacklist exemption for bridge or router addresses. Operators must ensure infrastructure contract addresses are never passed to `blacklist()`. This is an operational constraint, not a contract-level enforcement.

---

## OkuDollar.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Rebasing $1-pegged stablecoin with an independent yield rate. Holds OkuMoney as reserves. Has its own USD shares mapping and its own continuous multiplier, decoupled from OkuMoney's price. This is NOT an ERC-4626 vault — it is a custom rebasing token with reserve management.

### Storage

```solidity
IOkuMoney public okuMoney;                  // reference to OkuMoney contract

// USD rebasing mechanism
mapping(address => uint256) private _usdShares;
uint256 private _totalUsdShares;            // public getter: totalUsdShares()
uint256 internal _usdBaseMultiplier;        // public getter: usdBaseMultiplier()
uint256 public usdRatePerSecond;            // compound rate per second (1e18 = no yield)
uint256 public usdLastAccrualTime;          // timestamp of last snapshot
uint256 public usdRateEnd;                  // when current rate expires
uint256 public usdPendingRatePerSecond;     // next rate, activates at usdRateEnd

// Collateralization
uint256 public minCollateralRatio;          // e.g. 95e16 = 95%, enforced on withdrawSurplus
```

### Key Implementation Notes

- `usdMultiplier()` is a computed view function — same `_rpow` pattern as OkuMoney's `okuMPrice()`
- `balanceOf(user)` returns `_usdShares[user] * usdMultiplier() / PRECISION`
- `totalSupply()` returns `_totalUsdShares * usdMultiplier() / PRECISION`
- Transfers operate on USD shares internally, emit token amounts for ERC-20 compatibility
- Parent ERC20Upgradeable's `_balances` mapping is fully suppressed — all balance state is in `_usdShares`
- Pause is a **full freeze**: peer-to-peer OkuDollar transfers, `wrap`, and `unwrap` are all blocked while paused. As a consequence, `redeemUsdOku` in LitePSM is also blocked (it calls `unwrap` internally).

### Wrap/Unwrap (Price-Aware)

```solidity
// wrap: deposit OkuMoney, receive OkuDollar
// usdMinted = okuMAmount × okuMPrice() / usdMultiplier()
function wrap(uint256 okuMAmount, address receiver) external returns (uint256 usdMinted);

// unwrap: burn OkuDollar, receive OkuMoney
// okuMReturned = usdAmount × usdMultiplier() / okuMPrice()
// Reverts if vault holds insufficient OkuMoney
function unwrap(uint256 usdAmount, address receiver) external returns (uint256 okuMReturned);
```

Wrap pricing: price-aware. 100 OkuM at okuMPrice = $1.05, usdMultiplier = 1.0 produces 105 usdOku. The dollar value (`okuMAmount × okuMPrice()`) is converted to OkuDollar at the current usdMultiplier.

Unwrap pricing: price-aware inverse. 105 usdOku at usdMultiplier = 1.0, okuMPrice = $1.05 returns 100 OkuM. Reverts if `OkuMoney.balanceOf(address(this))` is insufficient.

### Reserve Management (RESERVE_MANAGER)

```solidity
// Top up: deposit OkuMoney without minting usdOku shares
// Used when usdOku rate > OkuM rate (vault undercollateralized)
function depositReserves(uint256 okuMAmount) external onlyRole(RESERVE_MANAGER);

// Extract surplus: withdraw OkuMoney without burning usdOku shares
// Used when usdOku rate < OkuM rate (vault overcollateralized)
// MUST enforce: collateralizationRatio() >= minCollateralRatio AFTER withdrawal
function withdrawSurplus(uint256 okuMAmount) external onlyRole(RESERVE_MANAGER);
```

Both functions accept OkuMoney token amounts. Since OkuMoney is non-rebasing, token amounts are NOT dollar-denominated — their value depends on `okuMPrice()`. The collateralization ratio recalculates automatically on the next read.

### Collateralization Views

```solidity
function totalOkuMReserves() public view returns (uint256);       // OkuMoney.balanceOf(this)
function totalUsdObligations() public view returns (uint256);     // totalSupply()
function collateralizationRatio() public view returns (uint256);  // price-aware ratio
function surplus() public view returns (uint256);                 // extractable OkuM (0 if undercollateralized)
```

Collateralization ratio formula (price-aware):
```
collateralizationRatio = (OkuMoney.balanceOf(this) × okuMPrice() / PRECISION) × PRECISION / totalSupply()
```

The numerator converts OkuMoney token count to dollar value via `okuMPrice()`. The denominator (`totalSupply()`) is already in dollar terms (usdShares × usdMultiplier).

### Admin

```solidity
function setMinCollateralRatio(uint256 newRatio) external onlyRole(DEFAULT_ADMIN_ROLE);
```

Adjusts the collateralization floor. Enforces `newRatio <= PRECISION` (cannot exceed 100%).

### Rate Management (USD_REBASER)

```solidity
function setUsdYieldRate(uint256 newRate, uint256 endTimestamp) external onlyRole(USD_REBASER);
function setNextUsdYieldRate(uint256 newRate) external onlyRole(USD_REBASER);
function updateUsdMultiplier(uint256 newMultiplier) external onlyRole(USD_REBASER); // emergency
```

Same mechanics as OkuMoney's rate management — snapshot before switching, head-to-tail chaining, `_rpow` continuous accrual. The rate is a policy decision set by Oku, independent of OkuMoney's rate.

### Role Constants

```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant USD_REBASER = keccak256("USD_REBASER");
bytes32 public constant RESERVE_MANAGER = keccak256("RESERVE_MANAGER");
bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");
```

### Operational Examples

Revenue extraction (usdOku rate < OkuM rate):
```
OkuM rate:   4.5% APY (realized)
usdOku rate: 4.0% APY (policy — Oku retains 0.5% spread)
Over time:   vault accumulates surplus OkuMoney
Oku calls:   withdrawSurplus(surplusAmount)
Safety:      collateralizationRatio must remain >= minCollateralRatio after withdrawal
```

Forward-facing yield (usdOku rate > OkuM rate):
```
OkuM rate:   4.0% APY (last period's realized)
usdOku rate: 4.5% APY (policy — streaming projected yield as a feature)
Over time:   vault becomes slightly undercollateralized
Oku calls:   depositReserves(gapAmount) to top up
```

---

## LitePSM.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard, UUPSUpgradeable

Note: OZ v5 `ReentrancyGuard` is `@custom:stateless` (ERC-7201 namespaced storage slot). No `ReentrancyGuardUpgradeable` variant exists in this library version, and no `__ReentrancyGuard_init()` call is required.

**Concept**: Price-aware USDC ↔ OkuMoney swaps. Queue handles insufficient buffer. Convenience functions route through the OkuDollar vault for single-transaction mint/redeem of the stablecoin.

### Core PSM Functions (OkuM ↔ USDC — Price-Aware)

```solidity
// USDC → OkuMoney: okuMAmount = usdcValue × PRECISION / okuMPrice()
function mintOkuM(uint256 usdcAmount) external;

// OkuMoney → USDC: usdcAmount = okuMAmount × okuMPrice() / PRECISION (scaled to 6 decimals)
function redeemOkuM(uint256 okuMAmount) external;
```

The PSM is no longer 1:1 in token terms. If `okuMPrice()` is $1.05, depositing 100 USDC gives ~95.24 OkuM. Redeeming 95.24 OkuM returns ~100 USDC. The PSM always transacts in dollar-value terms — the user thinks in USDC, the PSM handles the price conversion internally.

### Convenience Functions (usdOku ↔ USDC via Vault)

```solidity
// USDC → mint OkuM internally → wrap into vault → deliver usdOku to user
function mintUsdOku(uint256 usdcAmount) external;

// Receive usdOku → unwrap to OkuM → burn OkuM → deliver USDC to user
// Two failure modes: (a) vault undercollateralized → unwrap reverts → entire tx reverts
//                    (b) vault has OkuM but PSM buffer insufficient → OkuM goes to queue
function redeemUsdOku(uint256 usdAmount) external;

// Permit variant for single-tx UX
function redeemUsdOkuWithPermit(uint256 usdAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
```

PSM has MINTER role on OkuMoney. For `mintUsdOku`, the PSM mints OkuM to self, approves vault, calls `vault.wrap(okuMAmount, msg.sender)`. For `redeemUsdOku`, the PSM receives usdOku, calls `vault.unwrap(usdAmount, address(this))`, receives OkuM, then redeems via normal price-aware redeem path.

**Storage, RBAC, queue, buffer management, oracle checks**: Core PSM mechanics unchanged. Existing `mint()` / `redeem()` become `mintOkuM()` / `redeemOkuM()`.

### Queue Behavior

The redemption queue operates on OkuMoney tokens. Since OkuMoney is non-rebasing, queued tokens do not grow in balance — but they appreciate in price via `okuMPrice()`. When the queue processes, the user receives USDC based on `okuMAmount × okuMPrice()` at processing time. The economic result is the same (user earns yield while queued) but through price appreciation rather than balance growth.

### Stuck Queue Entries

If a queue entry becomes permanently unprocessable (e.g., the recipient's address is USDC-blacklisted after entering the queue), the `QUEUE_RESCUER` role can call `rescueQueueEntry(index, alternateRecipient)` to return the OkuMoney to the original user or an admin-specified alternate address.

**Operator flow for blocked batches:**
1. Identify the stuck entry index via `getQueueEntry(index)`
2. Call `rescueQueueEntry(index, alternateRecipient)` — transfers OkuM back (not burned), deletes the slot, advances `queueHead` if applicable
3. Call `processQueue(startIndex, endIndex, ...)` on the remaining live entries as normal

`queueLength()` returns an upper-bound approximation (`queueTail - queueHead`) and may briefly over-count if entries between `queueHead` and the current processing range have been rescued but `queueHead` has not yet advanced past them.

---

## Proxy Deployment

Each contract deployed behind TransparentUpgradeableProxy:

```solidity
// Deploy implementation
OkuMoney impl = new OkuMoney();

// Deploy proxy
TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
    address(impl),
    proxyAdmin,
    abi.encodeCall(OkuMoney.initialize, (admin, pauser, ...))
);
```

**ProxyAdmin ownership**: Cold Multisig (same entity with UPGRADER roles)

## Deterministic Deployment

Use CREATE2 via deterministic deployer for same addresses across chains:

```solidity
// Same salt + same bytecode = same address on all EVM chains
bytes32 salt = keccak256("OkuMoney-v1");
address deployed = deployer.deploy(salt, bytecode);
```

---

## Testing

### Unit Tests (Forge)

```bash
forge test --match-contract OkuMoneyTest
forge test --match-contract OkuDollarTest
```

### Invariant Tests (Forge)

```bash
forge test --match-contract VaultInvariants
forge test --match-contract SupplyInvariants
```

### Key Test Scenarios

*OkuMoney (non-rebasing with price oracle):*
- Standard ERC-20: balanceOf returns raw balance, unaffected by okuMPrice
- okuMPrice starts at PRECISION ($1.00), grows with setYieldRate over time
- setNextYieldRate head-to-tail seamless transition
- okuMPrice emergency override via updateOkuMPrice
- balanceOf and totalSupply do NOT change when okuMPrice increases
- Mint/burn with allowance tracking (raw token amounts)
- Continuous yield accrual: APY accuracy (~4.5% over 365 days)
- Continuous yield accrual: rate expiry stops price growth with no pending rate
- Pause blocks operations, blacklist works while paused
- Permit
- Role separation enforcement

*OkuDollar (rebasing vault):*
- Wrap: price-aware — okuMAmount × okuMPrice / usdMultiplier = correct usdOku
- Unwrap: price-aware inverse, revert if insufficient reserves
- Wrap/unwrap round-trip accuracy at various okuMPrice/usdMultiplier combinations
- Independent USD multiplier grows via its own _rpow
- USD rate independent of OkuM rate
- depositReserves increases collateralization ratio without minting shares
- withdrawSurplus extracts excess, enforces minCollateralRatio
- withdrawSurplus reverts if would breach minCollateralRatio
- Overcollateralized scenario: surplus() returns correct extractable amount
- Undercollateralized scenario: unwrap reverts when insufficient OkuMoney
- Pause blocks peer-to-peer usdOku transfers but allows wrap/unwrap
- Repeated wrap/unwrap cycles: no share inflation (rUSDY H-01 mitigation)
- Collateralization ratio accuracy across various rate combinations
- ERC-20 compliance with share-based math
- Pause full-freeze: wrap, unwrap, and transfer all revert while paused
- Role enforcement

*LitePSM:*
- mintOkuM / redeemOkuM: price-aware conversions via okuMPrice()
- mintUsdOku / redeemUsdOku: convenience functions
- redeemUsdOku: vault undercollateralized → revert (distinct from buffer-insufficient queue)
- Queue: OkuMoney appreciates in price while queued, USDC output based on okuMPrice() at processing
- Oracle staleness rejection
- Decimal conversion accuracy

*Bridge:*
- OkuBridge: valid signature mints tokens (not shares — standard ERC-20 amounts)
- OkuBridge: invalid/expired signature reverts
- OkuBridge: replay prevention
- OkuBridgeRouter: bridgeOkuM routes correctly (standard ERC-20 token amounts)
- OkuBridgeRouter: bridgeUsdOku unwraps then bridges
- OkuBridgeRouter: bridgeUsdOku reverts when vault undercollateralized
- OkuBridgeRouter: adapter path burns and delegates

---

## Key Invariants

```
// OkuMoney: standard ERC-20 (no shares, no multiplier in balanceOf)
balanceOf(user) == _balances[user]

// OkuMoney: okuMPrice never decreases
okuMPrice() >= previousOkuMPrice

// OkuMoney: supply cap respected
totalSupply() <= maxSupply

// OkuMoney: minter allowance only decreases (until admin reset)
newAllowance <= previousAllowance || caller == ALLOWANCE_MANAGER

// OkuDollar: share/token conversion
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION

// OkuDollar: collateralization floor (enforced on withdrawSurplus only)
afterWithdrawSurplus: collateralizationRatio() >= minCollateralRatio

// OkuDollar: collateralization is price-aware
collateralizationRatio = (okuMBalance × okuMPrice / PRECISION) × PRECISION / totalSupply

// OkuDollar: wrap/unwrap round-trip (max 1 unit rounding loss in OkuM terms)
unwrap(wrap(okuMAmount)) >= okuMAmount - 1

// OkuDollar: reserve accounting
totalOkuMReserves() == OkuMoney.balanceOf(address(okuDollarVault))

// OkuDollar: surplus is price-aware extractable overcollateralization
surplus() == max(0, (okuMReserves × okuMPrice / PRECISION) - totalUsdObligations) converted to OkuM tokens

// Queue integrity
queue.head <= queue.tail

// Yield distribution lock (sandwich prevention)
lastYieldDistributionBlock is set on distributeYield() and setOkuMPrice()
PSM and vault operations revert when block.number == lastYieldDistributionBlock
```