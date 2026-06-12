// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IAggregatorV3
 * @notice Minimal Chainlink AggregatorV3-compatible interface used by the OracleRelay
 *         to read the USDC/USD feed.
 * @dev Subset of Chainlink's `AggregatorV3Interface` containing only `latestRoundData`,
 *      which is the only call site we use across the protocol. The companion
 *      `decimals()` read is declared locally inside {OracleRelay} to keep this
 *      interface minimal.
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
