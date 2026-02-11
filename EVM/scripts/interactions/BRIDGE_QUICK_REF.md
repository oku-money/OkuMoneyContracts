# Bridge Relay Quick Reference

## Full Relay (Source → Dest)

```bash
SOURCE_NETWORK=optimism \
DEST_CHAIN_ID=42161 \
RECIPIENT=0x... \
SHARES=100 \
npx hardhat run scripts/interactions/relay-bridge.ts --network optimism
```

## Complete Pending (Retry)

```bash
REQUEST_ID=0x... \
npx hardhat run scripts/interactions/relay-bridge.ts --complete --network arbitrum
```

## Chain IDs

| Network | Chain ID |
|---------|----------|
| Ethereum | 1 |
| Optimism | 10 |
| Base | 8453 |
| Arbitrum | 42161 |

## View Logs

```bash
# All requests
cat scripts/logs/bridge-requests.jsonl | jq

# Pending only
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "pending")'

# Failed only
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "failed")'

# Count completed
cat scripts/logs/bridge-requests.jsonl | jq 'select(.status == "completed")' | wc -l
```

## Prerequisites

1. Deploy contracts on both chains
2. Add destination chain as supported on source bridge
3. Set authorized signer on destination bridge
4. Mint OkuUSD on source chain

## Common Errors

| Error | Solution |
|-------|----------|
| Insufficient balance | Mint more OkuUSD on source |
| Unsupported chain | Add chain support on source bridge |
| Invalid signature | Check authorized signer on dest bridge |
| Already processed | Bridge already completed (check logs) |

## Testing on Fork

```bash
# Terminal 1
npx hardhat node

# Terminal 2
NETWORK=localhost npx hardhat run scripts/deploy-all.ts --network localhost
NETWORK=localhost npx hardhat run scripts/utils/deal-usdc.ts --network localhost
NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost

SOURCE_NETWORK=localhost \
DEST_CHAIN_ID=42161 \
RECIPIENT=$(cast wallet address) \
SHARES=100 \
npx hardhat run scripts/interactions/relay-bridge.ts --network localhost
```

## Documentation

- Full guide: `BRIDGE_RELAY_GUIDE.md`
- Implementation: `BRIDGE_RELAY_IMPLEMENTATION.md`
- Main README: `../README.md`
