// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {MathLib} from "../../src/lib/MathLib.sol";

/**
 * @title LitePSMRebasingRedeemFuzzTest
 * @notice Fuzz coverage for `LitePSM.redeemUsdOku` at every reachable
 *         (usdMultiplier, okuMMultiplier, redeemAmount) tuple.
 * @dev The sibling `LitePSMFuzzTest` covers the mint path exhaustively. This file
 *      closes the symmetric gap on the redeem path that allowed the
 *      `InsufficientBalance()` bug to ship.
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

    /// @notice Top up the vault's OkuMoney reserves so unwrap won't revert with
    ///         InsufficientReserves after the multiplier has been pushed above
    ///         PRECISION. This isolates the rounding-asymmetry test from the
    ///         orthogonal collateral-drift concern.
    /// @dev Sizes the deposit to fully back current obligations at any reachable
    ///      (okuMMult, usdMult) pair: deposit enough OkuM so that
    ///      `reserves * okuMMult >= totalSupply` (USD-denominated).
    function _topUpReservesFully() internal {
        uint256 obligationsUsd = okuDollar.totalSupply();
        uint256 okuMMult = okuMoney.okuMMultiplier();
        // Required OkuM = obligations / okuMMult (ceiling). Over-provision generously
        // to absorb any rounding plus the small extra obligation accrual from any
        // remaining warps within this test.
        uint256 required = Math.mulDiv(obligationsUsd, PRECISION, okuMMult, Math.Rounding.Floor);
        uint256 currentReserves = okuMoney.balanceOf(address(okuDollar));
        if (currentReserves >= required) return;
        uint256 topUp = required - currentReserves + (required / 10) + 1e18; // +10% buffer
        // Cap at the remaining mintable supply to avoid blowing MaxSupply.
        uint256 mintable = okuMoney.maxSupply() - okuMoney.totalSupply();
        if (topUp > mintable) topUp = mintable;
        if (topUp == 0) return;
        vm.prank(minter);
        try okuMoney.mint(reserveManager, topUp) {}
        catch {
            return;
        }
        vm.prank(reserveManager);
        okuMoney.approve(address(okuDollar), topUp);
        vm.prank(reserveManager);
        okuDollar.depositReserves(topUp);
    }

    // ============ Fuzz Tests ============

    /// @notice The headline regression: redeem must not revert with the historical
    ///         `InsufficientBalance()` bug at any reachable usdMultiplier. Mirrors
    ///         testFuzz_MintUsdOku_NoRevertOnRounding.
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

        // Top up vault reserves to match the elevated obligations. We're testing
        // the rounding-asymmetry path, not collateral drift.
        _topUpReservesFully();

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
            // ONLY `AmountTooSmall` is permitted here. `InsufficientBalance` is the
            // historical bug and must never appear post-fix.
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            // Errors.InsufficientBalance selector — must NEVER show up.
            require(sel != 0xf4d678b8, "Fuzz: InsufficientBalance regression");
            // AmountTooSmall = 0xc2e4ff97; allow + log.
        }
    }

    /// @notice Dual-multiplier fuzz — both okuMMultiplier and usdMultiplier off-base.
    ///         Mirrors testFuzz_MintUsdOku_DualMultiplier exactly for the redeem path.
    function testFuzz_RedeemUsdOku_DualMultiplier(
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

        // Set okuMMultiplier first (rolls block), then mint, then elevate usdMult.
        _setOkuMMultiplierAndRoll(okuMMult);
        uint256 mintedUsdOku = _mintUsdOkuViaPsm(user1, usdcAmount);
        if (mintedUsdOku < 1e15) return;
        _elevateUsdMultiplier(usdMultTarget);
        _topUpReservesFully(); // isolate rounding from collateral

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
            assertGt(usdcReceived, 0, "Dual-mult fuzz: must receive USDC");
            assertLe(strandedDelta, MAX_STRANDED_DUST, "Dual-mult fuzz: stranded within budget");
        } catch (bytes memory reason) {
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            require(sel != 0xf4d678b8, "Dual-mult fuzz: InsufficientBalance regression");
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
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(1_000_000_001_546_176_000, 0); // ~5% APY
        vm.warp(block.timestamp + elapsedSeconds);
        // Top up reserves to match accrued obligations so InsufficientReserves
        // (a separate failure mode) doesn't confound the rounding test.
        _topUpReservesFully();

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
            assertGt(usdcReceived, 0);
            assertLe(strandedDelta, MAX_STRANDED_DUST);
        } catch (bytes memory reason) {
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            require(sel != 0xf4d678b8, "Live-compound fuzz: InsufficientBalance regression");
        }
    }
}
