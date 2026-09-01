// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IOkuMoney
 * @notice Shared interface for OkuMoney used by LitePSM, OkuDollar, and the
 *         test mocks/handlers.
 * @dev OkuMoney is a non-rebasing standard ERC-20; `okuMMultiplier()` tracks the dollar
 *      value per token separately from `balanceOf()` and accrues continuously over
 *      yield epochs. Extends `IERC20` so static
 *      analyzers can match the inherited ERC-20 surface against the OkuMoney
 *      implementation without a custom resolver. The OkuMoney-specific surface
 *      (mint/burn, multiplier ops) is declared explicitly below.
 *      Production call sites that need ERC-20 transfer semantics should still cast
 *      via `IERC20` to use SafeERC20. See Constants.sol for terminology legend.
 */
interface IOkuMoney is IERC20 {
    /// @notice Mint raw tokens to `to`.
    function mint(address to, uint256 amount) external;
    /// @notice Burn raw tokens from the caller's balance.
    function burn(uint256 amount) external;
    /// @notice Current OkuM multiplier (dollar value per token, 1e18 = $1.00).
    /// @dev Derived from the active yield epoch — advances every second while an
    ///      epoch is live. Monotonically non-decreasing.
    function okuMMultiplier() external view returns (uint256);
    /// @notice OkuM multiplier at an arbitrary timestamp.
    /// @dev Pure function of time; lets consumers project solvency forward.
    function okuMMultiplierAt(uint256 t) external view returns (uint256);
    /// @notice Begin streaming realized dollar yield over `duration` seconds.
    function startYieldEpoch(uint256 yieldAmount, uint256 duration) external;
    /// @notice Timestamp at which accrual stops absent a new epoch.
    function yieldEpochEndsAt() external view returns (uint256);
}
