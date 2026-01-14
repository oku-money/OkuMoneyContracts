// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockAggregatorV3
 * @notice Mock Chainlink oracle for PoR testing
 */
contract MockAggregatorV3 {
    int256 private _answer;
    uint256 private _timestamp;

    constructor() {
        _answer = int256(1_000_000_000e18); // 1B reserves
        _timestamp = block.timestamp;
    }

    function setAnswer(int256 answer) external {
        _answer = answer;
        _timestamp = block.timestamp;
    }

    function setAnswerWithoutTimestamp(int256 answer) external {
        _answer = answer;
    }

    function setTimestamp(uint256 timestamp) external {
        _timestamp = timestamp;
    }

    function setStale() external {
        _timestamp = block.timestamp - 2 hours;
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return _timestamp;
    }
}
