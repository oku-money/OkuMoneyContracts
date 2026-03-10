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
 *
 * @dev OkuNote is non-rebasing. notePrice() tracks price appreciation separately
 *      from balanceOf(). Token amounts are passed directly to the bridge — no share
 *      conversion is needed.
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
        uint256 amount,
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

    function test_BridgeOkuNote_TokenAmountsPreservedAcrossNotePrice() public {
        // OkuNote is non-rebasing: notePrice changes do NOT affect balanceOf().
        // The exact token amount is passed through to the bridge.
        uint256 noteAmount = 1000e18;
        _mintOkuNote(user1, noteAmount);

        // Increase notePrice by 20% — user's balance is unchanged
        uint256 newPrice = okuNote.notePrice() * 12 / 10;
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

        // User's balance is unchanged (non-rebasing)
        uint256 userBalance = okuNote.balanceOf(user1);
        assertEq(userBalance, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bridgeRouter.bridge_OkuNote(noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // OkuBridge processed the bridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
        // Router holds no residual OkuNote (exact, no rounding)
        assertEq(okuNote.balanceOf(address(bridgeRouter)), 0);
        // User's OkuNote fully consumed
        assertEq(okuNote.balanceOf(user1), 0);
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
        // Verify the full flow: OkuUSD -> unwrap to notes (price-aware) -> bridge notes via OkuBridge
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

    function test_BridgeOkuUSD_AfterNotePriceIncrease() public {
        // notePrice increase does NOT change OkuNote balances (non-rebasing).
        // OkuUSD unwrap is price-aware: same OkuUSD amount yields fewer notes
        // when notePrice is higher (each note is worth more).
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);

        // Increase notePrice by 10%
        uint256 newPrice = okuNote.notePrice() * 11 / 10;
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

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

        // At initial notePrice=1e18, unwrapping usdBalance returns noteAmount notes
        uint256 expectedNotes = (usdBalance * okuUsd.usdMultiplier()) / okuNote.notePrice();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);

        // The router unwraps OkuUSD to notes (price-aware), then burns the notes
        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockAdapter), expectedNotes, ARBITRUM_CHAIN_ID, user2);

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
        assertEq(pending.amount, expectedNotes);
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

    function test_BridgeWrappedVia_FewerNotesAfterNotePriceIncrease() public {
        // After notePrice increases, unwrapping the same OkuUSD amount gives fewer notes
        // because each note is worth more.
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);

        // Increase notePrice by 10%
        uint256 newPrice = okuNote.notePrice() + (okuNote.notePrice() / 10);
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

        uint256 usdBalance = okuUsd.balanceOf(user1);

        // Calculate expected notes from price-aware unwrap:
        // notesReturned = usdAmount × usdMultiplier / notePrice
        uint256 expectedNotes = (usdBalance * okuUsd.usdMultiplier()) / okuNote.notePrice();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        // Fewer notes returned because notePrice increased
        assertLt(pending.amount, noteAmount);
        assertEq(pending.amount, expectedNotes);
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
        // Bound noteAmount within [minBridgeAmount, maxBridgeAmount]
        noteAmount = bound(
            noteAmount, okuBridgeContract.minBridgeAmount(), okuBridgeContract.maxBridgeAmount()
        );
        _mintOkuNote(user1, noteAmount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteAmount);
        bytes32 requestId = bridgeRouter.bridge_OkuNote(
            noteAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // Router holds no OkuNote (exact, no rounding — non-rebasing)
        assertEq(okuNote.balanceOf(address(bridgeRouter)), 0);
        assertEq(okuNote.balanceOf(user1), 0);
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeOkuUSD_NativePath(uint256 noteAmount) public {
        noteAmount = bound(
            noteAmount, okuBridgeContract.minBridgeAmount(), okuBridgeContract.maxBridgeAmount()
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

        // At initial notePrice=1e18 and usdMultiplier=1e18, unwrap is 1:1
        uint256 expectedNotes = (usdBalance * okuUsd.usdMultiplier()) / okuNote.notePrice();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Adapter received the price-aware unwrapped note amount
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, expectedNotes);
    }

    function testFuzz_BridgeWrappedVia_AfterNotePriceUpdate(
        uint256 depositAmount,
        uint256 priceIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        priceIncrease = _boundNotePriceIncrease(priceIncrease);

        _mintOkuUsd(user1, depositAmount);

        // Update notePrice (makes vault overcollateralized — each note worth more)
        uint256 newPrice = okuNote.notePrice() + priceIncrease;
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

        uint256 usdBalance = okuUsd.balanceOf(user1);

        // Price-aware unwrap: notesReturned = usdAmount × usdMultiplier / notePrice
        uint256 expectedNotes = (usdBalance * okuUsd.usdMultiplier()) / okuNote.notePrice();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        // Fewer notes than depositAmount because notePrice increased
        assertLe(pending.amount, depositAmount);
        assertEq(pending.amount, expectedNotes);
    }

    function testFuzz_AdapterPath_RoundTripValueLoss(uint256 amount) public {
        // Round-trip through adapter bridge: mint notes -> bridge -> complete -> receive notes
        // OkuNote is non-rebasing — exact token amounts, no rounding
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
