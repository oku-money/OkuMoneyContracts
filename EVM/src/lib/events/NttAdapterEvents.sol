// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title NttAdapterEvents
 * @notice Event declarations for the NttAdapter contract.
 * @dev Inherited by NttAdapter. Adapter-specific event names are prefixed with the
 *      adapter family (`Ntt`) so future adapters (e.g. `CctpBridgeInitiated`,
 *      `LzBridgeInitiated`) avoid clashing with router-level events.
 */
abstract contract NttAdapterEvents {
    /// @notice Emitted when the adapter forwards a cross-chain message via Wormhole NTT.
    event NttBridgeInitiated(
        uint256 amount, uint16 wormholeChainId, bytes32 recipient, uint64 sequence
    );

    /// @notice Emitted when admin rescues stuck ETH.
    event NttEthWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when admin rescues stuck tokens.
    event NttTokensWithdrawn(address indexed token, address indexed to, uint256 amount);

    event ChainIdConfigured(uint256 evmChainId, uint16 wormholeChainId);
}
