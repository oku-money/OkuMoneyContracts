// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IOkuMoney
 * @notice Shared OkuMoney interface used by LitePSM, OkuDollar and the test mocks.
 * @dev Extends `IERC20`; call sites needing transfer semantics should still cast via
 *      `IERC20` to use SafeERC20. See Constants.sol for the terminology legend.
 */
interface IOkuMoney is IERC20 {
    /// @notice Mint raw tokens to `to`.
    function mint(address to, uint256 amount) external;
    /// @notice Burn raw tokens from the caller's balance.
    function burn(uint256 amount) external;
    /// @notice Whether `account` is blacklisted on OkuMoney.
    function isBlacklisted(address account) external view returns (bool);
    /// @notice Current OkuM multiplier (dollar value per token, 1e18 = $1.00).
    /// @dev Computed continuously from the rate schedule; not a stored value.
    function okuMMultiplier() external view returns (uint256);
    /// @notice Set the active yield rate, re-anchoring the accrual base.
    /// @param newRate      Per-second rate, 1e18-scaled; 1e18 halts accrual.
    /// @param endTimestamp When the rate expires; must be 0 when halting, future otherwise.
    function setOkuMYieldRate(uint256 newRate, uint256 endTimestamp) external;
    /// @notice Pre-stage the successor rate that activates after the active rate's end.
    /// @param pendingEndTimestamp When the successor itself expires.
    function setNextOkuMYieldRate(uint256 newRate, uint256 pendingEndTimestamp) external;
    /// @notice Atomically re-anchor the active rate AND stage its successor.
    function setOkuMYieldRateWithSuccessor(
        uint256 newRate,
        uint256 endTimestamp,
        uint256 nextRate,
        uint256 nextEndTimestamp
    )
        external;
    /// @notice The schedule's stored active-window rate (1e18 = no yield); not rolled forward.
    function okuMRatePerSecond() external view returns (uint256);
    /// @notice The per-second rate actually accruing right now.
    function okuMEffectiveRatePerSecond() external view returns (uint256);
    /// @notice Timestamp the active rate expires (0 = accrual halted).
    function okuMRateEnd() external view returns (uint256);
    /// @notice Successor rate, active after {okuMRateEnd} (1e18 = none armed).
    function okuMPendingRatePerSecond() external view returns (uint256);
    /// @notice Emergency discrete override — re-anchors the accrual base.
    function setOkuMMultiplier(uint256 newMultiplier) external;
    /// @notice Block of the last discrete override (the override-block stamp).
    function lastYieldDistributionBlock() external view returns (uint256);
}
