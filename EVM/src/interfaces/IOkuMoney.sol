// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuMoney
 * @notice Shared interface for OkuMoney used by LitePSM, RedemptionQueue, OkuBridge, and OkuBridgeRouter
 * @dev OkuMoney is a non-rebasing standard ERC-20. okuMPrice() tracks price appreciation
 *      separately from balanceOf(). No share conversion functions exist.
 */
interface IOkuMoney {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function okuMPrice() external view returns (uint256);
    function setOkuMPrice(uint256 newPrice) external;
    function distributeYield(uint256 yieldAmount) external;
}
