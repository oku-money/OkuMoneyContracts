// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title ValueDisplayParityTest
 * @notice Ties the ERC-8056 display layer to the ERC-4626 value layer.
 *
 * @dev THE PARITY RELATION IS A BOUND, NOT AN EQUALITY, and the bound is the
 *      point. `asset()` is USDC at 6 dp and `convertToAssets` must return
 *      asset-decimals to be ERC-4626-semantically correct, while
 *      `uiMultiplier()` is 18 dp. They differ by `usdcDecimalMultiplier` and a
 *      floor:
 *
 *        convertToAssets(1e18) * usdcDecimalMultiplier
 *            <= uiMultiplier()
 *            <  (convertToAssets(1e18) + 1) * usdcDecimalMultiplier
 *
 *      An earlier draft of this plan stated the bare equality
 *      `uiMultiplier() == convertToAssets(1e18)`. That is dimensionally
 *      impossible and would have bitten whoever wrote this file.
 *
 *      Corollary: the value layer's resolution is ONE USDC UNIT (1e12 in 18-dp
 *      terms) while the display layer's is one wei. `convertToAssets` and
 *      `convertToShares` are therefore not inverses.
 */
contract ValueDisplayParityTest is BaseTest {
    uint256 internal constant DM = TestConstants.DECIMAL_MULTIPLIER; // 1e12

    // ============ The parity bound ============

    function _assertParity() internal view {
        uint256 cta = token.convertToAssets(Constants.PRECISION);
        uint256 m = token.uiMultiplier();
        assertLe(cta * DM, m, "convertToAssets floor is below the multiplier");
        assertLt(m, (cta + 1) * DM, "and within one USDC unit of it");
    }

    function test_Parity_AtUnitMultiplier() public view {
        assertEq(token.convertToAssets(Constants.PRECISION), 1e6);
        _assertParity();
    }

    function test_Parity_AcrossAccrualHorizons() public {
        uint256[6] memory horizons =
            [uint256(1), 1 hours, 1 days, 7 days, 21 days, Constants.MAX_RATE_DURATION];
        for (uint256 i = 0; i < horizons.length; ++i) {
            _accrue(RATE_5_PCT_APY, horizons[i]);
            _assertParity();
        }
    }

    function test_Parity_AtHighMultiplier() public {
        _accrueToAtLeast(5 * Constants.PRECISION);
        _assertParity();
    }

    function testFuzz_Parity(uint256 rate, uint256 elapsed) public {
        rate = _bound(rate, Constants.PRECISION, Constants.PRECISION + 3_170_979_198);
        elapsed = _bound(elapsed, 1, Constants.MAX_RATE_DURATION);
        _accrue(rate, elapsed);
        _assertParity();
    }

    // ============ Conversion directions ============

    function test_ConvertToShares_InverseWithinUsdcGranularity() public {
        _accrue(RATE_5_PCT_APY, 20 days);
        uint256 back = token.convertToShares(token.convertToAssets(Constants.PRECISION));
        assertLe(back, Constants.PRECISION, "round trip must not manufacture value");
        // Bounded by the value layer's granularity, not by 1 wei.
        assertGe(back + DM, Constants.PRECISION, "loss bounded by one USDC unit");
    }

    /// @notice Explicitly documents that the two conversions are NOT inverses.
    function test_Conversions_AreNotInverses() public {
        // A multiplier with 18-dp detail that cannot survive a 6-dp round trip.
        _accrue(RATE_5_PCT_APY, 13 days + 7 hours + 11);
        uint256 m = token.uiMultiplier();
        vm.assume(m % DM != 0);

        uint256 back = token.convertToShares(token.convertToAssets(Constants.PRECISION));
        assertLt(back, Constants.PRECISION, "strict loss expected at a non-round multiplier");
    }

    function test_TotalAssets_TracksSupplyAndMultiplier() public {
        _mintRaw(user1, 1000e18);
        assertEq(token.totalAssets(), 1000e6);

        _accrue(RATE_5_PCT_APY, 30 days);
        assertGt(token.totalAssets(), 1000e6);
        assertEq(token.totalAssets(), token.convertToAssets(token.totalSupply()));
    }

    function test_Asset_IsUsdcAndMatchesDecimalMultiplier() public view {
        assertEq(token.asset(), address(usdc));
        assertEq(token.usdcDecimalMultiplier(), DM);
    }

    // ============ Single source of truth ============

    /// @notice The PSM and queue must agree with the token, not derive their own.
    ///         A misconfigured deployment would otherwise price divergently.
    function test_DecimalMultiplier_AgreesAcrossAllThreeContracts() public view {
        assertEq(token.usdcDecimalMultiplier(), litePsm.usdcDecimalMultiplier());
        assertEq(token.usdcDecimalMultiplier(), queue.usdcDecimalMultiplier());
        assertEq(token.asset(), address(litePsm.usdc()));
        assertEq(token.asset(), address(queue.usdc()));
    }

    // ============ PSM pricing agrees with the value layer ============

    function test_PsmQuoteAgreesWithConvertToShares() public {
        _accrue(RATE_5_PCT_APY, 20 days);
        uint256 usdcIn = 1234e6;
        assertEq(litePsm.quoteMint(usdcIn), token.convertToShares(usdcIn));
    }

    function test_PsmQuoteRedeemAgreesWithConvertToAssets() public {
        _accrue(RATE_5_PCT_APY, 20 days);
        uint256 rawIn = 987e18;
        assertEq(litePsm.quoteRedeem(rawIn), token.convertToAssets(rawIn));
    }
}
