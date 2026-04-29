// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IAggregatorV3
 * @notice Minimal Chainlink AggregatorV3-compatible interface for PoR oracle reads.
 * @dev Subset of Chainlink's `AggregatorV3Interface` containing only `latestRoundData`,
 *      which is the only call site we use across the protocol.
 *      Taken from https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol
 */
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
