// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IScaledUIAmount} from "./erc8056/IScaledUIAmount.sol";
import {IScaledUIAmountNewUIMultiplier} from "./erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "./erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "./erc8056/IScaledUIAmountBalances.sol";

/**
 * @title IOkuM
 * @notice Shared interface for OkuM used by SubscriptionModule, USDOkuWrapper,
 *         OkuMultiplierAdapter, and test scaffolding.
 * @dev IERC20 + the four ERC-8056 interfaces + the 4626-shaped value layer +
 *      role-gated supply hooks. Does NOT extend IERC4626 or IERC7540 — OkuM does
 *      not claim either (see `EVM/README.md § Token surfaces / OkuM`).
 */
interface IOkuM is
    IERC20,
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    IScaledUIAmountConversion,
    IScaledUIAmountBalances
{
    /// @notice Mint raw tokens to `to`.
    function mint(address to, uint256 amount) external;
    /// @notice Burn raw tokens from the caller's balance.
    function burn(uint256 amount) external;
    /// @notice The backing asset (USDC). Single source of truth for the decimal binding.
    function asset() external view returns (address);
    /// @notice `10**(18 - usdcDecimals)`, derived once at `initialize`.
    function usdcDecimalMultiplier() external view returns (uint256);
    /// @notice Total value of outstanding OkuM, in the asset's native decimals.
    function totalAssets() external view returns (uint256);
    /// @notice `shares` of OkuM valued in the asset's native decimals (floor).
    function convertToAssets(uint256 shares) external view returns (uint256);
    /// @notice `assets` (asset decimals) converted to OkuM raw shares (floor).
    function convertToShares(uint256 assets) external view returns (uint256);
    /// @notice Whether `account` is on the blacklist.
    function isBlacklisted(address account) external view returns (bool);
}
