# okuMoney Smart Contracts

Modern Foundry/Forge development environment for Ethereum smart contracts.

## Environment

- **Ubuntu**: 22.04.5 LTS
- **GLIBC**: 2.35
- **Foundry**: v1.5.1-nightly (December 22, 2025)
- **Solidity**: 0.8.28
- **EVM**: Cancun
- **Dependencies**:
  - forge-std v1.12.0
  - OpenZeppelin Contracts v5.5.0

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools)
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network
- **Chisel**: Fast, utilitarian, and verbose solidity REPL

## Project Structure

```
contracts/
├── src/                    # Smart contracts (your contracts go here)
├── test/                   # Test files (your tests go here)
├── script/                 # Deployment scripts (your deployment scripts go here)
├── lib/                    # Dependencies
│   ├── forge-std/          # Foundry standard library v1.12.0
│   └── openzeppelin-contracts/  # OpenZeppelin contracts v5.5.0
├── foundry.toml            # Foundry configuration
└── .gitignore              # Git ignore rules
```

## Quick Commands

### Build
```bash
forge build
```

### Test
```bash
# Run all tests
forge test

# Run with verbosity (show console.log)
forge test -vv

# Run with gas reporting
forge test --gas-report

# Run specific test
forge test --match-test test_Increment

# Run with stack traces on failure
forge test -vvvv
```

### Format
```bash
forge fmt
```

### Gas Snapshots
```bash
forge snapshot
```

### Deploy (Local)
```bash
# Terminal 1: Start local node
anvil

# Terminal 2: Deploy contract
forge script script/Counter.s.sol --rpc-url http://localhost:8545 --broadcast
```

### Deploy (Testnet/Mainnet)
```bash
forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key> --broadcast
```

### Cast (Blockchain interaction)
```bash
# Get block number
cast block-number --rpc-url <your_rpc_url>

# Get balance
cast balance <address> --rpc-url <your_rpc_url>

# Call contract
cast call <contract_address> "balanceOf(address)(uint256)" <address> --rpc-url <your_rpc_url>

# Send transaction
cast send <contract_address> "transfer(address,uint256)" <to> <amount> --private-key <your_private_key> --rpc-url <your_rpc_url>
```

## OpenZeppelin Contracts

OpenZeppelin Contracts v5.5.0 is already installed and ready to use!

### Available Contracts

**Token Standards:**
- **ERC20**: Fungible tokens
- **ERC721**: Non-fungible tokens (NFTs)
- **ERC1155**: Multi-token standard
- **ERC6909**: Minimal multi-token

**Access Control:**
- **Ownable**: Single owner access control
- **Ownable2Step**: Two-step ownership transfer
- **AccessControl**: Role-based access control

**Security:**
- **ReentrancyGuard**: Prevent reentrancy attacks
- **Pausable**: Emergency stop mechanism

**Utilities:**
- **SafeERC20**: Safe token operations
- **Address**: Address utility functions
- **Strings**: String operations
- **Math**: Mathematical operations

**Governance:**
- **Governor**: On-chain governance
- **Timelock**: Timelock controller
- **Votes**: Voting power tracking

**Finance:**
- **VestingWallet**: Token vesting
- **PaymentSplitter**: Revenue sharing

### Usage Example

```solidity
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MyToken is ERC20, Ownable {
    constructor() ERC20("My Token", "MTK") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }
}
```

### Installing Additional Dependencies

To install other libraries like Solmate:
```bash
forge install transmissions11/solmate
```

Remappings are configured in `foundry.toml`:
```toml
remappings = [
    "forge-std/=lib/forge-std/src/",
    "@openzeppelin/=lib/openzeppelin-contracts/",
]
```

## Configuration Highlights

The `foundry.toml` is configured with:
- Solidity 0.8.28
- Cancun EVM version
- Optimizer enabled (200 runs)
- Fuzz testing (256 runs)
- Gas reporting enabled
- Code formatting rules

## Additional Commands

```bash
# Update Foundry
foundryup

# Clean build artifacts
forge clean

# Check contract size
forge build --sizes

# Generate documentation
forge doc

# Coverage report
forge coverage

# Interactive Solidity REPL
chisel
```

## Testing Features

The setup includes:
- **Unit tests**: `test_*` functions
- **Fuzz tests**: `testFuzz_*` functions (runs 256 iterations)
- **Gas reporting** for all contracts
- **forge-std library** for testing utilities

## Environment Variables

Create a `.env` file for network deployments (never commit!):

```bash
# Private keys (NEVER COMMIT!)
PRIVATE_KEY=your_private_key_here

# API keys
ETHERSCAN_API_KEY=your_etherscan_key

# RPC URLs
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your-key
```

## Next Steps

1. Create your smart contracts in `src/`
2. Write comprehensive tests in `test/`
3. Create deployment scripts in `script/`
4. Install any additional dependencies as needed
5. Configure `.env` for network deployments (see Environment Variables section)

## Help

```bash
forge --help
anvil --help
cast --help
chisel --help
```

## Documentation

- [Foundry Book](https://book.getfoundry.sh/)
- [Foundry GitHub](https://github.com/foundry-rs/foundry)
- [forge-std Documentation](https://github.com/foundry-rs/forge-std)
- [Solidity Documentation](https://docs.soliditylang.org/)
