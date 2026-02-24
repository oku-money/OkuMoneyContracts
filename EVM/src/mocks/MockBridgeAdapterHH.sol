// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBridgeAdapter} from "../bridge/adapters/IBridgeAdapter.sol";

/**
 * @title MockBridgeAdapterHH
 * @notice Hardhat-compatible mock IBridgeAdapter for testing OkuBridgeRouter
 * @dev Records bridge calls. No vm.prank — compatible with both Hardhat and Forge.
 *      Use completeBridge() via a MINTER-role account to simulate destination mints.
 */
contract MockBridgeAdapterHH is IBridgeAdapter {
    struct PendingBridge {
        address token;
        uint256 amount;
        uint256 destinationChain;
        address recipient;
        address caller;
    }

    PendingBridge[] public pendingBridges;

    event BridgeCalled(
        address indexed caller,
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );

    function bridge(
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external
        override
    {
        pendingBridges.push(
            PendingBridge({
                token: token,
                amount: amount,
                destinationChain: destinationChain,
                recipient: recipient,
                caller: msg.sender
            })
        );

        emit BridgeCalled(msg.sender, token, amount, destinationChain, recipient);
    }

    function receiveBridge(address, uint256, address) external pure override {
        revert("Not implemented");
    }

    function getPendingBridge(uint256 index) external view returns (PendingBridge memory) {
        return pendingBridges[index];
    }

    function getLastBridge() external view returns (PendingBridge memory) {
        require(pendingBridges.length > 0, "No pending bridges");
        return pendingBridges[pendingBridges.length - 1];
    }

    function pendingBridgesCount() external view returns (uint256) {
        return pendingBridges.length;
    }
}
