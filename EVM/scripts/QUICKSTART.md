# Quick Start Guide

## Important: Starting the Fork Correctly

Use `npx hardhat node` (not `npx hardhat node --fork ...`) to ensure correct forking configuration:

```bash
npx hardhat node
```

This command uses the forking settings in `hardhat.config.ts`, which automatically forks Optimism mainnet at a recent block where USDC is available.

## Test on Local Fork (Recommended)

### Option A: One-Command Deploy & Test (Easiest)

```bash
# Terminal 1: Start fork (uses hardhat.config.ts settings for Optimism)
npx hardhat node

# Terminal 2: Deploy and test everything
npx hardhat run scripts/deploy-and-test.ts --network localhost
```

**Note:** The `npx hardhat node` command will automatically fork Optimism mainnet using the settings in `hardhat.config.ts`.

This single script will:
- ✓ Check network connectivity
- ✓ Deploy all contracts
- ✓ Configure roles
- ✓ Get USDC for testing
- ✓ Run full interaction suite (mint, wrap, rebalance)

### Option B: Deploy Only (No Testing)

```bash
# Terminal 1: Start fork
npx hardhat node

# Terminal 2: Deploy all contracts
npx hardhat run scripts/deploy-all.ts --network localhost
```

This deploys all contracts and configures roles, then stops.

### Option C: Manual Step-by-Step

If you prefer to run each step manually:

#### 1. Start Hardhat Node with Fork
```bash
npx hardhat node
```

This will fork Optimism mainnet using the settings in `hardhat.config.ts`.

#### 2. Deploy All Contracts (in another terminal)
```bash
# Deploy core contracts
NETWORK=localhost npx hardhat run scripts/deploy/1-deploy-core.ts --network localhost

# Deploy PSM
NETWORK=localhost npx hardhat run scripts/deploy/2-deploy-psm.ts --network localhost

# Deploy bridge router
NETWORK=localhost npx hardhat run scripts/deploy/3-deploy-bridge.ts --network localhost

# Configure roles
NETWORK=localhost npx hardhat run scripts/deploy/4-configure-roles.ts --network localhost
```

#### 3. Get USDC for Testing

You need USDC to test minting. We provide two methods:

**Method 1: Deal USDC directly (Recommended - more reliable)**
```bash
# Deal 100,000 USDC (default)
npx hardhat run scripts/utils/deal-usdc.ts --network localhost

# Or specify custom amount
AMOUNT=50000 npx hardhat run scripts/utils/deal-usdc.ts --network localhost
```

This uses Hardhat's storage manipulation to directly set your USDC balance. Fast and reliable.

**Method 2: Whale impersonation (Fallback)**
```bash
# Get 100,000 USDC from a whale
npx hardhat run scripts/utils/get-usdc-fork.ts --network localhost
```

This impersonates a USDC whale and transfers tokens to your account. May fail if whale addresses change.

#### 4. Test Interactions

```bash
# Mint OkuUSD
NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost

# Check balances
NETWORK=localhost npx hardhat run scripts/interactions/check-balances.ts --network localhost

# Wrap to wOkuUSD
NETWORK=localhost AMOUNT=5000 npx hardhat run scripts/interactions/wrap-okuusd.ts --network localhost

# Rebalance (5% yield)
NETWORK=localhost MULTIPLIER=1.05 npx hardhat run scripts/interactions/rebalance.ts --network localhost

# Check final balances
NETWORK=localhost npx hardhat run scripts/interactions/check-balances.ts --network localhost
```

### 5. Or Run Full E2E Flow

```bash
NETWORK=localhost npx hardhat run scripts/e2e/full-flow.ts --network localhost
```

Note: The E2E flow expects you to have USDC already. Get USDC first using step 3 above.

## Deploy to Mainnet

**WARNING**: This costs real gas and deploys real contracts!

### 1. Set up environment
```bash
# Create .env file
echo "OPTIMISM_RPC_URL=https://mainnet.optimism.io" >> EVM/.env
echo "ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc" >> EVM/.env
echo "PRIVATE_KEY=your_private_key_here" >> EVM/.env
```

### 2. Deploy to Optimism
```bash
NETWORK=optimism npx hardhat run scripts/deploy/1-deploy-core.ts --network optimism
NETWORK=optimism npx hardhat run scripts/deploy/2-deploy-psm.ts --network optimism
NETWORK=optimism npx hardhat run scripts/deploy/3-deploy-bridge.ts --network optimism
NETWORK=optimism npx hardhat run scripts/deploy/4-configure-roles.ts --network optimism
```

### 3. Deploy to Arbitrum
```bash
NETWORK=arbitrum npx hardhat run scripts/deploy/1-deploy-core.ts --network arbitrum
NETWORK=arbitrum npx hardhat run scripts/deploy/2-deploy-psm.ts --network arbitrum
NETWORK=arbitrum npx hardhat run scripts/deploy/3-deploy-bridge.ts --network arbitrum
NETWORK=arbitrum npx hardhat run scripts/deploy/4-configure-roles.ts --network arbitrum
```

### 4. Test on Mainnet
```bash
# You'll need real USDC
NETWORK=optimism AMOUNT=1000 npx hardhat run scripts/interactions/mint-okuusd.ts --network optimism

# Check balances across all chains
npx hardhat run scripts/interactions/check-balances.ts
```

## Common Issues

### "No address found for contract"
Run deployment scripts first.

### "Insufficient USDC balance"
Get USDC by:
- Fork: Impersonate USDC whale (see step 3 above)
- Mainnet: Buy or bridge USDC

### "InvalidMultiplier" on rebalance
New multiplier must be > current multiplier. Check current:
```bash
npx hardhat run scripts/interactions/check-balances.ts
```

### "AccessControl: account is missing role"
Run `scripts/deploy/4-configure-roles.ts`.

## Script Reference

### Deployment
- `1-deploy-core.ts` - Deploy OkuUSD, wOkuUSD, RedemptionQueue
- `2-deploy-psm.ts` - Deploy LitePSM
- `3-deploy-bridge.ts` - Deploy OkuBridgeRouter
- `4-configure-roles.ts` - Grant roles and allowances

### Interactions
- `mint-okuusd.ts` - Mint OkuUSD from USDC
- `wrap-okuusd.ts` - Wrap OkuUSD to wOkuUSD
- `rebalance.ts` - Update reward multiplier
- `check-balances.ts` - Query balances

### E2E
- `full-flow.ts` - Complete deployment + testing

## Environment Variables

- `NETWORK` - Target network (localhost, optimism, arbitrum)
- `AMOUNT` - Amount for mint/wrap operations
- `MULTIPLIER` - New multiplier for rebalance (e.g., 1.05)

## Next Steps

After successful deployment:
1. Verify contracts on Etherscan
2. Set up multi-sig for admin roles
3. Configure bridge adapters (when third-party integration ready)
4. Set up monitoring and alerts
5. Document deployed addresses for frontend integration
