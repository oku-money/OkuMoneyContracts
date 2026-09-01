// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmount
 * @notice Core interface of ERC-8056 (Scaled UI Amount Extension for ERC-20 Tokens).
 * @dev Draft EIP, created 2025-10-20: https://eips.ethereum.org/EIPS/eip-8056
 *      Interface ID `0xa60bf13d`, pinned in `Constants.IID_SCALED_UI_AMOUNT` — never
 *      inline the literal so a spec revision is a one-line change. A real interface
 *      (rather than a literal) so `type(IScaledUIAmount).interfaceId` can be asserted
 *      against the published ID in tests.
 */
interface IScaledUIAmount {
    /// @notice Emitted when the UI multiplier is updated.
    event UIMultiplierUpdated(
        uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp
    );

    /// @notice OPTIONAL per the spec: emitted on a transfer with the UI-adjusted
    ///         amount. OkuMoney does NOT emit this — it emits the equivalent
    ///         `OkuMoneyEvents.TransferValue(from, to, amount, dollarValue)`, which
    ///         carries identical information and predates this standard. Declared
    ///         here only for interface-ID completeness; the event is optional and
    ///         its absence does not affect conformance.
    event TransferWithUIAmount(
        address indexed from, address indexed to, uint256 amount, uint256 uiAmount
    );

    /// @notice Current UI multiplier. 18 decimals (1e18 = 1.0).
    function uiMultiplier() external view returns (uint256);
}
