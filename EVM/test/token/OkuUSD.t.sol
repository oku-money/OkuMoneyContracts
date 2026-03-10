// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title OkuUSDTest
 * @notice Unit tests for OkuUSD rebasing stablecoin vault (NOT ERC-4626)
 * @dev OkuNote is a non-rebasing ERC-20 with notePrice() for price tracking.
 *      Wrap/unwrap are price-aware: they convert between note tokens and OkuUSD
 *      using notePrice() and usdMultiplier(). When notePrice = 1e18 (initial state),
 *      the math is identical to old 1:1 behavior.
 */
contract OkuUSDTest is BaseTest {
    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 value);
    event UsdRebaseEvent(uint256 oldMultiplier, uint256 newMultiplier);
    event UsdYieldRateUpdated(
        uint256 newRatePerSecond, uint256 endTimestamp, uint256 snapshotMultiplier
    );
    event NextUsdYieldRateSet(uint256 newRatePerSecond, uint256 activatesAt);
    event MinCollateralRatioUpdated(uint256 oldRatio, uint256 newRatio);
    event ReservesDeposited(address indexed depositor, uint256 noteAmount);
    event SurplusWithdrawn(address indexed to, uint256 noteAmount);

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(okuUsd.name(), "OkuUSD");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(okuUsd.symbol(), "OKUSD");
    }

    function test_Initialize_SetsCorrectDecimals() public view {
        assertEq(okuUsd.decimals(), 18);
    }

    function test_Initialize_SetsOkuNoteReference() public view {
        assertEq(address(okuUsd.okuNote()), address(okuNote));
    }

    function test_Initialize_SetsMinCollateralRatio() public view {
        assertEq(okuUsd.minCollateralRatio(), 95e16);
    }

    function test_Initialize_UsdMultiplierStartsAtPrecision() public view {
        assertEq(okuUsd.usdMultiplier(), PRECISION);
    }

    function test_Initialize_SetsAdminRoles() public view {
        assertTrue(okuUsd.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(okuUsd.hasRole(UPGRADER, admin));
    }

    // ============ Wrap Tests ============

    function test_Wrap_MintsCorrectUsdShares() public {
        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // At notePrice=1e18 and usdMultiplier=1e18: 100 notes → 100 OkuUSD
        assertEq(usdMinted, noteAmount);
        assertEq(okuUsd.balanceOf(user1), noteAmount);
        assertEq(okuUsd.usdSharesOf(user1), noteAmount);
    }

    function test_Wrap_TransfersNotesToVault() public {
        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        uint256 vaultBefore = okuNote.balanceOf(address(okuUsd));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        assertEq(okuNote.balanceOf(user1), 0);
        assertEq(okuNote.balanceOf(address(okuUsd)), vaultBefore + noteAmount);
    }

    function test_Wrap_EmitsTransferFromZero() public {
        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        // At notePrice=1e18, usdMultiplier=1e18: usdMinted = noteAmount
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), user1, noteAmount);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);
    }

    function test_Wrap_ToReceiver() public {
        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user2);

        // At notePrice=1e18: 100 notes → 100 OkuUSD
        assertEq(okuUsd.balanceOf(user2), noteAmount);
        assertEq(okuUsd.balanceOf(user1), 0);
    }

    function test_Wrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        okuUsd.wrap(0, user1);
    }

    function test_Wrap_RevertsOnZeroReceiver() public {
        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        vm.expectRevert("Zero receiver");
        okuUsd.wrap(noteAmount, address(0));
    }

    // ============ Wrap Rounding Tests ============

    function test_Wrap_SharesRoundDown_FavorsVault() public {
        // Wrap some so vault is non-empty
        _mintOkuUsd(user1, 1000e18);

        // Increase USD multiplier to 3x
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 3);

        // Wrap an odd amount at notePrice=1e18, usdMult=3e18
        // usdMinted = 10e18 * 1e18 / 3e18 = 3333333333333333333 (rounds down)
        // shares = usdMinted * 1e18 / 3e18 (rounds down again)
        uint256 noteAmount = 10e18;
        _mintOkuNote(user2, noteAmount);
        _approveOkuNote(user2, address(okuUsd), noteAmount);

        vm.prank(user2);
        okuUsd.wrap(noteAmount, user2);

        // usdMinted = noteAmount * notePrice / usdMultiplier <= noteAmount (since notePrice <= usdMult here)
        // balanceOf(user2) = shares * multiplier / PRECISION <= usdMinted (rounds down favors vault)
        uint256 usdMinted = (noteAmount * okuNote.notePrice()) / okuUsd.usdMultiplier();
        assertLe(okuUsd.balanceOf(user2), usdMinted);
    }

    // ============ Price-Aware Wrap Tests ============

    function test_Wrap_PriceAware_NotePriceIncrease() public {
        // Increase notePrice to 1.05e18 ($1.05 per note token)
        vm.prank(rebaser);
        okuNote.updateNotePrice(105e16);

        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18, "100 notes at $1.05 should produce 105 OkuUSD");
        assertEq(okuUsd.balanceOf(user1), 105e18);
    }

    function test_Wrap_PriceAware_HighNotePrice() public {
        // notePrice = 2e18 ($2.00 per note token)
        vm.prank(rebaser);
        okuNote.updateNotePrice(PRECISION * 2);

        uint256 noteAmount = 50e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // usdMinted = 50e18 * 2e18 / 1e18 = 100e18
        assertEq(usdMinted, 100e18, "50 notes at $2.00 should produce 100 OkuUSD");
    }

    function test_Wrap_PriceAware_BothMultipliersElevated() public {
        // notePrice = 1.05e18, usdMultiplier = 1.02e18
        vm.prank(rebaser);
        okuNote.updateNotePrice(105e16);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(102e16);

        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // usdMinted = 100e18 * 1.05e18 / 1.02e18 ≈ 102.94e18
        uint256 expected = (noteAmount * 105e16) / 102e16;
        assertEq(usdMinted, expected);
    }

    // ============ Unwrap Tests ============

    function test_Unwrap_ReturnsCorrectNotes() public {
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);

        uint256 userNotesBefore = okuNote.balanceOf(user1);

        vm.prank(user1);
        uint256 notesReturned = okuUsd.unwrap(noteAmount, user1);

        // At notePrice=1e18: notesReturned = 100e18 * 1e18 / 1e18 = 100e18
        assertEq(notesReturned, noteAmount);
        assertEq(okuNote.balanceOf(user1), userNotesBefore + noteAmount);
        assertEq(okuUsd.balanceOf(user1), 0);
    }

    function test_Unwrap_BurnsUsdShares() public {
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);

        uint256 sharesBefore = okuUsd.usdSharesOf(user1);
        assertGt(sharesBefore, 0);

        vm.prank(user1);
        okuUsd.unwrap(noteAmount, user1);

        assertEq(okuUsd.usdSharesOf(user1), 0);
        assertEq(okuUsd.totalUsdShares(), 0);
    }

    function test_Unwrap_EmitsTransferToZero() public {
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, address(0), noteAmount);

        vm.prank(user1);
        okuUsd.unwrap(noteAmount, user1);
    }

    function test_Unwrap_ToReceiver() public {
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);

        vm.prank(user1);
        okuUsd.unwrap(noteAmount, user2);

        // At notePrice=1e18: 100 OkuUSD → 100 notes
        assertEq(okuNote.balanceOf(user2), noteAmount);
        assertEq(okuNote.balanceOf(user1), 0);
    }

    function test_Unwrap_RevertsOnZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert("Amount must be positive");
        okuUsd.unwrap(0, user1);
    }

    function test_Unwrap_RevertsOnZeroReceiver() public {
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);

        vm.prank(user1);
        vm.expectRevert("Zero receiver");
        okuUsd.unwrap(noteAmount, address(0));
    }

    // ============ Unwrap Rounding Tests ============

    function test_Unwrap_SharesBurnedRoundUp_FavorsVault() public {
        // Wrap at 1x, then bump usdMultiplier so unwrap has fractional shares
        _mintOkuUsd(user1, 1000e18);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 3);

        // user1 balance is now 1000e18 * 3 = 3000e18
        // Unwrap 1e18: sharesToBurn = ceil(1e18 * 1e18 / (3e18)) = ceil(1/3 * 1e18)
        uint256 sharesBefore = okuUsd.usdSharesOf(user1);

        vm.prank(user1);
        okuUsd.unwrap(1e18, user1);

        uint256 sharesAfter = okuUsd.usdSharesOf(user1);
        uint256 sharesBurned = sharesBefore - sharesAfter;

        // Round-up check: sharesBurned * multiplier / PRECISION >= 1e18
        assertGe((sharesBurned * okuUsd.usdMultiplier()) / PRECISION, 1e18);
    }

    // ============ Price-Aware Unwrap Tests ============

    function test_Unwrap_PriceAware_NotePriceIncrease() public {
        // Wrap at notePrice=1e18: 100 notes → 100 OkuUSD
        _mintOkuUsd(user1, 100e18);

        // Increase notePrice to 1.05e18
        vm.prank(rebaser);
        okuNote.updateNotePrice(105e16);

        // Unwrap 105 OkuUSD at notePrice=1.05e18
        // notesReturned = 105e18 * 1e18 / 1.05e18 = 100e18
        // But user only has 100 OkuUSD, so unwrap 100 OkuUSD:
        // notesReturned = 100e18 * 1e18 / 1.05e18 ≈ 95.238e18
        vm.prank(user1);
        uint256 notesReturned = okuUsd.unwrap(100e18, user1);

        uint256 expected = (100e18 * PRECISION) / 105e16;
        assertEq(notesReturned, expected);
        // Notes returned should be less than 100 (each note is worth more now)
        assertLt(notesReturned, 100e18, "Should return fewer notes since each note is worth more");
    }

    function test_Unwrap_PriceAware_RoundTrip_AtHighPrice() public {
        // Set notePrice to 1.05e18 BEFORE wrapping
        vm.prank(rebaser);
        okuNote.updateNotePrice(105e16);

        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.startPrank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // usdMinted = 100e18 * 1.05e18 / 1e18 = 105e18
        assertEq(usdMinted, 105e18);

        // Unwrap all: notesBack = 105e18 * 1e18 / 1.05e18 = 100e18
        uint256 notesBack = okuUsd.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, noteAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, noteAmount, "Round trip should not gain tokens");
    }

    // ============ Insufficient Reserves ============

    function test_Unwrap_RevertsOnInsufficientReserves() public {
        // Wrap notes normally
        _mintOkuUsd(user1, 100e18);

        // Deposit extra reserves then withdraw most to leave vault underfunded
        _mintOkuNote(reserveManager, 200e18);
        _approveOkuNote(reserveManager, address(okuUsd), 200e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(200e18);

        // Allow full withdrawal for test purposes
        vm.prank(admin);
        okuUsd.setMinCollateralRatio(0);
        vm.prank(reserveManager);
        okuUsd.withdrawSurplus(250e18);

        // Vault only has 50e18 notes but user has 100e18 OkuUSD
        // At notePrice=1e18: unwrap(100e18) needs 100 notes, vault has 50
        vm.prank(user1);
        vm.expectRevert("Insufficient reserves");
        okuUsd.unwrap(100e18, user1);
    }

    // ============ Price-Aware Wrap/Unwrap Behavior Tests ============

    function test_PriceAware_OneNoteWrapsToOneOkuUSD_AtBasePrice() public {
        // At notePrice=1e18 (initial), 1 note = 1 OkuUSD (identical to old 1:1 behavior)
        uint256 noteAmount = 1e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        assertEq(usdMinted, 1e18, "1 note at $1.00 should produce exactly 1 OkuUSD");
        assertEq(okuUsd.balanceOf(user1), 1e18);
    }

    function test_PriceAware_AfterNotePriceIncrease_MoreOkuUSDMinted() public {
        // notePrice increases to 2x — each note token is worth $2.00
        vm.prank(rebaser);
        okuNote.updateNotePrice(PRECISION * 2);

        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // 100 note tokens × $2.00/token / $1.00 usdMultiplier = 200 OkuUSD
        assertEq(usdMinted, 200e18, "100 notes at $2.00 should produce 200 OkuUSD");
    }

    function test_PriceAware_NotePriceDoesNotChangeVaultBalance() public {
        // Wrap 100 notes at notePrice=1e18
        _mintOkuUsd(user1, 100e18);

        uint256 vaultBalBefore = okuNote.balanceOf(address(okuUsd));
        assertEq(vaultBalBefore, 100e18);

        // Increase notePrice — vault token balance is unchanged (non-rebasing)
        vm.prank(rebaser);
        okuNote.updateNotePrice(PRECISION * 2);

        uint256 vaultBalAfter = okuNote.balanceOf(address(okuUsd));
        assertEq(vaultBalAfter, vaultBalBefore, "Note rebase should not change vault token count");
    }

    // ============ Wrap/Unwrap Round Trip ============

    function test_WrapUnwrap_RoundTrip_MaxOneWeiLoss() public {
        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 balance = okuUsd.balanceOf(user1);
        uint256 notesBack = okuUsd.unwrap(balance, user1);
        vm.stopPrank();

        assertGe(notesBack, noteAmount - 1, "Round trip should lose at most 1 wei");
        assertLe(notesBack, noteAmount, "Round trip should not gain tokens");
    }

    function test_WrapUnwrap_RoundTrip_AfterUsdMultiplierChange() public {
        // Wrap at 1x (notePrice=1e18, usdMult=1e18)
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);

        // Bump USD multiplier to 1.5x
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier((PRECISION * 3) / 2);

        // user1 OkuUSD balance grew to 150e18 (100 shares * 1.5x), but vault has 100 notes.
        // Unwrap 150e18 OkuUSD: notesReturned = 150e18 * 1.5e18 / 1e18 = 225e18 — but vault
        // only has 100 notes! The vault is undercollateralized after a pure USD rebase.
        //
        // Instead, unwrap a partial amount that the vault CAN cover.
        // notesReturned = usdAmount * usdMultiplier / notePrice
        // For 66e18 OkuUSD: notesReturned = 66e18 * 1.5e18 / 1e18 = 99e18 notes
        vm.prank(user1);
        uint256 notesBack = okuUsd.unwrap(66e18, user1);

        uint256 expected = (66e18 * (PRECISION * 3 / 2)) / PRECISION;
        assertEq(notesBack, expected);
    }

    function test_WrapUnwrap_RoundTrip_AfterNotePriceChange() public {
        // Wrap at notePrice=1e18
        uint256 noteAmount = 100e18;
        _mintOkuUsd(user1, noteAmount);
        // user1 has 100 OkuUSD (100 USD shares), vault has 100 notes

        // Increase notePrice to 1.5e18
        // Vault still has 100 note tokens, but each is worth $1.50 → $150 backing
        // Obligations: 100 OkuUSD → overcollateralized
        vm.prank(rebaser);
        okuNote.updateNotePrice((PRECISION * 3) / 2);

        // Unwrap 100 OkuUSD: notesReturned = 100e18 * 1e18 / 1.5e18 ≈ 66.67e18
        vm.prank(user1);
        uint256 notesBack = okuUsd.unwrap(100e18, user1);

        uint256 expected = (100e18 * PRECISION) / ((PRECISION * 3) / 2);
        assertEq(notesBack, expected);
        // Fewer notes returned, but each note is worth more dollars
        assertLt(notesBack, 100e18, "Should return fewer notes at higher note price");
    }

    // ============ USD Multiplier Tests ============

    function test_UsdMultiplier_GrowsOverTime() public {
        // ~4.5% APY = 1e18 + ~1.393e9 per second
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, 0);

        uint256 multBefore = okuUsd.usdMultiplier();

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        uint256 multAfter = okuUsd.usdMultiplier();
        assertGt(multAfter, multBefore, "Multiplier should grow over time");
    }

    function test_UsdMultiplier_AccruesContinuously() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, 0);

        uint256 start = block.timestamp;

        // Warp 100 seconds
        vm.warp(start + 100);
        uint256 multAt100 = okuUsd.usdMultiplier();

        // The multiplier is a pure function of elapsed time, always deterministic
        assertGt(multAt100, PRECISION);
        assertEq(okuUsd.usdMultiplier(), multAt100);
    }

    function test_UsdMultiplier_AffectsBalances() public {
        _mintOkuUsd(user1, 100e18);

        assertEq(okuUsd.balanceOf(user1), 100e18);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        assertEq(okuUsd.balanceOf(user1), 200e18);
    }

    function test_UsdMultiplier_AffectsTotalSupply() public {
        _mintOkuUsd(user1, 100e18);

        assertEq(okuUsd.totalSupply(), 100e18);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        assertEq(okuUsd.totalSupply(), 200e18);
    }

    // ============ setUsdYieldRate Tests ============

    function test_SetUsdYieldRate_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, USD_REBASER
            )
        );
        okuUsd.setUsdYieldRate(PRECISION + 1e9, 0);
    }

    function test_SetUsdYieldRate_SnapshotsMultiplier() public {
        uint256 rate = PRECISION + 1393e6;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, 0);

        vm.warp(block.timestamp + 1 days);

        uint256 multBefore = okuUsd.usdMultiplier();
        assertGt(multBefore, PRECISION);

        // Set a new rate -- should snapshot current multiplier
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION, 0); // zero yield

        uint256 baseAfter = okuUsd.usdBaseMultiplier();
        assertEq(baseAfter, multBefore, "Base multiplier should be snapshotted");
    }

    function test_SetUsdYieldRate_RevertsOnNegativeRate() public {
        vm.prank(usdRebaser);
        vm.expectRevert("Rate cannot be negative");
        okuUsd.setUsdYieldRate(PRECISION - 1, 0);
    }

    function test_SetUsdYieldRate_RevertsOnRateTooHigh() public {
        vm.prank(usdRebaser);
        vm.expectRevert("Rate too high");
        okuUsd.setUsdYieldRate(PRECISION + 1e11 + 1, 0);
    }

    function test_SetUsdYieldRate_WithEndTimestamp() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, endTime);

        assertEq(okuUsd.usdRateEnd(), endTime);
    }

    function test_SetUsdYieldRate_RevertsOnPastEndTimestamp() public {
        // Warp forward so block.timestamp - 1 is non-zero (avoiding endTimestamp == 0 no-expiry case)
        vm.warp(1000);
        vm.prank(usdRebaser);
        vm.expectRevert("End must be in the future");
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, block.timestamp - 1);
    }

    function test_SetUsdYieldRate_ClearsPendingRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        okuUsd.setNextUsdYieldRate(PRECISION + 2000e6);

        // Setting a new rate should clear pending
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1000e6, 0);

        assertEq(okuUsd.usdPendingRatePerSecond(), PRECISION);
    }

    // ============ setNextUsdYieldRate Tests ============

    function test_SetNextUsdYieldRate_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, USD_REBASER
            )
        );
        okuUsd.setNextUsdYieldRate(PRECISION + 1e9);
    }

    function test_SetNextUsdYieldRate_SchedulesNextRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, endTime);

        uint256 nextRate = PRECISION + 2000e6;
        vm.prank(usdRebaser);
        okuUsd.setNextUsdYieldRate(nextRate);

        assertEq(okuUsd.usdPendingRatePerSecond(), nextRate);
    }

    function test_SetNextUsdYieldRate_RevertsWhenNoEnd() public {
        // Set rate with no end time
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, 0);

        vm.prank(usdRebaser);
        vm.expectRevert("Current rate has no end");
        okuUsd.setNextUsdYieldRate(PRECISION + 2000e6);
    }

    function test_SetNextUsdYieldRate_RevertsOnNegativeRate() public {
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, endTime);

        vm.prank(usdRebaser);
        vm.expectRevert("Rate cannot be negative");
        okuUsd.setNextUsdYieldRate(PRECISION - 1);
    }

    function test_SetNextUsdYieldRate_HeadToTailTransition() public {
        uint256 rate1 = PRECISION + 1393e6;
        uint256 rate2 = PRECISION + 2000e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate1, endTime);

        vm.prank(usdRebaser);
        okuUsd.setNextUsdYieldRate(rate2);

        // Warp past end time -- pending rate should take over
        vm.warp(endTime + 1 days);

        uint256 mult = okuUsd.usdMultiplier();
        // Should be greater than what rate1 alone would have produced at endTime
        assertGt(mult, PRECISION, "Multiplier should have grown through both rate periods");
    }

    // ============ updateUsdMultiplier Tests ============

    function test_UpdateUsdMultiplier_OnlyUsdRebaser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, USD_REBASER
            )
        );
        okuUsd.updateUsdMultiplier(PRECISION * 2);
    }

    function test_UpdateUsdMultiplier_SetsNewMultiplier() public {
        uint256 newMult = PRECISION * 2;

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(newMult);

        assertEq(okuUsd.usdMultiplier(), newMult);
        assertEq(okuUsd.usdBaseMultiplier(), newMult);
    }

    function test_UpdateUsdMultiplier_ResetsRateToZero() public {
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(PRECISION + 1393e6, 0);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        assertEq(okuUsd.usdRatePerSecond(), PRECISION);
        assertEq(okuUsd.usdRateEnd(), 0);
        assertEq(okuUsd.usdPendingRatePerSecond(), PRECISION);
    }

    function test_UpdateUsdMultiplier_RevertsOnDecrease() public {
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        vm.prank(usdRebaser);
        vm.expectRevert("Multiplier cannot decrease");
        okuUsd.updateUsdMultiplier(PRECISION);
    }

    function test_UpdateUsdMultiplier_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit UsdRebaseEvent(PRECISION, PRECISION * 2);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);
    }

    // ============ depositReserves Tests ============

    function test_DepositReserves_OnlyReserveManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, RESERVE_MANAGER
            )
        );
        okuUsd.depositReserves(100e18);
    }

    function test_DepositReserves_IncreasesReservesWithoutMintingShares() public {
        _mintOkuUsd(user1, 100e18);

        uint256 sharesBefore = okuUsd.totalUsdShares();
        uint256 reservesBefore = okuUsd.totalNoteReserves();

        _mintOkuNote(reserveManager, 50e18);
        _approveOkuNote(reserveManager, address(okuUsd), 50e18);

        vm.prank(reserveManager);
        okuUsd.depositReserves(50e18);

        assertEq(okuUsd.totalUsdShares(), sharesBefore, "Shares should not change");
        assertEq(okuUsd.totalNoteReserves(), reservesBefore + 50e18, "Reserves should increase");
    }

    function test_DepositReserves_IncreasesCollateralizationRatio() public {
        _mintOkuUsd(user1, 100e18);

        uint256 ratioBefore = okuUsd.collateralizationRatio();

        _mintOkuNote(reserveManager, 50e18);
        _approveOkuNote(reserveManager, address(okuUsd), 50e18);

        vm.prank(reserveManager);
        okuUsd.depositReserves(50e18);

        uint256 ratioAfter = okuUsd.collateralizationRatio();
        assertGt(ratioAfter, ratioBefore, "Collateralization ratio should increase");
    }

    function test_DepositReserves_RevertsOnZeroAmount() public {
        vm.prank(reserveManager);
        vm.expectRevert("Amount must be positive");
        okuUsd.depositReserves(0);
    }

    function test_DepositReserves_EmitsEvent() public {
        _mintOkuNote(reserveManager, 50e18);
        _approveOkuNote(reserveManager, address(okuUsd), 50e18);

        vm.expectEmit(true, false, false, true);
        emit ReservesDeposited(reserveManager, 50e18);

        vm.prank(reserveManager);
        okuUsd.depositReserves(50e18);
    }

    // ============ withdrawSurplus Tests ============

    function test_WithdrawSurplus_OnlyReserveManager() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, RESERVE_MANAGER
            )
        );
        okuUsd.withdrawSurplus(1e18);
    }

    function test_WithdrawSurplus_ExtractsSurplus() public {
        _mintOkuUsd(user1, 100e18);

        // Deposit extra reserves to create surplus
        _mintOkuNote(reserveManager, 50e18);
        _approveOkuNote(reserveManager, address(okuUsd), 50e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(50e18);

        // At notePrice=1e18: Reserves: 150 notes ($150), obligations: 100 OkuUSD
        // surplus = ($150 - $100) * PRECISION / notePrice = 50e18 note tokens
        assertEq(okuUsd.surplus(), 50e18);

        uint256 managerNotesBefore = okuNote.balanceOf(reserveManager);

        vm.prank(reserveManager);
        okuUsd.withdrawSurplus(30e18);

        assertEq(okuNote.balanceOf(reserveManager), managerNotesBefore + 30e18);
        assertEq(okuUsd.surplus(), 20e18);
    }

    function test_WithdrawSurplus_EnforcesMinCollateralRatio() public {
        _mintOkuUsd(user1, 100e18);
        // minCollateralRatio is 95e16 (95%)

        // Deposit 10e18 extra -- reserves = 110 notes, obligations = 100 OkuUSD
        // At notePrice=1e18: ratio = (110 * 1.0 / 1.0) * 1.0 / 100 = 110%
        _mintOkuNote(reserveManager, 10e18);
        _approveOkuNote(reserveManager, address(okuUsd), 10e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(10e18);

        // Try to withdraw 16e18 -- would leave 94 notes, ratio = 94% < 95%
        vm.prank(reserveManager);
        vm.expectRevert("Below minimum collateral ratio");
        okuUsd.withdrawSurplus(16e18);
    }

    function test_WithdrawSurplus_SucceedsAtExactFloor() public {
        _mintOkuUsd(user1, 100e18);

        // Deposit 10e18 extra -- reserves = 110 notes, obligations = 100 OkuUSD
        _mintOkuNote(reserveManager, 10e18);
        _approveOkuNote(reserveManager, address(okuUsd), 10e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(10e18);

        // Withdraw 15e18 -- leaves 95 notes / 100 OkuUSD = 95% = minCollateralRatio exactly
        vm.prank(reserveManager);
        okuUsd.withdrawSurplus(15e18);

        assertEq(okuUsd.collateralizationRatio(), 95e16);
    }

    function test_WithdrawSurplus_RevertsOnZeroAmount() public {
        vm.prank(reserveManager);
        vm.expectRevert("Amount must be positive");
        okuUsd.withdrawSurplus(0);
    }

    function test_WithdrawSurplus_EmitsEvent() public {
        _mintOkuUsd(user1, 100e18);

        _mintOkuNote(reserveManager, 50e18);
        _approveOkuNote(reserveManager, address(okuUsd), 50e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(50e18);

        vm.expectEmit(true, false, false, true);
        emit SurplusWithdrawn(reserveManager, 20e18);

        vm.prank(reserveManager);
        okuUsd.withdrawSurplus(20e18);
    }

    // ============ setMinCollateralRatio Tests ============

    function test_SetMinCollateralRatio_OnlyAdmin() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, DEFAULT_ADMIN_ROLE
            )
        );
        okuUsd.setMinCollateralRatio(90e16);
    }

    function test_SetMinCollateralRatio_UpdatesRatio() public {
        vm.prank(admin);
        okuUsd.setMinCollateralRatio(90e16);

        assertEq(okuUsd.minCollateralRatio(), 90e16);
    }

    function test_SetMinCollateralRatio_RevertsAbovePrecision() public {
        vm.prank(admin);
        vm.expectRevert("Ratio exceeds 100%");
        okuUsd.setMinCollateralRatio(PRECISION + 1);
    }

    function test_SetMinCollateralRatio_AllowsZero() public {
        vm.prank(admin);
        okuUsd.setMinCollateralRatio(0);

        assertEq(okuUsd.minCollateralRatio(), 0);
    }

    function test_SetMinCollateralRatio_AllowsPrecision() public {
        vm.prank(admin);
        okuUsd.setMinCollateralRatio(PRECISION);

        assertEq(okuUsd.minCollateralRatio(), PRECISION);
    }

    function test_SetMinCollateralRatio_EmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MinCollateralRatioUpdated(95e16, 90e16);

        vm.prank(admin);
        okuUsd.setMinCollateralRatio(90e16);
    }

    // ============ Collateralization Views Tests ============

    function test_TotalNoteReserves_EqualsNoteBalance() public {
        _mintOkuUsd(user1, 100e18);

        assertEq(okuUsd.totalNoteReserves(), okuNote.balanceOf(address(okuUsd)));
    }

    function test_TotalUsdObligations_EqualsTotalSupply() public {
        _mintOkuUsd(user1, 100e18);

        assertEq(okuUsd.totalUsdObligations(), okuUsd.totalSupply());
    }

    function test_CollateralizationRatio_100Percent_AtStart() public {
        _mintOkuUsd(user1, 100e18);

        // At notePrice=1e18: reserves = 100 notes * $1.00 = $100, obligations = 100 OkuUSD
        assertEq(okuUsd.collateralizationRatio(), PRECISION);
    }

    function test_CollateralizationRatio_MaxWhenEmpty() public view {
        // No obligations -> type(uint256).max
        assertEq(okuUsd.collateralizationRatio(), type(uint256).max);
    }

    function test_CollateralizationRatio_IncreasesWithDeposit() public {
        _mintOkuUsd(user1, 100e18);

        _mintOkuNote(reserveManager, 100e18);
        _approveOkuNote(reserveManager, address(okuUsd), 100e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(100e18);

        // At notePrice=1e18: 200 notes * $1.00 / 100 OkuUSD = 200%
        assertEq(okuUsd.collateralizationRatio(), PRECISION * 2);
    }

    function test_CollateralizationRatio_IncreasesWithNotePriceIncrease() public {
        _mintOkuUsd(user1, 100e18);

        // ratio = 100% initially
        assertEq(okuUsd.collateralizationRatio(), PRECISION);

        // Increase notePrice to 1.5e18 — vault still has 100 note tokens
        // Dollar value of reserves: 100 * $1.50 = $150, obligations: 100 OkuUSD
        // ratio = $150 / $100 = 150%
        vm.prank(rebaser);
        okuNote.updateNotePrice((PRECISION * 3) / 2);

        assertEq(okuUsd.collateralizationRatio(), (PRECISION * 3) / 2);
    }

    function test_Surplus_ReturnsCorrectAmount() public {
        _mintOkuUsd(user1, 100e18);

        // At 100% collateralized, surplus = 0
        assertEq(okuUsd.surplus(), 0);

        // Add extra reserves
        _mintOkuNote(reserveManager, 50e18);
        _approveOkuNote(reserveManager, address(okuUsd), 50e18);
        vm.prank(reserveManager);
        okuUsd.depositReserves(50e18);

        // At notePrice=1e18: surplus = ($150 - $100) * 1e18 / 1e18 = 50 note tokens
        assertEq(okuUsd.surplus(), 50e18);
    }

    function test_Surplus_ZeroWhenUndercollateralized() public {
        _mintOkuUsd(user1, 100e18);

        // Increase USD multiplier -- obligations grow but reserves stay the same
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        // Reserves: 100 notes * $1.00 = $100, obligations: 200 OkuUSD
        assertEq(okuUsd.surplus(), 0);
    }

    function test_Surplus_IncreasesWithNotePriceIncrease() public {
        _mintOkuUsd(user1, 100e18);
        assertEq(okuUsd.surplus(), 0);

        // Increase notePrice to 1.5e18
        // Reserves: 100 notes * $1.50 = $150, obligations: 100 OkuUSD
        // Dollar surplus: $150 - $100 = $50
        // Surplus in note tokens: $50 * 1e18 / $1.50 ≈ 33.33e18
        vm.prank(rebaser);
        okuNote.updateNotePrice((PRECISION * 3) / 2);

        uint256 expectedSurplus = (50e18 * PRECISION) / ((PRECISION * 3) / 2);
        assertEq(okuUsd.surplus(), expectedSurplus);
        assertGt(okuUsd.surplus(), 0, "Note price increase should create surplus");
    }

    // ============ Pause Tests ============

    function test_Pause_BlocksTransfer() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(vaultPauser);
        okuUsd.pause();

        vm.prank(user1);
        vm.expectRevert();
        okuUsd.transfer(user2, 50e18);
    }

    function test_Pause_BlocksTransferFrom() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        okuUsd.approve(user2, 50e18);

        vm.prank(vaultPauser);
        okuUsd.pause();

        vm.prank(user2);
        vm.expectRevert();
        okuUsd.transferFrom(user1, user2, 50e18);
    }

    function test_Pause_AllowsWrap() public {
        vm.prank(vaultPauser);
        okuUsd.pause();

        uint256 noteAmount = 100e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // At notePrice=1e18: 100 notes → 100 OkuUSD
        assertEq(usdMinted, noteAmount);
    }

    function test_Pause_AllowsUnwrap() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(vaultPauser);
        okuUsd.pause();

        vm.prank(user1);
        uint256 notesBack = okuUsd.unwrap(100e18, user1);

        // At notePrice=1e18: 100 OkuUSD → 100 notes
        assertEq(notesBack, 100e18);
    }

    function test_Pause_OnlyVaultPauser() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_PAUSER
            )
        );
        okuUsd.pause();

        // Note pauser cannot pause OkuUSD vault
        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, VAULT_PAUSER
            )
        );
        okuUsd.pause();
    }

    function test_Unpause_OnlyVaultUnpauser() public {
        vm.prank(vaultPauser);
        okuUsd.pause();

        // user1 cannot unpause
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, VAULT_UNPAUSER
            )
        );
        okuUsd.unpause();

        // Separate roles: pauser cannot unpause
        vm.prank(vaultPauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                vaultPauser,
                VAULT_UNPAUSER
            )
        );
        okuUsd.unpause();

        // Vault unpauser can unpause
        vm.prank(vaultUnpauser);
        okuUsd.unpause();
    }

    function test_Pause_TransfersResumeAfterUnpause() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(vaultPauser);
        okuUsd.pause();

        vm.prank(vaultUnpauser);
        okuUsd.unpause();

        vm.prank(user1);
        okuUsd.transfer(user2, 50e18);

        assertEq(okuUsd.balanceOf(user2), 50e18);
    }

    // ============ ERC-20 Compliance Tests ============

    function test_Transfer_MovesSharesInternally() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        okuUsd.transfer(user2, 40e18);

        assertEq(okuUsd.balanceOf(user1), 60e18);
        assertEq(okuUsd.balanceOf(user2), 40e18);
    }

    function test_Transfer_EmitsTokenAmounts() public {
        _mintOkuUsd(user1, 100e18);

        vm.expectEmit(true, true, false, true);
        emit Transfer(user1, user2, 40e18);

        vm.prank(user1);
        okuUsd.transfer(user2, 40e18);
    }

    function test_TransferFrom_WithApproval() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        okuUsd.approve(user2, 50e18);

        vm.prank(user2);
        okuUsd.transferFrom(user1, user2, 50e18);

        assertEq(okuUsd.balanceOf(user2), 50e18);
        assertEq(okuUsd.balanceOf(user1), 50e18);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user2);
        vm.expectRevert();
        okuUsd.transferFrom(user1, user2, 50e18);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mintOkuUsd(user1, 100e18);

        vm.prank(user1);
        vm.expectRevert("Insufficient balance");
        okuUsd.transfer(user2, 101e18);
    }

    function test_Approve_SetsAllowance() public {
        vm.prank(user1);
        okuUsd.approve(user2, 100e18);

        assertEq(okuUsd.allowance(user1, user2), 100e18);
    }

    function test_TotalSupply_ReflectsAllShares() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 200e18);

        assertEq(okuUsd.totalSupply(), 300e18);
    }

    function test_Transfer_ShareBased_AfterMultiplierChange() public {
        _mintOkuUsd(user1, 100e18);

        // Increase multiplier to 2x
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        // user1 balance is now 200e18. Transfer 100e18 (50 shares)
        vm.prank(user1);
        okuUsd.transfer(user2, 100e18);

        assertEq(okuUsd.balanceOf(user1), 100e18);
        assertEq(okuUsd.balanceOf(user2), 100e18);
    }

    function test_BalanceOf_ReflectsMultiplier() public {
        _mintOkuUsd(user1, 100e18);

        assertEq(okuUsd.balanceOf(user1), 100e18);
        assertEq(okuUsd.usdSharesOf(user1), 100e18);

        // Multiplier 2x -> balanceOf doubles, shares unchanged
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        assertEq(okuUsd.balanceOf(user1), 200e18);
        assertEq(okuUsd.usdSharesOf(user1), 100e18);
    }

    // ============ Role Enforcement Tests ============

    function test_RoleEnforcement_NoteRebaserCannotSetUsdRate() public {
        vm.prank(rebaser); // note rebaser, not USD rebaser
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, rebaser, USD_REBASER
            )
        );
        okuUsd.setUsdYieldRate(PRECISION + 1e9, 0);
    }

    function test_RoleEnforcement_NonReserveManagerCannotDeposit() public {
        _mintOkuNote(user1, 100e18);
        _approveOkuNote(user1, address(okuUsd), 100e18);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, RESERVE_MANAGER
            )
        );
        okuUsd.depositReserves(100e18);
    }

    function test_RoleEnforcement_NonReserveManagerCannotWithdraw() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, RESERVE_MANAGER
            )
        );
        okuUsd.withdrawSurplus(1e18);
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
        okuUsd.setMinCollateralRatio(90e16);
    }

    // ============ Repeated Wrap/Unwrap (rUSDY H-01 Mitigation) ============

    function test_RepeatedWrapUnwrap_NoShareInflation() public {
        uint256 initialNotes = 1000e18;
        _mintOkuNote(user1, initialNotes);
        _approveOkuNote(user1, address(okuUsd), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 1000; i++) {
            uint256 noteBal = okuNote.balanceOf(user1);
            if (noteBal == 0) break;
            okuUsd.wrap(noteBal, user1);
            uint256 usdBal = okuUsd.balanceOf(user1);
            if (usdBal == 0) break;
            okuUsd.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuNote.balanceOf(user1);

        // Must not gain tokens (no free share accumulation)
        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        // Max 1 wei loss per cycle
        assertGe(finalNotes, initialNotes - 1000, "Excessive rounding loss");
    }

    function test_RepeatedWrapUnwrap_NoShareInflation_AfterUsdMultiplierChange() public {
        // Create some existing vault state
        _mintOkuUsd(user2, 5000e18);

        // Bump USD multiplier to 1.5x
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier((PRECISION * 3) / 2);

        // Now user1 does repeated wrap/unwrap at non-1.0 usdMultiplier
        uint256 initialNotes = 1000e18;
        _mintOkuNote(user1, initialNotes);
        _approveOkuNote(user1, address(okuUsd), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 1000; i++) {
            uint256 noteBal = okuNote.balanceOf(user1);
            if (noteBal == 0) break;
            okuUsd.wrap(noteBal, user1);
            uint256 usdBal = okuUsd.balanceOf(user1);
            if (usdBal == 0) break;
            okuUsd.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuNote.balanceOf(user1);

        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        assertGe(finalNotes, initialNotes - 1000, "Excessive rounding loss");
    }

    function test_RepeatedWrapUnwrap_NoShareInflation_AfterNotePriceChange() public {
        // Create some existing vault state
        _mintOkuUsd(user2, 5000e18);

        // Bump notePrice to 1.5e18
        vm.prank(rebaser);
        okuNote.updateNotePrice((PRECISION * 3) / 2);

        // Now user1 does repeated wrap/unwrap at non-1.0 notePrice
        uint256 initialNotes = 1000e18;
        _mintOkuNote(user1, initialNotes);
        _approveOkuNote(user1, address(okuUsd), type(uint256).max);

        vm.startPrank(user1);

        for (uint256 i = 0; i < 1000; i++) {
            uint256 noteBal = okuNote.balanceOf(user1);
            if (noteBal == 0) break;
            okuUsd.wrap(noteBal, user1);
            uint256 usdBal = okuUsd.balanceOf(user1);
            if (usdBal == 0) break;
            okuUsd.unwrap(usdBal, user1);
        }

        vm.stopPrank();

        uint256 finalNotes = okuNote.balanceOf(user1);

        assertLe(finalNotes, initialNotes, "Balance must not increase from wrap/unwrap cycles");
        assertGe(finalNotes, initialNotes - 1000, "Excessive rounding loss");
    }

    // ============ Rate Expiry Tests ============

    function test_RateExpiry_StopsYieldWhenNoPending() public {
        uint256 rate = PRECISION + 1393e6;
        uint256 endTime = block.timestamp + 30 days;

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, endTime);

        // Warp to 1 second before end
        vm.warp(endTime - 1);
        uint256 multBeforeEnd = okuUsd.usdMultiplier();

        // Warp 100 days past end -- no pending rate, so yield should stop
        vm.warp(endTime + 100 days);
        uint256 multLongAfterEnd = okuUsd.usdMultiplier();

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
        okuUsd.setUsdYieldRate(rate1, endTime);

        vm.prank(usdRebaser);
        okuUsd.setNextUsdYieldRate(rate2);

        // Warp past end + 365 days: should have 30d of rate1 + 365d of rate2
        vm.warp(endTime + 365 days);

        uint256 mult = okuUsd.usdMultiplier();
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
        okuUsd.setUsdYieldRate(rate, 0);

        uint256 startMult = okuUsd.usdMultiplier();

        vm.warp(block.timestamp + 365 days);

        uint256 endMult = okuUsd.usdMultiplier();
        uint256 expectedMult = 1045e15; // 1.045e18

        // Within 0.1% tolerance
        assertApproxEqRel(endMult, expectedMult, 1e15);
        assertGt(endMult, startMult);
    }

    // ============ Independent Multiplier Tests ============

    function test_UsdMultiplier_IndependentOfNotePrice() public {
        // Set different rates for note and USD
        uint256 noteRate = 1_000_000_001_395_766_281; // ~4.5% APY
        uint256 usdRate = PRECISION + 634e6; // ~2% APY

        vm.prank(rebaser);
        okuNote.setYieldRate(noteRate, 0);

        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(usdRate, 0);

        vm.warp(block.timestamp + 365 days);

        uint256 noteP = okuNote.notePrice();
        uint256 usdMult = okuUsd.usdMultiplier();

        // They should be different (note grows faster)
        assertGt(noteP, usdMult, "Note price should be higher at higher rate");
        assertTrue(noteP != usdMult, "Note price and USD multiplier must be independent");
    }

    // ============ Continuous Yield + Balance/Supply Tests ============

    function test_ContinuousYield_BalanceGrowsOverTime() public {
        _mintOkuUsd(user1, 100e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, 0);

        uint256 balBefore = okuUsd.balanceOf(user1);

        vm.warp(block.timestamp + 30 days);

        uint256 balAfter = okuUsd.balanceOf(user1);
        assertGt(balAfter, balBefore, "Balance must grow via continuous yield");
    }

    function test_ContinuousYield_TotalSupplyGrowsOverTime() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 200e18);

        uint256 rate = PRECISION + 1393e6;
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, 0);

        uint256 supplyBefore = okuUsd.totalSupply();

        vm.warp(block.timestamp + 30 days);

        uint256 supplyAfter = okuUsd.totalSupply();
        assertGt(supplyAfter, supplyBefore, "Total supply must grow via continuous yield");
    }

    // ============ TransferFrom Share-Based with Multiplier ============

    function test_TransferFrom_ShareBased_AfterMultiplierChange() public {
        _mintOkuUsd(user1, 100e18);

        // Increase multiplier to 2x
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        // user1 has 200 OkuUSD (100 shares * 2x)
        vm.prank(user1);
        okuUsd.approve(user2, 100e18);

        vm.prank(user2);
        okuUsd.transferFrom(user1, user2, 100e18);

        // 100 OkuUSD = 50 shares at 2x multiplier
        assertEq(okuUsd.usdSharesOf(user1), 50e18);
        assertEq(okuUsd.usdSharesOf(user2), 50e18);
        assertEq(okuUsd.balanceOf(user1), 100e18);
        assertEq(okuUsd.balanceOf(user2), 100e18);
    }

    // ============ Multi-User Tests ============

    function test_MultiUser_IndependentAccounting() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 200e18);

        // Unwrap user1 should not affect user2
        vm.prank(user1);
        okuUsd.unwrap(100e18, user1);

        assertEq(okuUsd.balanceOf(user1), 0);
        assertEq(okuUsd.balanceOf(user2), 200e18);
    }

    function test_MultiUser_ProportionalYield() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 300e18);

        // Bump multiplier to 2x
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(PRECISION * 2);

        // user1 should have 200e18, user2 should have 600e18
        assertEq(okuUsd.balanceOf(user1), 200e18);
        assertEq(okuUsd.balanceOf(user2), 600e18);
    }

    function test_MultiUser_ProportionalShares() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 300e18);

        // user2 should have 3x the shares of user1
        assertEq(okuUsd.usdSharesOf(user2), okuUsd.usdSharesOf(user1) * 3);
        assertEq(okuUsd.totalUsdShares(), okuUsd.usdSharesOf(user1) + okuUsd.usdSharesOf(user2));
    }

    function test_MultiUser_YieldAccruesProportionally() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 300e18);

        uint256 rate = 1_000_000_001_395_766_281; // ~4.5% APY
        vm.prank(usdRebaser);
        okuUsd.setUsdYieldRate(rate, 0);

        vm.warp(block.timestamp + 365 days);

        uint256 bal1 = okuUsd.balanceOf(user1);
        uint256 bal2 = okuUsd.balanceOf(user2);

        // Both accrue ~4.5%
        assertApproxEqRel(bal1, 104.5e18, 1e15); // within 0.1%
        assertApproxEqRel(bal2, 313.5e18, 1e15);

        // Proportions preserved (1:3 ratio)
        assertApproxEqRel(bal2, bal1 * 3, 1e15);
    }

    function test_MultiUser_WrapUnwrapDoesNotAffectOthers() public {
        _mintOkuUsd(user1, 100e18);
        _mintOkuUsd(user2, 200e18);

        uint256 user2BalBefore = okuUsd.balanceOf(user2);
        uint256 user2SharesBefore = okuUsd.usdSharesOf(user2);

        // User1 unwraps half
        vm.prank(user1);
        okuUsd.unwrap(50e18, user1);

        // User2's balance and shares should be unchanged
        assertEq(okuUsd.balanceOf(user2), user2BalBefore);
        assertEq(okuUsd.usdSharesOf(user2), user2SharesBefore);

        // User3 wraps new notes
        _mintOkuUsd(user3, 500e18);

        // User2 still unchanged
        assertEq(okuUsd.balanceOf(user2), user2BalBefore);
        assertEq(okuUsd.usdSharesOf(user2), user2SharesBefore);
    }

    // ============ Fuzz Round-Trip Tests ============

    function test_Fuzz_WrapUnwrap_RoundTrip(uint256 mult) public {
        mult = bound(mult, PRECISION, 5e18); // 1x to 5x

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(mult);

        uint256 noteAmount = 77.777e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 bal = okuUsd.balanceOf(user1);
        okuUsd.unwrap(bal, user1);
        vm.stopPrank();

        uint256 finalNotes = okuNote.balanceOf(user1);
        // Price-aware wrap/unwrap has multiple division steps, each losing up to 1 wei
        // of value scaled by mult/PRECISION. The rounding chain:
        //   1. usdMinted = noteAmount * notePrice / mult       (rounds down)
        //   2. shares = usdMinted * PRECISION / mult           (rounds down)
        //   3. balanceOf = shares * mult / PRECISION           (rounds down)
        //   4. notesReturned = balance * mult / notePrice       (rounds down)
        //   5. sharesToBurn = ceil(balance * PRECISION / mult)  (rounds up)
        // At mult = 5x, cumulative loss can reach ~5 * (mult/PRECISION) ≈ 25 wei.
        uint256 maxLoss = (5 * mult + PRECISION - 1) / PRECISION + 5;
        assertApproxEqAbs(finalNotes, noteAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, noteAmount, "Must not gain from round trip");
    }

    function test_Fuzz_WrapUnwrap_RoundTrip_WithNotePrice(uint256 price) public {
        price = bound(price, PRECISION, 3e18); // $1.00 to $3.00

        vm.prank(rebaser);
        okuNote.updateNotePrice(price);

        uint256 noteAmount = 77.777e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 bal = okuUsd.balanceOf(user1);
        okuUsd.unwrap(bal, user1);
        vm.stopPrank();

        uint256 finalNotes = okuNote.balanceOf(user1);
        // At any notePrice, round trip should return ≈ noteAmount (within rounding)
        // Loss bounded by price/PRECISION * multiplier rounding chain
        assertApproxEqAbs(finalNotes, noteAmount, 5, "Round trip rounding loss within bounds");
        assertLe(finalNotes, noteAmount, "Must not gain from round trip");
    }

    function test_Fuzz_WrapUnwrap_RoundTrip_BothPriceAndMult(uint256 price, uint256 mult) public {
        price = bound(price, PRECISION, 3e18); // $1.00 to $3.00
        mult = bound(mult, PRECISION, 3e18); // 1x to 3x

        vm.prank(rebaser);
        okuNote.updateNotePrice(price);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(mult);

        uint256 noteAmount = 77.777e18;
        _mintOkuNote(user1, noteAmount);
        _approveOkuNote(user1, address(okuUsd), noteAmount);

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 bal = okuUsd.balanceOf(user1);
        okuUsd.unwrap(bal, user1);
        vm.stopPrank();

        uint256 finalNotes = okuNote.balanceOf(user1);
        // With both price and multiplier, up to 5 rounding divisions each scaled by
        // max(price, mult) / PRECISION. Bound loss accordingly.
        uint256 scale = _max(price, mult);
        uint256 maxLoss = 5 * scale / PRECISION + 5;
        assertApproxEqAbs(finalNotes, noteAmount, maxLoss, "Round trip rounding loss within bounds");
        assertLe(finalNotes, noteAmount, "Must not gain from round trip");
    }
}
