// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {OracleRelay} from "../../src/oracle/OracleRelay.sol";
import {IOracleRelay} from "../../src/oracle/IOracleRelay.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {OracleRelayEvents} from "../../src/lib/events/OracleRelayEvents.sol";
import {TestRoles} from "../shared/Roles.sol";

import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";

/// @dev Tiny shim that lets us spin up Chainlink-shape feeds with arbitrary `decimals()`.
contract MockAggregatorV3WithDecimals {
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _timestamp;
    uint80 private _roundId;
    uint80 private _answeredInRound;
    uint8 private _decimals;

    constructor(uint8 d, int256 initialAnswer) {
        _decimals = d;
        _answer = initialAnswer;
        _timestamp = block.timestamp;
        _startedAt = _timestamp;
        _roundId = 1;
        _answeredInRound = 1;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function setAnswer(int256 a) external {
        _answer = a;
        _timestamp = block.timestamp;
        _startedAt = _timestamp;
        _answeredInRound = _roundId;
    }

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
        return (_roundId, _answer, _startedAt, _timestamp, _answeredInRound);
    }
}

contract OracleRelayTest is Test {
    OracleRelay public relay;
    MockAggregatorV3 public feed8dec; // default reusable Chainlink-shape feed (mock reports 18 dec by default, see below)
    // The shared MockAggregatorV3 doesn't expose decimals(); the relay needs decimals().
    // Use MockAggregatorV3WithDecimals throughout for predictability.
    MockAggregatorV3WithDecimals public feed;

    address public admin = makeAddr("admin");
    address public unauthorized = makeAddr("unauthorized");

    uint256 internal constant DEFAULT_STALENESS = 1 hours;
    uint256 internal constant DEFAULT_MIN = 0.97e18;
    uint256 internal constant DEFAULT_MAX = 1.03e18;

    function setUp() public {
        // 8-decimal feed at $1.00 (Chainlink USDC/USD shape).
        feed = new MockAggregatorV3WithDecimals(8, int256(1e8));
        relay = _deployRelay(address(feed), DEFAULT_STALENESS, DEFAULT_MIN, DEFAULT_MAX, admin);
    }

    function _deployRelay(
        address feed_,
        uint256 staleness_,
        uint256 minE18_,
        uint256 maxE18_,
        address admin_
    )
        internal
        returns (OracleRelay)
    {
        OracleRelay impl = new OracleRelay();
        bytes memory initData =
            abi.encodeCall(OracleRelay.initialize, (feed_, staleness_, minE18_, maxE18_, admin_));
        return OracleRelay(address(new ERC1967Proxy(address(impl), initData)));
    }

    // ============ Happy path ============

    function test_Init_StoresAllParams() public view {
        assertEq(address(relay.priceFeed()), address(feed));
        assertEq(relay.stalenessThreshold(), DEFAULT_STALENESS);
        assertEq(relay.minPriceE18(), DEFAULT_MIN);
        assertEq(relay.maxPriceE18(), DEFAULT_MAX);
        assertEq(relay.feedDecimals(), 8);
    }

    function test_GetUsdcPrice_NormalizesEightDecimalToE18() public view {
        // 1e8 raw -> 1e18 normalized
        assertEq(relay.getUsdcPrice(), 1e18);
    }

    function test_CheckUsdcPeg_HappyPathNoop() public view {
        relay.checkUsdcPeg(); // does not revert
    }

    // ============ Decimal normalization ============

    function test_GetUsdcPrice_SixDecimalFeed() public {
        MockAggregatorV3WithDecimals six = new MockAggregatorV3WithDecimals(6, int256(1_000_000)); // $1.00 at 6 dec
        OracleRelay r =
            _deployRelay(address(six), DEFAULT_STALENESS, DEFAULT_MIN, DEFAULT_MAX, admin);
        assertEq(r.getUsdcPrice(), 1e18);
    }

    function test_GetUsdcPrice_EighteenDecimalFeed() public {
        MockAggregatorV3WithDecimals d18 = new MockAggregatorV3WithDecimals(18, int256(1e18)); // $1.00 at 18 dec
        OracleRelay r =
            _deployRelay(address(d18), DEFAULT_STALENESS, DEFAULT_MIN, DEFAULT_MAX, admin);
        assertEq(r.getUsdcPrice(), 1e18);
    }

    function test_Init_RevertsOnFeedDecimalsTooLarge() public {
        MockAggregatorV3WithDecimals d19 = new MockAggregatorV3WithDecimals(19, int256(1));
        OracleRelay impl = new OracleRelay();
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize,
            (address(d19), DEFAULT_STALENESS, DEFAULT_MIN, DEFAULT_MAX, admin)
        );
        vm.expectRevert(
            abi.encodeWithSelector(OracleRelay.FeedDecimalsTooLarge.selector, uint8(19))
        );
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ Init guards ============

    function test_Init_RevertsOnZeroFeed() public {
        OracleRelay impl = new OracleRelay();
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize, (address(0), DEFAULT_STALENESS, DEFAULT_MIN, DEFAULT_MAX, admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Init_RevertsOnZeroAdmin() public {
        OracleRelay impl = new OracleRelay();
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize,
            (address(feed), DEFAULT_STALENESS, DEFAULT_MIN, DEFAULT_MAX, address(0))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Init_RevertsOnStalenessBelowMin() public {
        OracleRelay impl = new OracleRelay();
        uint256 below = Constants.ORACLE_MIN_STALENESS - 1;
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize, (address(feed), below, DEFAULT_MIN, DEFAULT_MAX, admin)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleRelay.InvalidStaleness.selector,
                below,
                Constants.ORACLE_MIN_STALENESS,
                Constants.ORACLE_MAX_STALENESS
            )
        );
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Init_RevertsOnStalenessAboveMax() public {
        OracleRelay impl = new OracleRelay();
        uint256 above = Constants.ORACLE_MAX_STALENESS + 1;
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize, (address(feed), above, DEFAULT_MIN, DEFAULT_MAX, admin)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleRelay.InvalidStaleness.selector,
                above,
                Constants.ORACLE_MIN_STALENESS,
                Constants.ORACLE_MAX_STALENESS
            )
        );
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Init_RevertsOnBandMinGreaterThanMax() public {
        OracleRelay impl = new OracleRelay();
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize,
            (address(feed), DEFAULT_STALENESS, DEFAULT_MAX, DEFAULT_MIN, admin) // swapped
        );
        vm.expectRevert(
            abi.encodeWithSelector(OracleRelay.InvalidPriceBand.selector, DEFAULT_MAX, DEFAULT_MIN)
        );
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Init_RevertsOnBandBelowFloor() public {
        OracleRelay impl = new OracleRelay();
        uint256 belowFloor = Constants.ORACLE_USDC_PRICE_FLOOR - 1;
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize,
            (address(feed), DEFAULT_STALENESS, belowFloor, DEFAULT_MAX, admin)
        );
        vm.expectRevert(
            abi.encodeWithSelector(OracleRelay.InvalidPriceBand.selector, belowFloor, DEFAULT_MAX)
        );
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Init_RevertsOnBandAboveCeiling() public {
        OracleRelay impl = new OracleRelay();
        uint256 aboveCeiling = Constants.ORACLE_USDC_PRICE_CEILING + 1;
        bytes memory initData = abi.encodeCall(
            OracleRelay.initialize,
            (address(feed), DEFAULT_STALENESS, DEFAULT_MIN, aboveCeiling, admin)
        );
        vm.expectRevert(
            abi.encodeWithSelector(OracleRelay.InvalidPriceBand.selector, DEFAULT_MIN, aboveCeiling)
        );
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ Read-safety reverts ============

    function test_GetUsdcPrice_RevertsOnStaleFeed() public {
        vm.warp(block.timestamp + DEFAULT_STALENESS + 1);
        vm.expectRevert(OracleRelay.StaleOracleData.selector);
        relay.getUsdcPrice();
    }

    function test_GetUsdcPrice_RevertsOnNonPositiveAnswer() public {
        feed.setAnswer(int256(0));
        vm.expectRevert(OracleRelay.NonPositiveAnswer.selector);
        relay.getUsdcPrice();

        feed.setAnswer(int256(-1));
        vm.expectRevert(OracleRelay.NonPositiveAnswer.selector);
        relay.getUsdcPrice();
    }

    function test_GetUsdcPrice_RevertsOnPriceBelowBand() public {
        // 0.96e18 < 0.97e18 floor
        feed.setAnswer(int256(0.96e8));
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleRelay.PriceOutOfBand.selector, uint256(0.96e18), DEFAULT_MIN, DEFAULT_MAX
            )
        );
        relay.getUsdcPrice();
    }

    function test_GetUsdcPrice_RevertsOnPriceAboveBand() public {
        // 1.04e18 > 1.03e18 ceiling
        feed.setAnswer(int256(1.04e8));
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleRelay.PriceOutOfBand.selector, uint256(1.04e18), DEFAULT_MIN, DEFAULT_MAX
            )
        );
        relay.getUsdcPrice();
    }

    // ============ Setters ============

    function test_SetPriceFeed_RotatesAndReCachesDecimals() public {
        MockAggregatorV3WithDecimals newFeed =
            new MockAggregatorV3WithDecimals(6, int256(1_000_000));

        vm.expectEmit(true, true, false, true);
        emit OracleRelayEvents.PriceFeedUpdated(address(feed), address(newFeed), uint8(6));
        vm.prank(admin);
        relay.setPriceFeed(address(newFeed));

        assertEq(address(relay.priceFeed()), address(newFeed));
        assertEq(relay.feedDecimals(), 6);
        assertEq(relay.getUsdcPrice(), 1e18); // still $1.00, now via 6-dec feed
    }

    function test_SetPriceFeed_RevertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        relay.setPriceFeed(address(0));
    }

    function test_SetPriceFeed_RevertsOnDecimalsTooLarge() public {
        MockAggregatorV3WithDecimals huge = new MockAggregatorV3WithDecimals(20, int256(1));
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(OracleRelay.FeedDecimalsTooLarge.selector, uint8(20))
        );
        relay.setPriceFeed(address(huge));
    }

    function test_SetPriceFeed_RevertsForNonFeedManager() public {
        vm.prank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                TestRoles.RELAY_FEED_MANAGER
            )
        );
        relay.setPriceFeed(address(feed));
    }

    function test_SetStalenessThreshold_Updates() public {
        uint256 newSec = 2 hours;
        vm.expectEmit(true, true, false, true);
        emit OracleRelayEvents.StalenessThresholdUpdated(DEFAULT_STALENESS, newSec);
        vm.prank(admin);
        relay.setStalenessThreshold(newSec);
        assertEq(relay.stalenessThreshold(), newSec);
    }

    function test_SetStalenessThreshold_RevertsOutOfBand() public {
        vm.prank(admin);
        vm.expectRevert();
        relay.setStalenessThreshold(Constants.ORACLE_MIN_STALENESS - 1);
    }

    function test_SetStalenessThreshold_RevertsForNonConfigManager() public {
        vm.prank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                TestRoles.RELAY_CONFIG_MANAGER
            )
        );
        relay.setStalenessThreshold(2 hours);
    }

    function test_SetPriceBand_Updates() public {
        uint256 newMin = 0.98e18;
        uint256 newMax = 1.02e18;
        vm.expectEmit(false, false, false, true);
        emit OracleRelayEvents.PriceBandUpdated(DEFAULT_MIN, DEFAULT_MAX, newMin, newMax);
        vm.prank(admin);
        relay.setPriceBand(newMin, newMax);
        assertEq(relay.minPriceE18(), newMin);
        assertEq(relay.maxPriceE18(), newMax);
    }

    function test_SetPriceBand_RevertsOnMinAboveMax() public {
        vm.prank(admin);
        vm.expectRevert();
        relay.setPriceBand(1.02e18, 0.98e18);
    }

    function test_SetPriceBand_RevertsBelowFloor() public {
        vm.prank(admin);
        vm.expectRevert();
        relay.setPriceBand(Constants.ORACLE_USDC_PRICE_FLOOR - 1, DEFAULT_MAX);
    }

    function test_SetPriceBand_RevertsAboveCeiling() public {
        vm.prank(admin);
        vm.expectRevert();
        relay.setPriceBand(DEFAULT_MIN, Constants.ORACLE_USDC_PRICE_CEILING + 1);
    }

    function test_SetPriceBand_RevertsForNonConfigManager() public {
        vm.prank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                TestRoles.RELAY_CONFIG_MANAGER
            )
        );
        relay.setPriceBand(0.98e18, 1.02e18);
    }

    // ============ UUPS upgrade ============

    function test_UpgradeAuthorized_OnlyUpgrader() public {
        OracleRelay newImpl = new OracleRelay();
        vm.prank(admin); // admin holds RELAY_UPGRADER
        relay.upgradeToAndCall(address(newImpl), "");
    }

    function test_UpgradeAuthorized_RevertsForNonUpgrader() public {
        OracleRelay newImpl = new OracleRelay();
        vm.prank(unauthorized);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                unauthorized,
                TestRoles.RELAY_UPGRADER
            )
        );
        relay.upgradeToAndCall(address(newImpl), "");
    }

    // ============ Fuzz ============

    /// @notice Any in-band price MUST pass; any out-of-band price MUST revert.
    function testFuzz_GetUsdcPrice_BandEnforcement(uint256 priceE18) public {
        priceE18 = bound(priceE18, 0.9e18, 1.1e18);

        // Convert 1e18 -> 1e8 (feed is 8 decimals).
        int256 feedAnswer = int256(priceE18 / 1e10);
        if (feedAnswer == 0) feedAnswer = 1; // skip the "answer == 0" branch, tested elsewhere
        feed.setAnswer(feedAnswer);

        uint256 effectivePriceE18 = uint256(feedAnswer) * 1e10;

        if (effectivePriceE18 >= DEFAULT_MIN && effectivePriceE18 <= DEFAULT_MAX) {
            assertEq(relay.getUsdcPrice(), effectivePriceE18);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    OracleRelay.PriceOutOfBand.selector, effectivePriceE18, DEFAULT_MIN, DEFAULT_MAX
                )
            );
            relay.getUsdcPrice();
        }
    }
}
