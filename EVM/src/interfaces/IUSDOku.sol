// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IUSDOku
 * @notice Consumer-facing surface of the USDOku rebasing dollar token.
 * @dev `balanceOf` returns dollars (`shares * M_usd / PRECISION`) and moves with
 *      no transfer to observe. `sharesOf` is the invariant ledger quantity — any
 *      integrator that must survive a rebase needs it, and the alternative is
 *      each one reverse-engineering it.
 *
 *      NO ERC-8056 and NO 4626 views, deliberately: `balanceOf` is already
 *      dollar-denominated, so a UI multiplier on top would be a second scaling
 *      factor over an already-scaled balance, and an 8056-aware wallet would
 *      apply it twice. `supportsInterface(0xa60bf13d)` returns false, asserted
 *      in the invariant suite.
 */
interface IUSDOku is IERC20 {
    // ============ Rebasing ledger ============

    /// @notice The invariant share count backing `account`'s rebasing balance.
    function sharesOf(address account) external view returns (uint256);

    /// @notice Total shares outstanding. `totalSupply() == totalShares * M_usd / 1e18`.
    function totalShares() external view returns (uint256);

    /// @notice `M_usd` — the continuous rebase index. Monotone; NOT a conversion rate.
    function usdOkuIndex() external view returns (uint256);

    // ============ Supply hooks (role-gated, wrapper-only) ============

    /// @notice Mint `usdOkuAmount` dollars of USDOku to `to`. Requires `OKU_MINTER`.
    /// @return sharesMinted Shares actually credited (floors at `M_usd`).
    function mint(address to, uint256 usdOkuAmount) external returns (uint256 sharesMinted);

    /// @notice Burn `shares` from the caller's share balance. Requires `OKU_BURNER`.
    /// @dev Share-denominated so the unwrap path can burn exactly what a
    ///      dollar-denominated `transferFrom` delivered, leaving no dust.
    function burnShares(uint256 shares) external;
}
