// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuDollarEvents} from "../../src/lib/events/OkuDollarEvents.sol";
import {YieldSandwichGuard} from "../../src/lib/YieldSandwichGuard.sol";

/**
 * @title OkuDollarTest
 * @notice Unit tests for OkuDollar rebasing stablecoin vault (NOT ERC-4626)
 * @dev OkuMoney is a non-rebasing ERC-20 with okuMMultiplier() for price tracking.
 *      Wrap/unwrap are multiplier-aware: they convert between note tokens and OkuDollar
 *      using okuMMultiplier() and usdMultiplier(). When okuMMultiplier = 1e18 (initial state),
 *      the math is identical to old 1:1 behavior.
 */
contract OkuDollarTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    event UsdYieldRateUpdated(
        uint256 oldRatePerSecond,
        uint256 newRatePerSecond,
        uint256 endTimestamp,
        uint256 snapshotMultiplier
    );
    event NextUsdYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinCollateralRatioUpdated(uint256 oldRatio, uint256 newRatio);
    event ReservesDeposited(
        address indexed depositor,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 collateralizationRatio
    );
    event SurplusWithdrawn(
        address indexed to, uint256 okuMAmount, uint256 dollarValue, uint256 collateralizationRatio
    );

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuDollar.name(), "OkuDollar");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuDollar.symbol(), "usdOku");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuDollar.decimals(), 18);
    }

    function test_Initialize_SetsOkuMoneyReference() public view {
        assertEq(address(okuDollar.okuMoney()), address(okuMoney));
    }

    function test_Initialize_SetsMinCollateralRatio() public view {
        assertEq(okuDollar.minCollateralRatio(), 95e16);
    }

    function test_Initialize_UsdMultiplierStartsAtPrecision() public view {
        assertEq(okuDollar.usdMultiplier(), PRECISION);
    }

    function test_Initialize_SetsAdminRoles() public view {
        assertTrue(okuDollar.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(okuDollar.hasRole(VAULT_UPGRADER, admin));
    }

    // ============ Wrap Tests ============

    function test_Wrap_MintsCorrectUsdShares() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // At okuMMultiplier=1e18 and usdMultiplier=1e18: 100 notes → 100 OkuDollar
        assertEq(usdMinted, okuMAmount);
        assertEq(okuDollar.balanceOf(user1), okuMAmount);
        assertEq(okuDollar.usdSharesOf(user1), okuMAmount);
    }

    function test_Wrap_TransfersNotesToVault() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        uint256 vaultBefore = okuMoney.balanceOf(address(okuDollar));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(okuMoney.balanceOf(user1), 0);
        assertEq(okuMoney.balanceOf(address(okuDollar)), vaultBefore + okuMAmount);
    }

    function test_Wrap_EmitsTransferFromZero() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // At okuMMultiplier=1e18, usdMultiplier=1e18: usdMinted = okuMAmount
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, okuMAmount);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);
    }

    function test_Wrap_ToReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user2, 0);

        // At okuMMultiplier=1e18: 100 notes → 100 OkuDollar
        assertEq(okuDollar.balanceOf(user2), okuMAmount);
        assertEq(okuDollar.balanceOf(user1), 0);
    }

    function test_Wrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.wrap(0, user1, 0);
    }

    function test_Wrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuDollar.wrap(okuMAmount, address(0), 0);
    }

    // ============ Wrap Rounding Tests ============

    function test_Wrap_SharesRoundDown_FavorsVault() public {
        // Wrap some so vault is non-empty
        _mintUsdOku(user1, 1000e18);

        // Increase USD multiplier to 3x
        _elevateUsdMultiplier(PRECISION * 3);

        // Wrap an odd amount at okuMMultiplier=1e18, usdMult=3e18
        // shares = 10e18 * 1e18 / 3e18 = 3333333333333333333 (rounds down)
        // usdMinted (balanceOf) = shares * 3e18 / 1e18 = 9999999999999999999 (rounds down)
        uint256 okuMAmount = 10e18;
        _mintOkuMoney(user2, okuMAmount);
        _approveOkuMoney(user2, address(okuDollar), okuMAmount);

        vm.prank(user2);
        okuDollar.wrap(okuMAmount, user2, 0);

        // Shares calculation rounds down (favors vault)
        // sharesToMint = okuMAmount * okuMMultiplier / usdMultiplier
        uint256 expectedShares =
            (okuMAmount * okuMoney.okuMMultiplier()) / okuDollar.usdMultiplier();
        assertEq(okuDollar.usdSharesOf(user2), expectedShares, "Shares should round down");

        // Dollar value from shares <= noteValue of tokens deposited (rounding favors vault)
        uint256 depositedNoteValue =
            Math.mulDiv(okuMAmount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor);
        assertLe(
            okuDollar.balanceOf(user2),
            depositedNoteValue,
            "USD balance should not exceed deposited note value"
        );
    }

    // ============ Price-Aware Wrap Tests ============

    function test_Wrap_PriceAware_NotePriceIncrease() public {
        // Increase okuMMultiplier to 1.05e18 ($1.05 per note token)
        _setOkuMMultiplierAndRoll(105e16);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18, "100 notes at $1.05 should produce 105 OkuDollar");
        assertEq(okuDollar.balanceOf(user1), 105e18);
    }

    function test_Wrap_PriceAware_HighNotePrice() public {
        // okuMMultiplier = 2e18 ($2.00 per note token)
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 okuMAmount = 50e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // usdMinted = 50e18 * 2e18 / 1e18 = 100e18
        assertEq(usdMinted, 100e18, "50 notes at $2.00 should produce 100 OkuDollar");
    }

    function test_Wrap_PriceAware_BothMultipliersElevated() public {
        // okuMMultiplier = 1.05e18, usdMultiplier targeted at 1.02e18
        _setOkuMMultiplierAndRoll(105e16);
        _elevateUsdMultiplier(102e16);

        // Read achieved multipliers — `_elevateUsdMultiplier` may overshoot the target
        // because it drives the value via setUsdYieldRate + warp.
        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 usdMult = okuDollar.usdMultiplier();

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // sharesToMint = okuMAmount * okuMMult / usdMult; usdMinted = shares * usdMult / PRECISION
        uint256 sharesToMint = Math.mulDiv(okuMAmount, okuMMult, usdMult, Math.Rounding.Floor);
        uint256 expected = Math.mulDiv(sharesToMint, usdMult, PRECISION, Math.Rounding.Floor);
        assertEq(usdMinted, expected);
    }

    // ============ Unwrap Tests ============

    function test_Unwrap_ReturnsCorrectNotes() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        uint256 userNotesBefore = okuMoney.balanceOf(user1);

        vm.prank(user1);
        uint256 okuMReturned = okuDollar.unwrap(okuMAmount, user1);

        // At okuMMultiplier=1e18: okuMReturned = 100e18 * 1e18 / 1e18 = 100e18
        assertEq(okuMReturned, okuMAmount);
        assertEq(okuMoney.balanceOf(user1), userNotesBefore + okuMAmount);
        assertEq(okuDollar.balanceOf(user1), 0);
    }

    function test_Unwrap_BurnsUsdShares() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        uint256 sharesBefore = okuDollar.usdSharesOf(user1);
        assertGt(sharesBefore, 0);

        vm.prank(user1);
        okuDollar.unwrap(okuMAmount, user1);

        assertEq(okuDollar.usdSharesOf(user1), 0);
        assertEq(okuDollar.totalUsdShares(), 0);
    }

    function test_Unwrap_EmitsTransferToZero() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, address(0), okuMAmount);

        vm.prank(user1);
        okuDollar.unwrap(okuMAmount, user1);
    }

    function test_Unwrap_ToReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        okuDollar.unwrap(okuMAmount, user2);

        // At okuMMultiplier=1e18: 100 OkuDollar → 100 notes
        assertEq(okuMoney.balanceOf(user2), okuMAmount);
        assertEq(okuMoney.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.unwrap(0, user1);
    }

    function test_Unwrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuDollar.unwrap(okuMAmount, address(0));
    }

    /// @dev Post-cycle-4 D2 fix: `unwrap` now mirrors `wrap`'s receiver check
    ///      so a user blacklisted only on OkuDollar cannot route OkuMoney to
    ///      a third-party recipient via `unwrap(amount, victimAddr)`. The
    ///      OkuMoney-side `_update` blacklist check is still independent;
    ///      this assertion closes the cross-token consistency hole.
    function test_Unwrap_RevertsOnBlacklistedReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // Blacklist user2 only on OkuDollar (not on OkuMoney).
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        okuDollar.unwrap(okuMAmount, user2);
    }

    // ============ Unwrap Rounding Tests ============

    function test_Unwrap_SharesBurnedRoundUp_FavorsVault() public {
        // Wrap at 1x, then bump usdMultiplier so the unwrap math has a non-trivial
        // fractional part (1/3) and we can directly assert ceil-division semantics.
        _mintUsdOku(user1, 1000e18);

        _elevateUsdMultiplier(PRECISION * 3);

        // user1 shares = 1000e18, balance = 1000e18 * 3 / 1e18 = 3000e18
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);
        uint256 mult = okuDollar.usdMultiplier(); // = 3e18

        uint256 usdAmount = 1e18;

        vm.prank(user1);
        okuDollar.unwrap(usdAmount, user1);

        uint256 sharesAfter = okuDollar.usdSharesOf(user1);
        uint256 sharesBurned = sharesBefore - sharesAfter;

        // Direct ceiling-division assertion — this is the actual invariant the vault
        // relies on (vault always rounds shares burned UP to favour itself).
        uint256 expectedSharesCeil = Math.mulDiv(usdAmount, PRECISION, mult, Math.Rounding.Ceil);
        assertEq(sharesBurned, expectedSharesCeil, "must burn ceil(usdAmount * 1e18 / mult) shares");

        // The dollar value of the shares burned must equal-or-exceed the requested
        // usdAmount. This is what "favors the vault" actually means — the user can
        // never extract more dollars than they burn shares for.
        uint256 dollarValueBurned = Math.mulDiv(sharesBurned, mult, PRECISION, Math.Rounding.Floor);
        assertGe(dollarValueBurned, usdAmount, "vault must not be drained by rounding");
    }

    // ============ Price-Aware Unwrap Tests ============

    function test_Unwrap_PriceAware_NotePriceIncrease() public {
        // Wrap at okuMMultiplier=1e18: 100 notes → 100 OkuDollar
        _mintUsdOku(user1, 100e18);

        // Increase okuMMultiplier to 1.05e18
        _setOkuMMultiplierAndRoll(105e16);

        // Unwrap 105 OkuDollar at okuMMultiplier=1.05e18
        // okuMReturned = 105e18 * 1e18 / 1.05e18 = 100e18
        // But user only has 100 OkuDollar, so unwrap 100 OkuDollar:
        // okuMReturned = 100e18 * 1e18 / 1.05e18 ≈ 95.238e18
        vm.prank(user1);
        uint256 okuMReturned = okuDollar.unwrap(100e18, user1);

        uint256 expected = Math.mulDiv(100e18, PRECISION, 105e16, Math.Rounding.Floor);
        assertEq(okuMReturned, expected);
        // Notes returned should be less than 100 (each note is worth more now)
        assertLt(okuMReturned, 100e18, "Should return fewer notes since each note is worth more");
    }

    function test_Unwrap_PriceAware_RoundTrip_AtHighPrice() public {
        // Set okuMMultiplier to 1.05e18 BEFORE wrapping
        _setOkuMMultiplierAndRoll(105e16);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.startPrank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18);

        // Unwrap all: notesBack = 105e18 * 1e18 / 1.05e18 = 100e18
        uint256 notesBack = okuDollar.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, okuMAmount, "Round trip should not gain tokens");
    }

    // ============ Insufficient Reserves ============

    function test_Unwrap_RevertsOnInsufficientReserves() public {
        // Wrap notes normally
        _mintUsdOku(user1, 100e18);

        // Deposit extra reserves then withdraw most to leave vault underfunded
        _mintOkuMoney(reserveManager, 200e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 200e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(200e18);

        // Set collateral ratio to floor (90%) for test purposes
        vm.prank(admin);
        okuDollar.setMinCollateralRatio(9e17);
        // Withdraw surplus: vault has 300, obligations are 100, can withdraw down to 90
        // At 90% ratio, reserves must be >= 90. So we can withdraw up to 210.
        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(210e18);

        // Vault only has 90e18 notes but user has 100e18 OkuDollar
        // At okuMMultiplier=1e18: unwrap(100e18) needs 100 notes, vault has 90
        vm.prank(user1);
        vm.expectRevert(OkuDollar.InsufficientReserves.selector);
        okuDollar.unwrap(100e18, user1);
    }

    // ============ Price-Aware Wrap/Unwrap Behavior Tests ============

    function test_PriceAware_OneNoteWrapsToOneOkuDollar_AtBasePrice() public {
        // At okuMMultiplier=1e18 (initial), 1 note = 1 OkuDollar (identical to old 1:1 behavior)
        uint256 okuMAmount = 1e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(usdMinted, 1e18, "1 note at $1.00 should produce exactly 1 OkuDollar");
        assertEq(okuDollar.balanceOf(user1), 1e18);
    }

    function test_PriceAware_AfterNotePriceIncrease_MoreOkuDollarMinted() public {
        // okuMMultiplier increases to 2x — each note token is worth $2.00
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // 100 note tokens × $2.00/token / $1.00 usdMultiplier = 200 OkuDollar
        assertEq(usdMinted, 200e18, "100 notes at $2.00 should produce 200 OkuDollar");
    }

    function test_PriceAware_NotePriceDoesNotChangeVaultBalance() public {
        // Wrap 100 notes at okuMMultiplier=1e18
        _mintUsdOku(user1, 100e18);

        uint256 vaultBalBefore = okuMoney.balanceOf(address(okuDollar));
        assertEq(vaultBalBefore, 100e18);

        // Increase okuMMultiplier — vault token balance is unchanged (non-rebasing)
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        uint256 vaultBalAfter = okuMoney.balanceOf(address(okuDollar));
        assertEq(vaultBalAfter, vaultBalBefore, "Note rebase should not change vault token count");
    }

    // ============ Wrap/Unwrap Round Trip ============

    function test_WrapUnwrap_RoundTrip_MaxOneWeiLoss() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 balance = okuDollar.balanceOf(user1);
        uint256 notesBack = okuDollar.unwrap(balance, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, okuMAmount, "Round trip should not gain tokens");
    }

    function test_WrapUnwrap_RoundTrip_AfterUsdMultiplierChange() public {
        // Wrap at 1x (okuMMultiplier=1e18, usdMult=1e18)
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // Bump USD multiplier to 1.5x
        _elevateUsdMultiplier((PRECISION * 3) / 2);

        // user1 OkuDollar balance grew to 150e18 (100 shares * 1.5x), but vault has 100 notes.
        // The vault is undercollateralized after a pure USD rebase without reserve top-up.
        //
        // Unwrap a partial amount. The CORRECT formula is:
        // okuMReturned = usdAmount × PRECISION / okuMMultiplier (multiplier is irrelevant for output)
        // For 66e18 OkuDollar at okuMMultiplier=1e18: okuMReturned = 66e18 × 1e18 / 1e18 = 66e18 notes
        //
        // This is correct because usdMultiplier converts shares↔dollars, not dollars↔OkuMoney.
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(66e18, user1);

        // Expected = usdAmount × PRECISION / okuMMultiplier = 66e18 × 1e18 / 1e18 = 66e18
        uint256 expected = Math.mulDiv(66e18, PRECISION, PRECISION, Math.Rounding.Floor);
        assertEq(notesBack, expected);
    }

    function test_WrapUnwrap_RoundTrip_AfterNotePriceChange() public {
        // Wrap at okuMMultiplier=1e18
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);
        // user1 has 100 OkuDollar (100 USD shares), vault has 100 notes

        // Increase okuMMultiplier to 1.5e18
        // Vault still has 100 note tokens, but each is worth $1.50 → $150 backing
        // Obligations: 100 OkuDollar → overcollateralized
        _setOkuMMultiplierAndRoll((PRECISION * 3) / 2);

        // Unwrap 100 OkuDollar: okuMReturned = 100e18 * 1e18 / 1.5e18 ≈ 66.67e18
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(100e18, user1);

        uint256 expected = Math.mulDiv(100e18, PRECISION, (PRECISION * 3) / 2, Math.Rounding.Floor);
        assertEq(notesBack, expected);
        // Fewer notes returned, but each note is worth more dollars
        assertLt(notesBack, 100e18, "Should return fewer notes at higher note price");
    }

    /// @notice CRITICAL: Test that caught the okuMReturned formula bug.
    /// @dev When okuMMultiplier and usdMultiplier are equally elevated, a user wrapping
    ///      N OkuMoney should get back exactly N OkuMoney on unwrap.
    ///      OLD buggy formula (usdAmount * mult / price) returned MORE than deposited
    ///      and reverted at the reserve check.
    ///      CORRECT formula (usdAmount * PRECISION / price) returns exactly N.
    function test_WrapUnwrap_RoundTrip_MatchedPriceAndMultiplier() public {
        // Wrap 100 OkuMoney at parity (okuMMultiplier=1e18, usdMult=1e18)
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // Elevate both multipliers to the same value (achieved value may exceed 1.04e18).
        uint256 elevatedTarget = (PRECISION * 104) / 100;
        _elevateUsdMultiplier(elevatedTarget);
        uint256 elevatedActual = okuDollar.usdMultiplier();
        _setOkuMMultiplierAndRoll(elevatedActual);
        vm.roll(block.number + 1); // Roll past yield lock

        // Vault still has exactly 100 OkuMoney tokens (no extra reserves added).
        uint256 vaultReserves = okuMoney.balanceOf(address(okuDollar));
        assertEq(vaultReserves, 100e18, "Vault should have 100 OkuMoney");

        // Unwrap full elevated balance — should return original deposited amount.
        uint256 usdBalance = okuDollar.balanceOf(user1);
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(usdBalance, user1);

        assertEq(notesBack, okuMAmount, "Round trip at matched rates should return original amount");
    }

    // ============ USD Multiplier Tests ============

    function test_UsdMultiplier_GrowsOverTime() public {
        // ~4.5% APY = 1e18 + ~1.393e9 per second
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        uint256 multBefore = okuDollar.usdMultiplier();

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        uint256 multAfter = okuDollar.usdMultiplier();
        assertGt(multAfter, multBefore, "Multiplier should grow over time");
    }

    function test_UsdMultiplier_AccruesContinuously() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        uint256 start = block.timestamp;

        // Warp 100 seconds
        vm.warp(start + 100);
        uint256 multAt100 = okuDollar.usdMultiplier();

        // The multiplier is a pure function of elapsed time, always deterministic
        assertGt(multAt100, PRECISION);
        assertEq(okuDollar.usdMultiplier(), multAt100);
    }

    function test_UsdMultiplier_AffectsBalances() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.balanceOf(user1), 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // _elevateUsdMultiplier may overshoot the target slightly; compute expected
        // balance from the achieved multiplier and the user's share count.
        uint256 expected = Math.mulDiv(
            okuDollar.usdSharesOf(user1), okuDollar.usdMultiplier(), PRECISION, Math.Rounding.Floor
        );
        assertEq(okuDollar.balanceOf(user1), expected);
        assertGe(okuDollar.balanceOf(user1), 200e18);
    }

    function test_UsdMultiplier_AffectsTotalSupply() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.totalSupply(), 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        uint256 expected = Math.mulDiv(
            okuDollar.totalUsdShares(), okuDollar.usdMultiplier(), PRECISION, Math.Rounding.Floor
        );
        assertEq(okuDollar.totalSupply(), expected);
        assertGe(okuDollar.totalSupply(), 200e18);
    }

    // ============ setUsdYieldRate Tests ============

    function test_SetUsdYieldRate_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_REBASER
            )
        );
        okuDollar.setUsdYieldRate(PRECISION + 1e9, 0);
    }

    function test_SetUsdYieldRate_SnapshotsMultiplier() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        vm.warp(block.timestamp + 1 days);

        uint256 multBefore = okuDollar.usdMultiplier();
        assertGt(multBefore, PRECISION);

        // Set a new rate -- should snapshot current multiplier
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION, 0); // zero yield

        uint256 baseAfter = okuDollar.usdBaseMultiplier();
        assertEq(baseAfter, multBefore, "Base multiplier should be snapshotted");
    }

    function test_SetUsdYieldRate_RevertsOnNegativeRate() public {
        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.InvalidRate.selector);
        okuDollar.setUsdYieldRate(PRECISION - 1, 0);
    }

    function test_SetUsdYieldRate_RevertsOnRateTooHigh() public {
        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.RateTooHigh.selector);
        okuDollar.setUsdYieldRate(PRECISION + 1e11 + 1, 0);
    }

    function test_SetUsdYieldRate_WithEndTimestamp() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        assertEq(okuDollar.usdRateEnd(), endTime);
    }

    function test_SetUsdYieldRate_RevertsOnPastEndTimestamp() public {
        // Warp forward so block.timestamp - 1 is non-zero (avoiding endTimestamp == 0 no-expiry case)
        vm.warp(1000);
        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.EndTimestampInPast.selector);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, block.timestamp - 1);
    }

    function test_SetUsdYieldRate_ClearsPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        okuDollar.setNextUsdYieldRate(PRECISION + 2000e6);

        // Setting a new rate should clear pending
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1000e6, 0);

        assertEq(okuDollar.usdPendingRatePerSecond(), PRECISION);
    }

    // ============ setNextUsdYieldRate Tests ============

    function test_SetNextUsdYieldRate_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_REBASER
            )
        );
        okuDollar.setNextUsdYieldRate(PRECISION + 1e9);
    }

    function test_SetNextUsdYieldRate_SchedulesNextRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(usdRebaser);
        okuDollar.setNextUsdYieldRate(nextRate);

        assertEq(okuDollar.usdPendingRatePerSecond(), nextRate);
    }

    function test_SetNextUsdYieldRate_RevertsWhenNoEnd() public {
        // Set rate with no end time
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, 0);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.NoRateEndSet.selector);
        okuDollar.setNextUsdYieldRate(PRECISION + 2000e6);
    }

    function test_SetNextUsdYieldRate_RevertsOnNegativeRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.InvalidRate.selector);
        okuDollar.setNextUsdYieldRate(PRECISION - 1);
    }

    function test_SetNextUsdYieldRate_HeadToTailTransition() public {
        uint256 rate1 = PRECISION + 1393e6;
        uint256 rate2 = PRECISION + 2000e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate1, endTime);

        vm.prank(usdRebaser);
        okuDollar.setNextUsdYieldRate(rate2);

        // Warp past end time -- pending rate should take over
        vm.warp(endTime + 1 days);

        uint256 mult = okuDollar.usdMultiplier();
        // Should be greater than what rate1 alone would have produced at endTime
        assertGt(mult, PRECISION, "Multiplier should have grown through both rate periods");
    }

    // ============ depositReserves Tests ============

    function test_DepositReserves_OnlyReserveManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                VAULT_RESERVE_MANAGER
            )
        );
        okuDollar.depositReserves(100e18);
    }

    function test_DepositReserves_IncreasesReservesWithoutMintingShares() public {
        _mintUsdOku(user1, 100e18);

        uint256 sharesBefore = okuDollar.totalUsdShares();
        uint256 reservesBefore = okuDollar.totalOkuMReserves();

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);

        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);

        assertEq(okuDollar.totalUsdShares(), sharesBefore, "Shares should not change");
        assertEq(okuDollar.totalOkuMReserves(), reservesBefore + 50e18, "Reserves should increase");
    }

    function test_DepositReserves_IncreasesCollateralizationRatio() public {
        _mintUsdOku(user1, 100e18);

        uint256 ratioBefore = okuDollar.collateralizationRatio();

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);

        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);

        uint256 ratioAfter = okuDollar.collateralizationRatio();
        assertGt(ratioAfter, ratioBefore, "Collateralization ratio should increase");
    }

    function test_DepositReserves_RevertsOnZeroAmount() public {
        vm.prank(reserveManager);
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.depositReserves(0);
    }

    function test_DepositReserves_EmitsEvent() public {
        // Set up some user-held okuDollar so the post-deposit ratio is not "infinite"
        // (which would make the event check tautological).
        _mintUsdOku(user1, 100e18);

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);

        uint256 mult = okuMoney.okuMMultiplier();
        uint256 dollarValue = Math.mulDiv(50e18, mult, PRECISION, Math.Rounding.Floor);

        // Pre-compute the expected post-deposit collateralization ratio:
        //   reservesAfter = totalReserves + 50e18
        //   reservesDollarValueAfter = reservesAfter * mult / PRECISION
        //   ratio = reservesDollarValueAfter * PRECISION / totalSupply
        uint256 reservesAfter = okuDollar.totalOkuMReserves() + 50e18;
        uint256 reservesDollarValueAfter =
            Math.mulDiv(reservesAfter, mult, PRECISION, Math.Rounding.Floor);
        uint256 expectedRatio = Math.mulDiv(
            reservesDollarValueAfter, PRECISION, okuDollar.totalSupply(), Math.Rounding.Floor
        );

        vm.expectEmit(true, false, false, true, address(okuDollar));
        emit OkuDollarEvents.ReservesDeposited(reserveManager, 50e18, dollarValue, expectedRatio);

        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);

        assertEq(okuDollar.totalOkuMReserves(), reservesAfter);
        assertEq(okuDollar.collateralizationRatio(), expectedRatio);
    }

    // ============ withdrawSurplus Tests ============

    function test_WithdrawSurplus_OnlyReserveManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                VAULT_RESERVE_MANAGER
            )
        );
        okuDollar.withdrawSurplus(1e18);
    }

    function test_WithdrawSurplus_ExtractsSurplus() public {
        _mintUsdOku(user1, 100e18);

        // Deposit extra reserves to create surplus
        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);

        // At okuMMultiplier=1e18: Reserves: 150 notes ($150), obligations: 100 OkuDollar
        // surplus = ($150 - $100) * PRECISION / okuMMultiplier = 50e18 note tokens
        assertEq(okuDollar.surplus(), 50e18);

        uint256 managerNotesBefore = okuMoney.balanceOf(reserveManager);

        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(30e18);

        assertEq(okuMoney.balanceOf(reserveManager), managerNotesBefore + 30e18);
        assertEq(okuDollar.surplus(), 20e18);
    }

    function test_WithdrawSurplus_EnforcesMinCollateralRatio() public {
        _mintUsdOku(user1, 100e18);
        // minCollateralRatio is 95e16 (95%)

        // Deposit 10e18 extra -- reserves = 110 notes, obligations = 100 OkuDollar
        // At okuMMultiplier=1e18: ratio = (110 * 1.0 / 1.0) * 1.0 / 100 = 110%
        _mintOkuMoney(reserveManager, 10e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 10e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(10e18);

        // Try to withdraw 16e18 -- would leave 94 notes, ratio = 94% < 95%
        vm.prank(reserveManager);
        vm.expectRevert(OkuDollar.BelowMinimumCollateral.selector);
        okuDollar.withdrawSurplus(16e18);
    }

    function test_WithdrawSurplus_SucceedsAtExactFloor() public {
        _mintUsdOku(user1, 100e18);

        // Deposit 10e18 extra -- reserves = 110 notes, obligations = 100 OkuDollar
        _mintOkuMoney(reserveManager, 10e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 10e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(10e18);

        // Withdraw 15e18 -- leaves 95 notes / 100 OkuDollar = 95% = minCollateralRatio exactly
        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(15e18);

        assertEq(okuDollar.collateralizationRatio(), 95e16);
    }

    function test_WithdrawSurplus_RevertsOnZeroAmount() public {
        vm.prank(reserveManager);
        vm.expectRevert(Errors.ZeroAmount.selector);
        okuDollar.withdrawSurplus(0);
    }

    function test_WithdrawSurplus_EmitsEvent() public {
        _mintUsdOku(user1, 100e18);

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);

        uint256 reservesBefore = okuDollar.totalOkuMReserves();

        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(20e18);

        // Verify withdrawal happened
        assertEq(okuDollar.totalOkuMReserves(), reservesBefore - 20e18);
        assertEq(okuMoney.balanceOf(reserveManager), 20e18);
    }

    // ============ setMinCollateralRatio Tests ============

    function test_SetMinCollateralRatio_OnlyVaultAdmin() public {
        // setMinCollateralRatio is now gated on VAULT_ADMIN (carved out from
        // DEFAULT_ADMIN_ROLE so the operational vault-config key can be
        // rotated independently of the AccessControl meta-role).
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_ADMIN
            )
        );
        okuDollar.setMinCollateralRatio(90e16);
    }

    function test_SetMinCollateralRatio_UpdatesRatio() public {
        vm.prank(admin);
        okuDollar.setMinCollateralRatio(90e16);

        assertEq(okuDollar.minCollateralRatio(), 90e16);
    }

    function test_SetMinCollateralRatio_RevertsAbovePrecision() public {
        vm.prank(admin);
        vm.expectRevert(OkuDollar.RatioExceedsMax.selector);
        okuDollar.setMinCollateralRatio(PRECISION + 1);
    }

    function test_SetMinCollateralRatio_RejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(OkuDollar.RatioBelowFloor.selector);
        okuDollar.setMinCollateralRatio(0);
    }

    function test_SetMinCollateralRatio_RejectsBelowFloor() public {
        vm.prank(admin);
        vm.expectRevert(OkuDollar.RatioBelowFloor.selector);
        okuDollar.setMinCollateralRatio(89e16); // 89% is below 90% floor
    }

    function test_SetMinCollateralRatio_AllowsFloor() public {
        vm.prank(admin);
        okuDollar.setMinCollateralRatio(9e17); // 90% is the floor

        assertEq(okuDollar.minCollateralRatio(), 9e17);
    }

    function test_SetMinCollateralRatio_AllowsPrecision() public {
        vm.prank(admin);
        okuDollar.setMinCollateralRatio(PRECISION);

        assertEq(okuDollar.minCollateralRatio(), PRECISION);
    }

    function test_SetMinCollateralRatio_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MinCollateralRatioUpdated(95e16, 90e16);

        vm.prank(admin);
        okuDollar.setMinCollateralRatio(90e16);
    }

    // ============ Collateralization Views Tests ============

    function test_TotalNoteReserves_EqualsNoteBalance() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.totalOkuMReserves(), okuMoney.balanceOf(address(okuDollar)));
    }

    function test_TotalUsdObligations_EqualsTotalSupply() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.totalUsdObligations(), okuDollar.totalSupply());
    }

    function test_CollateralizationRatio_100Percent_AtStart() public {
        _mintUsdOku(user1, 100e18);

        // At okuMMultiplier=1e18: reserves = 100 notes * $1.00 = $100, obligations = 100 OkuDollar
        assertEq(okuDollar.collateralizationRatio(), PRECISION);
    }

    function test_CollateralizationRatio_MaxWhenEmpty() public view {
        // No obligations -> type(uint256).max
        assertEq(okuDollar.collateralizationRatio(), type(uint256).max);
    }

    function test_CollateralizationRatio_IncreasesWithDeposit() public {
        _mintUsdOku(user1, 100e18);

        _mintOkuMoney(reserveManager, 100e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 100e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(100e18);

        // At okuMMultiplier=1e18: 200 notes * $1.00 / 100 OkuDollar = 200%
        assertEq(okuDollar.collateralizationRatio(), PRECISION * 2);
    }

    function test_CollateralizationRatio_IncreasesWithNotePriceIncrease() public {
        _mintUsdOku(user1, 100e18);

        // ratio = 100% initially
        assertEq(okuDollar.collateralizationRatio(), PRECISION);

        // Increase okuMMultiplier to 1.5e18 — vault still has 100 note tokens
        // Dollar value of reserves: 100 * $1.50 = $150, obligations: 100 OkuDollar
        // ratio = $150 / $100 = 150%
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier((PRECISION * 3) / 2);

        assertEq(okuDollar.collateralizationRatio(), (PRECISION * 3) / 2);
    }

    function test_Surplus_ReturnsCorrectAmount() public {
        _mintUsdOku(user1, 100e18);

        // At 100% collateralized, surplus = 0
        assertEq(okuDollar.surplus(), 0);

        // Add extra reserves
        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);

        // At okuMMultiplier=1e18: surplus = ($150 - $100) * 1e18 / 1e18 = 50 note tokens
        assertEq(okuDollar.surplus(), 50e18);
    }

    function test_Surplus_ZeroWhenUndercollateralized() public {
        _mintUsdOku(user1, 100e18);

        // Increase USD multiplier -- obligations grow but reserves stay the same
        _elevateUsdMultiplier(PRECISION * 2);

        // Reserves: 100 notes * $1.00 = $100, obligations: 200 OkuDollar
        assertEq(okuDollar.surplus(), 0);
    }

    function test_Surplus_IncreasesWithNotePriceIncrease() public {
        _mintUsdOku(user1, 100e18);
        assertEq(okuDollar.surplus(), 0);

        // Increase okuMMultiplier to 1.5e18
        // Reserves: 100 notes * $1.50 = $150, obligations: 100 OkuDollar
        // Dollar surplus: $150 - $100 = $50
        // Surplus in note tokens: $50 * 1e18 / $1.50 ≈ 33.33e18
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier((PRECISION * 3) / 2);

        uint256 expectedSurplus =
            Math.mulDiv(50e18, PRECISION, (PRECISION * 3) / 2, Math.Rounding.Floor);
        assertEq(okuDollar.surplus(), expectedSurplus);
        assertGt(okuDollar.surplus(), 0, "Note price increase should create surplus");
    }

    // ============ Pause Tests ============

    function test_Pause_BlocksTransfer() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(user1);
        vm.expectRevert();
        okuDollar.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(user2);
        vm.expectRevert();
        okuDollar.transferFrom(user1, user2, 50e18);
    }

    function test_Pause_BlocksWrap() public {
        vm.prank(vaultPauser);
        okuDollar.pause();

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // M-4 fix: wrap is now blocked when paused (full freeze)
        vm.prank(user1);
        vm.expectRevert();
        okuDollar.wrap(okuMAmount, user1, 0);
    }

    function test_Pause_BlocksUnwrap() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        // M-4 fix: unwrap is now blocked when paused (full freeze)
        vm.prank(user1);
        vm.expectRevert();
        okuDollar.unwrap(100e18, user1);
    }

    function test_Pause_OnlyVaultPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_PAUSER
            )
        );
        okuDollar.pause();

        // Note pauser cannot pause OkuDollar vault
        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, VAULT_PAUSER
            )
        );
        okuDollar.pause();
    }

    function test_Unpause_OnlyVaultUnpauser() public {
        vm.prank(vaultPauser);
        okuDollar.pause();

        // user1 cannot unpause
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_UNPAUSER
            )
        );
        okuDollar.unpause();

        // Separate roles: pauser cannot unpause
        vm.prank(vaultPauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                vaultPauser,
                VAULT_UNPAUSER
            )
        );
        okuDollar.unpause();

        // Vault unpauser can unpause
        vm.prank(vaultUnpauser);
        okuDollar.unpause();
    }

    function test_Pause_TransfersResumeAfterUnpause() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.prank(vaultUnpauser);
        okuDollar.unpause();

        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);

        assertEq(okuDollar.balanceOf(user2), 50e18);
    }

    // ============ ERC-20 Compliance Tests ============

    function test_Transfer_MovesSharesInternally() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.transfer(user2, 40e18);

        assertEq(okuDollar.balanceOf(user1), 60e18);
        assertEq(okuDollar.balanceOf(user2), 40e18);
    }

    function test_Transfer_EmitsTokenAmounts() public {
        _mintUsdOku(user1, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 40e18);

        vm.prank(user1);
        okuDollar.transfer(user2, 40e18);
    }

    function test_TransferFrom_WithApproval() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        okuDollar.approve(user2, 50e18);

        vm.prank(user2);
        okuDollar.transferFrom(user1, user2, 50e18);

        assertEq(okuDollar.balanceOf(user2), 50e18);
        assertEq(okuDollar.balanceOf(user1), 50e18);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user2);
        vm.expectRevert();
        okuDollar.transferFrom(user1, user2, 50e18);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mintUsdOku(user1, 100e18);

        // _transferUsdShares should revert with InsufficientBalance — the share
        // balance check is unrelated to vault collateralization (which has its own
        // distinct InsufficientCollateral error).
        vm.prank(user1);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        okuDollar.transfer(user2, 101e18);
    }

    function test_Approve_SetsAllowance() public {
        vm.prank(user1);
        okuDollar.approve(user2, 100e18);

        assertEq(okuDollar.allowance(user1, user2), 100e18);
    }

    function test_TotalSupply_ReflectsAllShares() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        assertEq(okuDollar.totalSupply(), 300e18);
    }

    function test_Transfer_ShareBased_AfterMultiplierChange() public {
        _mintUsdOku(user1, 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // Transfer half of user1's balance.
        uint256 user1Before = okuDollar.balanceOf(user1);
        uint256 transferAmt = user1Before / 2;
        vm.prank(user1);
        okuDollar.transfer(user2, transferAmt);

        // Both sides should hold ~half of the original balance (shares-based; rounding
        // can shift 1 wei).
        assertApproxEqAbs(okuDollar.balanceOf(user1), user1Before - transferAmt, 1);
        assertApproxEqAbs(okuDollar.balanceOf(user2), transferAmt, 1);
    }

    function test_BalanceOf_ReflectsMultiplier() public {
        _mintUsdOku(user1, 100e18);

        assertEq(okuDollar.balanceOf(user1), 100e18);
        assertEq(okuDollar.usdSharesOf(user1), 100e18);

        // Multiplier elevated -> balanceOf grows, shares unchanged.
        _elevateUsdMultiplier(PRECISION * 2);

        uint256 expected = Math.mulDiv(
            okuDollar.usdSharesOf(user1), okuDollar.usdMultiplier(), PRECISION, Math.Rounding.Floor
        );
        assertEq(okuDollar.balanceOf(user1), expected);
        assertGe(okuDollar.balanceOf(user1), 200e18);
        assertEq(okuDollar.usdSharesOf(user1), 100e18);
    }

    // ============ Role Enforcement Tests ============

    function test_RoleEnforcement_NoteRebaserCannotSetUsdRate() public {
        vm.prank(rebaser); // note rebaser, not USD rebaser
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, rebaser, VAULT_REBASER
            )
        );
        okuDollar.setUsdYieldRate(PRECISION + 1e9, 0);
    }

    function test_RoleEnforcement_NonReserveManagerCannotDeposit() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                VAULT_RESERVE_MANAGER
            )
        );
        okuDollar.depositReserves(100e18);
    }

    function test_RoleEnforcement_NonReserveManagerCannotWithdraw() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                VAULT_RESERVE_MANAGER
            )
        );
        okuDollar.withdrawSurplus(1e18);
    }

    function test_RoleEnforcement_NonVaultAdminCannotSetCollateralRatio() public {
        // setMinCollateralRatio is gated on VAULT_ADMIN, not the generic
        // DEFAULT_ADMIN_ROLE. The reserveManager holds VAULT_RESERVE_MANAGER
        // but not VAULT_ADMIN, so this call must revert.
        vm.prank(reserveManager);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                reserveManager,
                VAULT_ADMIN
            )
        );
        okuDollar.setMinCollateralRatio(90e16);
    }

    // ============ Repeated Wrap/Unwrap (rUSDY H-01 Mitigation) ============

    function test_RepeatedWrapUnwrap_NoShareInflation() public {
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            okuDollar.wrap(noteBal, user1, 0);
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;
            okuDollar.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);

        // Must not gain tokens (no free share accumulation)
        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        // Max 1 wei loss per cycle
        assertGe(finalNotes, initialNotes - 50, "Excessive rounding loss");
    }

    function test_RepeatedWrapUnwrap_NoShareInflation_ElevatedPrice() public {
        // Set okuMMultiplier to elevated value but keep multiplier at base
        // This tests the overcollateralized scenario (price > mult)
        uint256 elevatedPrice = 15e17; // 1.5e18

        _setOkuMMultiplierAndRoll(elevatedPrice);
        // usdMultiplier stays at default PRECISION

        // Create some existing vault state at elevated price
        _mintOkuMoney(user2, 5000e18);
        _approveOkuMoney(user2, address(okuDollar), 5000e18);
        vm.prank(user2);
        okuDollar.wrap(5000e18, user2, 0);

        // Now user1 does repeated wrap/unwrap at elevated okuMMultiplier
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            okuDollar.wrap(noteBal, user1, 0);
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;
            okuDollar.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);

        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        assertGe(finalNotes, initialNotes - 50, "Excessive rounding loss");
    }

    function test_RepeatedWrapUnwrap_NoShareInflation_AfterNotePriceChange() public {
        // Create some existing vault state
        _mintUsdOku(user2, 5000e18);

        // Bump okuMMultiplier to 1.5e18
        _setOkuMMultiplierAndRoll((PRECISION * 3) / 2);

        // Now user1 does repeated wrap/unwrap at non-1.0 okuMMultiplier
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            okuDollar.wrap(noteBal, user1, 0);
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;
            okuDollar.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);

        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        assertGe(finalNotes, initialNotes - 50, "Excessive rounding loss");
    }

    // ============ Rate Expiry Tests ============

    function test_RateExpiry_StopsYieldWhenNoPending() public {
        uint256 rate = PRECISION + 1393e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, endTime);

        // Warp to 1 second before end
        vm.warp(endTime - 1);
        uint256 multBeforeEnd = okuDollar.usdMultiplier();

        // Warp 100 days past end -- no pending rate, so yield should stop
        vm.warp(endTime + 100 days);
        uint256 multLongAfterEnd = okuDollar.usdMultiplier();

        // The multiplier should only accrue 1 more second of yield (from endTime-1 to endTime)
        // After that, no growth (pending rate is PRECISION = no yield)
        assertGt(multLongAfterEnd, multBeforeEnd, "Should accrue the final second");
        // The difference should be tiny (1 second of a ~4.5% APY rate)
        assertApproxEqRel(multLongAfterEnd, multBeforeEnd, 1e14); // within 0.01%
    }

    function test_RateExpiry_PendingRateTakesOver() public {
        uint256 rate1 = PRECISION + 1393e6; // ~4.5% APY
        uint256 rate2 = PRECISION + 634e6; // ~2% APY
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate1, endTime);

        vm.prank(usdRebaser);
        okuDollar.setNextUsdYieldRate(rate2);

        // Warp past end + 365 days: should have 30d of rate1 + 365d of rate2
        vm.warp(endTime + 365 days);

        uint256 mult = okuDollar.usdMultiplier();
        assertGt(mult, PRECISION, "Must have accrued yield through both periods");

        // Compare against just rate1 for 30 days (rate2 adds more)
        // Approximate: 30 days of ~4.5% + 365 days of ~2% => well above PRECISION
        assertGt(mult, PRECISION + 1e16, "Should have meaningful accrual");
    }

    // ============ APY Accuracy Tests ============

    function test_APYAccuracy_FourPointFivePercent() public {
        // ~4.5% APY compounding per second
        // rate = e^(ln(1.045) / 31536000) * 1e18 ~= 1000000001395766281
        uint256 rate = 1_000_000_001_395_766_281;

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        uint256 startMult = okuDollar.usdMultiplier();

        vm.warp(block.timestamp + 365 days);

        uint256 endMult = okuDollar.usdMultiplier();
        uint256 expectedMult = 1045e15; // 1.045e18

        // Within 0.1% tolerance
        assertApproxEqRel(endMult, expectedMult, 1e15);
        assertGt(endMult, startMult);
    }

    // ============ Independent Multiplier Tests ============

    function test_UsdMultiplier_IndependentOfNotePrice() public {
        // Set OkuM price discretely; set USD rate separately
        uint256 usdRate = PRECISION + 634e6; // ~2% APY

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 1045 / 1000); // simulate ~4.5% multiplier appreciation

        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(usdRate, 0);

        vm.warp(block.timestamp + 365 days);

        uint256 noteP = okuMoney.okuMMultiplier();
        uint256 usdMult = okuDollar.usdMultiplier();

        // They should be different (note at 4.5%, USD ~2% after 1 year)
        assertGt(noteP, usdMult, "Note price should be higher than USD multiplier");
        assertTrue(noteP != usdMult, "Note price and USD multiplier must be independent");
    }

    // ============ Continuous Yield + Balance/Supply Tests ============

    function test_ContinuousYield_BalanceGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        uint256 balBefore = okuDollar.balanceOf(user1);

        vm.warp(block.timestamp + 30 days);

        uint256 balAfter = okuDollar.balanceOf(user1);
        assertGt(balAfter, balBefore, "Balance must grow via continuous yield");
    }

    function test_ContinuousYield_TotalSupplyGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        uint256 supplyBefore = okuDollar.totalSupply();

        vm.warp(block.timestamp + 30 days);

        uint256 supplyAfter = okuDollar.totalSupply();
        assertGt(supplyAfter, supplyBefore, "Total supply must grow via continuous yield");
    }

    // ============ TransferFrom Share-Based with Multiplier ============

    function test_TransferFrom_ShareBased_AfterMultiplierChange() public {
        _mintUsdOku(user1, 100e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // Transfer half of user1's elevated balance.
        uint256 transferAmt = okuDollar.balanceOf(user1) / 2;
        vm.prank(user1);
        okuDollar.approve(user2, transferAmt);

        vm.prank(user2);
        okuDollar.transferFrom(user1, user2, transferAmt);

        // Share movement should be `transferAmt * PRECISION / multiplier`; per-side
        // balances should approximate `transferAmt` (1 wei tolerance for share rounding).
        uint256 expectedShares =
            Math.mulDiv(transferAmt, PRECISION, okuDollar.usdMultiplier(), Math.Rounding.Floor);
        assertEq(okuDollar.usdSharesOf(user1), 100e18 - expectedShares);
        assertEq(okuDollar.usdSharesOf(user2), expectedShares);
        assertApproxEqAbs(okuDollar.balanceOf(user2), transferAmt, 1);
    }

    // ============ Multi-User Tests ============

    function test_MultiUser_IndependentAccounting() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        // Unwrap user1 should not affect user2
        vm.prank(user1);
        okuDollar.unwrap(100e18, user1);

        assertEq(okuDollar.balanceOf(user1), 0);
        assertEq(okuDollar.balanceOf(user2), 200e18);
    }

    function test_MultiUser_ProportionalYield() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        _elevateUsdMultiplier(PRECISION * 2);

        // After elevation, balances should be in the same 1:3 ratio (shares unchanged).
        uint256 b1 = okuDollar.balanceOf(user1);
        uint256 b2 = okuDollar.balanceOf(user2);
        assertApproxEqAbs(b2, b1 * 3, 1);
        assertGe(b1, 200e18);
        assertGe(b2, 600e18);
    }

    function test_MultiUser_ProportionalShares() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        // user2 should have 3x the shares of user1
        assertEq(okuDollar.usdSharesOf(user2), okuDollar.usdSharesOf(user1) * 3);
        assertEq(
            okuDollar.totalUsdShares(), okuDollar.usdSharesOf(user1) + okuDollar.usdSharesOf(user2)
        );
    }

    function test_MultiUser_YieldAccruesProportionally() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        uint256 rate = 1_000_000_001_395_766_281; // ~4.5% APY
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(rate, 0);

        vm.warp(block.timestamp + 365 days);

        uint256 bal1 = okuDollar.balanceOf(user1);
        uint256 bal2 = okuDollar.balanceOf(user2);

        // Both accrue ~4.5%
        assertApproxEqRel(bal1, 104.5e18, 1e15); // within 0.1%
        assertApproxEqRel(bal2, 313.5e18, 1e15);

        // Proportions preserved (1:3 ratio)
        assertApproxEqRel(bal2, bal1 * 3, 1e15);
    }

    function test_MultiUser_WrapUnwrapDoesNotAffectOthers() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        uint256 user2BalBefore = okuDollar.balanceOf(user2);
        uint256 user2SharesBefore = okuDollar.usdSharesOf(user2);

        // User1 unwraps half
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);

        // User2's balance and shares should be unchanged
        assertEq(okuDollar.balanceOf(user2), user2BalBefore);
        assertEq(okuDollar.usdSharesOf(user2), user2SharesBefore);

        // User3 wraps new notes
        _mintUsdOku(user3, 500e18);

        // User2 still unchanged
        assertEq(okuDollar.balanceOf(user2), user2BalBefore);
        assertEq(okuDollar.usdSharesOf(user2), user2SharesBefore);
    }

    // ============ Fuzz Round-Trip Tests ============

    function testFuzz_WrapUnwrap_RoundTrip(uint256 mult) public {
        // Test wrap/unwrap at base multiplier=1e18 but varying okuMMultiplier.
        // `setOkuMMultiplier` requires strict increase, so bound starts above PRECISION.
        mult = bound(mult, PRECISION + 1, 5e18);

        // Only set okuMMultiplier (not multiplier) to avoid collateralization issues
        _setOkuMMultiplierAndRoll(mult);
        // usdMultiplier stays at default 1e18

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // Wrap
        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        // Unwrap full balance
        uint256 bal = okuDollar.balanceOf(user1);
        vm.prank(user1);
        okuDollar.unwrap(bal, user1);

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // Price-aware wrap/unwrap has multiple division steps, each losing up to 1 wei
        uint256 maxLoss = Math.mulDiv(5, mult, PRECISION, Math.Rounding.Ceil) + 5;
        assertApproxEqAbs(finalNotes, okuMAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    function testFuzz_WrapUnwrap_RoundTrip_WithNotePrice(uint256 price) public {
        // Strict increase required by setOkuMMultiplier.
        price = bound(price, PRECISION + 1, 3e18);

        _setOkuMMultiplierAndRoll(price);

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 bal = okuDollar.balanceOf(user1);
        okuDollar.unwrap(bal, user1);
        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // At any okuMMultiplier, round trip should return ≈ okuMAmount (within rounding)
        // Loss bounded by price/PRECISION * multiplier rounding chain
        assertApproxEqAbs(finalNotes, okuMAmount, 5, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    function testFuzz_WrapUnwrap_RoundTrip_BothPriceAndMult(uint256 price) public {
        // Test wrap/unwrap when price varies but multiplier stays at base (1e18).
        // Strict increase required by setOkuMMultiplier.
        price = bound(price, PRECISION + 1, 3e18);
        // Keep mult at base - this ensures vault stays solvent (price >= mult means overcollateralized)
        uint256 mult = PRECISION;

        _setOkuMMultiplierAndRoll(price);

        // usdMultiplier stays at default PRECISION

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(okuDollar), okuMAmount);

        // Wrap
        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        // Unwrap full balance
        uint256 bal = okuDollar.balanceOf(user1);
        vm.prank(user1);
        okuDollar.unwrap(bal, user1);

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // When price >= mult, round trip should return ≈ okuMAmount (within rounding)
        // Loss bounded by combined rounding effects
        uint256 maxLoss = Math.mulDiv(5, mult, PRECISION, Math.Rounding.Ceil)
            + Math.mulDiv(5, price, PRECISION, Math.Rounding.Ceil) + 10;
        assertApproxEqAbs(finalNotes, okuMAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_Wrap_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        okuDollar.wrap(50e18, user1, 0);
    }

    function test_Wrap_SucceedsInNextBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now wrap should succeed
        vm.prank(user1);
        okuDollar.wrap(50e18, user1, 0);

        assertGt(okuDollar.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block — unwrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        okuDollar.unwrap(50e18, user1);
    }

    function test_Unwrap_SucceedsInNextBlock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now unwrap should succeed
        uint256 okuMBefore = okuMoney.balanceOf(user1);
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);

        assertGt(okuMoney.balanceOf(user1), okuMBefore);
    }

    function test_SetOkuMPrice_AlsoBlocksWrapUnwrap() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        // setOkuMMultiplier also sets lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        okuDollar.wrap(50e18, user1, 0);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastYieldDistributionBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);

        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);

        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        assertGt(okuDollar.balanceOf(user1), 0);
    }

    function test_YieldLock_TransfersStillWorkDuringLock() public {
        // Setup: user1 has okuDollar
        _mintUsdOku(user1, 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block — transfers should still work (only wrap/unwrap are blocked)
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);

        assertGt(okuDollar.balanceOf(user2), 0);
    }

    // ============ WS3 Additional Tests ============

    // ---- WS3.1.a: zero-supply setUsdYieldRate ----

    /// @notice setUsdYieldRate when totalUsdShares == 0 should succeed
    ///         (unlike OkuMoney.distributeYield which rejects ZeroSupply).
    ///         The rate is stored and will accrue when wrap() is called later.
    function test_SetUsdYieldRate_WorksWithZeroSupply() public {
        assertEq(okuDollar.totalSupply(), 0);
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(MAX_RATE, 0);
        assertGt(okuDollar.usdRatePerSecond(), PRECISION);
    }

    /// @notice Verify that a non-zero rate accrues correctly after supply is added.
    function test_SetUsdYieldRate_AccruesAfterSubsequentWrap() public {
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(MAX_RATE, 0);
        vm.warp(block.timestamp + 1 days);

        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(100e18, user1, 0);

        // Rate accrued before wrap — usdMultiplier > 1e18
        assertGt(okuDollar.usdMultiplier(), PRECISION);
        // Dollar-adjusted balance > raw wrap amount
        assertGt(okuDollar.balanceOf(user1), 0);
        assertEq(usdMinted, okuDollar.balanceOf(user1));
    }

    // ---- WS3.1.c: reinit guard on OkuDollar ----

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert();
        okuDollar.initialize(address(okuMoney), "OkuDollar", "usdOku", admin, 95e16);
    }

    // ---- WS3.1.d: OkuDollar UUPS upgrade authorization ----

    function test_UUPS_Upgrade_RevertsForNonUpgrader() public {
        OkuDollar newImpl = new OkuDollar();
        vm.expectRevert();
        vm.prank(user1);
        okuDollar.upgradeToAndCall(address(newImpl), "");
    }

    function test_UUPS_Upgrade_SucceedsForUpgrader() public {
        OkuDollar newImpl = new OkuDollar();
        vm.prank(admin);
        okuDollar.upgradeToAndCall(address(newImpl), "");
        // State preserved through upgrade
        assertEq(okuDollar.minCollateralRatio(), 95e16);
    }

    // ---- WS3.1.f: pause for depositReserves / withdrawSurplus ----

    function test_Pause_BlocksDepositReserves() public {
        vm.prank(vaultPauser);
        okuDollar.pause();

        _mintOkuMoney(reserveManager, 100e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 100e18);
        vm.expectRevert();
        vm.prank(reserveManager);
        okuDollar.depositReserves(100e18);
    }

    function test_Pause_BlocksWithdrawSurplus() public {
        // First create surplus
        _mintOkuMoney(reserveManager, 200e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 200e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(200e18);

        vm.prank(vaultPauser);
        okuDollar.pause();

        vm.expectRevert();
        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(10e18);
    }

    function test_Unpause_AllowsDepositReservesAgain() public {
        vm.prank(vaultPauser);
        okuDollar.pause();
        vm.prank(vaultUnpauser);
        okuDollar.unpause();

        _mintOkuMoney(reserveManager, 100e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 100e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(100e18); // should not revert
    }

    // ---- WS3.1.j: OkuDollar blacklist ----

    function test_Blacklist_BlocksWrapSender() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(okuDollar), 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);
    }

    function test_Blacklist_BlocksWrapReceiver() public {
        _mintOkuMoney(user2, 100e18);
        _approveOkuMoney(user2, address(okuDollar), 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1); // blacklist receiver, not sender

        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        vm.prank(user2);
        okuDollar.wrap(100e18, user1, 0); // receiver is blacklisted
    }

    function test_Blacklist_BlocksUnwrapSender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.unwrap(50e18, user1);
    }

    function test_Blacklist_BlocksTransferSender() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Blacklist_BlocksTransferReceiver() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
    }

    function test_Blacklist_PermitBlocksBlacklistedOwner() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);

        // Permit with blacklisted owner should revert
        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        okuDollar.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    function test_Blacklist_UnblacklistRestoresAccess() public {
        _mintUsdOku(user1, 100e18);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);

        // Should work again after unblacklist
        vm.prank(user1);
        okuDollar.transfer(user2, 50e18);
        assertGt(okuDollar.balanceOf(user2), 0);
    }

    function test_Blacklist_IsBlacklistedView() public {
        assertFalse(okuDollar.isBlacklisted(user1));
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        assertTrue(okuDollar.isBlacklisted(user1));
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);
        assertFalse(okuDollar.isBlacklisted(user1));
    }

    function test_Blacklist_RevertAlreadyBlacklisted() public {
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
        vm.expectRevert(OkuDollar.AlreadyBlacklisted.selector);
        vm.prank(blacklister);
        okuDollar.blacklist(user1);
    }

    function test_Blacklist_RevertNotBlacklisted() public {
        vm.expectRevert(OkuDollar.NotBlacklisted.selector);
        vm.prank(unblacklister);
        okuDollar.unblacklist(user1);
    }

    // ---- WS3.1.j: withdrawSurplus yield-lock guard (new from WS1.3) ----

    function test_WithdrawSurplus_BlockedDuringYieldDistribution() public {
        // Setup surplus: deposit reserves without minting shares
        _mintOkuMoney(reserveManager, 200e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 200e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(200e18);

        // Distribute yield to stamp lastYieldDistributionBlock
        _mintOkuMoney(user1, 100e18);
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block: withdrawSurplus should be blocked by yield lock
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(10e18);
    }

    // ============ withdrawSurplus Boundary / postRatio Math ============
    //
    // Companion to `test_WithdrawSurplus_SucceedsAtExactFloor` which pins the
    // inclusive postRatio == minCollateralRatio success case. Below we drive:
    //   * postRatio == minCollateralRatio - 1 wei -> revert (strict-less branch).
    //   * obligations == 0 -> postRatio set to type(uint256).max (always passes).

    /// @notice One wei past the exact-floor case must revert with
    ///         BelowMinimumCollateral. Pairs with SucceedsAtExactFloor above.
    function test_WithdrawSurplus_OneWeiBelowFloor_Reverts() public {
        _mintUsdOku(user1, 100e18);

        // Reserves = 110 notes, obligations = 100 OkuDollar (multiplier 1e18).
        _mintOkuMoney(reserveManager, 10e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 10e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(10e18);

        // 15e18 leaves 95e18 reserves -> exact 95% floor (passes).
        // 15e18 + 1 leaves (95e18 - 1) wei reserves; postRatio falls below floor
        // by exactly one PRECISION-scaled unit. Must revert.
        vm.prank(reserveManager);
        vm.expectRevert(OkuDollar.BelowMinimumCollateral.selector);
        okuDollar.withdrawSurplus(15e18 + 1);
    }

    /// @notice obligations == 0 takes the `type(uint256).max` postRatio branch.
    ///         With no UsdOku in circulation, withdrawSurplus must succeed
    ///         regardless of reserves (no UsdOku holders to protect).
    function test_WithdrawSurplus_ZeroObligations_UsesInfiniteRatio() public {
        // Fund reserves but mint NO UsdOku.
        _mintOkuMoney(reserveManager, 100e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 100e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(100e18);

        assertEq(okuDollar.totalUsdObligations(), 0);
        assertEq(okuDollar.collateralizationRatio(), type(uint256).max);

        uint256 reservesBefore = okuDollar.totalOkuMReserves();
        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(reservesBefore); // drain everything

        assertEq(okuDollar.totalOkuMReserves(), 0);
    }

    /// @notice Companion: post-withdrawal ratio reflects the live
    ///         `collateralizationRatio()` view exactly.
    function test_WithdrawSurplus_EventPostRatioMatchesView() public {
        // _mintUsdOku wraps 100 OkuM -> 100 reserves + 100 obligations.
        _mintUsdOku(user1, 100e18);
        // Add 50 reserves more: total 150 reserves, 100 obligations -> 150% ratio.
        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(okuDollar), 50e18);
        vm.prank(reserveManager);
        okuDollar.depositReserves(50e18);
        assertEq(okuDollar.collateralizationRatio(), 150e16);

        vm.prank(reserveManager);
        okuDollar.withdrawSurplus(20e18);

        // Reserves: 150 -> 130; obligations: 100; ratio = 130%.
        assertEq(okuDollar.collateralizationRatio(), 130e16);
    }

    // ============ setNextUsdYieldRate Boundary Tests ============

    /// @notice `block.timestamp == usdRateEnd` must revert (closed inequality:
    ///         the production check is `>= usdRateEnd`).
    function test_SetNextUsdYieldRate_RevertAtExactEndBoundary() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        // Warp to exactly endTime — the inequality is `>=`, so this reverts.
        vm.warp(endTime);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.RateAlreadyExpired.selector);
        okuDollar.setNextUsdYieldRate(PRECISION + 2000e6);
    }

    /// @notice One second past `usdRateEnd` must revert.
    function test_SetNextUsdYieldRate_RevertOneSecondPastEnd() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.warp(endTime + 1);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.RateAlreadyExpired.selector);
        okuDollar.setNextUsdYieldRate(PRECISION + 2000e6);
    }

    /// @notice One second before `usdRateEnd` must succeed (open boundary).
    function test_SetNextUsdYieldRate_SucceedsOneSecondBeforeEnd() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.warp(endTime - 1);

        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(usdRebaser);
        okuDollar.setNextUsdYieldRate(nextRate);
        assertEq(okuDollar.usdPendingRatePerSecond(), nextRate);
    }

    /// @notice `RateTooHigh` boundary for `setNextUsdYieldRate` (companion to
    ///         the existing `setUsdYieldRate` RateTooHigh test).
    function test_SetNextUsdYieldRate_RevertsOnRateTooHigh() public {
        uint256 endTime = block.timestamp + 30 days;
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.RateTooHigh.selector);
        okuDollar.setNextUsdYieldRate(MAX_RATE + 1);
    }

    // ============ Permit Blacklist Spender Branch ============

    function test_Permit_RevertBlacklistedSpender() public {
        _mintUsdOku(user1, 100e18);
        // user1 is the (clean) owner; blacklist the spender (user2).
        vm.prank(blacklister);
        okuDollar.blacklist(user2);

        // Permit signature is bogus — call must revert before signature check.
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        okuDollar.permit(user1, user2, 50e18, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    // ============ Permit Positive-Path Tests ============

    function test_Permit_SetsAllowance() public {
        uint256 ownerPk = user2Pk;
        address owner = vm.addr(ownerPk);

        uint256 amount = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = okuDollar.nonces(owner);

        bytes32 domainSeparator = _getOkuDollarDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                user1,
                amount,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        okuDollar.permit(owner, user1, amount, deadline, v, r, s);

        assertEq(okuDollar.allowance(owner, user1), amount);
        assertEq(okuDollar.nonces(owner), nonce + 1);
    }

    function test_Permit_AllowsTransferFrom() public {
        uint256 ownerPk = user2Pk;
        address owner = vm.addr(ownerPk);

        uint256 okuMAmount = 100e18;
        _mintUsdOku(owner, okuMAmount);
        uint256 ownerBalance = okuDollar.balanceOf(owner);
        assertTrue(ownerBalance > 0);

        // Sign permit for user1 to spend owner's OkuDollar
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domainSeparator = _getOkuDollarDomainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                user1,
                ownerBalance,
                okuDollar.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        okuDollar.permit(owner, user1, ownerBalance, deadline, v, r, s);

        // user1 can now transferFrom
        vm.prank(user1);
        assertTrue(okuDollar.transferFrom(owner, user3, ownerBalance));

        assertEq(okuDollar.balanceOf(user3), ownerBalance);
        assertEq(okuDollar.balanceOf(owner), 0);
    }

    // ============ Internal Helpers ============

    function _getOkuDollarDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("OkuDollar")),
                keccak256(bytes("1")),
                block.chainid,
                address(okuDollar)
            )
        );
    }

    // ============ View Getter Tests ============

    function test_View_UsdLastAccrualTime() public {
        // Calling setUsdYieldRate stamps usdLastAccrualTime = block.timestamp.
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(PRECISION + 1e9, 0);
        assertEq(okuDollar.usdLastAccrualTime(), block.timestamp);
    }
}
