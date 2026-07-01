// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IOracleRelay} from "./IOracleRelay.sol";
import {Roles} from "../lib/Roles.sol";
import {Constants} from "../lib/Constants.sol";
import {Errors} from "../lib/Errors.sol";
import {OracleRelayEvents} from "../lib/events/OracleRelayEvents.sol";

/**
 * @title OracleRelay
 * @notice USDC peg circuit-breaker. Wraps a Chainlink-compatible USDC/USD aggregator,
 *         validates round completeness + freshness + in-band price, and normalizes the
 *         raw answer to 1e18 precision for downstream consumers (LitePSM, RedemptionQueue).
 * @dev    The relay is intentionally tightly scoped to the USDC/USD price-feed case.
 *         Production consumers call `checkUsdcPeg()` to revert when USDC is depegged
 *         or the oracle is unhealthy; off-chain monitoring calls `getUsdcPrice()` to
 *         read the normalized price directly.
 *
 *         The Chainlink read-safety checks (answeredInRound, updatedAt, startedAt,
 *         staleness threshold, positive answer) mirror the previous in-PSM check that
 *         this relay replaces, hardened by the canonical pattern from MakerDAO and
 *         Chainlink reference integrations.
 *
 *         The peg band (`minPriceE18`, `maxPriceE18`) is bounded by hard floor/ceiling
 *         constants (`ORACLE_USDC_PRICE_FLOOR`, `ORACLE_USDC_PRICE_CEILING`) so a
 *         compromised `RELAY_CONFIG_MANAGER` key cannot silently widen the band into
 *         a region that accepts catastrophic depegs.
 *
 *         Storage uses the ERC-7201 namespaced storage pattern for upgrade safety.
 *         See https://eips.ethereum.org/EIPS/eip-7201
 *         See {OkuMoney.initialize} for the unified role-grant policy.
 */
contract OracleRelay is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    OracleRelayEvents,
    IOracleRelay
{
    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:okumoney.storage.OracleRelay
    struct OracleRelayStorage {
        IAggregatorV3 priceFeed;
        uint256 stalenessThreshold;
        uint256 minPriceE18;
        uint256 maxPriceE18;
        uint8 feedDecimals;
    }

    // keccak256(abi.encode(uint256(keccak256("okumoney.storage.OracleRelay")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ORACLE_RELAY_STORAGE_LOCATION =
        0xa64dc72924ede57d47af7a7140d826cef88265982b3e0e07e8d3cad8d3ee9a00;

    function _getOracleRelayStorage() private pure returns (OracleRelayStorage storage $) {
        assembly {
            $.slot := ORACLE_RELAY_STORAGE_LOCATION
        }
    }

    // ============ Custom Errors ============

    // Common errors (ZeroAddress) live in lib/Errors.sol.

    /// @dev Aggregator reports more decimals than supported (> Constants.MAX_FEED_DECIMALS).
    error FeedDecimalsTooLarge(uint8 reported);
    /// @dev Provided staleness threshold is outside the bounded range.
    error InvalidStaleness(uint256 provided, uint256 minAllowed, uint256 maxAllowed);
    /// @dev Provided price band is invalid (min >= max, or outside the hard floor/ceiling).
    error InvalidPriceBand(uint256 minE18, uint256 maxE18);
    /// @dev Chainlink read returned an incomplete round (answeredInRound < roundId).
    error IncompleteOracleRound();
    /// @dev Chainlink read returned `updatedAt == 0` (the round was never
    ///      updated). Split from the broader `InvalidOracleResponse` for
    ///      incident-triage clarity.
    error OracleUpdatedAtZero();
    /// @dev Chainlink read returned malformed `startedAt` (zero or after
    ///      `updatedAt`). Distinct from `OracleUpdatedAtZero` so monitoring
    ///      can tell the two malformation classes apart.
    error OracleStartedAtInvalid();
    /// @dev Chainlink read returned a non-positive answer.
    error NonPositiveAnswer();
    /// @dev Chainlink read is older than the configured staleness threshold.
    error StaleOracleData();
    /// @dev Normalized price falls outside the configured peg band.
    error PriceOutOfBand(uint256 priceE18, uint256 minE18, uint256 maxE18);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the OracleRelay proxy.
    /// @param _priceFeed Chainlink USDC/USD aggregator address (or compatible IAggregatorV3).
    /// @param _stalenessThreshold Seconds after which a Chainlink round is considered stale.
    ///        Bounded by Constants.ORACLE_MIN_STALENESS / Constants.ORACLE_MAX_STALENESS.
    /// @param _minPriceE18 Lower edge of the in-band USDC price (1e18-scaled).
    /// @param _maxPriceE18 Upper edge of the in-band USDC price (1e18-scaled).
    /// @param _admin Admin address (receives the full RELAY_* role set + DEFAULT_ADMIN_ROLE).
    function initialize(
        address _priceFeed,
        uint256 _stalenessThreshold,
        uint256 _minPriceE18,
        uint256 _maxPriceE18,
        address _admin
    )
        public
        initializer
    {
        if (_priceFeed == address(0)) revert Errors.ZeroAddress();
        if (_admin == address(0)) revert Errors.ZeroAddress();
        _validateStaleness(_stalenessThreshold);
        _validatePriceBand(_minPriceE18, _maxPriceE18);

        __AccessControl_init();

        OracleRelayStorage storage $ = _getOracleRelayStorage();
        $.priceFeed = IAggregatorV3(_priceFeed);
        $.stalenessThreshold = _stalenessThreshold;
        $.minPriceE18 = _minPriceE18;
        $.maxPriceE18 = _maxPriceE18;

        uint8 d = _readAndValidateFeedDecimals(_priceFeed);
        $.feedDecimals = d;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(Roles.RELAY_UPGRADER, _admin);
        _grantRole(Roles.RELAY_FEED_MANAGER, _admin);
        _grantRole(Roles.RELAY_CONFIG_MANAGER, _admin);

        emit PriceFeedUpdated(address(0), _priceFeed, d);
        emit StalenessThresholdUpdated(0, _stalenessThreshold);
        emit PriceBandUpdated(0, 0, _minPriceE18, _maxPriceE18);
    }

    // ============ Storage Accessor Views ============

    /// @notice The underlying Chainlink-compatible USDC/USD price feed.
    function priceFeed() external view returns (IAggregatorV3) {
        return _getOracleRelayStorage().priceFeed;
    }

    /// @notice Seconds after which a Chainlink round is considered stale.
    function stalenessThreshold() external view returns (uint256) {
        return _getOracleRelayStorage().stalenessThreshold;
    }

    /// @notice Lower edge of the in-band USDC price (1e18-scaled).
    function minPriceE18() external view returns (uint256) {
        return _getOracleRelayStorage().minPriceE18;
    }

    /// @notice Upper edge of the in-band USDC price (1e18-scaled).
    function maxPriceE18() external view returns (uint256) {
        return _getOracleRelayStorage().maxPriceE18;
    }

    /// @notice Cached decimal count of the underlying price feed.
    function feedDecimals() external view returns (uint8) {
        return _getOracleRelayStorage().feedDecimals;
    }

    // ============ Consumer Surface ============

    /// @inheritdoc IOracleRelay
    function checkUsdcPeg() external view override {
        getUsdcPrice();
    }

    /// @inheritdoc IOracleRelay
    /// @dev Five-step Chainlink read-safety:
    ///        1. answeredInRound < roundId  -> IncompleteOracleRound
    ///        2. updatedAt == 0              -> OracleUpdatedAtZero
    ///        3. startedAt zero or > updatedAt -> OracleStartedAtInvalid
    ///        4. block.timestamp - updatedAt >= stalenessThreshold -> StaleOracleData
    ///        5. answer <= 0                 -> NonPositiveAnswer
    ///      then normalize 1e<feedDecimals> -> 1e18 and enforce the configured band.
    function getUsdcPrice() public view override returns (uint256 priceE18) {
        OracleRelayStorage storage $ = _getOracleRelayStorage();

        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = $.priceFeed.latestRoundData();

        if (answeredInRound < roundId) revert IncompleteOracleRound();
        if (updatedAt == 0) revert OracleUpdatedAtZero();
        if (startedAt == 0 || startedAt > updatedAt) revert OracleStartedAtInvalid();
        if (block.timestamp - updatedAt >= $.stalenessThreshold) revert StaleOracleData();
        if (answer <= 0) revert NonPositiveAnswer();

        // Normalize 1e<feedDecimals> -> 1e18. The `d > 18` branch is unreachable
        // because `initialize` / `setPriceFeed` reject feeds with > MAX_FEED_DECIMALS;
        // it is retained as a forward-compat safety net rather than asserting.
        uint256 raw = uint256(answer);
        uint8 d = $.feedDecimals;
        if (d <= 18) {
            priceE18 = raw * (10 ** (uint256(18) - uint256(d)));
        } else {
            priceE18 = raw / (10 ** (uint256(d) - uint256(18)));
        }

        if (priceE18 < $.minPriceE18 || priceE18 > $.maxPriceE18) {
            revert PriceOutOfBand(priceE18, $.minPriceE18, $.maxPriceE18);
        }
    }

    // ============ Admin / Operator Setters ============

    /// @notice Rotate the underlying price feed.
    /// @param newFeed Address of the new Chainlink-compatible aggregator (non-zero).
    /// @dev Re-caches the feed's decimals at the time of the call. The new feed must
    ///      be a non-zero address reporting <= Constants.MAX_FEED_DECIMALS decimals.
    function setPriceFeed(address newFeed) external onlyRole(Roles.RELAY_FEED_MANAGER) {
        if (newFeed == address(0)) revert Errors.ZeroAddress();
        OracleRelayStorage storage $ = _getOracleRelayStorage();
        address oldFeed = address($.priceFeed);
        uint8 d = _readAndValidateFeedDecimals(newFeed);
        $.priceFeed = IAggregatorV3(newFeed);
        $.feedDecimals = d;
        emit PriceFeedUpdated(oldFeed, newFeed, d);
    }

    /// @notice Update the staleness threshold (seconds).
    /// @param newSeconds New threshold (must be in [ORACLE_MIN_STALENESS, ORACLE_MAX_STALENESS]).
    /// @dev Bounded by Constants.ORACLE_MIN_STALENESS / Constants.ORACLE_MAX_STALENESS.
    function setStalenessThreshold(uint256 newSeconds)
        external
        onlyRole(Roles.RELAY_CONFIG_MANAGER)
    {
        _validateStaleness(newSeconds);
        OracleRelayStorage storage $ = _getOracleRelayStorage();
        uint256 oldSeconds = $.stalenessThreshold;
        $.stalenessThreshold = newSeconds;
        emit StalenessThresholdUpdated(oldSeconds, newSeconds);
    }

    /// @notice Update the in-band USDC price window (1e18-scaled).
    /// @param newMinE18 New lower band edge (>= ORACLE_USDC_PRICE_FLOOR).
    /// @param newMaxE18 New upper band edge (<= ORACLE_USDC_PRICE_CEILING, > newMinE18).
    /// @dev Bounded by Constants.ORACLE_USDC_PRICE_FLOOR / ORACLE_USDC_PRICE_CEILING and
    ///      requires newMinE18 < newMaxE18.
    function setPriceBand(
        uint256 newMinE18,
        uint256 newMaxE18
    )
        external
        onlyRole(Roles.RELAY_CONFIG_MANAGER)
    {
        _validatePriceBand(newMinE18, newMaxE18);
        OracleRelayStorage storage $ = _getOracleRelayStorage();
        uint256 oldMin = $.minPriceE18;
        uint256 oldMax = $.maxPriceE18;
        $.minPriceE18 = newMinE18;
        $.maxPriceE18 = newMaxE18;
        emit PriceBandUpdated(oldMin, oldMax, newMinE18, newMaxE18);
    }

    // ============ Internal Helpers ============

    function _readAndValidateFeedDecimals(address feedAddr) internal view returns (uint8 d) {
        d = IAggregatorV3Decimals(feedAddr).decimals();
        if (d > Constants.MAX_FEED_DECIMALS) revert FeedDecimalsTooLarge(d);
    }

    function _validateStaleness(uint256 s) internal pure {
        if (s < Constants.ORACLE_MIN_STALENESS || s > Constants.ORACLE_MAX_STALENESS) {
            revert InvalidStaleness(
                s, Constants.ORACLE_MIN_STALENESS, Constants.ORACLE_MAX_STALENESS
            );
        }
    }

    function _validatePriceBand(uint256 minE18, uint256 maxE18) internal pure {
        if (
            minE18 >= maxE18 || minE18 < Constants.ORACLE_USDC_PRICE_FLOOR
                || maxE18 > Constants.ORACLE_USDC_PRICE_CEILING
        ) {
            revert InvalidPriceBand(minE18, maxE18);
        }
    }

    // ============ Upgradeability ============

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(Roles.RELAY_UPGRADER)
    {}
}

/// @dev The relay needs `decimals()` from the aggregator at init / rotation time.
///      `IAggregatorV3` in this repo is intentionally minimal (only `latestRoundData`);
///      this local interface keeps that footprint while exposing the one extra read
///      the relay requires.
interface IAggregatorV3Decimals {
    function decimals() external view returns (uint8);
}
