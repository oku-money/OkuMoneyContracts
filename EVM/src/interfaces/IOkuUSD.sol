// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuUSD
 * @notice Shared interface for OkuUSD used by LitePSM, RedemptionQueue, OkuBridge, and OkuBridgeRouter
 */
interface IOkuUSD {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function sharesOf(address account) external view returns (uint256);
    function sharesToTokens(uint256 shares) external view returns (uint256);
    function tokensToShares(uint256 amount) external view returns (uint256);
    function rewardMultiplier() external view returns (uint256);
    function baseMultiplier() external view returns (uint256);
    function ratePerSecond() external view returns (uint256);
    function lastAccrualTime() external view returns (uint256);
    function rateEnd() external view returns (uint256);
    function pendingRatePerSecond() external view returns (uint256);
    function setYieldRate(uint256 newRatePerSecond, uint256 endTimestamp) external;
    function setNextYieldRate(uint256 newRatePerSecond) external;
}
