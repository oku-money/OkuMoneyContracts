// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOFTAdapter} from "./IOFTAdapter.sol";
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
 * @title OFTBridgeAdapter
 * @notice Adapter to integrate LayerZero OFT for burn/mint bridging
 * @dev Follows the same burn-then-bridge pattern as NttBridgeAdapter
 *
 * Flow:
 * 1. User calls quoteBridge() to get fee estimate
 * 2. User calls bridge() with amount, destination, and ETH for fees
 * 3. Adapter burns tokens from user
 * 4. Adapter calls OFTAdapter.send() to send cross-chain message
 * 5. On destination, LayerZero delivers message and triggers lzReceive()
 */
contract OFTBridgeAdapter is Ownable {
    IOFTAdapter public immutable oftAdapter;
    IBridgeToken public immutable token;

    // Mapping from EVM chain ID to LayerZero V2 endpoint ID
    mapping(uint256 => uint32) public lzEndpointId;

    // Events
    event BridgeInitiated(
        address indexed sender,
        uint256 amount,
        uint32 dstEid,
        bytes32 recipient
    );
    event EndpointIdConfigured(uint256 evmChainId, uint32 lzEndpointId);
    event TokensMinted(address indexed recipient, uint256 amount);

    // Errors
    error UnsupportedChain(uint256 chainId);
    error InvalidRecipient();
    error InvalidAmount();
    error OnlyOFTAdapter();

    constructor(
        address _oftAdapter,
        address _token,
        address _owner
    ) Ownable(_owner) {
        oftAdapter = IOFTAdapter(_oftAdapter);
        token = IBridgeToken(_token);

        // Pre-configure LayerZero V2 endpoint IDs
        // See: https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
        lzEndpointId[1] = 30101;      // Ethereum
        lzEndpointId[10] = 30111;     // Optimism
        lzEndpointId[42161] = 30110;  // Arbitrum
        lzEndpointId[8453] = 30184;   // Base
        lzEndpointId[137] = 30109;    // Polygon
        lzEndpointId[43114] = 30106;  // Avalanche
    }

    /**
     * @notice Quote the native fee for bridging tokens
     * @param amount Amount to bridge
     * @param destinationChain EVM chain ID of destination
     * @param recipient Recipient address on destination chain
     * @return nativeFee The native token fee required
     */
    function quoteBridge(
        uint256 amount,
        uint256 destinationChain,
        address recipient
    ) external view returns (uint256 nativeFee) {
        uint32 dstEid = lzEndpointId[destinationChain];
        if (dstEid == 0) revert UnsupportedChain(destinationChain);

        IOFTAdapter.SendParam memory sendParam = IOFTAdapter.SendParam({
            dstEid: dstEid,
            to: bytes32(uint256(uint160(recipient))),
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        IOFTAdapter.MessagingFee memory fee = oftAdapter.quoteSend(sendParam, false);
        return fee.nativeFee;
    }

    /**
     * @notice Bridge tokens to another chain via LayerZero
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

        uint32 dstEid = lzEndpointId[destinationChain];
        if (dstEid == 0) revert UnsupportedChain(destinationChain);

        // Burn tokens from sender
        token.burn(msg.sender, amount);

        bytes32 recipientBytes32 = bytes32(uint256(uint160(recipient)));

        IOFTAdapter.SendParam memory sendParam = IOFTAdapter.SendParam({
            dstEid: dstEid,
            to: recipientBytes32,
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        IOFTAdapter.MessagingFee memory fee = IOFTAdapter.MessagingFee({
            nativeFee: msg.value,
            lzTokenFee: 0
        });

        oftAdapter.send{value: msg.value}(sendParam, fee, msg.sender);

        emit BridgeInitiated(msg.sender, amount, dstEid, recipientBytes32);
    }

    /**
     * @notice Receive tokens from another chain and mint to recipient
     * @dev Called by LayerZero endpoint after validating the cross-chain message
     * @param recipient Recipient address
     * @param amount Amount to mint
     */
    function lzReceive(address recipient, uint256 amount) external {
        // In production, validate msg.sender is LayerZero endpoint
        if (msg.sender != address(oftAdapter)) revert OnlyOFTAdapter();

        token.mint(recipient, amount);

        emit TokensMinted(recipient, amount);
    }

    /**
     * @notice Configure LayerZero endpoint ID mapping
     * @param evmChainId EVM chain ID
     * @param _lzEndpointId LayerZero V2 endpoint ID
     */
    function configureEndpointId(uint256 evmChainId, uint32 _lzEndpointId) external onlyOwner {
        lzEndpointId[evmChainId] = _lzEndpointId;
        emit EndpointIdConfigured(evmChainId, _lzEndpointId);
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
