// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeBaseTest} from "../BridgeBase.t.sol";
import {OkuBridgeHandler} from "../handlers/OkuBridgeHandler.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";

/**
 * @title BridgeInvariantsTest
 * @notice Stateful invariant tests for OkuBridge driven by OkuBridgeHandler.
 * @dev Models a single chain that simultaneously acts as source (via bridgeBurn to
 *      OPTIMISM_CHAIN_ID) and destination (via bridgeMint with sourceChainId =
 *      OPTIMISM_CHAIN_ID). The handler tracks ghost variables sufficient to verify:
 *
 *      1. Bridge contract never holds OkuMoney (burn is atomic).
 *      2. Outbound nonce equals the number of successful bridgeBurn calls.
 *      3. processed and refunded request sets are disjoint (no double-finalisation).
 *      4. Sum of fees collected matches per-burn arithmetic.
 *      5. Net minted ≤ net burned + net refunded (no value creation).
 */
contract BridgeInvariantsTest is BridgeBaseTest {
    OkuBridgeHandler public handler;

    function setUp() public override {
        super.setUp();

        handler = new OkuBridgeHandler(
            okuBridge,
            IOkuMoney(address(okuMoney)),
            feeRecipient,
            refundInitiator,
            refundConfirmer,
            admin,
            OPTIMISM_CHAIN_ID
        );

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
        excludeContract(address(okuBridge));
        excludeContract(address(bridgeRouter));
        excludeContract(address(mockAdapter));
        excludeContract(address(mockNttManager));
    }

    /// @notice The bridge contract never holds OkuMoney — every bridgeBurn is atomic
    ///         (transferFrom + self-burn) and every fee is minted directly to feeRecipient.
    function invariant_BridgeHoldsNoOkuMoney() public view {
        assertEq(
            okuMoney.balanceOf(address(okuBridge)),
            0,
            "OkuBridge must never hold OkuMoney across calls"
        );
    }

    /// @notice The bridge's outbound nonce equals the number of successful bridgeBurn calls.
    function invariant_OutboundNonceEqualsBurnCount() public view {
        assertEq(
            okuBridge.outboundNonce(handler.remoteChain()),
            handler.ghostBurnCount(),
            "outboundNonce[remote] must equal ghostBurnCount"
        );
    }

    /// @notice processed and refunded request sets are disjoint — every requestId we
    ///         see was either minted on the destination OR refunded on the source,
    ///         never both. We sample by scanning every requestId the handler ever burned.
    function invariant_NoProcessedAndRefunded() public view {
        uint256 n = handler.ghostBurnRequestCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 srcRequestId = handler.allBurnRequestIds(i);
            // For mint-on-destination the requestId hashes the (remote→local) request,
            // not the source-chain (local→remote) request. We can still check that the
            // *source-chain* requestId is never both refunded (on source) and "minted"
            // (per the handler's own bookkeeping for the mirrored request).
            bool refunded = okuBridge.refundedRequests(srcRequestId);
            bool minted = handler.ghostMintedLocally(srcRequestId);
            assertFalse(refunded && minted, "request was both refunded and minted");
        }
    }

    /// @notice The fee accounting equation: feeRecipient holds exactly the cumulative
    ///         fee minted by every successful bridgeBurn.
    /// @dev `okuMoney.balanceOf(feeRecipient)` may have started non-zero only if other
    ///      tests seeded it; this test deploys feeRecipient fresh so the equality is exact.
    function invariant_FeeRecipientReceivesExactFees() public view {
        assertEq(
            okuMoney.balanceOf(feeRecipient),
            handler.ghostFeesCollected(),
            "feeRecipient balance must equal ghostFeesCollected"
        );
    }

    /// @notice Net minted on this chain via bridgeMint cannot exceed net burned + net refunded.
    /// @dev On a real two-chain system mints would be on chain B and burns on chain A;
    ///      this is the value-conservation invariant. In our single-chain model the
    ///      inequality is the strongest correct statement.
    function invariant_MintedAtMostBurnedPlusRefunded() public view {
        uint256 minted = handler.ghostNetMinted();
        uint256 burned = handler.ghostNetBurned();
        uint256 refunded = handler.ghostNetRefunded();
        assertLe(
            minted, burned + refunded, "minted on dest cannot exceed burned + refunded on source"
        );
    }
}
