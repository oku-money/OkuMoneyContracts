# OkuMoney Deployment & Testing Scripts

Hardhat/ethers scripts for deploying and testing OkuMoney contracts on Optimism and Arbitrum.

## Overview

This directory contains scripts to:
- Deploy OkuMoney contracts to Optimism and Arbitrum (or local forks)
- Configure roles and permissions
- Test the full happy path: mint, wrap, rebalance
- Verify balances and contract state

**Scope**: Happy path functionality only. Third-party bridges and NTT integration are excluded.

## Directory Structure

```
scripts/
├── deploy-and-test.ts  # 🚀 ONE-COMMAND: Deploy + test everything
├── deploy-all.ts       # 📦 Deploy all contracts (no testing)
│
├── config/             # Configuration files
│   ├── chains.ts       # Chain-specific constants (USDC, RPC URLs)
│   ├── addresses.json  # Deployed contract addresses (auto-generated)
│   └── roles.ts        # Role constant definitions
│
├── utils/              # Utility functions
│   ├── deploy.ts        # UUPS proxy deployment helper
│   ├── addressBook.ts   # Read/write deployed addresses
│   ├── logger.ts        # Colored console output
│   ├── deal-usdc.ts     # Deal USDC via storage (recommended)
│   └── get-usdc-fork.ts # Get USDC via whale impersonation (fallback)
│
├── deploy/             # Deployment scripts (run in order)
│   ├── 1-deploy-core.ts       # Deploy OkuUSD, wOkuUSD, RedemptionQueue
│   ├── 2-deploy-psm.ts        # Deploy LitePSM
│   ├── 3-deploy-bridge.ts     # Deploy OkuBridgeRouter
│   └── 4-configure-roles.ts   # Grant roles and configure allowances
│
├── interactions/       # Interaction scripts
│   ├── mint-okuusd.ts         # Mint OkuUSD from USDC
│   ├── wrap-okuusd.ts         # Wrap OkuUSD to wOkuUSD
│   ├── rebalance.ts           # Update reward multiplier
│   └── check-balances.ts      # Query balances on all chains
│
├── e2e/                # End-to-end testing
│   └── full-flow.ts    # Complete happy path orchestration (legacy)
│
├── README.md           # This file
└── QUICKSTART.md       # Quick reference guide
```

## Prerequisites

1. Install dependencies:
   ```bash
   cd EVM
   npm install
   ```

2. Configure Hardhat networks in `hardhat.config.ts`:
   ```typescript
   networks: {
     optimism: {
       url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
       accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
     },
     arbitrum: {
       url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
       accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
     },
   }
   ```

3. Set environment variables (create `.env` file):
   ```bash
   OPTIMISM_RPC_URL=https://mainnet.optimism.io
   ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
   PRIVATE_KEY=your_private_key_here  # For mainnet deployment only
   ```

## Quick Start: Local Fork Testing

**Recommended for development**: Test on a local fork before deploying to mainnet.

### One-Command Deploy & Test (Recommended)

```bash
# Terminal 1: Start fork (automatically forks Optimism from hardhat.config.ts)
npx hardhat node

# Terminal 2: Deploy and test everything
npx hardhat run scripts/deploy-and-test.ts --network localhost
```

This single command will deploy all contracts, get USDC, and run the full test suite.

**Note:** The `npx hardhat node` command uses the forking configuration in `hardhat.config.ts`, which is set to fork Optimism mainnet by default.

### Deploy Only (No Testing)

```bash
# Terminal 1: Start fork
npx hardhat node

# Terminal 2: Deploy all contracts
npx hardhat run scripts/deploy-all.ts --network localhost
```

### Manual Step-by-Step

If you prefer to run each script manually:

```bash
# Terminal 1: Start fork
npx hardhat node

# Terminal 2: Run deployment scripts
NETWORK=localhost npx hardhat run scripts/deploy/1-deploy-core.ts --network localhost
NETWORK=localhost npx hardhat run scripts/deploy/2-deploy-psm.ts --network localhost
NETWORK=localhost npx hardhat run scripts/deploy/3-deploy-bridge.ts --network localhost
NETWORK=localhost npx hardhat run scripts/deploy/4-configure-roles.ts --network localhost
```

### Step 3: Test Interactions

Before testing, you need USDC. On a fork, you can impersonate a USDC whale:

```javascript
// In Hardhat console or script
const usdc = await ethers.getContractAt("IERC20", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
const whale = "0x... "; // Find a USDC whale on Optimism
await network.provider.request({ method: "hardhat_impersonateAccount", params: [whale] });
const whaleSigner = await ethers.getSigner(whale);
await usdc.connect(whaleSigner).transfer(yourAddress, ethers.parseUnits("100000", 6));
```

Then run interactions:

```bash
# Mint OkuUSD from USDC
NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost

# Check balances
NETWORK=localhost npx hardhat run scripts/interactions/check-balances.ts --network localhost

# Wrap OkuUSD to wOkuUSD
NETWORK=localhost AMOUNT=5000 npx hardhat run scripts/interactions/wrap-okuusd.ts --network localhost

# Rebalance (5% yield)
NETWORK=localhost MULTIPLIER=1.05 npx hardhat run scripts/interactions/rebalance.ts --network localhost

# Check final balances
NETWORK=localhost npx hardhat run scripts/interactions/check-balances.ts --network localhost
```

### Step 4: Run Full E2E Flow

```bash
NETWORK=localhost npx hardhat run scripts/e2e/full-flow.ts --network localhost
```

## Mainnet Deployment

**WARNING**: This will deploy to real networks and cost real gas. Ensure you have:
- Sufficient ETH for gas on target networks
- Private key in `.env` file
- Verified contract code and roles

### Deploy to Optimism

```bash
NETWORK=optimism npx hardhat run scripts/deploy/1-deploy-core.ts --network optimism
NETWORK=optimism npx hardhat run scripts/deploy/2-deploy-psm.ts --network optimism
NETWORK=optimism npx hardhat run scripts/deploy/3-deploy-bridge.ts --network optimism
NETWORK=optimism npx hardhat run scripts/deploy/4-configure-roles.ts --network optimism
```

### Deploy to Arbitrum

```bash
NETWORK=arbitrum npx hardhat run scripts/deploy/1-deploy-core.ts --network arbitrum
NETWORK=arbitrum npx hardhat run scripts/deploy/2-deploy-psm.ts --network arbitrum
NETWORK=arbitrum npx hardhat run scripts/deploy/3-deploy-bridge.ts --network arbitrum
NETWORK=arbitrum npx hardhat run scripts/deploy/4-configure-roles.ts --network arbitrum
```

### Test on Mainnet

```bash
# Mint OkuUSD on Optimism
NETWORK=optimism AMOUNT=1000 npx hardhat run scripts/interactions/mint-okuusd.ts --network optimism

# Check balances across all chains
npx hardhat run scripts/interactions/check-balances.ts
```

## Script Details

### Orchestration Scripts (Recommended)

#### `deploy-and-test.ts` 🚀
**Complete deployment and testing in one command**

Orchestrates the entire flow:
1. Checks network connectivity
2. Deploys all contracts (core, PSM, bridge)
3. Configures all roles and permissions
4. Gets USDC for testing (fork only)
5. Runs full interaction suite (mint, wrap, rebalance)
6. Verifies balances at each step

**Usage:**
```bash
# Fork testing
npx hardhat run scripts/deploy-and-test.ts --network localhost

# Or specify network explicitly
NETWORK=localhost npx hardhat run scripts/deploy-and-test.ts --network localhost
```

**Best for:** Quick iteration, CI/CD pipelines, developer onboarding

#### `deploy-all.ts` 📦
**Deploy all contracts (no testing)**

Deploys and configures all contracts, then stops:
1. Checks network connectivity
2. Deploys all contracts
3. Configures roles

**Usage:**
```bash
# Fork testing
npx hardhat run scripts/deploy-all.ts --network localhost

# Mainnet deployment
NETWORK=optimism npx hardhat run scripts/deploy-all.ts --network optimism
```

**Best for:** Production deployments, when you want to test interactions manually

### Deployment Scripts

#### 1. `deploy/1-deploy-core.ts`
Deploys core contracts in dependency order:
1. **OkuUSD**: Rebase token with RBAC
2. **wOkuUSD**: ERC4626 wrapper for OkuUSD
3. **RedemptionQueue**: Queue for PSM redemptions

All contracts deployed as UUPS proxies.

#### 2. `deploy/2-deploy-psm.ts`
Deploys **LitePSM**: Peg stability module for minting/redeeming OkuUSD with USDC.

Requires: OkuUSD, RedemptionQueue, USDC addresses.

#### 3. `deploy/3-deploy-bridge.ts`
Deploys **OkuBridgeRouter**: Cross-chain bridge router for wOkuUSD.

**Note**: Adapters not configured (third-party bridge integration deferred).

#### 4. `deploy/4-configure-roles.ts`
Configures all necessary roles:
- **OkuUSD**: Grant MINTER_ROLE to LitePSM and RedemptionQueue
- **RedemptionQueue**: Grant PSM_ROLE to LitePSM
- **LitePSM**: Grant BUFFER_DEPOSITOR_ROLE to admin
- **OkuBridgeRouter**: Grant ADAPTER_MANAGER_ROLE to admin

Also configures minter allowances (1 billion tokens each).

### Interaction Scripts

#### `interactions/mint-okuusd.ts`
Mint OkuUSD from USDC via LitePSM.

**Environment variables**:
- `NETWORK`: Target network (default: localhost)
- `AMOUNT`: USDC amount to mint (default: 1000)

**Flow**:
1. Approve USDC to LitePSM
2. Call `LitePSM.mint(recipient, usdcAmount)`
3. Receive OkuUSD 1:1 (accounting for decimal difference)

#### `interactions/wrap-okuusd.ts`
Wrap OkuUSD to wOkuUSD (ERC4626 deposit).

**Environment variables**:
- `NETWORK`: Target network (default: localhost)
- `AMOUNT`: OkuUSD amount to wrap (default: 1000)

**Flow**:
1. Approve OkuUSD to wOkuUSD
2. Call `wOkuUSD.deposit(amount, recipient)`
3. Receive wOkuUSD shares (proportional to current rate)

#### `interactions/rebalance.ts`
Update reward multiplier (rebase) on OkuUSD.

**Environment variables**:
- `NETWORK`: Target network (default: localhost)
- `MULTIPLIER`: New multiplier (default: 1.05 for 5% yield)

**Requirements**:
- Caller must have REBASER_ROLE
- New multiplier must be strictly greater than current

**Effect**: All OkuUSD balances increase proportionally.

#### `interactions/check-balances.ts`
Query OkuUSD and wOkuUSD balances across all deployed networks.

**No environment variables required**.

Shows:
- OkuUSD balance
- wOkuUSD shares and equivalent okuUSD value
- Current reward multiplier
- wOkuUSD conversion rate

### E2E Scripts

#### `e2e/full-flow.ts`
Orchestrates complete happy path:
1. Deploy all contracts (1-4)
2. Mint 10,000 OkuUSD
3. Wrap 5,000 to wOkuUSD
4. Rebalance (5% yield)
5. Verify final balances

Uses `execSync()` to chain scripts sequentially.

## Deployed Addresses

All deployed contract addresses are saved to `config/addresses.json`:

```json
{
  "optimism": {
    "OkuUSD": "0x...",
    "wOkuUSD": "0x...",
    "RedemptionQueue": "0x...",
    "LitePSM": "0x...",
    "OkuBridgeRouter": "0x..."
  },
  "arbitrum": {
    "OkuUSD": "0x...",
    ...
  }
}
```

This file is auto-generated and should **not** be committed to version control (add to `.gitignore`).

For production deployments, consider storing addresses in a secure location or using a deployment management tool like Hardhat Ignition.

## Testing with USDC on Forks

When testing on forks, you need USDC. We provide two methods:

### Method 1: Deal USDC Directly (Recommended)
```bash
# Deal 100,000 USDC to your account
npx hardhat run scripts/utils/deal-usdc.ts --network localhost

# Custom amount
AMOUNT=50000 npx hardhat run scripts/utils/deal-usdc.ts --network localhost
```

This uses Hardhat's `hardhat_setStorageAt` to directly manipulate the USDC contract's storage, setting your balance. This is:
- Fast and reliable
- Doesn't depend on whale addresses
- Works on any fork

### Method 2: Whale Impersonation (Fallback)
```bash
# Get USDC from a whale account
npx hardhat run scripts/utils/get-usdc-fork.ts --network localhost
```

This impersonates a USDC whale and transfers tokens to you. May fail if whale addresses change or have insufficient balance.

### Method 3: Manual (Hardhat Console)
```bash
npx hardhat console --network localhost
```

```javascript
// Find whale address on Etherscan
const whale = "0x0A59649758aa4d66E25f08Dd01271e891fe52199"; // Coinbase 14
await network.provider.request({
  method: "hardhat_impersonateAccount",
  params: [whale],
});

const usdc = await ethers.getContractAt("IERC20", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
const whaleSigner = await ethers.getSigner(whale);
const [recipient] = await ethers.getSigners();
await usdc.connect(whaleSigner).transfer(recipient.address, ethers.parseUnits("100000", 6));
```

## Verification

After deployment, verify:

1. **Deployment**: All contracts in `addresses.json`
2. **Roles**: Run `hasRole()` checks on contracts
3. **Mint**: User receives OkuUSD after depositing USDC
4. **Wrap**: User receives wOkuUSD shares after depositing OkuUSD
5. **Rebalance**: Balances increase after multiplier update

Use `check-balances.ts` to verify state.

## Troubleshooting

### "could not decode result data" or "No contract found at USDC address"

This means the USDC contract is not available at the expected address. Common causes:

**Solution 1: Use the correct hardhat node command**
```bash
# Stop your current hardhat node (Ctrl+C)
# Start it correctly:
npx hardhat node
```

The `npx hardhat node` command (without `--fork` flag) uses the `hardhat.config.ts` forking settings, which are configured for Optimism.

**Solution 2: Check you're forking the right network**
If you prefer using `--fork` manually:
```bash
npx hardhat node --fork https://mainnet.optimism.io
```

**Solution 3: Specify a recent block number**
```bash
npx hardhat node --fork https://mainnet.optimism.io --fork-block-number 120000000
```

**Solution 4: Verify the fork in hardhat console**
```bash
npx hardhat console --network localhost
```
```javascript
const code = await ethers.provider.getCode("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
console.log("USDC bytecode length:", code.length); // Should be > 2 (not just "0x")
```

### "No address found for contract"
Run deployment scripts first. Check `config/addresses.json` exists and has correct network.

### "Insufficient USDC balance"
On forks: Run `scripts/utils/get-usdc-fork.ts` to get USDC from a whale.
On mainnet: Buy USDC or bridge from another chain.

### "AccessControl: account is missing role"
Run `deploy/4-configure-roles.ts` to grant necessary roles.

### "InvalidMultiplier" on rebalance
New multiplier must be strictly greater than current multiplier. Check current value with `check-balances.ts`.

### "UUPS: unauthorized upgrade"
Caller must have UPGRADE_ROLE. By default, only admin has this role.

## Security Notes

- **Never commit private keys** to version control
- Use hardware wallets or secure key management for mainnet deployments
- Verify all role grants before production deployment
- Test thoroughly on forks before mainnet deployment
- Consider multi-sig for admin roles in production

## Future Enhancements

- Bridge adapter configuration scripts (when third-party integration ready)
- Upgrade scripts for UUPS proxies
- Multi-chain balance aggregation
- Automated gas estimation
- Contract verification on Etherscan
- Integration with deployment management tools (Hardhat Ignition, Foundry)

## License

MIT
