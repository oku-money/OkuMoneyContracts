// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

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
    uint256 constant ARBITRUM_CHAIN_ID = 42_161;
    uint256 constant BASE_CHAIN_ID = 8453;
    uint256 constant UNSUPPORTED_CHAIN_ID = 999;

    // EIP-712 typehash
    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,bytes32 recipient,uint256 shares,uint256 nonce,uint256 deadline)"
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
            OkuBridge.initialize, (address(okuUsd), orchestratorSigner, feeRecipient, admin)
        );
        okuBridge = OkuBridge(address(new ERC1967Proxy(address(okuBridgeImpl), initData)));
    }

    // ============ Helper Functions ============

    /// @notice Approve bridge and call bridgeBurn (user must hold tokens)
    function _approveBridgeBurn(
        address user,
        uint256 destChainId,
        address recipient,
        uint256 shares
    )
        internal
        returns (bytes32 requestId)
    {
        uint256 tokenAmount = okuUsd.sharesToTokens(shares);
        vm.startPrank(user);
        okuUsd.approve(address(okuBridge), tokenAmount);
        requestId = okuBridge.bridgeBurn(destChainId, bytes32(uint256(uint160(recipient))), shares);
        vm.stopPrank();
    }

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
    )
        internal
        returns (bytes32 requestId, OkuBridge.BridgeRequest memory request)
    {
        _mintOkuUsd(user, shares); // Mint only the bridge amount (fee is deducted from it)

        // User must approve bridge to pull OkuUSD (transfer-then-burn model)
        uint256 tokenAmount = okuUsd.sharesToTokens(shares);
        vm.startPrank(user);
        okuUsd.approve(address(okuBridge), tokenAmount);
        requestId = okuBridge.bridgeBurn(destChainId, bytes32(uint256(uint160(recipient))), shares);
        vm.stopPrank();

        // Construct expected request (shares = netShares, what destination will mint)
        uint256 nonce = okuBridge.outboundNonce(destChainId) - 1;
        uint256 netShares = shares - (shares * okuBridge.bridgeFee()) / 10_000;
        request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: destChainId,
            sender: user,
            recipient: bytes32(uint256(uint160(recipient))),
            shares: netShares,
            nonce: nonce,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
    }

    // ============ Unit Tests - bridgeBurn() ============

    function test_BridgeBurn_Success() public {
        uint256 shares = 100e18;
        uint256 fee = (shares * 10) / 10_000; // 0.1% fee
        uint256 netShares = shares - fee;

        _mintOkuUsd(user1, shares);

        uint256 user1SharesBefore = okuUsd.sharesOf(user1);
        uint256 feeRecipientSharesBefore = okuUsd.sharesOf(feeRecipient);
        uint256 nonceBefore = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        bytes32 requestId =
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();

        // Verify exact shares burned from user
        assertEq(okuUsd.sharesOf(user1), user1SharesBefore - shares);

        // Verify fee collected
        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientSharesBefore + fee);

        // Verify nonce incremented
        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 1);

        // Verify requestId encodes netShares (what destination will mint)
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: netShares,
            nonce: nonceBefore,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
        bytes32 expectedRequestId = keccak256(abi.encode(request));
        assertEq(requestId, expectedRequestId);
    }

    function test_BridgeBurn_RevertUnsupportedChain() public {
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares);

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, UNSUPPORTED_CHAIN_ID)
        );
        okuBridge.bridgeBurn(UNSUPPORTED_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();
    }

    function test_BridgeBurn_RevertBelowMinimum() public {
        uint256 minShares = okuBridge.minBridgeShares();
        uint256 shares = minShares - 1;

        _mintOkuUsd(user1, shares);

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, shares, minShares)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();
    }

    function test_BridgeBurn_RevertAboveMaximum() public {
        uint256 maxShares = okuBridge.maxBridgeShares();
        uint256 shares = maxShares + 1;

        _mintOkuUsd(user1, shares);

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountAboveMaximum.selector, shares, maxShares)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();
    }

    function test_BridgeBurn_RevertWhenPaused() public {
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares);

        vm.prank(admin);
        okuBridge.pause();

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();
    }

    function test_BridgeBurn_FeeCalculation() public {
        uint256 shares = 1000e18;

        // Test with 0.1% fee (default)
        uint256 fee = (shares * 10) / 10_000;
        _mintOkuUsd(user1, shares);

        uint256 feeRecipientBefore = okuUsd.sharesOf(feeRecipient);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientBefore + fee);

        // Update fee to 1%
        vm.prank(admin);
        okuBridge.updateFee(100);

        uint256 newFee = (shares * 100) / 10_000;
        _mintOkuUsd(user1, shares);

        feeRecipientBefore = okuUsd.sharesOf(feeRecipient);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        assertEq(okuUsd.sharesOf(feeRecipient), feeRecipientBefore + newFee);
    }

    function test_BridgeBurn_NonceIncrement() public {
        uint256 shares = 100e18;

        for (uint256 i = 0; i < 5; i++) {
            _mintOkuUsd(user1, shares);

            uint256 expectedNonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

            _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

            assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), expectedNonce + 1);
        }
    }

    function test_BridgeBurn_MultipleDestinations_IndependentNonces() public {
        uint256 shares = 100e18;

        // Bridge to Optimism 3 times
        for (uint256 i = 0; i < 3; i++) {
            _mintOkuUsd(user1, shares);
            _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);
        }

        // Bridge to Arbitrum 3 times
        for (uint256 i = 0; i < 3; i++) {
            _mintOkuUsd(user1, shares);
            _approveBridgeBurn(user1, ARBITRUM_CHAIN_ID, user2, shares);
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
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
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
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
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
            recipient: bytes32(uint256(uint160(user2))),
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
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
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
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
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
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
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
        uint256 shares = 100e18;
        uint256 fee = (shares * 10) / 10_000;
        uint256 netShares = shares - fee;

        // Step 1: User1 bridges from source
        _mintOkuUsd(user1, shares);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        // Verify burn happened
        assertEq(okuUsd.sharesOf(user1), 0);

        // Step 2: Create request for destination (same chainid for testing)
        // Request encodes netShares — what destination will mint
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid, // Use current chainid
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: netShares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        // Step 3: Mint on destination
        uint256 user2Before = okuUsd.sharesOf(user2);
        okuBridge.bridgeMint(request, signature);

        // Verify netShares minted to recipient
        assertEq(okuUsd.sharesOf(user2), user2Before + netShares);

        // Verify fee was collected
        assertEq(okuUsd.sharesOf(feeRecipient), fee);
    }

    function test_FullRoundTrip_WithRebase() public {
        uint256 shares = 100e18;
        uint256 fee = (shares * 10) / 10_000;
        uint256 netShares = shares - fee;

        // Step 1: Mint and bridge
        _mintOkuUsd(user1, shares);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        // Step 2: Apply rebase (increase multiplier by 50%)
        uint256 oldMultiplier = okuUsd.rewardMultiplier();
        uint256 newMultiplier = (oldMultiplier * 150) / 100;

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Step 3: Create request and sign (encodes netShares)
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: netShares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        // Step 4: Mint on destination
        okuBridge.bridgeMint(request, signature);

        // Verify user2 received exact netShares (not affected by rebase)
        assertEq(okuUsd.sharesOf(user2), netShares);

        // But token balance reflects new multiplier
        uint256 expectedTokens = (netShares * newMultiplier) / PRECISION;
        assertEq(okuUsd.balanceOf(user2), expectedTokens);
    }

    function test_BridgeBurn_MultipleUsers_IncrementNonce() public {
        uint256 shares = 50e18;

        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            address user = address(uint160(i + 1000));
            _mintOkuUsd(user, shares);

            vm.startPrank(user);
            okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user));
            okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user))), shares);
            vm.stopPrank();
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

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

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
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
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
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares);

        _approveBridgeBurn(user1, newChainId, user2, shares);
    }

    function test_RemoveSupportedChain_Success() public {
        vm.prank(admin);
        okuBridge.removeSupportedChain(OPTIMISM_CHAIN_ID);

        assertFalse(okuBridge.supportedChains(OPTIMISM_CHAIN_ID));

        // Verify cannot bridge to it
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares);

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.UnsupportedChain.selector, OPTIMISM_CHAIN_ID)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();
    }

    function test_UpdateLimits_Success() public {
        uint256 newMin = 10e18;
        uint256 newMax = 5000e18;

        vm.prank(admin);
        okuBridge.updateLimits(newMin, newMax);

        assertEq(okuBridge.minBridgeShares(), newMin);
        assertEq(okuBridge.maxBridgeShares(), newMax);

        // Test below new minimum (mint enough for the valid bridgeBurn at newMin)
        _mintOkuUsd(user1, newMin);
        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(
            abi.encodeWithSelector(OkuBridge.AmountBelowMinimum.selector, newMin - 1, newMin)
        );
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), newMin - 1);

        // Test at new minimum (should work — approval already covers newMin)
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), newMin);
        vm.stopPrank();
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
        _mintOkuUsd(user1, shares);

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        assertEq(okuBridge.outboundNonce(OPTIMISM_CHAIN_ID), nonceBefore + 2);
    }

    function test_SkipNonce_RevertNotAuthorized() public {
        bytes32 role = okuBridge.BRIDGE_NONCE_ADMIN();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, role
            )
        );
        vm.prank(user1);
        okuBridge.skipNonce(OPTIMISM_CHAIN_ID);
    }

    function test_RefundFailedRequest_Success() public {
        uint256 shares = 100e18;
        uint256 netShares = shares - (shares * okuBridge.bridgeFee()) / 10_000;

        // Create a bridge request that "failed" on destination
        // request.shares == netShares (what would have been minted on destination)
        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        // Verify user1 shares were burned
        assertEq(okuUsd.sharesOf(user1), 0);

        // Admin refunds the request — must wait for mint window to close
        // proof param is unused in current implementation (OkuBridge.sol).
        // When proof verification is added, this test must be updated with valid proof data.
        bytes memory proof = "";

        // Warp past the deadline so the mint window is closed
        vm.warp(request.deadline + 1);

        uint256 user1SharesBefore = okuUsd.sharesOf(user1);
        uint256 user1TokensBefore = okuUsd.balanceOf(user1);

        vm.prank(admin);
        okuBridge.refundFailedRequest(request, proof);

        // Verify netShares returned to original sender (fee is non-refundable)
        assertEq(okuUsd.sharesOf(user1), user1SharesBefore + netShares);

        // Verify token balance reflects refunded shares at current multiplier
        uint256 expectedTokens = okuUsd.sharesToTokens(netShares);
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
            recipient: bytes32(uint256(uint160(user2))),
            shares: 100e18,
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
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
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

        uint256 fee = (shares * okuBridge.bridgeFee()) / 10_000;
        uint256 netShares = shares - fee;
        _mintOkuUsd(user1, shares);

        uint256 totalSharesBefore = okuUsd.totalShares();

        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        // Net supply change: burned shares - minted feeShares = netShares
        assertEq(okuUsd.totalShares(), totalSharesBefore - netShares);
    }

    function testFuzz_BridgeMint_SignatureValidation(uint256 shares, address recipient) public {
        vm.assume(recipient != address(0));
        shares = bound(shares, 1e18, 1_000_000e18);

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(recipient))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        uint256 recipientBefore = okuUsd.sharesOf(recipient);

        okuBridge.bridgeMint(request, signature);

        assertEq(okuUsd.sharesOf(recipient), recipientBefore + shares);
    }

    function testFuzz_FullRoundTrip_ValuePreservation(uint256 shares) public {
        shares = bound(shares, okuBridge.minBridgeShares(), okuBridge.maxBridgeShares());

        uint256 fee = (shares * okuBridge.bridgeFee()) / 10_000;
        uint256 netShares = shares - fee;
        _mintOkuUsd(user1, shares);

        // Bridge burn
        _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        // Create request (encodes netShares, what destination will mint)
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: netShares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);

        // Bridge mint
        okuBridge.bridgeMint(request, signature);

        // Verify netShares minted on destination; fee collected on source
        assertEq(okuUsd.sharesOf(user2), netShares);
        assertEq(okuUsd.sharesOf(feeRecipient), fee);
    }

    // ============ Event Tests ============

    function test_BridgeBurn_EmitsEvent() public {
        uint256 shares = 100e18;
        uint256 netShares = shares - (shares * 10) / 10_000;
        _mintOkuUsd(user1, shares);

        uint256 nonce = okuBridge.outboundNonce(OPTIMISM_CHAIN_ID);

        // Calculate expected requestId (encodes netShares)
        OkuBridge.BridgeRequest memory expectedRequest = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: netShares,
            nonce: nonce,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
        bytes32 expectedRequestId = keccak256(abi.encode(expectedRequest));

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));

        vm.expectEmit(true, true, false, true);
        emit OkuBridge.BridgeBurn(
            expectedRequestId,
            user1,
            bytes32(uint256(uint160(user2))),
            block.chainid,
            OPTIMISM_CHAIN_ID,
            netShares,
            nonce,
            block.timestamp + okuBridge.bridgeDeadline()
        );

        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();
    }

    /// @notice A user can bridge their entire balance when fee > 0.
    ///         This was the edge case the old additive model silently broke.
    function test_BridgeBurn_EntireBalance() public {
        uint256 shares = 100e18;
        // Mint ONLY the bridge amount — no extra for fees
        _mintOkuUsd(user1, shares);

        uint256 feeShares = (shares * okuBridge.bridgeFee()) / 10_000;
        uint256 netShares = shares - feeShares;

        bytes32 requestId = _approveBridgeBurn(user1, OPTIMISM_CHAIN_ID, user2, shares);

        // User has zero balance remaining
        assertEq(okuUsd.sharesOf(user1), 0);
        // Fee recipient collected the fee
        assertEq(okuUsd.sharesOf(feeRecipient), feeShares);
        // Request ID encodes netShares (what destination will mint)
        OkuBridge.BridgeRequest memory expected = OkuBridge.BridgeRequest({
            sourceChainId: block.chainid,
            destChainId: OPTIMISM_CHAIN_ID,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: netShares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });
        assertEq(requestId, keccak256(abi.encode(expected)));
    }

    // ============ Missing Coverage Tests ============

    function test_RefundFailedRequest_RevertAlreadyRefunded() public {
        uint256 shares = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        bytes memory proof = "";

        // Warp past the deadline so the mint window is closed
        vm.warp(request.deadline + 1);

        // First refund succeeds
        vm.prank(admin);
        okuBridge.refundFailedRequest(request, proof);

        // Second refund reverts with AlreadyRefunded
        bytes32 requestId = keccak256(abi.encode(request));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OkuBridge.AlreadyRefunded.selector, requestId));
        okuBridge.refundFailedRequest(request, proof);
    }

    function test_BridgeBurn_RevertZeroRecipient() public {
        uint256 shares = 100e18;
        _mintOkuUsd(user1, shares);

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(0), shares);
        vm.stopPrank();
    }

    function test_UpdateDeadline_Success() public {
        uint256 newDeadline = 2 hours;

        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit OkuBridge.DeadlineUpdated(1 hours, newDeadline);
        okuBridge.updateDeadline(newDeadline);

        assertEq(okuBridge.bridgeDeadline(), newDeadline);
    }

    function test_UpdateDeadline_RevertZero() public {
        vm.prank(admin);
        vm.expectRevert("Deadline must be positive");
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
        emit OkuBridge.FeeRecipientUpdated(feeRecipient, newRecipient);
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
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize, (address(0), orchestratorSigner, feeRecipient, admin)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroSigner() public {
        OkuBridge impl = new OkuBridge();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize, (address(okuUsd), address(0), feeRecipient, admin)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroFeeRecipient() public {
        OkuBridge impl = new OkuBridge();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize, (address(okuUsd), orchestratorSigner, address(0), admin)
        );
        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroAdmin() public {
        OkuBridge impl = new OkuBridge();
        bytes memory initData = abi.encodeCall(
            OkuBridge.initialize, (address(okuUsd), orchestratorSigner, feeRecipient, address(0))
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
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp // exactly now
        });

        bytes memory signature = _signBridgeRequest(request);

        // Should succeed — condition is block.timestamp > deadline (strict >)
        okuBridge.bridgeMint(request, signature);
        assertEq(okuUsd.sharesOf(user2), shares);
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
        emit OkuBridge.NonceSkipped(OPTIMISM_CHAIN_ID, nonce);
        okuBridge.skipNonce(OPTIMISM_CHAIN_ID);
    }

    function test_RefundFailedRequest_EmitsEvent() public {
        uint256 shares = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        bytes32 requestId = keccak256(abi.encode(request));

        // Warp past the deadline so the mint window is closed
        vm.warp(request.deadline + 1);

        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit OkuBridge.RefundProcessed(requestId, user1, request.shares);
        okuBridge.refundFailedRequest(request, "");
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
        okuBridge.updateLimits(1e18, 100e18);
    }

    function test_BridgeMint_EmitsEvent() public {
        uint256 shares = 100e18;

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(uint256(uint160(user2))),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + okuBridge.bridgeDeadline()
        });

        bytes memory signature = _signBridgeRequest(request);
        bytes32 requestId = keccak256(abi.encode(request));

        vm.expectEmit(true, true, false, true);
        emit OkuBridge.BridgeMint(
            requestId, bytes32(uint256(uint160(user2))), OPTIMISM_CHAIN_ID, shares
        );

        okuBridge.bridgeMint(request, signature);
    }

    // ============ M-2: Zero Recipient Validation ============

    function test_BridgeMint_RevertZeroRecipient() public {
        uint256 shares = 100e18;

        // Craft a request where the lower 20 bytes of recipient are zero
        // (e.g., a Solana pubkey whose lower 20 bytes happen to be 0x0)
        bytes32 solanaPubkeyLowerZero = bytes32(uint256(0xDEADBEEF) << 160);

        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: solanaPubkeyLowerZero,
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        okuBridge.bridgeMint(request, signature);
    }

    function test_BridgeMint_RevertPureZeroRecipient() public {
        uint256 shares = 100e18;

        // Recipient is bytes32(0) — lower 20 bytes are also zero
        OkuBridge.BridgeRequest memory request = OkuBridge.BridgeRequest({
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: block.chainid,
            sender: user1,
            recipient: bytes32(0),
            shares: shares,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory signature = _signBridgeRequest(request);

        vm.expectRevert(OkuBridge.ZeroAddress.selector);
        okuBridge.bridgeMint(request, signature);
    }

    // ============ Dust Sweep Tests ============

    function test_SweepDust_RecoverAccumulatedRounding() public {
        // Perform a bridge at a non-unit multiplier to create rounding dust
        uint256 newMultiplier = PRECISION * 3 / 2; // 1.5x
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        uint256 shares = 100e18;
        _mintOkuUsd(user1, okuUsd.sharesToTokens(shares));

        vm.startPrank(user1);
        okuUsd.approve(address(okuBridge), okuUsd.balanceOf(user1));
        okuBridge.bridgeBurn(OPTIMISM_CHAIN_ID, bytes32(uint256(uint160(user2))), shares);
        vm.stopPrank();

        uint256 dustBalance = okuUsd.balanceOf(address(okuBridge));

        // Sweep dust to feeRecipient
        uint256 feeRecipientBefore = okuUsd.balanceOf(feeRecipient);

        vm.prank(admin);
        okuBridge.sweepDust();

        // Bridge balance is now zero
        assertEq(okuUsd.balanceOf(address(okuBridge)), 0);
        // Fee recipient received the dust
        assertEq(okuUsd.balanceOf(feeRecipient), feeRecipientBefore + dustBalance);
    }

    function test_SweepDust_EmitsEvent() public {
        // Force some dust by minting directly to bridge (simulating rounding)
        _mintOkuUsd(address(okuBridge), 1);
        uint256 dustBalance = okuUsd.balanceOf(address(okuBridge));
        assertGt(dustBalance, 0);

        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit OkuBridge.DustSwept(feeRecipient, dustBalance);
        okuBridge.sweepDust();
    }

    function test_SweepDust_NoOpWhenZeroBalance() public {
        // Bridge has zero balance — sweepDust should be a no-op (no revert)
        assertEq(okuUsd.balanceOf(address(okuBridge)), 0);

        vm.prank(admin);
        okuBridge.sweepDust(); // should not revert
    }

    function test_SweepDust_RevertNotAuthorized() public {
        bytes32 role = okuBridge.DUST_SWEEPER();

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
        uint256 shares = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        // Deadline is in the future — refund should revert
        assertLe(block.timestamp, request.deadline);

        vm.prank(admin);
        vm.expectRevert(OkuBridge.MintWindowStillOpen.selector);
        okuBridge.refundFailedRequest(request, "");
    }

    function test_RefundFailedRequest_RevertAtExactDeadline() public {
        uint256 shares = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        // Warp to exactly the deadline — should still revert (condition is block.timestamp <= deadline)
        vm.warp(request.deadline);

        vm.prank(admin);
        vm.expectRevert(OkuBridge.MintWindowStillOpen.selector);
        okuBridge.refundFailedRequest(request, "");
    }

    function test_RefundFailedRequest_SucceedsAfterDeadline() public {
        uint256 shares = 100e18;

        (, OkuBridge.BridgeRequest memory request) =
            _mintSharesAndBridge(user1, shares, OPTIMISM_CHAIN_ID, user2);

        // Warp past the deadline
        vm.warp(request.deadline + 1);

        uint256 user1SharesBefore = okuUsd.sharesOf(user1);

        vm.prank(admin);
        okuBridge.refundFailedRequest(request, "");

        // Verify refund succeeded
        assertEq(okuUsd.sharesOf(user1), user1SharesBefore + request.shares);
    }
}
