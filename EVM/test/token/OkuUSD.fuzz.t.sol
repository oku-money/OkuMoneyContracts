// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title OkuUSDFuzzTest
 * @notice Fuzz tests for OkuUSD rebasing vault: wrap/unwrap math, collateralization, and share invariants
 * @dev Updated for OkuNote non-rebasing redesign. OkuNote balanceOf is static;
 *      notePrice() tracks price appreciation separately. Wrap/unwrap are price-aware:
 *      usdMinted = noteAmount × notePrice / usdMultiplier,
 *      notesReturned = usdAmount × usdMultiplier / notePrice.
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

    /// @notice Wrap then unwrap should return original note amount (max 1 wei loss)
    /// @dev At parity (notePrice == usdMultiplier == 1e18):
    ///      wrap(N) → usdMinted = N × 1e18 / 1e18 = N
    ///      unwrap(N) → notesReturned = N × 1e18 / 1e18 = N
    ///      Round-trip: unwrap(wrap(noteAmount)) ≈ noteAmount
    function testFuzz_WrapUnwrapRoundTrip(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.startPrank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);
        uint256 notesBack = okuUsd.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, noteAmount - 1, "Max 1 wei loss on round trip");
        assertLe(notesBack, noteAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip at various USD multipliers (price-aware)
    /// @dev When usdMultiplier > 1e18:
    ///      wrap(N) → usdMinted = N × notePrice / usdMultiplier (fewer OkuUSD)
    ///      unwrap(balanceOf) → notesReturned ≈ N
    ///      We unwrap balanceOf (not usdMinted) because ceil-division in unwrap
    ///      can require 1 more share than floor-division in wrap minted.
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

        uint256 usdBalance = okuUsd.balanceOf(user1);
        if (usdBalance == 0) {
            vm.stopPrank();
            return;
        }

        // Unwrap full balance — avoids ceil-vs-floor share mismatch
        uint256 notesBack = okuUsd.unwrap(usdBalance, user1);
        vm.stopPrank();

        assertLe(notesBack, noteAmount, "Cannot gain on round trip");
        // At higher multipliers, rounding compounds across multiple divisions in
        // wrap (2 divisions) and unwrap (1 division) plus balanceOf (1 division).
        // Each division can lose up to (divisor - 1) absolute wei, which translates
        // to proportionally more note-token loss at larger noteAmount.
        // Use relative tolerance: loss should be < 1 part per billion of noteAmount,
        // plus a small absolute floor for tiny amounts.
        uint256 maxLoss = noteAmount / 1e9 + (4 * multiplier) / okuNote.notePrice() + 2;
        assertGe(
            notesBack,
            noteAmount > maxLoss ? noteAmount - maxLoss : 0,
            "Excessive loss on round trip"
        );
    }

    /// @notice Round-trip at various note prices (price-aware)
    /// @dev When notePrice > 1e18:
    ///      wrap(N) → usdMinted = N × notePrice / usdMultiplier (more OkuUSD)
    ///      unwrap(usdMinted) → notesReturned = usdMinted × usdMultiplier / notePrice ≈ N
    function testFuzz_WrapUnwrapRoundTripAtNotePrice(uint256 noteAmount, uint256 notePrice) public {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 2);
        notePrice = _boundNotePrice(notePrice);

        // Set note price
        vm.prank(rebaser);
        okuNote.updateNotePrice(notePrice);

        vm.startPrank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        if (usdMinted == 0) {
            vm.stopPrank();
            return;
        }

        uint256 notesBack = okuUsd.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertLe(notesBack, noteAmount, "Cannot gain on round trip");
        // Allow proportional tolerance for rounding at high prices
        uint256 maxLoss = (noteAmount * notePrice) / (PRECISION * PRECISION) + 2;
        assertGe(
            notesBack,
            noteAmount > maxLoss ? noteAmount - maxLoss : 0,
            "Excessive loss on round trip"
        );
    }

    // ============ 2. Wrap Rounding Favors Vault ============

    /// @notice Wrap share calculation rounds DOWN, favoring the vault
    /// @dev usdMinted = noteAmount × notePrice / usdMultiplier (truncated)
    ///      sharesToMint = usdMinted × PRECISION / usdMultiplier (truncated)
    ///      Both divisions round down → vault never overmints
    function testFuzz_WrapRoundingFavorsVault(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        uint256 mult = okuUsd.usdMultiplier();
        uint256 price = okuNote.notePrice();

        // usdMinted = noteAmount × notePrice / usdMultiplier (rounds down)
        uint256 expectedUsd = (noteAmount * price) / mult;
        // sharesToMint = usdMinted × PRECISION / usdMultiplier (rounds down)
        uint256 expectedShares = (expectedUsd * PRECISION) / mult;

        if (expectedShares == 0) return;

        // Verify: implied dollar value of shares <= note dollar value deposited
        uint256 impliedDollarValue = (expectedShares * mult) / PRECISION;
        uint256 notesDollarValue = (noteAmount * price) / PRECISION;
        assertLe(impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault");

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        assertEq(okuUsd.usdSharesOf(user1), expectedShares, "Shares minted match expected");
    }

    /// @notice Wrap rounding at elevated USD multiplier (price-aware)
    function testFuzz_WrapRoundingAtHighMultiplier(uint256 noteAmount, uint256 multiplier) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);
        uint256 currentMult = okuUsd.usdMultiplier();
        multiplier = bound(multiplier, currentMult + 1, currentMult * 10);

        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(multiplier);

        uint256 price = okuNote.notePrice();

        // usdMinted = noteAmount × notePrice / usdMultiplier
        uint256 expectedUsd = (noteAmount * price) / multiplier;
        // sharesToMint = usdMinted × PRECISION / usdMultiplier
        uint256 expectedShares = (expectedUsd * PRECISION) / multiplier;

        if (expectedShares == 0) return;

        uint256 impliedDollarValue = (expectedShares * multiplier) / PRECISION;
        uint256 notesDollarValue = (noteAmount * price) / PRECISION;
        assertLe(
            impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault at any multiplier"
        );

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        assertEq(okuUsd.usdSharesOf(user1), expectedShares, "Shares match at elevated multiplier");
    }

    /// @notice Wrap rounding at elevated note price
    function testFuzz_WrapRoundingAtHighNotePrice(uint256 noteAmount, uint256 notePrice) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);
        notePrice = _boundNotePrice(notePrice);

        vm.prank(rebaser);
        okuNote.updateNotePrice(notePrice);

        uint256 mult = okuUsd.usdMultiplier();

        // usdMinted = noteAmount × notePrice / usdMultiplier
        uint256 expectedUsd = (noteAmount * notePrice) / mult;
        // sharesToMint = usdMinted × PRECISION / usdMultiplier
        uint256 expectedShares = (expectedUsd * PRECISION) / mult;

        if (expectedShares == 0) return;

        uint256 impliedDollarValue = (expectedShares * mult) / PRECISION;
        uint256 notesDollarValue = (noteAmount * notePrice) / PRECISION;
        assertLe(
            impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault at any note price"
        );

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        assertEq(okuUsd.usdSharesOf(user1), expectedShares, "Shares match at elevated note price");
    }

    // ============ 3. Unwrap Rounding Favors Vault ============

    /// @notice Unwrap share burn rounds UP, favoring the vault
    /// @dev sharesToBurn = (usdAmount × PRECISION + mult - 1) / mult (ceil division)
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

    /// @notice After wrap at 1:1 (notePrice == usdMultiplier == PRECISION), ratio >= 100%
    function testFuzz_CollateralizationAtParity(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 ratio = okuUsd.collateralizationRatio();
        assertGe(ratio, PRECISION, "Collateral ratio must be >= 100% at parity");
    }

    /// @notice After notePrice increase, vault becomes overcollateralized
    /// @dev notePrice increase does NOT change vault's note token count, but increases
    ///      their dollar value: (reserves × notePrice / PRECISION) grows while totalSupply
    ///      (OkuUSD obligations) stays the same.
    function testFuzz_NotePriceIncreaseOvercollateralizes(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 currentNotePrice = okuNote.notePrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 100, currentNotePrice * 5);

        // Increase note price — vault note balance unchanged, but dollar value increases
        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        uint256 ratio = okuUsd.collateralizationRatio();
        assertGe(ratio, PRECISION, "Note price increase should overcollateralize vault");
    }

    /// @notice After USD rebase without note price change, vault becomes undercollateralized
    /// @dev usdMultiplier increase grows totalSupply (obligations) while reserve dollar
    ///      value (reserves × notePrice / PRECISION) stays the same.
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

        // Rebase USD only — OkuUSD supply grows, note reserves dollar value stays same
        vm.prank(usdRebaser);
        okuUsd.updateUsdMultiplier(usdMultiplier);

        uint256 ratio = okuUsd.collateralizationRatio();
        assertLe(ratio, PRECISION, "USD-only rebase should undercollateralize vault");
    }

    /// @notice Collateralization views are consistent (price-aware)
    /// @dev reserves dollar value = reserves × notePrice / PRECISION
    ///      obligations = totalSupply (already in dollar terms)
    ///      surplus converts dollar surplus back to note tokens via notePrice
    function testFuzz_CollateralizationViewsConsistent(uint256 noteAmount) public {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 reserves = okuUsd.totalNoteReserves();
        uint256 obligations = okuUsd.totalUsdObligations();
        uint256 ratio = okuUsd.collateralizationRatio();
        uint256 surplusVal = okuUsd.surplus();
        uint256 price = okuNote.notePrice();

        assertEq(obligations, okuUsd.totalSupply(), "Obligations == totalSupply");
        assertEq(reserves, okuNote.balanceOf(address(okuUsd)), "Reserves == note balance");

        // Dollar value of reserves
        uint256 reservesDollarValue = (reserves * price) / PRECISION;

        if (reservesDollarValue >= obligations) {
            assertGe(ratio, PRECISION, "Ratio >= 100% when overcollateralized");
            // Surplus is in note tokens: (dollarSurplus × PRECISION) / notePrice
            uint256 dollarSurplus = reservesDollarValue - obligations;
            uint256 expectedSurplusNotes = (dollarSurplus * PRECISION) / price;
            assertEq(surplusVal, expectedSurplusNotes, "Surplus matches excess in note tokens");
        } else {
            assertLt(ratio, PRECISION, "Ratio < 100% when undercollateralized");
            assertEq(surplusVal, 0, "No surplus when undercollateralized");
        }
    }

    /// @notice Collateralization views consistent after notePrice increase
    function testFuzz_CollateralizationViewsAfterNotePriceIncrease(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 2);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 currentNotePrice = okuNote.notePrice();
        newNotePrice = bound(newNotePrice, currentNotePrice, currentNotePrice * 5);

        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        uint256 reserves = okuUsd.totalNoteReserves();
        uint256 obligations = okuUsd.totalUsdObligations();
        uint256 ratio = okuUsd.collateralizationRatio();
        uint256 price = okuNote.notePrice();

        // Note balance in vault unchanged (non-rebasing)
        assertEq(reserves, okuNote.balanceOf(address(okuUsd)), "Reserves == note balance");

        // Dollar value of reserves increased
        uint256 reservesDollarValue = (reserves * price) / PRECISION;
        if (obligations > 0) {
            uint256 expectedRatio = (reservesDollarValue * PRECISION) / obligations;
            assertEq(ratio, expectedRatio, "Ratio formula matches");
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

    /// @notice withdrawSurplus works after notePrice increase creates surplus
    function testFuzz_WithdrawSurplusAfterNotePriceIncrease(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 4);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 currentNotePrice = okuNote.notePrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 3);

        // notePrice increase → vault's reserve dollar value grows → surplus created
        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        uint256 surplusVal = okuUsd.surplus();
        assertGt(surplusVal, 0, "Should have surplus after note price increase");

        // Withdraw surplus
        vm.prank(reserveManager);
        okuUsd.withdrawSurplus(surplusVal);

        uint256 ratioAfter = okuUsd.collateralizationRatio();
        assertGe(ratioAfter, okuUsd.minCollateralRatio(), "Must stay above floor after withdrawal");
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

    /// @notice OkuUSD balance NOT affected by notePrice changes
    /// @dev notePrice increase doesn't change usdShares or usdMultiplier,
    ///      so OkuUSD balanceOf is unchanged. Only collateralization changes.
    function testFuzz_OkuUsdBalanceUnchangedByNotePrice(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 balanceBefore = okuUsd.balanceOf(user1);
        uint256 sharesBefore = okuUsd.usdSharesOf(user1);

        newNotePrice = _boundNotePrice(newNotePrice);

        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        uint256 balanceAfter = okuUsd.balanceOf(user1);
        uint256 sharesAfter = okuUsd.usdSharesOf(user1);

        assertEq(sharesAfter, sharesBefore, "Shares unchanged by notePrice");
        assertEq(balanceAfter, balanceBefore, "OkuUSD balance unchanged by notePrice");
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

    /// @notice Repeated cycles at elevated notePrice don't inflate
    function testFuzz_RepeatedCyclesAtHighNotePriceNoInflation(
        uint256 noteAmount,
        uint256 notePrice,
        uint8 cycles
    )
        public
    {
        noteAmount = bound(noteAmount, 1e12, okuNote.balanceOf(user1) / 2);
        notePrice = _boundNotePrice(notePrice);
        cycles = uint8(bound(cycles, 2, 10));

        vm.prank(rebaser);
        okuNote.updateNotePrice(notePrice);

        vm.startPrank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 initialShares = okuUsd.usdSharesOf(user1);

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = okuUsd.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = okuUsd.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            okuNote.approve(address(okuUsd), notesBack);
            okuUsd.wrap(notesBack, user1);
        }
        vm.stopPrank();

        uint256 finalShares = okuUsd.usdSharesOf(user1);
        assertLe(
            finalShares,
            initialShares,
            "Shares must not inflate after repeated cycles at high notePrice"
        );
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

    // ============ 10. Price-Aware Wrap Amount ============

    /// @notice Wrap gives more OkuUSD when notePrice > PRECISION
    /// @dev usdMinted = noteAmount × notePrice / usdMultiplier
    ///      At notePrice = 1.5e18, usdMultiplier = 1e18: wrap(100e18) → 150e18 OkuUSD
    function testFuzz_WrapGivesMoreUsdAtHighNotePrice(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 4);
        uint256 currentNotePrice = okuNote.notePrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 5);

        // Wrap at current price to get baseline
        vm.startPrank(user1);
        uint256 usdAtParity = okuUsd.wrap(noteAmount, user1);

        // Unwrap to reset (use balanceOf to avoid ceil-vs-floor share mismatch)
        uint256 usdBalance = okuUsd.balanceOf(user1);
        okuUsd.unwrap(usdBalance, user1);
        vm.stopPrank();

        // Increase note price
        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        // Wrap same note amount at higher price
        vm.prank(user1);
        uint256 usdAtHighPrice = okuUsd.wrap(noteAmount, user1);

        assertGt(usdAtHighPrice, usdAtParity, "Wrap must give more OkuUSD when notePrice is higher");
    }

    /// @notice Unwrap returns fewer note tokens when notePrice > PRECISION
    /// @dev notesReturned = usdAmount × usdMultiplier / notePrice
    ///      At notePrice = 2e18, usdMultiplier = 1e18: unwrap(100e18 OkuUSD) → 50e18 notes
    function testFuzz_UnwrapReturnsFewer_NotesAtHighNotePrice(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e18, okuNote.balanceOf(user1) / 4);

        // Wrap at parity to establish baseline
        vm.prank(user1);
        uint256 usdMinted = okuUsd.wrap(noteAmount, user1);

        // Increase note price (vault now overcollateralized)
        uint256 currentNotePrice = okuNote.notePrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 5);

        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        // Unwrap at higher note price — should get fewer note tokens back
        vm.prank(user1);
        uint256 notesBack = okuUsd.unwrap(usdMinted, user1);

        assertLt(
            notesBack, noteAmount, "Unwrap must return fewer notes when notePrice has increased"
        );
    }

    // ============ 11. OkuNote Balance Invariants ============

    /// @notice OkuNote balanceOf is NOT affected by notePrice changes
    /// @dev This is the key semantic change: non-rebasing means balances are static
    function testFuzz_OkuNoteBalanceUnchangedByNotePrice(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1));

        uint256 balanceBefore = okuNote.balanceOf(user1);

        newNotePrice = _boundNotePrice(newNotePrice);

        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        uint256 balanceAfter = okuNote.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore, "OkuNote balanceOf must not change with notePrice");
    }

    /// @notice Vault's note token count unchanged by notePrice increase
    /// @dev Reserve note balance is static; only dollar value (reserves × notePrice) changes
    function testFuzz_VaultNoteBalanceUnchangedByNotePrice(
        uint256 noteAmount,
        uint256 newNotePrice
    )
        public
    {
        noteAmount = bound(noteAmount, 1e6, okuNote.balanceOf(user1) / 2);

        vm.prank(user1);
        okuUsd.wrap(noteAmount, user1);

        uint256 vaultBalanceBefore = okuNote.balanceOf(address(okuUsd));

        newNotePrice = _boundNotePrice(newNotePrice);

        vm.prank(rebaser);
        okuNote.updateNotePrice(newNotePrice);

        uint256 vaultBalanceAfter = okuNote.balanceOf(address(okuUsd));
        assertEq(
            vaultBalanceAfter,
            vaultBalanceBefore,
            "Vault note token count must not change with notePrice"
        );
    }
}
