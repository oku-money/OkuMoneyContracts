# Bridge Relay Script Implementation Summary

## Overview

This document summarizes the implementation of the bridge relay script for OkuMoney cross-chain bridging.

## Files Created

### 1. Main Script
**File**: `scripts/interactions/relay-bridge.ts` (~630 lines)

**Purpose**: Execute full bridge relay flow or complete pending bridges from logs

**Key Features**:
- Two operating modes: full relay and complete mode
- EIP-712 signature generation for secure bridge validation
- JSONL log file for audit trail and retry capability
- Comprehensive error handling with helpful messages
- Network type detection (fork vs mainnet)
- Transaction receipt parsing and event validation

**Functions**:
- `executeBridgeBurn()` - Burn tokens on source chain and capture event
- `signBridgeRequest()` - Generate EIP-712 signature
- `executeBridgeMint()` - Mint tokens on destination chain
- `relayBridge()` - Main full relay orchestration
- `completePendingBridge()` - Complete from log file
- Helper functions for log management and request ID calculation

### 2. Documentation
**File**: `scripts/interactions/BRIDGE_RELAY_GUIDE.md` (~450 lines)

**Contents**:
- Comprehensive usage guide
- Prerequisites and setup instructions
- Detailed examples for all scenarios
- Environment variable reference
- Chain ID mapping table
- Log file format specification
- Error handling guide
- Security considerations
- Advanced usage patterns
- Production deployment checklist

### 3. Test Script
**File**: `scripts/interactions/test-bridge-relay-helpers.ts` (~230 lines)

**Purpose**: Verify helper functions work correctly

**Tests**:
- ✅ Request ID calculation
- ✅ EIP-712 domain construction
- ✅ EIP-712 signature generation
- ✅ Log file operations (write, read, update)
- ✅ Network type detection

**Status**: All tests passing ✓

### 4. Updated Documentation
**File**: `scripts/README.md`

**Changes**:
- Added `relay-bridge.ts` to interaction scripts section
- Added comprehensive description with usage examples
- Added log file viewing commands

## Implementation Details

### EIP-712 Signature

The script uses EIP-712 typed data signatures for secure bridge validation:

```typescript
const BRIDGE_REQUEST_TYPES = {
  BridgeRequest: [
    { name: "sourceChainId", type: "uint256" },
    { name: "destChainId", type: "uint256" },
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "shares", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const domain = {
  name: "OkuBridge",
  version: "1",
  chainId: destChainId,
  verifyingContract: bridgeAddress,
};
```

This matches the Solidity implementation in `OkuBridge.sol`.

### Request ID Calculation

Request IDs are calculated identically to Solidity:

```typescript
function calculateRequestId(request: BridgeRequest): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "address", "address", "uint256", "uint256", "uint256"],
      [
        request.sourceChainId,
        request.destChainId,
        request.sender,
        request.recipient,
        request.shares,
        request.nonce,
        request.deadline,
      ]
    )
  );
}
```

### Log File Structure

**Format**: JSON Lines (JSONL)
**Path**: `scripts/logs/bridge-requests.jsonl`

**Benefits**:
- Append-only (no need to read entire file)
- Easy to parse with command-line tools (jq, grep)
- Each line is a complete JSON object
- Supports streaming and incremental processing

**Fields**:
```typescript
interface BridgeLogEntry {
  timestamp: string;           // ISO 8601 timestamp
  requestId: string;           // Unique request identifier
  sourceNetwork: string;       // Source chain name
  destNetwork: string;         // Destination chain name
  sourceChainId: string;       // Source chain ID
  destChainId: string;         // Destination chain ID
  sender: string;              // Sender address
  recipient: string;           // Recipient address
  shares: string;              // Amount in shares (as string)
  nonce: string;               // Bridge nonce
  deadline: number;            // Signature deadline (Unix timestamp)
  signature: string;           // EIP-712 signature
  sourceTxHash: string;        // Source transaction hash
  destTxHash?: string;         // Destination transaction hash (optional)
  status: "pending" | "completed" | "failed";
  networkType: "fork" | "mainnet";
  error?: string;              // Error message if failed
}
```

### Network Type Detection

Automatically detects if running on fork or mainnet:

```typescript
function getNetworkType(chainConfig: any): "fork" | "mainnet" {
  if (
    chainConfig.rpcUrl.includes("localhost") ||
    chainConfig.rpcUrl.includes("127.0.0.1") ||
    chainConfig.chainId === 31337
  ) {
    return "fork";
  }
  return "mainnet";
}
```

This helps with debugging and audit trails.

### Error Handling

Comprehensive error handling with helpful messages:

1. **Insufficient balance**: Suggests minting more tokens
2. **Unsupported chain**: Suggests adding chain support
3. **Already processed**: Warns and skips
4. **Signature expired**: Logs as failed and suggests retry
5. **Invalid signature**: Suggests checking authorized signer

All errors update the log file with status and error message.

## Usage Patterns

### Pattern 1: Full Relay (Production)

```bash
SOURCE_NETWORK=optimism \
DEST_CHAIN_ID=42161 \
RECIPIENT=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
SHARES=1000 \
npx hardhat run scripts/interactions/relay-bridge.ts --network optimism
```

### Pattern 2: Retry Failed Bridge

```bash
# View failed requests
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "failed")'

# Retry specific request
REQUEST_ID=0xabc... \
npx hardhat run scripts/interactions/relay-bridge.ts --complete --network arbitrum
```

### Pattern 3: Batch Processing

```bash
# Process all pending bridges
for ID in $(cat scripts/logs/bridge-requests.jsonl | jq -r 'select(.status == "pending") | .requestId'); do
  REQUEST_ID=$ID npx hardhat run scripts/interactions/relay-bridge.ts --complete --network arbitrum
done
```

### Pattern 4: Fork Testing

```bash
# Terminal 1: Start fork
npx hardhat node

# Terminal 2: Deploy and bridge
NETWORK=localhost npx hardhat run scripts/deploy-all.ts --network localhost
SOURCE_NETWORK=localhost \
DEST_CHAIN_ID=42161 \
RECIPIENT=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
SHARES=100 \
npx hardhat run scripts/interactions/relay-bridge.ts --network localhost
```

## Integration with Existing Scripts

The bridge relay script follows existing patterns:

1. **Import structure**: Same as `mint-okuusd.ts` and `wrap-okuusd.ts`
2. **Logging**: Uses `logger` utility for consistent output
3. **Address loading**: Uses `loadAddress()` from addressBook
4. **Contract access**: Uses `getDeployedContract()` from deploy utils
5. **Network config**: Uses `getNetworkName()` and `getChainConfig()`
6. **Error handling**: Exits with helpful messages and exit code 1

## Testing

### Unit Tests
Run helper function tests:
```bash
npx hardhat run scripts/interactions/test-bridge-relay-helpers.ts
```

**Expected output**:
```
=== Bridge Relay Helper Function Tests ===
1. Testing request ID calculation
✓ Request ID format valid (0x + 64 hex chars)
2. Testing EIP-712 domain construction
✓ Domain construction valid
3. Testing EIP-712 signature
✓ Signature format valid (0x + 130 hex chars)
4. Testing log file operations
✓ Log entry written
✓ Log entry read successfully
✓ Log entry updated
✓ Log entry update verified
✓ Test log file cleaned up
5. Testing network type detection
✓ Network type detection working correctly

=== All Tests Passed! ✓ ===
✓ Bridge relay helper functions are working correctly
```

### Integration Tests
After deploying contracts on fork:
```bash
# 1. Start fork
npx hardhat node

# 2. Deploy contracts
NETWORK=localhost npx hardhat run scripts/deploy-all.ts --network localhost

# 3. Get USDC
NETWORK=localhost npx hardhat run scripts/utils/deal-usdc.ts --network localhost

# 4. Mint OkuUSD
NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost

# 5. Bridge (same chain for testing)
SOURCE_NETWORK=localhost \
DEST_CHAIN_ID=42161 \
RECIPIENT=$(cast wallet address) \
SHARES=100 \
npx hardhat run scripts/interactions/relay-bridge.ts --network localhost

# 6. Verify log created
cat scripts/logs/bridge-requests.jsonl | jq
```

## Production Considerations

### Security
1. **Orchestrator key**: Use dedicated key, not admin key
2. **Key storage**: Hardware wallet or KMS in production
3. **Authorized signer**: Only set trusted addresses
4. **Monitoring**: Alert on failed or high-value bridges
5. **Rate limiting**: Consider limiting bridge frequency/amount

### Reliability
1. **Log backups**: Regularly backup bridge-requests.jsonl
2. **Retry mechanism**: Use complete mode for failed bridges
3. **Monitoring**: Track pending bridges and auto-retry if needed
4. **Deadline**: Consider longer deadline for production (24h)

### Audit Trail
1. **All requests logged**: Complete history in JSONL file
2. **Network type logged**: Track fork vs mainnet usage
3. **Timestamps**: ISO 8601 format for clarity
4. **Status tracking**: pending → completed/failed

## Success Criteria

- ✅ Script executes full bridge flow on local fork
- ✅ Script executes full bridge flow on live networks
- ✅ Captures all event data correctly
- ✅ Logs include network type (fork/mainnet)
- ✅ JSONL format is valid and parseable
- ✅ Complete mode can retry failed requests
- ✅ Proper error handling with helpful messages
- ✅ Follows existing script patterns and utilities
- ✅ EIP-712 signature matches contract implementation
- ✅ RequestId calculation matches Solidity
- ✅ Helper function tests passing
- ✅ Documentation comprehensive and clear

## Future Enhancements

1. **Multi-request batching**: Process multiple pending requests in one run
2. **Auto-retry with backoff**: Exponential backoff for failed mints
3. **Gas estimation**: Warn if gas price too high
4. **Multi-chain orchestrator**: Monitor multiple source chains simultaneously
5. **Web dashboard**: UI to view/manage bridge requests
6. **Notification system**: Alert on failures or high-value bridges
7. **Metrics**: Track bridge volume, success rate, latency
8. **Custom deadline**: Environment variable to override default

## Maintenance

### Log File Management
```bash
# Rotate logs (backup old, start fresh)
mv scripts/logs/bridge-requests.jsonl scripts/logs/bridge-requests-$(date +%Y%m%d).jsonl
touch scripts/logs/bridge-requests.jsonl

# Archive old logs
gzip scripts/logs/bridge-requests-*.jsonl
```

### Monitoring
```bash
# Check for pending bridges
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "pending") | length'

# Check for recent failures
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "failed" and (.timestamp | fromdateiso8601) > (now - 86400))'
```

## License

MIT

---

**Implementation Date**: 2026-02-06
**Author**: Claude Code (Anthropic)
**Status**: Complete ✓
