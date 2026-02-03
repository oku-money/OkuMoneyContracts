# OkuUSD EVM Implementation

> See `CLAUDE.md` for architecture, business logic, and RBAC design.

This document covers EVM-specific implementation details.

## Stack

- **Language**: Solidity 0.8.x
- **Framework**: Foundry (Forge, Cast, Anvil)
- **Dependencies**: OpenZeppelin Contracts (Upgradeable)
- **Proxy Pattern**: UUPS (UUPSUpgradeable)
- **Oracle**: Chainlink AggregatorV3Interface

## Contract Structure

```
src/
  token/
    OkuUSD.sol              # Rebasing ERC20
    wOkuUSD.sol             # ERC-4626 vault
  psm/
    LitePSM.sol             # USDC ↔ OkuUSD swaps
  bridge/
    OkuBridgeRouter.sol     # Bridge convenience wrapper
    adapters/
      IOkuBridge.sol
      INttManager.sol
      IOFTAdapter.sol
test/
  OkuUSD.t.sol
  wOkuUSD.t.sol
  LitePSM.t.sol
  invariants/
    VaultInvariants.t.sol
    SupplyInvariants.t.sol
script/
  Deploy.s.sol
```

## OkuUSD.sol

**Inherits**: ERC20Upgradeable, AccessControlUpgradeable, PausableUpgradeable

**Storage**:
```solidity
mapping(address => uint256) private _shares;
uint256 public totalShares;
uint256 public rewardMultiplier;  // Scaled by PRECISION (1e18)
uint256 public maxSupply;
mapping(address => uint256) public minterAllowance;
mapping(address => bool) public blacklisted;
```

**Key implementation notes**:
- `balanceOf()` returns `_shares[user] * rewardMultiplier / PRECISION`
- `transfer()` and `transferFrom()` operate on shares, not tokens
- `Transfer` event emits token amounts for ERC20 compatibility
- `_beforeTokenTransfer` checks pause and blacklist status

**Role bytes32 constants**:
```solidity
bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
bytes32 public constant REBASER_ROLE = keccak256("REBASER_ROLE");
bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");
bytes32 public constant UNBLACKLISTER_ROLE = keccak256("UNBLACKLISTER_ROLE");
bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
bytes32 public constant ALLOWANCE_MANAGER_ROLE = keccak256("ALLOWANCE_MANAGER_ROLE");
```

**Critical**: `blacklist()` must NOT use `whenNotPaused` modifier.

## wOkuUSD.sol

**Inherits**: ERC4626Upgradeable, AccessControlUpgradeable

**Standard**: Full ERC-4626 compliance

**Key implementation notes**:
- `asset()` returns OkuUSD address
- `totalAssets()` returns `okuUSD.balanceOf(address(this))`
- Exchange rate grows automatically as underlying OkuUSD rebases
- Rounding: Use `_convertToShares` with rounding down, `_convertToAssets` with rounding down (favor vault)
- No pause functionality—always available as exit path

**Role bytes32 constants**:
```solidity
bytes32 public constant WOKUSD_UPGRADER_ROLE = keccak256("WOKUSD_UPGRADER_ROLE");
```

## LitePSM.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable

**Storage**:
```solidity
IERC20 public usdc;
IOkuUSD public okuUSD;
AggregatorV3Interface public oracle;
uint256 public stalenessThreshold;
uint256 public queueHead;
uint256 public queueTail;
mapping(uint256 => QueueEntry) public redemptionQueue;

struct QueueEntry {
    address user;
    uint256 shares;
    uint256 timestamp;
}
```

**Key implementation notes**:
- `mint()`: USDC in → OkuUSD out (1:1), checks oracle if configured
- `redeem()`: OkuUSD in → USDC out (1:1) or queue if buffer insufficient
- `processQueue()`: FIFO processing, calculates payout at current multiplier
- Oracle check: `oracle.latestRoundData()`, verify `answeredInRound >= roundId` and freshness

**Role bytes32 constants**:
```solidity
bytes32 public constant PSM_PAUSER_ROLE = keccak256("PSM_PAUSER_ROLE");
bytes32 public constant PSM_UNPAUSER_ROLE = keccak256("PSM_UNPAUSER_ROLE");
bytes32 public constant QUEUE_PROCESSOR_ROLE = keccak256("QUEUE_PROCESSOR_ROLE");
bytes32 public constant BUFFER_DEPOSITOR_ROLE = keccak256("BUFFER_DEPOSITOR_ROLE");
bytes32 public constant BUFFER_WITHDRAWER_ROLE = keccak256("BUFFER_WITHDRAWER_ROLE");
bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");
```

## OkuBridgeRouter.sol

**Inherits**: AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable

**Storage**:
```solidity
mapping(address => bool) public supportedAdapters;  // adapter address => supported
```

**Key implementation notes**:
- `bridgeWrapped()`: Unwrap wOkuUSD → bridge OkuUSD
- `bridgeDirect()`: Bridge OkuUSD directly
- Pausable for emergency circuit-breaker functionality
- Stateless—no funds held beyond single tx

**Role bytes32 constants**:
```solidity
bytes32 public constant ROUTER_UPGRADER_ROLE = keccak256("ROUTER_UPGRADER_ROLE");
bytes32 public constant ROUTER_PAUSER_ROLE = keccak256("ROUTER_PAUSER_ROLE");
bytes32 public constant ROUTER_UNPAUSER_ROLE = keccak256("ROUTER_UNPAUSER_ROLE");
bytes32 public constant ADAPTER_MANAGER_ROLE = keccak256("ADAPTER_MANAGER_ROLE");
```

## Proxy Deployment

Each contract deployed behind UUPS (ERC1967Proxy):

```solidity
// Deploy implementation
OkuUSD impl = new OkuUSD();

// Deploy proxy
ERC1967Proxy proxy = new ERC1967Proxy(
    address(impl),
    abi.encodeCall(OkuUSD.initialize, ("OkuUSD", "OKUSD", admin, maxSupply))
);

// Proxy is now upgradeable via upgradeTo() call by UPGRADER_ROLE
```

**Upgrade authority**: Cold Multisig (holder of UPGRADER_ROLE on each contract)

**Key difference from TransparentUpgradeableProxy**: Upgrade logic is in the implementation contract itself, authorized by role-based access control rather than a separate ProxyAdmin.

## Deterministic Deployment

Use CREATE2 via deterministic deployer for same addresses across chains:

```solidity
// Same salt + same bytecode = same address on all EVM chains
bytes32 salt = keccak256("OkuUSD-v1");
address deployed = deployer.deploy(salt, bytecode);
```

## Testing

**Unit tests** (Forge):
```bash
forge test --match-contract OkuUSDTest
```

**Invariant tests** (Forge):
```bash
forge test --match-contract VaultInvariants
```

**Key test scenarios**:
- Mint/burn with allowance tracking
- Rebase affects all balances proportionally
- Wrap/unwrap round-trip accuracy
- Queue entry and processing
- Pause blocks operations, blacklist works while paused
- Oracle staleness rejection
- Role separation enforcement

## Gas Optimization Notes

- Store shares, not balances (one SLOAD for balance calculation)
- Use unchecked math where overflow impossible
- Batch queue processing with gas limit parameter
- Consider ERC20Permit for gasless approvals

## Events

```solidity
// OkuUSD
event RebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
event Blacklisted(address indexed account);
event Unblacklisted(address indexed account);
event MaxSupplyUpdated(uint256 oldCap, uint256 newCap);
event MinterAllowanceUpdated(address indexed minter, uint256 oldAllowance, uint256 newAllowance);

// LitePSM
event Mint(address indexed user, uint256 usdcAmount, uint256 okusdAmount);
event Redeem(address indexed user, uint256 okusdAmount, uint256 usdcAmount);
event RedemptionQueued(address indexed user, uint256 shares, uint256 queuePosition);
event RedemptionProcessed(address indexed user, uint256 shares, uint256 usdcAmount);
event OracleUpdated(address oldOracle, address newOracle);

// OkuBridgeRouter
event BridgeInitiated(address indexed user, address indexed adapter, uint256 amount, uint256 destinationChain, address recipient);
event AdapterConfigured(address indexed adapter, bool supported);
```

## Dependencies

```toml
# foundry.toml
[dependencies]
openzeppelin-contracts-upgradeable = "5.0.0"
```

```bash
forge install OpenZeppelin/openzeppelin-contracts-upgradeable
```