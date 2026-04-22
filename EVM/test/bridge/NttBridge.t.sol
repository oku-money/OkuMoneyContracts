// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeBaseTest} from "../BridgeBase.t.sol";
import {NttAdapter} from "../../src/bridge/adapters/NttAdapter.sol";
import {MockNttManager} from "../../src/mocks/MockNttManager.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title NttBridgeTest
 * @notice Tests for the Wormhole NTT bridge adapter integration.
 * @dev Extends BridgeBaseTest (which deploys OkuBridge, OkuBridgeRouter, and mock adapters),
 *      then layers NttAdapter + its own MockNttManager instance on top.
 *
 *      OkuMoney is a standard non-rebasing ERC-20. `okuMMultiplier()` is a pricing view
 *      and does NOT affect `balanceOf()`. The bridge operates on raw token amounts — no
 *      share conversion.
 *
 *      Testable on a local chain:
 *      - Source chain: adapter forwards burned-amount message to NttManager
 *      - Type conversions: address <-> bytes32, uint256 <-> uint16
 *      - Fee handling: message fee forwarded to NttManager
 *      - Full flow: OkuBridgeRouter → NttAdapter → MockNttManager
 *
 *      NOT testable without a fork:
 *      - Guardian signatures / VAA validation
 *      - Real `receiveMessage()` on the destination chain
 */
contract NttBridgeTest is BridgeBaseTest {
    NttAdapter public nttAdapter;
    MockNttManager public nttManager;

    // Wormhole chain IDs
    uint16 public constant WORMHOLE_ARBITRUM = 23;
    uint16 public constant WORMHOLE_OPTIMISM = 24;
    uint16 public constant WORMHOLE_BASE = 30;

    // Events
    event BridgeInitiated(
        uint256 amount, uint16 wormholeChainId, bytes32 recipient, uint64 sequence
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

        // Deploy a dedicated MockNttManager for NTT-specific tests. We reuse the
        // inherited bridgeRouter from BridgeBaseTest (it is real, not a placeholder).
        nttManager = new MockNttManager(address(okuMoney));

        nttAdapter =
            new NttAdapter(address(nttManager), address(okuMoney), address(bridgeRouter), admin);

        // Grant MINTER + allowance to the NTT manager mock so completeBridge* can mint.
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(nttManager));
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(nttManager), MAX_SUPPLY);

        // Register NttAdapter on the router
        vm.prank(admin);
        bridgeRouter.configureAdapter(address(nttAdapter), true);
    }

    // ============ Helpers ============

    function _addressToBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    function _bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    // ============ NttAdapter Initialization ============

    function test_NttAdapter_Initialize() public view {
        assertEq(address(nttAdapter.NTT_MANAGER()), address(nttManager));
        assertEq(nttAdapter.TOKEN(), address(okuMoney));
        assertEq(nttAdapter.ROUTER(), address(bridgeRouter));
        // NttAdapter now uses AccessControl rather than Ownable — verify admin holds
        // every defined role.
        assertTrue(nttAdapter.hasRole(nttAdapter.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(nttAdapter.hasRole(nttAdapter.NTT_CONFIGURATOR(), admin));
        assertTrue(nttAdapter.hasRole(nttAdapter.NTT_RESCUER(), admin));
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

    function test_NttAdapter_ConfigureChainId_RevertIfNotConfigurator() public {
        bytes32 role = nttAdapter.NTT_CONFIGURATOR();
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        nttAdapter.configureChainId(999, 99);
    }

    function test_NttAdapter_ConfigureChainId_EmitsEvent() public {
        uint256 newChainId = 999;
        uint16 newWormholeId = 99;

        vm.expectEmit(false, false, false, true, address(nttAdapter));
        emit ChainIdConfigured(newChainId, newWormholeId);

        vm.prank(admin);
        nttAdapter.configureChainId(newChainId, newWormholeId);
    }

    // ============ NttAdapter.bridge() ============

    function test_NttAdapter_Bridge() public {
        uint256 amount = 1000e18;

        vm.prank(address(bridgeRouter));
        vm.expectEmit(false, false, false, true, address(nttAdapter));
        emit BridgeInitiated(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2), 0);
        nttAdapter.bridge(address(okuMoney), amount, ARBITRUM_CHAIN_ID, user2);

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function test_NttAdapter_Bridge_RevertUnauthorizedCaller() public {
        vm.prank(user1);
        vm.expectRevert(NttAdapter.UnauthorizedCaller.selector);
        nttAdapter.bridge(address(okuMoney), 1000e18, ARBITRUM_CHAIN_ID, user2);
    }

    function test_NttAdapter_Bridge_RevertUnsupportedChain() public {
        vm.prank(address(bridgeRouter));
        vm.expectRevert(abi.encodeWithSelector(NttAdapter.UnsupportedChain.selector, 12_345));
        nttAdapter.bridge(address(okuMoney), 1000e18, 12_345, user2);
    }

    function test_NttAdapter_Bridge_RevertInvalidRecipient() public {
        vm.prank(address(bridgeRouter));
        vm.expectRevert(NttAdapter.InvalidRecipient.selector);
        nttAdapter.bridge(address(okuMoney), 1000e18, ARBITRUM_CHAIN_ID, address(0));
    }

    function test_NttAdapter_Bridge_RevertInvalidAmount() public {
        vm.prank(address(bridgeRouter));
        vm.expectRevert(NttAdapter.InvalidAmount.selector);
        nttAdapter.bridge(address(okuMoney), 0, ARBITRUM_CHAIN_ID, user2);
    }

    function test_NttAdapter_Bridge_RevertInvalidToken() public {
        address wrongToken = makeAddr("wrongToken");
        vm.prank(address(bridgeRouter));
        vm.expectRevert(
            abi.encodeWithSelector(NttAdapter.InvalidToken.selector, wrongToken, address(okuMoney))
        );
        nttAdapter.bridge(wrongToken, 1000e18, ARBITRUM_CHAIN_ID, user2);
    }

    function test_NttAdapter_Bridge_WithFee() public {
        uint256 amount = 1000e18;
        uint256 fee = 0.01 ether;
        nttManager.setMessageFee(fee);

        vm.deal(address(bridgeRouter), fee);
        vm.prank(address(bridgeRouter));
        nttAdapter.bridge{value: fee}(address(okuMoney), amount, ARBITRUM_CHAIN_ID, user2);

        assertEq(nttManager.pendingTransfersCount(), 1);
    }

    function test_NttAdapter_Bridge_RevertInsufficientFee() public {
        uint256 amount = 1000e18;
        uint256 fee = 0.01 ether;
        nttManager.setMessageFee(fee);

        vm.deal(address(bridgeRouter), fee / 2);
        vm.prank(address(bridgeRouter));
        vm.expectRevert(
            abi.encodeWithSelector(MockNttManager.InsufficientFee.selector, fee, fee / 2)
        );
        nttAdapter.bridge{value: fee / 2}(address(okuMoney), amount, ARBITRUM_CHAIN_ID, user2);
    }

    // ============ NttAdapter Recovery ============

    function test_NttAdapter_WithdrawStuckETH() public {
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
        _mintOkuMoney(address(nttAdapter), amount);

        address recipient = makeAddr("tokenRecipient");

        vm.prank(admin);
        nttAdapter.withdrawTokens(address(okuMoney), recipient, amount);

        assertEq(okuMoney.balanceOf(recipient), amount);
        assertEq(okuMoney.balanceOf(address(nttAdapter)), 0);
    }

    function test_NttAdapter_WithdrawTokens_RevertIfNotRescuer() public {
        _mintOkuMoney(address(nttAdapter), 1000e18);

        bytes32 role = nttAdapter.NTT_RESCUER();
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        nttAdapter.withdrawTokens(address(okuMoney), user1, 1000e18);
    }

    function test_NttAdapter_WithdrawEth_RevertIfNotRescuer() public {
        vm.deal(address(nttAdapter), 1 ether);

        bytes32 role = nttAdapter.NTT_RESCUER();
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        nttAdapter.withdrawEth(payable(user1));
    }

    /// @notice NttAdapter has a `receive()` fallback so WETH refunds / ETH returns land here.
    function test_NttAdapter_ReceiveEth() public {
        uint256 amount = 0.5 ether;
        vm.deal(user1, amount);

        vm.prank(user1);
        (bool ok,) = address(nttAdapter).call{value: amount}("");
        assertTrue(ok);
        assertEq(address(nttAdapter).balance, amount);
    }

    /// @notice Configure a non-standard EVM chain ID and verify it is used.
    function test_NttAdapter_ConfigureNonStandardChainId() public {
        uint256 newChainId = 999_999;
        uint16 wormholeId = 42;

        vm.prank(admin);
        nttAdapter.configureChainId(newChainId, wormholeId);

        // Bridging to the newly configured chain should now succeed.
        uint256 amount = 1000e18;
        vm.prank(address(bridgeRouter));
        nttAdapter.bridge(address(okuMoney), amount, newChainId, user2);

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertEq(pending.recipientChain, wormholeId);
    }

    // ============ MockNttManager Behaviour ============

    function test_MockNtt_Transfer() public {
        uint256 amount = 1000e18;

        vm.prank(user1);
        vm.expectEmit(true, false, false, true, address(nttManager));
        emit TransferInitiated(user1, amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2), 0);

        uint64 sequence = nttManager.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        assertEq(sequence, 0);
        assertEq(nttManager.pendingTransfersCount(), 1);
    }

    function test_MockNtt_CompleteBridge() public {
        uint256 amount = 1000e18;

        vm.prank(user1);
        nttManager.transfer(amount, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        vm.expectEmit(true, true, false, true, address(nttManager));
        emit TransferCompleted(0, user2, amount);
        nttManager.completeBridge(0);

        assertEq(okuMoney.balanceOf(user2), amount);

        MockNttManager.PendingTransfer memory pending = nttManager.getPendingTransfer(0);
        assertTrue(pending.completed);
    }

    function test_MockNtt_CompleteBridge_RevertAlreadyCompleted() public {
        vm.prank(user1);
        nttManager.transfer(1000e18, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        nttManager.completeBridge(0);
        vm.expectRevert(MockNttManager.TransferAlreadyCompleted.selector);
        nttManager.completeBridge(0);
    }

    function test_MockNtt_ReceiveMessage_Reverts() public {
        vm.expectRevert(MockNttManager.CannotForgeGuardianSignatures.selector);
        nttManager.receiveMessage(hex"deadbeef");
    }

    function test_MockNtt_InvalidIndex() public {
        vm.expectRevert(MockNttManager.InvalidTransferIndex.selector);
        nttManager.getPendingTransfer(999);
    }

    function test_MockNtt_CompleteBridgeTo() public {
        vm.prank(user1);
        nttManager.transfer(1000e18, WORMHOLE_ARBITRUM, _addressToBytes32(user2));

        address override_ = makeAddr("override");
        nttManager.completeBridgeTo(0, override_);

        assertEq(okuMoney.balanceOf(override_), 1000e18);
        assertEq(okuMoney.balanceOf(user2), 0);
    }

    // ============ Integration (Router → NttAdapter → MockNtt) ============

    function test_Integration_BridgeOkuMoney_ViaNtt() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeVia(amount, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        assertEq(okuMoney.balanceOf(user1), 0);

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, WORMHOLE_ARBITRUM);
        assertEq(_bytes32ToAddress(pending.recipient), user2);
    }

    function test_Integration_BridgeOkuDollar_ViaNtt() public {
        uint256 okuMAmount = 1000e18;
        _mintUsdOku(user1, okuMAmount);

        uint256 usdBalance = usdOku.balanceOf(user1);

        vm.startPrank(user1);
        usdOku.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        assertEq(usdOku.balanceOf(user1), 0);

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertEq(pending.amount, okuMAmount);
    }

    function test_Integration_FullRoundTrip_ViaNtt() public {
        uint256 initialAmount = 1000e18;
        _mintUsdOku(user1, initialAmount);

        uint256 usdBalance = usdOku.balanceOf(user1);
        vm.startPrank(user1);
        usdOku.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        nttManager.completeBridge(0);

        assertEq(okuMoney.balanceOf(user2), initialAmount);
    }

    function test_Integration_FullRoundTrip_AfterNotePriceIncrease() public {
        uint256 initialAmount = 1000e18;
        _mintOkuMoney(user1, initialAmount);

        // Raise okuMMultiplier by 20% — balanceOf is unchanged (non-rebasing).
        uint256 newPrice = PRECISION * 12 / 10;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        uint256 tokenBalance = okuMoney.balanceOf(user1);
        assertEq(tokenBalance, initialAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), tokenBalance);
        bridgeRouter.bridgeVia(tokenBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertEq(pending.amount, initialAmount);

        nttManager.completeBridge(0);
        assertEq(okuMoney.balanceOf(user2), initialAmount);
    }

    function test_Integration_MultipleChains() public {
        uint256 amount1 = 500e18;
        uint256 amount2 = 750e18;
        uint256 amount3 = 1000e18;

        address dest1 = makeAddr("dest1");
        address dest2 = makeAddr("dest2");
        address dest3 = makeAddr("dest3");

        _mintOkuMoney(user1, amount1 + amount2 + amount3);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), amount1 + amount2 + amount3);
        bridgeRouter.bridgeVia(amount1, address(nttAdapter), ARBITRUM_CHAIN_ID, dest1);
        bridgeRouter.bridgeVia(amount2, address(nttAdapter), OPTIMISM_CHAIN_ID, dest2);
        bridgeRouter.bridgeVia(amount3, address(nttAdapter), BASE_CHAIN_ID, dest3);
        vm.stopPrank();

        assertEq(nttManager.pendingTransfersCount(), 3);
        assertEq(nttManager.getPendingTransfer(0).recipientChain, WORMHOLE_ARBITRUM);
        assertEq(nttManager.getPendingTransfer(1).recipientChain, WORMHOLE_OPTIMISM);
        assertEq(nttManager.getPendingTransfer(2).recipientChain, WORMHOLE_BASE);

        nttManager.completeBridge(0);
        nttManager.completeBridge(1);
        nttManager.completeBridge(2);

        assertEq(okuMoney.balanceOf(dest1), amount1);
        assertEq(okuMoney.balanceOf(dest2), amount2);
        assertEq(okuMoney.balanceOf(dest3), amount3);
    }

    // ============ Fuzz Tests (integration only — no tests-the-mock) ============

    function testFuzz_Integration_BridgeOkuMoney(uint256 amount, uint256 chainSelector) public {
        amount = bound(amount, 1e18, 100_000_000e18);

        uint256[3] memory chains = [ARBITRUM_CHAIN_ID, OPTIMISM_CHAIN_ID, BASE_CHAIN_ID];
        uint256 selectedChain = chains[chainSelector % 3];

        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), amount);
        bridgeRouter.bridgeVia(amount, address(nttAdapter), selectedChain, user2);
        vm.stopPrank();

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertEq(pending.amount, amount);
        assertEq(pending.recipientChain, nttAdapter.wormholeChainId(selectedChain));
    }

    function testFuzz_Integration_BridgeOkuDollar_AfterNotePriceIncrease(
        uint256 depositAmount,
        uint256 priceIncrease
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, 100_000_000e18);
        priceIncrease = _boundOkuMMultiplierIncrease(priceIncrease);

        _mintUsdOku(user1, depositAmount);

        uint256 newPrice = okuMoney.okuMMultiplier() + priceIncrease;
        _setOkuMMultiplierAndRoll(newPrice);

        uint256 usdBalance = usdOku.balanceOf(user1);

        vm.startPrank(user1);
        usdOku.approve(address(bridgeRouter), usdBalance);
        bridgeRouter.bridgeWrappedVia(usdBalance, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        MockNttManager.PendingTransfer memory pending = nttManager.getLastTransfer();
        assertGt(pending.amount, 0);
    }

    function testFuzz_Integration_FullRoundTrip(
        uint256 initialAmount,
        uint256 priceIncrease
    )
        public
    {
        initialAmount = bound(initialAmount, 1e18, 100_000_000e18);
        priceIncrease = _boundOkuMMultiplierIncrease(priceIncrease);

        _mintOkuMoney(user1, initialAmount);

        uint256 newPrice = okuMoney.okuMMultiplier() + priceIncrease;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        uint256 balanceBeforeBridge = okuMoney.balanceOf(user1);
        assertEq(balanceBeforeBridge, initialAmount);

        vm.startPrank(user1);
        okuMoney.approve(address(bridgeRouter), balanceBeforeBridge);
        bridgeRouter.bridgeVia(balanceBeforeBridge, address(nttAdapter), ARBITRUM_CHAIN_ID, user2);
        vm.stopPrank();

        nttManager.completeBridge(0);

        assertEq(okuMoney.balanceOf(user2), initialAmount);
    }

    function testFuzz_MultipleBridges_ViaNtt(uint256 numBridges, uint256 baseSeed) public {
        numBridges = bound(numBridges, 1, 15);

        address[] memory users = new address[](numBridges);
        uint256[] memory amounts = new uint256[](numBridges);
        address[] memory destinations = new address[](numBridges);

        for (uint256 i = 0; i < numBridges; i++) {
            users[i] = makeAddr(string(abi.encodePacked("nttUser", i)));
            destinations[i] = makeAddr(string(abi.encodePacked("nttDest", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 10_000_000e18);

            _mintOkuMoney(users[i], amounts[i]);

            vm.startPrank(users[i]);
            okuMoney.approve(address(bridgeRouter), amounts[i]);
            bridgeRouter.bridgeVia(
                amounts[i], address(nttAdapter), ARBITRUM_CHAIN_ID, destinations[i]
            );
            vm.stopPrank();
        }

        assertEq(nttManager.pendingTransfersCount(), numBridges);

        for (uint256 i = 0; i < numBridges; i++) {
            nttManager.completeBridge(i);
            assertEq(okuMoney.balanceOf(destinations[i]), amounts[i]);
        }
    }
}
