// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IOkuMoney
 * @notice Shared interface for OkuMoney used by LitePSM, RedemptionQueue, OkuDollar,
 *         and the test mocks/handlers.
 * @dev OkuMoney is a non-rebasing standard ERC-20; `okuMMultiplier()` tracks the dollar
 *      value per token separately from `balanceOf()`. Extends `IERC20` so static
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
    /// @dev Computed continuously from the rate schedule; not a stored value.
    function okuMMultiplier() external view returns (uint256);
    /// @notice Set the active yield rate, re-anchoring the accrual base.
    function setOkuMYieldRate(uint256 newRate, uint256 endTimestamp) external;
    /// @notice Pre-stage the successor rate that activates after the active rate's end.
    function setNextOkuMYieldRate(uint256 newRate) external;
    /// @notice Active per-second accrual rate (1e18 = no yield).
    function okuMRatePerSecond() external view returns (uint256);
    /// @notice Timestamp the active rate expires (0 = open-ended).
    function okuMRateEnd() external view returns (uint256);
    /// @notice Successor rate, active after {okuMRateEnd} (1e18 = none armed).
    function okuMPendingRatePerSecond() external view returns (uint256);
    /// @notice Emergency discrete override — re-anchors the accrual base.
    function setOkuMMultiplier(uint256 newMultiplier) external;
    /// @notice Block number of the last discrete override (for sandwich-attack prevention).
    function lastYieldDistributionBlock() external view returns (uint256);
}
