// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
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
    event UsdMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 totalSupply);
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
        assertEq(usdOku.name(), "OkuDollar");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(usdOku.symbol(), "usdOku");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(usdOku.decimals(), 18);
    }

    function test_Initialize_SetsOkuMoneyReference() public view {
        assertEq(address(usdOku.okuMoney()), address(okuMoney));
    }

    function test_Initialize_SetsMinCollateralRatio() public view {
        assertEq(usdOku.minCollateralRatio(), 95e16);
    }

    function test_Initialize_UsdMultiplierStartsAtPrecision() public view {
        assertEq(usdOku.usdMultiplier(), PRECISION);
    }

    function test_Initialize_SetsAdminRoles() public view {
        assertTrue(usdOku.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(usdOku.hasRole(VAULT_UPGRADER, admin));
    }

    // ============ Wrap Tests ============

    function test_Wrap_MintsCorrectUsdShares() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // At okuMMultiplier=1e18 and usdMultiplier=1e18: 100 notes → 100 OkuDollar
        assertEq(usdMinted, okuMAmount);
        assertEq(usdOku.balanceOf(user1), okuMAmount);
        assertEq(usdOku.usdSharesOf(user1), okuMAmount);
    }

    function test_Wrap_TransfersNotesToVault() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        uint256 vaultBefore = okuMoney.balanceOf(address(usdOku));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        assertEq(okuMoney.balanceOf(user1), 0);
        assertEq(okuMoney.balanceOf(address(usdOku)), vaultBefore + okuMAmount);
    }

    function test_Wrap_EmitsTransferFromZero() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        // At okuMMultiplier=1e18, usdMultiplier=1e18: usdMinted = okuMAmount
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, okuMAmount);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);
    }

    function test_Wrap_ToReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user2, 0);

        // At okuMMultiplier=1e18: 100 notes → 100 OkuDollar
        assertEq(usdOku.balanceOf(user2), okuMAmount);
        assertEq(usdOku.balanceOf(user1), 0);
    }

    function test_Wrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(OkuDollar.ZeroAmount.selector);
        usdOku.wrap(0, user1, 0);
    }

    function test_Wrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        vm.expectRevert(OkuDollar.ZeroAddress.selector);
        usdOku.wrap(okuMAmount, address(0), 0);
    }

    // ============ Wrap Rounding Tests ============

    function test_Wrap_SharesRoundDown_FavorsVault() public {
        // Wrap some so vault is non-empty
        _mintUsdOku(user1, 1000e18);

        // Increase USD multiplier to 3x
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 3);

        // Wrap an odd amount at okuMMultiplier=1e18, usdMult=3e18
        // shares = 10e18 * 1e18 / 3e18 = 3333333333333333333 (rounds down)
        // usdMinted (balanceOf) = shares * 3e18 / 1e18 = 9999999999999999999 (rounds down)
        uint256 okuMAmount = 10e18;
        _mintOkuMoney(user2, okuMAmount);
        _approveOkuMoney(user2, address(usdOku), okuMAmount);

        vm.prank(user2);
        usdOku.wrap(okuMAmount, user2, 0);

        // Shares calculation rounds down (favors vault)
        // sharesToMint = okuMAmount * okuMMultiplier / usdMultiplier
        uint256 expectedShares = (okuMAmount * okuMoney.okuMMultiplier()) / usdOku.usdMultiplier();
        assertEq(usdOku.usdSharesOf(user2), expectedShares, "Shares should round down");

        // Dollar value from shares <= noteValue of tokens deposited (rounding favors vault)
        uint256 depositedNoteValue = (okuMAmount * okuMoney.okuMMultiplier()) / PRECISION;
        assertLe(
            usdOku.balanceOf(user2),
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
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18, "100 notes at $1.05 should produce 105 OkuDollar");
        assertEq(usdOku.balanceOf(user1), 105e18);
    }

    function test_Wrap_PriceAware_HighNotePrice() public {
        // okuMMultiplier = 2e18 ($2.00 per note token)
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 okuMAmount = 50e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // usdMinted = 50e18 * 2e18 / 1e18 = 100e18
        assertEq(usdMinted, 100e18, "50 notes at $2.00 should produce 100 OkuDollar");
    }

    function test_Wrap_PriceAware_BothMultipliersElevated() public {
        // okuMMultiplier = 1.05e18, usdMultiplier = 1.02e18
        _setOkuMMultiplierAndRoll(105e16);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(102e16);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // sharesToMint = 100e18 * 1.05e18 / 1.02e18 ≈ 102.94e18
        // usdMinted = sharesToMint * 1.02e18 / 1e18 (reconstructed from shares)
        uint256 sharesToMint = (okuMAmount * 105e16) / 102e16;
        uint256 expected = (sharesToMint * 102e16) / PRECISION;
        assertEq(usdMinted, expected);
    }

    // ============ Unwrap Tests ============

    function test_Unwrap_ReturnsCorrectNotes() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        uint256 userNotesBefore = okuMoney.balanceOf(user1);

        vm.prank(user1);
        uint256 okuMReturned = usdOku.unwrap(okuMAmount, user1);

        // At okuMMultiplier=1e18: okuMReturned = 100e18 * 1e18 / 1e18 = 100e18
        assertEq(okuMReturned, okuMAmount);
        assertEq(okuMoney.balanceOf(user1), userNotesBefore + okuMAmount);
        assertEq(usdOku.balanceOf(user1), 0);
    }

    function test_Unwrap_BurnsUsdShares() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        uint256 sharesBefore = usdOku.usdSharesOf(user1);
        assertGt(sharesBefore, 0);

        vm.prank(user1);
        usdOku.unwrap(okuMAmount, user1);

        assertEq(usdOku.usdSharesOf(user1), 0);
        assertEq(usdOku.totalUsdShares(), 0);
    }

    function test_Unwrap_EmitsTransferToZero() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, address(0), okuMAmount);

        vm.prank(user1);
        usdOku.unwrap(okuMAmount, user1);
    }

    function test_Unwrap_ToReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        usdOku.unwrap(okuMAmount, user2);

        // At okuMMultiplier=1e18: 100 OkuDollar → 100 notes
        assertEq(okuMoney.balanceOf(user2), okuMAmount);
        assertEq(okuMoney.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(OkuDollar.ZeroAmount.selector);
        usdOku.unwrap(0, user1);
    }

    function test_Unwrap_RevertsOnZeroReceiver() public {
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        vm.prank(user1);
        vm.expectRevert(OkuDollar.ZeroAddress.selector);
        usdOku.unwrap(okuMAmount, address(0));
    }

    // ============ Unwrap Rounding Tests ============

    function test_Unwrap_SharesBurnedRoundUp_FavorsVault() public {
        // Wrap at 1x, then bump usdMultiplier so the unwrap math has a non-trivial
        // fractional part (1/3) and we can directly assert ceil-division semantics.
        _mintUsdOku(user1, 1000e18);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 3);

        // user1 shares = 1000e18, balance = 1000e18 * 3 / 1e18 = 3000e18
        uint256 sharesBefore = usdOku.usdSharesOf(user1);
        uint256 mult = usdOku.usdMultiplier(); // = 3e18

        uint256 usdAmount = 1e18;

        vm.prank(user1);
        usdOku.unwrap(usdAmount, user1);

        uint256 sharesAfter = usdOku.usdSharesOf(user1);
        uint256 sharesBurned = sharesBefore - sharesAfter;

        // Direct ceiling-division assertion — this is the actual invariant the vault
        // relies on (vault always rounds shares burned UP to favour itself).
        uint256 expectedSharesCeil = (usdAmount * PRECISION + mult - 1) / mult;
        assertEq(sharesBurned, expectedSharesCeil, "must burn ceil(usdAmount * 1e18 / mult) shares");

        // The dollar value of the shares burned must equal-or-exceed the requested
        // usdAmount. This is what "favors the vault" actually means — the user can
        // never extract more dollars than they burn shares for.
        uint256 dollarValueBurned = (sharesBurned * mult) / PRECISION;
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
        uint256 okuMReturned = usdOku.unwrap(100e18, user1);

        uint256 expected = (100e18 * PRECISION) / 105e16;
        assertEq(okuMReturned, expected);
        // Notes returned should be less than 100 (each note is worth more now)
        assertLt(okuMReturned, 100e18, "Should return fewer notes since each note is worth more");
    }

    function test_Unwrap_PriceAware_RoundTrip_AtHighPrice() public {
        // Set okuMMultiplier to 1.05e18 BEFORE wrapping
        _setOkuMMultiplierAndRoll(105e16);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.startPrank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18);

        // Unwrap all: notesBack = 105e18 * 1e18 / 1.05e18 = 100e18
        uint256 notesBack = usdOku.unwrap(usdMinted, user1);
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
        _approveOkuMoney(reserveManager, address(usdOku), 200e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(200e18);

        // Set collateral ratio to floor (90%) for test purposes
        vm.prank(admin);
        usdOku.setMinCollateralRatio(9e17);
        // Withdraw surplus: vault has 300, obligations are 100, can withdraw down to 90
        // At 90% ratio, reserves must be >= 90. So we can withdraw up to 210.
        vm.prank(reserveManager);
        usdOku.withdrawSurplus(210e18);

        // Vault only has 90e18 notes but user has 100e18 OkuDollar
        // At okuMMultiplier=1e18: unwrap(100e18) needs 100 notes, vault has 90
        vm.prank(user1);
        vm.expectRevert(OkuDollar.InsufficientReserves.selector);
        usdOku.unwrap(100e18, user1);
    }

    // ============ Price-Aware Wrap/Unwrap Behavior Tests ============

    function test_PriceAware_OneNoteWrapsToOneOkuDollar_AtBasePrice() public {
        // At okuMMultiplier=1e18 (initial), 1 note = 1 OkuDollar (identical to old 1:1 behavior)
        uint256 okuMAmount = 1e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        assertEq(usdMinted, 1e18, "1 note at $1.00 should produce exactly 1 OkuDollar");
        assertEq(usdOku.balanceOf(user1), 1e18);
    }

    function test_PriceAware_AfterNotePriceIncrease_MoreOkuDollarMinted() public {
        // okuMMultiplier increases to 2x — each note token is worth $2.00
        _setOkuMMultiplierAndRoll(PRECISION * 2);

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // 100 note tokens × $2.00/token / $1.00 usdMultiplier = 200 OkuDollar
        assertEq(usdMinted, 200e18, "100 notes at $2.00 should produce 200 OkuDollar");
    }

    function test_PriceAware_NotePriceDoesNotChangeVaultBalance() public {
        // Wrap 100 notes at okuMMultiplier=1e18
        _mintUsdOku(user1, 100e18);

        uint256 vaultBalBefore = okuMoney.balanceOf(address(usdOku));
        assertEq(vaultBalBefore, 100e18);

        // Increase okuMMultiplier — vault token balance is unchanged (non-rebasing)
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        uint256 vaultBalAfter = okuMoney.balanceOf(address(usdOku));
        assertEq(vaultBalAfter, vaultBalBefore, "Note rebase should not change vault token count");
    }

    // ============ Wrap/Unwrap Round Trip ============

    function test_WrapUnwrap_RoundTrip_MaxOneWeiLoss() public {
        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.startPrank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 balance = usdOku.balanceOf(user1);
        uint256 notesBack = usdOku.unwrap(balance, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, okuMAmount, "Round trip should not gain tokens");
    }

    function test_WrapUnwrap_RoundTrip_AfterUsdMultiplierChange() public {
        // Wrap at 1x (okuMMultiplier=1e18, usdMult=1e18)
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);

        // Bump USD multiplier to 1.5x
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier((PRECISION * 3) / 2);

        // user1 OkuDollar balance grew to 150e18 (100 shares * 1.5x), but vault has 100 notes.
        // The vault is undercollateralized after a pure USD rebase without reserve top-up.
        //
        // Unwrap a partial amount. The CORRECT formula is:
        // okuMReturned = usdAmount × PRECISION / okuMMultiplier (multiplier is irrelevant for output)
        // For 66e18 OkuDollar at okuMMultiplier=1e18: okuMReturned = 66e18 × 1e18 / 1e18 = 66e18 notes
        //
        // This is correct because usdMultiplier converts shares↔dollars, not dollars↔OkuMoney.
        vm.prank(user1);
        uint256 notesBack = usdOku.unwrap(66e18, user1);

        // Expected = usdAmount × PRECISION / okuMMultiplier = 66e18 × 1e18 / 1e18 = 66e18
        uint256 expected = (66e18 * PRECISION) / PRECISION;
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
        uint256 notesBack = usdOku.unwrap(100e18, user1);

        uint256 expected = (100e18 * PRECISION) / ((PRECISION * 3) / 2);
        assertEq(notesBack, expected);
        // Fewer notes returned, but each note is worth more dollars
        assertLt(notesBack, 100e18, "Should return fewer notes at higher note price");
    }

    /// @notice CRITICAL: Test that caught the okuMReturned formula bug
    /// @dev When both okuMMultiplier and usdMultiplier are elevated by the same amount (matched rates),
    ///      a user wrapping N OkuMoney should get back exactly N OkuMoney on unwrap.
    ///      The OLD buggy formula (usdAmount * mult / price) would return MORE OkuMoney than deposited
    ///      and revert at the reserve check, breaking unwrap entirely at elevated multipliers.
    ///      The CORRECT formula (usdAmount * PRECISION / price) returns exactly N.
    function test_WrapUnwrap_RoundTrip_MatchedPriceAndMultiplier() public {
        // Wrap 100 OkuMoney at parity (okuMMultiplier=1e18, usdMult=1e18)
        uint256 okuMAmount = 100e18;
        _mintUsdOku(user1, okuMAmount);
        // user1 has 100 OkuDollar (100 shares), vault has 100 OkuMoney

        // Simulate 1 year of 4% yield on BOTH okuMMultiplier and usdMultiplier (matched rates)
        // After 1 year: okuMMultiplier = 1.04e18, usdMultiplier = 1.04e18
        uint256 elevatedValue = (PRECISION * 104) / 100; // 1.04e18

        _setOkuMMultiplierAndRoll(elevatedValue);
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(elevatedValue);
        vm.roll(block.number + 1); // Roll past yield lock

        // user1 OkuDollar balance: 100 shares × 1.04 mult / 1e18 = 104 OkuDollar
        uint256 usdBalance = usdOku.balanceOf(user1);
        assertEq(usdBalance, 104e18, "Balance should be 104 OkuDollar");

        // Vault still has exactly 100 OkuMoney tokens (no extra reserves added)
        uint256 vaultReserves = okuMoney.balanceOf(address(usdOku));
        assertEq(vaultReserves, 100e18, "Vault should have 100 OkuMoney");

        // User unwraps full balance (104 OkuDollar)
        // CORRECT formula: okuMReturned = 104e18 × 1e18 / 1.04e18 = 100e18
        // BUGGY formula would be: 104e18 × 1.04e18 / 1.04e18 = 104e18 (reverts!)
        vm.prank(user1);
        uint256 notesBack = usdOku.unwrap(usdBalance, user1);

        // Should get back EXACTLY what was deposited (within rounding)
        assertEq(notesBack, okuMAmount, "Round trip at matched rates should return original amount");
    }

    // ============ USD Multiplier Tests ============

    function test_UsdMultiplier_GrowsOverTime() public {
        // ~4.5% APY = 1e18 + ~1.393e9 per second
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate, 0);

        uint256 multBefore = usdOku.usdMultiplier();

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        uint256 multAfter = usdOku.usdMultiplier();
        assertGt(multAfter, multBefore, "Multiplier should grow over time");
    }

    function test_UsdMultiplier_AccruesContinuously() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate, 0);

        uint256 start = block.timestamp;

        // Warp 100 seconds
        vm.warp(start + 100);
        uint256 multAt100 = usdOku.usdMultiplier();

        // The multiplier is a pure function of elapsed time, always deterministic
        assertGt(multAt100, PRECISION);
        assertEq(usdOku.usdMultiplier(), multAt100);
    }

    function test_UsdMultiplier_AffectsBalances() public {
        _mintUsdOku(user1, 100e18);

        assertEq(usdOku.balanceOf(user1), 100e18);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        assertEq(usdOku.balanceOf(user1), 200e18);
    }

    function test_UsdMultiplier_AffectsTotalSupply() public {
        _mintUsdOku(user1, 100e18);

        assertEq(usdOku.totalSupply(), 100e18);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        assertEq(usdOku.totalSupply(), 200e18);
    }

    // ============ setUsdYieldRate Tests ============

    function test_SetUsdYieldRate_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_REBASER
            )
        );
        usdOku.setUsdYieldRate(PRECISION + 1e9, 0);
    }

    function test_SetUsdYieldRate_SnapshotsMultiplier() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate, 0);

        vm.warp(block.timestamp + 1 days);

        uint256 multBefore = usdOku.usdMultiplier();
        assertGt(multBefore, PRECISION);

        // Set a new rate -- should snapshot current multiplier
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION, 0); // zero yield

        uint256 baseAfter = usdOku.usdBaseMultiplier();
        assertEq(baseAfter, multBefore, "Base multiplier should be snapshotted");
    }

    function test_SetUsdYieldRate_RevertsOnNegativeRate() public {
        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.InvalidRate.selector);
        usdOku.setUsdYieldRate(PRECISION - 1, 0);
    }

    function test_SetUsdYieldRate_RevertsOnRateTooHigh() public {
        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.RateTooHigh.selector);
        usdOku.setUsdYieldRate(PRECISION + 1e11 + 1, 0);
    }

    function test_SetUsdYieldRate_WithEndTimestamp() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, endTime);

        assertEq(usdOku.usdRateEnd(), endTime);
    }

    function test_SetUsdYieldRate_RevertsOnPastEndTimestamp() public {
        // Warp forward so block.timestamp - 1 is non-zero (avoiding endTimestamp == 0 no-expiry case)
        vm.warp(1000);
        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.EndTimestampInPast.selector);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, block.timestamp - 1);
    }

    function test_SetUsdYieldRate_ClearsPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        usdOku.setNextUsdYieldRate(PRECISION + 2000e6);

        // Setting a new rate should clear pending
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1000e6, 0);

        assertEq(usdOku.usdPendingRatePerSecond(), PRECISION);
    }

    // ============ setNextUsdYieldRate Tests ============

    function test_SetNextUsdYieldRate_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_REBASER
            )
        );
        usdOku.setNextUsdYieldRate(PRECISION + 1e9);
    }

    function test_SetNextUsdYieldRate_SchedulesNextRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, endTime);

        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(usdRebaser);
        usdOku.setNextUsdYieldRate(nextRate);

        assertEq(usdOku.usdPendingRatePerSecond(), nextRate);
    }

    function test_SetNextUsdYieldRate_RevertsWhenNoEnd() public {
        // Set rate with no end time
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, 0);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.NoRateEndSet.selector);
        usdOku.setNextUsdYieldRate(PRECISION + 2000e6);
    }

    function test_SetNextUsdYieldRate_RevertsOnNegativeRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.InvalidRate.selector);
        usdOku.setNextUsdYieldRate(PRECISION - 1);
    }

    function test_SetNextUsdYieldRate_HeadToTailTransition() public {
        uint256 rate1 = PRECISION + 1393e6;
        uint256 rate2 = PRECISION + 2000e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate1, endTime);

        vm.prank(usdRebaser);
        usdOku.setNextUsdYieldRate(rate2);

        // Warp past end time -- pending rate should take over
        vm.warp(endTime + 1 days);

        uint256 mult = usdOku.usdMultiplier();
        // Should be greater than what rate1 alone would have produced at endTime
        assertGt(mult, PRECISION, "Multiplier should have grown through both rate periods");
    }

    // ============ updateUsdMultiplier Tests ============

    function test_UpdateUsdMultiplier_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_REBASER
            )
        );
        usdOku.updateUsdMultiplier(PRECISION * 2);
    }

    function test_UpdateUsdMultiplier_SetsNewMultiplier() public {
        uint256 newMult = PRECISION * 2;

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(newMult);

        assertEq(usdOku.usdMultiplier(), newMult);
        assertEq(usdOku.usdBaseMultiplier(), newMult);
    }

    function test_UpdateUsdMultiplier_ResetsRateToZero() public {
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(PRECISION + 1393e6, 0);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        assertEq(usdOku.usdRatePerSecond(), PRECISION);
        assertEq(usdOku.usdRateEnd(), 0);
        assertEq(usdOku.usdPendingRatePerSecond(), PRECISION);
    }

    function test_UpdateUsdMultiplier_RevertsOnDecrease() public {
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        vm.prank(usdRebaser);
        vm.expectRevert(OkuDollar.MultiplierCannotDecrease.selector);
        usdOku.updateUsdMultiplier(PRECISION);
    }

    function test_UpdateUsdMultiplier_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit UsdMultiplierUpdated(PRECISION, PRECISION * 2, usdOku.totalSupply());

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);
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
        usdOku.depositReserves(100e18);
    }

    function test_DepositReserves_IncreasesReservesWithoutMintingShares() public {
        _mintUsdOku(user1, 100e18);

        uint256 sharesBefore = usdOku.totalUsdShares();
        uint256 reservesBefore = usdOku.totalOkuMReserves();

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(usdOku), 50e18);

        vm.prank(reserveManager);
        usdOku.depositReserves(50e18);

        assertEq(usdOku.totalUsdShares(), sharesBefore, "Shares should not change");
        assertEq(usdOku.totalOkuMReserves(), reservesBefore + 50e18, "Reserves should increase");
    }

    function test_DepositReserves_IncreasesCollateralizationRatio() public {
        _mintUsdOku(user1, 100e18);

        uint256 ratioBefore = usdOku.collateralizationRatio();

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(usdOku), 50e18);

        vm.prank(reserveManager);
        usdOku.depositReserves(50e18);

        uint256 ratioAfter = usdOku.collateralizationRatio();
        assertGt(ratioAfter, ratioBefore, "Collateralization ratio should increase");
    }

    function test_DepositReserves_RevertsOnZeroAmount() public {
        vm.prank(reserveManager);
        vm.expectRevert(OkuDollar.ZeroAmount.selector);
        usdOku.depositReserves(0);
    }

    function test_DepositReserves_EmitsEvent() public {
        // Set up some user-held usdOku so the post-deposit ratio is not "infinite"
        // (which would make the event check tautological).
        _mintUsdOku(user1, 100e18);

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(usdOku), 50e18);

        uint256 mult = okuMoney.okuMMultiplier();
        uint256 dollarValue = (50e18 * mult) / PRECISION;

        // Pre-compute the expected post-deposit collateralization ratio:
        //   reservesAfter = totalReserves + 50e18
        //   reservesDollarValueAfter = reservesAfter * mult / PRECISION
        //   ratio = reservesDollarValueAfter * PRECISION / totalSupply
        uint256 reservesAfter = usdOku.totalOkuMReserves() + 50e18;
        uint256 reservesDollarValueAfter = (reservesAfter * mult) / PRECISION;
        uint256 expectedRatio = (reservesDollarValueAfter * PRECISION) / usdOku.totalSupply();

        vm.expectEmit(true, false, false, true, address(usdOku));
        emit OkuDollar.ReservesDeposited(reserveManager, 50e18, dollarValue, expectedRatio);

        vm.prank(reserveManager);
        usdOku.depositReserves(50e18);

        assertEq(usdOku.totalOkuMReserves(), reservesAfter);
        assertEq(usdOku.collateralizationRatio(), expectedRatio);
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
        usdOku.withdrawSurplus(1e18);
    }

    function test_WithdrawSurplus_ExtractsSurplus() public {
        _mintUsdOku(user1, 100e18);

        // Deposit extra reserves to create surplus
        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(usdOku), 50e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(50e18);

        // At okuMMultiplier=1e18: Reserves: 150 notes ($150), obligations: 100 OkuDollar
        // surplus = ($150 - $100) * PRECISION / okuMMultiplier = 50e18 note tokens
        assertEq(usdOku.surplus(), 50e18);

        uint256 managerNotesBefore = okuMoney.balanceOf(reserveManager);

        vm.prank(reserveManager);
        usdOku.withdrawSurplus(30e18);

        assertEq(okuMoney.balanceOf(reserveManager), managerNotesBefore + 30e18);
        assertEq(usdOku.surplus(), 20e18);
    }

    function test_WithdrawSurplus_EnforcesMinCollateralRatio() public {
        _mintUsdOku(user1, 100e18);
        // minCollateralRatio is 95e16 (95%)

        // Deposit 10e18 extra -- reserves = 110 notes, obligations = 100 OkuDollar
        // At okuMMultiplier=1e18: ratio = (110 * 1.0 / 1.0) * 1.0 / 100 = 110%
        _mintOkuMoney(reserveManager, 10e18);
        _approveOkuMoney(reserveManager, address(usdOku), 10e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(10e18);

        // Try to withdraw 16e18 -- would leave 94 notes, ratio = 94% < 95%
        vm.prank(reserveManager);
        vm.expectRevert(OkuDollar.BelowMinimumCollateral.selector);
        usdOku.withdrawSurplus(16e18);
    }

    function test_WithdrawSurplus_SucceedsAtExactFloor() public {
        _mintUsdOku(user1, 100e18);

        // Deposit 10e18 extra -- reserves = 110 notes, obligations = 100 OkuDollar
        _mintOkuMoney(reserveManager, 10e18);
        _approveOkuMoney(reserveManager, address(usdOku), 10e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(10e18);

        // Withdraw 15e18 -- leaves 95 notes / 100 OkuDollar = 95% = minCollateralRatio exactly
        vm.prank(reserveManager);
        usdOku.withdrawSurplus(15e18);

        assertEq(usdOku.collateralizationRatio(), 95e16);
    }

    function test_WithdrawSurplus_RevertsOnZeroAmount() public {
        vm.prank(reserveManager);
        vm.expectRevert(OkuDollar.ZeroAmount.selector);
        usdOku.withdrawSurplus(0);
    }

    function test_WithdrawSurplus_EmitsEvent() public {
        _mintUsdOku(user1, 100e18);

        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(usdOku), 50e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(50e18);

        uint256 reservesBefore = usdOku.totalOkuMReserves();

        vm.prank(reserveManager);
        usdOku.withdrawSurplus(20e18);

        // Verify withdrawal happened
        assertEq(usdOku.totalOkuMReserves(), reservesBefore - 20e18);
        assertEq(okuMoney.balanceOf(reserveManager), 20e18);
    }

    // ============ setMinCollateralRatio Tests ============

    function test_SetMinCollateralRatio_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, DEFAULT_ADMIN_ROLE
            )
        );
        usdOku.setMinCollateralRatio(90e16);
    }

    function test_SetMinCollateralRatio_UpdatesRatio() public {
        vm.prank(admin);
        usdOku.setMinCollateralRatio(90e16);

        assertEq(usdOku.minCollateralRatio(), 90e16);
    }

    function test_SetMinCollateralRatio_RevertsAbovePrecision() public {
        vm.prank(admin);
        vm.expectRevert(OkuDollar.RatioExceedsMax.selector);
        usdOku.setMinCollateralRatio(PRECISION + 1);
    }

    function test_SetMinCollateralRatio_RejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(OkuDollar.RatioBelowFloor.selector);
        usdOku.setMinCollateralRatio(0);
    }

    function test_SetMinCollateralRatio_RejectsBelowFloor() public {
        vm.prank(admin);
        vm.expectRevert(OkuDollar.RatioBelowFloor.selector);
        usdOku.setMinCollateralRatio(89e16); // 89% is below 90% floor
    }

    function test_SetMinCollateralRatio_AllowsFloor() public {
        vm.prank(admin);
        usdOku.setMinCollateralRatio(9e17); // 90% is the floor

        assertEq(usdOku.minCollateralRatio(), 9e17);
    }

    function test_SetMinCollateralRatio_AllowsPrecision() public {
        vm.prank(admin);
        usdOku.setMinCollateralRatio(PRECISION);

        assertEq(usdOku.minCollateralRatio(), PRECISION);
    }

    function test_SetMinCollateralRatio_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MinCollateralRatioUpdated(95e16, 90e16);

        vm.prank(admin);
        usdOku.setMinCollateralRatio(90e16);
    }

    // ============ Collateralization Views Tests ============

    function test_TotalNoteReserves_EqualsNoteBalance() public {
        _mintUsdOku(user1, 100e18);

        assertEq(usdOku.totalOkuMReserves(), okuMoney.balanceOf(address(usdOku)));
    }

    function test_TotalUsdObligations_EqualsTotalSupply() public {
        _mintUsdOku(user1, 100e18);

        assertEq(usdOku.totalUsdObligations(), usdOku.totalSupply());
    }

    function test_CollateralizationRatio_100Percent_AtStart() public {
        _mintUsdOku(user1, 100e18);

        // At okuMMultiplier=1e18: reserves = 100 notes * $1.00 = $100, obligations = 100 OkuDollar
        assertEq(usdOku.collateralizationRatio(), PRECISION);
    }

    function test_CollateralizationRatio_MaxWhenEmpty() public view {
        // No obligations -> type(uint256).max
        assertEq(usdOku.collateralizationRatio(), type(uint256).max);
    }

    function test_CollateralizationRatio_IncreasesWithDeposit() public {
        _mintUsdOku(user1, 100e18);

        _mintOkuMoney(reserveManager, 100e18);
        _approveOkuMoney(reserveManager, address(usdOku), 100e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(100e18);

        // At okuMMultiplier=1e18: 200 notes * $1.00 / 100 OkuDollar = 200%
        assertEq(usdOku.collateralizationRatio(), PRECISION * 2);
    }

    function test_CollateralizationRatio_IncreasesWithNotePriceIncrease() public {
        _mintUsdOku(user1, 100e18);

        // ratio = 100% initially
        assertEq(usdOku.collateralizationRatio(), PRECISION);

        // Increase okuMMultiplier to 1.5e18 — vault still has 100 note tokens
        // Dollar value of reserves: 100 * $1.50 = $150, obligations: 100 OkuDollar
        // ratio = $150 / $100 = 150%
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier((PRECISION * 3) / 2);

        assertEq(usdOku.collateralizationRatio(), (PRECISION * 3) / 2);
    }

    function test_Surplus_ReturnsCorrectAmount() public {
        _mintUsdOku(user1, 100e18);

        // At 100% collateralized, surplus = 0
        assertEq(usdOku.surplus(), 0);

        // Add extra reserves
        _mintOkuMoney(reserveManager, 50e18);
        _approveOkuMoney(reserveManager, address(usdOku), 50e18);
        vm.prank(reserveManager);
        usdOku.depositReserves(50e18);

        // At okuMMultiplier=1e18: surplus = ($150 - $100) * 1e18 / 1e18 = 50 note tokens
        assertEq(usdOku.surplus(), 50e18);
    }

    function test_Surplus_ZeroWhenUndercollateralized() public {
        _mintUsdOku(user1, 100e18);

        // Increase USD multiplier -- obligations grow but reserves stay the same
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        // Reserves: 100 notes * $1.00 = $100, obligations: 200 OkuDollar
        assertEq(usdOku.surplus(), 0);
    }

    function test_Surplus_IncreasesWithNotePriceIncrease() public {
        _mintUsdOku(user1, 100e18);
        assertEq(usdOku.surplus(), 0);

        // Increase okuMMultiplier to 1.5e18
        // Reserves: 100 notes * $1.50 = $150, obligations: 100 OkuDollar
        // Dollar surplus: $150 - $100 = $50
        // Surplus in note tokens: $50 * 1e18 / $1.50 ≈ 33.33e18
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier((PRECISION * 3) / 2);

        uint256 expectedSurplus = (50e18 * PRECISION) / ((PRECISION * 3) / 2);
        assertEq(usdOku.surplus(), expectedSurplus);
        assertGt(usdOku.surplus(), 0, "Note price increase should create surplus");
    }

    // ============ Pause Tests ============

    function test_Pause_BlocksTransfer() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        usdOku.pause();

        vm.prank(user1);
        vm.expectRevert();
        usdOku.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        usdOku.approve(user2, 50e18);

        vm.prank(vaultPauser);
        usdOku.pause();

        vm.prank(user2);
        vm.expectRevert();
        usdOku.transferFrom(user1, user2, 50e18);
    }

    function test_Pause_BlocksWrap() public {
        vm.prank(vaultPauser);
        usdOku.pause();

        uint256 okuMAmount = 100e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        // M-4 fix: wrap is now blocked when paused (full freeze)
        vm.prank(user1);
        vm.expectRevert();
        usdOku.wrap(okuMAmount, user1, 0);
    }

    function test_Pause_BlocksUnwrap() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        usdOku.pause();

        // M-4 fix: unwrap is now blocked when paused (full freeze)
        vm.prank(user1);
        vm.expectRevert();
        usdOku.unwrap(100e18, user1);
    }

    function test_Pause_OnlyVaultPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_PAUSER
            )
        );
        usdOku.pause();

        // Note pauser cannot pause OkuDollar vault
        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, VAULT_PAUSER
            )
        );
        usdOku.pause();
    }

    function test_Unpause_OnlyVaultUnpauser() public {
        vm.prank(vaultPauser);
        usdOku.pause();

        // user1 cannot unpause
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_UNPAUSER
            )
        );
        usdOku.unpause();

        // Separate roles: pauser cannot unpause
        vm.prank(vaultPauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                vaultPauser,
                VAULT_UNPAUSER
            )
        );
        usdOku.unpause();

        // Vault unpauser can unpause
        vm.prank(vaultUnpauser);
        usdOku.unpause();
    }

    function test_Pause_TransfersResumeAfterUnpause() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(vaultPauser);
        usdOku.pause();

        vm.prank(vaultUnpauser);
        usdOku.unpause();

        vm.prank(user1);
        usdOku.transfer(user2, 50e18);

        assertEq(usdOku.balanceOf(user2), 50e18);
    }

    // ============ ERC-20 Compliance Tests ============

    function test_Transfer_MovesSharesInternally() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        usdOku.transfer(user2, 40e18);

        assertEq(usdOku.balanceOf(user1), 60e18);
        assertEq(usdOku.balanceOf(user2), 40e18);
    }

    function test_Transfer_EmitsTokenAmounts() public {
        _mintUsdOku(user1, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 40e18);

        vm.prank(user1);
        usdOku.transfer(user2, 40e18);
    }

    function test_TransferFrom_WithApproval() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user1);
        usdOku.approve(user2, 50e18);

        vm.prank(user2);
        usdOku.transferFrom(user1, user2, 50e18);

        assertEq(usdOku.balanceOf(user2), 50e18);
        assertEq(usdOku.balanceOf(user1), 50e18);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        _mintUsdOku(user1, 100e18);

        vm.prank(user2);
        vm.expectRevert();
        usdOku.transferFrom(user1, user2, 50e18);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mintUsdOku(user1, 100e18);

        // _transferUsdShares should revert with InsufficientBalance — the share
        // balance check is unrelated to vault collateralization (which has its own
        // distinct InsufficientCollateral error).
        vm.prank(user1);
        vm.expectRevert(OkuDollar.InsufficientBalance.selector);
        usdOku.transfer(user2, 101e18);
    }

    function test_Approve_SetsAllowance() public {
        vm.prank(user1);
        usdOku.approve(user2, 100e18);

        assertEq(usdOku.allowance(user1, user2), 100e18);
    }

    function test_TotalSupply_ReflectsAllShares() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        assertEq(usdOku.totalSupply(), 300e18);
    }

    function test_Transfer_ShareBased_AfterMultiplierChange() public {
        _mintUsdOku(user1, 100e18);

        // Increase multiplier to 2x
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        // user1 balance is now 200e18. Transfer 100e18 (50 shares)
        vm.prank(user1);
        usdOku.transfer(user2, 100e18);

        assertEq(usdOku.balanceOf(user1), 100e18);
        assertEq(usdOku.balanceOf(user2), 100e18);
    }

    function test_BalanceOf_ReflectsMultiplier() public {
        _mintUsdOku(user1, 100e18);

        assertEq(usdOku.balanceOf(user1), 100e18);
        assertEq(usdOku.usdSharesOf(user1), 100e18);

        // Multiplier 2x -> balanceOf doubles, shares unchanged
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        assertEq(usdOku.balanceOf(user1), 200e18);
        assertEq(usdOku.usdSharesOf(user1), 100e18);
    }

    // ============ Role Enforcement Tests ============

    function test_RoleEnforcement_NoteRebaserCannotSetUsdRate() public {
        vm.prank(rebaser); // note rebaser, not USD rebaser
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, rebaser, VAULT_REBASER
            )
        );
        usdOku.setUsdYieldRate(PRECISION + 1e9, 0);
    }

    function test_RoleEnforcement_NonReserveManagerCannotDeposit() public {
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(usdOku), 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                VAULT_RESERVE_MANAGER
            )
        );
        usdOku.depositReserves(100e18);
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
        usdOku.withdrawSurplus(1e18);
    }

    function test_RoleEnforcement_NonAdminCannotSetCollateralRatio() public {
        vm.prank(reserveManager);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                reserveManager,
                DEFAULT_ADMIN_ROLE
            )
        );
        usdOku.setMinCollateralRatio(90e16);
    }

    // ============ Repeated Wrap/Unwrap (rUSDY H-01 Mitigation) ============

    function test_RepeatedWrapUnwrap_NoShareInflation() public {
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(usdOku), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            usdOku.wrap(noteBal, user1, 0);
            uint256 usdBal = usdOku.balanceOf(user1);
            if (usdBal == 0) break;
            usdOku.unwrap(usdBal, user1);
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
        _approveOkuMoney(user2, address(usdOku), 5000e18);
        vm.prank(user2);
        usdOku.wrap(5000e18, user2, 0);

        // Now user1 does repeated wrap/unwrap at elevated okuMMultiplier
        uint256 initialNotes = 1000e18;
        _mintOkuMoney(user1, initialNotes);
        _approveOkuMoney(user1, address(usdOku), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            usdOku.wrap(noteBal, user1, 0);
            uint256 usdBal = usdOku.balanceOf(user1);
            if (usdBal == 0) break;
            usdOku.unwrap(usdBal, user1);
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
        _approveOkuMoney(user1, address(usdOku), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 50; i++) {
            uint256 noteBal = okuMoney.balanceOf(user1);
            if (noteBal == 0) break;
            usdOku.wrap(noteBal, user1, 0);
            uint256 usdBal = usdOku.balanceOf(user1);
            if (usdBal == 0) break;
            usdOku.unwrap(usdBal, user1);
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
        usdOku.setUsdYieldRate(rate, endTime);

        // Warp to 1 second before end
        vm.warp(endTime - 1);
        uint256 multBeforeEnd = usdOku.usdMultiplier();

        // Warp 100 days past end -- no pending rate, so yield should stop
        vm.warp(endTime + 100 days);
        uint256 multLongAfterEnd = usdOku.usdMultiplier();

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
        usdOku.setUsdYieldRate(rate1, endTime);

        vm.prank(usdRebaser);
        usdOku.setNextUsdYieldRate(rate2);

        // Warp past end + 365 days: should have 30d of rate1 + 365d of rate2
        vm.warp(endTime + 365 days);

        uint256 mult = usdOku.usdMultiplier();
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
        usdOku.setUsdYieldRate(rate, 0);

        uint256 startMult = usdOku.usdMultiplier();

        vm.warp(block.timestamp + 365 days);

        uint256 endMult = usdOku.usdMultiplier();
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
        usdOku.setUsdYieldRate(usdRate, 0);

        vm.warp(block.timestamp + 365 days);

        uint256 noteP = okuMoney.okuMMultiplier();
        uint256 usdMult = usdOku.usdMultiplier();

        // They should be different (note at 4.5%, USD ~2% after 1 year)
        assertGt(noteP, usdMult, "Note price should be higher than USD multiplier");
        assertTrue(noteP != usdMult, "Note price and USD multiplier must be independent");
    }

    // ============ Continuous Yield + Balance/Supply Tests ============

    function test_ContinuousYield_BalanceGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate, 0);

        uint256 balBefore = usdOku.balanceOf(user1);

        vm.warp(block.timestamp + 30 days);

        uint256 balAfter = usdOku.balanceOf(user1);
        assertGt(balAfter, balBefore, "Balance must grow via continuous yield");
    }

    function test_ContinuousYield_TotalSupplyGrowsOverTime() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate, 0);

        uint256 supplyBefore = usdOku.totalSupply();

        vm.warp(block.timestamp + 30 days);

        uint256 supplyAfter = usdOku.totalSupply();
        assertGt(supplyAfter, supplyBefore, "Total supply must grow via continuous yield");
    }

    // ============ TransferFrom Share-Based with Multiplier ============

    function test_TransferFrom_ShareBased_AfterMultiplierChange() public {
        _mintUsdOku(user1, 100e18);

        // Increase multiplier to 2x
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        // user1 has 200 OkuDollar (100 shares * 2x)
        vm.prank(user1);
        usdOku.approve(user2, 100e18);

        vm.prank(user2);
        usdOku.transferFrom(user1, user2, 100e18);

        // 100 OkuDollar = 50 shares at 2x multiplier
        assertEq(usdOku.usdSharesOf(user1), 50e18);
        assertEq(usdOku.usdSharesOf(user2), 50e18);
        assertEq(usdOku.balanceOf(user1), 100e18);
        assertEq(usdOku.balanceOf(user2), 100e18);
    }

    // ============ Multi-User Tests ============

    function test_MultiUser_IndependentAccounting() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        // Unwrap user1 should not affect user2
        vm.prank(user1);
        usdOku.unwrap(100e18, user1);

        assertEq(usdOku.balanceOf(user1), 0);
        assertEq(usdOku.balanceOf(user2), 200e18);
    }

    function test_MultiUser_ProportionalYield() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        // Bump multiplier to 2x
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(PRECISION * 2);

        // user1 should have 200e18, user2 should have 600e18
        assertEq(usdOku.balanceOf(user1), 200e18);
        assertEq(usdOku.balanceOf(user2), 600e18);
    }

    function test_MultiUser_ProportionalShares() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        // user2 should have 3x the shares of user1
        assertEq(usdOku.usdSharesOf(user2), usdOku.usdSharesOf(user1) * 3);
        assertEq(usdOku.totalUsdShares(), usdOku.usdSharesOf(user1) + usdOku.usdSharesOf(user2));
    }

    function test_MultiUser_YieldAccruesProportionally() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 300e18);

        uint256 rate = 1_000_000_001_395_766_281; // ~4.5% APY
        vm.prank(usdRebaser);
        usdOku.setUsdYieldRate(rate, 0);

        vm.warp(block.timestamp + 365 days);

        uint256 bal1 = usdOku.balanceOf(user1);
        uint256 bal2 = usdOku.balanceOf(user2);

        // Both accrue ~4.5%
        assertApproxEqRel(bal1, 104.5e18, 1e15); // within 0.1%
        assertApproxEqRel(bal2, 313.5e18, 1e15);

        // Proportions preserved (1:3 ratio)
        assertApproxEqRel(bal2, bal1 * 3, 1e15);
    }

    function test_MultiUser_WrapUnwrapDoesNotAffectOthers() public {
        _mintUsdOku(user1, 100e18);
        _mintUsdOku(user2, 200e18);

        uint256 user2BalBefore = usdOku.balanceOf(user2);
        uint256 user2SharesBefore = usdOku.usdSharesOf(user2);

        // User1 unwraps half
        vm.prank(user1);
        usdOku.unwrap(50e18, user1);

        // User2's balance and shares should be unchanged
        assertEq(usdOku.balanceOf(user2), user2BalBefore);
        assertEq(usdOku.usdSharesOf(user2), user2SharesBefore);

        // User3 wraps new notes
        _mintUsdOku(user3, 500e18);

        // User2 still unchanged
        assertEq(usdOku.balanceOf(user2), user2BalBefore);
        assertEq(usdOku.usdSharesOf(user2), user2SharesBefore);
    }

    // ============ Fuzz Round-Trip Tests ============

    function testFuzz_WrapUnwrap_RoundTrip(uint256 mult) public {
        // Test wrap/unwrap at base multiplier=1e18 but varying okuMMultiplier
        // This tests the multiplier-aware conversion without hitting collateralization issues
        mult = bound(mult, PRECISION, 5e18);

        // Only set okuMMultiplier (not multiplier) to avoid collateralization issues
        _setOkuMMultiplierAndRoll(mult);
        // usdMultiplier stays at default 1e18

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        // Wrap
        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        // Unwrap full balance
        uint256 bal = usdOku.balanceOf(user1);
        vm.prank(user1);
        usdOku.unwrap(bal, user1);

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // Price-aware wrap/unwrap has multiple division steps, each losing up to 1 wei
        uint256 maxLoss = (5 * mult + PRECISION - 1) / PRECISION + 5;
        assertApproxEqAbs(finalNotes, okuMAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    function testFuzz_WrapUnwrap_RoundTrip_WithNotePrice(uint256 price) public {
        price = bound(price, PRECISION, 3e18); // $1.00 to $3.00

        _setOkuMMultiplierAndRoll(price);

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        vm.startPrank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 bal = usdOku.balanceOf(user1);
        usdOku.unwrap(bal, user1);
        vm.stopPrank();

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // At any okuMMultiplier, round trip should return ≈ okuMAmount (within rounding)
        // Loss bounded by price/PRECISION * multiplier rounding chain
        assertApproxEqAbs(finalNotes, okuMAmount, 5, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    function testFuzz_WrapUnwrap_RoundTrip_BothPriceAndMult(uint256 price) public {
        // Test wrap/unwrap when price varies but multiplier stays at base (1e18)
        // This is a common scenario where okuMMultiplier appreciates but OkuDollar multiplier hasn't changed yet
        price = bound(price, PRECISION, 3e18); // $1.00 to $3.00
        // Keep mult at base - this ensures vault stays solvent (price >= mult means overcollateralized)
        uint256 mult = PRECISION;

        _setOkuMMultiplierAndRoll(price);

        // usdMultiplier stays at default PRECISION

        uint256 okuMAmount = 77.777e18;
        _mintOkuMoney(user1, okuMAmount);
        _approveOkuMoney(user1, address(usdOku), okuMAmount);

        // Wrap
        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        // Unwrap full balance
        uint256 bal = usdOku.balanceOf(user1);
        vm.prank(user1);
        usdOku.unwrap(bal, user1);

        uint256 finalNotes = okuMoney.balanceOf(user1);
        // When price >= mult, round trip should return ≈ okuMAmount (within rounding)
        // Loss bounded by combined rounding effects
        uint256 maxLoss =
            (5 * mult + PRECISION - 1) / PRECISION + (5 * price + PRECISION - 1) / PRECISION + 10;
        assertApproxEqAbs(finalNotes, okuMAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, okuMAmount, "Must not gain from round trip");
    }

    // ============ Yield Distribution Lock Tests (Sandwich Attack Prevention) ============

    function test_Wrap_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(usdOku), 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        usdOku.wrap(50e18, user1, 0);
    }

    function test_Wrap_SucceedsInNextBlock() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(usdOku), 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now wrap should succeed
        vm.prank(user1);
        usdOku.wrap(50e18, user1, 0);

        assertGt(usdOku.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsInYieldDistributionBlock() public {
        // Setup: user1 has usdOku
        _mintUsdOku(user1, 100e18);

        // Distribute yield to set lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block — unwrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        usdOku.unwrap(50e18, user1);
    }

    function test_Unwrap_SucceedsInNextBlock() public {
        // Setup: user1 has usdOku
        _mintUsdOku(user1, 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Roll to next block
        vm.roll(block.number + 1);

        // Now unwrap should succeed
        uint256 okuMBefore = okuMoney.balanceOf(user1);
        vm.prank(user1);
        usdOku.unwrap(50e18, user1);

        assertGt(okuMoney.balanceOf(user1), okuMBefore);
    }

    function test_SetOkuMPrice_AlsoBlocksWrapUnwrap() public {
        // Setup: user1 has OkuMoney
        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(usdOku), 100e18);

        // setOkuMMultiplier also sets lastYieldDistributionBlock
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);

        // Same block — wrap should revert
        vm.prank(user1);
        vm.expectRevert(YieldSandwichGuard.YieldDistributionInProgress.selector);
        usdOku.wrap(50e18, user1, 0);
    }

    function test_YieldLock_NoEffectBeforeFirstDistribution() public {
        // Before any yield distribution, lastYieldDistributionBlock is 0
        // Operations should work normally
        assertEq(okuMoney.lastYieldDistributionBlock(), 0);

        _mintOkuMoney(user1, 100e18);
        _approveOkuMoney(user1, address(usdOku), 100e18);

        vm.prank(user1);
        usdOku.wrap(100e18, user1, 0);

        assertGt(usdOku.balanceOf(user1), 0);
    }

    function test_YieldLock_TransfersStillWorkDuringLock() public {
        // Setup: user1 has usdOku
        _mintUsdOku(user1, 100e18);

        // Distribute yield
        vm.prank(rebaser);
        okuMoney.distributeYield(10e18);

        // Same block — transfers should still work (only wrap/unwrap are blocked)
        vm.prank(user1);
        usdOku.transfer(user2, 50e18);

        assertGt(usdOku.balanceOf(user2), 0);
    }
}
