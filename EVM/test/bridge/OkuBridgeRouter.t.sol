// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeBaseTest} from "../BridgeBase.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";
import {MockBridgeAdapter} from "../mocks/MockBridgeAdapter.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title OkuBridgeRouterTest
 * @notice Tests for OkuBridgeRouter covering both bridge paths:
 *
 *   NATIVE PATH  — bridge_okuDollar / bridge_OkuM -> OkuBridge.bridgeBurn()
 *   ADAPTER PATH — bridgeWrappedVia / bridgeVia -> IBridgeAdapter.bridge()
 *
 * @dev OkuMoney is non-rebasing. okuMMultiplier() tracks multiplier appreciation separately
 *      from balanceOf(). Token amounts are passed directly to the bridge — no share
 *      conversion is needed.
 *
 *      Inherits from BridgeBaseTest which provides:
 *      - All role constants (BRIDGE_*, ROUTER_*, OKUM_*, etc.)
 *      - Chain ID constants (OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID, etc.)
 *      - okuBridge, bridgeRouter, mockAdapter deployments
 */
contract OkuBridgeRouterTest is BridgeBaseTest {
    // Use okuBridge from BridgeBaseTest as okuBridgeContract for clarity in existing tests
    OkuBridge public okuBridgeContract;

    // Events from OkuBridge
    event BridgeBurn(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount,
        uint256 nonce,
        uint256 deadline
    );

    // Events from OkuBridgeRouter
    event BridgeInitiated(
        address indexed user,
        address indexed adapter,
        address sourceToken,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );
    event NativeBridgeInitiated(
        address indexed user,
        bytes32 indexed requestId,
        uint256 inputAmount,
        uint256 bridgedAmount,
        uint256 feeAmount,
        uint256 destinationChain,
        bytes32 recipient
    );
    event AdapterConfigured(address indexed adapter, bool supported);
    event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);

    function setUp() public override {
        super.setUp();

        // Alias okuBridge from BridgeBaseTest to okuBridgeContract for existing test compatibility
        okuBridgeContract = okuBridge;

        // All bridge setup (MINTER roles, allowances, mock adapter registration) is done
        // in BridgeBaseTest.setUp() -> _deployBridgeContracts() and _setupBridgeRoles()
    }

    // ============ Initialization Tests ============

    function test_Initialize() public view {
        assertEq(address(bridgeRouter.okuDollar()), address(okuDollar));
        assertEq(address(bridgeRouter.okuMoney()), address(okuMoney));
        assertEq(address(bridgeRouter.okuBridge()), address(okuBridgeContract));
        assertTrue(bridgeRouter.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_UPGRADER, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_PAUSER, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_ADAPTER_MANAGER, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_BRIDGE_MANAGER, admin));
    }

    function test_Initialize_RevertZeroAddresses() public {
        OkuBridgeRouter impl = new OkuBridgeRouter();

        // Zero okuDollar
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize,
                (address(0), address(okuMoney), address(okuBridgeContract), admin)
            )
        );

        // Zero okuMoney
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize,
                (address(okuDollar), address(0), address(okuBridgeContract), admin)
            )
        );

        // Zero okuBridge
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize,
                (address(okuDollar), address(okuMoney), address(0), admin)
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
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                ROUTER_ADAPTER_MANAGER
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
        vm.expectRevert(Errors.ZeroAddress.selector);
        bridgeRouter.updateOkuBridge(address(0));
    }

    function test_UpdateOkuBridge_RevertIfNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                ROUTER_BRIDGE_MANAGER
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

    // ============ Native Path: bridge_OkuM ============

    function test_BridgeOkuMoney_Success() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);

        // Expect BridgeBurn from OkuBridge (the canonical native path event)
        // Only check indexed sender field, skip other values
        vm.expectEmit(false, true, false, false, address(okuBridgeContract));
        emit BridgeBurn(
            bytes32(0), // requestId
            address(bridgeRouter), // sender (indexed)
            bytes32(uint256(uint160(user2))), // recipient
            0, // sourceChainId
            ARBITRUM_CHAIN_ID, // destChainId
            0, // grossAmount
            0, // netAmount
            0, // feeAmount
            0, // nonce
            0 // deadline
        );

        bytes32 requestId = bridgeRouter.bridgeOkuM(
            okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // Router holds no OkuMoney
        assertEq(okuMoney.balanceOf(address(bridgeRouter)), 0);
        // User has no OkuMoney
        assertEq(okuMoney.balanceOf(user1), 0);
        // requestId is non-zero
        assertNotEq(requestId, bytes32(0));
        // Fee recipient received fee in OkuMoney
        assertGt(okuMoney.balanceOf(feeRecipient), 0);
        // Nonce incremented on OkuBridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_BridgeOkuMoney_EmitsNativeBridgeInitiated() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        uint256 feeBps = okuBridgeContract.bridgeFee();
        uint256 feeAmount = (okuMAmount * feeBps) / 10_000;
        uint256 bridgedAmount = okuMAmount - feeAmount;

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);

        // Only check indexed `user` field (requestId is not known until bridgeBurn executes)
        vm.expectEmit(true, false, false, true, address(bridgeRouter));
        emit NativeBridgeInitiated(
            user1,
            bytes32(0), // requestId — not checked (indexed=false for second param)
            okuMAmount,
            bridgedAmount,
            feeAmount,
            ARBITRUM_CHAIN_ID,
            bytes32(uint256(uint160(user2)))
        );

        bridgeRouter.bridgeOkuM(okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuMoney_RevertWhenPaused() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeOkuM(okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuMoney_RevertInvalidRecipient() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeOkuM(okuMAmount, ARBITRUM_CHAIN_ID, bytes32(0));
        vm.stopPrank();
    }

    function test_BridgeOkuMoney_FeeCollected() public {
        // Set bridge fee to 1% for clear arithmetic
        vm.prank(admin);
        okuBridgeContract.updateFee(100); // 100 bps = 1%

        uint256 okuMAmount = 10_000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        bridgeRouter.bridgeOkuM(okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Fee recipient should have received exactly 1% in OkuMoney
        uint256 feeBalance = okuMoney.balanceOf(feeRecipient);
        assertGt(feeBalance, 0);
        uint256 currentFee = okuBridgeContract.bridgeFee(); // 100 bps
        assertEq(feeBalance, okuMAmount * currentFee / 10_000);
    }

    function test_BridgeOkuMoney_TokenAmountsPreservedAcrossNotePrice() public {
        // OkuMoney is non-rebasing: okuMMultiplier changes do NOT affect balanceOf().
        // The exact token amount is passed through to the bridge.
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        // Increase okuMMultiplier by 20% — user's balance is unchanged
        uint256 newPrice = okuMoney.okuMMultiplier() * 12 / 10;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // User's balance is unchanged (non-rebasing)
        uint256 userBalance = okuMoney.balanceOf(user1);
        assertEq(userBalance, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        bridgeRouter.bridgeOkuM(okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // OkuBridge processed the bridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
        // Router holds no residual OkuMoney (exact, no rounding)
        assertEq(okuMoney.balanceOf(address(bridgeRouter)), 0);
        // User's OkuMoney fully consumed
        assertEq(okuMoney.balanceOf(user1), 0);
    }

    // ============ Native Path: bridge_okuDollar ============

    function test_BridgeOkuDollar_Success() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);

        vm.expectEmit(false, true, false, false, address(okuBridgeContract));
        emit BridgeBurn(
            bytes32(0), // requestId
            address(bridgeRouter), // sender (indexed)
            bytes32(uint256(uint160(user2))), // recipient
            0, // sourceChainId
            ARBITRUM_CHAIN_ID, // destChainId
            0, // grossAmount
            0, // netAmount
            0, // feeAmount
            0, // nonce
            0 // deadline
        );

        bytes32 requestId = bridgeRouter.bridgeUsdOku(
            usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // User has no OkuDollar
        assertEq(okuDollar.balanceOf(user1), 0);
        // Router holds no OkuDollar or OkuMoney
        assertEq(okuDollar.balanceOf(address(bridgeRouter)), 0);
        assertEq(
            okuMoney.balanceOf(address(bridgeRouter)), 0, "router holds no OkuMoney after bridge"
        );
        // requestId is non-zero
        assertNotEq(requestId, bytes32(0));
        // Nonce incremented on OkuBridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_BridgeOkuDollar_EmitsNativeBridgeInitiated() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        // At initial okuMMultiplier=1e18 and usdMultiplier=1e18, unwrap is 1:1
        // okuMFromUnwrap = usdBalance * usdMultiplier / okuMMultiplier = usdBalance
        uint256 okuMFromUnwrap = usdBalance; // 1:1 at base prices
        uint256 feeBps = okuBridgeContract.bridgeFee();
        uint256 feeAmount = (okuMFromUnwrap * feeBps) / 10_000;
        uint256 bridgedAmount = okuMFromUnwrap - feeAmount;

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);

        // Only check indexed `user` field (requestId is not known until bridgeBurn executes)
        vm.expectEmit(true, false, false, true, address(bridgeRouter));
        emit NativeBridgeInitiated(
            user1,
            bytes32(0), // requestId — not checked (indexed=false for second param)
            usdBalance,
            bridgedAmount,
            feeAmount,
            ARBITRUM_CHAIN_ID,
            bytes32(uint256(uint160(user2)))
        );

        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuDollar_RevertWhenPaused() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();
    }

    function test_BridgeOkuDollar_RevertInvalidRecipient() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(0));
        vm.stopPrank();
    }

    function test_BridgeOkuDollar_UnwrapsToNotesAndBridges() public {
        // Verify the full flow: OkuDollar -> unwrap to notes (multiplier-aware) -> bridge notes via OkuBridge
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        uint256 noteSupplyBefore = okuMoney.totalSupply();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Notes were burned (net reduction = amount minus fee reminted to feeRecipient)
        uint256 noteSupplyAfter = okuMoney.totalSupply();
        uint256 feeBalance = okuMoney.balanceOf(feeRecipient);
        // totalSupply decreased by the burned amount and increased by fee mint
        // so: noteSupplyBefore - okuMAmount + feeBalance ~= noteSupplyAfter (within rounding)
        assertLe(noteSupplyAfter, noteSupplyBefore);
        assertGt(feeBalance, 0);
    }

    function test_BridgeOkuDollar_AfterNotePriceIncrease() public {
        // okuMMultiplier increase does NOT change OkuMoney balances (non-rebasing).
        // OkuDollar unwrap is multiplier-aware: same OkuDollar amount yields fewer notes
        // when okuMMultiplier is higher (each note is worth more).
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);

        // Increase okuMMultiplier by 10% and roll to avoid yield distribution lock
        uint256 newPrice = okuMoney.okuMMultiplier() * 11 / 10;
        _setOkuMMultiplierAndRoll(newPrice);

        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
        assertEq(okuDollar.balanceOf(address(bridgeRouter)), 0);
        assertEq(
            okuMoney.balanceOf(address(bridgeRouter)), 0, "router holds no OkuMoney after bridge"
        );
    }

    function test_BridgeOkuDollar_FeeCollected() public {
        // Set bridge fee to 1% for clear arithmetic
        vm.prank(admin);
        okuBridgeContract.updateFee(100); // 100 bps = 1%

        uint256 okuMAmount = 10_000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Fee recipient should have received fee in OkuMoney (bridge operates on notes)
        uint256 feeBalance = okuMoney.balanceOf(feeRecipient);
        assertGt(feeBalance, 0);
    }

    // ============ Adapter Path: bridgeVia ============

    function test_BridgeVia_Success() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);

        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(
            user1, address(mockAdapter), address(okuMoney), okuMAmount, ARBITRUM_CHAIN_ID, user2
        );

        bridgeRouter.bridgeVia(okuMAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // OkuMoney burned
        assertEq(okuMoney.balanceOf(user1), 0);
        // Router holds no OkuMoney (burned before adapter call)
        assertEq(okuMoney.balanceOf(address(bridgeRouter)), 0);
        // Adapter received the call with OkuMoney token address
        MockBridgeAdapter.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.token, address(okuMoney));
        assertEq(pending.amount, okuMAmount);
        assertEq(pending.destinationChain, ARBITRUM_CHAIN_ID);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeVia_RevertWhenPaused() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeVia(okuMAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeVia_RevertUnsupportedAdapter() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);
        address unsupported = makeAddr("unsupported");

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridgeRouter.UnsupportedAdapter.selector, unsupported)
        );
        bridgeRouter.bridgeVia(okuMAmount, unsupported, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeVia_RevertInvalidRecipient() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeVia(okuMAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, address(0));
        vm.stopPrank();
    }

    // ============ Adapter Path: bridgeWrappedVia ============

    function test_BridgeWrappedVia_Success() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        // At initial okuMMultiplier=1e18, unwrapping usdBalance returns okuMAmount notes
        uint256 expectedNotes = (usdBalance * okuDollar.usdMultiplier()) / okuMoney.okuMMultiplier();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);

        // The router unwraps OkuDollar to notes (multiplier-aware), then burns the notes
        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(
            user1, address(mockAdapter), address(okuMoney), expectedNotes, ARBITRUM_CHAIN_ID, user2
        );

        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // OkuDollar gone
        assertEq(okuDollar.balanceOf(user1), 0);
        // Router holds no OkuMoney or OkuDollar (notes burned before adapter call)
        assertEq(okuMoney.balanceOf(address(bridgeRouter)), 0);
        assertEq(okuDollar.balanceOf(address(bridgeRouter)), 0);
        // Adapter received the call with OkuMoney token address
        MockBridgeAdapter.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.token, address(okuMoney));
        assertEq(pending.amount, expectedNotes);
        assertEq(pending.destinationChain, ARBITRUM_CHAIN_ID);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeWrappedVia_RevertWhenPaused() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_RevertUnsupportedAdapter() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);
        address unsupported = makeAddr("unsupported");

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridgeRouter.UnsupportedAdapter.selector, unsupported)
        );
        bridgeRouter.bridgeWrappedVia(usdBalance, unsupported, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_RevertInvalidRecipient() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeWrappedVia(
            usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, address(0)
        );
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_FewerNotesAfterNotePriceIncrease() public {
        // After okuMMultiplier increases, unwrapping the same OkuDollar amount gives fewer notes
        // because each note is worth more.
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);

        // Increase okuMMultiplier by 10% and roll to avoid yield distribution lock
        uint256 newPrice = okuMoney.okuMMultiplier() + (okuMoney.okuMMultiplier() / 10);
        _setOkuMMultiplierAndRoll(newPrice);

        uint256 usdBalance = okuDollar.balanceOf(user1);

        // Calculate expected notes from multiplier-aware unwrap:
        // okuMReturned = usdAmount × usdMultiplier / okuMMultiplier
        uint256 expectedNotes = (usdBalance * okuDollar.usdMultiplier()) / okuMoney.okuMMultiplier();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockBridgeAdapter.PendingBridge memory pending = mockAdapter.getLastBridge();
        // Fewer notes returned because okuMMultiplier increased
        assertLt(pending.amount, okuMAmount);
        assertEq(pending.amount, expectedNotes);
    }

    // ============ Full Round-Trip Tests (Native Path) ============

    function test_FullRoundTrip_NativePath_OkuMoney() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        bridgeRouter.bridgeOkuM(okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        // Verify nonce incremented (full EIP-712 round-trip covered in OkuBridge.t.sol)
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_FullRoundTrip_NativePath_OkuDollar() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeUsdOku(usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2))));
        vm.stopPrank();

        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_FullRoundTrip_AdapterPath() public {
        uint256 okuMAmount = 1000e18;
        _mintOkuMoney(user1, okuMAmount);

        // Bridge via adapter
        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        bridgeRouter.bridgeVia(okuMAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Complete bridge on destination (mock mints OkuMoney to recipient)
        mockAdapter.completeBridge(0);

        // User2 received OkuMoney on destination
        uint256 user2NoteBalance = okuMoney.balanceOf(user2);
        assertEq(user2NoteBalance, okuMAmount);
    }

    function test_FullRoundTrip_AdapterPath_MultipleUsers() public {
        uint256 amount1 = 1000e18;
        uint256 amount2 = 2000e18;
        uint256 amount3 = 500e18;

        _mintOkuMoney(user1, amount1);
        _mintOkuMoney(user2, amount2);
        _mintOkuMoney(user3, amount3);

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), amount1);
        bridgeRouter.bridgeVia(amount1, address(mockAdapter), ARBITRUM_CHAIN_ID, dest1);
        vm.stopPrank();

        vm.startPrank(user2);
        okuMoney.approve(address(bridgeRouter), amount2);
        bridgeRouter.bridgeVia(amount2, address(mockAdapter), OPTIMISM_CHAIN_ID, dest2);
        vm.stopPrank();

        vm.startPrank(user3);
        okuMoney.approve(address(bridgeRouter), amount3);
        bridgeRouter.bridgeVia(amount3, address(mockAdapter), ARBITRUM_CHAIN_ID, dest3);
        vm.stopPrank();

        mockAdapter.completeBridge(0);
        mockAdapter.completeBridge(1);
        mockAdapter.completeBridge(2);

        assertEq(okuMoney.balanceOf(dest1), amount1);
        assertEq(okuMoney.balanceOf(dest2), amount2);
        assertEq(okuMoney.balanceOf(dest3), amount3);
    }

    // ============ Fuzz Tests ============

    function testFuzz_BridgeOkuMoney_NativePath(uint256 okuMAmount) public {
        // Bound okuMAmount within [minBridgeAmount, maxBridgeAmount]
        okuMAmount = bound(
            okuMAmount, okuBridgeContract.minBridgeAmount(), okuBridgeContract.maxBridgeAmount()
        );
        _mintOkuMoney(user1, okuMAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        bytes32 requestId = bridgeRouter.bridgeOkuM(
            okuMAmount, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        // Router holds no OkuMoney (exact, no rounding — non-rebasing)
        assertEq(okuMoney.balanceOf(address(bridgeRouter)), 0);
        assertEq(okuMoney.balanceOf(user1), 0);
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeOkuDollar_NativePath(uint256 okuMAmount) public {
        okuMAmount = bound(
            okuMAmount, okuBridgeContract.minBridgeAmount(), okuBridgeContract.maxBridgeAmount()
        );
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bytes32 requestId = bridgeRouter.bridgeUsdOku(
            usdBalance, ARBITRUM_CHAIN_ID, bytes32(uint256(uint160(user2)))
        );
        vm.stopPrank();

        assertEq(okuDollar.balanceOf(user1), 0);
        assertEq(okuDollar.balanceOf(address(bridgeRouter)), 0);
        assertEq(
            okuMoney.balanceOf(address(bridgeRouter)), 0, "router holds no OkuMoney after bridge"
        );
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeVia_AmountConsistency(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e18, 100_000_000e18);
        _mintOkuMoney(user1, okuMAmount);

        uint256 supplyBefore = okuMoney.totalSupply();

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), okuMAmount);
        bridgeRouter.bridgeVia(okuMAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Exact amount burned
        assertEq(okuMoney.totalSupply(), supplyBefore - okuMAmount);
        MockBridgeAdapter.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, okuMAmount);
    }

    function testFuzz_BridgeWrappedVia_AmountConsistency(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e18, 100_000_000e18);
        _mintUsdOku(user1, okuMAmount);
        uint256 usdBalance = okuDollar.balanceOf(user1);

        // At initial okuMMultiplier=1e18 and usdMultiplier=1e18, unwrap is 1:1
        uint256 expectedNotes = (usdBalance * okuDollar.usdMultiplier()) / okuMoney.okuMMultiplier();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Adapter received the multiplier-aware unwrapped note amount
        MockBridgeAdapter.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, expectedNotes);
    }

    function testFuzz_BridgeWrappedVia_AfterNotePriceUpdate(
        uint256 depositAmount,
        uint256 priceIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        priceIncrease = _boundOkuMMultiplierIncrease(priceIncrease);

        _mintUsdOku(user1, depositAmount);

        // Update okuMMultiplier (makes vault overcollateralized — each note worth more)
        uint256 newPrice = okuMoney.okuMMultiplier() + priceIncrease;
        _setOkuMMultiplierAndRoll(newPrice);

        uint256 usdBalance = okuDollar.balanceOf(user1);

        // Price-aware unwrap: okuMReturned = usdAmount × usdMultiplier / okuMMultiplier
        uint256 expectedNotes = (usdBalance * okuDollar.usdMultiplier()) / okuMoney.okuMMultiplier();

        vm.startPrank(user1);
        okuDollar.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockBridgeAdapter.PendingBridge memory pending = mockAdapter.getLastBridge();
        // Fewer notes than depositAmount because okuMMultiplier increased
        assertLe(pending.amount, depositAmount);
        assertEq(pending.amount, expectedNotes);
    }

    function testFuzz_AdapterPath_RoundTripValueLoss(uint256 amount) public {
        // Round-trip through adapter bridge: mint notes -> bridge -> complete -> receive notes
        // OkuMoney is non-rebasing — exact token amounts, no rounding
        amount = bound(amount, 1e18, 100_000_000e18);

        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeVia(amount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        mockAdapter.completeBridge(0);
        uint256 receivedNote = okuMoney.balanceOf(user2);

        // Exact round-trip (no wrapping involved, direct burn/mint)
        assertEq(receivedNote, amount);
    }

    // ============ UUPS Upgrade Tests ============

    function test_UUPS_UpgradeRouter() public {
        OkuBridgeRouter newImpl = new OkuBridgeRouter();

        vm.prank(admin);
        bridgeRouter.upgradeToAndCall(address(newImpl), "");

        // State preserved
        assertEq(address(bridgeRouter.okuDollar()), address(okuDollar));
        assertEq(address(bridgeRouter.okuMoney()), address(okuMoney));
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

    // ============ sweep() Tests ============

    function test_Sweep_ThirdPartyToken_Success() public {
        // USDC is "third-party" from the router's perspective — it isn't OkuMoney or OkuDollar.
        uint256 stuckAmount = 12_345e6;
        usdc.mint(address(bridgeRouter), stuckAmount);
        assertEq(usdc.balanceOf(address(bridgeRouter)), stuckAmount);

        vm.prank(admin);
        bridgeRouter.sweep(address(usdc), treasury, stuckAmount);

        assertEq(usdc.balanceOf(treasury), stuckAmount);
        assertEq(usdc.balanceOf(address(bridgeRouter)), 0);
    }

    function test_Sweep_RevertOkuMoney() public {
        _mintOkuMoney(address(bridgeRouter), 1e18);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                OkuBridgeRouter.CannotSweepOperationalToken.selector, address(okuMoney)
            )
        );
        bridgeRouter.sweep(address(okuMoney), treasury, 1e18);
    }

    function test_Sweep_RevertOkuDollar() public {
        _mintUsdOku(address(bridgeRouter), 1e18);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                OkuBridgeRouter.CannotSweepOperationalToken.selector, address(okuDollar)
            )
        );
        bridgeRouter.sweep(address(okuDollar), treasury, 1e18);
    }

    function test_Sweep_RevertZeroRecipient() public {
        usdc.mint(address(bridgeRouter), 1e6);

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        bridgeRouter.sweep(address(usdc), address(0), 1e6);
    }

    function test_Sweep_RevertInsufficientBalance() public {
        usdc.mint(address(bridgeRouter), 100e6);

        vm.prank(admin);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        bridgeRouter.sweep(address(usdc), treasury, 101e6);
    }

    function test_Sweep_RevertNotAdmin() public {
        usdc.mint(address(bridgeRouter), 100e6);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, DEFAULT_ADMIN_ROLE
            )
        );
        bridgeRouter.sweep(address(usdc), treasury, 100e6);
    }
}
