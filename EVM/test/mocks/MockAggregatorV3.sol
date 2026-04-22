// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockAggregatorV3
 * @notice Mock Chainlink oracle for PoR testing
 */
contract MockAggregatorV3 {
    int256 private _answer;
    uint256 private _timestamp;
    uint80 private _roundId;
    uint80 private _answeredInRound;

    constructor() {
        _answer = int256(1_000_000_000e18); // 1B reserves
        _timestamp = block.timestamp;
        _roundId = 1;
        _answeredInRound = 1; // complete round by default
    }

    function setAnswer(int256 answer) external {
        _answer = answer;
        _timestamp = block.timestamp;
        _answeredInRound = _roundId; // complete round
    }

    function setTimestamp(uint256 timestamp) external {
        _timestamp = timestamp;
    }

    function setStale() external {
        _timestamp = block.timestamp - 2 hours;
    }

    /// @notice Simulate an incomplete round (answeredInRound < roundId)
    function setRoundIncomplete() external {
        _roundId = 2;
        _answeredInRound = 1; // answeredInRound < roundId
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _answer, 0, _timestamp, _answeredInRound);
    }
}
