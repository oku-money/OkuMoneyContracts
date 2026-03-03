// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "./INttManager.sol";
import {IBridgeAdapter} from "./IBridgeAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title NttAdapter
 * @notice Adapter to integrate Wormhole NTT with OkuBridgeRouter
 * @dev Converts IBridgeAdapter interface to INttManager interface
 *
 * Flow:
 * 1. OkuBridgeRouter burns OkuUSD (via MINTER)
 * 2. Router calls this adapter's bridge() to send cross-chain message
 * 3. This adapter forwards to NttManager.transfer() for Wormhole messaging
 * 4. On destination, NttManager receives VAA and mints OkuUSD
 *
 * Key conversions:
 * - uint256 destinationChain → uint16 (Wormhole chain ID)
 * - address recipient → bytes32 (left-padded)
 *
 * Note: Tokens are already burned before this adapter is called.
 * This adapter only handles the cross-chain message, not token movement.
 */
contract NttAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    INttManager public immutable NTT_MANAGER;
    address public immutable TOKEN;
    address public immutable ROUTER;

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

    error UnsupportedChain(uint256 chainId);
    error InvalidRecipient();
    error InvalidAmount();
    error UnauthorizedCaller();

    constructor(
        address _nttManager,
        address _token,
        address _router,
        address _owner
    )
        Ownable(_owner)
    {
        ROUTER = _router;
        NTT_MANAGER = INttManager(_nttManager);
        TOKEN = _token;

        // Pre-configure common chain mappings
        // See: https://docs.wormhole.com/wormhole/reference/constants
        wormholeChainId[1] = 2; // Ethereum
        wormholeChainId[42_161] = 23; // Arbitrum
        wormholeChainId[10] = 24; // Optimism
        wormholeChainId[137] = 5; // Polygon
        wormholeChainId[8453] = 30; // Base
        wormholeChainId[43_114] = 6; // Avalanche
    }

    /**
     * @notice Send cross-chain message via Wormhole NTT
     * @dev Called by OkuBridgeRouter AFTER it has burned the tokens.
     *      This function only sends the cross-chain message - no token movement.
     * @param _token Token address (for validation, already burned)
     * @param amount Amount that was burned
     * @param destinationChain EVM chain ID (will be converted to Wormhole ID)
     * @param recipient Recipient address on destination chain
     */
    function bridge(
        address _token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external
        payable
        override
    {
        if (msg.sender != ROUTER) revert UnauthorizedCaller();
        require(_token == TOKEN, "Invalid token");
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        uint16 wormholeDestChain = wormholeChainId[destinationChain];
        if (wormholeDestChain == 0) revert UnsupportedChain(destinationChain);

        // Convert address to bytes32 (left-pad with zeros for EVM addresses)
        bytes32 recipientBytes32 = bytes32(uint256(uint160(recipient)));

        // Call NTT transfer to send cross-chain message
        // Note: Tokens already burned by router - this is message-only
        // Forwards any ETH for Wormhole message fees
        uint64 sequence =
            NTT_MANAGER.transfer{value: msg.value}(amount, wormholeDestChain, recipientBytes32);

        emit BridgeInitiated(msg.sender, amount, wormholeDestChain, recipientBytes32, sequence);
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
    function withdrawEth(address payable to) external onlyOwner {
        (bool success,) = to.call{value: address(this).balance}("");
        require(success, "ETH transfer failed");
    }

    /**
     * @notice Withdraw stuck tokens
     */
    function withdrawTokens(address _token, address to, uint256 amount) external onlyOwner {
        IERC20(_token).safeTransfer(to, amount);
    }

    /**
     * @notice Not implemented — NTT handles destination minting natively via VAA
     */
    function receiveBridge(address, uint256, address) external pure {
        revert("NttAdapter: use NTT native receive");
    }

    receive() external payable {}
}
