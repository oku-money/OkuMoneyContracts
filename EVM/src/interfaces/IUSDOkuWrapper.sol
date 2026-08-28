// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IUSDOkuWrapper
 * @notice Interface for the OkuM <-> USDOku wrapper's solvency views.
 * @dev `USDOku.setUsdOkuRate` calls {realizedBacking} through this interface to
 *      enforce `Constants.MAX_SOLVENCY_GAP_BPS` on the projected rate — the one
 *      live call site for the solvency bound. Wired post-deploy via
 *      `USDOku.setWrapper`, since the wrapper does not exist yet when USDOku
 *      initializes (deploy order: OkuM, SubscriptionModule, USDOku, USDOkuWrapper).
 */
interface IUSDOkuWrapper {
    /// @notice USDOku's declared liability (`USDOku.totalSupply()`, dollars).
    function declaredLiability() external view returns (uint256);
    /// @notice OkuM held by the wrapper, valued at `M_oku` (dollars, realized).
    function realizedBacking() external view returns (uint256);
    /// @notice Signed gap in basis points: positive = under-backed, negative = surplus.
    function solvencyGapBps() external view returns (int256);
    /// @notice `realizedBacking / declaredLiability`, in basis points.
    function backingRatioBps() external view returns (uint256);
}
