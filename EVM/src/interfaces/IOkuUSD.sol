// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuUSD
 * @notice Interface for OkuUSD vault (rebasing stablecoin backed by OkuNote reserves)
 */
interface IOkuUSD {
    function wrap(uint256 noteAmount, address receiver) external returns (uint256 usdMinted);
    function unwrap(uint256 usdAmount, address receiver) external returns (uint256 notesReturned);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function usdMultiplier() external view returns (uint256);
    function usdSharesOf(address account) external view returns (uint256);
    function totalNoteReserves() external view returns (uint256);
    function totalUsdObligations() external view returns (uint256);
    function collateralizationRatio() external view returns (uint256);
    function surplus() external view returns (uint256);
}
