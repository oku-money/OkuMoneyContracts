// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountNewUIMultiplier
 * @notice ERC-8056 REQUIRED extension — pending multiplier.
 * @dev Interface ID: `0x4bd27648` == `newUIMultiplier()` ^ `effectiveAt()`.
 *
 *      ============ IMPLEMENTATION NOTE (read before integrating) ============
 *
 *      The extension presumes a **step function**: a discrete jump from
 *      `uiMultiplier()` to `newUIMultiplier()` at `effectiveAt()`. `M_oku` is
 *      genuinely stepwise, so the fit is native — with one deliberate
 *      narrowing: **steps are immediate**. A future-dated step would mature
 *      with no transaction, recreating the unfenceable-revaluation problem the
 *      post-step sync window exists to close (nothing can auto-arm at
 *      maturity). So on this token:
 *
 *        - `newUIMultiplier()` -> the value of the last step (== `uiMultiplier()`).
 *        - `effectiveAt()`     -> the timestamp of the last step.
 *
 *      The observable boundary contract is satisfied trivially: once
 *      `block.timestamp >= effectiveAt()`, `uiMultiplier() == newUIMultiplier()`
 *      — which here is always. This also sidesteps the reference
 *      implementation's documented `>=`/`>` defect at
 *      `block.timestamp == effectiveAt()`: there is never a matured-but-
 *      uncrystallized pending value.
 *
 *      See EVM/README.md "ERC-8056 on OkuM".
 */
interface IScaledUIAmountNewUIMultiplier {
    /// @notice Pending UI multiplier scheduled to obtain at `effectiveAt`, 18 decimals.
    function newUIMultiplier() external view returns (uint256);

    /// @notice Timestamp at which the pending multiplier becomes effective.
    function effectiveAt() external view returns (uint256);
}
