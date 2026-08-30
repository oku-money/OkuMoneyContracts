// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountBalances
 * @notice Optional ERC-8056 extension exposing on-chain UI-adjusted balance queries.
 * @dev Interface ID `0xd890fd71`, pinned in `Constants.IID_SCALED_UI_AMOUNT_BALANCES`.
 */
interface IScaledUIAmountBalances {
    /// @notice UI-adjusted (dollar) balance of `account`.
    function balanceOfUI(address account) external view returns (uint256);

    /// @notice UI-adjusted (dollar) total supply.
    function totalSupplyUI() external view returns (uint256);
}
