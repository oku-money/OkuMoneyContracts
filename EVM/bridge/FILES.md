# OkuBridge Implementation Files

## Core Implementation

### Contract
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/src/bridge/OkuBridge.sol`
- **Lines**: 500+
- **Description**: Main bridge contract with burn-and-mint pattern
- **Key Components**:
  - EIP-712 signature verification
  - Burn shares on source chain
  - Mint shares on destination chain
  - Nonce and replay prevention
  - Fee collection mechanism
  - Admin recovery functions (skipNonce, refund)
  - 8 granular RBAC roles

## Test Suites

### Forge Tests (Unit + Integration)
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/test/bridge/OkuBridge.t.sol`
- **Test Count**: 37 tests
- **Coverage**: 93.52% lines, 90.43% branches
- **Categories**:
  - Unit tests for bridgeBurn() (8 tests)
  - Unit tests for bridgeMint() (6 tests)
  - Integration tests with rebase (5 tests)
  - Admin function tests (6 tests)
  - Admin recovery tests (2 tests)
  - EIP-712 signature tests (3 tests)
  - Fuzz tests (3 tests with 256 runs each)
  - Event emission tests (2 tests)

**Run command**: `forge test --match-contract OkuBridgeTest`

### Hardhat Tests (E2E)
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/test/hardhat/bridge/OkuBridge.test.ts`
- **Test Count**: 11 tests across 6 suites
- **Purpose**: E2E testing with ethers.js EIP-712 signature generation
- **Suites**:
  1. EIP-712 Signature Generation (3 tests)
  2. Multi-Chain Simulation (2 tests)
  3. Fee Mechanics (2 tests)
  4. Error Recovery (2 tests)
  5. Gas Measurement (1 test)
  6. Rebase Scenarios (1 test)

**Run command**: `npx hardhat test test/hardhat/bridge/OkuBridge.test.ts`

## Documentation

### Developer Guide (README)
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/bridge/README.md`
- **Contents**:
  - Quick start for users, orchestrators, and admins
  - Architecture diagrams
  - Complete API reference
  - Event and error documentation
  - Security features
  - Deployment guide
  - FAQ

## Related Files

### Base Test Contract
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/test/Base.t.sol`
- **Description**: Base test setup with helpers, actors, and utilities
- **Used By**: OkuBridge.t.sol

### OkuUSD Token
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/src/token/OkuUSD.sol`
- **Description**: Rebasing ERC20 token that bridge mints/burns
- **Interface Used**: mint(), burn(), sharesOf(), sharesToTokens(), tokensToShares()

### Foundry Configuration
- **Path**: `/home/jbarber/gfx/okuMoney/contracts/EVM/foundry.toml`
- **Remappings**:
  - `@openzeppelin/contracts/`
  - `@openzeppelin/contracts-upgradeable/`
  - `forge-std/`

## Test Execution Commands

### Run All Bridge Tests
```bash
forge test --match-contract OkuBridgeTest -vv
```

### Run With Gas Report
```bash
forge test --match-contract OkuBridgeTest --gas-report
```

### Run With Coverage
```bash
forge coverage --match-contract OkuBridgeTest
```

### Run Specific Test
```bash
forge test --match-test test_BridgeBurn_Success -vvv
```

### Run Fuzz Tests Only
```bash
forge test --match-test testFuzz -vv
```

### Run Hardhat Tests
```bash
npx hardhat test test/hardhat/bridge/OkuBridge.test.ts
```

## File Structure

```
contracts/EVM/
├── src/
│   ├── bridge/
│   │   └── OkuBridge.sol              ← Core implementation
│   └── token/
│       └── OkuUSD.sol                 ← Token contract
├── test/
│   ├── bridge/
│   │   └── OkuBridge.t.sol            ← Forge tests
│   ├── hardhat/
│   │   └── bridge/
│   │       └── OkuBridge.test.ts      ← Hardhat tests
│   └── Base.t.sol                     ← Base test setup
├── bridge/
│   ├── README.md                       ← Developer guide
│   └── FILES.md                        ← This file
└── foundry.toml                        ← Foundry config
```

## Dependencies

### OpenZeppelin Contracts
- `Initializable`
- `AccessControlUpgradeable`
- `PausableUpgradeable`
- `EIP712Upgradeable`
- `ECDSA`
- `ERC1967Proxy`

### Foundry
- `forge-std/Test.sol`
- `vm` cheatcodes for testing

### Hardhat
- `@nomicfoundation/hardhat-ethers`
- `ethers` v6
- `chai` for assertions

## Key Metrics

| Metric | Value |
|--------|-------|
| Contract Size | 500+ lines |
| Test Lines | 800+ lines (Forge) + 400+ lines (Hardhat) |
| Total Tests | 48 tests (37 Forge + 11 Hardhat) |
| Fuzz Runs | 768 total (3 tests × 256 runs) |
| Line Coverage | 93.52% |
| Branch Coverage | 90.43% |
| Function Coverage | 86.67% |
| Gas - bridgeBurn() | ~110k |
| Gas - bridgeMint() | ~107k |

## Next Steps

1. **Code Review**: Review implementation for logic issues
2. **Security Audit**: Professional audit before mainnet
3. **Deploy Testnet**: Test on Sepolia/Goerli
4. **Orchestrator**: Implement off-chain orchestrator service
5. **Deploy Mainnet**: After audit completion

## Contact

For questions or issues:
- Review test suites for usage examples
- Check documentation in README.md
- Examine contract source code with inline comments
