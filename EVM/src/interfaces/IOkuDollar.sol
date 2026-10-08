// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IOkuDollar
 * @notice Interface for the OkuDollar vault (rebasing stablecoin backed by OkuMoney reserves).
 */
interface IOkuDollar {
    /// @notice Underlying asset (OkuMoney address). ERC-4626 `asset()`.
    function asset() external view returns (address);
    /// @notice Wrap OkuMoney into OkuDollar.
    /// @param minAmountOut Revert if fewer dollars would be minted (0 disables).
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        external
        returns (uint256 usdMinted);
    /// @notice Unwrap OkuDollar back to OkuMoney.
    function unwrap(uint256 usdAmount, address receiver) external returns (uint256 okuMReturned);
    /// @notice Dollar-denominated balance for `account` (rebasing).
    function balanceOf(address account) external view returns (uint256);
    /// @notice Total dollar-denominated supply (rebasing).
    function totalSupply() external view returns (uint256);
    /// @notice Dollar value per UsdOku share. Delegates to `okuMoney.okuMMultiplier()`.
    function usdMultiplier() external view returns (uint256);
    /// @notice Internal share balance for `account`.
    function usdSharesOf(address account) external view returns (uint256);
    /// @notice Total internal share tokens across all holders.
    function totalUsdShares() external view returns (uint256);
    /// @notice Total OkuMoney tokens held as reserves (ERC-4626 `totalAssets`).
    function totalOkuMReserves() external view returns (uint256);
    /// @notice Total OkuDollar obligations (in dollar terms).
    function totalUsdObligations() external view returns (uint256);
}
