// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmount (ERC-8056 core)
 * @notice Scaled UI Amount Extension for ERC-20 Tokens.
 * @dev See https://eips.ethereum.org/EIPS/eip-8056
 *
 *      STATUS: ERC-8056 is a **Draft** standard at time of writing. The interface
 *      IDs below are taken from the current draft and MAY change before Final.
 *
 *      OkuMoney implements this as a *derived view* over its streaming yield
 *      schedule: `uiMultiplier()` returns `okuMMultiplier()`, which is computed
 *      continuously via {MathLib.computeMultiplier}. This is a deliberate
 *      deviation in spirit from the EIP's reference implementation, which stores
 *      a discrete multiplier and rotates it on a schedule:
 *
 *      - The EIP requires `UIMultiplierUpdated` be emitted "whenever the
 *        multiplier is changed". Under continuous accrual the multiplier changes
 *        every second, so a per-change event is not satisfiable. OkuMoney emits
 *        it on **rate-schedule changes** instead, which are the only discrete
 *        events in the system.
 *      - `newUIMultiplier()` / `effectiveAt()` presume a scheduled *value*.
 *        OkuMoney schedules a pending *rate*, so `newUIMultiplier()` returns the
 *        multiplier projected to be in effect at `effectiveAt()` (= the active
 *        rate's end timestamp) — but ONLY when a successor rate is actually
 *        armed. If no successor is staged (or the active window has no bound,
 *        i.e. accrual is halted), `effectiveAt()` returns `0` and
 *        `newUIMultiplier()` returns the current `uiMultiplier()` — "nothing
 *        scheduled", not a fabricated projection of the current rate's own
 *        natural continuation.
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
