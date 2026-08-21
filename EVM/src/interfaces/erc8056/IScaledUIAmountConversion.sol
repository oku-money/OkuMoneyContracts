// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountConversion
 * @notice ERC-8056 OPTIONAL extension — on-chain conversion helpers.
 * @dev Interface ID: `0x57854fc3` == `toUIAmount(uint256)` ^ `fromUIAmount(uint256)`.
 *
 *      ROUNDING: both directions truncate (floor). They are therefore **not
 *      inverses**: `fromUIAmount(toUIAmount(x))` lies in `[x - 1, x]`.
 *
 *      Integrators computing a "max send" MUST derive the transfer amount from
 *      raw `balanceOf` and the display value from that raw amount. Never compute
 *      `fromUIAmount(displayedBalance)` — see EVM/README.md "The max-send rule".
 */
interface IScaledUIAmountConversion {
    /// @notice Convert a raw token amount to its UI (dollar) amount.
    function toUIAmount(uint256 rawAmount) external view returns (uint256);

    /// @notice Convert a UI (dollar) amount to its raw token amount.
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}
