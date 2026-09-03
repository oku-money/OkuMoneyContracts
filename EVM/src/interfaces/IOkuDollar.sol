// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IOkuDollar
 * @notice Interface for the OkuDollar vault (rebasing stablecoin backed by OkuMoney reserves).
 * @dev Exposes the full mint / redeem / view surface so tests, handlers, and invariant
 *      runners can program against a single interface. Production call sites only
 *      invoke `wrap` and `unwrap`; the read-only views are kept here for
 *      off-chain consumers and test scaffolding.
 */
interface IOkuDollar {
    /// @notice Wrap OkuMoney into OkuDollar.
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
    // REMOVED (single-multiplier refactor): collateralizationRatio, surplus —
    // collateralization is exactly 1.0 by construction.
}
