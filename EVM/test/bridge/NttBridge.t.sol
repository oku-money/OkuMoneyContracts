// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";
import {NttAdapter} from "../../src/bridge/adapters/NttAdapter.sol";
import {MockNttManager} from "../mocks/MockNttManager.sol";

/**
 * @title NttBridgeTest
 * @notice Tests for Wormhole NTT bridge integration
 * @dev Tests the NttAdapter and MockNttManager for source chain flow
 *
 * What we CAN test:
 * - Source chain: transfer() burns tokens, records message
 * - Type conversions: address ↔ bytes32, uint256 ↔ uint16
 * - Fee handling: message fees passed to NttManager
 * - Full flow through OkuBridgeRouter → NttAdapter → MockNttManager
 *
 * What we CANNOT test (would require forked mainnet or live network):
 * - Guardian signatures (VAA validation)
 * - receiveMessage() on destination chain
 * - Real cross-chain message delivery
 */
contract NttBridgeTest is BaseTest {
    OkuBridgeRouter public bridgeRouter;
    OkuBridgeRouter public bridgeRouterImpl;
    NttAdapter public nttAdapter;
    MockNttManager public mockNtt;

    // Wormhole chain IDs (from https://docs.wormhole.com/wormhole/reference/constants)
    uint16 public constant WORMHOLE_ARBITRUM = 23;
    uint16 public constant WORMHOLE_OPTIMISM = 24;
    uint16 public constant WORMHOLE_BASE = 30;

    // EVM chain IDs
    uint256 public constant ARBITRUM_CHAIN_ID = 42_161;
    uint256 public constant OPTIMISM_CHAIN_ID = 10;
    uint256 public constant BASE_CHAIN_ID = 8453;

    // Events
    event BridgeInitiated(
        address indexed sender,
        uint256 amount,
        uint16 wormholeChainId,
        bytes32 recipient,
        uint64 sequence
    );
    event TransferInitiated(
        address indexed sender,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint64 sequence
    );
    event TransferCompleted(uint256 index, address recipient, uint256 amount);

    function setUp() public override {
        super.setUp();

        // Deploy MockNttManager (okuUSD address, minter address)
        mockNtt = new MockNttManager(address(okuUSD), minter);

        // Deploy NttAdapter
        nttAdapter = new NttAdapter(address(mockNtt), address(okuUSD), admin);

        // Deploy OkuBridgeRouter
        bridgeRouterImpl = new OkuBridgeRouter();
        bytes memory routerInitData =
            abi.encodeCall(OkuBridgeRouter.initialize, (address(wokuUSD), address(okuUSD), admin));
        bridgeRouter =
            OkuBridgeRouter(address(new ERC1967Proxy(address(bridgeRouterImpl), routerInitData)));

        // Configure roles
        vm.startPrank(admin);
        // Router needs MINTER_ROLE to burn tokens
        okuUSD.grantRole(MINTER_ROLE, address(bridgeRouter));
        // Register NttAdapter as supported adapter
        bridgeRouter.configureAdapter(address(nttAdapter), true);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    function _wrapOkuUSD(address user, uint256 amount) internal returns (uint256 shares) {
        vm.startPrank(user);
        okuUSD.approve(address(wokuUSD), amount);
        shares = wokuUSD.deposit(amount, user);
        vm.stopPrank();
    }

    function _mintAndWrap(address user, uint256 okuAmount) internal returns (uint256 wokuShares) {
        _mintOkuUSD(user, okuAmount);
        wokuShares = _wrapOkuUSD(user, okuAmount);
    }

    function _addressToBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    function _bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    // ============ NttAdapter Unit Tests ============

    function test_NttAdapter_Initialize() public view {
        assertEq(address(nttAdapter.nttManager()), address(mockNtt));
        assertEq(address(nttAdapter.token()), address(okuUSD));
        assertEq(nttAdapter.owner(), admin);
    }

    function test_NttAdapter_ChainIdMappings() public view {
        assertEq(nttAdapter.wormholeChainId(ARBITRUM_CHAIN_ID), WORMHOLE_ARBITRUM);
        assertEq(nttAdapter.wormholeChainId(OPTIMISM_CHAIN_ID), WORMHOLE_OPTIMISM);
        assertEq(nttAdapter.wormholeChainId(BASE_CHAIN_ID), WORMHOLE_BASE);
    }

    function test_NttAdapter_ConfigureChainId() public {
        uint256 newChainId = 999;
        uint16 newWormholeId = 99;

        vm.prank(admin);
        nttAdapter.configureChainId(newChainId, newWormholeId);

        assertEq(nttAdapter.wormholeChainId(newChainId), newWormholeId);
    }

    function test_NttAdapter_ConfigureChainId_RevertIfNotOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        nttAdapter.configureChainId(999, 99);
    }

    function test_NttAdapter_Bridge() public {
        uint256 amount = 1000e18;

        // In real flow, tokens are already burned by router before calling adapter
        // We just test the message recording functionality

        // Bridge call from user1
        vm.prank(user1);
        vm.expectEmit(true, false, false, true, address(nttAdapter));
        emit BridgeInitiated(user1, amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2), 0);
        nttAdapter.bridge(address(okuUSD), amount, ARBITRUM_CHAIN_ID, user2);

        // Verify transfer recorded in mock
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function test_NttAdapter_Bridge_RevertUnsupportedChain() public {
        uint256 amount = 1000e18;
        // No tokens needed - adapter just sends message

        vm.expectRevert(abi.encodeWithSelector(NttAdapter.UnsupportedChain.selector, 12_345));
        nttAdapter.bridge(address(okuUSD), amount, 12_345, user2);
    }

    function test_NttAdapter_Bridge_RevertInvalidRecipient() public {
        uint256 amount = 1000e18;
        // No tokens needed - adapter just sends message

        vm.expectRevert(NttAdapter.InvalidRecipient.selector);
        nttAdapter.bridge(address(okuUSD), amount, ARBITRUM_CHAIN_ID, address(0));
    }

    function test_NttAdapter_Bridge_WithFee() public {
        uint256 amount = 1000e18;
        uint256 fee = 0.01 ether;

        mockNtt.setMessageFee(fee);

        // Bridge with fee
        vm.deal(address(this), fee);
        nttAdapter.bridge{value: fee}(address(okuUSD), amount, ARBITRUM_CHAIN_ID, user2);

        // Verify transfer succeeded
        assertEq(mockNtt.pendingTransfersCount(), 1);
    }

    function test_NttAdapter_Bridge_RevertInsufficientFee() public {
        uint256 amount = 1000e18;
        uint256 fee = 0.01 ether;

        mockNtt.setMessageFee(fee);

        // Bridge with insufficient fee
        vm.deal(address(this), fee / 2);
        vm.expectRevert(
            abi.encodeWithSelector(MockNttManager.InsufficientFee.selector, fee, fee / 2)
        );
        nttAdapter.bridge{value: fee / 2}(address(okuUSD), amount, ARBITRUM_CHAIN_ID, user2);
    }

    // ============ MockNttManager Tests ============

    function test_MockNtt_Transfer() public {
        uint256 amount = 1000e18;
        // No tokens needed - mock just records the message

        vm.prank(user1);
        vm.expectEmit(true, false, false, true, address(mockNtt));
        emit TransferInitiated(user1, amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2), 0);

        uint64 sequence = mockNtt.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        assertEq(sequence, 0);
        assertEq(mockNtt.pendingTransfersCount(), 1);

        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.sender, user1);
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
        assertEq(pending.completed, false);
    }

    function test_MockNtt_CompleteBridge() public {
        uint256 amount = 1000e18;

        // Record transfer message
        vm.prank(user1);
        mockNtt.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        // Complete (mints on destination)
        vm.expectEmit(true, true, false, true, address(mockNtt));
        emit TransferCompleted(0, user2, amount);

        mockNtt.completeBridge(0);

        // Verify recipient received tokens
        assertEq(okuUSD.balanceOf(user2), amount);

        // Verify marked as completed
        MockNttManager.PendingTransfer memory pending = mockNtt.getPendingTransfer(0);
        assertTrue(pending.completed);
    }

    function test_MockNtt_CompleteBridge_RevertAlreadyCompleted() public {
        uint256 amount = 1000e18;

        vm.prank(user1);
        mockNtt.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        mockNtt.completeBridge(0);

        vm.expectRevert(MockNttManager.TransferAlreadyCompleted.selector);
        mockNtt.completeBridge(0);
    }

    function test_MockNtt_ReceiveMessage_Reverts() public {
        vm.expectRevert("Use completeBridge() for testing - cannot forge guardian signatures");
        mockNtt.receiveMessage(hex"deadbeef");
    }

    function test_MockNtt_AddressConversion() public view {
        address original = user1;
        bytes32 asBytes32 = mockNtt.addressToRecipient(original);
        address recovered = mockNtt.recipientToAddress(asBytes32);

        assertEq(original, recovered);
        assertEq(asBytes32, _addressToBytes32(original));
    }

    // ============ Integration Tests (Router → NttAdapter → MockNtt) ============

    function test_Integration_BridgeOkuUSD_ViaNtt() public {
        uint256 amount = 1000e18;
        _mintOkuUSD(user1, amount);

        vm.startPrank(user1);
        okuUSD.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeOkuUSD(amount, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify tokens burned from user
        assertEq(okuUSD.balanceOf(user1), 0);

        // Verify transfer recorded in NTT
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function test_Integration_BridgeWOkuUSD_ViaNtt() public {
        uint256 okuAmount = 1000e18;
        uint256 wokuShares = _mintAndWrap(user1, okuAmount);

        vm.startPrank(user1);
        wokuUSD.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWOkuUSD(wokuShares, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify wOkuUSD burned
        assertEq(wokuUSD.balanceOf(user1), 0);

        // Verify correct OkuUSD amount recorded
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, okuAmount);
    }

    function test_Integration_FullRoundTrip_ViaNtt() public {
        uint256 initialOku = 1000e18;

        // Step 1: Mint and wrap
        _mintOkuUSD(user1, initialOku);
        uint256 wokuShares = _wrapOkuUSD(user1, initialOku);

        // Step 2: Bridge wOkuUSD via NTT
        vm.startPrank(user1);
        wokuUSD.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWOkuUSD(wokuShares, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 3: Complete bridge on destination
        mockNtt.completeBridge(0);

        // Step 4: Verify user2 received tokens
        assertEq(okuUSD.balanceOf(user2), initialOku);

        // Step 5: User2 wraps tokens on destination
        uint256 user2Shares = _wrapOkuUSD(user2, initialOku);
        assertEq(user2Shares, wokuShares);
    }

    function test_Integration_FullRoundTrip_AfterRebase() public {
        uint256 initialOku = 1000e18;

        // Step 1: Mint and wrap
        _mintOkuUSD(user1, initialOku);
        uint256 wokuShares = _wrapOkuUSD(user1, initialOku);

        // Step 2: Rebase
        uint256 newMultiplier = PRECISION * 12 / 10; // 20% increase
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 okuValueAfterRebase = wokuUSD.previewRedeem(wokuShares);
        assertGt(okuValueAfterRebase, initialOku);

        // Step 3: Bridge
        vm.startPrank(user1);
        wokuUSD.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWOkuUSD(wokuShares, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify bridged amount includes rebase yield (allow 1 wei rounding from share conversion)
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertApproxEqAbs(pending.amount, okuValueAfterRebase, 1);

        // Step 4: Complete
        mockNtt.completeBridge(0);

        // User2 gets the rebased amount (allow 1 wei rounding)
        assertApproxEqAbs(okuUSD.balanceOf(user2), okuValueAfterRebase, 1);
    }

    function test_Integration_MultipleChains() public {
        uint256 amount1 = 500e18;
        uint256 amount2 = 750e18;
        uint256 amount3 = 1000e18;

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        _mintOkuUSD(user1, amount1 + amount2 + amount3);

        vm.startPrank(user1);
        okuUSD.approve(address(bridgeRouter), amount1 + amount2 + amount3);

        bridgeRouter.bridgeOkuUSD(amount1, address(nttAdapter), ARBITRUM_CHAIN_ID, dest1);
        bridgeRouter.bridgeOkuUSD(amount2, address(nttAdapter), OPTIMISM_CHAIN_ID, dest2);
        bridgeRouter.bridgeOkuUSD(amount3, address(nttAdapter), BASE_CHAIN_ID, dest3);
        vm.stopPrank();

        // Verify all transfers
        assertEq(mockNtt.pendingTransfersCount(), 3);

        MockNttManager.PendingTransfer memory p0 = mockNtt.getPendingTransfer(0);
        MockNttManager.PendingTransfer memory p1 = mockNtt.getPendingTransfer(1);
        MockNttManager.PendingTransfer memory p2 = mockNtt.getPendingTransfer(2);

        assertEq(p0.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(p1.recipientChain, WORMHOLE_OPTIMISM);
        assertEq(p2.recipientChain, WORMHOLE_BASE);

        // Complete all
        mockNtt.completeBridge(0);
        mockNtt.completeBridge(1);
        mockNtt.completeBridge(2);

        assertEq(okuUSD.balanceOf(dest1), amount1);
        assertEq(okuUSD.balanceOf(dest2), amount2);
        assertEq(okuUSD.balanceOf(dest3), amount3);
    }

    // ============ Fuzz Tests ============

    function testFuzz_AddressToBytes32Conversion(address addr) public view {
        vm.assume(addr != address(0));

        bytes32 b = mockNtt.addressToRecipient(addr);
        address recovered = mockNtt.recipientToAddress(b);

        assertEq(addr, recovered);
    }

    function testFuzz_NttTransfer_AmountConsistency(uint256 amount) public {
        amount = bound(amount, 1e18, 100_000_000e18);

        // Mock just records the message - no token movement
        vm.prank(user1);
        mockNtt.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        // Transfer recorded correctly
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function testFuzz_Integration_BridgeOkuUSD(uint256 amount, uint256 chainSelector) public {
        amount = bound(amount, 1e18, 100_000_000e18);

        // Select a valid chain
        uint256[] memory chains = new uint256[](3);
        chains[0] = ARBITRUM_CHAIN_ID;
        chains[1] = OPTIMISM_CHAIN_ID;
        chains[2] = BASE_CHAIN_ID;
        uint256 selectedChain = chains[chainSelector % 3];

        _mintOkuUSD(user1, amount);

        vm.startPrank(user1);
        okuUSD.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeOkuUSD(amount, address(nttAdapter), selectedChain, user2);
        vm.stopPrank();

        // Verify transfer
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, nttAdapter.wormholeChainId(selectedChain));
    }

    function testFuzz_Integration_BridgeWOkuUSD_AfterRebase(
        uint256 depositAmount,
        uint256 multiplierIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        multiplierIncrease = _boundMultiplierIncrease(multiplierIncrease);

        // Wrap tokens
        _mintOkuUSD(user1, depositAmount);
        uint256 wokuShares = _wrapOkuUSD(user1, depositAmount);

        // Apply rebase
        uint256 newMultiplier = okuUSD.rewardMultiplier() + multiplierIncrease;
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        // Calculate expected value
        uint256 expectedOkuAmount = wokuUSD.previewRedeem(wokuShares);

        // Bridge
        vm.startPrank(user1);
        wokuUSD.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWOkuUSD(wokuShares, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify bridged amount
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, expectedOkuAmount);
        assertGe(pending.amount, depositAmount); // At least original amount
    }

    function testFuzz_Integration_FullRoundTrip(
        uint256 initialOku,
        uint256 multiplierIncrease
    )
        public
    {
        initialOku = bound(initialOku, 1e18, 100_000_000e18);
        multiplierIncrease = _boundMultiplierIncrease(multiplierIncrease);

        // Step 1: Wrap
        _mintOkuUSD(user1, initialOku);
        uint256 wokuShares = _wrapOkuUSD(user1, initialOku);

        // Step 2: Rebase
        uint256 newMultiplier = okuUSD.rewardMultiplier() + multiplierIncrease;
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 valueBeforeBridge = wokuUSD.previewRedeem(wokuShares);

        // Step 3: Bridge via NTT
        vm.startPrank(user1);
        wokuUSD.approve(address(bridgeRouter), wokuShares);
        bridgeRouter.bridgeWOkuUSD(wokuShares, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 4: Complete on destination
        mockNtt.completeBridge(0);

        // Verify destination received expected amount (allow 2 wei rounding)
        uint256 destBalance = okuUSD.balanceOf(user2);
        assertApproxEqAbs(destBalance, valueBeforeBridge, 2);

        // Step 5: Wrap on destination
        uint256 destWokuShares = _wrapOkuUSD(user2, destBalance);

        // Verify value preserved (allow up to 5 wei rounding from multiple conversions)
        uint256 destValue = wokuUSD.previewRedeem(destWokuShares);
        assertApproxEqAbs(destValue, valueBeforeBridge, 5);
    }

    function testFuzz_MultipleBridges_ViaNtt(uint256 numBridges, uint256 baseSeed) public {
        numBridges = bound(numBridges, 1, 15);

        address[] memory users = new address[](numBridges);
        uint256[] memory amounts = new uint256[](numBridges);
        address[] memory destinations = new address[](numBridges);

        // Setup and bridge
        for (uint256 i = 0; i < numBridges; i++) {
            users[i] = makeAddr(string(abi.encodePacked("nttUser", i)));
            destinations[i] = makeAddr(string(abi.encodePacked("nttDest", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 10_000_000e18);

            uint256 shares = _mintAndWrap(users[i], amounts[i]);

            vm.startPrank(users[i]);
            wokuUSD.approve(address(bridgeRouter), shares);
            bridgeRouter.bridgeWOkuUSD(
                shares, address(nttAdapter), ARBITRUM_CHAIN_ID, destinations[i]
            );
            vm.stopPrank();
        }

        // Verify all recorded
        assertEq(mockNtt.pendingTransfersCount(), numBridges);

        // Complete all
        for (uint256 i = 0; i < numBridges; i++) {
            mockNtt.completeBridge(i);
            assertEq(okuUSD.balanceOf(destinations[i]), amounts[i]);
        }
    }

    function testFuzz_SequenceNumbers(uint256 numTransfers) public {
        numTransfers = bound(numTransfers, 1, 20);

        for (uint256 i = 0; i < numTransfers; i++) {
            address sender = makeAddr(string(abi.encodePacked("sender", i)));
            _mintOkuUSD(sender, 100e18);

            vm.startPrank(sender);
            okuUSD.approve(address(mockNtt), 100e18);
            uint64 sequence = mockNtt.transfer(100e18, WORMHOLE_ARBITRUM, _addressToBytes32(user2));
            vm.stopPrank();

            // Sequence should increment
            assertEq(sequence, uint64(i));
        }

        assertEq(mockNtt.pendingTransfersCount(), numTransfers);
    }

    // ============ Edge Case Tests ============

    function test_NttAdapter_ZeroAmount() public {
        vm.expectRevert(NttAdapter.InvalidAmount.selector);
        nttAdapter.bridge(address(okuUSD), 0, ARBITRUM_CHAIN_ID, user2);
    }

    function test_NttAdapter_WrongToken() public {
        vm.expectRevert("Invalid token");
        nttAdapter.bridge(address(wokuUSD), 100e18, ARBITRUM_CHAIN_ID, user2);
    }

    function test_MockNtt_InvalidIndex() public {
        vm.expectRevert(MockNttManager.InvalidTransferIndex.selector);
        mockNtt.getPendingTransfer(999);
    }

    function test_MockNtt_CompleteBridgeTo() public {
        uint256 amount = 1000e18;

        vm.prank(user1);
        mockNtt.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        // Complete to different address
        address override_ = makeAddr("override");
        mockNtt.completeBridgeTo(0, override_);

        assertEq(okuUSD.balanceOf(override_), amount);
        assertEq(okuUSD.balanceOf(user2), 0);
    }

    function test_NttAdapter_WithdrawStuckETH() public {
        // Send ETH to adapter
        vm.deal(address(nttAdapter), 1 ether);

        address payable recipient = payable(makeAddr("ethRecipient"));
        uint256 balanceBefore = recipient.balance;

        vm.prank(admin);
        nttAdapter.withdrawETH(recipient);

        assertEq(recipient.balance, balanceBefore + 1 ether);
        assertEq(address(nttAdapter).balance, 0);
    }

    function test_NttAdapter_WithdrawStuckTokens() public {
        uint256 amount = 1000e18;
        // Simulate stuck tokens (could happen from failed operations or other issues)
        _mintOkuUSD(address(nttAdapter), amount);

        address recipient = makeAddr("tokenRecipient");

        vm.prank(admin);
        nttAdapter.withdrawTokens(address(okuUSD), recipient, amount);

        assertEq(okuUSD.balanceOf(recipient), amount);
        assertEq(okuUSD.balanceOf(address(nttAdapter)), 0);
    }
}
