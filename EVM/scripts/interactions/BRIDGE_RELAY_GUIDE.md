# Bridge Relay Script Guide

This guide explains how to use the `relay-bridge.ts` script to bridge OkuUSD between chains.

## Overview

The bridge relay script automates the cross-chain bridging process:
1. Burns OkuUSD on the source chain
2. Captures the bridge request event
3. Signs the request with EIP-712
4. Mints OkuUSD on the destination chain
5. Logs all requests to a file for audit and retry

## Two Operating Modes

### 1. Full Relay (Default)
Executes the complete bridge flow in one script run:
- Source chain: burn tokens
- Sign with orchestrator key
- Destination chain: mint tokens

### 2. Complete Mode (`--complete`)
Completes a pending bridge request from the log file:
- Read request from log
- Destination chain: mint tokens
- Update log with completion status

## Prerequisites

### 1. Deploy Contracts
Contracts must be deployed on both source and destination chains:

```bash
# Deploy on source chain (e.g., Optimism)
NETWORK=optimism npx hardhat run scripts/deploy-all.ts --network optimism

# Deploy on destination chain (e.g., Arbitrum)
NETWORK=arbitrum npx hardhat run scripts/deploy-all.ts --network arbitrum
```

### 2. Configure Bridge
The destination chain must be configured as supported on the source bridge:

```bash
# Add supported chain (admin function)
cast send $BRIDGE_ADDRESS "addSupportedChain(uint256)" 42161 \
  --private-key $ADMIN_KEY --rpc-url $SOURCE_RPC
```

### 3. Set Authorized Signer
The orchestrator's address must be set as authorized signer on destination bridge:

```bash
# Set authorized signer (admin function)
cast send $BRIDGE_ADDRESS "setAuthorizedSigner(address)" $ORCHESTRATOR_ADDRESS \
  --private-key $ADMIN_KEY --rpc-url $DEST_RPC
```

### 4. Mint OkuUSD
User must have OkuUSD balance on source chain:

```bash
# Mint some OkuUSD first
NETWORK=optimism AMOUNT=10000 \
npx hardhat run scripts/interactions/mint-okuusd.ts --network optimism
```

## Usage Examples

### Example 1: Fork Testing (Localhost)

```bash
# Terminal 1: Start Arbitrum fork
npx hardhat node --fork https://arb1.arbitrum.io/rpc

# Terminal 2: Deploy contracts
NETWORK=localhost npx hardhat run scripts/deploy-all.ts --network localhost

# Terminal 3: Get USDC and mint OkuUSD
NETWORK=localhost npx hardhat run scripts/utils/deal-usdc.ts --network localhost
NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost

# Terminal 4: Relay bridge (same chain for testing)
SOURCE_NETWORK=localhost \
DEST_CHAIN_ID=42161 \
RECIPIENT=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb \
SHARES=100 \
npx hardhat run scripts/interactions/relay-bridge.ts --network localhost
```

### Example 2: Live Networks (Optimism → Arbitrum)

```bash
# Bridge 100 shares from Optimism to Arbitrum
SOURCE_NETWORK=optimism \
DEST_CHAIN_ID=42161 \
RECIPIENT=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb \
SHARES=100 \
npx hardhat run scripts/interactions/relay-bridge.ts --network optimism
```

### Example 3: Retry Failed Bridge

If the destination mint fails (e.g., destination chain paused), you can retry:

```bash
# View pending requests
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "pending")'

# Get the request ID from the output
REQUEST_ID=0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890

# Complete the bridge on destination chain
REQUEST_ID=$REQUEST_ID \
npx hardhat run scripts/interactions/relay-bridge.ts --complete --network arbitrum
```

### Example 4: Custom Amounts

```bash
# Bridge 1000 shares
SOURCE_NETWORK=optimism \
DEST_CHAIN_ID=8453 \
RECIPIENT=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb \
SHARES=1000 \
npx hardhat run scripts/interactions/relay-bridge.ts --network optimism
```

## Environment Variables

### Full Relay Mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOURCE_NETWORK` | No | Current network | Source chain name (optimism, arbitrum, base) |
| `DEST_CHAIN_ID` | Yes | - | Destination chain ID (10, 42161, 8453, etc.) |
| `RECIPIENT` | Yes | - | Recipient address on destination chain |
| `SHARES` | No | 100 | Amount of shares to bridge |

### Complete Mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REQUEST_ID` | Yes | - | Request ID from log file (0x...) |

## Chain ID Reference

| Network | Chain ID | Name |
|---------|----------|------|
| Ethereum | 1 | Ethereum Mainnet |
| Optimism | 10 | Optimism |
| Base | 8453 | Base |
| Arbitrum | 42161 | Arbitrum One |
| Localhost | 31337 | Hardhat Fork |

## Log File Format

Bridge requests are logged to `scripts/logs/bridge-requests.jsonl` in JSON Lines format.

### Example Log Entry

```json
{
  "timestamp": "2026-02-06T12:34:56.789Z",
  "requestId": "0xabcdef...",
  "sourceNetwork": "optimism",
  "destNetwork": "arbitrum",
  "sourceChainId": "10",
  "destChainId": "42161",
  "sender": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "recipient": "0x1234567890123456789012345678901234567890",
  "shares": "100000000000000000000",
  "nonce": "0",
  "deadline": 1738848896,
  "signature": "0x1234...5678",
  "sourceTxHash": "0xabc123...",
  "destTxHash": "0xdef456...",
  "status": "completed",
  "networkType": "mainnet",
  "error": null
}
```

### Status Values

- `pending`: Source burn completed, waiting for destination mint
- `completed`: Bridge successfully completed
- `failed`: Destination mint failed (check `error` field)

### Querying Logs with jq

```bash
# View all bridge requests
cat scripts/logs/bridge-requests.jsonl | jq

# View pending requests
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "pending")'

# View failed requests
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "failed")'

# View bridges by source network
cat scripts/logs/bridge-requests.jsonl | jq 'select(.sourceNetwork == "optimism")'

# View bridges by recipient
cat scripts/logs/bridge-requests.jsonl | jq 'select(.recipient == "0x...")'

# Count completed bridges
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "completed")' | wc -l
```

## Error Handling

### Insufficient Balance

```
✗ Insufficient balance: 50 < 100.1
ℹ Mint tokens first using: NETWORK=... AMOUNT=... npx hardhat run scripts/interactions/mint-okuusd.ts
```

**Solution**: Mint more OkuUSD on the source chain.

### Unsupported Chain

```
✗ Destination chain 137 is not supported
ℹ Add support using admin functions
```

**Solution**: Add the destination chain as supported on the source bridge contract.

### Already Processed

```
⚠ Request already processed on destination chain
```

**Info**: This request has already been minted on the destination. Check logs for details.

### Signature Expired

```
✗ Bridge mint failed: SignatureExpired
⚠ Request logged as failed. Retry with --complete flag:
ℹ REQUEST_ID=0x... npx hardhat run scripts/interactions/relay-bridge.ts --complete
```

**Solution**: The deadline (1 hour) expired. Generate a new signature or retry if still within deadline.

### Invalid Signature

```
✗ Bridge mint failed: Invalid signature
```

**Solution**: Ensure the orchestrator key is set as authorized signer on destination bridge.

## Security Considerations

### Orchestrator Key

The script uses the first signer as the orchestrator key. In production:
1. Use a dedicated orchestrator key (different from admin)
2. Store the key securely (hardware wallet, KMS)
3. Grant `BRIDGE_SIGNER_MANAGER` only to trusted operators
4. Monitor bridge activity for anomalies

### Signature Verification

- Signatures are EIP-712 typed data signatures
- Domain separator includes chain ID and verifying contract
- Deadline prevents replay attacks (1 hour by default)
- Request ID prevents double-spending

### Network Type Detection

The script automatically detects if running on a fork or mainnet:
- Fork: RPC URL contains "localhost" or "127.0.0.1"
- Mainnet: All other RPC URLs

This is logged for transparency and debugging.

## Advanced Usage

### Batch Processing

To process multiple pending bridges:

```bash
# Get all pending request IDs
PENDING_IDS=$(cat scripts/logs/bridge-requests.jsonl | \
  jq -r 'select(.status == "pending") | .requestId')

# Complete each one
for ID in $PENDING_IDS; do
  REQUEST_ID=$ID npx hardhat run scripts/interactions/relay-bridge.ts \
    --complete --network arbitrum
done
```

### Custom Deadline

To modify the deadline, edit the script:

```typescript
// Change from 1 hour (3600) to 24 hours (86400)
const deadline = Math.floor(Date.now() / 1000) + 86400;
```

### Monitoring

Set up monitoring for bridge activity:

```bash
# Watch for new pending requests
tail -f scripts/logs/bridge-requests.jsonl | \
  jq 'select(.status == "pending")'

# Alert on failed bridges
cat scripts/logs/bridge-requests.jsonl | \
  jq 'select(.status == "failed") | {requestId, error}'
```

## Troubleshooting

### Log File Not Found

The log file is created automatically on first bridge request. If missing:

```bash
mkdir -p scripts/logs
touch scripts/logs/bridge-requests.jsonl
```

### Invalid JSON in Log

If the log file becomes corrupted:

```bash
# Backup current log
cp scripts/logs/bridge-requests.jsonl scripts/logs/bridge-requests.jsonl.bak

# Validate and fix
cat scripts/logs/bridge-requests.jsonl.bak | \
  jq -c '.' > scripts/logs/bridge-requests.jsonl
```

### Request ID Not Found

Ensure you're using the full request ID (66 characters including "0x"):

```bash
# Correct format
REQUEST_ID=0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890

# Wrong - too short
REQUEST_ID=0xabcd
```

## Production Checklist

Before using in production:

- [ ] Deploy contracts on all chains
- [ ] Configure supported chains on all bridges
- [ ] Set authorized signer on all bridges
- [ ] Test full relay on testnet/fork
- [ ] Test complete mode for retry scenarios
- [ ] Set up monitoring for bridge logs
- [ ] Secure orchestrator key
- [ ] Document bridge configuration
- [ ] Plan for disaster recovery
- [ ] Set up alerts for failed bridges

## Support

For issues or questions:
- Check the error message and this guide first
- View logs: `cat scripts/logs/bridge-requests.jsonl | jq`
- Review contract events on block explorer
- Contact the development team

## License

MIT
