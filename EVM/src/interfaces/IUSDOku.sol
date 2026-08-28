// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IUSDOku
 * @notice Interface for USDOku, the rebasing $1-denominated wrapper over OkuM.
 * @dev `mint`/`burn` are privileged and take an explicit target — unlike
 *      `OkuM.burn` (self-only), USDOku's sole supply-change caller is
 *      `USDOkuWrapper`, acting on a user's behalf without a prior transfer step.
 *      Both are denominated in USDOku's internal `shares`, not dollars — the
 *      caller (the wrapper) is responsible for the dollar<->share conversion via
 *      {usdOkuIndex}.
 */
interface IUSDOku is IERC20 {
    /// @notice Credit `shares` internal shares to `to`.
    function mint(address to, uint256 shares) external;
    /// @notice Debit `shares` internal shares from `from`.
    function burn(address from, uint256 shares) external;
    /// @notice The continuous rebase index (`M_usd`). NOT a conversion rate.
    function usdOkuIndex() external view returns (uint256);
    /// @notice The index the live rate segment will have reached at `rateEnd`.
    /// @dev Used by `USDOkuWrapper.wrap` to ensure newly minted shares are also
    ///      pre-funded for the remainder of the segment.
    function projectedIndexAtRateEnd() external view returns (uint256);
    /// @notice Internal share balance for `account`.
    function sharesOf(address account) external view returns (uint256);
    /// @notice Total internal shares across all holders.
    function totalShares() external view returns (uint256);
}
