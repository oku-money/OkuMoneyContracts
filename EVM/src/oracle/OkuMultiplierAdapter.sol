// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOkuM} from "../interfaces/IOkuM.sol";

/**
 * @title OkuMultiplierAdapter
 * @notice Chainlink `AggregatorV3Interface`-compatible read of `OkuM.uiMultiplier()`.
 * @dev Immutable and non-upgradeable: `minAnswer`, `maxAnswer`, `stalenessThreshold`
 *      are constructor args. Changing bounds means deploying a new adapter and
 *      re-pointing consumers — the correct blast radius for a price feed.
 *
 *      18 decimals, NOT Chainlink's usual 8 — an integrator assuming the usual
 *      convention misprices by `1e10`.
 *
 *      There is deliberately no adapter for `M_usd`: it is a declared payout
 *      rate, not a value a lending market should price collateral against.
 *      Nothing should be borrowed against USDOku while the solvency gap is
 *      nonzero.
 *
 *      `getRoundData` always reverts — this is a live derivation from OkuM's
 *      current state, not a push feed with history.
 */
contract OkuMultiplierAdapter {
    IOkuM public immutable OKU_M;
    int256 public immutable MIN_ANSWER;
    int256 public immutable MAX_ANSWER;
    uint256 public immutable STALENESS_THRESHOLD;

    error ZeroAddress();
    error InvalidBounds();
    error NoDataPresent();

    constructor(address okuM_, int256 minAnswer_, int256 maxAnswer_, uint256 stalenessThreshold_) {
        if (okuM_ == address(0)) revert ZeroAddress();
        if (minAnswer_ >= maxAnswer_) revert InvalidBounds();
        OKU_M = IOkuM(okuM_);
        MIN_ANSWER = minAnswer_;
        MAX_ANSWER = maxAnswer_;
        STALENESS_THRESHOLD = stalenessThreshold_;
    }

    /// @notice Adapter decimals. 18, NOT Chainlink's usual 8 — see contract NatSpec.
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function description() external pure returns (string memory) {
        return "OkuM / USD (uiMultiplier adapter)";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice Chainlink-shaped read of the live `uiMultiplier()`.
    /// @dev `roundId`/`answeredInRound` are both `1` — there is no round history.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        answer = int256(OKU_M.uiMultiplier());
        // `effectiveAt()` is the timestamp of the live value's most recent step —
        // once past it, `uiMultiplier() == newUIMultiplier()` (see
        // ScaledUIAmountUpgradeable), so it doubles as "last updated".
        updatedAt = OKU_M.effectiveAt();
        startedAt = updatedAt;
        roundId = 1;
        answeredInRound = 1;
    }

    /// @notice Always reverts — this is a live derivation, not a push feed with history.
    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NoDataPresent();
    }

    /// @notice Whether the live multiplier sits within `[MIN_ANSWER, MAX_ANSWER]` and is fresh.
    function isHealthy() external view returns (bool) {
        int256 answer = int256(OKU_M.uiMultiplier());
        if (answer < MIN_ANSWER || answer > MAX_ANSWER) return false;
        return !isAccrualStopped();
    }

    /// @notice Whether the last step is older than `STALENESS_THRESHOLD`.
    /// @dev A lapsed mark leaves the multiplier flat and truthful — this does not
    ///      mean the value is wrong, only that a consumer should not price off it
    ///      indefinitely without checking freshness.
    function isAccrualStopped() public view returns (bool) {
        uint256 lastStep = OKU_M.effectiveAt();
        return block.timestamp - lastStep > STALENESS_THRESHOLD;
    }
}
