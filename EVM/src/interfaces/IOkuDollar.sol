// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuDollar
 * @notice Interface for OkuDollar vault (rebasing stablecoin backed by OkuMoney reserves)
 */
interface IOkuDollar {
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        external
        returns (uint256 usdMinted);
    function unwrap(uint256 usdAmount, address receiver) external returns (uint256 okuMReturned);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function usdMultiplier() external view returns (uint256);
    function usdSharesOf(address account) external view returns (uint256);
    function totalUsdShares() external view returns (uint256);
    function totalOkuMReserves() external view returns (uint256);
    function totalUsdObligations() external view returns (uint256);
    function collateralizationRatio() external view returns (uint256);
    function surplus() external view returns (uint256);
}
