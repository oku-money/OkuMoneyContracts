// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OkuBridge} from "../../src/bridge/OkuBridge.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {TestKeys} from "../shared/Keys.sol";

/**
 * @title OkuBridgeHandler
 * @notice Stateful invariant handler for OkuBridge.
 * @dev Models a single chain that simultaneously acts as source and destination by
 *      treating OPTIMISM_CHAIN_ID as the "remote" chain id (configured in setUp).
 *      bridgeBurn() goes to OPTIMISM_CHAIN_ID; bridgeMint() arrives from
 *      OPTIMISM_CHAIN_ID. This is mathematically equivalent to a real cross-chain
 *      flow for the purposes of nonce / processed-set / refund-set bookkeeping.
 *
 *      Tracks ghost variables for invariant assertions:
 *      - ghostBurnCount               — total successful bridgeBurn calls
 *      - ghostMintCount               — total successful bridgeMint calls
 *      - ghostInitiatedRefundCount    — total successful initiateRefund calls
 *      - ghostConfirmedRefundCount    — total successful confirmRefund calls
 *      - ghostCancelledRefundCount    — total successful cancelRefund calls
 *      - ghostFeesCollected           — sum of all fees minted to feeRecipient
 *      - ghostNetBurned               — sum of (amount - fee) burned across all bridgeBurns
 *      - ghostNetMinted               — sum of mints from bridgeMint
 *      - allBurnRequestIds            — every requestId returned by bridgeBurn (for invariant
 *                                       checks against processed/refunded sets)
 *      - bridgeRequests[requestId]    — full BridgeRequest struct for each outbound burn so
 *                                       handlers can mint/refund deterministically
 */
contract OkuBridgeHandler is Test {
    OkuBridge public bridge;
    IOkuMoney public okuMoney;
    address public feeRecipient;
    address public refundInitiator;
    address public refundConfirmer;
    address public bridgeAdmin;

    /// @notice The "remote" chain id used both as bridgeBurn destination and as bridgeMint source.
    uint256 public remoteChain;

    /// @notice Orchestrator key — shared with BridgeBaseTest so mint signatures verify.
    uint256 public constant ORCHESTRATOR_PK = TestKeys.ORCHESTRATOR_PK;

    bytes32 public constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 sourceChainId,uint256 destChainId,address sender,bytes32 recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    address[] public actors;

    // Ghost state
    uint256 public ghostBurnCount;
    uint256 public ghostMintCount;
    uint256 public ghostInitiatedRefundCount;
    uint256 public ghostConfirmedRefundCount;
    uint256 public ghostCancelledRefundCount;
    uint256 public ghostFeesCollected;
    uint256 public ghostNetBurned;
    uint256 public ghostNetMinted;
    uint256 public ghostNetRefunded;

    // Call counters (success rate)
    uint256 public ghostBurnCalls;
    uint256 public ghostBurnReverts;
    uint256 public ghostMintCalls;
    uint256 public ghostMintReverts;
    uint256 public ghostRefundCalls;
    uint256 public ghostRefundReverts;

    // Track every requestId we've ever burned, plus the underlying request details so
    // mint/refund handlers can pick a real outbound request by index.
    bytes32[] public allBurnRequestIds;
    mapping(bytes32 => OkuBridge.BridgeRequest) public outboundRequests;
    mapping(bytes32 => bool) public ghostMintedLocally;
    mapping(bytes32 => bool) public ghostRefundInitiated;
    mapping(bytes32 => bool) public ghostRefundConfirmed;

    constructor(
        OkuBridge _bridge,
        IOkuMoney _okuMoney,
        address _feeRecipient,
        address _refundInitiator,
        address _refundConfirmer,
        address _bridgeAdmin,
        uint256 _remoteChain
    ) {
        bridge = _bridge;
        okuMoney = _okuMoney;
        feeRecipient = _feeRecipient;
        refundInitiator = _refundInitiator;
        refundConfirmer = _refundConfirmer;
        bridgeAdmin = _bridgeAdmin;
        remoteChain = _remoteChain;

        actors.push(makeAddr("bridgeActor1"));
        actors.push(makeAddr("bridgeActor2"));
        actors.push(makeAddr("bridgeActor3"));
    }

    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    // ============ Handler Functions ============

    /// @notice Burn tokens for a cross-chain transfer. Records the resulting requestId
    ///         and full BridgeRequest so subsequent mint/refund handlers can reuse them.
    function bridgeBurn(uint256 actorSeed, uint256 amount) external {
        ghostBurnCalls++;

        address actor = actors[actorSeed % actors.length];
        uint128 minAmount = bridge.minBridgeAmount();
        uint128 maxAmount = bridge.maxBridgeAmount();
        amount = bound(amount, minAmount, maxAmount);

        // Ensure the actor has enough OkuMoney + an allowance to the bridge.
        if (okuMoney.balanceOf(actor) < amount) {
            // Request mint via the bridge admin (admin holds OKUM_MINTER per unified policy).
            vm.prank(bridgeAdmin);
            try okuMoney.mint(actor, amount) {}
            catch {
                ghostBurnReverts++;
                return;
            }
        }
        vm.prank(actor);
        IERC20(address(okuMoney)).approve(address(bridge), amount);

        uint256 nonceBefore = bridge.outboundNonce(remoteChain);
        (uint256 feeAmount, uint256 netAmount) = bridge.quoteFee(amount);

        bytes32 recipient = bytes32(uint256(uint160(actor))); // mint back to actor on dest

        vm.prank(actor);
        try bridge.bridgeBurn(remoteChain, recipient, netAmount + feeAmount) returns (
            bytes32 requestId
        ) {
            ghostBurnCount++;
            ghostFeesCollected += feeAmount;
            ghostNetBurned += netAmount;

            allBurnRequestIds.push(requestId);
            outboundRequests[requestId] = OkuBridge.BridgeRequest({
                sourceChainId: block.chainid,
                destChainId: remoteChain,
                sender: actor,
                recipient: recipient,
                amount: netAmount,
                nonce: nonceBefore,
                deadline: block.timestamp + bridge.bridgeDeadline()
            });
        } catch {
            ghostBurnReverts++;
        }
    }

    /// @notice Simulate a mint arriving from `remoteChain` for a previously-burned request.
    function bridgeMint(uint256 requestSeed) external {
        ghostMintCalls++;

        if (allBurnRequestIds.length == 0) {
            ghostMintReverts++;
            return;
        }

        bytes32 srcRequestId = allBurnRequestIds[requestSeed % allBurnRequestIds.length];
        OkuBridge.BridgeRequest memory src = outboundRequests[srcRequestId];

        // Translate the burn request into the mirror-chain mint request:
        // source = remoteChain (where it was burned from this handler's perspective on dest),
        // dest   = block.chainid (this chain).
        OkuBridge.BridgeRequest memory mintReq = OkuBridge.BridgeRequest({
            sourceChainId: remoteChain,
            destChainId: block.chainid,
            sender: src.sender,
            recipient: src.recipient,
            amount: src.amount,
            nonce: src.nonce,
            deadline: block.timestamp + bridge.bridgeDeadline()
        });

        bytes memory signature = _signRequest(mintReq);

        try bridge.bridgeMint(mintReq, signature) {
            ghostMintCount++;
            ghostNetMinted += mintReq.amount;
            ghostMintedLocally[srcRequestId] = true;
        } catch {
            ghostMintReverts++;
        }
    }

    /// @notice Initiate refund for a previously-burned request whose deadline has elapsed.
    function initiateRefund(uint256 requestSeed) external {
        ghostRefundCalls++;
        if (allBurnRequestIds.length == 0) {
            ghostRefundReverts++;
            return;
        }

        bytes32 srcRequestId = allBurnRequestIds[requestSeed % allBurnRequestIds.length];
        OkuBridge.BridgeRequest memory r = outboundRequests[srcRequestId];

        // Push past the original deadline.
        if (block.timestamp <= r.deadline) {
            vm.warp(r.deadline + 1);
        }

        vm.prank(refundInitiator);
        try bridge.initiateRefund(r) {
            ghostInitiatedRefundCount++;
            ghostRefundInitiated[srcRequestId] = true;
        } catch {
            ghostRefundReverts++;
        }
    }

    /// @notice Confirm refund (a different signer than the initiator).
    function confirmRefund(uint256 requestSeed) external {
        ghostRefundCalls++;
        if (allBurnRequestIds.length == 0) {
            ghostRefundReverts++;
            return;
        }

        bytes32 srcRequestId = allBurnRequestIds[requestSeed % allBurnRequestIds.length];
        if (!ghostRefundInitiated[srcRequestId]) {
            ghostRefundReverts++;
            return;
        }
        OkuBridge.BridgeRequest memory r = outboundRequests[srcRequestId];

        vm.prank(refundConfirmer);
        try bridge.confirmRefund(r) {
            ghostConfirmedRefundCount++;
            ghostNetRefunded += r.amount;
            ghostRefundConfirmed[srcRequestId] = true;
        } catch {
            ghostRefundReverts++;
        }
    }

    /// @notice Cancel a pending (un-confirmed) refund proposal.
    function cancelRefund(uint256 requestSeed) external {
        ghostRefundCalls++;
        if (allBurnRequestIds.length == 0) {
            ghostRefundReverts++;
            return;
        }

        bytes32 srcRequestId = allBurnRequestIds[requestSeed % allBurnRequestIds.length];
        if (!ghostRefundInitiated[srcRequestId] || ghostRefundConfirmed[srcRequestId]) {
            ghostRefundReverts++;
            return;
        }
        OkuBridge.BridgeRequest memory r = outboundRequests[srcRequestId];

        vm.prank(refundInitiator);
        try bridge.cancelRefund(r) {
            ghostCancelledRefundCount++;
            ghostRefundInitiated[srcRequestId] = false;
        } catch {
            ghostRefundReverts++;
        }
    }

    // ============ Aggregates ============

    function ghostTotalCalls() external view returns (uint256) {
        return ghostBurnCalls + ghostMintCalls + ghostRefundCalls;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostBurnReverts + ghostMintReverts + ghostRefundReverts;
    }

    function ghostOutboundNonceTotal() external view returns (uint256) {
        return bridge.outboundNonce(remoteChain);
    }

    function ghostBurnRequestCount() external view returns (uint256) {
        return allBurnRequestIds.length;
    }

    // ============ Internals ============

    function _signRequest(OkuBridge.BridgeRequest memory request)
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
                request.amount,
                request.nonce,
                request.deadline
            )
        );
        bytes32 digest = bridge.hashTypedDataV4(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORCHESTRATOR_PK, digest);
        return abi.encodePacked(r, s, v);
    }
}
