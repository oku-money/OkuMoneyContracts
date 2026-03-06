// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title OkuUSDFuzzTest
 * @notice Fuzz tests for OkuUSD rebasing vault: wrap/unwrap math, collateralization, and share invariants
 */
contract OkuUSDFuzzTest is BaseTest {
    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint OkuNote to users for wrapping
        _mintOkuNote(user1, MAX_SUPPLY / 4);
        _mintOkuNote(user2, MAX_SUPPLY / 4);
        // Pre-approve vault for notes
        _approveOkuNote(user1, address(okuUsd), type(uint256).max);
        _approveOkuNote(user2, address(okuUsd), type(uint256).max);
    }

    // ============ 1. Wrap/Unwrap Round-Trip ============

    /// @notice Wrap then unwrap should return original amount (max 1 wei loss)
    function testFuzz_WrapUnwrapRoundTrip(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.startPrank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);
        uint256 notesBack = okuUsd.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, noteAmount - 1, "Max 1 wei loss on round trip");
        assertLe(notesBack, noteAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip at various USD multipliers
    function testFuzz_WrapUnwrapRoundTripAtMultiplier(
        uint256 noteAmount,
        uint256 multiplier
    )
        public
    {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 2);
        uint256 currentMult = okuUsd.usdMultiplier();
        multiplier = bound(multiplier, currentMult, currentMult * 10);

        // Set USD multiplier
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(multiplier);

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        // Unwrap the actual balance (not usdMinted, which may exceed what shares can cover
        // due to wrap rounding down shares but usdMinted = noteAmount)
        uint256 bal = okuUsd.balanceOf(user1);
        if (bal == 0) {
            vm.stopPrank();
            return;
        }
        uint256 notesBack = okuUsd.unwrap(bal, user1);
        vm.stopPrank();

        assertLe(notesBack, noteAmount, "Cannot gain on round trip");
        // At higher multipliers, rounding compounds — allow proportional tolerance
        uint256 maxLoss = (noteAmount * multiplier) / (PRECISION * PRECISION) + 2;
        assertGe(
            notesBack,
            noteAmount > maxLoss ? noteAmount - maxLoss : 0,
            "Excessive loss on round trip"
        );
    }

    // ============ 2. Wrap Rounding Favors Vault ============

    /// @notice sharesToMint = (noteAmount * PRECISION) / usdMultiplier() rounds DOWN
    function testFuzz_WrapRoundingFavorsVault(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        uint256 mult = okuUsd.usdMultiplier();
        uint256 expectedShares = (noteAmount * PRECISION) / mult;
        // Solidity integer division truncates (rounds down) — this is the vault-favorable direction
        // Verify: expectedShares * mult / PRECISION <= noteAmount
        uint256 impliedValue = (expectedShares * mult) / PRECISION;
        assertLe(impliedValue, noteAmount, "Wrap rounding must favor vault (round shares down)");

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        assertEq(okuUsd.usdSharesOf(user1), expectedShares, "Shares minted match expected");
    }

    /// @notice Wrap rounding at elevated USD multiplier
    function testFuzz_WrapRoundingAtHighMultiplier(uint256 noteAmount, uint256 multiplier) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);
        uint256 currentMult = okuUsd.usdMultiplier();
        multiplier = bound(multiplier, currentMult + 1, currentMult * 10);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(multiplier);

        uint256 expectedShares = (noteAmount * PRECISION) / multiplier;
        uint256 impliedValue = (expectedShares * multiplier) / PRECISION;
        assertLe(impliedValue, noteAmount, "Wrap rounding must favor vault at any multiplier");

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        assertEq(okuUsd.usdSharesOf(user1), expectedShares, "Shares match at elevated multiplier");
    }

    // ============ 3. Unwrap Rounding Favors Vault ============

    /// @notice sharesToBurn rounds UP: (usdAmount * PRECISION + mult - 1) / mult
    function testFuzz_UnwrapRoundingFavorsVault(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 usdBalance = okuUsd.balanceOf(user1);
        if (usdBalance == 0) return;

        uint256 mult = okuUsd.usdMultiplier();
        uint256 sharesBefore = okuUsd.usdSharesOf(user1);

        // Expected shares to burn (round UP)
        uint256 expectedBurn = (usdBalance * PRECISION + mult - 1) / mult;

        vm.prank(user1);
        okuUsd.unwrap(usdBalance, user1);

        uint256 sharesAfter = okuUsd.usdSharesOf(user1);
        uint256 actualBurn = sharesBefore - sharesAfter;

        assertGe(actualBurn, (usdBalance * PRECISION) / mult, "Burn must be >= floor (round up)");
        assertEq(actualBurn, expectedBurn, "Burn matches ceil division");
    }

    // ============ 4. Collateralization Under Various Rates ============

    /// @notice After wrap at 1:1 multipliers, collateralization ratio >= 100%
    function testFuzz_CollateralizationAtParity(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 ratio = okuUsd.collateralizationRatio();
        assertGe(ratio, PRECISION, "Collateral ratio must be >= 100% at parity");
    }

    /// @notice After note rebase without USD rebase, vault becomes overcollateralized
    function testFuzz_NoteRebaseOvercollateralizes(
        uint256 noteAmount,
        uint256 noteMultiplier
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 currentNoteMult = okuNote.rewardMultiplier();
        noteMultiplier =
            bound(noteMultiplier, currentNoteMult + currentNoteMult / 100, currentNoteMult * 5);

        // Rebase note only — vault note balance grows, OkuUSD supply stays same
        vm.prank(rebaser);
        okuNote.updateRewardMultiplier(noteMultiplier);

        uint256 ratio = okuUsd.collateralizationRatio();
        assertGe(ratio, PRECISION, "Note rebase should overcollateralize vault");
    }

    /// @notice After USD rebase without note rebase, vault becomes undercollateralized
    function testFuzz_UsdRebaseUndercollateralizes(
        uint256 noteAmount,
        uint256 usdMultiplier
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 currentUsdMult = okuUsd.usdMultiplier();
        usdMultiplier =
            bound(usdMultiplier, currentUsdMult + currentUsdMult / 100, currentUsdMult * 5);

        // Rebase USD only — OkuUSD supply grows, note reserves stay same
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(usdMultiplier);

        uint256 ratio = okuUsd.collateralizationRatio();
        assertLe(ratio, PRECISION, "USD-only rebase should undercollateralize vault");
    }

    /// @notice Collateralization views are consistent
    function testFuzz_CollateralizationViewsConsistent(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 reserves = okuUsd.totalNoteReserves();
        uint256 obligations = okuUsd.totalUsdObligations();
        uint256 ratio = okuUsd.collateralizationRatio();
        uint256 surplusVal = okuUsd.surplus();

        assertEq(obligations, okuUsd.totalSupply(), "Obligations == totalSupply");
        assertEq(reserves, okuNote.balanceOf(address(okuUsd)), "Reserves == note balance");

        if (reserves >= obligations) {
            assertGe(ratio, PRECISION, "Ratio >= 100% when overcollateralized");
            assertEq(surplusVal, reserves - obligations, "Surplus matches excess");
        } else {
            assertLt(ratio, PRECISION, "Ratio < 100% when undercollateralized");
            assertEq(surplusVal, 0, "No surplus when undercollateralized");
        }
    }

    // ============ 5. Surplus Extraction ============

    /// @notice withdrawSurplus reverts when at or below floor
    function testFuzz_WithdrawSurplusRevertsAtFloor(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 surplusVal = okuUsd.surplus();

        // Fund reserveManager to call withdrawSurplus
        if (surplusVal > 0) {
            // Try to withdraw more than surplus — should revert
            vm.prank(reserveManager);
            vm.expectRevert("Below minimum collateral ratio");
            okuUsd.withdrawSurplus(surplusVal + 1e18);
        }

        // With no extra reserves, any withdrawal should fail or leave ratio below floor
        // Deposit exact noteAmount means ratio ~= 100%, surplus ~= 0 at parity
    }

    /// @notice withdrawSurplus succeeds when overcollateralized, respects floor
    function testFuzz_WithdrawSurplusWithExcessReserves(
        uint256 noteAmount,
        uint256 extraNotes
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 4);
        extraNotes = bound(extraNotes, 1e6, okuNote.balanceOf(user1) / 4);

        // Wrap to create OkuUSD supply
        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        // Deposit extra reserves (overcollateralize)
        _mintOkuNote(reserveManager, extraNotes);
        _approveOkuNote(reserveManager, address(okuUsd), extraNotes);
        vm.prank(reserveManager);
        okuUsd.depositReserves(extraNotes);

        uint256 surplusVal = okuUsd.surplus();
        assertGt(surplusVal, 0, "Should have surplus after extra deposit");

        uint256 ratioBefore = okuUsd.collateralizationRatio();

        // Withdraw exactly the surplus
        vm.prank(reserveManager);
        okuUsd.withdrawSurplus(surplusVal);

        uint256 ratioAfter = okuUsd.collateralizationRatio();
        assertGe(ratioAfter, okuUsd.minCollateralRatio(), "Must stay above floor after withdrawal");
        assertLe(ratioAfter, ratioBefore, "Ratio should decrease after withdrawal");
    }

    /// @notice withdrawSurplus reverts if would breach minCollateralRatio
    function testFuzz_WithdrawSurplusRevertsBelowFloor(
        uint256 noteAmount,
        uint256 extraNotes
    )
        public
    {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 4);
        extraNotes = bound(extraNotes, 1e6, noteAmount / 10);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        // Small extra deposit
        _mintOkuNote(reserveManager, extraNotes);
        _approveOkuNote(reserveManager, address(okuUsd), extraNotes);
        vm.prank(reserveManager);
        okuUsd.depositReserves(extraNotes);

        // Try to withdraw way more than surplus
        uint256 totalReserves = okuUsd.totalNoteReserves();
        uint256 excessiveWithdraw = totalReserves; // withdrawing everything

        vm.prank(reserveManager);
        vm.expectRevert();
        okuUsd.withdrawSurplus(excessiveWithdraw);
    }

    // ============ 6. Balance Formula ============

    /// @notice balanceOf == usdShares * usdMultiplier / PRECISION
    function testFuzz_BalanceFormula(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 shares = okuUsd.usdSharesOf(user1);
        uint256 mult = okuUsd.usdMultiplier();
        uint256 expected = (shares * mult) / PRECISION;

        assertEq(
            okuUsd.balanceOf(user1), expected, "balanceOf must equal shares * mult / PRECISION"
        );
    }

    /// @notice Balance formula holds after USD rebase
    function testFuzz_BalanceFormulaAfterRebase(uint256 noteAmount, uint256 newMultiplier) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 currentMult = okuUsd.usdMultiplier();
        newMultiplier = bound(newMultiplier, currentMult, currentMult * 10);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(newMultiplier);

        uint256 shares = okuUsd.usdSharesOf(user1);
        uint256 mult = okuUsd.usdMultiplier();
        uint256 expected = (shares * mult) / PRECISION;

        assertEq(okuUsd.balanceOf(user1), expected, "Balance formula must hold after rebase");
    }

    /// @notice totalSupply == totalUsdShares * usdMultiplier / PRECISION
    function testFuzz_TotalSupplyFormula(uint256 amount1, uint256 amount2) public {
        amount1 = bound(amount1, 1e6, okuNote.balanceOf(user1) / 2);
        amount2 = bound(amount2, 1e6, okuNote.balanceOf(user2) / 2);

        vm.prank(user1);
        okuUsd.wrap(amount1, user1);

        vm.prank(user2);
        okuUsd.wrap(amount2, user2);

        uint256 totalShares = okuUsd.totalUsdShares();
        uint256 mult = okuUsd.usdMultiplier();
        uint256 expected = (totalShares * mult) / PRECISION;

        assertEq(
            okuUsd.totalSupply(), expected, "totalSupply must equal totalShares * mult / PRECISION"
        );
    }

    // ============ 7. Transfer Preserves Shares ============

    /// @notice Total shares unchanged after transfer
    function testFuzz_TransferPreservesShares(uint256 noteAmount, uint256 transferAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 usdBalance = okuUsd.balanceOf(user1);
        transferAmount = bound(transferAmount, 1, usdBalance);

        uint256 totalSharesBefore = okuUsd.totalUsdShares();

        vm.prank(user1);
        okuUsd.transfer(user2, transferAmount);

        uint256 totalSharesAfter = okuUsd.totalUsdShares();

        assertEq(totalSharesAfter, totalSharesBefore, "Total shares must not change on transfer");
    }

    /// @notice Individual shares sum preserved after transfer
    function testFuzz_TransferSharesSum(uint256 noteAmount, uint256 transferAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 usdBalance = okuUsd.balanceOf(user1);
        transferAmount = bound(transferAmount, 1, usdBalance);

        uint256 user1SharesBefore = okuUsd.usdSharesOf(user1);
        uint256 user2SharesBefore = okuUsd.usdSharesOf(user2);

        vm.prank(user1);
        okuUsd.transfer(user2, transferAmount);

        uint256 user1SharesAfter = okuUsd.usdSharesOf(user1);
        uint256 user2SharesAfter = okuUsd.usdSharesOf(user2);

        assertEq(
            user1SharesAfter + user2SharesAfter,
            user1SharesBefore + user2SharesBefore,
            "Sum of individual shares must be preserved"
        );
    }

    // ============ 8. Multiple Wrap/Unwrap No Inflation ============

    /// @notice Repeated wrap/unwrap cycles don't create extra shares (rUSDY H-01 mitigation)
    function testFuzz_RepeatedWrapUnwrapNoInflation(uint256 noteAmount, uint8 cycles) public {
        noteAmount = bound(noteAmount, 1e12, okuNote.balanceOf(user1) / 2);
        cycles = uint8(bound(cycles, 2, 10));

        // First wrap
        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 initialShares = okuUsd.usdSharesOf(user1);

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = okuUsd.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = okuUsd.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            // Re-approve note for vault
            okuNote.approve(address(okuUsd), notesBack);
            okuUsd.wrap(notesBack, user1);
        }
        vm.stopPrank();

        uint256 finalShares = okuUsd.usdSharesOf(user1);

        // Shares should not increase (they may decrease slightly due to rounding)
        assertLe(finalShares, initialShares, "Shares must not inflate after repeated cycles");
    }

    /// @notice Total supply does not inflate through wrap/unwrap cycles
    function testFuzz_RepeatedCyclesNoSupplyInflation(uint256 noteAmount, uint8 cycles) public {
        noteAmount = bound(noteAmount, 1e12, okuNote.balanceOf(user1) / 2);
        cycles = uint8(bound(cycles, 2, 10));

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 initialSupply = okuUsd.totalSupply();

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = okuUsd.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = okuUsd.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            okuNote.approve(address(okuUsd), notesBack);
            okuUsd.wrap(notesBack, user1);
        }
        vm.stopPrank();

        uint256 finalSupply = okuUsd.totalSupply();
        assertLe(finalSupply, initialSupply, "Total supply must not inflate through cycles");
    }

    // ============ 9. depositReserves Increases Collateral Ratio ============

    /// @notice depositReserves increases collateralization without minting shares
    function testFuzz_DepositReservesIncreasesRatio(
        uint256 noteAmount,
        uint256 depositAmount
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 4);
        depositAmount = bound(depositAmount, 1e6, okuNote.balanceOf(user1) / 4);

        // Create OkuUSD supply
        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 sharesBefore = okuUsd.totalUsdShares();
        uint256 ratioBefore = okuUsd.collateralizationRatio();

        // Deposit reserves
        _mintOkuNote(reserveManager, depositAmount);
        _approveOkuNote(reserveManager, address(okuUsd), depositAmount);
        vm.prank(reserveManager);
        okuUsd.depositReserves(depositAmount);

        uint256 sharesAfter = okuUsd.totalUsdShares();
        uint256 ratioAfter = okuUsd.collateralizationRatio();

        assertEq(sharesAfter, sharesBefore, "depositReserves must not mint USD shares");
        assertGe(ratioAfter, ratioBefore, "Collateral ratio must not decrease after deposit");
    }

    /// @notice depositReserves reflected in totalNoteReserves
    function testFuzz_DepositReservesReflectedInReserves(
        uint256 noteAmount,
        uint256 depositAmount
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 4);
        depositAmount = bound(depositAmount, 1e6, okuNote.balanceOf(user1) / 4);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 reservesBefore = okuUsd.totalNoteReserves();

        _mintOkuNote(reserveManager, depositAmount);
        _approveOkuNote(reserveManager, address(okuUsd), depositAmount);
        vm.prank(reserveManager);
        okuUsd.depositReserves(depositAmount);

        uint256 reservesAfter = okuUsd.totalNoteReserves();
        assertEq(
            reservesAfter,
            reservesBefore + depositAmount,
            "Reserves must increase by exact deposit amount"
        );
    }
}
