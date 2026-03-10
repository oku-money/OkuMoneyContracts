# OkuUSD EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuUSD — a yield-bearing stablecoin backed by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil)
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy Pattern**: TransparentUpgradeableProxy (token/PSM) / UUPS (bridge contracts)
- **Oracle**: Chainlink AggregatorV3Interface

## Contracts

| Contract | Description |
|----------|-------------|
| `OkuNote.sol` | Non-rebasing base token — static balance, appreciating price via `notePrice()` |
| `OkuUSD.sol` | Rebasing $1-pegged stablecoin — growing balance, independent yield rate |
| `LitePSM.sol` | Peg Stability Module — price-aware USDC ↔ OkuNote + OkuUSD convenience functions |
| `OkuBridge.sol` | Native cross-chain bridge (burn/mint with EIP-712 orchestrator signatures) |
| `OkuBridgeRouter.sol` | User entry point for bridging OkuNote and OkuUSD |
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
forge test --match-contract OkuNoteTest -vv
forge test --match-contract OkuUSDTest -vv
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
    OkuNote.sol             # Non-rebasing base token (price appreciates via notePrice())
    OkuUSD.sol              # Rebasing stablecoin vault (independent yield rate, $1 peg)
  psm/
    LitePSM.sol             # USDC ↔ OkuNote (price-aware) + OkuUSD convenience functions
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
    IOkuNote.sol            # OkuNote interface
    IOkuUSD.sol             # OkuUSD vault interface
  mocks/
    MockBridgeAdapterHH.sol # Hardhat-compatible IBridgeAdapter mock
    MockNttManagerHH.sol    # Hardhat-compatible NTT Manager mock
test/
  token/
    OkuNote.t.sol
    OkuNote.fuzz.t.sol
    OkuUSD.t.sol
    OkuUSD.fuzz.t.sol
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
      OkuUSD.ts
  invariants/
    VaultInvariants.t.sol
    SupplyInvariants.t.sol
    ShareConversionInvariants.t.sol
    MinterAllowanceInvariants.t.sol
  handlers/
    OkuNoteHandler.sol
    OkuUSDHandler.sol
  Base.t.sol
script/
  Deploy.s.sol
```

## Dual-Token Split-Economy Model

OkuNote and OkuUSD have **independent yield rates** controlled by separate roles. This enables three operational modes:

```
USD rate > Note rate  →  Vault undercollateralized → Oku tops up (depositReserves)
USD rate = Note rate  →  Vault fully collateralized → No action needed
USD rate < Note rate  →  Vault overcollateralized  → Oku extracts revenue (withdrawSurplus)
```

The note is the solvency anchor (rear-facing, always backed). OkuUSD is a policy lever.

**Key distinction**: OkuNote is **non-rebasing** (standard ERC-20, price appreciates). OkuUSD is **rebasing** ($1-pegged, balance grows). This is NOT the same as the previous OkuUSD/wOkuUSD architecture where both tokens shared a single rate.

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
- Router unwraps OkuUSD to OkuNote if needed, then calls `OkuBridge.bridgeBurn()`
- OkuBridge (as MINTER on OkuNote) burns from the router, collects fee, increments nonce, emits `BridgeBurn`
- Orchestrator observes the event, waits for finality, signs a `BridgeRequest` (EIP-712)
- Anyone calls `OkuBridge.bridgeMint()` on destination with the signed request

**Adapter path** — Router is the burn authority:
- Router burns OkuNote itself, then calls `IBridgeAdapter.bridge()` (message-only)
- Adapter translates the call to the third-party protocol (Wormhole VAA, CCIP message, etc.)
- The third-party protocol handles destination minting natively (no OkuBridge.bridgeMint involved)

### Key Design Distinctions

| | Native (OkuBridge) | Third-party (NTT/CCIP) |
|---|---|---|
| Who burns on source | OkuBridge (called by router) | OkuBridgeRouter |
| Destination mint | OkuBridge.bridgeMint() + EIP-712 | Protocol-native |
| Fee model | Oku-controlled (bps in tokens) | Protocol-native |
| Recovery | skipNonce, refundFailedRequest | Protocol-native |
| Trust model | Oku orchestrator key | Wormhole Guardians / CCIP DON |

### Router Functions

```
bridge_OkuNote(amount, destChain, recipient)     — direct bridge of note tokens
bridge_OkuUSD(amount, destChain, recipient)      — unwrap OkuUSD → notes → bridge notes
                                                    destination: mint notes → wrap → deliver OkuUSD
bridgeVia(amount, adapter, destChain, recipient)  — note bridge via third-party adapter
bridgeWrappedVia(amount, adapter, destChain, recipient) — unwrap OkuUSD → adapter bridge
```

All four bridge functions are guarded with `nonReentrant` to prevent reentrant calls through external adapter contracts.

**DeFi & bridge compatibility**: Since OkuNote is a standard non-rebasing ERC-20, third-party bridges (LayerZero OFT, Wormhole NTT, CCIP) can handle it natively without share conversion.

---

## OkuNote.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Non-rebasing base token with rear-facing yield. Standard ERC-20 balances (static). Yield is expressed through price appreciation tracked by an internal `notePrice()` view function using `_rpow` continuous accrual. DeFi and bridge compatible out of the box.

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

`notePrice()` is a computed view function. Yield accrues continuously via `_rpow(ratePerSecond, elapsed, PRECISION)` (MakerDAO DSS exponentiation by squaring):

```
notePrice() = _basePrice × _rpow(ratePerSecond, elapsed, PRECISION) / PRECISION
```

The note starts at `notePrice() = 1e18` ($1.00). Over time, `notePrice()` grows as rear-facing T-Bill yield accrues. After one year at 4.5% APY, `notePrice()` returns ~1.045e18 ($1.045).

**Key difference from old design**: `balanceOf()` returns raw token count (standard ERC-20). It is NOT affected by `notePrice()`. Price appreciation is tracked separately for use by the PSM and vault.

### Rate Management

- `setYieldRate(rate, endTimestamp)` — NOTE_REBASER sets active rate with optional end time. Snapshots current price before switching.
- `setNextYieldRate(rate)` — NOTE_REBASER schedules next rate that activates when current expires (head-to-tail chaining, no tx needed at transition).
- `updateNotePrice(newPrice)` — Emergency override. Snapshots computed price, resets rate to zero yield.
- `notePrice()` — Computed view function. Handles current rate, expiry crossover, and pending rate seamlessly.
- `_rpow(x, n, b)` — Exponentiation by squaring (MakerDAO DSS, battle-tested since 2017).

**Rear-facing yield**: The orchestrator feeds realized T-Bill returns (not projected). January's actual yield gets distributed as February's `ratePerSecond`. The contract does not know or care whether the rate is forward or rear-derived — this is purely an orchestrator-side operational choice. The note is always fully backed because it only distributes yield that has already been earned.

### Key Implementation Notes

- `balanceOf()` returns standard ERC-20 balance (raw token count, not price-adjusted)
- `transfer()` and `transferFrom()` are standard ERC-20 (no share conversion)
- `notePrice()` is a view function for pricing — used by PSM and vault, not by balanceOf
- `mint()` creates raw tokens; minting 100 tokens when notePrice = $1.05 creates $105 of value
- The PSM handles USDC ↔ note conversion using `notePrice()`
- Blacklist and pause checks apply to transfers

### Role Constants

```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant NOTE_PAUSER = keccak256("NOTE_PAUSER");
bytes32 public constant NOTE_UNPAUSER = keccak256("NOTE_UNPAUSER");
bytes32 public constant MINTER = keccak256("MINTER");
bytes32 public constant NOTE_REBASER = keccak256("NOTE_REBASER");
bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");
```

**Critical**: `blacklist()` must NOT use `whenNotPaused` modifier.

**Blacklist-exempt addresses**: Bridge and router addresses can be marked exempt from blacklisting via `initializeBlacklistExempt(bridge, router)` (one-time, `DEFAULT_ADMIN_ROLE`). Prevents accidental blacklisting of infrastructure contracts that would break bridging.

---

## OkuUSD.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Rebasing $1-pegged stablecoin with an independent yield rate. Holds OkuNotes as reserves. Has its own USD shares mapping and its own continuous multiplier, decoupled from the note's price. This is NOT an ERC-4626 vault — it is a custom rebasing token with reserve management.

### Storage

```solidity
IOkuNote public okuNote;                    // reference to note contract

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

- `usdMultiplier()` is a computed view function — same `_rpow` pattern as OkuNote's `notePrice()`
- `balanceOf(user)` returns `_usdShares[user] * usdMultiplier() / PRECISION`
- `totalSupply()` returns `_totalUsdShares * usdMultiplier() / PRECISION`
- Transfers operate on USD shares internally, emit token amounts for ERC-20 compatibility
- Parent ERC20Upgradeable's `_balances` mapping is fully suppressed — all balance state is in `_usdShares`
- Pause blocks peer-to-peer OkuUSD transfers only; wrap and unwrap always available

### Wrap/Unwrap

```solidity
// wrap: deposit notes, receive OkuUSD (price-aware)
// usdMinted = noteAmount × notePrice() / usdMultiplier()
function wrap(uint256 noteAmount, address receiver) external returns (uint256 usdMinted);

// unwrap: burn OkuUSD, receive notes (price-aware)
// notesReturned = usdAmount × usdMultiplier() / notePrice()
// Reverts if vault holds insufficient notes
function unwrap(uint256 usdAmount, address receiver) external returns (uint256 notesReturned);
```

Wrap pricing: price-aware. 100 note tokens at notePrice = $1.05, usdMultiplier = 1.0 produces 105 OkuUSD. The note's dollar value (`noteAmount × notePrice()`) is converted to OkuUSD at the current usdMultiplier.

Unwrap pricing: price-aware inverse. 105 OkuUSD at usdMultiplier = 1.0, notePrice = $1.05 returns 100 note tokens. Reverts if `OkuNote.balanceOf(address(this))` is insufficient.

### Reserve Management (RESERVE_MANAGER)

```solidity
// Top up: deposit notes without minting OkuUSD shares
// Used when USD rate > note rate (vault undercollateralized)
function depositReserves(uint256 noteAmount) external onlyRole(RESERVE_MANAGER);

// Extract surplus: withdraw notes without burning OkuUSD shares
// Used when USD rate < note rate (vault overcollateralized)
// MUST enforce: collateralizationRatio() >= minCollateralRatio AFTER withdrawal
function withdrawSurplus(uint256 noteAmount) external onlyRole(RESERVE_MANAGER);
```

Both functions accept note token amounts. Since OkuNote is non-rebasing, note tokens are NOT dollar-denominated — their value depends on `notePrice()`. The collateralization ratio recalculates automatically on the next read.

### Collateralization Views

```solidity
function totalNoteReserves() public view returns (uint256);       // OkuNote.balanceOf(this)
function totalUsdObligations() public view returns (uint256);     // totalSupply()
function collateralizationRatio() public view returns (uint256);  // price-aware ratio
function surplus() public view returns (uint256);                 // extractable notes (0 if undercollateralized)
```

Collateralization ratio formula (price-aware):
```
collateralizationRatio = (OkuNote.balanceOf(this) × notePrice() / PRECISION) × PRECISION / totalSupply()
```

The numerator converts note token count to dollar value via `notePrice()`. The denominator (`totalSupply()`) is already in dollar terms (usdShares × usdMultiplier).

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

Same mechanics as OkuNote's rate management — snapshot before switching, head-to-tail chaining, `_rpow` continuous accrual. The rate is a policy decision set by Oku, independent of the note's rate.

### Role Constants

```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant USD_REBASER = keccak256("USD_REBASER");
bytes32 public constant RESERVE_MANAGER = keccak256("RESERVE_MANAGER");
bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");
```

### Operational Examples

Revenue extraction (USD rate < note rate):
```
Note rate: 4.5% APY (realized)
USD rate:  4.0% APY (policy — Oku retains 0.5% spread)
Over time: vault accumulates surplus notes
Oku calls: withdrawSurplus(surplusAmount)
Safety:    collateralizationRatio must remain >= minCollateralRatio after withdrawal
```

Forward-facing yield (USD rate > note rate):
```
Note rate: 4.0% APY (last period's realized)
USD rate:  4.5% APY (policy — streaming projected yield as a feature)
Over time: vault becomes slightly undercollateralized
Oku calls: depositReserves(gapAmount) to top up
```

---

## LitePSM.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard, UUPSUpgradeable

Note: OZ v5 `ReentrancyGuard` is `@custom:stateless` (ERC-7201 namespaced storage slot). No `ReentrancyGuardUpgradeable` variant exists in this library version, and no `__ReentrancyGuard_init()` call is required.

**Concept**: Price-aware USDC ↔ OkuNote swaps. Queue handles insufficient buffer. Convenience functions route through the OkuUSD vault for single-transaction mint/redeem of the stablecoin.

### Core PSM Functions (Note ↔ USDC — Price-Aware)

```solidity
// USDC → OkuNote: noteAmount = usdcValue × PRECISION / notePrice()
function mint_OkuNote(uint256 usdcAmount) external;

// OkuNote → USDC: usdcAmount = noteAmount × notePrice() / PRECISION (scaled to 6 decimals)
function redeem_OkuNote(uint256 noteAmount) external;
```

The PSM is no longer 1:1 in token terms. If `notePrice()` is $1.05, depositing 100 USDC gives ~95.24 notes. Redeeming 95.24 notes returns ~100 USDC. The PSM always transacts in dollar-value terms — the user thinks in USDC, the PSM handles the price conversion internally.

### Convenience Functions (OkuUSD ↔ USDC via Vault)

```solidity
// USDC → mint note internally → wrap into vault → deliver OkuUSD to user
function mint_OkuUSD(uint256 usdcAmount) external;

// Receive OkuUSD → unwrap to notes → burn notes → deliver USDC to user
// Two failure modes: (a) vault undercollateralized → unwrap reverts → entire tx reverts
//                    (b) vault has notes but PSM buffer insufficient → notes go to queue
function redeem_OkuUSD(uint256 usdAmount) external;

// Permit variant for single-tx UX
function redeem_OkuUSDWithPermit(uint256 usdAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
```

PSM has MINTER role on OkuNote. For `mint_OkuUSD`, the PSM mints note to self, approves vault, calls `vault.wrap(noteAmount, msg.sender)`. For `redeem_OkuUSD`, the PSM receives OkuUSD, calls `vault.unwrap(usdAmount, address(this))`, receives notes, then burns via normal price-aware redeem path.

### Queue Behavior

The redemption queue operates on OkuNote tokens. Since OkuNote is non-rebasing, queued note tokens do not grow in balance — but they appreciate in price via `notePrice()`. When the queue processes, the user receives USDC based on `noteAmount × notePrice()` at processing time. The economic result is the same as the old design (user earns yield while queued) but through price appreciation rather than balance growth.

---

## Proxy Deployment

Each contract deployed behind TransparentUpgradeableProxy:

```solidity
// Deploy implementation
OkuNote impl = new OkuNote();

// Deploy proxy
TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
    address(impl),
    proxyAdmin,
    abi.encodeCall(OkuNote.initialize, (admin, pauser, ...))
);
```

**ProxyAdmin ownership**: Cold Multisig (same entity with UPGRADER roles)

## Deterministic Deployment

Use CREATE2 via deterministic deployer for same addresses across chains:

```solidity
bytes32 salt = keccak256("OkuNote-v1");
address deployed = deployer.deploy(salt, bytecode);
```

---

## Testing

### Unit Tests (Forge)

```bash
forge test --match-contract OkuNoteTest
forge test --match-contract OkuUSDTest
```

### Invariant Tests (Forge)

```bash
forge test --match-contract VaultInvariants
forge test --match-contract SupplyInvariants
```

### Key Test Scenarios

*OkuNote (non-rebasing with price oracle):*
- Standard ERC-20: balanceOf returns raw balance, unaffected by notePrice
- notePrice starts at PRECISION ($1.00), grows with setYieldRate
- setNextYieldRate head-to-tail seamless transition
- notePrice emergency override via updateNotePrice
- Mint/burn with allowance tracking (raw token amounts, no shares)
- Blacklist, pause, supply cap
- Permit
- Role separation enforcement

*OkuUSD (rebasing vault):*
- Wrap: price-aware — noteAmount × notePrice / usdMultiplier = correct OkuUSD
- Unwrap: price-aware inverse, revert if insufficient reserves
- Wrap/unwrap round-trip accuracy at various notePrice/usdMultiplier combinations
- Independent USD multiplier grows via its own _rpow
- USD rate independent of note rate
- depositReserves increases collateralization ratio without minting shares
- withdrawSurplus extracts excess, enforces minCollateralRatio
- Overcollateralized / undercollateralized scenarios
- Pause blocks peer-to-peer OkuUSD transfers but allows wrap/unwrap
- Repeated wrap/unwrap cycles: no share inflation (rUSDY H-01 mitigation)
- ERC-20 compliance with share-based math
- Role enforcement

*LitePSM:*
- mint_OkuNote / redeem_OkuNote: price-aware conversions via notePrice()
- mint_OkuUSD / redeem_OkuUSD: convenience functions
- redeem_OkuUSD: vault undercollateralized → revert (distinct from buffer-insufficient queue)
- Queue: notes appreciate in price while queued, USDC output based on notePrice() at processing
- Oracle staleness rejection

*Bridge:*
- OkuBridge: valid signature mints tokens (not shares)
- OkuBridge: invalid/expired signature reverts
- OkuBridge: replay prevention
- OkuBridgeRouter: bridge_OkuNote routes correctly (standard ERC-20 token amounts)
- OkuBridgeRouter: bridge_OkuUSD unwraps then bridges
- OkuBridgeRouter: bridge_OkuUSD reverts when vault undercollateralized
- OkuBridgeRouter: adapter path burns and delegates

---

## Key Invariants

```
// OkuNote: standard ERC-20 (no shares, no multiplier in balanceOf)
balanceOf(user) == _balances[user]

// OkuNote: notePrice never decreases
notePrice() >= previousNotePrice

// OkuNote: supply cap respected
totalSupply() <= maxSupply

// OkuNote: minter allowance only decreases
newAllowance <= previousAllowance || caller == ALLOWANCE_MANAGER

// OkuUSD: share/token conversion
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION

// OkuUSD: collateralization floor (enforced on withdrawSurplus only)
afterWithdrawSurplus: collateralizationRatio() >= minCollateralRatio

// OkuUSD: collateralization is price-aware
collateralizationRatio = (noteBalance × notePrice / PRECISION) × PRECISION / totalSupply

// OkuUSD: wrap/unwrap round-trip (max 1 unit rounding loss in note terms)
unwrap(wrap(noteAmount)) >= noteAmount - 1

// OkuUSD: reserve accounting
totalNoteReserves() == OkuNote.balanceOf(address(okuUsdVault))

// OkuUSD: surplus is price-aware extractable overcollateralization
surplus() == max(0, (noteReserves × notePrice / PRECISION) - totalUsdObligations) converted to note tokens

// Queue integrity
queue.head <= queue.tail
```