// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeBaseTest} from "../BridgeBase.t.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Vm} from "forge-std/Vm.sol";

/**
 * @title BridgeStatelessFuzzTest
 * @notice Stateless fuzz tests for OkuBridge per-call integrity properties.
 * @dev These verify single-call invariants (fee math, nonce monotonicity per call,
 *      bridge holds no tokens after a single burn). Stateful multi-call invariants
 *      live in `test/invariants/BridgeInvariants.t.sol` and use `OkuBridgeHandler`.
 */
contract BridgeStatelessFuzzTest is BridgeBaseTest {
    // ============ State for invariant tracking ============

    uint256 public DEST_CHAIN; // Set to ARBITRUM_CHAIN_ID in setUp
    uint256 public bridgeOperationCount;
    bytes32[] public allRequestIds;
    uint256 public lastNonce;

    function setUp() public override {
        super.setUp();

        DEST_CHAIN = ARBITRUM_CHAIN_ID;

        // Seed user with OkuMoney for bridging
        _mintOkuMoney(user1, 100_000_000e18);
        vm.prank(user1);
        okuMoney.approve(address(okuBridge), type(uint256).max);

        lastNonce = okuBridge.outboundNonce(DEST_CHAIN);
    }

    // ============ Fuzz Tests as Invariant Checks ============

    /**
     * @notice Bridge fee is always calculated correctly
     * @dev Fee should be exactly (amount * bridgeFee) / BASIS_POINTS
     */
    function testFuzz_FeeCalculationCorrect(uint256 amount) public {
        // Bound to valid bridge amounts
        uint128 minAmount = okuBridge.minBridgeAmount();
        uint128 maxAmount = okuBridge.maxBridgeAmount();
        amount = bound(amount, minAmount, maxAmount);

        uint256 balanceBefore = okuMoney.balanceOf(address(feeRecipient));

        vm.prank(user1);
        okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amount);

        uint256 balanceAfter = okuMoney.balanceOf(address(feeRecipient));
        uint256 actualFee = balanceAfter - balanceBefore;

        uint256 expectedFee = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;

        assertEq(actualFee, expectedFee, "Fee calculation incorrect");
    }

    /**
     * @notice Nonce increments exactly once per bridge operation
     */
    function testFuzz_NonceIncrementsOnce(uint256 amount) public {
        uint128 minAmount = okuBridge.minBridgeAmount();
        uint128 maxAmount = okuBridge.maxBridgeAmount();
        amount = bound(amount, minAmount, maxAmount);

        uint256 nonceBefore = okuBridge.outboundNonce(DEST_CHAIN);

        vm.prank(user1);
        okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amount);

        uint256 nonceAfter = okuBridge.outboundNonce(DEST_CHAIN);

        assertEq(nonceAfter, nonceBefore + 1, "Nonce should increment by exactly 1");
    }

    /**
     * @notice Bridge correctly burns tokens (total supply decreases)
     */
    function testFuzz_BridgeBurnsTokens(uint256 amount) public {
        uint128 minAmount = okuBridge.minBridgeAmount();
        uint128 maxAmount = okuBridge.maxBridgeAmount();
        amount = bound(amount, minAmount, maxAmount);

        uint256 supplyBefore = okuMoney.totalSupply();

        vm.prank(user1);
        okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amount);

        uint256 supplyAfter = okuMoney.totalSupply();

        // Supply should decrease by (amount - fee) because fee is re-minted
        uint256 fee = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;
        uint256 expectedDecrease = amount - fee;

        assertEq(
            supplyBefore - supplyAfter, expectedDecrease, "Supply should decrease by net amount"
        );
    }

    /**
     * @notice Multiple sequential bridges maintain nonce ordering
     */
    function testFuzz_SequentialBridgesNoncesOrdered(uint8 count) public {
        count = uint8(bound(count, 1, 10));

        uint256 startNonce = okuBridge.outboundNonce(DEST_CHAIN);
        uint256 amountPerBridge = okuBridge.minBridgeAmount();

        for (uint8 i = 0; i < count; i++) {
            vm.prank(user1);
            okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amountPerBridge);
        }

        uint256 endNonce = okuBridge.outboundNonce(DEST_CHAIN);

        assertEq(endNonce, startNonce + count, "Nonces should increment sequentially");
    }

    /**
     * @notice Request IDs are unique (no collisions)
     * @dev Request ID is keccak256 of the full request struct, which includes nonce
     */
    function test_RequestIdsUniqueViaReturnValue() public {
        uint256 amountPerBridge = okuBridge.minBridgeAmount();
        bytes32 recipient = bytes32(uint256(uint160(user2)));

        // Store request IDs from return values
        vm.prank(user1);
        bytes32 requestId1 = okuBridge.bridgeBurn(DEST_CHAIN, recipient, amountPerBridge);

        vm.prank(user1);
        bytes32 requestId2 = okuBridge.bridgeBurn(DEST_CHAIN, recipient, amountPerBridge);

        vm.prank(user1);
        bytes32 requestId3 = okuBridge.bridgeBurn(DEST_CHAIN, recipient, amountPerBridge);

        // Verify all request IDs are different (due to different nonces)
        assertTrue(requestId1 != requestId2, "Request IDs 1 and 2 should differ");
        assertTrue(requestId2 != requestId3, "Request IDs 2 and 3 should differ");
        assertTrue(requestId1 != requestId3, "Request IDs 1 and 3 should differ");
    }

    /**
     * @notice Bridge does not hold OkuMoney (burns everything, mints fee separately)
     */
    function testFuzz_BridgeDoesNotHoldTokens(uint256 amount) public {
        uint128 minAmount = okuBridge.minBridgeAmount();
        uint128 maxAmount = okuBridge.maxBridgeAmount();
        amount = bound(amount, minAmount, maxAmount);

        vm.prank(user1);
        okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amount);

        uint256 bridgeBalance = okuMoney.balanceOf(address(okuBridge));
        assertEq(bridgeBalance, 0, "Bridge should not hold any tokens after burn");
    }

    /**
     * @notice Limits are enforced correctly
     */
    function testFuzz_LimitsEnforced(uint256 amount) public {
        uint128 minAmount = okuBridge.minBridgeAmount();
        uint128 maxAmount = okuBridge.maxBridgeAmount();

        // Try below minimum
        if (amount < minAmount && amount > 0) {
            vm.prank(user1);
            vm.expectRevert(
                abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, amount, minAmount)
            );
            okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amount);
        }

        // Try above maximum
        if (amount > maxAmount) {
            vm.prank(user1);
            vm.expectRevert(
                abi.encodeWithSelector(OkuBridge.AmountAboveMaximum.selector, amount, maxAmount)
            );
            okuBridge.bridgeBurn(DEST_CHAIN, bytes32(uint256(uint160(user2))), amount);
        }
    }

    /**
     * @notice Cannot bridge to unsupported chain
     */
    function testFuzz_UnsupportedChainReverts(uint256 chainId) public {
        // Exclude supported chains and self-chain
        vm.assume(chainId != DEST_CHAIN);
        vm.assume(chainId != block.chainid);
        vm.assume(!okuBridge.supportedChains(chainId));

        uint256 amount = okuBridge.minBridgeAmount();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, chainId));
        okuBridge.bridgeBurn(chainId, bytes32(uint256(uint160(user2))), amount);
    }

    /**
     * @notice Cannot bridge to self (same chain)
     */
    function test_CannotBridgeToSelf() public {
        uint256 amount = okuBridge.minBridgeAmount();

        vm.prank(user1);
        vm.expectRevert(OkuBridge.CannotBridgeToSelf.selector);
        okuBridge.bridgeBurn(block.chainid, bytes32(uint256(uint160(user2))), amount);
    }
}
