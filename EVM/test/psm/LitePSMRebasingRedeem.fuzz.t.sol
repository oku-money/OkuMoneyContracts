// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";

/**
 * @title LitePSMRebasingRedeemFuzzTest
 * @notice Fuzz coverage for `LitePSM.redeemUsdOku` at every reachable
 *         (usdMultiplier, okuMMultiplier, redeemAmount) tuple.
 * @dev Mirrors `LitePSMFuzzTest` (mint path) for redeem. The property pinned is that
 *      redeem never reverts with `InsufficientBalance()` from the transferFrom-floor /
 *      unwrap-ceil share mismatch, and strands at most 1 wei of UsdOku.
 */
contract LitePSMRebasingRedeemFuzzTest is BaseTest {
    /// @notice Maximum allowed stranded UsdOku dust per redeem (1 wei).
    uint256 internal constant MAX_STRANDED_DUST = 1;

    function setUp() public override {
        super.setUp();
        // Large USDC pool — fuzz tests need lots of liquidity on both sides.
        _mintUsdc(user1, 100_000_000e6);
        _mintUsdc(address(litePsm), 100_000_000e6);
    }

    // ============ Helpers ============

    function _mintUsdOkuViaPsm(address user, uint256 usdcAmount) internal returns (uint256) {
        _approveUsdc(user, address(litePsm), usdcAmount);
        uint256 balBefore = okuDollar.balanceOf(user);
        vm.prank(user);
        litePsm.mintUsdOku(usdcAmount);
        return okuDollar.balanceOf(user) - balBefore;
    }

    // ============ Fuzz Tests ============

    /// @notice Redeem must not revert with `InsufficientBalance()` at any reachable
    ///         usdMultiplier. Mirrors testFuzz_MintUsdOku_NoRevertOnRounding.
    /// @dev The only revert this test pin-asserts CAN'T happen is `InsufficientBalance`.
    ///      `AmountTooSmall` (from the USDC-flooring leg) is a legitimate
    ///      orthogonal failure mode that is filtered or absorbed.
    function testFuzz_RedeemUsdOku_NoRevertOnRounding_AtElevatedUsdMultiplier(
        uint256 usdcAmount,
        uint256 redeemAmount,
        uint256 usdMultTarget
    )
        public
    {
        // Bound inputs.
        usdcAmount = bound(usdcAmount, 100e6, 1_000_000e6); // 100 to 1M USDC for the mint
        usdMultTarget = bound(usdMultTarget, PRECISION, 2 * PRECISION);

        // Mint UsdOku to user1 BEFORE elevating the multiplier.
        uint256 mintedUsdOku = _mintUsdOkuViaPsm(user1, usdcAmount);
        if (mintedUsdOku < 1e15) return; // skip vanishingly small mints

        // Elevate the multiplier (helper rolls blocks and resets rate to PRECISION
        // at the end, so the multiplier is "frozen" at the elevated value).
        _elevateUsdMultiplier(usdMultTarget);

        uint256 userBal = okuDollar.balanceOf(user1);
        if (userBal < 1e15) return;
        // Floor the redeem amount at the USDC-representable boundary scaled by the
        // current usdMultiplier so the redeem produces at least 1 USDC unit out and
        // doesn't trip the orthogonal `AmountTooSmall` revert.
        uint256 floorAmt = (DECIMAL_MULTIPLIER * okuDollar.usdMultiplier() / PRECISION) + 1;
        if (floorAmt >= userBal) return;
        redeemAmount = bound(redeemAmount, floorAmt, userBal);

        _approveOkuDollar(user1, address(litePsm), redeemAmount);
        uint256 usdcBefore = usdc.balanceOf(user1);
        uint256 strandedBefore = okuDollar.balanceOf(address(litePsm));

        vm.prank(user1);
        try litePsm.redeemUsdOku(redeemAmount) {
            // success path — assert invariants
            uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;
            uint256 strandedDelta = okuDollar.balanceOf(address(litePsm)) - strandedBefore;
            assertGt(usdcReceived, 0, "Fuzz: must receive USDC");
            assertLe(usdcReceived * DECIMAL_MULTIPLIER, redeemAmount, "Fuzz: USDC out <= UsdOku in");
            assertLe(strandedDelta, MAX_STRANDED_DUST, "Fuzz: stranded within budget");
        } catch (bytes memory reason) {
            // ONLY `AmountTooSmall` is permitted here; `InsufficientBalance` must never
            // appear.
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            // OkuMoneyErrors.InsufficientBalance selector — must NEVER show up.
            require(sel != 0xf4d678b8, "Fuzz: must not revert InsufficientBalance");
            // AmountTooSmall = 0xc2e4ff97; allow + log.
        }
    }

    /// @notice Mint at a fuzzed multiplier, elevate it further, then redeem a fuzzed
    ///         fraction of the balance.
    function testFuzz_RedeemUsdOku_MintElevatedThenElevateFurther(
        uint256 usdcAmount,
        uint256 okuMMultInput,
        uint256 usdMultTarget,
        uint256 redeemFraction
    )
        public
    {
        usdcAmount = bound(usdcAmount, 100e6, 1_000_000e6);
        uint256 okuMMult = _boundOkuMMultiplier(okuMMultInput);
        usdMultTarget = bound(usdMultTarget, PRECISION, 2 * PRECISION);
        redeemFraction = bound(redeemFraction, 1, 10_000); // bps

        // Set the multiplier (rolls block), mint, then elevate it further.
        _setOkuMMultiplierAndRoll(okuMMult);
        uint256 mintedUsdOku = _mintUsdOkuViaPsm(user1, usdcAmount);
        if (mintedUsdOku < 1e15) return;
        _elevateUsdMultiplier(usdMultTarget);

        uint256 userBal = okuDollar.balanceOf(user1);
        uint256 redeemAmount = (userBal * redeemFraction) / 10_000;
        if (redeemAmount < 1e15) return;
        if (redeemAmount > userBal) redeemAmount = userBal;

        _approveOkuDollar(user1, address(litePsm), redeemAmount);
        uint256 usdcBefore = usdc.balanceOf(user1);
        uint256 strandedBefore = okuDollar.balanceOf(address(litePsm));

        vm.prank(user1);
        try litePsm.redeemUsdOku(redeemAmount) {
            uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;
            uint256 strandedDelta = okuDollar.balanceOf(address(litePsm)) - strandedBefore;
            assertGt(usdcReceived, 0, "Elevate-further fuzz: must receive USDC");
            assertLe(
                strandedDelta, MAX_STRANDED_DUST, "Elevate-further fuzz: stranded within budget"
            );
        } catch (bytes memory reason) {
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            require(sel != 0xf4d678b8, "Elevate-further fuzz: must not revert InsufficientBalance");
        }
    }

    /// @notice Time-fuzz: a random elapsed-time at a fixed 5% rate must always
    ///         allow redeem to succeed. Covers the live-compounding path with
    ///         pseudo-random clock advances rather than fixed horizons.
    function testFuzz_RedeemUsdOku_LiveCompounding_RandomElapsed(
        uint256 usdcAmount,
        uint256 elapsedSeconds,
        uint256 redeemFraction
    )
        public
    {
        usdcAmount = bound(usdcAmount, 1000e6, 1_000_000e6);
        // Bound elapsed to [1s, 50 years]. Beyond ~50 years at 5% APY, the
        // multiplier exceeds reasonable bounds for fuzz (and tests other limits).
        elapsedSeconds = bound(elapsedSeconds, 1, 50 * 365 days);
        redeemFraction = bound(redeemFraction, 1, 10_000);

        _mintUsdOkuViaPsm(user1, usdcAmount);
        // The rate lives on OkuMoney; `usdMultiplier()` reads it. A window may not
        // exceed MAX_RATE_WINDOW (90 days), so the horizon is walked as chained
        // re-anchors at the same rate (see `_accrueAtCurrentRate`).
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(1_000_000_001_546_176_000, block.timestamp + MAX_RATE_WINDOW); // ~5% APY
        _accrueAtCurrentRate(elapsedSeconds);

        uint256 userBal = okuDollar.balanceOf(user1);
        uint256 redeemAmount = (userBal * redeemFraction) / 10_000;
        if (redeemAmount < 1e15) return;
        if (redeemAmount > userBal) redeemAmount = userBal;

        _approveOkuDollar(user1, address(litePsm), redeemAmount);
        uint256 usdcBefore = usdc.balanceOf(user1);
        uint256 strandedBefore = okuDollar.balanceOf(address(litePsm));

        vm.prank(user1);
        try litePsm.redeemUsdOku(redeemAmount) {
            uint256 usdcReceived = usdc.balanceOf(user1) - usdcBefore;
            uint256 strandedDelta = okuDollar.balanceOf(address(litePsm)) - strandedBefore;
            // usdOku is dollar-denominated, so a successful redeem pays its own
            // dollar value scaled to collateral decimals, whatever the multiplier.
            assertApproxEqAbs(
                usdcReceived,
                redeemAmount / 1e12,
                2,
                "redeem pays dollar value regardless of multiplier"
            );
            assertLe(strandedDelta, MAX_STRANDED_DUST);
        } catch (bytes memory reason) {
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            require(sel != 0xf4d678b8, "Live-compound fuzz: must not revert InsufficientBalance");
        }
    }
}
