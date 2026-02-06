# OkuUSD EVM Implementation

> See `CLAUDE.md` for architecture, business logic, and RBAC design.

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
    OkuBridge.sol           # Cross-chain bridge (burn/mint)
    OkuBridgeRouter.sol     # Convenience wrapper for wOkuUSD bridging
test/
  OkuUSD.t.sol
  wOkuUSD.t.sol
  LitePSM.t.sol
  OkuBridge.t.sol
  invariants/
    VaultInvariants.t.sol
    SupplyInvariants.t.sol
script/
  Deploy.s.sol
```

## OkuUSD.sol

**Inherits**: ERC20Upgradeable, AccessControlUpgradeable, PausableUpgradeable

**Storage**:
```solidity
mapping(address => uint256) private _shares;
uint256 public totalShares;
uint256 public rewardMultiplier;  // Scaled by PRECISION (1e18)
uint256 public maxSupply;
mapping(address => uint256) public minterAllowance;
mapping(address => bool) public blacklisted;
```

**Key implementation notes**:
- `balanceOf()` returns `_shares[user] * rewardMultiplier / PRECISION`
- `transfer()` and `transferFrom()` operate on shares, not tokens
- `Transfer` event emits token amounts for ERC20 compatibility
- `_beforeTokenTransfer` checks pause and blacklist status

**Role bytes32 constants**:
```solidity
bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
bytes32 public constant REBASER_ROLE = keccak256("REBASER_ROLE");
bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");
bytes32 public constant UNBLACKLISTER_ROLE = keccak256("UNBLACKLISTER_ROLE");
bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
bytes32 public constant ALLOWANCE_MANAGER_ROLE = keccak256("ALLOWANCE_MANAGER_ROLE");
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
bytes32 public constant WOKUSD_UPGRADER_ROLE = keccak256("WOKUSD_UPGRADER_ROLE");
```

## LitePSM.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable

**Storage**:
```solidity
IERC20 public usdc;
IOkuUSD public okuUSD;
AggregatorV3Interface public oracle;
uint256 public stalenessThreshold;
uint256 public queueHead;
uint256 public queueTail;
mapping(uint256 => QueueEntry) public redemptionQueue;

struct QueueEntry {
    address user;
    uint256 shares;
    uint256 timestamp;
}
```

**Key implementation notes**:
- `mint()`: USDC in → OkuUSD out (1:1), checks oracle if configured
- `redeem()`: OkuUSD in → USDC out (1:1) or queue if buffer insufficient
- `processQueue()`: FIFO processing, calculates payout at current multiplier
- Oracle check: `oracle.latestRoundData()`, verify `answeredInRound >= roundId` and freshness

**Role bytes32 constants**:
```solidity
bytes32 public constant PSM_PAUSER_ROLE = keccak256("PSM_PAUSER_ROLE");
bytes32 public constant PSM_UNPAUSER_ROLE = keccak256("PSM_UNPAUSER_ROLE");
bytes32 public constant QUEUE_PROCESSOR_ROLE = keccak256("QUEUE_PROCESSOR_ROLE");
bytes32 public constant BUFFER_DEPOSITOR_ROLE = keccak256("BUFFER_DEPOSITOR_ROLE");
bytes32 public constant BUFFER_WITHDRAWER_ROLE = keccak256("BUFFER_WITHDRAWER_ROLE");
bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");
```

## OkuBridge.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable

**Storage**:
```solidity
IOkuUSD public okuUSD;
address public authorizedSigner;
address public feeRecipient;
uint256 public bridgeFee;                                    // In shares
uint256 public minBridgeShares;
uint256 public maxBridgeShares;
mapping(uint256 => bool) public supportedChains;             // destChainId => supported
mapping(uint256 => uint256) public outboundNonce;            // destChainId => nonce
mapping(bytes32 => bool) public processedRequests;           // requestId => processed
```

**EIP-712 Domain**:
```solidity
bytes32 public constant DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
);
bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
    "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,address recipient,uint256 shares,uint256 nonce,uint256 deadline)"
);
```

**Key functions**:
```solidity
// Source chain: User burns shares to initiate bridge
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
function skipNonce(uint256 destChainId) external onlyRole(BRIDGE_NONCE_ADMIN_ROLE);

// Admin: Refund failed request
function refundFailedRequest(
    BridgeRequest calldata request,
    bytes calldata proof
) external onlyRole(BRIDGE_REFUND_ADMIN_ROLE);
```

**Role bytes32 constants**:
```solidity
bytes32 public constant BRIDGE_SIGNER_MANAGER_ROLE = keccak256("BRIDGE_SIGNER_MANAGER_ROLE");
bytes32 public constant BRIDGE_PAUSER_ROLE = keccak256("BRIDGE_PAUSER_ROLE");
bytes32 public constant BRIDGE_UNPAUSER_ROLE = keccak256("BRIDGE_UNPAUSER_ROLE");
bytes32 public constant BRIDGE_FEE_MANAGER_ROLE = keccak256("BRIDGE_FEE_MANAGER_ROLE");
bytes32 public constant BRIDGE_NONCE_ADMIN_ROLE = keccak256("BRIDGE_NONCE_ADMIN_ROLE");
bytes32 public constant BRIDGE_CHAIN_MANAGER_ROLE = keccak256("BRIDGE_CHAIN_MANAGER_ROLE");
bytes32 public constant BRIDGE_LIMITS_MANAGER_ROLE = keccak256("BRIDGE_LIMITS_MANAGER_ROLE");
bytes32 public constant BRIDGE_REFUND_ADMIN_ROLE = keccak256("BRIDGE_REFUND_ADMIN_ROLE");
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

**Inherits**: ReentrancyGuardUpgradeable (no access control needed)

**Stateless convenience wrapper** for bridging wOkuUSD:

```solidity
function bridgeWrapped(
    uint256 destChainId,
    address recipient,
    uint256 wokusdShares
) external nonReentrant returns (bytes32 requestId) {
    // 1. Transfer wOkuUSD from user
    wOkuUSD.transferFrom(msg.sender, address(this), wokusdShares);
    
    // 2. Redeem wOkuUSD for OkuUSD
    uint256 okusdShares = wOkuUSD.redeem(wokusdShares, address(this), address(this));
    
    // 3. Approve and call bridge
    okuUSD.approve(address(bridge), okusdShares);
    requestId = bridge.bridgeBurn(destChainId, recipient, okusdShares);
}
```

No privileged roles — purely a helper contract.

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
- Wrap/unwrap round-trip accuracy
- Queue entry and processing
- Pause blocks operations, blacklist works while paused
- Oracle staleness rejection
- Role separation enforcement
- Bridge: valid signature mints shares
- Bridge: invalid/expired signature reverts
- Bridge: replay prevention (same requestId rejected)
- Bridge: nonce sequencing enforced
- Bridge: fee collection and refund mechanics
- Bridge: unsupported chain rejection

## Gas Optimization Notes

- Store shares, not balances (one SLOAD for balance calculation)
- Use unchecked math where overflow impossible
- Batch queue processing with gas limit parameter
- Consider ERC20Permit for gasless approvals

## Events

```solidity
// OkuUSD
event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
event Blacklisted(address indexed account);
event Unblacklisted(address indexed account);
event MaxSupplyUpdated(uint256 oldCap, uint256 newCap);
event MinterAllowanceUpdated(address indexed minter, uint256 oldAllowance, uint256 newAllowance);

// LitePSM
event Mint(address indexed user, uint256 usdcAmount, uint256 okusdAmount);
event Redeem(address indexed user, uint256 okusdAmount, uint256 usdcAmount);
event RedemptionQueued(address indexed user, uint256 shares, uint256 queuePosition);
event RedemptionProcessed(address indexed user, uint256 shares, uint256 usdcAmount);
event OracleUpdated(address oldOracle, address newOracle);

// OkuBridge
event BridgeBurn(
    bytes32 indexed requestId,
    address indexed sender,
    address indexed recipient,
    uint256 sourceChainId,
    uint256 destChainId,
    uint256 shares,
    uint256 nonce
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