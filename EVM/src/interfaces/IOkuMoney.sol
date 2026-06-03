// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuMoney
 * @notice Shared interface for OkuMoney used by LitePSM, RedemptionQueue, OkuDollar,
 *         and the test mocks/handlers.
 * @dev OkuMoney is a non-rebasing standard ERC-20; `okuMMultiplier()` tracks the dollar
 *      value per token separately from `balanceOf()`. The full surface (mint/burn,
 *      ERC-20 reads, multiplier ops) is intentionally exposed so tests, mocks, and
 *      handlers can program against a single type. Production call sites that need
 *      ERC-20 transfer semantics should still cast via `IERC20` to use SafeERC20.
 *      See Constants.sol for terminology legend.
 */
interface IOkuMoney {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function okuMMultiplier() external view returns (uint256);
    function setOkuMMultiplier(uint256 newMultiplier) external;
    function distributeYield(uint256 yieldAmount) external;
    /// @notice Block number of last yield distribution (for sandwich-attack prevention)
    function lastYieldDistributionBlock() external view returns (uint256);
}
