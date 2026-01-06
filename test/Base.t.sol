// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
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

    OkuUSD public okuUSD;
    OkuUSD public okuUSDImpl;
    wOkuUSD public wokuUSD;
    wOkuUSD public wokuUSDImpl;
    LitePSM public litePSM;
    LitePSM public litePSMImpl;
    RedemptionQueue public redemptionQueue;
    RedemptionQueue public redemptionQueueImpl;
    MockUSDC public usdc;
    MockAggregatorV3 public oracle;

    // ============ Actors ============

    address public admin = makeAddr("admin");
    address public pauser = makeAddr("pauser");
    address public minter = makeAddr("minter");
    address public operator = makeAddr("operator");
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");

    // ============ Role Constants ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PSM_ROLE = keccak256("PSM_ROLE");

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
        okuUSDImpl = new OkuUSD();
        bytes memory okuInitData = abi.encodeCall(
            OkuUSD.initialize,
            ("OkuUSD", "OKUSD", admin, MAX_SUPPLY)
        );
        okuUSD = OkuUSD(address(new ERC1967Proxy(address(okuUSDImpl), okuInitData)));

        // Deploy wOkuUSD implementation and proxy
        wokuUSDImpl = new wOkuUSD();
        bytes memory wokuInitData = abi.encodeCall(
            wOkuUSD.initialize,
            (IERC20(address(okuUSD)), "Wrapped OkuUSD", "wOKUSD", admin)
        );
        wokuUSD = wOkuUSD(address(new ERC1967Proxy(address(wokuUSDImpl), wokuInitData)));

        // Deploy RedemptionQueue implementation and proxy
        redemptionQueueImpl = new RedemptionQueue();
        bytes memory queueInitData = abi.encodeCall(
            RedemptionQueue.initialize,
            (address(okuUSD), admin)
        );
        redemptionQueue = RedemptionQueue(
            address(new ERC1967Proxy(address(redemptionQueueImpl), queueInitData))
        );

        // Deploy LitePSM implementation and proxy
        litePSMImpl = new LitePSM();
        bytes memory psmInitData = abi.encodeCall(
            LitePSM.initialize,
            (address(okuUSD), address(usdc), address(redemptionQueue), admin)
        );
        litePSM = LitePSM(address(new ERC1967Proxy(address(litePSMImpl), psmInitData)));
    }

    function _setupRoles() internal {
        vm.startPrank(admin);

        // OkuUSD roles
        okuUSD.grantRole(PAUSER_ROLE, pauser);
        okuUSD.grantRole(MINTER_ROLE, minter);
        okuUSD.grantRole(MINTER_ROLE, address(litePSM)); // PSM can mint

        // LitePSM roles
        litePSM.grantRole(PAUSER_ROLE, pauser);
        litePSM.grantRole(OPERATOR_ROLE, operator);

        // RedemptionQueue roles
        redemptionQueue.grantRole(PSM_ROLE, address(litePSM));

        vm.stopPrank();
    }

    function _setupMinterAllowances() internal {
        vm.startPrank(admin);
        okuUSD.configureMinterAllowance(minter, MAX_SUPPLY);
        okuUSD.configureMinterAllowance(address(litePSM), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Mint OkuUSD tokens to a user
    function _mintOkuUSD(address to, uint256 amount) internal {
        vm.prank(minter);
        okuUSD.mint(to, amount);
    }

    /// @notice Mint USDC tokens to a user
    function _mintUSDC(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @notice Approve OkuUSD spending
    function _approveOkuUSD(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuUSD.approve(spender, amount);
    }

    /// @notice Approve USDC spending
    function _approveUSDC(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usdc.approve(spender, amount);
    }

    /// @notice Calculate expected shares from tokens at current multiplier
    function _tokensToShares(uint256 tokens) internal view returns (uint256) {
        return (tokens * PRECISION) / okuUSD.rewardMultiplier();
    }

    /// @notice Calculate expected tokens from shares at current multiplier
    function _sharesToTokens(uint256 shares) internal view returns (uint256) {
        return (shares * okuUSD.rewardMultiplier()) / PRECISION;
    }

    /// @notice Bound fuzz input to reasonable mint amount
    function _boundMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - okuUSD.totalSupply();
        return bound(amount, 1, remaining > 0 ? remaining : 1);
    }

    /// @notice Bound fuzz input to reasonable multiplier (current to 10x)
    function _boundMultiplier(uint256 multiplier) internal view returns (uint256) {
        uint256 current = okuUSD.rewardMultiplier();
        return bound(multiplier, current, current * 10);
    }

    /// @notice Bound fuzz input to reasonable multiplier increase (0.01% to 100%)
    function _boundMultiplierIncrease(uint256 increase) internal view returns (uint256) {
        uint256 current = okuUSD.rewardMultiplier();
        return bound(increase, current / 10000, current);
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
