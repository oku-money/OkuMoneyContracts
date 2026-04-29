// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title NttAdapterEvents
 * @notice Event declarations for the NttAdapter contract.
 * @dev Inherited by NttAdapter; see OkuMoneyEvents for the rationale.
 */
abstract contract NttAdapterEvents {
    /// @notice Emitted when the adapter forwards a cross-chain message via NTT.
    /// @dev Distinct from OkuBridgeRouter.BridgeInitiated (different signature).
    event BridgeInitiated(
        uint256 amount, uint16 wormholeChainId, bytes32 recipient, uint64 sequence
    );

    event ChainIdConfigured(uint256 evmChainId, uint16 wormholeChainId);
}
