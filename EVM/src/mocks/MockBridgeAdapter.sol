// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBridgeAdapter} from "../bridge/adapters/IBridgeAdapter.sol";

interface IOkuMoneyMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockBridgeAdapter
 * @notice Mock IBridgeAdapter used by both Foundry and Hardhat tests.
 * @dev Records bridge requests and exposes `completeBridge()` to simulate destination
 *      chain mints. The mock must be granted OKUM_MINTER on OkuMoney by the test setup
 *      (and have minter allowance configured) for `completeBridge*` to succeed.
 *
 *      This mock contains no cheatcodes (no forge-std dependency) so it compiles under
 *      Hardhat and Foundry alike.
 */
contract MockBridgeAdapter is IBridgeAdapter {
    struct PendingBridge {
        address token;
        uint256 amount;
        uint256 destinationChain;
        address recipient;
        address caller;
    }

    PendingBridge[] public pendingBridges;
    IOkuMoneyMintable public okuMoney;

    event BridgeCalled(
        address indexed caller,
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );
    event BridgeCompleted(uint256 index, address recipient, uint256 amount);

    error InvalidBridgeIndex();
    error NoPendingBridges();

    constructor(address _okuMoney) {
        okuMoney = IOkuMoneyMintable(_okuMoney);
    }

    function bridge(
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external
        payable
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

    /// @notice Simulate destination chain mint. This mock must have OKUM_MINTER role.
    function completeBridge(uint256 index) external {
        if (index >= pendingBridges.length) revert InvalidBridgeIndex();
        PendingBridge memory p = pendingBridges[index];
        okuMoney.mint(p.recipient, p.amount);
        emit BridgeCompleted(index, p.recipient, p.amount);
    }

    /// @notice Simulate destination chain mint to an alternate recipient.
    function completeBridgeTo(uint256 index, address to) external {
        if (index >= pendingBridges.length) revert InvalidBridgeIndex();
        PendingBridge memory p = pendingBridges[index];
        okuMoney.mint(to, p.amount);
        emit BridgeCompleted(index, to, p.amount);
    }

    function getPendingBridge(uint256 index) external view returns (PendingBridge memory) {
        if (index >= pendingBridges.length) revert InvalidBridgeIndex();
        return pendingBridges[index];
    }

    function getLastBridge() external view returns (PendingBridge memory) {
        if (pendingBridges.length == 0) revert NoPendingBridges();
        return pendingBridges[pendingBridges.length - 1];
    }

    function pendingBridgesCount() external view returns (uint256) {
        return pendingBridges.length;
    }
}
