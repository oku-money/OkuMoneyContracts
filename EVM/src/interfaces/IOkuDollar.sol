// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuDollar
 * @notice Interface for the OkuDollar vault (rebasing stablecoin backed by OkuMoney reserves).
 * @dev Exposes the full mint / redeem / view surface so tests, handlers, and invariant
 *      runners can program against a single interface. Production call sites in the PSM
 *      and router only invoke `wrap` and `unwrap`; the read-only views are kept here for
 *      off-chain consumers and test scaffolding.
 */
interface IOkuDollar {
    function wrap(
        uint256 okuMAmount,
        address receiver,
        uint256 minAmountOut
    )
        external
        returns (uint256 usdMinted);
    function unwrap(uint256 usdAmount, address receiver) external returns (uint256 okuMReturned);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function usdMultiplier() external view returns (uint256);
    function usdSharesOf(address account) external view returns (uint256);
    function totalUsdShares() external view returns (uint256);
    function totalOkuMReserves() external view returns (uint256);
    function totalUsdObligations() external view returns (uint256);
    function collateralizationRatio() external view returns (uint256);
    function surplus() external view returns (uint256);
}
