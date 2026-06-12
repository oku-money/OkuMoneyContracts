// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IOracleRelay
 * @notice Consumer interface for the OkuMoney USDC peg circuit-breaker.
 * @dev Implementations wrap a USDC/USD price feed (e.g. Chainlink AggregatorV3),
 *      validate round completeness + staleness + in-band price, and normalize the
 *      answer to 1e18 precision. Production consumers (LitePSM, RedemptionQueue)
 *      call `checkUsdcPeg()` to revert when USDC is unhealthy or off-peg.
 */
interface IOracleRelay {
    /// @notice Revert if USDC is currently depegged or oracle data is unhealthy.
    /// @dev View function. Wraps `getUsdcPrice()` and discards the return value.
    function checkUsdcPeg() external view;

    /// @notice Current USDC/USD price normalized to 1e18.
    /// @dev Reverts on the same conditions as `checkUsdcPeg`: incomplete round,
    ///      malformed timestamps, stale data, non-positive answer, or
    ///      price outside the configured `[minPriceE18, maxPriceE18]` band.
    /// @return priceE18 Normalized USDC/USD price scaled to 1e18 (e.g. 1e18 == $1.00).
    function getUsdcPrice() external view returns (uint256 priceE18);
}
