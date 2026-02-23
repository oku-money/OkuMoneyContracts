// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OkuUSD} from "../src/token/OkuUSD.sol";
import {wOkuUSD} from "../src/token/wOkuUSD.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAggregatorV3} from "./mocks/MockAggregatorV3.sol";

/**
 * @title BaseTest
 * @notice Base test contract with deployment helpers, actors, and utility functions
 */
abstract contract BaseTest is Test {
    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18; // 1B tokens

    // ============ Contracts ============

    OkuUSD public okuUsd;
    OkuUSD public okuUsdImpl;
    wOkuUSD public wokuUsd;
    wOkuUSD public wokuUsdImpl;
    LitePSM public litePsm;
    LitePSM public litePsmImpl;
    RedemptionQueue public redemptionQueue;
    RedemptionQueue public redemptionQueueImpl;
    MockUSDC public usdc;
    MockAggregatorV3 public oracle;

    // ============ Actors ============

    address public admin = makeAddr("admin");
    address public pauser = makeAddr("pauser");
    address public unpauser = makeAddr("unpauser");
    address public minter = makeAddr("minter");
    address public rebaser = makeAddr("rebaser");
    address public blacklister = makeAddr("blacklister");
    address public unblacklister = makeAddr("unblacklister");
    address public capManager = makeAddr("capManager");
    address public allowanceManager = makeAddr("allowanceManager");
    address public queueProcessor = makeAddr("queueProcessor");
    address public bufferDepositor = makeAddr("bufferDepositor");
    address public bufferWithdrawer = makeAddr("bufferWithdrawer");
    address public oracleManager = makeAddr("oracleManager");
    address public adapterManager = makeAddr("adapterManager");
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");

    // ============ Role Constants ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // OkuUSD roles
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant REBASER_ROLE = keccak256("REBASER_ROLE");
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");
    bytes32 public constant UNBLACKLISTER_ROLE = keccak256("UNBLACKLISTER_ROLE");
    bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
    bytes32 public constant ALLOWANCE_MANAGER_ROLE = keccak256("ALLOWANCE_MANAGER_ROLE");

    // LitePSM roles
    bytes32 public constant PSM_UPGRADER_ROLE = keccak256("PSM_UPGRADER_ROLE");
    bytes32 public constant PSM_PAUSER_ROLE = keccak256("PSM_PAUSER_ROLE");
    bytes32 public constant PSM_UNPAUSER_ROLE = keccak256("PSM_UNPAUSER_ROLE");
    bytes32 public constant QUEUE_PROCESSOR_ROLE = keccak256("QUEUE_PROCESSOR_ROLE");
    bytes32 public constant BUFFER_DEPOSITOR_ROLE = keccak256("BUFFER_DEPOSITOR_ROLE");
    bytes32 public constant BUFFER_WITHDRAWER_ROLE = keccak256("BUFFER_WITHDRAWER_ROLE");
    bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");

    // RedemptionQueue roles
    bytes32 public constant PSM_ROLE = keccak256("PSM_ROLE");

    // OkuBridgeRouter roles
    bytes32 public constant ROUTER_UPGRADER_ROLE = keccak256("ROUTER_UPGRADER_ROLE");
    bytes32 public constant ROUTER_PAUSER_ROLE = keccak256("ROUTER_PAUSER_ROLE");
    bytes32 public constant ROUTER_UNPAUSER_ROLE = keccak256("ROUTER_UNPAUSER_ROLE");
    bytes32 public constant ADAPTER_MANAGER_ROLE = keccak256("ADAPTER_MANAGER_ROLE");

    // ============ Setup ============

    function setUp() public virtual {
        _deployContracts();
        _setupRoles();
        _setupMinterAllowances();
    }

    function _deployContracts() internal {
        // Deploy mocks
        usdc = new MockUSDC();
        oracle = new MockAggregatorV3();

        // Deploy OkuUSD implementation and proxy
        okuUsdImpl = new OkuUSD();
        bytes memory okuInitData =
            abi.encodeCall(OkuUSD.initialize, ("OkuUSD", "OKUSD", admin, MAX_SUPPLY));
        okuUsd = OkuUSD(address(new ERC1967Proxy(address(okuUsdImpl), okuInitData)));

        // Deploy wOkuUSD implementation and proxy
        wokuUsdImpl = new wOkuUSD();
        bytes memory wokuInitData = abi.encodeCall(
            wOkuUSD.initialize, (IERC20(address(okuUsd)), "Wrapped OkuUSD", "wOKUSD", admin)
        );
        wokuUsd = wOkuUSD(address(new ERC1967Proxy(address(wokuUsdImpl), wokuInitData)));

        // Deploy RedemptionQueue implementation and proxy
        redemptionQueueImpl = new RedemptionQueue();
        bytes memory queueInitData =
            abi.encodeCall(RedemptionQueue.initialize, (address(okuUsd), admin));
        redemptionQueue =
            RedemptionQueue(address(new ERC1967Proxy(address(redemptionQueueImpl), queueInitData)));

        // Deploy LitePSM implementation and proxy
        litePsmImpl = new LitePSM();
        bytes memory psmInitData = abi.encodeCall(
            LitePSM.initialize, (address(okuUsd), address(usdc), address(redemptionQueue), admin)
        );
        litePsm = LitePSM(address(new ERC1967Proxy(address(litePsmImpl), psmInitData)));
    }

    function _setupRoles() internal {
        vm.startPrank(admin);

        // OkuUSD roles - Granular RBAC
        okuUsd.grantRole(PAUSER_ROLE, pauser);
        okuUsd.grantRole(UNPAUSER_ROLE, unpauser);
        okuUsd.grantRole(MINTER_ROLE, minter);
        okuUsd.grantRole(MINTER_ROLE, address(litePsm)); // PSM can mint
        okuUsd.grantRole(REBASER_ROLE, rebaser);
        okuUsd.grantRole(BLACKLISTER_ROLE, blacklister);
        okuUsd.grantRole(UNBLACKLISTER_ROLE, unblacklister);
        okuUsd.grantRole(CAP_MANAGER_ROLE, capManager);
        okuUsd.grantRole(ALLOWANCE_MANAGER_ROLE, allowanceManager);

        // LitePSM roles - Granular RBAC
        litePsm.grantRole(PSM_PAUSER_ROLE, pauser);
        litePsm.grantRole(PSM_UNPAUSER_ROLE, unpauser);
        litePsm.grantRole(QUEUE_PROCESSOR_ROLE, queueProcessor);
        litePsm.grantRole(BUFFER_DEPOSITOR_ROLE, bufferDepositor);
        litePsm.grantRole(BUFFER_WITHDRAWER_ROLE, bufferWithdrawer);
        litePsm.grantRole(ORACLE_MANAGER_ROLE, oracleManager);

        // RedemptionQueue roles
        redemptionQueue.grantRole(PSM_ROLE, address(litePsm));

        vm.stopPrank();
    }

    function _setupMinterAllowances() internal {
        vm.startPrank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, MAX_SUPPLY);
        okuUsd.configureMinterAllowance(address(litePsm), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Mint OkuUSD tokens to a user
    function _mintOkuUsd(address to, uint256 amount) internal {
        vm.prank(minter);
        okuUsd.mint(to, amount);
    }

    /// @notice Mint USDC tokens to a user
    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @notice Approve OkuUSD spending
    function _approveOkuUsd(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuUsd.approve(spender, amount);
    }

    /// @notice Approve USDC spending
    function _approveUsdc(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usdc.approve(spender, amount);
    }

    /// @notice Calculate expected shares from tokens at current multiplier
    function _tokensToShares(uint256 tokens) internal view returns (uint256) {
        return (tokens * PRECISION) / okuUsd.rewardMultiplier();
    }

    /// @notice Calculate expected tokens from shares at current multiplier
    function _sharesToTokens(uint256 shares) internal view returns (uint256) {
        return (shares * okuUsd.rewardMultiplier()) / PRECISION;
    }

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    /// @notice Bound fuzz input to reasonable mint amount
    function _boundMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - okuUsd.totalSupply();
        return bound(amount, 1, remaining > 0 ? remaining : 1);
    }

    /// @notice Bound fuzz input to reasonable multiplier (current to 10x)
    function _boundMultiplier(uint256 multiplier) internal view returns (uint256) {
        uint256 current = okuUsd.rewardMultiplier();
        return bound(multiplier, current, current * 10);
    }

    /// @notice Bound fuzz input to reasonable multiplier increase (0.01% to 100%)
    function _boundMultiplierIncrease(uint256 increase) internal view returns (uint256) {
        uint256 current = okuUsd.rewardMultiplier();
        return bound(increase, current / 10_000, current);
    }

    /// @notice Get minimum of two values
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Get maximum of two values
    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
