// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "./INttManager.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title IBridgeToken
 * @notice Interface for the BridgeToken contract
 */
interface IBridgeToken {
    function burn(address from, uint256 amount) external;
    function mint(address to, uint256 amount) external;
}

/**
 * @title NttBridgeAdapter
 * @notice Adapter to integrate Wormhole NTT for burn/mint bridging
 * @dev Follows the same pattern as OkuMoney's NttAdapter
 *
 * Flow:
 * 1. User calls bridge() with amount and destination
 * 2. Adapter burns tokens from user
 * 3. Adapter calls NttManager.transfer() to send cross-chain message
 * 4. On destination, NttManager triggers receiveAndMint()
 */
contract NttBridgeAdapter is Ownable {
    INttManager public immutable nttManager;
    IBridgeToken public immutable token;

    // Mapping from EVM chain ID to Wormhole chain ID
    mapping(uint256 => uint16) public wormholeChainId;

    // Events
    event BridgeInitiated(
        address indexed sender,
        uint256 amount,
        uint16 wormholeChainId,
        bytes32 recipient,
        uint64 sequence
    );
    event ChainIdConfigured(uint256 evmChainId, uint16 wormholeChainId);
    event TokensMinted(address indexed recipient, uint256 amount);

    // Errors
    error UnsupportedChain(uint256 chainId);
    error InvalidRecipient();
    error InvalidAmount();
    error OnlyNttManager();

    constructor(
        address _nttManager,
        address _token,
        address _owner
    ) Ownable(_owner) {
        nttManager = INttManager(_nttManager);
        token = IBridgeToken(_token);

        // Pre-configure common chain mappings
        // See: https://docs.wormhole.com/wormhole/reference/constants
        wormholeChainId[1] = 2;       // Ethereum
        wormholeChainId[10] = 24;     // Optimism
        wormholeChainId[42161] = 23;  // Arbitrum
        wormholeChainId[8453] = 30;   // Base
        wormholeChainId[137] = 5;     // Polygon
        wormholeChainId[43114] = 6;   // Avalanche
    }

    /**
     * @notice Bridge tokens to another chain via Wormhole NTT
     * @param amount Amount to bridge
     * @param destinationChain EVM chain ID of destination
     * @param recipient Recipient address on destination chain
     */
    function bridge(
        uint256 amount,
        uint256 destinationChain,
        address recipient
    ) external payable {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        uint16 wormholeDestChain = wormholeChainId[destinationChain];
        if (wormholeDestChain == 0) revert UnsupportedChain(destinationChain);

        // Burn tokens from sender
        token.burn(msg.sender, amount);

        // Convert address to bytes32 (left-pad with zeros for EVM addresses)
        bytes32 recipientBytes32 = bytes32(uint256(uint160(recipient)));

        // Call NTT transfer to send cross-chain message
        // Forwards any ETH for Wormhole message fees
        uint64 sequence = nttManager.transfer{value: msg.value}(
            amount,
            wormholeDestChain,
            recipientBytes32
        );

        emit BridgeInitiated(msg.sender, amount, wormholeDestChain, recipientBytes32, sequence);
    }

    /**
     * @notice Receive tokens from another chain and mint to recipient
     * @dev Called by NttManager after validating the cross-chain message
     * @param recipient Recipient address
     * @param amount Amount to mint
     */
    function receiveAndMint(address recipient, uint256 amount) external {
        if (msg.sender != address(nttManager)) revert OnlyNttManager();

        token.mint(recipient, amount);

        emit TokensMinted(recipient, amount);
    }

    /**
     * @notice Configure Wormhole chain ID mapping
     * @param evmChainId EVM chain ID
     * @param _wormholeChainId Wormhole chain ID
     */
    function configureChainId(uint256 evmChainId, uint16 _wormholeChainId) external onlyOwner {
        wormholeChainId[evmChainId] = _wormholeChainId;
        emit ChainIdConfigured(evmChainId, _wormholeChainId);
    }

    /**
     * @notice Withdraw stuck ETH (from failed bridge attempts)
     */
    function withdrawETH(address payable to) external onlyOwner {
        (bool success,) = to.call{value: address(this).balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
