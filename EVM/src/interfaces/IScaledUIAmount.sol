// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmount (ERC-8056 core)
 * @notice Scaled UI Amount Extension for ERC-20 Tokens.
 * @dev See https://eips.ethereum.org/EIPS/eip-8056. The draft may change before Final.
 *
 *      OkuMoney implements this as a derived view: `uiMultiplier()` returns
 *      `okuMMultiplier()`, computed continuously via {MathLib.computeMultiplier}. Deviations
 *      from the EIP's reference implementation (a stored multiplier rotated on a schedule):
 *
 *      - `UIMultiplierUpdated` fires only on the discrete re-anchors (`setOkuMYieldRate`,
 *        `setOkuMMultiplier`), not "whenever the multiplier changes" (every second).
 *        Staging a successor via `setNextOkuMYieldRate` emits `NextOkuMYieldRateSet`
 *        instead; replacing an armed one emits `UIMultiplierUpdateCancelled`.
 *      - `newUIMultiplier()` / `effectiveAt()` presume a scheduled *value*; OkuMoney
 *        schedules a *rate*. They report the multiplier projected at the active rate's end
 *        ONLY when a successor is armed; otherwise `effectiveAt()` is `0` and
 *        `newUIMultiplier()` is the current `uiMultiplier()`.
 *
 *      Interface ID: 0xa60bf13d
 */
interface IScaledUIAmount {
    /// @notice Emitted when the UI multiplier schedule is updated.
    event UIMultiplierUpdated(
        uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp
    );

    /// @notice Emitted when a scheduled UI multiplier update is cancelled or superseded.
    event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt);

    /// @notice Current UI multiplier, 18 decimals (1e18 = 1.0).
    function uiMultiplier() external view returns (uint256);
}

/**
 * @title IScaledUIAmountNewUIMultiplier (ERC-8056 required extension)
 * @dev Interface ID: 0x4bd27648
 */
interface IScaledUIAmountNewUIMultiplier {
    /// @notice Pending UI multiplier scheduled to take effect at {effectiveAt}, 18 decimals.
    function newUIMultiplier() external view returns (uint256);

    /// @notice Timestamp at which the pending multiplier becomes effective.
    function effectiveAt() external view returns (uint256);
}

/**
 * @title IScaledUIAmountConversion (ERC-8056 optional extension)
 * @dev Interface ID: 0x57854fc3
 */
interface IScaledUIAmountConversion {
    /// @notice Convert a raw token amount to its UI amount.
    function toUIAmount(uint256 rawAmount) external view returns (uint256);

    /// @notice Convert a UI amount to its raw token amount.
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}

/**
 * @title IScaledUIAmountBalances (ERC-8056 optional extension)
 * @dev Interface ID: 0xd890fd71
 */
interface IScaledUIAmountBalances {
    /// @notice UI-adjusted balance of `account`.
    function balanceOfUI(address account) external view returns (uint256);

    /// @notice UI-adjusted total supply.
    function totalSupplyUI() external view returns (uint256);
}
