// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeBaseTest} from "../BridgeBase.t.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {OkuBridgeEvents} from "../../src/lib/events/OkuBridgeEvents.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Deploy} from "../shared/Deploy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title OkuBridgeTest
 * @notice Comprehensive test suite for OkuBridge contract
 * @dev Updated for OkuMoney non-rebasing redesign. Bridge operates on raw token
 *      amounts — no share conversion. Round-trip amounts are exact (no rounding).
 *
 *      Inherits from BridgeBaseTest which provides:
 *      - All role constants (BRIDGE_*, OKUM_*, etc.)
 *      - Chain ID constants (OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID, etc.)
 *      - okuBridge deployment and setup
 *      - Helper functions (_signBridgeRequest, _approveBridgeBurn, etc.)
 */
contract OkuBridgeTest is BridgeBaseTest {
    // Note: okuBridge, okuBridgeImpl, orchestratorSigner, orchestratorPk, feeRecipient,
    // refundInitiator, refundConfirmer, and all role/chain constants are inherited from BridgeBaseTest

    // ============ Unit Tests - bridgeBurn() ============

    function test_BridgeBurn_Success() public {
        uint256 amount = 100e18;
        uint256 fee = (amount * 10) / BASIS_POINTS; // 0.1% fee
        uint256 netAmount = amount - fee;

        _mintOkuMoney(user1, amount);

        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);
        uint256 feeRecipientBalanceBefore = okuMoney.balanceOf(feeRecipient);
        uint256 nonceBefore = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        bytes32 requestId =
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();

        // Verify exact amount burned from user
        assertEq(okuMoney.balanceOf(user1), user1BalanceBefore - amount);

        // Verify fee collected
        assertEq(okuMoney.balanceOf(feeRecipient), feeRecipientBalanceBefore + fee);

        // Verify nonce incremented
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 1);

        // Verify requestId encodes netAmount (what destination will mint)
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: netAmount,
            nonce: nonceBefore,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
        bytes32 expectedRequestId = keccak256(abi.encode(request));
        assertEq(requestId, expectedRequestId);
    }

    function test_BridgeBurn_RevertUnsupportedChain() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, UNSUPPORTED_CHAIN_ID)
        );
        okuBridge.bridgeBurn(UNSUPPORTED_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();
    }

    function test_BridgeBurn_RevertBelowMinimum() public {
        uint256 minAmount = okuBridge.minBridgeAmount();
        uint256 amount = minAmount - 1;

        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, amount, minAmount)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();
    }

    function test_BridgeBurn_RevertAboveMaximum() public {
        uint256 maxAmount = okuBridge.maxBridgeAmount();
        uint256 amount = maxAmount + 1;

        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountAboveMaximum.selector, amount, maxAmount)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();
    }

    function test_BridgeBurn_RevertWhenPaused() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        vm.prank(admin);
        okuBridge.pause();

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();
    }

    function test_BridgeBurn_FeeCalculation() public {
        uint256 amount = 1000e18;

        // Test with 0.1% fee (default)
        uint256 fee = (amount * 10) / BASIS_POINTS;
        _mintOkuMoney(user1, amount);

        uint256 feeRecipientBefore = okuMoney.balanceOf(feeRecipient);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        assertEq(okuMoney.balanceOf(feeRecipient), feeRecipientBefore + fee);

        // Update fee to 1%
        vm.prank(admin);
        okuBridge.updateFee(100);

        uint256 newFee = (amount * 100) / BASIS_POINTS;
        _mintOkuMoney(user1, amount);

        feeRecipientBefore = okuMoney.balanceOf(feeRecipient);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        assertEq(okuMoney.balanceOf(feeRecipient), feeRecipientBefore + newFee);
    }

    function test_BridgeBurn_NonceIncrement() public {
        uint256 amount = 100e18;

        for (uint256 i = 0; i < 5; i++) {
            _mintOkuMoney(user1, amount);

            uint256 expectedNonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

            _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

            assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), expectedNonce + 1);
        }
    }

    function test_BridgeBurn_MultipleDestinations_IndependentNonces() public {
        uint256 amount = 100e18;

        // Bridge to Optimism 3 times
        for (uint256 i = 0; i < 3; i++) {
            _mintOkuMoney(user1, amount);
            _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);
        }

        // Bridge to Arbitrum 3 times
        for (uint256 i = 0; i < 3; i++) {
            _mintOkuMoney(user1, amount);
            _approveBridgeBurn(user1, ARBITRUM_CHAIN_ID, user2, amount);
        }

        // Verify independent nonces
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), 3);
        assertEq(okuBridge.outboundNonce(ARBITRUM_CHAIN_ID), 3);
        assertEq(okuBridge.outboundNonce(BASE_CHAIN_ID), 0); // Unused chain
    }

    // ============ Unit Tests - bridgeMint() ============

    function test_BridgeMint_ValidSignature() public {
        uint256 amount = 100e18;

        // Create request
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        uint256 user2BalanceBefore = okuMoney.balanceOf(user2);

        okuBridge.bridgeMint(request, signature);

        // Verify amount minted to recipient
        assertEq(okuMoney.balanceOf(user2), user2BalanceBefore + amount);

        // Verify requestId marked as processed
        assertTrue(okuBridge.processedRequests(requestId));
    }

    function test_BridgeMint_RevertInvalidSignature() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        // Sign with wrong private key
        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.amount,
                request.nonce,
                request.deadline
            )
        );
        bytes32 digest = okuBridge.hashTypedDataV4(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory wrongSignature = abi.encodePacked(r, s, v);

        vm.expectRevert(OkuBridge.InvalidSignature.selector);
        okuBridge.bridgeMint(request, wrongSignature);
    }

    function test_BridgeMint_RevertExpiredDeadline() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp - 1 // Past deadline
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.SignatureExpired.selector);
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertWrongChain() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: ARBITRUM_CHAIN_ID, // Wrong chain
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.WrongChain.selector, ARBITRUM_CHAIN_ID, block.chainid)
        );
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertReplay() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        // First mint succeeds
        okuBridge.bridgeMint(request, signature);

        // Second mint with same request should fail
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.AlreadyProcessed.selector, requestId));
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertWhenPaused() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.prank(admin);
        okuBridge.pause();

        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuBridge.bridgeMint(request, signature);
    }

    // ============ Integration Tests - Full Round-Trip ============

    function test_FullRoundTrip_SingleUser() public {
        uint256 amount = 100e18;
        uint256 fee = (amount * 10) / BASIS_POINTS;
        uint256 netAmount = amount - fee;

        // Step 1: User1 bridges from source
        _mintOkuMoney(user1, amount);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        // Verify burn happened
        assertEq(okuMoney.balanceOf(user1), 0);

        // Step 2: Create request for destination (same chainid for testing)
        // Request encodes netAmount — what destination will mint
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid, // Use current chainid
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: netAmount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        // Step 3: Mint on destination
        uint256 user2Before = okuMoney.balanceOf(user2);
        okuBridge.bridgeMint(request, signature);

        // Verify exact netAmount minted to recipient (no rounding — non-rebasing)
        assertEq(okuMoney.balanceOf(user2), user2Before + netAmount);

        // Verify fee was collected
        assertEq(okuMoney.balanceOf(feeRecipient), fee);
    }

    function test_FullRoundTrip_WithNotePriceIncrease() public {
        uint256 amount = 100e18;
        uint256 fee = (amount * 10) / BASIS_POINTS;
        uint256 netAmount = amount - fee;

        // Step 1: Mint and bridge
        _mintOkuMoney(user1, amount);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        // Step 2: Increase okuMMultiplier by 50%
        // OkuMoney is non-rebasing: okuMMultiplier tracks multiplier appreciation but does NOT
        // change balanceOf(). Bridge amounts are unaffected.
        uint256 oldPrice = okuMoney.okuMMultiplier();
        uint256 newPrice = (oldPrice * 150) / 100;

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Step 3: Create request and sign (encodes netAmount)
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: netAmount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        // Step 4: Mint on destination
        okuBridge.bridgeMint(request, signature);

        // Verify user2 received exact netAmount (okuMMultiplier change has no effect
        // on balanceOf — OkuMoney is non-rebasing)
        assertEq(okuMoney.balanceOf(user2), netAmount);
    }

    function test_BridgeBurn_MultipleUsers_IncrementNonce() public {
        uint256 amount = 50e18;

        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            address user = address(uint160(i + 1000));
            _mintOkuMoney(user, amount);

            vm.startPrank(user);
            okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user));
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user))), amount);
            vm.stopPrank();
        }

        // Verify nonce incremented correctly
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), 5);
    }

    function test_FullRoundTrip_ZeroFee() public {
        uint256 amount = 100e18;

        // Set fee to 0
        vm.prank(admin);
        okuBridge.updateFee(0);

        _mintOkuMoney(user1, amount);

        uint256 feeRecipientBefore = okuMoney.balanceOf(feeRecipient);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        // Verify no fee collected
        assertEq(okuMoney.balanceOf(feeRecipient), feeRecipientBefore);
    }

    // ============ Admin Function Tests ============

    function test_UpdateAuthorizedSigner_Success() public {
        address newSigner = makeAddr("newSigner");

        vm.prank(admin);
        okuBridge.updateAuthorizedSigner(newSigner);

        assertEq(okuBridge.authorizedSigner(), newSigner);

        // Verify old signatures no longer work
        uint256 amount = 100e18;
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory oldSignature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.InvalidSignature.selector);
        okuBridge.bridgeMint(request, oldSignature);
    }

    function test_UpdateAuthorizedSigner_RevertNotAuthorized() public {
        address newSigner = makeAddr("newSigner");
        // Role aliases were removed from the contracts in favour of the shared Roles
        // library; tests reference TestRoles directly.
        bytes32 role = BRIDGE_SIGNER_MANAGER;

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        vm.prank(user1);
        okuBridge.updateAuthorizedSigner(newSigner);
    }

    function test_UpdateFee_Success() public {
        uint256 newFee = 50; // 0.5%

        vm.prank(admin);
        okuBridge.updateFee(newFee);

        assertEq(okuBridge.bridgeFee(), newFee);
    }

    function test_UpdateFee_RevertInvalidFee() public {
        uint256 invalidFee = 10_001; // > 100%

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.InvalidFee.selector, invalidFee));
        okuBridge.updateFee(invalidFee);
    }

    function test_AddSupportedChain_Success() public {
        uint256 newChainId = 137; // Polygon

        vm.prank(admin);
        okuBridge.addSupportedChain(newChainId);

        assertTrue(okuBridge.supportedChains(newChainId));

        // Verify can bridge to it
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        _approveBridgeBurn(user1, newChainId, user2, amount);
    }

    function test_RemoveSupportedChain_Success() public {
        vm.prank(admin);
        okuBridge.removeSupportedChain(OPTIMISM_CHAIN_ID);

        assertFalse(okuBridge.supportedChains(OPTIMISM_CHAIN_ID));

        // Verify cannot bridge to it
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, OPTIMISM_CHAIN_ID)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();
    }

    function test_AddSupportedChain_RevertSelfChain() public {
        vm.prank(admin);
        vm.expectRevert(OkuBridge.CannotBridgeToSelf.selector);
        okuBridge.addSupportedChain(block.chainid);
    }

    function test_AddSupportedChain_RevertAlreadySupported() public {
        // OPTIMISM_CHAIN_ID is added in BridgeBaseTest setup.
        vm.prank(admin);
        vm.expectRevert(OkuBridge.ChainAlreadySupported.selector);
        okuBridge.addSupportedChain(OPTIMISM_CHAIN_ID);
    }

    function test_RemoveSupportedChain_RevertNotSupported() public {
        vm.prank(admin);
        vm.expectRevert(OkuBridge.ChainNotSupported.selector);
        okuBridge.removeSupportedChain(UNSUPPORTED_CHAIN_ID);
    }

    function test_BridgeMint_RevertUnsupportedSourceChain() public {
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: UNSUPPORTED_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: 100e18,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });
        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, UNSUPPORTED_CHAIN_ID)
        );
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertZeroAmount() public {
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: 0,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });
        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.ZeroAmount.selector);
        okuBridge.bridgeMint(request, signature);
    }

    function test_UpdateLimits_Success() public {
        uint128 newMin = 10e18;
        uint128 newMax = 5000e18;

        vm.prank(admin);
        okuBridge.updateLimits(newMin, newMax);

        assertEq(okuBridge.minBridgeAmount(), newMin);
        assertEq(okuBridge.maxBridgeAmount(), newMax);

        // Test below new minimum (mint enough for the valid bridgeBurn at newMin)
        _mintOkuMoney(user1, newMin);
        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, newMin - 1, newMin)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), newMin - 1);

        // Test at new minimum (should work — approval already covers newMin)
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), newMin);
        vm.stopPrank();
    }

    function test_UpdateLimits_RevertInvalidLimits() public {
        uint128 min = 1000e18;
        uint128 max = 100e18; // max < min

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.InvalidLimits.selector, min, max));
        okuBridge.updateLimits(min, max);
    }

    // ============ Admin Recovery Tests ============

    function test_SkipNonce_Success() public {
        uint256 nonceBefore = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        vm.prank(admin);
        okuBridge.skipNonce(OPTIMISM_CHAIN_ID);

        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 1);

        // Verify subsequent bridges use new nonce
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 2);
    }

    function test_SkipNonce_RevertNotAuthorized() public {
        bytes32 role = BRIDGE_NONCE_ADMIN;

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        vm.prank(user1);
        okuBridge.skipNonce(OPTIMISM_CHAIN_ID);
    }

    function test_RefundFailedRequest_Success() public {
        uint256 amount = 100e18;
        uint256 netAmount = amount - (amount * okuBridge.bridgeFee()) / BASIS_POINTS;

        // Create a bridge request that "failed" on destination
        // request.amount == netAmount (what would have been minted on destination)
        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        // Verify user1 balance was burned
        assertEq(okuMoney.balanceOf(user1), 0);

        // Warp past the deadline so the mint window is closed
        vm.warp(request.deadline + 1);

        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);

        // Two-step refund: initiator proposes, confirmer executes
        _twoStepRefund(request);

        // Verify netAmount returned to original sender (fee is non-refundable)
        assertEq(okuMoney.balanceOf(user1), user1BalanceBefore + netAmount);
    }

    // ============ EIP-712 Signature Tests ============

    function test_EIP712_DomainSeparator() public view {
        bytes32 domainSeparator = okuBridge.domainSeparator();

        // Verify domain separator is deterministic
        bytes32 typeHash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 nameHash = keccak256("OkuBridge");
        bytes32 versionHash = keccak256("1");

        bytes32 expected = keccak256(
            abi.encode(typeHash, nameHash, versionHash, block.chainid, address(okuBridge))
        );

        assertEq(domainSeparator, expected);
    }

    function test_EIP712_TypedDataHash() public view {
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: 100e18,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.amount,
                request.nonce,
                request.deadline
            )
        );

        bytes32 digest = okuBridge.hashTypedDataV4(structHash);

        // Verify format: keccak256("\x19\x01" || domainSeparator || structHash)
        bytes32 expected =
            keccak256(abi.encodePacked("\x19\x01", okuBridge.domainSeparator(), structHash));

        assertEq(digest, expected);
    }

    function test_EIP712_SignatureRecovery() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        okuBridge.bridgeMint(request, signature);

        assertEq(okuMoney.balanceOf(user2), amount, "Signature recovery should mint tokens");
        assertTrue(okuBridge.processedRequests(requestId), "Request should be marked processed");
    }

    // ============ Fuzz Tests ============

    function testFuzz_BridgeBurn_AmountConsistency(uint256 amount) public {
        amount = bound(amount, okuBridge.minBridgeAmount(), okuBridge.maxBridgeAmount());

        uint256 fee = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;
        uint256 netAmount = amount - fee;
        _mintOkuMoney(user1, amount);

        uint256 totalSupplyBefore = okuMoney.totalSupply();

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        // Net supply change: burned amount - minted fee = netAmount decrease
        assertEq(okuMoney.totalSupply(), totalSupplyBefore - netAmount);
    }

    function testFuzz_BridgeMint_SignatureValidation(uint256 amount, address recipient) public {
        vm.assume(recipient != address(0));
        amount = bound(amount, 1e18, 1_000_000e18);

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(recipient))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        uint256 recipientBefore = okuMoney.balanceOf(recipient);

        okuBridge.bridgeMint(request, signature);

        assertEq(okuMoney.balanceOf(recipient), recipientBefore + amount);
    }

    function testFuzz_FullRoundTrip_ValuePreservation(uint256 amount) public {
        amount = bound(amount, okuBridge.minBridgeAmount(), okuBridge.maxBridgeAmount());

        uint256 fee = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;
        uint256 netAmount = amount - fee;
        _mintOkuMoney(user1, amount);

        // Bridge burn
        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        // Create request (encodes netAmount, what destination will mint).
        // sourceChainId must be a supported chain — use OPTIMISM_CHAIN_ID to simulate
        // a cross-chain flow (burned on Optimism, minting here). block.chainid (31337)
        // is not in supportedChains so would fail the L-10 sourceChainId guard.
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: netAmount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        // Bridge mint
        okuBridge.bridgeMint(request, signature);

        // Verify exact netAmount minted on destination; fee collected on source
        // No rounding tolerance needed — OkuMoney is non-rebasing
        assertEq(okuMoney.balanceOf(user2), netAmount);
        assertEq(okuMoney.balanceOf(feeRecipient), fee);
    }

    // ============ Event Tests ============

    function test_BridgeBurn_EmitsEvent() public {
        uint256 amount = 100e18;
        uint256 feeAmount = (amount * 10) / BASIS_POINTS;
        uint256 netAmount = amount - feeAmount;
        _mintOkuMoney(user1, amount);

        uint256 nonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        // Calculate expected requestId (encodes netAmount)
        OkuBridge.BridgeRequest memory expectedRequest = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: netAmount,
            nonce: nonce,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
        bytes32 expectedRequestId = keccak256(abi.encode(expectedRequest));

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));

        vm.expectEmit(true, true, false, true);
        emit OkuBridgeEvents.BridgeBurn(
            expectedRequestId,
            user1,
            bytes32(uint256(uint160(user2))),
            block.chainid,
            OPTIMISM_CHAIN_ID,
            amount, // grossAmount
            netAmount, // netAmount
            feeAmount, // feeAmount
            nonce,
            block.timestamp + okuBridge.bridgeDeadline()
        );

        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), amount);
        vm.stopPrank();
    }

    /// @notice A user can bridge their entire balance when fee > 0.
    function test_BridgeBurn_EntireBalance() public {
        uint256 amount = 100e18;
        // Mint ONLY the bridge amount — no extra for fees
        _mintOkuMoney(user1, amount);

        uint256 feeAmount = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;
        uint256 netAmount = amount - feeAmount;

        bytes32 requestId = _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, amount);

        // User has zero balance remaining
        assertEq(okuMoney.balanceOf(user1), 0);
        // Fee recipient collected the fee
        assertEq(okuMoney.balanceOf(feeRecipient), feeAmount);
        // Request ID encodes netAmount (what destination will mint)
        OkuBridge.BridgeRequest memory expected = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: netAmount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
        assertEq(requestId, keccak256(abi.encode(expected)));
    }

    // ============ Missing Coverage Tests ============

    function test_RefundFailedRequest_RevertAlreadyRefunded() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        // Warp past the deadline so the mint window is closed
        vm.warp(request.deadline + 1);

        // First refund succeeds
        _twoStepRefund(request);

        // Second initiation reverts with AlreadyRefunded
        bytes32 requestId = keccak256(abi.encode(request));
        vm.prank(refundInitiator);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.AlreadyRefunded.selector, requestId));
        okuBridge.initiateRefund(request);
    }

    function test_BridgeBurn_RevertZeroRecipient() public {
        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), okuMoney.balanceOf(user1));
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(0), amount);
        vm.stopPrank();
    }

    function test_UpdateDeadline_Success() public {
        uint256 newDeadline = 2 hours;

        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit OkuBridgeEvents.DeadlineUpdated(1 hours, newDeadline);
        okuBridge.updateDeadline(newDeadline);

        assertEq(okuBridge.bridgeDeadline(), newDeadline);
    }

    function test_UpdateDeadline_RevertZero() public {
        vm.prank(admin);
        vm.expectRevert(OkuBridge.DeadlineMustBePositive.selector);
        okuBridge.updateDeadline(0);
    }

    function test_UpdateDeadline_RevertNotAuthorized() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                BRIDGE_LIMITS_MANAGER
            )
        );
        okuBridge.updateDeadline(2 hours);
    }

    function test_UpdateFeeRecipient_Success() public {
        address newRecipient = makeAddr("newFeeRecipient");

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit OkuBridgeEvents.FeeRecipientUpdated(feeRecipient, newRecipient);
        okuBridge.updateFeeRecipient(newRecipient);

        assertEq(okuBridge.feeRecipient(), newRecipient);
    }

    function test_UpdateFeeRecipient_RevertZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        okuBridge.updateFeeRecipient(address(0));
    }

    function test_UpdateFeeRecipient_RevertNotAuthorized() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BRIDGE_FEE_MANAGER
            )
        );
        okuBridge.updateFeeRecipient(makeAddr("x"));
    }

    function test_Initialize_RevertZeroOkuUsd() public {
        OkuBridge impl = new OkuBridge();
        uint256[] memory emptyChains = new uint256[](0);
        OkuBridge.InitConfig memory cfg = Deploy.defaultBridgeConfig();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize,
            (address(0), orchestratorSigner, feeRecipient, admin, emptyChains, cfg)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroSigner() public {
        OkuBridge impl = new OkuBridge();
        uint256[] memory emptyChains = new uint256[](0);
        OkuBridge.InitConfig memory cfg = Deploy.defaultBridgeConfig();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize,
            (address(okuMoney), address(0), feeRecipient, admin, emptyChains, cfg)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroFeeRecipient() public {
        OkuBridge impl = new OkuBridge();
        uint256[] memory emptyChains = new uint256[](0);
        OkuBridge.InitConfig memory cfg = Deploy.defaultBridgeConfig();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize,
            (address(okuMoney), orchestratorSigner, address(0), admin, emptyChains, cfg)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroAdmin() public {
        OkuBridge impl = new OkuBridge();
        uint256[] memory emptyChains = new uint256[](0);
        OkuBridge.InitConfig memory cfg = Deploy.defaultBridgeConfig();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize,
            (address(okuMoney), orchestratorSigner, feeRecipient, address(0), emptyChains, cfg)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_UUPS_UpgradeWithBridgeUpgrader() public {
        OkuBridge newImpl = new OkuBridge();

        vm.prank(admin);
        okuBridge.upgradeToAndCall(address(newImpl), "");

        // Verify upgrade succeeded (still functional)
        assertEq(okuBridge.bridgeFee(), 10);
    }

    function test_UUPS_RevertUpgradeNotAuthorized() public {
        OkuBridge newImpl = new OkuBridge();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BRIDGE_UPGRADER
            )
        );
        okuBridge.upgradeToAndCall(address(newImpl), "");
    }

    function test_BridgeMint_AtExactDeadline() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp // exactly now
        });

        bytes memory signature = _signBridgeRequest(request);

        // Should succeed — condition is block.timestamp > deadline (strict >)
        okuBridge.bridgeMint(request, signature);
        assertEq(okuMoney.balanceOf(user2), amount);
    }

    function test_Pause_RevertNotAuthorized() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BRIDGE_PAUSER
            )
        );
        okuBridge.pause();
    }

    function test_Unpause_RevertNotAuthorized() public {
        vm.prank(admin);
        okuBridge.pause();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, BRIDGE_UNPAUSER
            )
        );
        okuBridge.unpause();
    }

    function test_SkipNonce_EmitsEvent() public {
        uint256 nonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit OkuBridgeEvents.NonceSkipped(OPTIMISM_CHAIN_ID, nonce);
        okuBridge.skipNonce(OPTIMISM_CHAIN_ID);
    }

    function test_RefundFailedRequest_EmitsEvent() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        bytes32 requestId = keccak256(abi.encode(request));

        // Warp past the deadline so the mint window is closed
        vm.warp(request.deadline + 1);

        // Step 1: initiate — emits RefundInitiated
        vm.prank(refundInitiator);
        vm.expectEmit(true, true, false, true);
        emit OkuBridgeEvents.RefundInitiated(
            requestId, refundInitiator, request.sender, request.amount
        );
        okuBridge.initiateRefund(request);

        // Step 2: confirm — emits RefundConfirmed
        vm.prank(refundConfirmer);
        vm.expectEmit(true, true, false, true);
        emit OkuBridgeEvents.RefundConfirmed(requestId, user1, request.amount);
        okuBridge.confirmRefund(request);
    }

    function test_AddSupportedChain_RevertNotAuthorized() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                BRIDGE_CHAIN_MANAGER
            )
        );
        okuBridge.addSupportedChain(137);
    }

    function test_UpdateLimits_RevertNotAuthorized() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                BRIDGE_LIMITS_MANAGER
            )
        );
        okuBridge.updateLimits(uint128(1e18), uint128(100e18));
    }

    function test_BridgeMint_EmitsEvent() public {
        uint256 amount = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        vm.expectEmit(true, true, false, true);
        emit OkuBridgeEvents.BridgeMint(
            requestId, bytes32(uint256(uint160(user2))), OPTIMISM_CHAIN_ID, block.chainid, amount
        );

        okuBridge.bridgeMint(request, signature);
    }

    // ============ M-2: Zero Recipient Validation ============

    function test_BridgeMint_RevertNonEvmRecipientToEvmDestination() public {
        uint256 amount = 100e18;

        // Craft a request whose bytes32 recipient has non-zero high bytes
        // (e.g., a Solana pubkey routed to an EVM destination by orchestrator bug).
        // The new top-bits guard rejects this before any silent address truncation.
        bytes32 solanaPubkey = bytes32(uint256(0xDEADBEEF) << 160);

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: solanaPubkey,
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.InvalidRecipient.selector);
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertPureZeroRecipient() public {
        uint256 amount = 100e18;

        // Recipient is bytes32(0) — lower 20 bytes are also zero
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(0),
            amount: amount,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        okuBridge.bridgeMint(request, signature);
    }

    // ============ Dust Sweep Tests ============

    function test_SweepDust_RecoverAccumulatedDust() public {
        // With non-rebasing OkuMoney there should be no rounding dust from
        // share conversion, but the sweepDust mechanism still exists for
        // any tokens that end up in the bridge contract.
        // Force some dust by minting directly to bridge.
        _mintOkuMoney(address(okuBridge), 1);

        uint256 dustBalance = okuMoney.balanceOf(address(okuBridge));
        assertGt(dustBalance, 0);

        // Sweep dust to feeRecipient
        uint256 feeRecipientBefore = okuMoney.balanceOf(feeRecipient);

        vm.prank(admin);
        okuBridge.sweepDust();

        // Bridge balance is now zero
        assertEq(okuMoney.balanceOf(address(okuBridge)), 0);
        // Fee recipient received the dust
        assertEq(okuMoney.balanceOf(feeRecipient), feeRecipientBefore + dustBalance);
    }

    function test_SweepDust_EmitsEvent() public {
        // Force some dust by minting directly to bridge
        _mintOkuMoney(address(okuBridge), 1);
        uint256 dustBalance = okuMoney.balanceOf(address(okuBridge));
        assertGt(dustBalance, 0);

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit OkuBridgeEvents.DustSwept(feeRecipient, dustBalance);
        okuBridge.sweepDust();
    }

    function test_SweepDust_NoOpWhenZeroBalance() public {
        // Bridge has zero balance — sweepDust should be a no-op (no revert)
        assertEq(okuMoney.balanceOf(address(okuBridge)), 0);

        vm.prank(admin);
        okuBridge.sweepDust(); // should not revert
    }

    function test_SweepDust_RevertNotAuthorized() public {
        bytes32 role = BRIDGE_DUST_SWEEPER;

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        okuBridge.sweepDust();
    }

    // ============ Refund Deadline Enforcement Tests ============

    function test_RefundFailedRequest_RevertMintWindowStillOpen() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        // Deadline is in the future — initiation should revert
        assertLe(block.timestamp, request.deadline);

        vm.prank(refundInitiator);
        vm.expectRevert(OkuBridge.MintWindowStillOpen.selector);
        okuBridge.initiateRefund(request);
    }

    function test_RefundFailedRequest_RevertAtExactDeadline() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        // Warp to exactly the deadline — should still revert (condition is block.timestamp <= deadline)
        vm.warp(request.deadline);

        vm.prank(refundInitiator);
        vm.expectRevert(OkuBridge.MintWindowStillOpen.selector);
        okuBridge.initiateRefund(request);
    }

    function test_RefundFailedRequest_SucceedsAfterDeadline() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        // Warp past the deadline
        vm.warp(request.deadline + 1);

        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);

        _twoStepRefund(request);

        // Verify refund succeeded — exact amount, no rounding
        assertEq(okuMoney.balanceOf(user1), user1BalanceBefore + request.amount);
    }

    function test_Refund_RevertInitiatorCannotConfirm() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        // Grant refundInitiator also the confirmer role (still same address — should revert)
        vm.prank(admin);
        okuBridge.grantRole(BRIDGE_REFUND_CONFIRMER, refundInitiator);

        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);

        vm.prank(refundInitiator);
        vm.expectRevert(OkuBridge.InitiatorCannotConfirm.selector);
        okuBridge.confirmRefund(request);
    }

    function test_Refund_RevertConfirmWithoutInitiate() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        bytes32 requestId = keccak256(abi.encode(request));
        vm.prank(refundConfirmer);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.RefundNotInitiated.selector, requestId));
        okuBridge.confirmRefund(request);
    }

    // ============ Cancel Refund Tests ============

    function test_CancelRefund_ByInitiator() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        // Initiate refund
        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);

        bytes32 requestId = keccak256(abi.encode(request));

        // Verify pending
        assertEq(okuBridge.pendingRefundInitiator(requestId), refundInitiator);

        // Cancel by initiator
        vm.prank(refundInitiator);
        vm.expectEmit(true, true, true, false);
        emit OkuBridgeEvents.RefundCancelled(requestId, refundInitiator, refundInitiator);
        okuBridge.cancelRefund(request);

        // Verify cancelled
        assertEq(okuBridge.pendingRefundInitiator(requestId), address(0));
    }

    function test_CancelRefund_ByAdmin() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        // Initiate refund
        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);

        bytes32 requestId = keccak256(abi.encode(request));

        // Cancel by admin
        vm.prank(admin);
        vm.expectEmit(true, true, true, false);
        emit OkuBridgeEvents.RefundCancelled(requestId, refundInitiator, admin);
        okuBridge.cancelRefund(request);

        // Verify cancelled
        assertEq(okuBridge.pendingRefundInitiator(requestId), address(0));
    }

    function test_CancelRefund_RevertNotInitiated() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        bytes32 requestId = keccak256(abi.encode(request));

        // Try to cancel without initiating
        vm.prank(refundInitiator);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.RefundNotInitiated.selector, requestId));
        okuBridge.cancelRefund(request);
    }

    function test_CancelRefund_RevertNotInitiatorOrAdmin() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        // Initiate refund
        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);

        // Try to cancel as unauthorized user
        vm.prank(user1);
        vm.expectRevert(OkuBridge.NotInitiatorOrAdmin.selector);
        okuBridge.cancelRefund(request);
    }

    function test_CancelRefund_CanReinitiateAfterCancel() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        // Initiate and cancel
        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);
        vm.prank(refundInitiator);
        okuBridge.cancelRefund(request);

        bytes32 requestId = keccak256(abi.encode(request));
        assertEq(okuBridge.pendingRefundInitiator(requestId), address(0));

        // Can re-initiate
        vm.prank(refundInitiator);
        okuBridge.initiateRefund(request);

        assertEq(okuBridge.pendingRefundInitiator(requestId), refundInitiator);
    }

    function test_CancelRefund_CannotCancelAfterConfirm() public {
        uint256 amount = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintAndBridge(user1, amount, OPTIMISM_CHAIN_ID, user2);

        vm.warp(request.deadline + 1);

        // Complete two-step refund
        _twoStepRefund(request);

        bytes32 requestId = keccak256(abi.encode(request));

        // Try to cancel after confirm — should revert (no longer pending)
        vm.prank(refundInitiator);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.RefundNotInitiated.selector, requestId));
        okuBridge.cancelRefund(request);
    }

    // ============ Solana Destination Tests ============

    function test_SolanaBridge_AddChainSupport() public {
        // Initially Solana should not be supported
        assertFalse(okuBridge.supportedChains(SOLANA_MAINNET_CHAIN_ID));

        // Add Solana chain support
        _enableSolanaChain(true);

        assertTrue(okuBridge.supportedChains(SOLANA_MAINNET_CHAIN_ID));
    }

    function test_SolanaBridge_BurnToSolanaRecipient() public {
        // Enable Solana
        _enableSolanaChain(true);

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        // Create a Solana recipient (32-byte pubkey)
        bytes32 solanaRecipient = _createSolanaRecipient(42);
        // Verify it's a full 32-byte value (not just 20 bytes)
        assertTrue(
            uint256(solanaRecipient) > type(uint160).max,
            "Solana recipient should use full 32 bytes"
        );

        uint256 supplyBefore = okuMoney.totalSupply();
        uint256 nonceBefore = okuBridge.outboundNonce(SOLANA_MAINNET_CHAIN_ID);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount);
        bytes32 requestId = okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);
        vm.stopPrank();

        // Verify bridge worked
        assertTrue(requestId != bytes32(0), "Request ID should be non-zero");
        assertEq(
            okuBridge.outboundNonce(SOLANA_MAINNET_CHAIN_ID),
            nonceBefore + 1,
            "Nonce should increment"
        );

        // Verify tokens burned (minus fee)
        uint256 fee = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;
        assertEq(
            okuMoney.totalSupply(),
            supplyBefore - amount + fee,
            "Supply should decrease by net amount"
        );
    }

    function test_SolanaBridge_SequentialNoncesForSolana() public {
        _enableSolanaChain(true);

        uint256 amount = okuBridge.minBridgeAmount();
        _mintOkuMoney(user1, amount * 3);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount * 3);

        bytes32 solanaRecipient = _createSolanaRecipient(1);

        // Bridge 3 times
        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);
        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);
        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);

        vm.stopPrank();

        // Verify nonces incremented correctly
        assertEq(
            okuBridge.outboundNonce(SOLANA_MAINNET_CHAIN_ID),
            3,
            "Should have 3 outbound nonces for Solana"
        );
    }

    function test_SolanaBridge_DevnetChain() public {
        // Enable Solana devnet
        _enableSolanaChain(false); // false = devnet

        assertTrue(okuBridge.supportedChains(SOLANA_DEVNET_CHAIN_ID));
        assertFalse(okuBridge.supportedChains(SOLANA_MAINNET_CHAIN_ID));

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        bytes32 solanaRecipient = _createSolanaRecipient(123);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount);
        bytes32 requestId = okuBridge.bridgeBurn(SOLANA_DEVNET_CHAIN_ID, solanaRecipient, amount);
        vm.stopPrank();

        assertTrue(requestId != bytes32(0));
    }

    function test_SolanaBridge_RevertUnsupportedSolanaChain() public {
        // Don't enable Solana
        assertFalse(okuBridge.supportedChains(SOLANA_MAINNET_CHAIN_ID));

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        bytes32 solanaRecipient = _createSolanaRecipient(1);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount);

        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, SOLANA_MAINNET_CHAIN_ID)
        );
        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);

        vm.stopPrank();
    }

    function test_SolanaBridge_SeparateNoncePerChain() public {
        _enableSolanaChain(true);

        uint256 amount = okuBridge.minBridgeAmount();
        _mintOkuMoney(user1, amount * 4);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount * 4);

        bytes32 evmRecipient = bytes32(uint256(uint160(user2)));
        bytes32 solanaRecipient = _createSolanaRecipient(1);

        // Bridge to Optimism
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, evmRecipient, amount);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, evmRecipient, amount);

        // Bridge to Solana
        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);

        vm.stopPrank();

        // Verify separate nonces
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), 2, "Optimism should have 2 nonces");
        assertEq(okuBridge.outboundNonce(SOLANA_MAINNET_CHAIN_ID), 1, "Solana should have 1 nonce");
    }

    function testFuzz_SolanaBridge_VariableAmounts(uint256 amount) public {
        _enableSolanaChain(true);

        // Bound to valid bridge amounts
        uint128 minAmount = okuBridge.minBridgeAmount();
        uint128 maxAmount = okuBridge.maxBridgeAmount();
        amount = bound(amount, minAmount, maxAmount);

        _mintOkuMoney(user1, amount);

        bytes32 solanaRecipient = _createSolanaRecipient(amount);

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount);
        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);
        vm.stopPrank();

        // User balance should decrease by full amount
        assertEq(okuMoney.balanceOf(user1), balanceBefore - amount);
    }

    function test_SolanaBridge_EmitsBridgeBurnEvent() public {
        _enableSolanaChain(true);

        uint256 amount = 100e18;
        _mintOkuMoney(user1, amount);

        bytes32 solanaRecipient = _createSolanaRecipient(1);
        uint256 fee = (amount * okuBridge.bridgeFee()) / BASIS_POINTS;
        uint256 netAmount = amount - fee;
        uint256 nonce = okuBridge.outboundNonce(SOLANA_MAINNET_CHAIN_ID);
        uint256 deadline = block.timestamp + okuBridge.bridgeDeadline();

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount);

        // Expect the BridgeBurn event with Solana chain ID and 32-byte recipient
        vm.expectEmit(false, true, false, false); // Only check indexed sender
        emit OkuBridgeEvents.BridgeBurn(
            bytes32(0), // requestId calculated, don't check
            user1,
            solanaRecipient,
            block.chainid,
            SOLANA_MAINNET_CHAIN_ID,
            amount,
            netAmount,
            fee,
            nonce,
            deadline
        );

        okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);
        vm.stopPrank();
    }

    function test_SolanaBridge_RequestIdIncludesSolanaChain() public {
        _enableSolanaChain(true);

        uint256 amount = okuBridge.minBridgeAmount();
        _mintOkuMoney(user1, amount * 2);

        vm.startPrank(user1);
        okuMoney.approve(address(okuBridge), amount * 2);

        bytes32 solanaRecipient = _createSolanaRecipient(1);
        bytes32 evmRecipient = bytes32(uint256(uint160(user2)));

        // Bridge to Solana
        bytes32 solanaRequestId =
            okuBridge.bridgeBurn(SOLANA_MAINNET_CHAIN_ID, solanaRecipient, amount);

        // Bridge same amount to Optimism with equivalent recipient bytes
        bytes32 optimismRequestId = okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, evmRecipient, amount);

        vm.stopPrank();

        // Request IDs should be different due to different dest chains
        assertTrue(
            solanaRequestId != optimismRequestId, "Request IDs should differ for different chains"
        );
    }
}
