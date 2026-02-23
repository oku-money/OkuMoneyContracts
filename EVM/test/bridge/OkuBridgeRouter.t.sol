// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";
import {MockOkuBridge} from "../mocks/MockOkuBridge.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title OkuBridgeRouterTest
 * @notice Tests for OkuBridgeRouter including wrapped token bridging flow
 */
contract OkuBridgeRouterTest is BaseTest {
    OkuBridgeRouter public bridgeRouter;
    OkuBridgeRouter public bridgeRouterImpl;
    MockOkuBridge public mockBridge;

    uint256 public constant ARBITRUM_CHAIN_ID = 42_161;
    uint256 public constant OPTIMISM_CHAIN_ID = 10;

    // Events
    event BridgeInitiated(
        address indexed user,
        address indexed adapter,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );
    event AdapterConfigured(address indexed adapter, bool supported);

    function setUp() public override {
        super.setUp();

        // Deploy OkuBridgeRouter implementation and proxy
        bridgeRouterImpl = new OkuBridgeRouter();
        bytes memory routerInitData =
            abi.encodeCall(OkuBridgeRouter.initialize, (address(wokuUsd), address(okuUsd), admin));
        bridgeRouter =
            OkuBridgeRouter(address(new ERC1967Proxy(address(bridgeRouterImpl), routerInitData)));

        // Deploy mock bridge
        mockBridge = new MockOkuBridge(okuUsd, minter);

        // Configure roles and adapters
        vm.startPrank(admin);
        bridgeRouter.grantRole(ADAPTER_MANAGER, admin);
        bridgeRouter.grantRole(ROUTER_UNPAUSER, admin);
        bridgeRouter.configureAdapter(address(mockBridge), true);
        okuUsd.grantRole(MINTER, address(bridgeRouter)); // Router needs MINTER to burn
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    /// @notice Wrap OkuUSD into wOkuUSD for a user
    function _wrapOkuUsd(address user, uint256 amount) internal returns (uint256 shares) {
        vm.startPrank(user);
        okuUsd.approve(address(wokuUsd), amount);
        shares = wokuUsd.deposit(amount, user);
        vm.stopPrank();
    }

    /// @notice Mint OkuUSD and wrap it for a user
    function _mintAndWrap(address user, uint256 okuAmount) internal returns (uint256 wokuShares) {
        _mintOkuUsd(user, okuAmount);
        wokuShares = _wrapOkuUsd(user, okuAmount);
    }

    // ============ Router Configuration Tests ============

    function test_Initialize() public view {
        assertEq(address(bridgeRouter.wOkuUsd()), address(wokuUsd));
        assertEq(address(bridgeRouter.okuUsd()), address(okuUsd));
        assertTrue(bridgeRouter.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_UPGRADER, admin));
        assertTrue(bridgeRouter.hasRole(ROUTER_PAUSER, admin));
    }

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
        bridgeRouter.configureAdapter(address(mockBridge), false);

        assertFalse(bridgeRouter.supportedAdapters(address(mockBridge)));
    }

    function test_ConfigureAdapter_RevertIfNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                ADAPTER_MANAGER
            )
        );
        bridgeRouter.configureAdapter(makeAddr("adapter"), true);
    }

    function test_Pause() public {
        vm.prank(admin);
        bridgeRouter.pause();

        assertTrue(bridgeRouter.paused());
    }

    function test_Pause_RevertIfNotPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                ROUTER_PAUSER
            )
        );
        bridgeRouter.pause();
    }

    function test_Unpause() public {
        vm.prank(admin);
        bridgeRouter.pause();

        vm.prank(admin);
        bridgeRouter.unpause();

        assertFalse(bridgeRouter.paused());
    }

    // ============ Direct OkuUSD Bridging Tests ============

    function test_BridgeOkuUSD() public {
        uint256 amount = 1000e18;
        _mintOkuUsd(user1, amount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), amount);

        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockBridge), amount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeDirect(amount, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify tokens burned
        assertEq(okuUsd.balanceOf(user1), 0);

        // Verify bridge called
        MockOkuBridge.PendingBridge memory pending = mockBridge.getLastBridge();
        assertEq(pending.token, address(okuUsd));
        assertEq(pending.amount, amount);
        assertEq(pending.destinationChain, ARBITRUM_CHAIN_ID);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeOkuUSD_RevertWhenPaused() public {
        uint256 amount = 1000e18;
        _mintOkuUsd(user1, amount);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), amount);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeDirect(amount, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeOkuUSD_RevertIfAdapterNotSupported() public {
        uint256 amount = 1000e18;
        _mintOkuUsd(user1, amount);
        address unsupportedAdapter = makeAddr("unsupported");

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), amount);
        vm.expectRevert("Unsupported adapter");
        bridgeRouter.bridgeDirect(amount, unsupportedAdapter, ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeOkuUSD_RevertIfInvalidRecipient() public {
        uint256 amount = 1000e18;
        _mintOkuUsd(user1, amount);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), amount);
        vm.expectRevert("Invalid recipient");
        bridgeRouter.bridgeDirect(amount, address(mockBridge), ARBITRUM_CHAIN_ID, address(0));
        vm.stopPrank();
    }

    function test_BridgeOkuUSD_RevertIfInsufficientBalance() public {
        uint256 amount = 1000e18;
        // Don't mint any tokens to user1

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), amount);
        vm.expectRevert("Insufficient balance");
        bridgeRouter.bridgeDirect(amount, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    // ============ Wrapped Flow Tests (wOkuUSD → bridge) ============

    function test_BridgeWOkuUSD_UnwrapsAndBurns() public {
        uint256 okuAmount = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);

        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify wOkuUSD burned
        assertEq(wokuUsd.balanceOf(user1), 0);

        // Verify OkuUSD burned (not held by router)
        assertEq(okuUsd.balanceOf(address(bridgeRouter)), 0);

        // Verify bridge received correct amount
        MockOkuBridge.PendingBridge memory pending = mockBridge.getLastBridge();
        assertEq(pending.amount, okuAmount);
        assertEq(pending.recipient, user2);
    }

    function test_BridgeWOkuUSD_CorrectOkuUSDAmountAfterRebase() public {
        uint256 initialOku = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, initialOku);

        // Rebase: 10% increase
        uint256 newMultiplier = PRECISION + (PRECISION / 10);
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // wOkuUSD shares now represent more OkuUSD
        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);
        assertGt(expectedOkuAmount, initialOku); // Should be ~1100e18

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify bridge received increased amount
        MockOkuBridge.PendingBridge memory pending = mockBridge.getLastBridge();
        assertEq(pending.amount, expectedOkuAmount);
    }

    function test_BridgeWOkuUSD_RevertWhenPaused() public {
        uint256 wokuShares = _mintAndWrap(user1, 1000e18);

        vm.prank(admin);
        bridgeRouter.pause();

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    function test_BridgeWOkuUSD_EmitsEvent() public {
        uint256 okuAmount = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);

        vm.expectEmit(true, true, false, true);
        emit BridgeInitiated(user1, address(mockBridge), okuAmount, ARBITRUM_CHAIN_ID, user2);

        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();
    }

    // ============ Full Round-Trip Tests ============

    function test_FullRoundTrip_WrapBridgeUnwrapWrap() public {
        uint256 initialOku = 1000e18;

        // Step 1: User1 has OkuUSD, wraps it
        _mintOkuUsd(user1, initialOku);
        uint256 wokuShares = _wrapOkuUsd(user1, initialOku);

        // Step 2: Bridge wOkuUSD
        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 3: Complete bridge on destination (mock mints OkuUSD to user2)
        mockBridge.completeBridge(0);

        // Step 4: User2 wraps received OkuUSD
        uint256 user2OkuBalance = okuUsd.balanceOf(user2);
        uint256 user2WokuShares = _wrapOkuUsd(user2, user2OkuBalance);

        // Verify: user2 should have equivalent wOkuUSD shares
        assertEq(user2WokuShares, wokuShares);
        assertEq(user2OkuBalance, initialOku);
    }

    function test_FullRoundTrip_PreservesValueAfterRebase() public {
        uint256 initialOku = 1000e18;

        // Step 1: Mint and wrap
        _mintOkuUsd(user1, initialOku);
        uint256 wokuShares = _wrapOkuUsd(user1, initialOku);

        // Step 2: Rebase before bridging
        uint256 newMultiplier = PRECISION * 12 / 10; // 20% increase
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // wOkuUSD now worth more OkuUSD
        uint256 okuValueBeforeBridge = wokuUsd.previewRedeem(wokuShares);

        // Step 3: Bridge
        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 4: Complete bridge
        mockBridge.completeBridge(0);

        // Verify: user2 receives the full rebased amount (allow 1 wei rounding)
        uint256 user2Balance = okuUsd.balanceOf(user2);
        assertApproxEqAbs(user2Balance, okuValueBeforeBridge, 1);
        assertGt(user2Balance, initialOku); // More than original due to rebase
    }

    function test_FullRoundTrip_MultipleUsers() public {
        uint256 amount1 = 1000e18;
        uint256 amount2 = 2000e18;
        uint256 amount3 = 500e18;

        // Three users bridge
        uint256 shares1 = _mintAndWrap(user1, amount1);
        uint256 shares2 = _mintAndWrap(user2, amount2);
        uint256 shares3 = _mintAndWrap(user3, amount3);

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), shares1);
        bridgeRouter.bridgeWrapped(shares1, address(mockBridge), ARBITRUM_CHAIN_ID, dest1);
        vm.stopPrank();

        vm.startPrank(user2);
        wokuUsd.approve(address(bridgeRouter), shares2);
        bridgeRouter.bridgeWrapped(shares2, address(mockBridge), OPTIMISM_CHAIN_ID, dest2);
        vm.stopPrank();

        vm.startPrank(user3);
        wokuUsd.approve(address(bridgeRouter), shares3);
        bridgeRouter.bridgeWrapped(shares3, address(mockBridge), ARBITRUM_CHAIN_ID, dest3);
        vm.stopPrank();

        // Complete all bridges
        mockBridge.completeBridge(0);
        mockBridge.completeBridge(1);
        mockBridge.completeBridge(2);

        // Verify all destinations received correct amounts
        assertEq(okuUsd.balanceOf(dest1), amount1);
        assertEq(okuUsd.balanceOf(dest2), amount2);
        assertEq(okuUsd.balanceOf(dest3), amount3);
    }

    // ============ Fuzz Tests ============

    function testFuzz_BridgeOkuUSD_AmountConsistency(uint256 amount) public {
        amount = bound(amount, 1e18, 100_000_000e18);

        _mintOkuUsd(user1, amount);
        uint256 supplyBefore = okuUsd.totalSupply();

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeDirect(amount, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify exact amount burned
        assertEq(okuUsd.totalSupply(), supplyBefore - amount);

        // Verify exact amount recorded in bridge
        MockOkuBridge.PendingBridge memory pending = mockBridge.getLastBridge();
        assertEq(pending.amount, amount);
    }

    function testFuzz_BridgeWOkuUSD_AmountConsistency(uint256 okuAmount) public {
        okuAmount = bound(okuAmount, 1e18, 100_000_000e18);

        _mintOkuUsd(user1, okuAmount);
        uint256 wokuShares = _wrapOkuUsd(user1, okuAmount);

        // Calculate expected OkuUSD amount from redemption
        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify bridged amount matches preview
        MockOkuBridge.PendingBridge memory pending = mockBridge.getLastBridge();
        assertEq(pending.amount, expectedOkuAmount);
    }

    function testFuzz_BridgeWOkuUSD_AfterRebase(
        uint256 depositAmount,
        uint256 multiplierIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        multiplierIncrease = _boundMultiplierIncrease(multiplierIncrease);

        // Wrap tokens
        _mintOkuUsd(user1, depositAmount);
        uint256 wokuShares = _wrapOkuUsd(user1, depositAmount);

        // Apply rebase
        uint256 newMultiplier = okuUsd.rewardMultiplier() + multiplierIncrease;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Calculate expected post-rebase value
        uint256 expectedOkuAmount = wokuUsd.previewRedeem(wokuShares);

        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify bridged amount includes rebase yield
        MockOkuBridge.PendingBridge memory pending = mockBridge.getLastBridge();
        assertEq(pending.amount, expectedOkuAmount);
        assertGe(pending.amount, depositAmount); // At least original amount (more after rebase)
    }

    function testFuzz_FullRoundTrip(uint256 initialOku, uint256 multiplierIncrease) public {
        initialOku = bound(initialOku, 1e18, 100_000_000e18);
        multiplierIncrease = _boundMultiplierIncrease(multiplierIncrease);

        // Step 1: Wrap
        _mintOkuUsd(user1, initialOku);
        uint256 wokuShares = _wrapOkuUsd(user1, initialOku);

        // Step 2: Optional rebase
        uint256 newMultiplier = okuUsd.rewardMultiplier() + multiplierIncrease;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        uint256 valueBeforeBridge = wokuUsd.previewRedeem(wokuShares);

        // Step 3: Bridge
        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWrapped(wokuShares, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 4: Complete on destination
        mockBridge.completeBridge(0);

        // Verify: destination received expected amount
        // Allow 2 wei rounding from share conversion during OkuUSD transfer
        uint256 destBalance = okuUsd.balanceOf(user2);
        assertApproxEqAbs(destBalance, valueBeforeBridge, 2);

        // Step 5: Wrap on destination
        uint256 destWokuShares = _wrapOkuUsd(user2, destBalance);

        // Verify: destination wOkuUSD VALUE equals source value (not share count)
        // Share counts differ after rebase, but underlying OkuUSD value should be preserved
        uint256 destValue = wokuUsd.previewRedeem(destWokuShares);
        // Allow up to 5 wei rounding (accumulates across multiple share/token conversions)
        // Operations: source redeem, OkuUSD transfer (share conversion), mint, dest deposit, preview
        assertApproxEqAbs(destValue, valueBeforeBridge, 5);
    }

    function testFuzz_MultipleBridges(uint256 numBridges, uint256 baseSeed) public {
        numBridges = bound(numBridges, 1, 20);

        address[] memory users = new address[](numBridges);
        uint256[] memory amounts = new uint256[](numBridges);
        address[] memory destinations = new address[](numBridges);

        // Setup all users
        for (uint256 i = 0; i < numBridges; i++) {
            users[i] = makeAddr(string(abi.encodePacked("bridgeUser", i)));
            destinations[i] = makeAddr(string(abi.encodePacked("dest", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 10_000_000e18);

            uint256 shares = _mintAndWrap(users[i], amounts[i]);

            vm.startPrank(users[i]);
            wokuUsd.approve(address(bridgeRouter), shares);
            bridgeRouter.bridgeWrapped(
                shares, address(mockBridge), ARBITRUM_CHAIN_ID, destinations[i]
            );
            vm.stopPrank();
        }

        // Verify all bridges recorded
        assertEq(mockBridge.pendingBridgesCount(), numBridges);

        // Complete all and verify
        for (uint256 i = 0; i < numBridges; i++) {
            mockBridge.completeBridge(i);
            assertEq(okuUsd.balanceOf(destinations[i]), amounts[i]);
        }
    }

    function testFuzz_RoundTripValueLoss(uint256 amount) public {
        // Test that round-trip through bridge loses at most 2 wei (1 per wrap operation)
        amount = bound(amount, 1e18, 100_000_000e18);

        // Initial state
        _mintOkuUsd(user1, amount);
        uint256 initialValue = amount;

        // Wrap
        uint256 shares1 = _wrapOkuUsd(user1, amount);

        // Bridge
        vm.startPrank(user1);
        wokuUsd.approve(address(bridgeRouter), shares1);
        bridgeRouter.bridgeWrapped(shares1, address(mockBridge), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Complete
        mockBridge.completeBridge(0);
        uint256 receivedOku = okuUsd.balanceOf(user2);

        // Wrap again on destination
        uint256 shares2 = _wrapOkuUsd(user2, receivedOku);

        // Redeem to get final OkuUSD value
        vm.prank(user2);
        uint256 finalValue = wokuUsd.redeem(shares2, user2, user2);

        // Max 2 wei loss (1 wei per wrap operation rounding)
        assertGe(initialValue, finalValue);
        assertLe(initialValue - finalValue, 2);
    }
}
