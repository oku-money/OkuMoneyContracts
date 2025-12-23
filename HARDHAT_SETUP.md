# Hardhat + Foundry Dual Setup

This project now supports both **Foundry** (primary) and **Hardhat** (simulation testing) in a single repository.

## Setup Summary

### What Was Added

1. **Node.js/TypeScript Configuration**
   - `package.json` - npm dependencies and scripts
   - `tsconfig.json` - TypeScript compiler configuration
   - `.env.example` - Environment variable template

2. **Hardhat Configuration**
   - `hardhat.config.ts` - Full Hardhat configuration with:
     - Solidity 0.8.28, Cancun EVM (matches Foundry)
     - Network configs for mainnet, Arbitrum, Base, Optimism
     - TypeChain integration for type-safe contract interactions
     - hardhat-deploy for advanced deployments
     - Gas reporting and Etherscan verification

3. **Directory Structure**
   ```
   test/hardhat/           # Hardhat tests (TypeScript)
   ├── integration/        # Integration tests
   ├── fork/              # Mainnet fork tests
   └── simulation/        # Complex scenario tests
   deploy/                 # hardhat-deploy scripts
   scripts/               # Utility scripts (TypeScript)
   typechain-types/       # Generated TypeChain types
   ```

4. **Example Files**
   - `test/hardhat/integration/example.test.ts` - Comprehensive test suite
   - `deploy/001_deploy_core.ts` - Deployment script for OkuUSD core
   - `scripts/verify-setup.ts` - Setup verification tool
   - `src/test/TestProxy.sol` - Test helper for proxy deployments

## Key Features

### Type-Safe Contract Interactions

TypeChain generates TypeScript types for all contracts:

```typescript
import { OkuUSD, WOkuUSD } from "../typechain-types";

// Full type safety and autocomplete
const factory = await ethers.getContractFactory("OkuUSD");
const okuUSD: OkuUSD = await factory.deploy();

// Type-safe method calls
await okuUSD.mint(user.address, amount); // autocomplete works!
const balance = await okuUSD.balanceOf(user.address); // returns BigInt
```

### Network Forking for Realistic Tests

Test against real on-chain state:

```typescript
// In hardhat.config.ts, uncomment:
forking: {
  url: process.env.MAINNET_RPC_URL || "",
  blockNumber: 18000000,
}

// Then run tests against forked mainnet
npx hardhat test
```

### Dual Testing Strategy

**Foundry (Fast Unit/Fuzz Tests)**:
```bash
forge test                 # Run all Foundry tests
forge test -vvv           # Verbose output
forge test --gas-report   # Gas usage report
```

**Hardhat (Integration/Simulation Tests)**:
```bash
npm run test              # Run Hardhat tests
npm run test:gas          # With gas reporting
npm run test:all          # Both Foundry and Hardhat
```

## Available npm Scripts

```bash
# Compilation
npm run compile           # Compile with Hardhat (generates TypeChain)

# Testing
npm run test             # Run Hardhat tests
npm run test:forge       # Run Foundry tests
npm run test:hardhat     # Run Hardhat tests
npm run test:all         # Run both Foundry and Hardhat tests
npm run test:gas         # Run with gas reporting

# Deployment
npm run deploy            # Deploy to local network
npm run deploy:sepolia    # Deploy to Sepolia testnet
npm run deploy:local      # Deploy to localhost

# Development
npm run node              # Start local Hardhat node
npm run node:fork         # Start node forked from mainnet
npm run verify-setup      # Verify setup is working
npm run clean             # Clean all artifacts
```

## Test Results

All 12 integration tests passing:

```
✔ Deployment - should deploy with correct initial state
✔ Deployment - should have correct admin roles
✔ Minting & Burning - should mint tokens correctly
✔ Minting & Burning - should burn tokens correctly
✔ Minting & Burning - should enforce minter allowance
✔ Minting & Burning - should enforce supply cap
✔ Rebasing - should increase balances when multiplier increases
✔ Rebasing - should not allow multiplier to decrease
✔ ERC4626 Wrapper - should wrap OkuUSD into wOkuUSD
✔ ERC4626 Wrapper - should maintain value through rebase
✔ Transfers - should transfer tokens correctly
✔ Transfers - should respect blacklist

12 passing (1s)
```

## File Organization

### Contracts (Shared)
Both Foundry and Hardhat compile from `src/`:
```
src/
├── token/              # OkuUSD, wOkuUSD
├── psm/                # LitePSM, RedemptionQueue
├── bridge/             # Bridge router and adapters
└── test/               # Test helpers (TestProxy)
```

### Tests (Separated)
```
test/
├── hardhat/            # Hardhat tests (TypeScript)
│   ├── integration/
│   ├── fork/
│   └── simulation/
└── *.t.sol            # Foundry tests (Solidity) - TBD
```

### Build Outputs (Separate Caches)
```
artifacts/              # Shared build artifacts (both tools)
cache_hardhat/          # Hardhat cache (separate from Foundry)
typechain-types/        # Generated TypeScript types
out/                    # Foundry output (if different from artifacts)
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
# Required for deployments
PRIVATE_KEY=your_private_key_here

# Required for forking and deployments
MAINNET_RPC_URL=https://eth.llamarpc.com
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
BASE_RPC_URL=https://mainnet.base.org

# Required for contract verification
ETHERSCAN_API_KEY=your_etherscan_api_key
ARBISCAN_API_KEY=your_arbiscan_api_key
BASESCAN_API_KEY=your_basescan_api_key

# Optional for gas reporting
COINMARKETCAP_API_KEY=your_coinmarketcap_api_key
REPORT_GAS=true
```

## Compiler Compatibility

Both tools use identical compiler settings:

| Setting | Value |
|---------|-------|
| Solidity Version | 0.8.28 |
| EVM Version | cancun |
| Optimizer | Enabled (200 runs) |
| OpenZeppelin | Imported from node_modules |

## Dependencies

### Foundry Dependencies (Git Submodules)
- `lib/forge-std` - Foundry standard library
- `lib/openzeppelin-contracts` - OpenZeppelin contracts
- `lib/openzeppelin-contracts-upgradeable` - OZ upgradeable

### Hardhat Dependencies (npm)
- `hardhat` - Ethereum development environment
- `@nomicfoundation/hardhat-toolbox` - All-in-one plugin
- `hardhat-deploy` - Advanced deployment system
- `typechain` + `@typechain/hardhat` - Type generation
- `ethers` v6 - Ethereum library
- TypeScript + ts-node - TypeScript support

## Writing Tests

### Hardhat Test Example

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { OkuUSD } from "../../../typechain-types";

describe("OkuUSD", function () {
  let okuUSD: OkuUSD;

  beforeEach(async function () {
    const [deployer, admin] = await ethers.getSigners();

    // Deploy implementation
    const OkuUSDFactory = await ethers.getContractFactory("OkuUSD");
    const impl = await OkuUSDFactory.deploy();

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("TestProxy");
    const initData = OkuUSDFactory.interface.encodeFunctionData("initialize", [
      "OkuUSD",
      "okuUSD",
      admin.address,
      ethers.parseUnits("1000000000", 18),
    ]);
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);

    okuUSD = OkuUSDFactory.attach(await proxy.getAddress()) as OkuUSD;
  });

  it("should mint tokens", async function () {
    const [, admin, user] = await ethers.getSigners();
    const amount = ethers.parseUnits("1000", 18);

    // Grant minter role and allowance
    const MINTER_ROLE = await okuUSD.MINTER_ROLE();
    await okuUSD.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await okuUSD.connect(admin).configureMinterAllowance(admin.address, amount);

    // Mint tokens
    await okuUSD.connect(admin).mint(user.address, amount);

    expect(await okuUSD.balanceOf(user.address)).to.equal(amount);
  });
});
```

### Foundry Test Example (for future)

```solidity
// test/OkuUSD.t.sol
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OkuUSD} from "../src/token/OkuUSD.sol";

contract OkuUSDTest is Test {
    OkuUSD public okuUSD;
    address admin = makeAddr("admin");
    address user = makeAddr("user");

    function setUp() public {
        // Deploy with proxy...
        okuUSD = new OkuUSD();
        okuUSD.initialize("OkuUSD", "okuUSD", admin, 1_000_000_000e18);
    }

    function test_Mint() public {
        uint256 amount = 1000e18;

        // Setup
        vm.startPrank(admin);
        okuUSD.grantRole(okuUSD.MINTER_ROLE(), admin);
        okuUSD.configureMinterAllowance(admin, amount);

        // Mint
        okuUSD.mint(user, amount);
        vm.stopPrank();

        assertEq(okuUSD.balanceOf(user), amount);
    }
}
```

## Next Steps

1. **Add Foundry Tests**
   - Create `.t.sol` test files in `test/`
   - Use for unit tests and fuzz testing
   - Leverage Foundry's speed for rapid iteration

2. **Add Fork Tests**
   - Create fork tests in `test/hardhat/fork/`
   - Test against real mainnet state
   - Verify integration with actual DeFi protocols

3. **Add Multi-Chain Tests**
   - Test cross-chain bridging flows
   - Fork multiple networks simultaneously
   - Verify state consistency across chains

4. **Create Deployment Scripts**
   - Expand `deploy/` with network-specific scripts
   - Use hardhat-deploy's tagging system
   - Create upgrade scripts for UUPS proxies

5. **Add Gas Benchmarks**
   - Compare gas costs between implementations
   - Track gas usage over time
   - Optimize hot paths

## Troubleshooting

### TypeChain types not generated
```bash
npx hardhat clean
npx hardhat compile
```

### Tests timing out
Increase timeout in `hardhat.config.ts`:
```typescript
mocha: {
  timeout: 300000, // 5 minutes
}
```

### Foundry still works?
```bash
forge build
forge test
```

Yes! Both tools work side by side.

### Need to reinstall dependencies?
```bash
npm install          # npm dependencies
forge install        # Foundry dependencies (git submodules)
```

## Documentation

- [Hardhat](https://hardhat.org/docs)
- [Foundry](https://book.getfoundry.sh/)
- [TypeChain](https://github.com/dethcrypto/TypeChain)
- [hardhat-deploy](https://github.com/wighawag/hardhat-deploy)
- [Ethers v6](https://docs.ethers.org/v6/)
