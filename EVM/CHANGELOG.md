# Changelog

## [Unreleased] - 2026-02-04

### Added - Centralized Configuration System

#### New Files
- **`config/config.ts`** - Single source of truth for all canonical addresses
  - Token addresses (USDC, WETH, DAI, USDT) for Ethereum, Optimism, Arbitrum, Base
  - Whale addresses for fork testing
  - Protocol addresses (Uniswap V3, Aave V3)
  - Chain metadata (chain IDs, RPC URLs, explorers)
  - Wormhole chain ID mappings for bridge integration
  - Type-safe helper functions: `getTokenAddress()`, `getWhaleAddress()`, `getChainMetadata()`, `getWormholeChainId()`

- **`config/README.md`** - Documentation for the centralized config system
  - Usage examples
  - Guide for adding new chains
  - Migration notes

#### Modified Files

**Scripts:**
- **`scripts/config/chains.ts`** - Refactored to use centralized config
  - Now wraps `config/config.ts` for backward compatibility
  - Removed duplicate address definitions
  - Simplified to focus on script-specific utilities

- **`scripts/utils/deal-usdc.ts`** - Uses centralized config
  - Imports `getTokenAddress()` from `config/config.ts`
  - Removed hardcoded USDC address

- **`scripts/utils/get-usdc-fork.ts`** - Uses centralized config
  - Imports `getTokenAddress()` and `getWhaleAddress()` from `config/config.ts`
  - Keeps backup whale addresses for fallback
  - Removed hardcoded USDC address

**Tests:**
- **`test/hardhat/fork/LitePSM.ts`** - Uses centralized config
  - Imports `getTokenAddress()` and `getWhaleAddress()`
  - Replaced `const USDC_MAINNET = "0x..."` with config function

- **`test/hardhat/fork/wOkuUSD.ts`** - Uses centralized config
  - Same pattern as LitePSM.ts

- **`test/hardhat/fork/OkuUSD.ts`** - Uses centralized config
  - Same pattern as LitePSM.ts

- **`test/hardhat/fork/NttBridge.ts`** - Uses centralized config
  - Imports `getTokenAddress()`, `getWhaleAddress()`, `getChainMetadata()`, `getWormholeChainId()`
  - Replaced hardcoded chain IDs and Wormhole mappings with config functions

- **`test/hardhat/happyPath/HappyPath.ts`** - Uses centralized config
  - Same pattern as LitePSM.ts

### Benefits

1. **Single Source of Truth**
   - All addresses defined in one place
   - Update once, works everywhere
   - Eliminates duplicate definitions

2. **Type Safety**
   - TypeScript helper functions with proper types
   - Compile-time checking for supported networks and tokens
   - Autocomplete for available chains and tokens

3. **Maintainability**
   - Easy to add new chains
   - Clear structure for different address types
   - Self-documenting with inline comments

4. **Flexibility**
   - Support for multiple chains (Ethereum, Optimism, Arbitrum, Base)
   - Extensible for new tokens and protocols
   - Backward compatible with existing scripts

### Verification

✅ All 248 Forge tests pass
✅ All 6 Hardhat happy path tests pass
✅ No hardcoded addresses remaining in tests
✅ Scripts compile without errors
✅ Type checking passes

### Migration Guide

For new code:
```typescript
// Old way (don't do this)
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const USDC_WHALE = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341"

// New way (do this)
import { getTokenAddress, getWhaleAddress } from "../config/config"
const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!
```

For chain metadata:
```typescript
// Old way
const chainId = 10
const rpcUrl = "https://mainnet.optimism.io"

// New way
import { getChainMetadata } from "../config/config"
const metadata = getChainMetadata("optimism")
const chainId = metadata.chainId
const rpcUrl = metadata.rpcUrl
```
