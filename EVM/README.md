# OkuUSD EVM Implementation

> See [`../README.md`](../README.md) for shared architecture, business logic, and RBAC design.

Solidity smart contracts for OkuUSD — a yield-bearing stablecoin backed 1:1 by US Treasury Bills.

## Stack

- **Language**: Solidity 0.8.28 / EVM Cancun
- **Framework**: Foundry (Forge, Cast, Anvil)
- **Dependencies**: OpenZeppelin Contracts v5 (Upgradeable)
- **Proxy Pattern**: TransparentUpgradeableProxy (token/PSM) / UUPS (bridge contracts)
- **Oracle**: Chainlink AggregatorV3Interface

## Contracts

| Contract | Description |
|----------|-------------|
| `OkuNote.sol` | Rebasing base token (rear-facing yield) |
| `OkuUSD.sol` | Rebasing stablecoin vault (independent forward-facing yield) |
| `LitePSM.sol` | Peg Stability Module — 1:1 USDC ↔ OkuNote + OkuUSD convenience functions |
| `OkuBridge.sol` | Native cross-chain bridge (burn/mint with EIP-712 orchestrator signatures) |
| `OkuBridgeRouter.sol` | User entry point for bridging OkuUSD and wOkuUSD |
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
    OkuNote.sol             # Rebasing base token (rear-facing yield)
    OkuUSD.sol              # Rebasing stablecoin vault (independent forward-facing yield)
  psm/
    LitePSM.sol             # USDC ↔ OkuNote swaps + OkuUSD convenience functions
  bridge/
    OkuBridge.sol           # Native cross-chain bridge (full burn/mint protocol)
    OkuBridgeRouter.sol     # Entry point: token normalization + bridge path selection
    adapters/
      IBridgeAdapter.sol    # Interface for third-party message-only adapters
      IOFTAdapter.sol       # LayerZero OFT interface
      INttManager.sol       # Wormhole NTT interface
      NttAdapter.sol        # Wormhole NTT adapter implementation
  mocks/
    MockBridgeAdapterHH.sol # Hardhat-compatible IBridgeAdapter mock
    MockNttManagerHH.sol    # Hardhat-compatible NTT Manager mock
test/
  OkuNote.t.sol
  OkuUSD.t.sol
  LitePSM.t.sol
  bridge/
    OkuBridge.t.sol
    OkuBridgeRouter.t.sol
  hardhat/
    bridge/
      OkuBridge.test.ts
      OkuBridgeRouter.test.ts
  invariants/
    VaultInvariants.t.sol
    SupplyInvariants.t.sol
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

## Bridge Architecture

The bridge system has a clear three-tier hierarchy:

```
OkuBridgeRouter          ← single user entry point; token normalization layer
  ├── native path        → OkuBridge.bridgeBurn() directly (no pre-burn by router)
  └── adapter path       → pre-burn → IBridgeAdapter.bridge() (message-only shims)

OkuBridge                ← full native protocol (source burn + destination mint)
  bridgeBurn()           ← burns from caller, collects fee, emits event for orchestrator
  bridgeMint()           ← destination: validate EIP-712 sig, mint shares

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
| Fee model | Oku-controlled (bps in shares) | Protocol-native |
| Recovery | skipNonce, refundFailedRequest | Protocol-native |
| Trust model | Oku orchestrator key | Wormhole Guardians / CCIP DON |

### Router Functions

```
bridge_OkuNote(amount, destChain, recipient)    — direct bridge of note shares
bridge_OkuUSD(amount, destChain, recipient)     — unwrap OkuUSD → notes → bridge notes
                                                   destination: mint notes → wrap → deliver OkuUSD
bridgeVia(amount, adapter, destChain, recipient) — note bridge via third-party adapter
bridgeWrappedVia(amount, adapter, destChain, recipient) — unwrap OkuUSD → adapter bridge
```

All four bridge functions are guarded with `nonReentrant` to prevent reentrant calls through external adapter contracts.

## OkuNote.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Base redeemable note with rear-facing yield. Balances stored as shares, displayed via a continuously accruing multiplier. Only distributes realized T-Bill returns.

### Storage

```solidity
mapping(address => uint256) private _shares;
uint256 private _totalShares;           // public getter: totalShares()
uint256 internal _baseMultiplier;       // last snapshot of multiplier (public getter: baseMultiplier())
uint256 public ratePerSecond;           // compound rate per second (1e18 = no yield)
uint256 public lastAccrualTime;         // timestamp of last _baseMultiplier snapshot
uint256 public rateEnd;                 // when current rate expires (0 = no expiry)
uint256 public pendingRatePerSecond;    // next rate, activates at rateEnd
uint256 public maxSupply;
mapping(address => uint256) public minterAllowance;
mapping(address => bool) public isBlacklisted;
```

### Continuous Yield Accrual

- `rewardMultiplier()` is a computed view function (not a storage variable)
- Yield accrues continuously via `_rpow(ratePerSecond, elapsed, PRECISION)` (MakerDAO DSS exponentiation by squaring)
- Handles rate expiry + pending rate crossover seamlessly in the view function
- `setYieldRate(rate, endTimestamp)` — NOTE_REBASER sets active rate, snapshots current multiplier
- `setNextYieldRate(rate)` — NOTE_REBASER schedules next rate (head-to-tail chaining)
- `updateRewardMultiplier(newMultiplier)` — Emergency override, snapshots computed multiplier, resets rate to zero
- External interface unchanged: `rewardMultiplier()` is now a public view function — same selector

### Rear-Facing Yield

The orchestrator feeds realized T-Bill returns (not projected). January's actual yield gets distributed as February's `ratePerSecond`. The contract does not know or care whether the rate is forward or rear-derived — this is purely an orchestrator-side operational choice. The note is always fully backed because it only distributes yield that has already been earned.

### Key Implementation Notes

- `balanceOf()` returns `_shares[user] * rewardMultiplier() / PRECISION`
- `transfer()` and `transferFrom()` operate on shares, not tokens
- `Transfer` event emits token amounts for ERC20 compatibility
- `_transferShares()` checks pause and blacklist status

### Role Constants

```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant OKUUSD_PAUSER = keccak256("OKUUSD_PAUSER");
bytes32 public constant OKUUSD_UNPAUSER = keccak256("OKUUSD_UNPAUSER");
bytes32 public constant MINTER = keccak256("MINTER");
bytes32 public constant NOTE_REBASER = keccak256("NOTE_REBASER");
bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");
```

**Critical**: `blacklist()` must NOT use `whenNotPaused` modifier.

**Blacklist-exempt addresses**: Bridge and router addresses can be marked exempt from blacklisting via `initializeBlacklistExempt(bridge, router)` (one-time, `DEFAULT_ADMIN_ROLE`). Prevents accidental blacklisting of infrastructure contracts that would break bridging. Storage: `blacklistExempt1`, `blacklistExempt2`, `_blacklistExemptInitialized`.

## OkuUSD.sol

**Inherits**: ERC20Upgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Concept**: Rebasing $1-pegged stablecoin with an independent yield rate. Holds OkuNotes as reserves. Has its own shares mapping and its own continuous multiplier, decoupled from the note's multiplier. This is NOT an ERC-4626 vault — it is a custom rebasing token with reserve management.

### Storage

```solidity
IOkuNote public okuNote;                    // reference to note contract

// USD rebasing mechanism (mirrors OkuNote pattern)
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

- `usdMultiplier()` is a computed view function — same `_rpow` pattern as OkuNote's `rewardMultiplier()`
- `balanceOf(user)` returns `_usdShares[user] * usdMultiplier() / PRECISION`
- `totalSupply()` returns `_totalUsdShares * usdMultiplier() / PRECISION`
- Transfers operate on USD shares internally, emit token amounts for ERC-20 compatibility
- Pause blocks peer-to-peer OkuUSD transfers only; wrap and unwrap always available

### Wrap/Unwrap

```solidity
// wrap: deposit notes, receive OkuUSD
// usdMinted = noteAmount × note.rewardMultiplier() / usdMultiplier()
function wrap(uint256 noteAmount) external returns (uint256 usdMinted);

// unwrap: burn OkuUSD, receive notes
// notesReturned = usdAmount × usdMultiplier() / note.rewardMultiplier()
// Reverts if vault holds insufficient notes
function unwrap(uint256 usdAmount) external returns (uint256 notesReturned);
```

Wrap pricing: 1 note worth $1.05 (note multiplier) wrapped when usdMultiplier = 1.00 produces 1.05 OkuUSD. The note's dollar value is converted to dollar-tokens at the current USD peg.

Unwrap pricing: the inverse calculation. Reverts if `OkuNote.balanceOf(address(this))` is insufficient to cover the proportional note redemption.

### Reserve Management (RESERVE_MANAGER)

```solidity
// Top up: deposit notes without minting OkuUSD shares
// Used when USD rate > note rate (vault undercollateralized)
// Amount is in note token units (which are dollar-denominated post-rebase)
function depositReserves(uint256 noteAmount) external onlyRole(RESERVE_MANAGER);

// Extract surplus: withdraw notes without burning OkuUSD shares
// Used when USD rate < note rate (vault overcollateralized)
// Amount is in note token units (dollar-denominated)
// MUST enforce: collateralizationRatio() >= minCollateralRatio AFTER withdrawal
function withdrawSurplus(uint256 noteAmount) external onlyRole(RESERVE_MANAGER);
```

Both functions accept note token amounts (dollar-denominated since OkuNote is rebasing). The collateralization ratio recalculates automatically on the next read since `totalNoteReserves()` is `OkuNote.balanceOf(address(this))`.

### Collateralization Views

```solidity
// Actual notes held (dollar-denominated, post-rebase)
function totalNoteReserves() public view returns (uint256);

// What the vault owes (dollar-denominated, same as totalSupply)
function totalUsdObligations() public view returns (uint256);

// reserves / obligations (1e18 scale, e.g. 1e18 = 100%)
function collateralizationRatio() public view returns (uint256);

// Surplus notes extractable (0 if undercollateralized)
function surplus() public view returns (uint256);
```

Collateralization ratio formula:
```
collateralizationRatio = OkuNote.balanceOf(address(this)) / totalSupply()
```

Both numerator and denominator are in dollar terms (note balance is post-rebase token amount, totalSupply is usdShares × usdMultiplier), so the ratio is dimensionless.

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

## LitePSM.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard, UUPSUpgradeable

Note: OZ v5 `ReentrancyGuard` is `@custom:stateless` (ERC-7201 namespaced storage slot). No `ReentrancyGuardUpgradeable` variant exists in this library version, and no `__ReentrancyGuard_init()` call is required.

**Concept**: 1:1 USDC ↔ OkuNote swaps with zero slippage. Queue handles insufficient buffer. Convenience functions route through the OkuUSD vault for single-transaction mint/redeem of the stablecoin.

### Core PSM Functions (Note ↔ USDC)

```solidity
function mint_OkuNote(uint256 usdcAmount) external;      // USDC → OkuNote at 1:1
function redeem_OkuNote(uint256 noteAmount) external;     // OkuNote → USDC at 1:1
```

### Convenience Functions (OkuUSD ↔ USDC via Vault)

```solidity
// USDC → mint note internally → wrap into vault → deliver OkuUSD to user
function mint_OkuUSD(uint256 usdcAmount) external;

// Receive OkuUSD → unwrap to notes → burn notes → deliver USDC to user
// Reverts if vault undercollateralized for the requested amount
function redeem_OkuUSD(uint256 usdAmount) external;

// Permit variant for single-tx UX
function redeem_OkuUSDWithPermit(uint256 usdAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
```

PSM has MINTER role on OkuNote. For `mint_OkuUSD`, the PSM mints note to self, approves vault, calls `vault.wrap(noteAmount)`, then transfers resulting OkuUSD to user. For `redeem_OkuUSD`, the PSM receives OkuUSD, calls `vault.unwrap(usdAmount)`, receives notes, then burns via normal redeem path.

**Storage, RBAC, queue, buffer management, oracle checks**: Unchanged from current implementation. Existing `mint()` / `redeem()` become `mint_OkuNote()` / `redeem_OkuNote()`.

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
// Same salt + same bytecode = same address on all EVM chains
bytes32 salt = keccak256("OkuNote-v1");
address deployed = deployer.deploy(salt, bytecode);
```

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

*OkuNote (same as current OkuUSD tests, renamed):*
- Mint/burn with allowance tracking
- Rebase affects all balances proportionally
- Continuous yield accrual: setYieldRate grows multiplier over time
- Continuous yield accrual: setNextYieldRate head-to-tail seamless transition
- Continuous yield accrual: front-running unprofitable (<$0.01 on $1M for 2s L2 block)
- Continuous yield accrual: APY accuracy (~4.5% over 365 days)
- Continuous yield accrual: emergency override snapshots + resets rate
- Continuous yield accrual: rate expiry stops yield with no pending rate
- Pause blocks operations, blacklist works while paused
- Role separation enforcement

*OkuUSD (new vault tests):*
- Wrap/unwrap round-trip accuracy (max 1 wei loss)
- Wrap pricing: noteAmount × noteMultiplier / usdMultiplier
- Unwrap pricing: inverse of wrap
- Independent USD multiplier grows via its own _rpow
- USD rate independent of note rate
- depositReserves increases collateralization ratio without minting shares
- withdrawSurplus decreases collateralization ratio without burning shares
- withdrawSurplus reverts if would breach minCollateralRatio
- withdrawSurplus succeeds when surplus exists and floor maintained
- Overcollateralized scenario: surplus() returns correct extractable amount
- Undercollateralized scenario: unwrap reverts when insufficient notes
- Pause blocks peer-to-peer OkuUSD transfers but allows wrap/unwrap
- Repeated wrap/unwrap cycles: no share inflation (rUSDY H-01 mitigation)
- Collateralization ratio accuracy across various rate combinations

*LitePSM (extended):*
- mint_OkuNote / redeem_OkuNote: same as current mint/redeem tests
- mint_OkuUSD: USDC → user receives OkuUSD in single tx
- redeem_OkuUSD: OkuUSD → user receives USDC in single tx
- redeem_OkuUSD reverts when vault undercollateralized
- Queue entry and processing (unchanged)
- Oracle staleness rejection (unchanged)

*Bridge (unchanged):*
- Bridge (OkuBridge): valid signature mints shares
- Bridge (OkuBridge): invalid/expired signature reverts
- Bridge (OkuBridge): replay prevention
- Bridge (OkuBridgeRouter): bridge_OkuNote routes correctly
- Bridge (OkuBridgeRouter): bridge_OkuUSD unwraps then bridges
- Bridge (OkuBridgeRouter): adapter path burns and delegates

## Key Invariants

```
// OkuNote: share/token conversion
balanceOf(user) == sharesOf(user) * rewardMultiplier / PRECISION

// OkuUSD: share/token conversion
balanceOf(user) == usdSharesOf(user) * usdMultiplier / PRECISION

// OkuNote: supply cap respected (except rebase)
totalSupply() <= maxSupply || lastOperationWasRebase

// OkuNote: minter allowance only decreases
newAllowance <= previousAllowance || caller == ALLOWANCE_MANAGER

// OkuUSD: collateralization floor
// (only enforced on withdrawSurplus, not on user operations)
afterWithdrawSurplus: collateralizationRatio() >= minCollateralRatio

// OkuUSD: wrap/unwrap round-trip (max 1 unit rounding loss)
unwrap(wrap(noteAmount)) >= noteAmount - 1 (in note terms)

// OkuUSD: reserve accounting
totalNoteReserves() == OkuNote.balanceOf(address(okuUsdVault))

// OkuUSD: surplus is extractable overcollateralization
surplus() == max(0, totalNoteReserves() - totalUsdObligations())

// Queue integrity
queue.head <= queue.tail
```
