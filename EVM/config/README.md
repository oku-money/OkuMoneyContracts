# Configuration Directory

This directory contains the centralized configuration for all canonical addresses and chain metadata used across the OkuMoney EVM contracts project.

## Files

### `config.ts`

**Single source of truth** for all external contract addresses across chains.

**What's included:**
- Token addresses (USDC, WETH, DAI, USDT) for each chain
- Whale addresses for fork testing
- Protocol addresses (Uniswap, Aave)
- Chain metadata (chain IDs, names, RPC URLs, explorers)
- Wormhole chain ID mappings for bridge integration

**Supported chains:**
- Ethereum Mainnet
- Optimism
- Arbitrum One
- Base
- Localhost (fork testing - defaults to Optimism)

**Usage examples:**

```typescript
import { getTokenAddress, getWhaleAddress, getChainMetadata } from "../config/config";

// Get USDC address for Optimism
const usdcAddress = getTokenAddress("optimism", "usdc");
// Returns: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"

// Get whale address for testing
const whaleAddress = getWhaleAddress("optimism", "usdc");
// Returns: "0xf89d7b9c864f589bbF53a82105107622B35EaA40"

// Get chain metadata
const chainMeta = getChainMetadata("arbitrum");
// Returns: { name: "Arbitrum One", chainId: 42161, rpcUrl: "...", explorer: "..." }

// Get Wormhole chain ID for bridging
import { getWormholeChainId } from "../config/config";
const wormholeId = getWormholeChainId(10); // Optimism chain ID
// Returns: 24 (Wormhole chain ID for Optimism)
```

## Adding New Chains

To add a new chain:

1. Add token addresses to `CHAIN_ADDRESSES`:
```typescript
newchain: {
  tokens: {
    usdc: "0x...",
    weth: "0x...",
  },
  whales: {
    usdc: "0x...",
  },
  protocols: {
    // Optional protocol addresses
  },
}
```

2. Add chain metadata to `CHAIN_METADATA`:
```typescript
newchain: {
  name: "New Chain",
  chainId: 12345,
  rpcUrl: process.env.NEWCHAIN_RPC_URL || "https://...",
  explorer: "https://...",
}
```

3. Add Wormhole mapping if needed:
```typescript
export const WORMHOLE_CHAIN_IDS: Record<number, number> = {
  // ...existing mappings
  12345: 42, // New Chain -> Wormhole 42
};
```

## Why Centralized Config?

**Before:** Addresses were hardcoded across multiple files:
- ❌ Test files had `const USDC_MAINNET = "0x..."`
- ❌ Scripts had duplicate chain configs
- ❌ Updating addresses required changes in 10+ files
- ❌ Easy to have mismatched addresses

**After:** Single source of truth:
- ✅ All addresses in one file
- ✅ Type-safe access with helper functions
- ✅ Update once, works everywhere
- ✅ Easy to add new chains

## Files Using This Config

**Tests:**
- `test/hardhat/fork/LitePSM.ts`
- `test/hardhat/fork/wOkuUSD.ts`
- `test/hardhat/fork/OkuUSD.ts`
- `test/hardhat/fork/NttBridge.ts`
- `test/hardhat/happyPath/HappyPath.ts`

**Scripts:**
- `scripts/config/chains.ts` (wrapper for backward compatibility)
- `scripts/utils/deal-usdc.ts`
- `scripts/utils/get-usdc-fork.ts`
- All deployment and interaction scripts (via `chains.ts`)

## Updating Addresses

To update addresses (e.g., whale addresses changed due to on-chain activity):

1. Find current holders on block explorer:
   - Optimism: https://optimistic.etherscan.io/token/{address}#balances
   - Arbitrum: https://arbiscan.io/token/{address}#balances

2. Update the address in `config.ts`

3. All tests and scripts automatically use the new address

## Notes

- **Localhost fork**: Uses Optimism addresses by default. Update if forking a different chain.
- **Whale addresses**: May become stale as funds move. Keep backups in scripts.
- **RPC URLs**: Use environment variables (`OPTIMISM_RPC_URL`, etc.) or fallback to public RPCs.
- **Protocol addresses**: Optional - add as needed for future features.
