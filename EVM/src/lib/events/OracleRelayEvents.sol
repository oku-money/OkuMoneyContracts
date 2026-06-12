// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OracleRelayEvents
 * @notice Event declarations for the OracleRelay contract.
 * @dev Inherited by OracleRelay; see OkuMoneyEvents for the rationale.
 */
abstract contract OracleRelayEvents {
    /// @notice Emitted when the underlying USDC/USD price feed is rotated.
    /// @param oldFeed Previous Chainlink aggregator address.
    /// @param newFeed New Chainlink aggregator address.
    /// @param decimals Cached decimal count of the new feed.
    event PriceFeedUpdated(address indexed oldFeed, address indexed newFeed, uint8 decimals);

    /// @notice Emitted when the staleness threshold is updated.
    event StalenessThresholdUpdated(uint256 oldSeconds, uint256 newSeconds);

    /// @notice Emitted when the in-band price window is updated.
    event PriceBandUpdated(
        uint256 oldMinE18, uint256 oldMaxE18, uint256 newMinE18, uint256 newMaxE18
    );
}
