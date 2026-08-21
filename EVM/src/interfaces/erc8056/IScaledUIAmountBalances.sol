// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountBalances
 * @notice ERC-8056 OPTIONAL extension — on-chain UI balance queries.
 * @dev Interface ID: `0xd890fd71` == `balanceOfUI(address)` ^ `totalSupplyUI()`.
 *
 *      Each balance is floored independently, so
 *      `sum(balanceOfUI(holder)) <= totalSupplyUI()`, with a gap bounded by the
 *      holder count (at most 1 wei per holder). Do not assert equality.
 */
interface IScaledUIAmountBalances {
    /// @notice UI-adjusted (dollar) balance of `account`.
    function balanceOfUI(address account) external view returns (uint256);

    /// @notice UI-adjusted (dollar) total supply.
    function totalSupplyUI() external view returns (uint256);
}
