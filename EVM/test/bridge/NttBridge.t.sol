// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuBridgeRouter} from "../../src/bridge/OkuBridgeRouter.sol";
import {NttAdapter} from "../../src/bridge/adapters/NttAdapter.sol";
import {MockNttManager} from "../mocks/MockNttManager.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";

/**
 * @title NttBridgeTest
 * @notice Tests for Wormhole NTT bridge integration
 * @dev Tests the NttAdapter and MockNttManager for source chain flow.
 *      OkuNote is a standard non-rebasing ERC-20. notePrice() is a view for
 *      pricing only — it does NOT affect balanceOf(). Bridge operates on raw
 *      token amounts (no share conversions).
 *
 * What we CAN test:
 * - Source chain: transfer() burns tokens, records message
 * - Type conversions: address <-> bytes32, uint256 <-> uint16
 * - Fee handling: message fees passed to NttManager
 * - Full flow through OkuBridgeRouter -> NttAdapter -> MockNttManager
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
    event ChainIdConfigured(uint256 evmChainId, uint16 wormholeChainId);

    function setUp() public override {
        super.setUp();

        // Deploy MockNttManager (okuNote address, minter address)
        mockNtt = new MockNttManager(address(okuNote), minter);

        // Deploy OkuBridgeRouter first (native bridge unused in NTT tests, pass placeholder)
        bridgeRouterImpl = new OkuBridgeRouter();
        bytes memory routerInitData = abi.encodeCall(
            OkuBridgeRouter.initialize,
            (address(okuUsd), address(okuNote), makeAddr("okuBridgePlaceholder"), admin)
        );
        bridgeRouter =
            OkuBridgeRouter(address(new ERC1967Proxy(address(bridgeRouterImpl), routerInitData)));

        // Deploy NttAdapter with router address for caller restriction
        nttAdapter =
            new NttAdapter(address(mockNtt), address(okuNote), address(bridgeRouter), admin);

        // Configure roles
        vm.startPrank(admin);
        // Router needs MINTER on OkuNote to burn tokens
        okuNote.grantRole(MINTER, address(bridgeRouter));
        // Grant ADAPTER_MANAGER to admin
        bridgeRouter.grantRole(ADAPTER_MANAGER, admin);
        // Grant ROUTER_UNPAUSER to admin
        bridgeRouter.grantRole(ROUTER_UNPAUSER, admin);
        // Register NttAdapter as supported adapter
        bridgeRouter.configureAdapter(address(nttAdapter), true);
        vm.stopPrank();

        // Setup minter allowance for router
        vm.prank(allowanceManager);
        okuNote.configureMinterAllowance(address(bridgeRouter), MAX_SUPPLY);
    }

    // ============ Helper Functions ============

    function _addressToBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    function _bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    // ============ NttAdapter Unit Tests ============

    function test_NttAdapter_Initialize() public view {
        assertEq(address(nttAdapter.NTT_MANAGER()), address(mockNtt));
        assertEq(address(nttAdapter.TOKEN()), address(okuNote));
        assertEq(nttAdapter.ROUTER(), address(bridgeRouter));
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
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        nttAdapter.configureChainId(999, 99);
    }

    function test_NttAdapter_Bridge() public {
        uint256 amount = 1000e18;

        // In real flow, tokens are already burned by router before calling adapter
        // We just test the message recording functionality

        // Bridge call from router (only router can call bridge)
        vm.prank(address(bridgeRouter));
        vm.expectEmit(true, false, false, true, address(nttAdapter));
        emit BridgeInitiated(
            address(bridgeRouter), amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2), 0
        );
        nttAdapter.bridge(address(okuNote), amount, ARBITRUM_CHAIN_ID, user2);

        // Verify transfer recorded in mock
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function test_NttAdapter_Bridge_RevertUnauthorizedCaller() public {
        uint256 amount = 1000e18;

        // Non-router caller should revert
        vm.prank(user1);
        vm.expectRevert(NttAdapter.UnauthorizedCaller.selector);
        nttAdapter.bridge(address(okuNote), amount, ARBITRUM_CHAIN_ID, user2);
    }

    function test_NttAdapter_Bridge_RevertUnsupportedChain() public {
        uint256 amount = 1000e18;

        vm.prank(address(bridgeRouter));
        vm.expectRevert(abi.encodeWithSelector(NttAdapter.UnsupportedChain.selector, 12_345));
        nttAdapter.bridge(address(okuNote), amount, 12_345, user2);
    }

    function test_NttAdapter_Bridge_RevertInvalidRecipient() public {
        uint256 amount = 1000e18;

        vm.prank(address(bridgeRouter));
        vm.expectRevert(NttAdapter.InvalidRecipient.selector);
        nttAdapter.bridge(address(okuNote), amount, ARBITRUM_CHAIN_ID, address(0));
    }

    function test_NttAdapter_Bridge_WithFee() public {
        uint256 amount = 1000e18;
        uint256 fee = 0.01 ether;

        mockNtt.setMessageFee(fee);

        // Bridge with fee (called by router)
        vm.deal(address(bridgeRouter), fee);
        vm.prank(address(bridgeRouter));
        nttAdapter.bridge{value: fee}(address(okuNote), amount, ARBITRUM_CHAIN_ID, user2);

        // Verify transfer succeeded
        assertEq(mockNtt.pendingTransfersCount(), 1);
    }

    function test_NttAdapter_Bridge_RevertInsufficientFee() public {
        uint256 amount = 1000e18;
        uint256 fee = 0.01 ether;

        mockNtt.setMessageFee(fee);

        // Bridge with insufficient fee (called by router)
        vm.deal(address(bridgeRouter), fee / 2);
        vm.prank(address(bridgeRouter));
        vm.expectRevert(
            abi.encodeWithSelector(MockNttManager.InsufficientFee.selector, fee, fee / 2)
        );
        nttAdapter.bridge{value: fee / 2}(address(okuNote), amount, ARBITRUM_CHAIN_ID, user2);
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

        // Verify recipient received tokens (OkuNote)
        assertEq(okuNote.balanceOf(user2), amount);

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

    // ============ Integration Tests (Router -> NttAdapter -> MockNtt) ============

    function test_Integration_BridgeOkuNote_ViaNtt() public {
        uint256 amount = 1000e18;
        _mintOkuNote(user1, amount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeVia(amount, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify tokens burned from user
        assertEq(okuNote.balanceOf(user1), 0);

        // Verify transfer recorded in NTT (raw token amount, no share conversion)
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function test_Integration_BridgeOkuUSD_ViaNtt() public {
        uint256 noteAmount = 1000e18;
        _mintOkuUsd(user1, noteAmount);

        // At notePrice=1e18, usdMultiplier=1e18: wrapping 1000 notes gives 1000 OkuUSD
        uint256 usdBalance = okuUsd.balanceOf(user1);

        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify OkuUSD burned from user
        assertEq(okuUsd.balanceOf(user1), 0);

        // Verify correct OkuNote amount recorded
        // At 1:1 pricing, unwrapping usdBalance OkuUSD yields noteAmount OkuNote
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, noteAmount);
    }

    function test_Integration_FullRoundTrip_ViaNtt() public {
        uint256 initialAmount = 1000e18;

        // Step 1: Mint OkuUSD (wraps notes into vault)
        _mintOkuUsd(user1, initialAmount);

        // Step 2: Bridge OkuUSD via NTT (unwraps to notes, burns, sends message)
        uint256 usdBalance = okuUsd.balanceOf(user1);
        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 3: Complete bridge on destination (mints OkuNote)
        mockNtt.completeBridge(0);

        // Step 4: Verify user2 received OkuNote tokens
        assertEq(okuNote.balanceOf(user2), initialAmount);
    }

    function test_Integration_FullRoundTrip_AfterNotePriceIncrease() public {
        uint256 initialAmount = 1000e18;

        // Step 1: Mint OkuNote
        _mintOkuNote(user1, initialAmount);

        // Step 2: Increase notePrice (does NOT change balanceOf — OkuNote is non-rebasing)
        uint256 newPrice = PRECISION * 12 / 10; // 20% price increase
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

        // balanceOf is unchanged — OkuNote is a standard ERC-20
        uint256 noteBalanceAfterPriceChange = okuNote.balanceOf(user1);
        assertEq(noteBalanceAfterPriceChange, initialAmount);

        // Step 3: Bridge the full balance (raw token amount)
        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), noteBalanceAfterPriceChange);
        bridgeRouter.bridgeVia(
            noteBalanceAfterPriceChange, address(nttAdapter), ARBITRUM_CHAIN_ID, user2
        );
        vm.stopPrank();

        // Verify bridged amount is exactly the token amount (no share conversion needed)
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, initialAmount);

        // Step 4: Complete
        mockNtt.completeBridge(0);

        // User2 gets exactly the same token amount
        assertEq(okuNote.balanceOf(user2), initialAmount);
    }

    function test_Integration_MultipleChains() public {
        uint256 amount1 = 500e18;
        uint256 amount2 = 750e18;
        uint256 amount3 = 1000e18;

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        _mintOkuNote(user1, amount1 + amount2 + amount3);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), amount1 + amount2 + amount3);

        bridgeRouter.bridgeVia(amount1, address(nttAdapter), ARBITRUM_CHAIN_ID, dest1);
        bridgeRouter.bridgeVia(amount2, address(nttAdapter), OPTIMISM_CHAIN_ID, dest2);
        bridgeRouter.bridgeVia(amount3, address(nttAdapter), BASE_CHAIN_ID, dest3);
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

        assertEq(okuNote.balanceOf(dest1), amount1);
        assertEq(okuNote.balanceOf(dest2), amount2);
        assertEq(okuNote.balanceOf(dest3), amount3);
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

    function testFuzz_Integration_BridgeOkuNote(uint256 amount, uint256 chainSelector) public {
        amount = bound(amount, 1e18, 100_000_000e18);

        // Select a valid chain
        uint256[] memory chains = new uint256[](3);
        chains[0] = ARBITRUM_CHAIN_ID;
        chains[1] = OPTIMISM_CHAIN_ID;
        chains[2] = BASE_CHAIN_ID;
        uint256 selectedChain = chains[chainSelector % 3];

        _mintOkuNote(user1, amount);

        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeVia(amount, address(nttAdapter), selectedChain, user2);
        vm.stopPrank();

        // Verify transfer (raw token amount, no share conversion)
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, nttAdapter.wormholeChainId(selectedChain));
    }

    function testFuzz_Integration_BridgeOkuUSD_AfterNotePriceIncrease(
        uint256 depositAmount,
        uint256 priceIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        priceIncrease = _boundNotePriceIncrease(priceIncrease);

        // Mint OkuUSD (wraps notes into vault at current notePrice)
        _mintOkuUsd(user1, depositAmount);

        // Increase notePrice (does NOT change OkuNote balances — non-rebasing)
        uint256 newPrice = okuNote.notePrice() + priceIncrease;
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

        // OkuUSD balance is independent of note price change (vault token with its own multiplier)
        uint256 usdBalance = okuUsd.balanceOf(user1);

        // Bridge OkuUSD via NTT (unwraps to notes, burns, sends message)
        vm.startPrank(user1);
        okuUsd.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Verify bridged amount is the note amount from unwrapping (price-aware)
        MockNttManager.PendingTransfer memory pending = mockNtt.getLastTransfer();
        assertGt(pending.amount, 0);
    }

    function testFuzz_Integration_FullRoundTrip(
        uint256 initialAmount,
        uint256 priceIncrease
    )
        public
    {
        initialAmount = bound(initialAmount, 1e18, 100_000_000e18);
        priceIncrease = _boundNotePriceIncrease(priceIncrease);

        // Step 1: Mint OkuNote
        _mintOkuNote(user1, initialAmount);

        // Step 2: Increase notePrice (balanceOf unchanged — non-rebasing)
        uint256 newPrice = okuNote.notePrice() + priceIncrease;
        vm.prank(rebaser);
        okuNote.updateNotePrice(newPrice);

        // balanceOf is unchanged for a non-rebasing token
        uint256 balanceBeforeBridge = okuNote.balanceOf(user1);
        assertEq(balanceBeforeBridge, initialAmount);

        // Step 3: Bridge via NTT (raw token amount)
        vm.startPrank(user1);
        okuNote.approve(address(bridgeRouter), balanceBeforeBridge);
        bridgeRouter.bridgeVia(balanceBeforeBridge, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        // Step 4: Complete on destination
        mockNtt.completeBridge(0);

        // Verify destination received exactly the same token amount
        uint256 destBalance = okuNote.balanceOf(user2);
        assertEq(destBalance, initialAmount);
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

            _mintOkuNote(users[i], amounts[i]);

            vm.startPrank(users[i]);
            okuNote.approve(address(bridgeRouter), amounts[i]);
            bridgeRouter.bridgeVia(
                amounts[i], address(nttAdapter), ARBITRUM_CHAIN_ID, destinations[i]
            );
            vm.stopPrank();
        }

        // Verify all recorded
        assertEq(mockNtt.pendingTransfersCount(), numBridges);

        // Complete all
        for (uint256 i = 0; i < numBridges; i++) {
            mockNtt.completeBridge(i);
            assertEq(okuNote.balanceOf(destinations[i]), amounts[i]);
        }
    }

    function testFuzz_SequenceNumbers(uint256 numTransfers) public {
        numTransfers = bound(numTransfers, 1, 20);

        for (uint256 i = 0; i < numTransfers; i++) {
            address sender = makeAddr(string(abi.encodePacked("sender", i)));
            _mintOkuNote(sender, 100e18);

            vm.startPrank(sender);
            okuNote.approve(address(mockNtt), 100e18);
            uint64 sequence = mockNtt.transfer(100e18, WORMHOLE_ARBITRUM, _addressToBytes32(user2));
            vm.stopPrank();

            // Sequence should increment
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(sequence, uint64(i));
        }

        assertEq(mockNtt.pendingTransfersCount(), numTransfers);
    }

    // ============ Edge Case Tests ============

    function test_NttAdapter_ZeroAmount() public {
        vm.prank(address(bridgeRouter));
        vm.expectRevert(NttAdapter.InvalidAmount.selector);
        nttAdapter.bridge(address(okuNote), 0, ARBITRUM_CHAIN_ID, user2);
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

        assertEq(okuNote.balanceOf(override_), amount);
        assertEq(okuNote.balanceOf(user2), 0);
    }

    function test_NttAdapter_WithdrawStuckETH() public {
        // Send ETH to adapter
        vm.deal(address(nttAdapter), 1 ether);

        address payable recipient = payable(makeAddr("ethRecipient"));
        uint256 balanceBefore = recipient.balance;

        vm.prank(admin);
        nttAdapter.withdrawEth(recipient);

        assertEq(recipient.balance, balanceBefore + 1 ether);
        assertEq(address(nttAdapter).balance, 0);
    }

    function test_NttAdapter_WithdrawStuckTokens() public {
        uint256 amount = 1000e18;
        // Simulate stuck tokens (could happen from failed operations or other issues)
        _mintOkuNote(address(nttAdapter), amount);

        address recipient = makeAddr("tokenRecipient");

        vm.prank(admin);
        nttAdapter.withdrawTokens(address(okuNote), recipient, amount);

        assertEq(okuNote.balanceOf(recipient), amount);
        assertEq(okuNote.balanceOf(address(nttAdapter)), 0);
    }

    // ============ NttAdapter Role Enforcement ============

    function test_NttAdapter_WithdrawTokens_RevertIfNotOwner() public {
        _mintOkuNote(address(nttAdapter), 1000e18);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        nttAdapter.withdrawTokens(address(okuNote), user1, 1000e18);
    }

    function test_NttAdapter_WithdrawEth_RevertIfNotOwner() public {
        vm.deal(address(nttAdapter), 1 ether);

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        nttAdapter.withdrawEth(payable(user1));
    }

    function test_NttAdapter_ConfigureChainId_EmitsEvent() public {
        uint256 newChainId = 999;
        uint16 newWormholeId = 99;

        vm.expectEmit(false, false, false, true, address(nttAdapter));
        emit ChainIdConfigured(newChainId, newWormholeId);

        vm.prank(admin);
        nttAdapter.configureChainId(newChainId, newWormholeId);
    }

    // ============ RedemptionQueue UUPS Upgrade ============

    function test_UUPS_UpgradeRedemptionQueue() public {
        RedemptionQueue newImpl = new RedemptionQueue();

        vm.prank(admin);
        redemptionQueue.upgradeToAndCall(address(newImpl), "");

        // State preserved
        assertEq(address(redemptionQueue.okuNote()), address(okuNote));
    }

    function test_UUPS_UpgradeRedemptionQueue_RevertNotUpgrader() public {
        RedemptionQueue newImpl = new RedemptionQueue();

        vm.prank(user1);
        bytes32 QUEUE_UPGRADER = keccak256("UPGRADER");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_UPGRADER
            )
        );
        redemptionQueue.upgradeToAndCall(address(newImpl), "");
    }
}
