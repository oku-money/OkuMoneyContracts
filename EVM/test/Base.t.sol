// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OkuMoney} from "../src/token/OkuMoney.sol";
import {OkuDollar} from "../src/token/OkuDollar.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAggregatorV3} from "./mocks/MockAggregatorV3.sol";

import {TestConstants} from "./shared/Constants.sol";
import {TestRoles} from "./shared/Roles.sol";
import {Actors} from "./shared/Actors.sol";
import {Deploy} from "./shared/Deploy.sol";

/**
 * @title BaseTest
 * @notice Base test contract with deployment helpers, actors, and utility functions
 * @dev Updated for OkuMoney non-rebasing redesign. OkuMoney is a standard ERC-20 with
 *      okuMMultiplier() tracking the dollar value per token separately from balanceOf().
 *      See Constants.sol for terminology legend.
 *
 *      Uses shared scaffolding:
 *      - TestConstants: All numeric constants (re-exported from src + test-only)
 *      - TestRoles: All role keccaks (re-exported from src + DEFAULT_ADMIN_ROLE)
 *      - Actors: Named test actors with deterministic addresses
 *      - Deploy: Proxy deployment helpers
 */
abstract contract BaseTest is Test, Actors {
    // ============ Re-exported Constants ============

    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_SUPPLY = TestConstants.MAX_SUPPLY;
    uint256 public constant DECIMAL_MULTIPLIER = TestConstants.DECIMAL_MULTIPLIER;
    uint256 public constant MAX_RATE = TestConstants.MAX_RATE;
    uint256 public constant BASIS_POINTS = TestConstants.BASIS_POINTS;

    // ============ Re-exported Roles ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = TestRoles.DEFAULT_ADMIN_ROLE;

    // OkuMoney roles (OKUM_ prefix)
    bytes32 public constant OKUM_UPGRADER = TestRoles.OKUM_UPGRADER;
    bytes32 public constant OKUM_PAUSER = TestRoles.OKUM_PAUSER;
    bytes32 public constant OKUM_UNPAUSER = TestRoles.OKUM_UNPAUSER;
    bytes32 public constant OKUM_MINTER = TestRoles.OKUM_MINTER;
    bytes32 public constant OKUM_REBASER = TestRoles.OKUM_REBASER;
    bytes32 public constant OKUM_BLACKLISTER = TestRoles.OKUM_BLACKLISTER;
    bytes32 public constant OKUM_UNBLACKLISTER = TestRoles.OKUM_UNBLACKLISTER;
    bytes32 public constant OKUM_CAP_MANAGER = TestRoles.OKUM_CAP_MANAGER;
    bytes32 public constant OKUM_ALLOWANCE_MANAGER = TestRoles.OKUM_ALLOWANCE_MANAGER;

    // OkuDollar vault roles (VAULT_ prefix)
    bytes32 public constant VAULT_UPGRADER = TestRoles.VAULT_UPGRADER;
    bytes32 public constant VAULT_REBASER = TestRoles.VAULT_REBASER;
    bytes32 public constant VAULT_RESERVE_MANAGER = TestRoles.VAULT_RESERVE_MANAGER;
    bytes32 public constant VAULT_PAUSER = TestRoles.VAULT_PAUSER;
    bytes32 public constant VAULT_UNPAUSER = TestRoles.VAULT_UNPAUSER;

    // LitePSM roles (PSM_ prefix)
    bytes32 public constant PSM_UPGRADER = TestRoles.PSM_UPGRADER;
    bytes32 public constant PSM_PAUSER = TestRoles.PSM_PAUSER;
    bytes32 public constant PSM_UNPAUSER = TestRoles.PSM_UNPAUSER;
    bytes32 public constant PSM_QUEUE_PROCESSOR = TestRoles.PSM_QUEUE_PROCESSOR;
    bytes32 public constant PSM_BUFFER_DEPOSITOR = TestRoles.PSM_BUFFER_DEPOSITOR;
    bytes32 public constant PSM_BUFFER_WITHDRAWER = TestRoles.PSM_BUFFER_WITHDRAWER;
    bytes32 public constant PSM_ORACLE_MANAGER = TestRoles.PSM_ORACLE_MANAGER;

    // RedemptionQueue roles (QUEUE_ prefix)
    bytes32 public constant QUEUE_PSM = TestRoles.QUEUE_PSM;
    bytes32 public constant QUEUE_UPGRADER = TestRoles.QUEUE_UPGRADER;
    bytes32 public constant QUEUE_RESCUER = TestRoles.QUEUE_RESCUER;

    // OkuBridge roles (BRIDGE_ prefix)
    bytes32 public constant BRIDGE_UPGRADER = TestRoles.BRIDGE_UPGRADER;
    bytes32 public constant BRIDGE_DUST_SWEEPER = TestRoles.BRIDGE_DUST_SWEEPER;
    bytes32 public constant BRIDGE_SIGNER_MANAGER = TestRoles.BRIDGE_SIGNER_MANAGER;
    bytes32 public constant BRIDGE_PAUSER = TestRoles.BRIDGE_PAUSER;
    bytes32 public constant BRIDGE_UNPAUSER = TestRoles.BRIDGE_UNPAUSER;
    bytes32 public constant BRIDGE_FEE_MANAGER = TestRoles.BRIDGE_FEE_MANAGER;
    bytes32 public constant BRIDGE_NONCE_ADMIN = TestRoles.BRIDGE_NONCE_ADMIN;
    bytes32 public constant BRIDGE_CHAIN_MANAGER = TestRoles.BRIDGE_CHAIN_MANAGER;
    bytes32 public constant BRIDGE_LIMITS_MANAGER = TestRoles.BRIDGE_LIMITS_MANAGER;
    bytes32 public constant BRIDGE_REFUND_INITIATOR = TestRoles.BRIDGE_REFUND_INITIATOR;
    bytes32 public constant BRIDGE_REFUND_CONFIRMER = TestRoles.BRIDGE_REFUND_CONFIRMER;

    // OkuBridgeRouter roles (ROUTER_ prefix)
    bytes32 public constant ROUTER_UPGRADER = TestRoles.ROUTER_UPGRADER;
    bytes32 public constant ROUTER_PAUSER = TestRoles.ROUTER_PAUSER;
    bytes32 public constant ROUTER_UNPAUSER = TestRoles.ROUTER_UNPAUSER;
    bytes32 public constant ROUTER_ADAPTER_MANAGER = TestRoles.ROUTER_ADAPTER_MANAGER;
    bytes32 public constant ROUTER_BRIDGE_MANAGER = TestRoles.ROUTER_BRIDGE_MANAGER;

    // ============ Contracts ============

    OkuMoney public okuMoney;
    OkuMoney public okuMoneyImpl;
    OkuDollar public usdOku;
    OkuDollar public usdOkuImpl;
    LitePSM public litePsm;
    LitePSM public litePsmImpl;
    RedemptionQueue public redemptionQueue;
    RedemptionQueue public redemptionQueueImpl;
    MockUSDC public usdc;
    MockAggregatorV3 public oracle;

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

        // Deploy OkuMoney
        (okuMoney, okuMoneyImpl) = Deploy.deployOkuMoney(admin);

        // Deploy OkuDollar vault
        (usdOku, usdOkuImpl) = Deploy.deployOkuDollar(address(okuMoney), admin);

        // Deploy RedemptionQueue
        (redemptionQueue, redemptionQueueImpl) =
            Deploy.deployRedemptionQueue(address(okuMoney), admin);

        // Deploy LitePSM
        (litePsm, litePsmImpl) = Deploy.deployLitePSM(
            address(okuMoney), address(usdOku), address(usdc), address(redemptionQueue), admin
        );
    }

    function _setupRoles() internal {
        vm.startPrank(admin);

        // OkuMoney roles - Granular RBAC (OKUM_ prefix)
        okuMoney.grantRole(OKUM_PAUSER, pauser);
        okuMoney.grantRole(OKUM_UNPAUSER, unpauser);
        okuMoney.grantRole(OKUM_MINTER, minter);
        okuMoney.grantRole(OKUM_MINTER, address(litePsm)); // PSM can mint
        okuMoney.grantRole(OKUM_REBASER, rebaser);
        okuMoney.grantRole(OKUM_BLACKLISTER, blacklister);
        okuMoney.grantRole(OKUM_UNBLACKLISTER, unblacklister);
        okuMoney.grantRole(OKUM_CAP_MANAGER, capManager);
        okuMoney.grantRole(OKUM_ALLOWANCE_MANAGER, allowanceManager);

        // OkuDollar vault roles (VAULT_ prefix)
        usdOku.grantRole(VAULT_REBASER, usdRebaser);
        usdOku.grantRole(VAULT_RESERVE_MANAGER, reserveManager);
        usdOku.grantRole(VAULT_PAUSER, vaultPauser);
        usdOku.grantRole(VAULT_UNPAUSER, vaultUnpauser);

        // LitePSM roles - Granular RBAC (PSM_ prefix)
        litePsm.grantRole(PSM_PAUSER, pauser);
        litePsm.grantRole(PSM_UNPAUSER, unpauser);
        litePsm.grantRole(PSM_QUEUE_PROCESSOR, queueProcessor);
        litePsm.grantRole(PSM_BUFFER_DEPOSITOR, bufferDepositor);
        litePsm.grantRole(PSM_BUFFER_WITHDRAWER, bufferWithdrawer);
        litePsm.grantRole(PSM_ORACLE_MANAGER, oracleManager);

        // RedemptionQueue roles (QUEUE_ prefix)
        redemptionQueue.grantRole(QUEUE_PSM, address(litePsm));
        redemptionQueue.grantRole(QUEUE_RESCUER, queueRescuer);

        // Grant RedemptionQueue MINTER role on OkuMoney (needed for self-burn in processQueue)
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        vm.stopPrank();
    }

    function _setupMinterAllowances() internal {
        // allowanceManager has OKUM_ALLOWANCE_MANAGER role on OkuMoney
        vm.startPrank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(litePsm), MAX_SUPPLY);
        okuMoney.configureMinterAllowance(address(redemptionQueue), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Mint OkuMoney tokens to a user (raw token amount, no share conversion)
    function _mintOkuMoney(address to, uint256 amount) internal {
        vm.prank(minter);
        okuMoney.mint(to, amount);
    }

    /// @notice Mint OkuDollar tokens to a user via wrap flow (multiplier-aware)
    function _mintUsdOku(address to, uint256 okuMAmount) internal {
        // Mint OkuMoney to the to address first
        _mintOkuMoney(to, okuMAmount);
        // Approve vault to pull OkuMoney
        vm.startPrank(to);
        IERC20(address(okuMoney)).approve(address(usdOku), okuMAmount);
        // Wrap OkuMoney into OkuDollar (0 minAmountOut for test helpers)
        usdOku.wrap(okuMAmount, to, 0);
        vm.stopPrank();
    }

    /// @notice Mint USDC tokens to a user
    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @notice Approve OkuMoney spending
    function _approveOkuMoney(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuMoney.approve(spender, amount);
    }

    /// @notice Approve OkuDollar spending
    function _approveUsdOku(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usdOku.approve(spender, amount);
    }

    /// @notice Approve USDC spending
    function _approveUsdc(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usdc.approve(spender, amount);
    }

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    /// @notice Bound fuzz input to reasonable mint amount
    function _boundMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - okuMoney.totalSupply();
        return bound(amount, 1, remaining > 0 ? remaining : 1);
    }

    /// @notice Bound fuzz input to reasonable okuMMultiplier (current to 2x)
    /// @dev Tightened from 10x to 2x for more realistic scenarios
    function _boundOkuMMultiplier(uint256 mult) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        return bound(mult, current, current * TestConstants.MAX_MULTIPLIER_FACTOR);
    }

    /// @notice Bound fuzz input to reasonable okuMMultiplier increase (0.01% to 100%)
    function _boundOkuMMultiplierIncrease(uint256 increase) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        return bound(increase, current / 10_000, current);
    }

    /// @notice Bound price to realistic fuzz range (capped at MAX_FUZZ_PRICE)
    function _boundPrice(uint256 price) internal pure returns (uint256) {
        return bound(price, PRECISION, TestConstants.MAX_FUZZ_PRICE);
    }

    /// @notice Get minimum of two values
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Get maximum of two values
    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @notice Set OkuMoney multiplier and roll to next block to avoid yield distribution lock
    /// @dev Use this helper when testing multiplier-aware operations that would be blocked
    ///      in the same block as a multiplier change (sandwich attack prevention).
    function _setOkuMMultiplierAndRoll(uint256 newMultiplier) internal {
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newMultiplier);
        vm.roll(block.number + 1);
    }
}
