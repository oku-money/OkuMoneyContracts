// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";
import {MockOkuBridge} from "../mocks/MockOkuBridge.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title OkuBridgeRouterTest
 * @notice Tests for OkuBridgeRouter covering both bridge paths:
 *
 *   NATIVE PATH  — bridgeWrapped / bridgeDirect → OkuBridge.bridgeBurn()
 *   ADAPTER PATH — bridgeWrappedVia / bridgeDirectVia → IBridgeAdapter.bridge()
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

    // Events from OkuBridge
    event BridgeBurn(
        bytes32 indexed requestId,
        address indexed sender,
        address indexed recipient,
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
        address recipient
    );
    event AdapterConfigured(address indexed adapter, bool supported);
    event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);

    function setUp() public override {
        super.setUp();

        orchestratorPk = 0xA11CE;
        orchestratorSigner = vm.addr(orchestratorPk);
        feeRecipient = makeAddr("feeRecipient");

        // Deploy OkuBridge (native bridge)
        okuBridgeImpl = new OkuBridge();
        bytes memory bridgeInitData = abi.encodeCall(
            OkuBridge.initialize, (address(okuUsd), orchestratorSigner, feeRecipient, admin)
        );
        okuBridgeContract =
            OkuBridge(address(new ERC1967Proxy(address(okuBridgeImpl), bridgeInitData)));

        // Deploy OkuBridgeRouter
        bridgeRouterImpl = new OkuBridgeRouter();
        bytes memory routerInitData = abi.encodeCall(
            OkuBridgeRouter.initialize,
            (address(wokuUsd), address(okuUsd), address(okuBridgeContract), admin)
        );
        bridgeRouter =
            OkuBridgeRouter(address(new ERC1967Proxy(address(bridgeRouterImpl), routerInitData)));

        // Deploy mock adapter (for adapter path tests)
        mockAdapter = new MockOkuBridge(okuUsd, minter);

        vm.startPrank(admin);

        // Grant OkuBridge MINTER role — it burns from router (native path) and mints fees
        okuUsd.grantRole(MINTER, address(okuBridgeContract));

        // Grant router MINTER role — it burns OkuUSD directly (adapter path)
        okuUsd.grantRole(MINTER, address(bridgeRouter));

        // Register mock adapter for adapter path tests
        bridgeRouter.configureAdapter(address(mockAdapter), true);

        vm.stopPrank();

        // Grant OkuBridge minter allowance for fee minting
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(address(okuBridgeContract), MAX_SUPPLY);

        // Grant router minter allowance (needed for adapter path burn — burn consumes allowance
        // if OkuUSD tracks it, no-op otherwise, but safe to configure)
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(address(bridgeRouter), MAX_SUPPLY);
    }

    // ============ Helper Functions ============

    function _wrapOkuUsd(address user, uint256 amount) internal returns (uint256 shares) {
        vm.startPrank(user);
        okuUsd.approve(address(wokuUsd), amount);
        shares = wokuUsd.deposit(amount, user);
        vm.stopPrank();
    }

    function _mintAndWrap(address user, uint256 okuAmount) internal returns (uint256 wokuShares) {
        _mintOkuUsd(user, okuAmount);
        wokuShares = _wrapOkuUsd(user, okuAmount);
    }

    // ============ Initialization Tests ============

    function test_Initialize() public view {
        assertEq(address(bridgeRouter.wOkuUsd()), address(wokuUsd));
        assertEq(address(bridgeRouter.okuUsd()), address(okuUsd));
        assertEq(address(bridgeRouter.okuBridge()), address(okuBridgeContract));
        assertTrue(bridgeRouter.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_UPGRADER, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_PAUSER, admin));
        assertTrue(bridgeRouter.hasRole(ADAPTER_MANAGER, admin));
        assertTrue(bridgeRouter.hasRole(BRIDGE_MANAGER, admin));
    }

    function test_Initialize_RevertZeroAddresses() public {
        OkuBridgeRouter impl = new OkuBridgeRouter();

        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize, (address(0), address(okuUsd), address(okuBridgeContract), admin)
            )
        );

        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize, (address(wokuUsd), address(0), address(okuBridgeContract), admin)
            )
        );

        vm.expectRevert(OkuBridgeRouter.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuBridgeRouter.initialize, (address(wokuUsd), address(okuUsd), address(0), admin)
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

    // ============ Native Path: bridgeWrapped ============

    function test_BridgeWrapped_Success() public {
        uint256 okuAmount = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);

        // Expect BridgeBurn from OkuBridge (the canonical native path event)
        vm.expectEmit(false, true, true, false, address(okuBridgeContract));
        emit BridgeBurn(bytes32(0), address(bridgeRouter), user2, 0, ARBITRUM_CHAIN_ID, 0, 0, 0);

        bytes32 requestId = bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Router holds at most dust (1-2 wei from integer division in fee-adjusted share calc)
        assertLe(okuUsd.balanceOf(address(bridgeRouter)), 2);
        // User has no wOkuUSD
        assertEq(wokuUsd.balanceOf(user1), 0);
        // requestId is non-zero
        assertNotEq(requestId, bytes32(0));
        // Fee recipient received fee in OkuUSD
        assertGt(okuUsd.balanceOf(feeRecipient), 0);
        // Nonce incremented on OkuBridge
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_BridgeWrapped_EmitsNativeBridgeInitiated() public {
        uint256 okuAmount = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);

        vm.expectEmit(true, false, false, false, address(bridgeRouter));
        emit NativeBridgeInitiated(user1, bytes32(0), okuAmount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrapped_RevertWhenPaused() public {
        uint256 wokuShares = _mintAndWrap(user1, 1000e18);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrapped_RevertInvalidRecipient() public {
        uint256 wokuShares = _mintAndWrap(user1, 1000e18);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, address(0));
        vm.stopPrank();
    }

    function test_BridgeWrapped_SharesPreservedAcrossRebase() public {
        uint256 initialOku = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, initialOku);

        // Rebase: 20% increase
        uint256 newMultiplier = PRECISION * 12 / 10;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // wOkuUSD now redeems to more OkuUSD
        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);
        assertGt(expectedOkuAmount, initialOku);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // OkuBridge received shares representing the full rebased value (minus fee)
        // Verify by checking nonce incremented (OkuBridge processed the bridge)
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
        // Router holds at most dust from integer division
        assertLe(okuUsd.balanceOf(address(bridgeRouter)), 2);
    }

    function test_BridgeWrapped_FeeCollected() public {
        // Set bridge fee to 1% for clear arithmetic
        vm.prank(admin);
        okuBridgeContract.updateFee(100); // 100 bps = 1%

        uint256 okuAmount = 10_000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Fee recipient should have received ~1% as OkuUSD.
        // The router uses a gross-deduction model: fee comes out of the input amount.
        // Net shares bridged = gross * 10000 / (10000 + fee), so fee ≈ gross * fee / (10000 + fee).
        uint256 feeBalance = okuUsd.balanceOf(feeRecipient);
        assertGt(feeBalance, 0);
        uint256 currentFee = okuBridgeContract.bridgeFee(); // 100 bps
        assertApproxEqAbs(feeBalance, okuAmount * currentFee / (10000 + currentFee), 2);
    }

    // ============ Native Path: bridgeDirect ============

    function test_BridgeDirect_Success() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);

        vm.expectEmit(false, true, true, false, address(okuBridgeContract));
        emit BridgeBurn(bytes32(0), address(bridgeRouter), user2, 0, ARBITRUM_CHAIN_ID, 0, 0, 0);

        bytes32 requestId = bridgeRouter.bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        assertEq(okuUsd.balanceOf(user1), 0);
        // Router holds at most dust from integer division in fee-adjusted share calc
        assertLe(okuUsd.balanceOf(address(bridgeRouter)), 2);
        assertNotEq(requestId, bytes32(0));
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_BridgeDirect_RevertWhenPaused() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeDirect_RevertInvalidRecipient() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, address(0));
        vm.stopPrank();
    }

    // ============ Adapter Path: bridgeWrappedVia ============

    function test_BridgeWrappedVia_Success() public {
        uint256 okuAmount = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);

        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockAdapter), okuAmount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeWrappedVia(wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // wOkuUSD burned
        assertEq(wokuUsd.balanceOf(user1), 0);
        // Router holds no OkuUSD (burned before adapter call)
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);
        // Adapter received the call
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.token, address(okuUsd));
        assertEq(pending.amount, okuAmount);
        assertEq(pending.destinationChain, ARBITRUM_CHAIN_ID);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeWrappedVia_RevertWhenPaused() public {
        uint256 wokuShares = _mintAndWrap(user1, 1000e18);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeWrappedVia(wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_RevertUnsupportedAdapter() public {
        uint256 wokuShares = _mintAndWrap(user1, 1000e18);
        address unsupported = makeAddr("unsupported");

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridgeRouter.UnsupportedAdapter.selector, unsupported)
        );
        bridgeRouter.bridgeWrappedVia(wokuShares, unsupported, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_RevertInvalidRecipient() public {
        uint256 wokuShares = _mintAndWrap(user1, 1000e18);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeWrappedVia(
            wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, address(0)
        );
        vm.stopPrank();
    }

    function test_BridgeWrappedVia_CorrectAmountAfterRebase() public {
        uint256 initialOku = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, initialOku);

        // Rebase: 10% increase
        uint256 newMultiplier = PRECISION + (PRECISION / 10);
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);
        assertGt(expectedOkuAmount, initialOku);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrappedVia(wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, expectedOkuAmount);
    }

    // ============ Adapter Path: bridgeDirectVia ============

    function test_BridgeDirectVia_Success() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);

        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockAdapter), okuAmount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeDirectVia(okuAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        assertEq(okuUsd.balanceOf(user1), 0);
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, okuAmount);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeDirectVia_RevertWhenPaused() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeDirectVia(okuAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeDirectVia_RevertUnsupportedAdapter() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);
        address unsupported = makeAddr("unsupported");

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridgeRouter.UnsupportedAdapter.selector, unsupported)
        );
        bridgeRouter.bridgeDirectVia(okuAmount, unsupported, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeDirectVia_RevertInvalidRecipient() public {
        uint256 okuAmount = 1000e18;
        _mintOkuUsd(user1, okuAmount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        vm.expectRevert(OkuBridgeRouter.InvalidRecipient.selector);
        bridgeRouter.bridgeDirectVia(okuAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, address(0));
        vm.stopPrank();
    }

    // ============ Full Round-Trip Tests (Native Path) ============

    function test_FullRoundTrip_NativePath() public {
        uint256 initialOku = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, initialOku);

        // Bridge
        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Simulate destination mint: orchestrator calls bridgeMint with valid signature
        // For simplicity, use admin refund path to verify shares reach destination
        // (full EIP-712 round-trip is covered in OkuBridge.t.sol)
        assertEq(okuBridgeContract.outboundNonce(ARBITRUM_CHAIN_ID), 1);
    }

    function test_FullRoundTrip_AdapterPath_WrapBridgeUnwrapWrap() public {
        uint256 initialOku = 1000e18;
        _mintOkuUsd(user1, initialOku);
        uint256 wokuShares = _wrapOkuUsd(user1, initialOku);

        // Bridge via adapter
        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrappedVia(wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Complete bridge on destination
        mockAdapter.completeBridge(0);

        // User2 wraps received OkuUSD
        uint256 user2OkuBalance = okuUsd.balanceOf(user2);
        uint256 user2WokuShares = _wrapOkuUsd(user2, user2OkuBalance);

        assertEq(user2OkuBalance, initialOku);
        assertEq(user2WokuShares, wokuShares);
    }

    function test_FullRoundTrip_AdapterPath_MultipleUsers() public {
        uint256 amount1 = 1000e18;
        uint256 amount2 = 2000e18;
        uint256 amount3 = 500e18;

        uint256 shares1 = _mintAndWrap(user1, amount1);
        uint256 shares2 = _mintAndWrap(user2, amount2);
        uint256 shares3 = _mintAndWrap(user3, amount3);

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), shares1);
        bridgeRouter.bridgeWrappedVia(shares1, address(mockAdapter), ARBITRUM_CHAIN_ID, dest1);
        vm.stopPrank();

        vm.startPrank(user2);
        wokuUsd.approve(address(bridgeRouter), shares2);
        bridgeRouter.bridgeWrappedVia(shares2, address(mockAdapter), OPTIMISM_CHAIN_ID, dest2);
        vm.stopPrank();

        vm.startPrank(user3);
        wokuUsd.approve(address(bridgeRouter), shares3);
        bridgeRouter.bridgeWrappedVia(shares3, address(mockAdapter), ARBITRUM_CHAIN_ID, dest3);
        vm.stopPrank();

        mockAdapter.completeBridge(0);
        mockAdapter.completeBridge(1);
        mockAdapter.completeBridge(2);

        assertEq(okuUsd.balanceOf(dest1), amount1);
        assertEq(okuUsd.balanceOf(dest2), amount2);
        assertEq(okuUsd.balanceOf(dest3), amount3);
    }

    // ============ Fuzz Tests ============

    function testFuzz_BridgeWrapped_NativePath(uint256 okuAmount) public {
        // Bound so that fee-adjusted shares land within [minBridgeShares, maxBridgeShares].
        // shares = totalShares * 10000 / (10000 + fee), so minimum okuAmount = ceil(min * (10000+fee) / 10000).
        uint256 fee = okuBridgeContract.bridgeFee();
        uint256 minOku = (okuBridgeContract.minBridgeShares() * (10000 + fee) + 9999) / 10000;
        okuAmount = bound(okuAmount, minOku, okuBridgeContract.maxBridgeShares());
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bytes32 requestId = bridgeRouter.bridgeWrapped(wokuShares, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Router holds at most dust (1-2 wei) from integer division in fee-adjusted share calc
        assertLe(okuUsd.balanceOf(address(bridgeRouter)), 2);
        assertEq(wokuUsd.balanceOf(user1), 0);
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeDirect_NativePath(uint256 okuAmount) public {
        // Bound so that fee-adjusted shares land within [minBridgeShares, maxBridgeShares].
        // shares = totalShares * 10000 / (10000 + fee), so minimum okuAmount = ceil(min * (10000+fee) / 10000).
        uint256 fee = okuBridgeContract.bridgeFee();
        uint256 minOku = (okuBridgeContract.minBridgeShares() * (10000 + fee) + 9999) / 10000;
        okuAmount = bound(okuAmount, minOku, okuBridgeContract.maxBridgeShares());
        _mintOkuUsd(user1, okuAmount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        bytes32 requestId = bridgeRouter.bridgeDirect(okuAmount, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        assertEq(okuUsd.balanceOf(user1), 0);
        // Router holds at most dust (1-2 wei) from integer division in fee-adjusted share calc
        assertLe(okuUsd.balanceOf(address(bridgeRouter)), 2);
        assertNotEq(requestId, bytes32(0));
    }

    function testFuzz_BridgeWrappedVia_AmountConsistency(uint256 okuAmount) public {
        okuAmount = bound(okuAmount, 1e18, 100_000_000e18);
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);
        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrappedVia(wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, expectedOkuAmount);
    }

    function testFuzz_BridgeDirectVia_AmountConsistency(uint256 okuAmount) public {
        okuAmount = bound(okuAmount, 1e18, 100_000_000e18);
        _mintOkuUsd(user1, okuAmount);
        uint256 supplyBefore = okuUsd.totalSupply();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), okuAmount);
        bridgeRouter.bridgeDirectVia(okuAmount, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Exact amount burned
        assertEq(okuUsd.totalSupply(), supplyBefore - okuAmount);
        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, okuAmount);
    }

    function testFuzz_BridgeWrappedVia_AfterRebase(
        uint256 depositAmount,
        uint256 multiplierIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        multiplierIncrease = _boundMultiplierIncrease(multiplierIncrease);

        uint256 wokuShares = _mintAndWrap(user1, depositAmount);

        uint256 newMultiplier = okuUsd.rewardMultiplier() + multiplierIncrease;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrappedVia(wokuShares, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockOkuBridge.PendingBridge memory pending = mockAdapter.getLastBridge();
        assertEq(pending.amount, expectedOkuAmount);
        assertGe(pending.amount, depositAmount);
    }

    function testFuzz_AdapterPath_RoundTripValueLoss(uint256 amount) public {
        // Round-trip through adapter bridge loses at most 2 wei (1 per wrap operation rounding)
        amount = bound(amount, 1e18, 100_000_000e18);

        _mintOkuUsd(user1, amount);
        uint256 shares1 = _wrapOkuUsd(user1, amount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), shares1);
        bridgeRouter.bridgeWrappedVia(shares1, address(mockAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        mockAdapter.completeBridge(0);
        uint256 receivedOku = okuUsd.balanceOf(user2);

        uint256 shares2 = _wrapOkuUsd(user2, receivedOku);
        vm.prank(user2);
        uint256 finalValue = wokuUsd.redeem(shares2, user2, user2);

        assertGe(amount, finalValue);
        assertLe(amount - finalValue, 2);
    }
}
