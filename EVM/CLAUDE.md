# OkuUSD EVM Implementation

> See [`../CLAUDE.md`](../CLAUDE.md) for shared architecture, business logic, and RBAC design.

This document covers EVM-specific implementation details.

## Stack

- **Language**: Solidity 0.8.x
- **Framework**: Foundry (Forge, Cast, Anvil)
- **Dependencies**: OpenZeppelin Contracts (Upgradeable)
- **Proxy Pattern**: TransparentUpgradeableProxy
- **Oracle**: Chainlink AggregatorV3Interface

## Contract Structure

```
src/
  token/
    OkuUSD.sol              # Rebasing ERC20
    wOkuUSD.sol             # ERC-4626 vault
  psm/
    LitePSM.sol             # USDC ↔ OkuUSD swaps
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
  OkuUSD.t.sol
  wOkuUSD.t.sol
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
- Router redeems wOkuUSD if needed, then calls `OkuBridge.bridgeBurn()`
- OkuBridge (as MINTER on OkuUSD) burns from the router, collects fee, increments nonce, emits `BridgeBurn`
- Orchestrator observes the event, waits for finality, signs a `BridgeRequest` (EIP-712)
- Anyone calls `OkuBridge.bridgeMint()` on destination with the signed request

**Adapter path** — Router is the burn authority:
- Router burns OkuUSD itself, then calls `IBridgeAdapter.bridge()` (message-only)
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

## OkuUSD.sol

**Inherits**: ERC20Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Storage**:
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

**Continuous yield accrual**:
- `rewardMultiplier()` is a computed view function (not a storage variable)
- Yield accrues continuously via `_rpow(ratePerSecond, elapsed, PRECISION)` (MakerDAO DSS exponentiation by squaring)
- Handles rate expiry + pending rate crossover seamlessly in the view function
- `setYieldRate(rate, endTimestamp)` — REBASER sets active rate, snapshots current multiplier
- `setNextYieldRate(rate)` — REBASER schedules next rate (head-to-tail chaining)
- `updateRewardMultiplier()` — Emergency override, snapshots computed multiplier, resets rate to zero
- External interface unchanged: `rewardMultiplier()` was a public storage variable, now a public view function — same selector

**Key implementation notes**:
- `balanceOf()` returns `_shares[user] * rewardMultiplier() / PRECISION`
- `transfer()` and `transferFrom()` operate on shares, not tokens
- `Transfer` event emits token amounts for ERC20 compatibility
- `_transferShares()` checks pause and blacklist status

**Role bytes32 constants**:
```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant OKUUSD_PAUSER = keccak256("OKUUSD_PAUSER");
bytes32 public constant OKUUSD_UNPAUSER = keccak256("OKUUSD_UNPAUSER");
bytes32 public constant MINTER = keccak256("MINTER");
bytes32 public constant REBASER = keccak256("REBASER");
bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");
```

**Critical**: `blacklist()` must NOT use `whenNotPaused` modifier.

## wOkuUSD.sol

**Inherits**: ERC4626Upgradeable, AccessControlUpgradeable

**Standard**: Full ERC-4626 compliance

**Key implementation notes**:
- `asset()` returns OkuUSD address
- `totalAssets()` returns `okuUSD.balanceOf(address(this))`
- Exchange rate grows automatically as underlying OkuUSD rebases
- Rounding: Use `_convertToShares` with rounding down, `_convertToAssets` with rounding down (favor vault)
- No pause functionality—always available as exit path

**Role bytes32 constants**:
```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
```

## LitePSM.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard, UUPSUpgradeable

Note: OZ v5 `ReentrancyGuard` is `@custom:stateless` (ERC-7201 namespaced storage slot). No `ReentrancyGuardUpgradeable` variant exists in this library version, and no `__ReentrancyGuard_init()` call is required.

**Storage**:
```solidity
IOkuUSD public okuUsd;
IERC20 public usdc;
RedemptionQueue public redemptionQueue;   // external contract, not embedded queue
IAggregatorV3 public porOracle;
uint256 public stalenessThreshold;
bool public oracleEnabled;               // oracle checks require both oracleEnabled AND oracle != address(0)
```

**Key implementation notes**:
- `mint()`: USDC in → OkuUSD out (1:1), checks oracle if configured
- `redeem()`: OkuUSD in → USDC out (1:1) or queue if buffer insufficient
- `redeemWithPermit()`: Convenience wrapper using ERC20Permit — `redeemWithPermit(uint256 okuUsdAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`
- `processQueue()`: FIFO processing, calculates payout at current multiplier
- `configureOracle()`: Combined oracle configuration — `configureOracle(address _oracle, uint256 _stalenessThreshold, bool _enabled)`
- Oracle check: `porOracle.latestRoundData()`, verify `answeredInRound >= roundId` and freshness
- `redeem()` queue path: PSM calls `safeTransferFrom(user → PSM)`, then
  `safeTransfer(PSM → queue)`, then `redemptionQueue.enqueue()` (record-only, no token pull)
- `withdrawUsdc()` calls `redemptionQueue.totalQueuedUsdc()` and reverts with
  "Would strand queue" if `balance - amount < queueObligation`

**Role bytes32 constants**:
```solidity
bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
bytes32 public constant QUEUE_PROCESSOR = keccak256("QUEUE_PROCESSOR");
bytes32 public constant BUFFER_DEPOSITOR = keccak256("BUFFER_DEPOSITOR");
bytes32 public constant BUFFER_WITHDRAWER = keccak256("BUFFER_WITHDRAWER");
bytes32 public constant ORACLE_MANAGER = keccak256("ORACLE_MANAGER");
```

## RedemptionQueue.sol

**Inherits**: Initializable, AccessControlUpgradeable, UUPSUpgradeable

**Storage**:
```solidity
mapping(uint256 => QueueEntry) public queue;
uint256 public queueHead;
uint256 public queueTail;
IOkuUSD public okuUsd;
uint256 public totalQueuedShares;   // running counter for O(1) totalQueuedUsdc() calculation

struct QueueEntry {
    address user;
    uint256 shares;   // stored as shares so users earn yield while waiting
    uint256 timestamp;
}
```

**Key implementation notes**:
- Tokens arrive pre-funded by the PSM before `enqueue()` is called; `enqueue()` is record-only (no `transferFrom`)
- Stores shares, not token amounts, so users continue to earn yield while queued
- `totalQueuedUsdc()` sums outstanding USDC obligations for all queued entries; used by `LitePSM.withdrawUsdc()` to prevent stranding queued redemptions
- Called exclusively by LitePSM via the `PSM` role; users interact only through LitePSM

**Role bytes32 constants**:
```solidity
bytes32 public constant UPGRADER = keccak256("UPGRADER");
bytes32 public constant PSM = keccak256("PSM");
```

## OkuBridge.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard, EIP712Upgradeable

Note: OZ v5 `ReentrancyGuard` is `@custom:stateless` (ERC-7201 namespaced storage slot). No `ReentrancyGuardUpgradeable` variant exists, and no `__ReentrancyGuard_init()` call is required.

**Storage**:
```solidity
IOkuUSD public okuUsd;
address public authorizedSigner;
address public feeRecipient;
uint256 public bridgeFee;                                    // In basis points (10 = 0.1%)
uint256 public minBridgeShares;
uint256 public maxBridgeShares;
mapping(uint256 => bool) public supportedChains;             // destChainId => supported
mapping(uint256 => uint256) public outboundNonce;            // destChainId => nonce
mapping(bytes32 => bool) public processedRequests;           // requestId => processed
mapping(bytes32 => bool) public refundedRequests;           // requestId => refunded (replay prevention for refunds)
uint256 public bridgeDeadline;                              // configurable deadline duration (default 1 hour)
```

**EIP-712 Domain**: Initialized via `__EIP712_init("OkuBridge", "1")`. Domain separator is computed and cached by `EIP712Upgradeable` (OZ); not an explicit constant.

```solidity
// Only the struct typehash is a contract constant:
bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
    "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,address recipient,uint256 shares,uint256 nonce,uint256 deadline)"
);
```

**Key functions**:
```solidity
// Source chain: Burns `shares` from caller, deducts feeShares, emits netShares = shares - feeShares
// in BridgeRequest and BridgeBurn event (destination mints netShares to recipient)
function bridgeBurn(
    uint256 destChainId,
    address recipient,
    uint256 shares
) external whenNotPaused nonReentrant returns (bytes32 requestId);

// Destination chain: Mint shares with orchestrator signature
function bridgeMint(
    BridgeRequest calldata request,
    bytes calldata signature
) external nonReentrant;

// Admin: Skip stuck nonce
function skipNonce(uint256 destChainId) external onlyRole(BRIDGE_NONCE_ADMIN);

// Admin: Refund failed request
function refundFailedRequest(
    BridgeRequest calldata request,
    bytes calldata proof
) external onlyRole(BRIDGE_REFUND_ADMIN);

// Admin: Update deadline duration
function updateDeadline(uint256 newDeadline) external onlyRole(BRIDGE_LIMITS_MANAGER);
```

**Role bytes32 constants**:
```solidity
bytes32 public constant BRIDGE_SIGNER_MANAGER = keccak256("BRIDGE_SIGNER_MANAGER");
bytes32 public constant BRIDGE_PAUSER = keccak256("BRIDGE_PAUSER");
bytes32 public constant BRIDGE_UNPAUSER = keccak256("BRIDGE_UNPAUSER");
bytes32 public constant BRIDGE_FEE_MANAGER = keccak256("BRIDGE_FEE_MANAGER");
bytes32 public constant BRIDGE_NONCE_ADMIN = keccak256("BRIDGE_NONCE_ADMIN");
bytes32 public constant BRIDGE_CHAIN_MANAGER = keccak256("BRIDGE_CHAIN_MANAGER");
bytes32 public constant BRIDGE_LIMITS_MANAGER = keccak256("BRIDGE_LIMITS_MANAGER");
bytes32 public constant BRIDGE_REFUND_ADMIN = keccak256("BRIDGE_REFUND_ADMIN");
bytes32 public constant BRIDGE_UPGRADER = keccak256("BRIDGE_UPGRADER");
```

**Signature verification**:
```solidity
function _verifySignature(BridgeRequest calldata request, bytes calldata signature) internal view {
    bytes32 structHash = keccak256(abi.encode(
        BRIDGE_REQUEST_TYPEHASH,
        request.sourceChainId,
        request.destChainId,
        request.sender,
        request.recipient,
        request.shares,
        request.nonce,
        request.deadline
    ));
    bytes32 digest = _hashTypedDataV4(structHash);
    address signer = ECDSA.recover(digest, signature);
    require(signer == authorizedSigner, "Invalid signature");
    require(block.timestamp <= request.deadline, "Signature expired");
}
```

## OkuBridgeRouter.sol

**Inherits**: Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Entry point** for all user-facing bridging. Handles token normalization (wOkuUSD → OkuUSD)
and routes to either the native OkuBridge or a registered third-party adapter.

**Storage**:
```solidity
IwOkuUSD public wOkuUsd;
IOkuUSD public okuUsd;
IOkuBridgeNative public okuBridge;               // Native bridge (direct call, no pre-burn)
mapping(address => bool) public supportedAdapters; // Registered IBridgeAdapter shims
```

**Native path** — OkuBridge owns the burn:
```solidity
// wOkuUSD → redeem → tokensToShares → OkuBridge.bridgeBurn()
function bridgeWrapped(uint256 wOkuUsdAmount, uint256 destinationChain, address recipient)
    external whenNotPaused returns (bytes32 requestId);

// OkuUSD → tokensToShares → OkuBridge.bridgeBurn()
function bridgeDirect(uint256 okuUsdAmount, uint256 destinationChain, address recipient)
    external whenNotPaused returns (bytes32 requestId);
```

**Subtractive fee model**: The router passes `totalShares` directly to `OkuBridge.bridgeBurn()`.
OkuBridge burns `totalShares` from the router, computes `feeShares = totalShares * bridgeFee / 10000`,
and emits `netShares = totalShares - feeShares` as the bridge amount (encoded in the `BridgeRequest`
and minted to the recipient on destination). The fee comes out of the user's input (not charged on
top). No dust remains in the router.

**Adapter path** — Router pre-burns, then calls message-only adapter:
```solidity
// wOkuUSD → redeem → burn → IBridgeAdapter.bridge() (no return — adapter path has no OkuBridge request)
function bridgeWrappedVia(uint256 wOkuUsdAmount, address adapter, uint256 destinationChain, address recipient)
    external whenNotPaused;

// OkuUSD → burn → IBridgeAdapter.bridge() (no return — adapter path has no OkuBridge request)
function bridgeDirectVia(uint256 okuUsdAmount, address adapter, uint256 destinationChain, address recipient)
    external whenNotPaused;
```

**Role bytes32 constants**:
```solidity
bytes32 public constant ROUTER_UPGRADER = keccak256("ROUTER_UPGRADER");
bytes32 public constant ROUTER_PAUSER = keccak256("ROUTER_PAUSER");
bytes32 public constant ROUTER_UNPAUSER = keccak256("ROUTER_UNPAUSER");
bytes32 public constant ADAPTER_MANAGER = keccak256("ADAPTER_MANAGER");
bytes32 public constant BRIDGE_MANAGER = keccak256("BRIDGE_MANAGER");
```

**MINTER role requirements**:
- `OkuBridge` must hold `MINTER` role on OkuUSD (burns from router in native path, mints fees)
- `OkuBridgeRouter` must hold `MINTER` role on OkuUSD (burns in adapter path)

**Custom errors**:
```solidity
error UnsupportedAdapter(address adapter);
error InvalidRecipient();
error ZeroAddress();
```

**Events**:
```solidity
// Emitted on adapter path
event BridgeInitiated(address indexed user, address indexed adapter, uint256 amount, uint256 destinationChain, address recipient);
// Emitted on native path
event NativeBridgeInitiated(address indexed user, bytes32 indexed requestId, uint256 amount, uint256 destinationChain, address recipient);
```

## Proxy Deployment

Each contract deployed behind TransparentUpgradeableProxy:

```solidity
// Deploy implementation
OkuUSD impl = new OkuUSD();

// Deploy proxy
TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
    address(impl),
    proxyAdmin,
    abi.encodeCall(OkuUSD.initialize, (admin, pauser, ...))
);
```

**ProxyAdmin ownership**: Cold Multisig (same entity with UPGRADER roles)

## Deterministic Deployment

Use CREATE2 via deterministic deployer for same addresses across chains:

```solidity
// Same salt + same bytecode = same address on all EVM chains
bytes32 salt = keccak256("OkuUSD-v1");
address deployed = deployer.deploy(salt, bytecode);
```

## Testing

**Unit tests** (Forge):
```bash
forge test --match-contract OkuUSDTest
```

**Invariant tests** (Forge):
```bash
forge test --match-contract VaultInvariants
```

**Key test scenarios**:
- Mint/burn with allowance tracking
- Rebase affects all balances proportionally
- Continuous yield accrual: setYieldRate grows multiplier over time
- Continuous yield accrual: setNextYieldRate head-to-tail seamless transition
- Continuous yield accrual: front-running unprofitable (<$0.01 on $1M for 2s L2 block)
- Continuous yield accrual: APY accuracy (~4.5% over 365 days)
- Continuous yield accrual: emergency override snapshots + resets rate
- Continuous yield accrual: rate expiry stops yield with no pending rate
- Wrap/unwrap round-trip accuracy
- Queue entry and processing
- Pause blocks operations, blacklist works while paused
- Oracle staleness rejection
- Role separation enforcement
- Bridge (OkuBridge): valid signature mints shares
- Bridge (OkuBridge): invalid/expired signature reverts
- Bridge (OkuBridge): replay prevention (same requestId rejected)
- Bridge (OkuBridge): nonce sequencing enforced
- Bridge (OkuBridge): fee collection and refund mechanics
- Bridge (OkuBridge): unsupported chain rejection
- Router native path: wOkuUSD → OkuBridge.bridgeBurn() (OkuBridge burns, router retains zero balance)
- Router native path: totalShares passed directly; OkuBridge applies subtractive fee and emits netShares
- Router native path: fee collected by OkuBridge, not by router
- Router adapter path: OkuUSD burned by router, then IBridgeAdapter.bridge() called (message-only)
- Router adapter path: unsupported adapter reverts
- Router: both paths revert when paused

## Gas Optimization Notes

- Store shares, not balances (one SLOAD for balance calculation)
- Use unchecked math where overflow impossible
- Batch queue processing with gas limit parameter
- Consider ERC20Permit for gasless approvals

## Events

```solidity
// OkuUSD
event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
event YieldRateUpdated(uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotMultiplier);
event NextYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
event Blacklisted(address indexed account);
event Unblacklisted(address indexed account);
event MaxSupplyUpdated(uint256 oldCap, uint256 newCap);
event MinterAllowanceUpdated(address indexed minter, uint256 oldAllowance, uint256 newAllowance);

// LitePSM
event Mint(address indexed user, uint256 usdcAmount, uint256 okusdAmount);
event Redeem(address indexed user, uint256 okuUsdIn, uint256 usdcOut);
event OracleConfigured(address indexed oracle, uint256 stalenessThreshold, bool enabled);
event BufferRefilled(uint256 amount);
event BufferDeposited(address indexed depositor, uint256 amount);

// RedemptionQueue
event RedemptionQueued(address indexed user, uint256 shares, uint256 okuUsdAmount, uint256 position);
event RedemptionProcessed(address indexed user, uint256 shares, uint256 okuUsdAmount, uint256 usdcAmount);

// OkuBridge
event BridgeBurn(
    bytes32 indexed requestId,
    address indexed sender,
    address indexed recipient,
    uint256 sourceChainId,
    uint256 destChainId,
    uint256 shares,
    uint256 nonce,
    uint256 deadline
);
event BridgeMint(
    bytes32 indexed requestId,
    address indexed recipient,
    uint256 sourceChainId,
    uint256 shares
);
event SignerUpdated(address oldSigner, address newSigner);
event FeeUpdated(uint256 oldFee, uint256 newFee);
event ChainAdded(uint256 chainId);
event ChainRemoved(uint256 chainId);
event NonceSkipped(uint256 destChainId, uint256 skippedNonce);
event RefundProcessed(bytes32 indexed requestId, address indexed recipient, uint256 shares);

// OkuBridgeRouter
event BridgeInitiated(address indexed user, address indexed adapter, uint256 amount, uint256 destinationChain, address recipient);  // adapter path
event NativeBridgeInitiated(address indexed user, bytes32 indexed requestId, uint256 amount, uint256 destinationChain, address recipient);  // native path
event AdapterConfigured(address indexed adapter, bool supported);
event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);
```

## Dependencies

```toml
# foundry.toml
[dependencies]
openzeppelin-contracts-upgradeable = "5.0.0"
```

```bash
forge install OpenZeppelin/openzeppelin-contracts-upgradeable
```