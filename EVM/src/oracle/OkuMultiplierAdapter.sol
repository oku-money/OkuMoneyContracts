// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {IOkuM} from "../interfaces/IOkuM.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";

/**
 * @title OkuMultiplierAdapter
 * @notice Chainlink `AggregatorV3Interface`-compatible read of
 *         `OkuM.uiMultiplier()`, with bounds and staleness.
 *
 * @dev WHY THIS EXISTS. Lending markets will price collateral off the multiplier
 *      whether or not we give them a safe way to do it. Hand-rolled integrations
 *      reach for `uiMultiplier()` raw, with no bound and no liveness signal.
 *      Shipping this adapter alongside the token is cheaper than auditing five
 *      different versions of it written by other people.
 *
 *      THERE IS NO ADAPTER FOR `M_usd`, DELIBERATELY. `M_usd` is a declared
 *      payout rate, not a value a lending market should price collateral
 *      against. Nothing should be borrowed against USDOku at its rebased
 *      balance while the solvency gap is nonzero.
 *
 *      NOTE THE ASYMMETRY, and hand it to your auditor: the protocol has no
 *      oracle on its *input* side (USDC peg monitoring is off-chain) and adds
 *      one on its *output* side. This contract makes the system a price
 *      PUBLISHER. `totalAssets()` on the token is derived from the multiplier
 *      rather than measured, so there is no on-chain referent to cross-check
 *      against; the feed is exactly as trustworthy as the multiplier authority.
 *
 *      GUARDS:
 *        - `[minAnswer, maxAnswer]` bounds, set at construction, immutable.
 *        - Staleness: reverts once the last step (`effectiveAt()`) is further in
 *          the past than `stalenessThreshold`. A lapsed mark leaves the
 *          multiplier flat and truthful for a while, but a consumer should not
 *          keep pricing off it indefinitely.
 *        - `isHealthy()` for consumers that prefer to branch rather than revert.
 *
 *      Answers are reported with 18 decimals to match the multiplier exactly. Do
 *      NOT assume Chainlink's usual 8.
 */
contract OkuMultiplierAdapter {
    // ============ Immutables ============

    /// @notice The token whose multiplier this feed publishes.
    IOkuM public immutable token;
    /// @notice Lower bound on a reportable answer.
    uint256 public immutable minAnswer;
    /// @notice Upper bound on a reportable answer.
    uint256 public immutable maxAnswer;
    /// @notice Seconds past the last step after which the feed is considered stale.
    uint256 public immutable stalenessThreshold;

    // ============ Errors ============

    error AnswerOutOfBounds(uint256 answer, uint256 min, uint256 max);
    error StaleAnswer(uint256 lastSteppedAt, uint256 threshold);
    error InvalidBounds();
    error NoDataPresent();

    constructor(
        address _token,
        uint256 _minAnswer,
        uint256 _maxAnswer,
        uint256 _stalenessThreshold
    ) {
        if (_token == address(0)) revert Errors.ZeroAddress();
        if (_minAnswer == 0 || _minAnswer >= _maxAnswer) revert InvalidBounds();
        if (_maxAnswer > Constants.MAX_MULTIPLIER) revert InvalidBounds();
        if (_stalenessThreshold == 0) revert InvalidBounds();

        token = IOkuM(_token);
        minAnswer = _minAnswer;
        maxAnswer = _maxAnswer;
        stalenessThreshold = _stalenessThreshold;
    }

    // ============ AggregatorV3Interface ============

    /// @notice 18, matching the multiplier. NOT Chainlink's conventional 8.
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function description() external pure returns (string memory) {
        return "OkuM uiMultiplier / USD";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice Latest multiplier, bounds- and staleness-checked.
    /// @return roundId Monotonic pseudo-round: the timestamp of the read.
    /// @return answer The multiplier, 18 decimals.
    /// @return startedAt Timestamp of the last step.
    /// @return updatedAt Same as `startedAt` — the multiplier is stepwise, so
    ///         the last step IS the last update. Consumers running their own
    ///         staleness checks against `updatedAt` get the honest figure.
    /// @return answeredInRound Equal to `roundId`.
    function latestRoundData()
        public
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        uint256 multiplier = token.uiMultiplier();
        if (multiplier < minAnswer || multiplier > maxAnswer) {
            revert AnswerOutOfBounds(multiplier, minAnswer, maxAnswer);
        }

        uint256 lastStep = IScaledUIAmountNewUIMultiplier(address(token)).effectiveAt();
        if (block.timestamp > lastStep && block.timestamp - lastStep > stalenessThreshold) {
            revert StaleAnswer(lastStep, stalenessThreshold);
        }

        roundId = uint80(block.timestamp);
        // Casting to int256 is safe: `multiplier` was just bounds-checked against
        // `maxAnswer`, and the constructor rejects a `maxAnswer` above
        // `Constants.MAX_MULTIPLIER` (1e24), which is ~57 orders of magnitude
        // below `type(int256).max`. The value can never be negative when
        // reinterpreted.
        // forge-lint: disable-next-line(unsafe-typecast)
        answer = int256(multiplier);
        startedAt = lastStep;
        updatedAt = lastStep;
        answeredInRound = roundId;
    }

    /// @notice Historical rounds are not retained — this is a live derivation, not
    ///         a push feed. Always reverts, per Chainlink's `NoDataPresent` idiom.
    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NoDataPresent();
    }

    // ============ Non-reverting surface ============

    /// @notice Whether `latestRoundData()` would succeed right now.
    /// @dev For consumers that would rather branch than catch a revert. A lending
    ///      market should gate new borrows on this rather than assuming liveness.
    function isHealthy() external view returns (bool) {
        uint256 multiplier = token.uiMultiplier();
        if (multiplier < minAnswer || multiplier > maxAnswer) return false;
        uint256 lastStep = IScaledUIAmountNewUIMultiplier(address(token)).effectiveAt();
        if (block.timestamp > lastStep && block.timestamp - lastStep > stalenessThreshold) {
            return false;
        }
        return true;
    }

    // ============ Post-step sync window ============
    //
    // Surfaced so a consumer can see that the module is refusing to transact
    // against the price this adapter is publishing.
    //
    // DELIBERATELY NOT FOLDED INTO `isHealthy()`. The multiplier is genuinely
    // correct during a window — the step that armed it has already landed here;
    // the window holds this chain still while the peer catches up. Reporting
    // unhealthy would trigger needless liquidation pauses on an accurate feed.
    // The asymmetry worth knowing about is narrower than "bad price": for at
    // most `MAX_SYNC_WINDOW`, a position valued off this feed cannot be unwound
    // through the module. Consumers who care can branch on it; the rest are no
    // worse off than before.

    /// @notice True while the post-step sync window is engaged, during which
    ///         `SubscriptionModule` mint/redeem revert.
    /// @dev Bounded and auto-expiring by construction, so treat a `true` here as
    ///      transient (retry) rather than as an outage.
    function isSyncLocked() external view returns (bool) {
        return token.isSyncLocked();
    }

    /// @notice Exclusive timestamp at which the current sync window lifts.
    ///         `0` when none has ever been armed.
    function syncLockedUntil() external view returns (uint256) {
        return token.syncLockedUntil();
    }
}
