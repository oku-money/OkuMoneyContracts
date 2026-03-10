// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuNote
 * @notice Shared interface for OkuNote used by LitePSM, RedemptionQueue, OkuBridge, and OkuBridgeRouter
 * @dev OkuNote is a non-rebasing standard ERC-20. notePrice() tracks price appreciation
 *      separately from balanceOf(). No share conversion functions exist.
 */
interface IOkuNote {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function notePrice() external view returns (uint256);
    function basePrice() external view returns (uint256);
    function ratePerSecond() external view returns (uint256);
    function lastAccrualTime() external view returns (uint256);
    function rateEnd() external view returns (uint256);
    function pendingRatePerSecond() external view returns (uint256);
    function setYieldRate(uint256 newRatePerSecond, uint256 endTimestamp) external;
    function setNextYieldRate(uint256 newRatePerSecond) external;
}
