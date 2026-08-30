// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IUSDOku
 * @notice Oku Dollar: a rebasing presentation layer over OkuM.
 * @dev `usdOkuIndex()` (`M_usd`) is USDOku's share -> dollar ledger index and NOTHING
 *      else. It does not participate in the OkuM <-> USDOku exchange rate: it cancels
 *      algebraically out of `wrap` and does not appear in `unwrap` at all. Both
 *      directions convert at OkuM's `uiMultiplier()`.
 */
interface IUSDOku is IERC20 {
    /// @notice Internal share balance, immune to rebases.
    /// @dev Integrators MUST compute a max-send from this, never from `balanceOf`,
    ///      which moves between the read and the transaction.
    function sharesOf(address account) external view returns (uint256);

    /// @notice Total shares outstanding.
    function totalShares() external view returns (uint256);

    /// @notice `M_usd` — the current share -> dollar index.
    function usdOkuIndex() external view returns (uint256);

    /// @notice `M_usd` as it will stand when the live rate segment ends.
    /// @dev The forward figure the pre-funding invariant is enforced against.
    function projectedIndexAtRateEnd() external view returns (uint256);

    /// @notice Mint shares. Vault-internal; role-gated.
    function mint(address to, uint256 shares) external;

    /// @notice Burn shares. Vault-internal; role-gated.
    function burn(address from, uint256 shares) external;
}
