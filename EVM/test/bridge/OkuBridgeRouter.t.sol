// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";
import {MockOkuBridge} from "../mocks/MockOkuBridge.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title OkuBridgeRouterTest
 * @notice Tests for OkuBridgeRouter covering both bridge paths:
 *
 *   NATIVE PATH  — bridge_OkuUSD / bridge_OkuNote -> OkuBridge.bridgeBurn()
 *   ADAPTER PATH — bridgeWrappedVia / bridgeVia -> IBridgeAdapter.bridge()
 */
contract OkuBridgeRouterTest is BaseTest {
    OkuBridgeRouter public bridgeRouter;
    OkuBridgeRouter public bridgeRouterImpl;

    // Native OkuBridge instance (used by native path)
    OkuBridge public okuBridgeContract;
    OkuBridge public okuBridgeImpl;

    // Mock adapter (used by adapter path)
    MockOkuBridge public mockAdapter;

    address public orchestratorSigner;
    uint256 public orchestratorPk;
    address public feeRecipient;

    uint256 public constant ARBITRUM_CHAIN_ID = 42_161;
    uint256 public constant OPTIMISM_CHAIN_ID = 10;

    // Bridge roles (for OkuBridge)
    bytes32 public constant BRIDGE_SIGNER_MANAGER = keccak256("BRIDGE_SIGNER_MANAGER");
    bytes32 public constant BRIDGE_FEE_MANAGER = keccak256("BRIDGE_FEE_MANAGER");

    // Events from OkuBridge
    event BridgeBurn(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 shares,
        uint256 nonce,
        uint256 deadline
    );

    // Events from OkuBridgeRouter
    event BridgeInitiated(
        address indexed user,
        address indexed adapter,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );
    event NativeBridgeInitiated(
        address indexed user,
        bytes32 indexed requestId,
        uint256 amount,
        uint256 destinationChain,
        bytes32 recipient
    );
    event AdapterConfigured(address indexed adapter, bool supported);
    event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);

    function setUp() public override {
        super.setUp();

        orchestratorPk = 0xA11CE;
        orchestratorSigner = vm.addr(orchestratorPk);
        feeRecipient = makeAddr("feeRecipient");

        // Deploy OkuBridge (native bridge) — operates on OkuNote
        okuBridgeImpl = new OkuBridge();
        bytes memory bridgeInitData = abi.encodeCall(
            OkuBridge.initialize, (address(okuNote), orchestratorSigner, feeRecipient, admin)
        );
        okuBridgeContract =
            OkuBridge(address(new ERC1967Proxy(address(okuBridgeImpl), bridgeInitData)));

        // Deploy OkuBridgeRouter — references OkuUSD vault and OkuNote base token
        bridgeRouterImpl = new OkuBridgeRouter();
        bytes memory routerInitData = abi.encodeCall(
            OkuBridgeRouter.initialize,
            (address(okuUsd), address(okuNote), address(okuBridgeContract), admin)
        );
        bridgeRouter =
            OkuBridgeRouter(address(new ERC1967Proxy(address(bridgeRouterImpl), routerInitData)));

        // Deploy mock adapter (for adapter path tests) — operates on OkuNote
        mockAdapter = new MockOkuBridge(okuNote, minter);

        vm.startPrank(admin);

        // Grant OkuBridge MINTER role on OkuNote — it burns from router (native path) and mints fees
        okuNote.grantRole(MINTER, address(okuBridgeContract));

        // Grant router MINTER role on OkuNote — it burns OkuNote directly (adapter path)
        okuNote.grantRole(MINTER, address(bridgeRouter));

        // Register mock adapter for adapter path tests
        bridgeRouter.configureAdapter(address(mockAdapter), true);

        vm.stopPrank();

        // Grant OkuBridge minter allowance on OkuNote for fee minting
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(address(okuBridgeContract), MAX_SUPPLY);

        // Grant router minter allowance on OkuNote (needed for adapter path burn)
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(address(bridgeRouter), MAX_SUPPLY);
    }

    // ============ Initialization Tests ============

    function test_Initialize() public view {
        assertEq(address(bridgeRouter.okuUsd()), address(okuUsd));
        assertEq(address(bridgeRouter.okuNote()), address(okuNote));
        assertEq(address(bridgeRouter.okuBridge()), address(okuBridgeContract));
        assertTrue(bridgeRouter.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_UPGRADER, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_PAUSER, admin));
        assertTrue(bridgeRouter.hasRole(ADAPTER_MANAGER, admin));
        assertTrue(bridgeRouter.hasRole(BRIDGE_MANAGER, admin));
    }

    function test_Initialize_RevertZeroAddresses() public {
        OkuBridgeRouter impl = new OkuBridgeRouter();

        // Zero okuUsd
        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize,
                (address(0), address(okuNote), address(okuBridgeContract), admin)
            )
        );

        // Zero okuNote
        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize,
                (address(okuUsd), address(0), address(okuBridgeContract), admin)
            )
        );

        // Zero okuBridge
        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize, (address(okuUsd), address(okuNote), address(0), admin)
            )
        );
    }

    // ============ Adapter Configuration Tests ============

    function test_ConfigureAdapter() public {
        address newAdapter = makeAddr("newAdapter");

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit AdapterConfigured(newAdapter, true);
        bridgeRouter.configureAdapter(newAdapter, true);

        assertTrue(bridgeRouter.supportedAdapters(newAdapter));
    }

    function test_ConfigureAdapter_Remove() public {
        vm.prank(admin);
        bridgeRouter.configureAdapter(address(mockAdapter), false);
        assertFalse(bridgeRouter.supportedAdapters(address(mockAdapter)));
    }

    function test_ConfigureAdapter_RevertIfNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ADAPTER_MANAGER
            )
        );
        bridgeRouter.configureAdapter(makeAddr("adapter"), true);
    }

    function test_UpdateOkuBridge() public {
        address newBridge = makeAddr("newBridge");
        address oldBridge = address(okuBridgeContract);

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit OkuBridgeUpdated(oldBridge, newBridge);
        bridgeRouter.updateOkuBridge(newBridge);

        assertEq(address(bridgeRouter.okuBridge()), newBridge);
    }

    function test_UpdateOkuBridge_RevertZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        bridgeRouter.updateOkuBridge(address(0));
    }

    function test_UpdateOkuBridge_RevertIfNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BRIDGE_MANAGER
            )
        );
        bridgeRouter.updateOkuBridge(makeAddr("bridge"));
    }

    // ============ Pause Tests ============

    function test_Pause() public {
        vm.prank(admin);
        bridgeRouter.pause();
        assertTrue(bridgeRouter.paused());
    }

    function test_Unpause() public {
        vm.prank(admin);
        bridgeRouter.pause();
        vm.prank(admin);
        bridgeRouter.unpause();
        assertFalse(bridgeRouter.paused());
    }

    function test_Pause_RevertIfNotPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ROUTER_PAUSER
            )
        );
        bridgeRouter.pause();
    }

    function test_Unpause_RevertNotUnpauser() public {
        vm.prank(admin);
        bridgeRouter.pause();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ROUTER_UNPAUSER
            )
        );
        bridgeRouter.unpause();
    }

    // ============ Native Path: bridge_OkuNote ============

    function test_BridgeOkuNote_Success() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);

        // Expect BridgeBurn from OkuBridge (the canonical native path event)
        vm.expectEmit(false, true, false, false, address(okuBridgeContract));
        emit BridgeBurn(
            bytes32(0),
            address(bridgeRouter),
            bytes32(uint256(uint160(user2))),
            0,
            ARBITRUM_CHAIN_ID,
            0,
            0,
            0
        );

        bytes32 requestId = bridgeRouter.bridge_OkuNote(
            noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // Router holds no OkuNote
        assertEq(okuNote.balanceOf(address(bridgeRouter)), 0);
        // User has no OkuNote
        assertEq(okuNote.balanceOf(user1), 0);
        // requestId is non-zero
        assertNotEq(requestId, bytes32(0));
        // Fee recipient received fee in OkuNote
        assertGt(okuNote.balanceOf(feeRecipient), 0);
        // Nonce incremented on OkuBridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_BridgeOkuNote_EmitsNativeBridgeInitiated() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);

        vm.expectEmit(true, false, false, false, address(bridgeRouter));
        emit NativeBridgeInitiated(
            user1, bytes32(0), noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );

        bridgeRouter.bridge_OkuNote(noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuNote_RevertWhenPaused() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridge_OkuNote(noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuNote_RevertInvalidRecipient() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridge_OkuNote(noteAmount, ARBITRUM_CHAIN_ID, bytes32(0));
        vm.stopPrank();
    }

    function test_BridgeOkuNote_FeeCollected() public {
        // Set bridge fee to 1% for clear arithmetic
        vm.prank(admin);
        okuBridgeContract.updateFee(100); // 100 bps = 1%

        uint256 noteAmount = 10_000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bridgeRouter.bridge_OkuNote(noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Fee recipient should have received exactly 1% in OkuNote
        uint256 feeBalance = okuNote.balanceOf(feeRecipient);
        assertGt(feeBalance, 0);
        uint256 currentFee = okuBridgeContract.bridgeFee(); // 100 bps
        assertEq(feeBalance, noteAmount * currentFee / 10_000);
    }

    function test_BridgeOkuNote_SharesPreservedAcrossRebase() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        // Rebase OkuNote: 20% increase
        uint256 newMultiplier = PRECISION * 12 / 10;
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(newMultiplier);

        // User's balance grew with rebase
        uint256 rebasedBalance = okuNote.balanceOf(user1);
        assertGt(rebasedBalance, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), rebasedBalance);
        bridgeRouter.bridge_OkuNote(
            rebasedBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // OkuBridge processed the bridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
        // Router holds no residual OkuNote (at most 1 wei rounding dust)
        assertLe(okuNote.balanceOf(address(bridgeRouter)), 1);
    }

    // ============ Native Path: bridge_OkuUSD ============

    function test_BridgeOkuUSD_Success() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);

        vm.expectEmit(false, true, false, false, address(okuBridgeContract));
        emit BridgeBurn(
            bytes32(0),
            address(bridgeRouter),
            bytes32(uint256(uint160(user2))),
            0,
            ARBITRUM_CHAIN_ID,
            0,
            0,
            0
        );

        bytes32 requestId = bridgeRouter.bridge_OkuUSD(
            usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // User has no OkuUSD
        assertEq(okuUsd.balanceOf(user1), 0);
        // Router holds no OkuUSD or OkuNote
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);
        assertLe(okuNote.balanceOf(address(bridgeRouter)), 1);
        // requestId is non-zero
        assertNotEq(requestId, bytes32(0));
        // Nonce incremented on OkuBridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_BridgeOkuUSD_EmitsNativeBridgeInitiated() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);

        vm.expectEmit(true, false, false, false, address(bridgeRouter));
        emit NativeBridgeInitiated(
            user1, bytes32(0), usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );

        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuUSD_RevertWhenPaused() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuUSD_RevertInvalidRecipient() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(0));
        vm.stopPrank();
    }

    function test_BridgeOkuUSD_UnwrapsToNotesAndBridges() public {
        // Verify the full flow: OkuUSD -> unwrap to notes -> bridge notes via OkuBridge
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        uint256 noteSupplyBefore = okuNote.totalSupply();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Notes were burned (net reduction = amount minus fee reminted to feeRecipient)
        uint256 noteSupplyAfter = okuNote.totalSupply();
        uint256 feeBalance = okuNote.balanceOf(feeRecipient);
        // totalSupply decreased by the burned amount and increased by fee mint
        // so: noteSupplyBefore - noteAmount + feeBalance ~= noteSupplyAfter (within rounding)
        assertLe(noteSupplyAfter, noteSupplyBefore);
        assertGt(feeBalance, 0);
    }

    function test_BridgeOkuUSD_AfterNoteRebase() public {
        // OkuNote rebase should not affect OkuUSD bridging (OkuUSD has independent multiplier)
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);

        // Rebase OkuNote only (note multiplier increases, OkuUSD vault becomes overcollateralized)
        uint256 newNoteMultiplier = PRECISION * 11 / 10; // 10% note rebase
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(newNoteMultiplier);

        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);
        assertLe(okuNote.balanceOf(address(bridgeRouter)), 1);
    }

    function test_BridgeOkuUSD_FeeCollected() public {
        // Set bridge fee to 1% for clear arithmetic
        vm.prank(admin);
        okuBridgeContract.updateFee(100); // 100 bps = 1%

        uint256 noteAmount = 10_000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Fee recipient should have received fee in OkuNote (bridge operates on notes)
        uint256 feeBalance = okuNote.balanceOf(feeRecipient);
        assertGt(feeBalance, 0);
    }

    // ============ Adapter Path: bridgeVia ============

    function test_BridgeVia_Success() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);

        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockAdapter), noteAmount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeVia(noteAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // OkuNote burned
        assertEq(okuNote.balanceOf(user1), 0);
        // Router holds no OkuNote (burned before adapter call)
        assertEq(okuNote.balanceOf(address(bridgeRouter)), 0);
        // Adapter received the call with OkuNote token address
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.token, address(okuNote));
        assertEq(pending.amount, noteAmount);
        assertEq(pending.destinationChain, ARBITRUM_CHAIN_ID);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeVia_RevertWhenPaused() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeVia(noteAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeVia_RevertUnsupportedAdapter() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);
        address unsupported = makeAddr("unsupported");

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridgeRouter.UnsupportedAdapter.selector, unsupported)
        );
        bridgeRouter.bridgeVia(noteAmount, unsupported, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeVia_RevertInvalidRecipient() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeVia(noteAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, address(0));
        vm.stopPrank();
    }

    // ============ Adapter Path: bridgeWrappedVia ============

    function test_BridgeWrappedVia_Success() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);

        // The router unwraps OkuUSD to notes, then burns the notes
        // Adapter receives noteAmount (dollar-for-dollar unwrap)
        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockAdapter), noteAmount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // OkuUSD gone
        assertEq(okuUsd.balanceOf(user1), 0);
        // Router holds no OkuNote or OkuUSD (notes burned before adapter call)
        assertEq(okuNote.balanceOf(address(bridgeRouter)), 0);
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);
        // Adapter received the call with OkuNote token address
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.token, address(okuNote));
        assertEq(pending.amount, noteAmount);
        assertEq(pending.destinationChain, ARBITRUM_CHAIN_ID);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeWrappedVia_RevertWhenPaused() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_RevertUnsupportedAdapter() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);
        address unsupported = makeAddr("unsupported");

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridgeRouter.UnsupportedAdapter.selector, unsupported)
        );
        bridgeRouter.bridgeWrappedVia(usdBalance, unsupported, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_RevertInvalidRecipient() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeWrappedVia(
            usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, address(0)
        );
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_CorrectAmountAfterNoteRebase() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);

        // Rebase OkuNote: 10% increase (vault becomes overcollateralized)
        uint256 newMultiplier = PRECISION + (PRECISION / 10);
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(newMultiplier);

        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Unwrap is dollar-for-dollar, so noteAmount returned = usdBalance
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, usdBalance);
    }

    // ============ Full Round-Trip Tests (Native Path) ============

    function test_FullRoundTrip_NativePath_OkuNote() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bridgeRouter.bridge_OkuNote(noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Verify nonce incremented (full EIP-712 round-trip covered in OkuBridge.t.sol)
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_FullRoundTrip_NativePath_OkuUSD() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridge_OkuUSD(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_FullRoundTrip_AdapterPath() public {
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        // Bridge via adapter
        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bridgeRouter.bridgeVia(noteAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Complete bridge on destination (mock mints OkuNote to recipient)
        mockAdapter.completeBridge(0);

        // User2 received OkuNote on destination
        uint256 user2NoteBalance = okuNote.balanceOf(user2);
        assertEq(user2NoteBalance, noteAmount);
    }

    function test_FullRoundTrip_AdapterPath_MultipleUsers() public {
        uint256 amount1 = 1000e18;
        uint256 amount2 = 2000e18;
        uint256 amount3 = 500e18;

        _mintOkuNote(user1, amount1);
        _mintOkuNote(user2, amount2);
        _mintOkuNote(user3, amount3);

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), amount1);
        bridgeRouter.bridgeVia(amount1, address(mockAdapter), ARBITRUM_CHAIN_ID, dest1);
        vm.stopPrank();

        vm.startPrank(user2);
        okuNote.approve(address(bridgeRouter), amount2);
        bridgeRouter.bridgeVia(amount2, address(mockAdapter), OPTIMISM_CHAIN_ID, dest2);
        vm.stopPrank();

        vm.startPrank(user3);
        okuNote.approve(address(bridgeRouter), amount3);
        bridgeRouter.bridgeVia(amount3, address(mockAdapter), ARBITRUM_CHAIN_ID, dest3);
        vm.stopPrank();

        mockAdapter.completeBridge(0);
        mockAdapter.completeBridge(1);
        mockAdapter.completeBridge(2);

        assertEq(okuNote.balanceOf(dest1), amount1);
        assertEq(okuNote.balanceOf(dest2), amount2);
        assertEq(okuNote.balanceOf(dest3), amount3);
    }

    // ============ Fuzz Tests ============

    function testFuzz_BridgeOkuNote_NativePath(uint256 noteAmount) public {
        // Bound noteAmount within [minBridgeShares, maxBridgeShares] — at 1:1 multiplier shares == tokens
        noteAmount = bound(
            noteAmount, okuBridgeContract.minBridgeShares(), okuBridgeContract.maxBridgeShares()
        );
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bytes32 requestId = bridgeRouter.bridge_OkuNote(
            noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // Router holds no OkuNote
        assertLe(okuNote.balanceOf(address(bridgeRouter)), 1);
        assertEq(okuNote.balanceOf(user1), 0);
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeOkuUSD_NativePath(uint256 noteAmount) public {
        noteAmount = bound(
            noteAmount, okuBridgeContract.minBridgeShares(), okuBridgeContract.maxBridgeShares()
        );
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bytes32 requestId = bridgeRouter.bridge_OkuUSD(
            usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        assertEq(okuUsd.balanceOf(user1), 0);
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);
        assertLe(okuNote.balanceOf(address(bridgeRouter)), 1);
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeVia_AmountConsistency(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e18, 100_000_000e18);
        _mintOkuNote(user1, noteAmount);

        uint256 supplyBefore = okuNote.totalSupply();

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bridgeRouter.bridgeVia(noteAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Exact amount burned
        assertEq(okuNote.totalSupply(), supplyBefore - noteAmount);
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, noteAmount);
    }

    function testFuzz_BridgeWrappedVia_AmountConsistency(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e18, 100_000_000e18);
        _mintOkuUsd(user1, noteAmount);
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Adapter received the unwrapped note amount
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, usdBalance); // dollar-for-dollar unwrap
    }

    function testFuzz_BridgeWrappedVia_AfterNoteRebase(
        uint256 depositAmount,
        uint256 multiplierIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        multiplierIncrease = _boundMultiplierIncrease(multiplierIncrease);

        _mintOkuUsd(user1, depositAmount);

        // Rebase OkuNote (makes vault overcollateralized)
        uint256 newMultiplier = okuNote.rewardMultiplier() + multiplierIncrease;
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(newMultiplier);

        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        // Unwrap is dollar-for-dollar, so amount should equal usdBalance
        assertEq(pending.amount, usdBalance);
    }

    function testFuzz_AdapterPath_RoundTripValueLoss(uint256 amount) public {
        // Round-trip through adapter bridge: mint notes -> bridge -> complete -> receive notes
        // Should lose at most 1 wei (rounding in adapter path is minimal since burn/mint are direct)
        amount = bound(amount, 1e18, 100_000_000e18);

        _mintOkuNote(user1, amount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeVia(amount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        mockAdapter.completeBridge(0);
        uint256 receivedNote = okuNote.balanceOf(user2);

        // Exact round-trip (no wrapping involved, direct burn/mint)
        assertEq(receivedNote, amount);
    }

    // ============ UUPS Upgrade Tests ============

    function test_UUPS_UpgradeRouter() public {
        OkuBridgeRouter newImpl = new OkuBridgeRouter();

        vm.prank(admin);
        bridgeRouter.upgradeToAndCall(address(newImpl), "");

        // State preserved
        assertEq(address(bridgeRouter.okuUsd()), address(okuUsd));
        assertEq(address(bridgeRouter.okuNote()), address(okuNote));
        assertEq(address(bridgeRouter.okuBridge()), address(okuBridgeContract));
    }

    function test_UUPS_UpgradeRouter_RevertNotUpgrader() public {
        OkuBridgeRouter newImpl = new OkuBridgeRouter();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, ROUTER_UPGRADER
            )
        );
        bridgeRouter.upgradeToAndCall(address(newImpl), "");
    }
}
