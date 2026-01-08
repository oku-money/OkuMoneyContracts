// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IOkuBridge} from "../../src/bridge/adapters/IOkuBridge.sol";
import {OkuUSD} from "../../src/token/OkuUSD.sol";

/**
 * @title MockOkuBridge
 * @notice Mock bridge adapter for testing OkuBridgeRouter
 * @dev Records bridge requests and allows simulating destination chain mints
 */
contract MockOkuBridge is IOkuBridge, Test {
    struct PendingBridge {
        address token;
        uint256 amount;
        uint256 destinationChain;
        address recipient;
    }

    PendingBridge[] public pendingBridges;
    OkuUSD public okuUSD;
    address public minter;

    // Events for testing
    event BridgeCalled(address token, uint256 amount, uint256 destinationChain, address recipient);
    event BridgeCompleted(uint256 index, address recipient, uint256 amount);

    constructor(OkuUSD _okuUSD, address _minter) {
        okuUSD = _okuUSD;
        minter = _minter;
    }

    /**
     * @notice Called by OkuBridgeRouter to initiate bridge
     * @dev Records the request for later completion in tests
     */
    function bridge(
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    ) external override {
        pendingBridges.push(PendingBridge({
            token: token,
            amount: amount,
            destinationChain: destinationChain,
            recipient: recipient
        }));

        emit BridgeCalled(token, amount, destinationChain, recipient);
    }

    /**
     * @notice Simulate receiving bridge on destination chain
     * @dev Not used in these tests, but part of IOkuBridge interface
     */
    function receiveBridge(address, uint256, address) external pure override {
        // Not implemented for mock - we use completeBridge instead
        revert("Use completeBridge for testing");
    }

    /**
     * @notice Simulate destination chain mint (for testing full round-trip)
     * @param index Index of pending bridge to complete
     */
    function completeBridge(uint256 index) external {
        require(index < pendingBridges.length, "Invalid bridge index");
        PendingBridge memory p = pendingBridges[index];

        vm.prank(minter);
        okuUSD.mint(p.recipient, p.amount);

        emit BridgeCompleted(index, p.recipient, p.amount);
    }

    /**
     * @notice Complete bridge to a different recipient (for testing)
     */
    function completeBridgeTo(uint256 index, address to) external {
        require(index < pendingBridges.length, "Invalid bridge index");
        PendingBridge memory p = pendingBridges[index];

        vm.prank(minter);
        okuUSD.mint(to, p.amount);

        emit BridgeCompleted(index, to, p.amount);
    }

    // ============ View Functions ============

    function getPendingBridge(uint256 index) external view returns (PendingBridge memory) {
        require(index < pendingBridges.length, "Invalid bridge index");
        return pendingBridges[index];
    }

    function pendingBridgesCount() external view returns (uint256) {
        return pendingBridges.length;
    }

    function getLastBridge() external view returns (PendingBridge memory) {
        require(pendingBridges.length > 0, "No pending bridges");
        return pendingBridges[pendingBridges.length - 1];
    }
}
