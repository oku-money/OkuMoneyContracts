// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountNewUIMultiplier
 * @notice ERC-8056 REQUIRED extension — pending multiplier.
 * @dev Interface ID: `0x4bd27648` == `newUIMultiplier()` ^ `effectiveAt()`.
 *
 *      ============ IMPLEMENTATION NOTE (read before integrating) ============
 *
 *      The ERC-8056 reference implementation presumes a **step function**: a
 *      discrete jump from `uiMultiplier()` to `newUIMultiplier()` at
 *      `effectiveAt()`. OkuDollar accrues **continuously** from a stored
 *      per-second rate, so it maps this pair onto the rate segment instead:
 *
 *        - `effectiveAt()`      -> `rateEnd`, the timestamp at which accrual halts.
 *        - `newUIMultiplier()`  -> the multiplier the trajectory reaches at
 *                                  `rateEnd`, i.e. where growth stops absent a
 *                                  renewed rate.
 *
 *      The reference implementation's observable contract is nonetheless
 *      satisfied exactly: once `block.timestamp >= effectiveAt()`,
 *      `uiMultiplier() == newUIMultiplier()`, because `uiMultiplier()` clamps
 *      its elapsed-time term at `rateEnd`.
 *
 *      The divergence is in *intent*, not in the boundary behaviour: our pending
 *      value is where a continuous trajectory terminates rather than a
 *      discontinuous jump. There is therefore no step to front-run.
 *
 *      See EVM/README.md "ERC-8056's pending-multiplier extension".
 */
interface IScaledUIAmountNewUIMultiplier {
    /// @notice Pending UI multiplier scheduled to obtain at `effectiveAt`, 18 decimals.
    function newUIMultiplier() external view returns (uint256);

    /// @notice Timestamp at which the pending multiplier becomes effective.
    function effectiveAt() external view returns (uint256);
}
