// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OkuNote} from "../src/token/OkuNote.sol";
import {OkuUSD} from "../src/token/OkuUSD.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAggregatorV3} from "./mocks/MockAggregatorV3.sol";

/**
 * @title BaseTest
 * @notice Base test contract with deployment helpers, actors, and utility functions
 * @dev Updated for OkuNote non-rebasing redesign. OkuNote is a standard ERC-20 with
 *      notePrice() tracking price appreciation separately from balanceOf().
 */
abstract contract BaseTest is Test {
    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18; // 1B tokens

    // ============ Contracts ============

    OkuNote public okuNote;
    OkuNote public okuNoteImpl;
    OkuUSD public okuUsd;
    OkuUSD public okuUsdImpl;
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
    address public usdRebaser = makeAddr("usdRebaser");
    address public reserveManager = makeAddr("reserveManager");
    address public blacklister = makeAddr("blacklister");
    address public unblacklister = makeAddr("unblacklister");
    address public capManager = makeAddr("capManager");
    address public allowanceManager = makeAddr("allowanceManager");
    address public queueProcessor = makeAddr("queueProcessor");
    address public bufferDepositor = makeAddr("bufferDepositor");
    address public bufferWithdrawer = makeAddr("bufferWithdrawer");
    address public oracleManager = makeAddr("oracleManager");
    address public adapterManager = makeAddr("adapterManager");
    address public vaultPauser = makeAddr("vaultPauser");
    address public vaultUnpauser = makeAddr("vaultUnpauser");
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");

    // ============ Role Constants ============

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // OkuNote roles
    bytes32 public constant UPGRADER = keccak256("UPGRADER");
    bytes32 public constant NOTE_PAUSER = keccak256("NOTE_PAUSER");
    bytes32 public constant NOTE_UNPAUSER = keccak256("NOTE_UNPAUSER");
    bytes32 public constant MINTER = keccak256("MINTER");
    bytes32 public constant NOTE_REBASER = keccak256("NOTE_REBASER");
    bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");
    bytes32 public constant UNBLACKLISTER = keccak256("UNBLACKLISTER");
    bytes32 public constant CAP_MANAGER = keccak256("CAP_MANAGER");
    bytes32 public constant ALLOWANCE_MANAGER = keccak256("ALLOWANCE_MANAGER");

    // OkuUSD vault roles
    bytes32 public constant USD_REBASER = keccak256("USD_REBASER");
    bytes32 public constant RESERVE_MANAGER = keccak256("RESERVE_MANAGER");
    bytes32 public constant VAULT_PAUSER = keccak256("VAULT_PAUSER");
    bytes32 public constant VAULT_UNPAUSER = keccak256("VAULT_UNPAUSER");

    // LitePSM roles
    bytes32 public constant PSM_UPGRADER = keccak256("PSM_UPGRADER");
    bytes32 public constant PSM_PAUSER = keccak256("PSM_PAUSER");
    bytes32 public constant PSM_UNPAUSER = keccak256("PSM_UNPAUSER");
    bytes32 public constant QUEUE_PROCESSOR = keccak256("QUEUE_PROCESSOR");
    bytes32 public constant BUFFER_DEPOSITOR = keccak256("BUFFER_DEPOSITOR");
    bytes32 public constant BUFFER_WITHDRAWER = keccak256("BUFFER_WITHDRAWER");
    bytes32 public constant ORACLE_MANAGER = keccak256("ORACLE_MANAGER");

    // RedemptionQueue roles
    bytes32 public constant PSM = keccak256("PSM");

    // OkuBridge roles
    bytes32 public constant BRIDGE_UPGRADER = keccak256("BRIDGE_UPGRADER");

    // OkuBridgeRouter roles
    bytes32 public constant ROUTER_UPGRADER = keccak256("ROUTER_UPGRADER");
    bytes32 public constant ROUTER_PAUSER = keccak256("ROUTER_PAUSER");
    bytes32 public constant ROUTER_UNPAUSER = keccak256("ROUTER_UNPAUSER");
    bytes32 public constant ADAPTER_MANAGER = keccak256("ADAPTER_MANAGER");
    bytes32 public constant BRIDGE_MANAGER = keccak256("BRIDGE_MANAGER");

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

        // Deploy OkuNote implementation and proxy
        okuNoteImpl = new OkuNote();
        bytes memory noteInitData =
            abi.encodeCall(OkuNote.initialize, ("OkuNote", "OKUNOTE", admin, MAX_SUPPLY));
        okuNote = OkuNote(address(new ERC1967Proxy(address(okuNoteImpl), noteInitData)));

        // Deploy OkuUSD vault implementation and proxy
        okuUsdImpl = new OkuUSD();
        bytes memory usdInitData = abi.encodeCall(
            OkuUSD.initialize,
            (address(okuNote), "OkuUSD", "OKUSD", admin, 95e16) // 95% min collateral ratio
        );
        okuUsd = OkuUSD(address(new ERC1967Proxy(address(okuUsdImpl), usdInitData)));

        // Deploy RedemptionQueue implementation and proxy
        redemptionQueueImpl = new RedemptionQueue();
        bytes memory queueInitData =
            abi.encodeCall(RedemptionQueue.initialize, (address(okuNote), admin));
        redemptionQueue =
            RedemptionQueue(address(new ERC1967Proxy(address(redemptionQueueImpl), queueInitData)));

        // Deploy LitePSM implementation and proxy
        litePsmImpl = new LitePSM();
        bytes memory psmInitData = abi.encodeCall(
            LitePSM.initialize,
            (address(okuNote), address(okuUsd), address(usdc), address(redemptionQueue), admin)
        );
        litePsm = LitePSM(address(new ERC1967Proxy(address(litePsmImpl), psmInitData)));
    }

    function _setupRoles() internal {
        vm.startPrank(admin);

        // OkuNote roles - Granular RBAC
        okuNote.grantRole(NOTE_PAUSER, pauser);
        okuNote.grantRole(NOTE_UNPAUSER, unpauser);
        okuNote.grantRole(MINTER, minter);
        okuNote.grantRole(MINTER, address(litePsm)); // PSM can mint
        okuNote.grantRole(NOTE_REBASER, rebaser);
        okuNote.grantRole(BLACKLISTER, blacklister);
        okuNote.grantRole(UNBLACKLISTER, unblacklister);
        okuNote.grantRole(CAP_MANAGER, capManager);
        okuNote.grantRole(ALLOWANCE_MANAGER, allowanceManager);

        // OkuUSD vault roles
        okuUsd.grantRole(USD_REBASER, usdRebaser);
        okuUsd.grantRole(RESERVE_MANAGER, reserveManager);
        okuUsd.grantRole(VAULT_PAUSER, vaultPauser);
        okuUsd.grantRole(VAULT_UNPAUSER, vaultUnpauser);

        // LitePSM roles - Granular RBAC
        litePsm.grantRole(PSM_PAUSER, pauser);
        litePsm.grantRole(PSM_UNPAUSER, unpauser);
        litePsm.grantRole(QUEUE_PROCESSOR, queueProcessor);
        litePsm.grantRole(BUFFER_DEPOSITOR, bufferDepositor);
        litePsm.grantRole(BUFFER_WITHDRAWER, bufferWithdrawer);
        litePsm.grantRole(ORACLE_MANAGER, oracleManager);

        // RedemptionQueue roles
        redemptionQueue.grantRole(PSM, address(litePsm));

        // Grant RedemptionQueue MINTER role on OkuNote (needed for self-burn in processQueue)
        okuNote.grantRole(MINTER, address(redemptionQueue));

        vm.stopPrank();
    }

    function _setupMinterAllowances() internal {
        vm.startPrank(allowanceManager);
        okuNote.configureMinterAllowance(minter, MAX_SUPPLY);
        okuNote.configureMinterAllowance(address(litePsm), MAX_SUPPLY);
        okuNote.configureMinterAllowance(address(redemptionQueue), MAX_SUPPLY);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Mint OkuNote tokens to a user (raw token amount, no share conversion)
    function _mintOkuNote(address to, uint256 amount) internal {
        vm.prank(minter);
        okuNote.mint(to, amount);
    }

    /// @notice Mint OkuUSD tokens to a user via wrap flow (price-aware)
    function _mintOkuUsd(address to, uint256 noteAmount) internal {
        // Mint notes to the to address first
        _mintOkuNote(to, noteAmount);
        // Approve vault to pull notes
        vm.startPrank(to);
        IERC20(address(okuNote)).approve(address(okuUsd), noteAmount);
        // Wrap notes into OkuUSD
        okuUsd.wrap(noteAmount, to);
        vm.stopPrank();
    }

    /// @notice Mint USDC tokens to a user
    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    /// @notice Approve OkuNote spending
    function _approveOkuNote(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        okuNote.approve(spender, amount);
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

    /// @notice Override bound() to suppress "Bound result" console logs
    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    /// @notice Bound fuzz input to reasonable mint amount
    function _boundMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - okuNote.totalSupply();
        return bound(amount, 1, remaining > 0 ? remaining : 1);
    }

    /// @notice Bound fuzz input to reasonable notePrice (current to 10x)
    function _boundNotePrice(uint256 price) internal view returns (uint256) {
        uint256 current = okuNote.notePrice();
        return bound(price, current, current * 10);
    }

    /// @notice Bound fuzz input to reasonable notePrice increase (0.01% to 100%)
    function _boundNotePriceIncrease(uint256 increase) internal view returns (uint256) {
        uint256 current = okuNote.notePrice();
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
