// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title OkuBridgeTest
 * @notice Comprehensive test suite for OkuBridge contract
 */
contract OkuBridgeTest is BaseTest {
    OkuBridge public okuBridge;
    OkuBridge public okuBridgeImpl;

    address public orchestratorSigner;
    uint256 public orchestratorPk;
    address public feeRecipient;

    // Bridge roles
    bytes32 public constant BRIDGE_SIGNER_MANAGER = keccak256("BRIDGE_SIGNER_MANAGER");
    bytes32 public constant BRIDGE_PAUSER = keccak256("BRIDGE_PAUSER");
    bytes32 public constant BRIDGE_UNPAUSER = keccak256("BRIDGE_UNPAUSER");
    bytes32 public constant BRIDGE_FEE_MANAGER = keccak256("BRIDGE_FEE_MANAGER");
    bytes32 public constant BRIDGE_NONCE_ADMIN = keccak256("BRIDGE_NONCE_ADMIN");
    bytes32 public constant BRIDGE_CHAIN_MANAGER = keccak256("BRIDGE_CHAIN_MANAGER");
    bytes32 public constant BRIDGE_LIMITS_MANAGER = keccak256("BRIDGE_LIMITS_MANAGER");
    bytes32 public constant BRIDGE_REFUND_ADMIN = keccak256("BRIDGE_REFUND_ADMIN");

    // Chain IDs for testing
    uint256 constant OPTIMISM_CHAIN_ID = 10;
    uint256 constant ARBITRUM_CHAIN_ID = 42161;
    uint256 constant BASE_CHAIN_ID = 8453;
    uint256 constant UNSUPPORTED_CHAIN_ID = 999;

    // EIP-712 typehash
    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,address recipient,uint256 shares,uint256 nonce,uint256 deadline)"
    );

    function setUp() public override {
        super.setUp();

        // Create orchestrator signer
        orchestratorPk = 0xA11CE;
        orchestratorSigner = vm.addr(orchestratorPk);
        feeRecipient = makeAddr("feeRecipient");

        // Deploy OkuBridge
        _deployBridge();

        // Grant bridge contract minter role for OkuUSD
        vm.startPrank(admin);
        okuUsd.grantRole(MINTER, address(okuBridge));
        vm.startPrank(allowanceManager);
        okuUsd.configureMinterAllowance(address(okuBridge), MAX_SUPPLY);
        vm.stopPrank();
    }

    function _deployBridge() internal {
        okuBridgeImpl = new OkuBridge();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize,
            (address(okuUsd), orchestratorSigner, feeRecipient, admin)
        );
        okuBridge = OkuBridge(address(new ERC1967Proxy(address(okuBridgeImpl), initData)));
    }

    // ============ Helper Functions ============

    function _signBridgeRequest(OkuBridge.BridgeRequest memory request)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.shares,
                request.nonce,
                request.deadline
            )
        );

        bytes32 digest = okuBridge.hashTypedDataV4(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(orchestratorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mintSharesAndBridge(
        address user,
        uint256 shares,
        uint256 destChainId,
        address recipient
    ) internal returns (bytes32 requestId, OkuBridge.BridgeRequest memory request) {
        uint256 fee = (shares * okuBridge.bridgeFee()) / 10000;
        _mintOkuUsd(user, (shares + fee)); // Mint tokens (will convert to shares)

        vm.startPrank(user);
        requestId = okuBridge.bridgeBurn(destChainId, recipient, shares);
        vm.stopPrank();

        // Construct expected request
        uint256 nonce = okuBridge.outboundNonce(destChainId) - 1;
        request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: user,
            recipient: recipient,
            shares: shares,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    // ============ Unit Tests - bridgeBurn() ============

    function test_BridgeBurn_Success() public {
        uint256 shares = 100e18;
        uint256 fee = (shares * 10) / 10000; // 0.1% fee

        _mintOkuUsd(user1, shares + fee);

        uint256 user1SharesBefore = okuUsd.sharesOf(user1);
        uint256 feeRecipientSharesBefore = okuUsd.sharesOf(feeRecipient);
        uint256 nonceBefore = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        vm.prank(user1);
        bytes32 requestId = okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        // Verify shares burned from user
        assertEq(okuUsd.sharesOf(user1), user1SharesBefore - shares - fee);

        // Verify fee collected
        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientSharesBefore + fee);

        // Verify nonce incremented
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 1);

        // Verify requestId is correct
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: nonceBefore,
            deadline: block.timestamp + 1 hours
        });
        bytes32 expectedRequestId = keccak256(abi.encode(request));
        assertEq(requestId, expectedRequestId);
    }

    function test_BridgeBurn_RevertUnsupportedChain() public {
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, UNSUPPORTED_CHAIN_ID)
        );
        okuBridge.bridgeBurn(UNSUPPORTED_CHAIN_ID, user2, shares);
    }

    function test_BridgeBurn_RevertBelowMinimum() public {
        uint256 minShares = okuBridge.minBridgeShares();
        uint256 shares = minShares - 1;

        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, shares, minShares)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);
    }

    function test_BridgeBurn_RevertAboveMaximum() public {
        uint256 maxShares = okuBridge.maxBridgeShares();
        uint256 shares = maxShares + 1;

        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountAboveMaximum.selector, shares, maxShares)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);
    }

    function test_BridgeBurn_RevertWhenPaused() public {
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(admin);
        okuBridge.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);
    }

    function test_BridgeBurn_FeeCalculation() public {
        uint256 shares = 1000e18;

        // Test with 0.1% fee (default)
        uint256 fee = (shares * 10) / 10000;
        _mintOkuUsd(user1, shares + fee);

        uint256 feeRecipientBefore = okuUsd.sharesOf(feeRecipient);

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientBefore + fee);

        // Update fee to 1%
        vm.prank(admin);
        okuBridge.updateFee(100);

        uint256 newFee = (shares * 100) / 10000;
        _mintOkuUsd(user1, shares + newFee);

        feeRecipientBefore = okuUsd.sharesOf(feeRecipient);

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientBefore + newFee);
    }

    function test_BridgeBurn_NonceIncrement() public {
        uint256 shares = 100e18;

        for (uint256 i = 0; i < 5; i++) {
            _mintOkuUsd(user1, shares + (shares * 10) / 10000);

            uint256 expectedNonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

            vm.prank(user1);
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

            assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), expectedNonce + 1);
        }
    }

    function test_BridgeBurn_MultipleDestinations_IndependentNonces() public {
        uint256 shares = 100e18;

        // Bridge to Optimism 3 times
        for (uint256 i = 0; i < 3; i++) {
            _mintOkuUsd(user1, shares + (shares * 10) / 10000);
            vm.prank(user1);
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);
        }

        // Bridge to Arbitrum 3 times
        for (uint256 i = 0; i < 3; i++) {
            _mintOkuUsd(user1, shares + (shares * 10) / 10000);
            vm.prank(user1);
            okuBridge.bridgeBurn(ARBITRUM_CHAIN_ID, user2, shares);
        }

        // Verify independent nonces
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), 3);
        assertEq(okuBridge.outboundNonce(ARBITRUM_CHAIN_ID), 3);
        assertEq(okuBridge.outboundNonce(BASE_CHAIN_ID), 0); // Unused chain
    }

    // ============ Unit Tests - bridgeMint() ============

    function test_BridgeMint_ValidSignature() public {
        uint256 shares = 100e18;

        // Create request
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        uint256 user2SharesBefore = okuUsd.sharesOf(user2);

        okuBridge.bridgeMint(request, signature);

        // Verify shares minted to recipient
        assertEq(okuUsd.sharesOf(user2), user2SharesBefore + shares);

        // Verify requestId marked as processed
        assertTrue(okuBridge.processedRequests(requestId));
    }

    function test_BridgeMint_RevertInvalidSignature() public {
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        // Sign with wrong private key
        uint256 wrongPk = 0xBADBAD;
        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.shares,
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
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp - 1 // Past deadline
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.SignatureExpired.selector);
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertWrongChain() public {
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: ARBITRUM_CHAIN_ID, // Wrong chain
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(
            abi.encodeWithSelector(
                OkuBridge.WrongChain.selector, ARBITRUM_CHAIN_ID, block.chainid
            )
        );
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertReplay() public {
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
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
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.prank(admin);
        okuBridge.pause();

        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuBridge.bridgeMint(request, signature);
    }

    // ============ Integration Tests - Full Round-Trip ============

    function test_FullRoundTrip_SingleUser() public {
        uint256 shares = 100e18;

        // Step 1: User1 bridges from source
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        // Verify burn happened
        assertEq(okuUsd.sharesOf(user1), 0);

        // Step 2: Create request for destination (same chainid for testing)
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid, // Use current chainid
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        // Step 3: Mint on destination
        uint256 user2Before = okuUsd.sharesOf(user2);
        okuBridge.bridgeMint(request, signature);

        // Verify shares minted to recipient
        assertEq(okuUsd.sharesOf(user2), user2Before + shares);

        // Verify fee was collected
        uint256 expectedFee = (shares * 10) / 10000;
        assertEq(okuUsd.sharesOf(feeRecipient), expectedFee);
    }

    function test_FullRoundTrip_WithRebase() public {
        uint256 shares = 100e18;

        // Step 1: Mint and bridge
        uint256 fee = (shares * 10) / 10000;
        _mintOkuUsd(user1, shares + fee);

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        // Step 2: Apply rebase (increase multiplier by 50%)
        uint256 oldMultiplier = okuUsd.rewardMultiplier();
        uint256 newMultiplier = (oldMultiplier * 150) / 100;

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Step 3: Create request and sign
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        // Step 4: Mint on destination
        okuBridge.bridgeMint(request, signature);

        // Verify user2 received exact share count (not affected by rebase)
        assertEq(okuUsd.sharesOf(user2), shares);

        // But token balance reflects new multiplier
        uint256 expectedTokens = (shares * newMultiplier) / PRECISION;
        assertEq(okuUsd.balanceOf(user2), expectedTokens);
    }

    function test_BridgeBurn_MultipleUsers_IncrementNonce() public {
        uint256 shares = 50e18;

        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            address user = address(uint160(i + 1000));
            _mintOkuUsd(user, shares + (shares * 10) / 10000);

            vm.prank(user);
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user, shares);
        }

        // Verify nonce incremented correctly
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), 5);
    }

    function test_FullRoundTrip_ZeroFee() public {
        uint256 shares = 100e18;

        // Set fee to 0
        vm.prank(admin);
        okuBridge.updateFee(0);

        _mintOkuUsd(user1, shares);

        uint256 feeRecipientBefore = okuUsd.sharesOf(feeRecipient);

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        // Verify no fee collected
        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientBefore);
    }

    // ============ Admin Function Tests ============

    function test_UpdateAuthorizedSigner_Success() public {
        address newSigner = makeAddr("newSigner");

        vm.prank(admin);
        okuBridge.updateAuthorizedSigner(newSigner);

        assertEq(okuBridge.authorizedSigner(), newSigner);

        // Verify old signatures no longer work
        uint256 shares = 100e18;
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory oldSignature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.InvalidSignature.selector);
        okuBridge.bridgeMint(request, oldSignature);
    }

    function test_UpdateAuthorizedSigner_RevertNotAuthorized() public {
        address newSigner = makeAddr("newSigner");
        bytes32 role = okuBridge.BRIDGE_SIGNER_MANAGER();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                role
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
        uint256 invalidFee = 10001; // > 100%

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
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        okuBridge.bridgeBurn(newChainId, user2, shares);
    }

    function test_RemoveSupportedChain_Success() public {
        vm.prank(admin);
        okuBridge.removeSupportedChain(OPTIMISM_CHAIN_ID);

        assertFalse(okuBridge.supportedChains(OPTIMISM_CHAIN_ID));

        // Verify cannot bridge to it
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, OPTIMISM_CHAIN_ID)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);
    }

    function test_UpdateLimits_Success() public {
        uint256 newMin = 10e18;
        uint256 newMax = 5000e18;

        vm.prank(admin);
        okuBridge.updateLimits(newMin, newMax);

        assertEq(okuBridge.minBridgeShares(), newMin);
        assertEq(okuBridge.maxBridgeShares(), newMax);

        // Test below new minimum
        uint256 fee = (newMin * 10) / 10000;
        _mintOkuUsd(user1, newMin + fee);
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, newMin - 1, newMin)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, newMin - 1);

        // Test at new minimum (should work)
        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, newMin);
    }

    function test_UpdateLimits_RevertInvalidLimits() public {
        uint256 min = 1000e18;
        uint256 max = 100e18; // max < min

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
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 2);
    }

    function test_SkipNonce_RevertNotAuthorized() public {
        bytes32 role = okuBridge.BRIDGE_NONCE_ADMIN();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                role
            )
        );
        vm.prank(user1);
        okuBridge.skipNonce(OPTIMISM_CHAIN_ID);
    }

    function test_RefundFailedRequest_Success() public {
        uint256 shares = 100e18;

        // Create a bridge request that "failed" on destination
        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        // Verify user1 shares were burned
        assertEq(okuUsd.sharesOf(user1), 0);

        // Admin refunds the request
        // proof param is unused in current implementation (OkuBridge.sol).
        // When proof verification is added, this test must be updated with valid proof data.
        bytes memory proof = "";

        uint256 user1SharesBefore = okuUsd.sharesOf(user1);
        uint256 user1TokensBefore = okuUsd.balanceOf(user1);

        vm.prank(admin);
        okuBridge.refundFailedRequest(request, proof);

        // Verify shares returned to original sender
        assertEq(okuUsd.sharesOf(user1), user1SharesBefore + shares);

        // Verify token balance reflects refunded shares at current multiplier
        uint256 expectedTokens = okuUsd.sharesToTokens(shares);
        assertEq(okuUsd.balanceOf(user1), user1TokensBefore + expectedTokens);
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
            recipient: user2,
            shares: 100e18,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                request.sourceChainId,
                request.destChainId,
                request.sender,
                request.recipient,
                request.shares,
                request.nonce,
                request.deadline
            )
        );

        bytes32 digest = okuBridge.hashTypedDataV4(structHash);

        // Verify format: keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)
        bytes32 expected =
            keccak256(abi.encodePacked("\x19\x01", okuBridge.domainSeparator(), structHash));

        assertEq(digest, expected);
    }

    function test_EIP712_SignatureRecovery() public {
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        okuBridge.bridgeMint(request, signature);

        assertEq(okuUsd.sharesOf(user2), shares, "Signature recovery should mint shares");
        assertTrue(okuBridge.processedRequests(requestId), "Request should be marked processed");
    }

    // ============ Fuzz Tests ============

    function testFuzz_BridgeBurn_AmountConsistency(uint256 shares) public {
        shares = bound(shares, okuBridge.minBridgeShares(), okuBridge.maxBridgeShares());

        uint256 fee = (shares * 10) / 10000;
        _mintOkuUsd(user1, shares + fee);

        uint256 totalSharesBefore = okuUsd.totalShares();

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        // Verify exact shares burned (net of fee which was minted back to recipient)
        assertEq(okuUsd.totalShares(), totalSharesBefore - shares);
    }

    function testFuzz_BridgeMint_SignatureValidation(uint256 shares, address recipient) public {
        vm.assume(recipient != address(0));
        shares = bound(shares, 1e18, 1000000e18);

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: recipient,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        uint256 recipientBefore = okuUsd.sharesOf(recipient);

        okuBridge.bridgeMint(request, signature);

        assertEq(okuUsd.sharesOf(recipient), recipientBefore + shares);
    }

    function testFuzz_FullRoundTrip_ValuePreservation(uint256 shares) public {
        shares = bound(shares, okuBridge.minBridgeShares(), okuBridge.maxBridgeShares());

        uint256 fee = (shares * 10) / 10000;
        _mintOkuUsd(user1, shares + fee);

        // Bridge burn
        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);

        // Create request
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        // Bridge mint
        okuBridge.bridgeMint(request, signature);

        // Verify shares preserved (accounting for fee)
        assertEq(okuUsd.sharesOf(user2), shares);
        assertEq(okuUsd.sharesOf(feeRecipient), fee);
    }

    // ============ Event Tests ============

    function test_BridgeBurn_EmitsEvent() public {
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares + (shares * 10) / 10000);

        uint256 nonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        // Calculate expected requestId
        OkuBridge.BridgeRequest memory expectedRequest = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
        bytes32 expectedRequestId = keccak256(abi.encode(expectedRequest));

        vm.expectEmit(true, true, true, true);
        emit OkuBridge.BridgeBurn(
            expectedRequestId,
            user1,
            user2,
            block.chainid,
            OPTIMISM_CHAIN_ID,
            shares,
            nonce,
            block.timestamp + 1 hours
        );

        vm.prank(user1);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, user2, shares);
    }

    function test_BridgeMint_EmitsEvent() public {
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: user2,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        vm.expectEmit(true, true, true, true);
        emit OkuBridge.BridgeMint(requestId, user2, OPTIMISM_CHAIN_ID, shares);

        okuBridge.bridgeMint(request, signature);
    }
}
