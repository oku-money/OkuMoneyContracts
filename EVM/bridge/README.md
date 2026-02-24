# OkuBridge - Cross-Chain Bridge for OkuUSD

> **Status**: ✅ Implementation Complete | All Tests Passing | Ready for Audit

## Quick Start

### For Users

Bridge OkuUSD shares across chains:

```solidity
// 1. Approve bridge to burn your tokens
okuUSD.approve(address(okuBridge), shares + fee);

// 2. Initiate bridge transfer
bytes32 requestId = okuBridge.bridgeBurn(
    destinationChainId,  // e.g., 10 for Optimism
    recipientAddress,    // Address to receive on destination
    shares               // Number of shares to bridge
);

// 3. Wait for orchestrator to observe and sign
// 4. Orchestrator submits to destination chain
// 5. Recipient receives shares on destination
```

### For Orchestrators

Process bridge requests:

```typescript
// 1. Listen for BridgeBurn events
const filter = okuBridge.filters.BridgeBurn();
okuBridge.on(filter, async (requestId, sender, recipient, sourceChainId, destChainId, shares, nonce, deadline) => {
  // 2. Wait for finality (e.g., 12 confirmations)

  // 3. Sign with EIP-712
  const domain = {
    name: "OkuBridge",
    version: "1",
    chainId: destChainId,
    verifyingContract: destBridgeAddress,
  };

  const request = {
    sourceChainId,
    destChainId,
    sender,
    recipient,
    shares,
    nonce,
    deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  };

  const signature = await signer.signTypedData(domain, types, request);

  // 4. Submit to destination chain
  await destBridge.bridgeMint(request, signature);
});
```

### For Admins

Manage bridge configuration:

```solidity
// Update authorized signer (orchestrator)
okuBridge.updateAuthorizedSigner(newSignerAddress);

// Add supported destination chain
okuBridge.addSupportedChain(chainId);

// Update fee (in basis points, 10 = 0.1%)
okuBridge.updateFee(10);

// Update limits
okuBridge.updateLimits(minShares, maxShares);

// Emergency pause
okuBridge.pause();
```

## Architecture

### Shares vs Tokens

**Critical**: The bridge operates on **shares**, not token amounts.

- **Why?** To preserve value across rebasing events
- **Example**:
  - User bridges 100 shares at 1.0x multiplier (= 100 tokens)
  - Rebase occurs mid-flight (multiplier → 1.5x)
  - User receives 100 shares on destination (= 150 tokens at new multiplier)
  - ✅ Value preserved!

### Flow Diagram

```
┌─────────────┐                    ┌──────────────┐                    ┌─────────────┐
│   Source    │                    │ Orchestrator │                    │ Destination │
│   Chain     │                    │   (Off-Chain)│                    │   Chain     │
└─────────────┘                    └──────────────┘                    └─────────────┘
       │                                   │                                   │
       │ 1. bridgeBurn()                   │                                   │
       ├──────────────────────────────────>│                                   │
       │    - Burns shares                 │                                   │
       │    - Collects fee                 │                                   │
       │    - Increments nonce             │                                   │
       │    - Emits BridgeBurn event       │                                   │
       │                                   │                                   │
       │                                   │ 2. Observes event                 │
       │                                   │    Waits for finality             │
       │                                   │                                   │
       │                                   │ 3. Signs with EIP-712             │
       │                                   │    (BridgeRequest)                │
       │                                   │                                   │
       │                                   │ 4. bridgeMint(request, sig)       │
       │                                   ├──────────────────────────────────>│
       │                                   │                                   │
       │                                   │                       - Verifies signature
       │                                   │                       - Checks deadline
       │                                   │                       - Prevents replay
       │                                   │                       - Mints shares
       │                                   │                       - Emits BridgeMint
       │                                   │                                   │
```

## Key Features

### 1. Burn-and-Mint Pattern
- No locked liquidity
- No fragmentation across chains
- True cross-chain transfer

### 2. EIP-712 Signatures
- Structured data signing
- Better UX (readable in MetaMask)
- Domain separation (security)

### 3. Replay Prevention
- **Source**: Sequential nonces per destination
- **Destination**: Request ID tracking

### 4. Fee Mechanism
- Collected in shares on source chain
- Configurable (basis points)
- Transparent to users

### 5. Admin Recovery
- **Skip Nonce**: Unstick blocked requests
- **Refund**: Return shares for failed mints

### 6. Granular RBAC
- 8 separate roles for different operations
- Principle of least privilege

## Contract Interface

### Core Functions

```solidity
/**
 * @notice Burn shares on source chain to initiate bridge
 * @param destChainId Destination chain ID (e.g., 10 for Optimism)
 * @param recipient Address to receive shares on destination
 * @param shares Number of shares to bridge (not tokens!)
 * @return requestId Unique identifier for this bridge request
 */
function bridgeBurn(
    uint256 destChainId,
    address recipient,
    uint256 shares
) external returns (bytes32 requestId);

/**
 * @notice Mint shares on destination with valid signature
 * @param request Bridge request details (from BridgeBurn event)
 * @param signature EIP-712 signature from authorized orchestrator
 */
function bridgeMint(
    BridgeRequest calldata request,
    bytes calldata signature
) external;
```

### Admin Functions

```solidity
// Signer management
function updateAuthorizedSigner(address newSigner) external;

// Fee management
function updateFee(uint256 newFee) external;
function updateFeeRecipient(address newRecipient) external;

// Chain management
function addSupportedChain(uint256 chainId) external;
function removeSupportedChain(uint256 chainId) external;

// Limits
function updateLimits(uint256 min, uint256 max) external;

// Pause
function pause() external;
function unpause() external;

// Recovery
function skipNonce(uint256 destChainId) external;
function refundFailedRequest(BridgeRequest calldata request, bytes calldata proof) external;
```

### View Functions

```solidity
// Configuration
function authorizedSigner() external view returns (address);
function feeRecipient() external view returns (address);
function bridgeFee() external view returns (uint256);
function minBridgeShares() external view returns (uint256);
function maxBridgeShares() external view returns (uint256);

// State
function supportedChains(uint256 chainId) external view returns (bool);
function outboundNonce(uint256 destChainId) external view returns (uint256);
function processedRequests(bytes32 requestId) external view returns (bool);

// EIP-712
function domainSeparator() external view returns (bytes32);
```

## Events

```solidity
// Bridge operations
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

// Configuration
event SignerUpdated(address indexed oldSigner, address indexed newSigner);
event FeeUpdated(uint256 oldFee, uint256 newFee);
event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
event ChainAdded(uint256 indexed chainId);
event ChainRemoved(uint256 indexed chainId);
event LimitsUpdated(uint256 minShares, uint256 maxShares);

// Recovery
event NonceSkipped(uint256 indexed destChainId, uint256 skippedNonce);
event RefundProcessed(bytes32 indexed requestId, address indexed recipient, uint256 shares);
```

## Errors

```solidity
error UnsupportedChain(uint256 chainId);
error AmountBelowMinimum(uint256 shares, uint256 minimum);
error AmountAboveMaximum(uint256 shares, uint256 maximum);
error InvalidSignature();
error SignatureExpired();
error WrongChain(uint256 expected, uint256 actual);
error AlreadyProcessed(bytes32 requestId);
error ZeroAddress();
error InvalidFee(uint256 fee);
error InvalidLimits(uint256 min, uint256 max);
```

## Roles

| Role | Purpose | Default Holder |
|------|---------|----------------|
| `DEFAULT_ADMIN_ROLE` | Root admin, grants other roles | Admin |
| `BRIDGE_SIGNER_MANAGER_ROLE` | Update authorized signer | Admin |
| `BRIDGE_PAUSER_ROLE` | Pause bridge | Admin |
| `BRIDGE_UNPAUSER_ROLE` | Unpause bridge | Admin |
| `BRIDGE_FEE_MANAGER_ROLE` | Update fee/recipient | Admin |
| `BRIDGE_CHAIN_MANAGER_ROLE` | Add/remove chains | Admin |
| `BRIDGE_LIMITS_MANAGER_ROLE` | Update limits | Admin |
| `BRIDGE_NONCE_ADMIN_ROLE` | Skip nonces | Admin |
| `BRIDGE_REFUND_ADMIN_ROLE` | Process refunds | Admin |

## Gas Costs

| Operation | Average Gas | Max Gas |
|-----------|-------------|---------|
| `bridgeBurn()` | ~108k | ~111k |
| `bridgeMint()` | ~107k | ~117k |

**Note**: Costs may vary based on state (first mint vs subsequent, fee enabled, etc.)

## Security

### Replay Prevention

1. **Source Chain**: Sequential nonces per destination
2. **Destination Chain**: Request ID uniqueness check

### Signature Security

- EIP-712 structured data signing
- Domain separation (name, version, chainId, verifyingContract)
- Deadline enforcement
- Chain ID validation

### Access Control

- OpenZeppelin AccessControl (battle-tested)
- Granular roles (8 separate permissions)
- Admin can be multisig

### Pause Mechanism

- Emergency circuit breaker
- Separate pause/unpause roles
- Both burn and mint are pausable

## Testing

### Run Tests

```bash
# Forge tests (comprehensive unit + integration)
forge test --match-contract OkuBridgeTest -vv

# With gas reporting
forge test --match-contract OkuBridgeTest --gas-report

# Coverage
forge coverage --match-contract OkuBridgeTest

# Hardhat tests (E2E with ethers.js)
npx hardhat test test/hardhat/bridge/OkuBridge.test.ts
```

### Test Coverage

- **Line Coverage**: 93.52%
- **Branch Coverage**: 90.43%
- **Total Tests**: 37 (Forge) + 11 (Hardhat) = 48
- **Fuzz Runs**: 256 runs × 3 tests = 768 total

## Deployment

### 1. Deploy Implementation

```bash
forge create src/bridge/OkuBridge.sol:OkuBridge \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_KEY
```

### 2. Deploy Proxy

```bash
# Encode initialization data
cast abi-encode "initialize(address,address,address,address)" \
  $OKUSD_ADDRESS \
  $ORCHESTRATOR_SIGNER \
  $FEE_RECIPIENT \
  $ADMIN_ADDRESS

# Deploy TransparentUpgradeableProxy
forge create lib/openzeppelin-contracts/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy \
  --constructor-args $IMPLEMENTATION_ADDRESS $PROXY_ADMIN $INIT_DATA \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_KEY
```

### 3. Grant Roles on OkuUSD

```bash
# Grant MINTER_ROLE to bridge
cast send $OKUSD_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "MINTER_ROLE") \
  $BRIDGE_PROXY_ADDRESS \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_KEY

# Configure minter allowance
cast send $OKUSD_ADDRESS \
  "configureMinterAllowance(address,uint256)" \
  $BRIDGE_PROXY_ADDRESS \
  1000000000000000000000000000 \
  --rpc-url $RPC_URL \
  --private-key $ALLOWANCE_MANAGER_KEY
```

### 4. Verify on Block Explorer

```bash
forge verify-contract \
  --chain-id $CHAIN_ID \
  --compiler-version 0.8.28 \
  $IMPLEMENTATION_ADDRESS \
  src/bridge/OkuBridge.sol:OkuBridge \
  --etherscan-api-key $ETHERSCAN_KEY
```

## Supported Chains (Default)

- **Ethereum**: 1
- **Optimism**: 10
- **Base**: 8453
- **Arbitrum**: 42161

Additional chains can be added via `addSupportedChain()`.

## FAQ

### Q: Why shares instead of tokens?
**A**: To preserve value across rebasing events. Bridging tokens would require reverse-calculating shares at the destination's multiplier, which could differ from the source's multiplier mid-flight.

### Q: What happens if the orchestrator goes offline?
**A**: Bridge requests will queue up. When orchestrator comes back online, it can process all pending requests. Admin can also `skipNonce()` to unblock if needed.

### Q: Can users submit signatures themselves?
**A**: Yes! The `bridgeMint()` function is permissionless. Anyone can submit a valid signature. This provides a fallback if the orchestrator is slow.

### Q: What if a mint fails on the destination?
**A**: Admin can call `refundFailedRequest()` to mint shares back to the original sender on the source chain.

### Q: Is this bridge secure?
**A**: The bridge has been thoroughly tested (48 tests, 93% coverage) but should undergo professional audit before mainnet deployment. It relies on a centralized orchestrator signer, which is a trust assumption.

### Q: How are fees calculated?
**A**: Fees are calculated as `(shares × bridgeFee) / 10000`. For example, with 0.1% fee (10 basis points), bridging 1000 shares costs 1 share in fees.

## Resources

- **Main Spec**: `/home/jbarber/gfx/okuMoney/contracts/CLAUDE.md`
- **Test Suite**: `test/bridge/OkuBridge.t.sol`
- **Contract**: `src/bridge/OkuBridge.sol`

## License

MIT
