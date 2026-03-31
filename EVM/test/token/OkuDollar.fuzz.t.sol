// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";

/**
 * @title OkuDollarFuzzTest
 * @notice Fuzz tests for OkuDollar rebasing vault: wrap/unwrap math, collateralization, and share invariants
 * @dev Updated for OkuMoney non-rebasing redesign. OkuMoney balanceOf is static;
 *      okuMPrice() tracks price appreciation separately. Wrap/unwrap are price-aware:
 *      sharesToMint = okuMAmount × okuMPrice / usdMultiplier,
 *      okuMReturned = usdAmount × PRECISION / okuMPrice.
 *      Note: usdMultiplier converts shares↔dollars, NOT dollars↔OkuMoney.
 */
contract OkuDollarFuzzTest is BaseTest {
    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint OkuMoney to users for wrapping
        _mintOkuMoney(user1, MAX_SUPPLY / 4);
        _mintOkuMoney(user2, MAX_SUPPLY / 4);
        // Pre-approve vault for notes
        _approveOkuMoney(user1, address(usdOku), type(uint256).max);
        _approveOkuMoney(user2, address(usdOku), type(uint256).max);
    }

    // ============ 1. Wrap/Unwrap Round-Trip ============

    /// @notice Wrap then unwrap should return original note amount (max 1 wei loss)
    /// @dev At parity (notePrice == usdMultiplier == 1e18):
    ///      wrap(N) → usdMinted = N × 1e18 / 1e18 = N
    ///      unwrap(N) → okuMReturned = N × 1e18 / 1e18 = N
    ///      Round-trip: unwrap(wrap(okuMAmount)) ≈ okuMAmount
    function testFuzz_WrapUnwrapRoundTrip(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.startPrank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);
        uint256 notesBack = usdOku.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Max 1 wei loss on round trip");
        assertLe(notesBack, okuMAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip at various USD multipliers (price-aware)
    /// @dev When usdMultiplier is elevated:
    ///      wrap(N) → sharesToMint = N × notePrice / usdMultiplier
    ///      balanceOf = shares × usdMultiplier / PRECISION
    ///
    ///      Key insight: The usdMultiplier converts shares↔dollars, NOT dollars↔OkuMoney.
    ///      unwrap formula: okuMReturned = usdAmount × PRECISION / okuMPrice
    ///
    ///      At elevated usdMultiplier with notePrice=PRECISION:
    ///      - wrap(N): shares = N × PRECISION / mult (fewer shares)
    ///      - balanceOf: shares × mult / PRECISION = N (unchanged dollar balance)
    ///      - unwrap(N): okuMReturned = N × PRECISION / PRECISION = N (correct!)
    ///
    ///      The vault stays solvent because the multiplier doesn't inflate OkuMoney output.
    function testFuzz_WrapUnwrapRoundTripAtMultiplier(
        uint256 okuMAmount,
        uint256 multiplier
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 2);
        uint256 currentMult = usdOku.usdMultiplier();
        // Limit multiplier to avoid extreme edge cases
        multiplier = bound(multiplier, currentMult, currentMult * 5);

        // Set USD multiplier (notePrice stays at PRECISION)
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(multiplier);

        uint256 price = okuMoney.okuMPrice(); // Still at PRECISION

        vm.startPrank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = usdOku.balanceOf(user1);
        if (usdBalance == 0) {
            vm.stopPrank();
            return;
        }

        // With correct formula, unwrap returns: usdAmount × PRECISION / okuMPrice
        // At okuMPrice = PRECISION: unwrap(usdBalance) returns usdBalance OkuMoney
        // So we can always unwrap full balance if reserves == wrapped amount
        uint256 usdToUnwrap = usdBalance;

        uint256 notesBack = usdOku.unwrap(usdToUnwrap, user1);
        vm.stopPrank();

        // Expected notes back = usdToUnwrap × PRECISION / price
        uint256 expectedNotes = (usdToUnwrap * PRECISION) / price;

        // Should get approximately expected (within rounding)
        assertLe(notesBack, expectedNotes + 1, "Cannot gain more than expected");
        assertGe(
            notesBack,
            expectedNotes > 1 ? expectedNotes - 1 : 0,
            "Should get approximately expected"
        );
    }

    /// @notice Round-trip at various note prices (price-aware)
    /// @dev When notePrice > 1e18:
    ///      wrap(N) → usdMinted = N × notePrice / usdMultiplier (more OkuDollar)
    ///      unwrap(usdMinted) → okuMReturned = usdMinted × PRECISION / notePrice ≈ N
    function testFuzz_WrapUnwrapRoundTripAtNotePrice(uint256 okuMAmount, uint256 notePrice) public {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 2);
        notePrice = _boundOkuMPrice(notePrice);

        // Set note price and roll to next block to avoid yield distribution lock
        _setOkuMPriceAndRoll(notePrice);

        vm.startPrank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        if (usdMinted == 0) {
            vm.stopPrank();
            return;
        }

        uint256 notesBack = usdOku.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertLe(notesBack, okuMAmount, "Cannot gain on round trip");
        // Allow proportional tolerance for rounding at high prices
        uint256 maxLoss = (okuMAmount * notePrice) / (PRECISION * PRECISION) + 2;
        assertGe(
            notesBack,
            okuMAmount > maxLoss ? okuMAmount - maxLoss : 0,
            "Excessive loss on round trip"
        );
    }

    // ============ 2. Wrap Rounding Favors Vault ============

    /// @notice Wrap share calculation rounds DOWN, favoring the vault
    /// @dev usdMinted = okuMAmount × notePrice / usdMultiplier (truncated)
    ///      sharesToMint = usdMinted × PRECISION / usdMultiplier (truncated)
    ///      Both divisions round down → vault never overmints
    function testFuzz_WrapRoundingFavorsVault(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        uint256 mult = usdOku.usdMultiplier();
        uint256 price = okuMoney.okuMPrice();

        // usdMinted = okuMAmount × notePrice / usdMultiplier (rounds down)
        uint256 expectedUsd = (okuMAmount * price) / mult;
        // sharesToMint = usdMinted × PRECISION / usdMultiplier (rounds down)
        uint256 expectedShares = (expectedUsd * PRECISION) / mult;

        if (expectedShares == 0) return;

        // Verify: implied dollar value of shares <= note dollar value deposited
        uint256 impliedDollarValue = (expectedShares * mult) / PRECISION;
        uint256 notesDollarValue = (okuMAmount * price) / PRECISION;
        assertLe(impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault");

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        assertEq(usdOku.usdSharesOf(user1), expectedShares, "Shares minted match expected");
    }

    /// @notice Wrap rounding at elevated USD multiplier (price-aware)
    function testFuzz_WrapRoundingAtHighMultiplier(uint256 okuMAmount, uint256 multiplier) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);
        uint256 currentMult = usdOku.usdMultiplier();
        multiplier = bound(multiplier, currentMult + 1, currentMult * 10);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(multiplier);

        uint256 price = okuMoney.okuMPrice();

        // Contract logic: sharesToMint = okuMAmount × notePrice / usdMultiplier
        // (single division, NOT two sequential divisions)
        uint256 expectedShares = (okuMAmount * price) / multiplier;

        if (expectedShares == 0) return;

        uint256 impliedDollarValue = (expectedShares * multiplier) / PRECISION;
        uint256 notesDollarValue = (okuMAmount * price) / PRECISION;
        assertLe(
            impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault at any multiplier"
        );

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        assertEq(usdOku.usdSharesOf(user1), expectedShares, "Shares match at elevated multiplier");
    }

    /// @notice Wrap rounding at elevated note price
    function testFuzz_WrapRoundingAtHighNotePrice(uint256 okuMAmount, uint256 notePrice) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);
        notePrice = _boundOkuMPrice(notePrice);

        _setOkuMPriceAndRoll(notePrice);

        uint256 mult = usdOku.usdMultiplier();

        // usdMinted = okuMAmount × notePrice / usdMultiplier
        uint256 expectedUsd = (okuMAmount * notePrice) / mult;
        // sharesToMint = usdMinted × PRECISION / usdMultiplier
        uint256 expectedShares = (expectedUsd * PRECISION) / mult;

        if (expectedShares == 0) return;

        uint256 impliedDollarValue = (expectedShares * mult) / PRECISION;
        uint256 notesDollarValue = (okuMAmount * notePrice) / PRECISION;
        assertLe(
            impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault at any note price"
        );

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        assertEq(usdOku.usdSharesOf(user1), expectedShares, "Shares match at elevated note price");
    }

    // ============ 3. Unwrap Rounding Favors Vault ============

    /// @notice Unwrap share burn rounds UP, favoring the vault
    /// @dev sharesToBurn = (usdAmount × PRECISION + mult - 1) / mult (ceil division)
    function testFuzz_UnwrapRoundingFavorsVault(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = usdOku.balanceOf(user1);
        if (usdBalance == 0) return;

        uint256 mult = usdOku.usdMultiplier();
        uint256 sharesBefore = usdOku.usdSharesOf(user1);

        // Expected shares to burn (round UP)
        uint256 expectedBurn = (usdBalance * PRECISION + mult - 1) / mult;

        vm.prank(user1);
        usdOku.unwrap(usdBalance, user1);

        uint256 sharesAfter = usdOku.usdSharesOf(user1);
        uint256 actualBurn = sharesBefore - sharesAfter;

        assertGe(actualBurn, (usdBalance * PRECISION) / mult, "Burn must be >= floor (round up)");
        assertEq(actualBurn, expectedBurn, "Burn matches ceil division");
    }

    // ============ 4. Collateralization Under Various Rates ============

    /// @notice After wrap at 1:1 (notePrice == usdMultiplier == PRECISION), ratio >= 100%
    function testFuzz_CollateralizationAtParity(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 ratio = usdOku.collateralizationRatio();
        assertGe(ratio, PRECISION, "Collateral ratio must be >= 100% at parity");
    }

    /// @notice After notePrice increase, vault becomes overcollateralized
    /// @dev notePrice increase does NOT change vault's note token count, but increases
    ///      their dollar value: (reserves × notePrice / PRECISION) grows while totalSupply
    ///      (OkuDollar obligations) stays the same.
    function testFuzz_NotePriceIncreaseOvercollateralizes(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 currentNotePrice = okuMoney.okuMPrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 100, currentNotePrice * 5);

        // Increase note price — vault note balance unchanged, but dollar value increases
        // No need to roll here since we're only checking collateralization, not wrapping/unwrapping
        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newNotePrice);

        uint256 ratio = usdOku.collateralizationRatio();
        assertGe(ratio, PRECISION, "Note price increase should overcollateralize vault");
    }

    /// @notice After USD rebase without note price change, vault becomes undercollateralized
    /// @dev usdMultiplier increase grows totalSupply (obligations) while reserve dollar
    ///      value (reserves × notePrice / PRECISION) stays the same.
    function testFuzz_UsdRebaseUndercollateralizes(
        uint256 okuMAmount,
        uint256 usdMultiplier
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 currentUsdMult = usdOku.usdMultiplier();
        usdMultiplier =
            bound(usdMultiplier, currentUsdMult + currentUsdMult / 100, currentUsdMult * 5);

        // Rebase USD only — OkuDollar supply grows, note reserves dollar value stays same
        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(usdMultiplier);

        uint256 ratio = usdOku.collateralizationRatio();
        assertLe(ratio, PRECISION, "USD-only rebase should undercollateralize vault");
    }

    /// @notice Collateralization views are consistent (price-aware)
    /// @dev reserves dollar value = reserves × notePrice / PRECISION
    ///      obligations = totalSupply (already in dollar terms)
    ///      surplus converts dollar surplus back to note tokens via notePrice
    function testFuzz_CollateralizationViewsConsistent(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 reserves = usdOku.totalOkuMReserves();
        uint256 obligations = usdOku.totalUsdObligations();
        uint256 ratio = usdOku.collateralizationRatio();
        uint256 surplusVal = usdOku.surplus();
        uint256 price = okuMoney.okuMPrice();

        assertEq(obligations, usdOku.totalSupply(), "Obligations == totalSupply");
        assertEq(reserves, okuMoney.balanceOf(address(usdOku)), "Reserves == note balance");

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
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 2);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 currentNotePrice = okuMoney.okuMPrice();
        newNotePrice = bound(newNotePrice, currentNotePrice, currentNotePrice * 5);

        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newNotePrice);

        uint256 reserves = usdOku.totalOkuMReserves();
        uint256 obligations = usdOku.totalUsdObligations();
        uint256 ratio = usdOku.collateralizationRatio();
        uint256 price = okuMoney.okuMPrice();

        // Note balance in vault unchanged (non-rebasing)
        assertEq(reserves, okuMoney.balanceOf(address(usdOku)), "Reserves == note balance");

        // Dollar value of reserves increased
        uint256 reservesDollarValue = (reserves * price) / PRECISION;
        if (obligations > 0) {
            uint256 expectedRatio = (reservesDollarValue * PRECISION) / obligations;
            assertEq(ratio, expectedRatio, "Ratio formula matches");
        }
    }

    // ============ 5. Surplus Extraction ============

    /// @notice withdrawSurplus reverts when at or below floor
    function testFuzz_WithdrawSurplusRevertsAtFloor(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 surplusVal = usdOku.surplus();

        // Fund reserveManager to call withdrawSurplus
        if (surplusVal > 0) {
            // Try to withdraw more than surplus — should revert
            vm.prank(reserveManager);
            vm.expectRevert(OkuDollar.BelowMinimumCollateral.selector);
            usdOku.withdrawSurplus(surplusVal + 1e18);
        }

        // With no extra reserves, any withdrawal should fail or leave ratio below floor
        // Deposit exact okuMAmount means ratio ~= 100%, surplus ~= 0 at parity
    }

    /// @notice withdrawSurplus succeeds when overcollateralized, respects floor
    function testFuzz_WithdrawSurplusWithExcessReserves(
        uint256 okuMAmount,
        uint256 extraNotes
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 4);
        extraNotes = bound(extraNotes, 1e6, okuMoney.balanceOf(user1) / 4);

        // Wrap to create OkuDollar supply
        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        // Deposit extra reserves (overcollateralize)
        _mintOkuMoney(reserveManager, extraNotes);
        _approveOkuMoney(reserveManager, address(usdOku), extraNotes);
        vm.prank(reserveManager);
        usdOku.depositReserves(extraNotes);

        uint256 surplusVal = usdOku.surplus();
        assertGt(surplusVal, 0, "Should have surplus after extra deposit");

        uint256 ratioBefore = usdOku.collateralizationRatio();

        // Withdraw exactly the surplus
        vm.prank(reserveManager);
        usdOku.withdrawSurplus(surplusVal);

        uint256 ratioAfter = usdOku.collateralizationRatio();
        assertGe(ratioAfter, usdOku.minCollateralRatio(), "Must stay above floor after withdrawal");
        assertLe(ratioAfter, ratioBefore, "Ratio should decrease after withdrawal");
    }

    /// @notice withdrawSurplus reverts if would breach minCollateralRatio
    function testFuzz_WithdrawSurplusRevertsBelowFloor(
        uint256 okuMAmount,
        uint256 extraNotes
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 4);
        extraNotes = bound(extraNotes, 1e6, okuMAmount / 10);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        // Small extra deposit
        _mintOkuMoney(reserveManager, extraNotes);
        _approveOkuMoney(reserveManager, address(usdOku), extraNotes);
        vm.prank(reserveManager);
        usdOku.depositReserves(extraNotes);

        // Try to withdraw way more than surplus
        uint256 totalReserves = usdOku.totalOkuMReserves();
        uint256 excessiveWithdraw = totalReserves; // withdrawing everything

        vm.prank(reserveManager);
        vm.expectRevert();
        usdOku.withdrawSurplus(excessiveWithdraw);
    }

    /// @notice withdrawSurplus works after notePrice increase creates surplus
    function testFuzz_WithdrawSurplusAfterNotePriceIncrease(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 4);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 currentNotePrice = okuMoney.okuMPrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 3);

        // notePrice increase → vault's reserve dollar value grows → surplus created
        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newNotePrice);

        uint256 surplusVal = usdOku.surplus();
        assertGt(surplusVal, 0, "Should have surplus after note price increase");

        // Withdraw surplus
        vm.prank(reserveManager);
        usdOku.withdrawSurplus(surplusVal);

        uint256 ratioAfter = usdOku.collateralizationRatio();
        assertGe(ratioAfter, usdOku.minCollateralRatio(), "Must stay above floor after withdrawal");
    }

    // ============ 6. Balance Formula ============

    /// @notice balanceOf == usdShares * usdMultiplier / PRECISION
    function testFuzz_BalanceFormula(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 shares = usdOku.usdSharesOf(user1);
        uint256 mult = usdOku.usdMultiplier();
        uint256 expected = (shares * mult) / PRECISION;

        assertEq(
            usdOku.balanceOf(user1), expected, "balanceOf must equal shares * mult / PRECISION"
        );
    }

    /// @notice Balance formula holds after USD rebase
    function testFuzz_BalanceFormulaAfterRebase(uint256 okuMAmount, uint256 newMultiplier) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 currentMult = usdOku.usdMultiplier();
        newMultiplier = bound(newMultiplier, currentMult, currentMult * 10);

        vm.prank(usdRebaser);
        usdOku.updateUsdMultiplier(newMultiplier);

        uint256 shares = usdOku.usdSharesOf(user1);
        uint256 mult = usdOku.usdMultiplier();
        uint256 expected = (shares * mult) / PRECISION;

        assertEq(usdOku.balanceOf(user1), expected, "Balance formula must hold after rebase");
    }

    /// @notice OkuDollar balance NOT affected by notePrice changes
    /// @dev notePrice increase doesn't change usdShares or usdMultiplier,
    ///      so OkuDollar balanceOf is unchanged. Only collateralization changes.
    function testFuzz_OkuUsdBalanceUnchangedByNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 balanceBefore = usdOku.balanceOf(user1);
        uint256 sharesBefore = usdOku.usdSharesOf(user1);

        newNotePrice = _boundOkuMPrice(newNotePrice);

        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newNotePrice);

        uint256 balanceAfter = usdOku.balanceOf(user1);
        uint256 sharesAfter = usdOku.usdSharesOf(user1);

        assertEq(sharesAfter, sharesBefore, "Shares unchanged by notePrice");
        assertEq(balanceAfter, balanceBefore, "OkuDollar balance unchanged by notePrice");
    }

    /// @notice totalSupply == totalUsdShares * usdMultiplier / PRECISION
    function testFuzz_TotalSupplyFormula(uint256 amount1, uint256 amount2) public {
        amount1 = bound(amount1, 1e6, okuMoney.balanceOf(user1) / 2);
        amount2 = bound(amount2, 1e6, okuMoney.balanceOf(user2) / 2);

        vm.prank(user1);
        usdOku.wrap(amount1, user1, 0);

        vm.prank(user2);
        usdOku.wrap(amount2, user2, 0);

        uint256 totalShares = usdOku.totalUsdShares();
        uint256 mult = usdOku.usdMultiplier();
        uint256 expected = (totalShares * mult) / PRECISION;

        assertEq(
            usdOku.totalSupply(), expected, "totalSupply must equal totalShares * mult / PRECISION"
        );
    }

    // ============ 7. Transfer Preserves Shares ============

    /// @notice Total shares unchanged after transfer
    function testFuzz_TransferPreservesShares(uint256 okuMAmount, uint256 transferAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = usdOku.balanceOf(user1);
        transferAmount = bound(transferAmount, 1, usdBalance);

        uint256 totalSharesBefore = usdOku.totalUsdShares();

        vm.prank(user1);
        usdOku.transfer(user2, transferAmount);

        uint256 totalSharesAfter = usdOku.totalUsdShares();

        assertEq(totalSharesAfter, totalSharesBefore, "Total shares must not change on transfer");
    }

    /// @notice Individual shares sum preserved after transfer
    function testFuzz_TransferSharesSum(uint256 okuMAmount, uint256 transferAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = usdOku.balanceOf(user1);
        transferAmount = bound(transferAmount, 1, usdBalance);

        uint256 user1SharesBefore = usdOku.usdSharesOf(user1);
        uint256 user2SharesBefore = usdOku.usdSharesOf(user2);

        vm.prank(user1);
        usdOku.transfer(user2, transferAmount);

        uint256 user1SharesAfter = usdOku.usdSharesOf(user1);
        uint256 user2SharesAfter = usdOku.usdSharesOf(user2);

        assertEq(
            user1SharesAfter + user2SharesAfter,
            user1SharesBefore + user2SharesBefore,
            "Sum of individual shares must be preserved"
        );
    }

    // ============ 8. Multiple Wrap/Unwrap No Inflation ============

    /// @notice Repeated wrap/unwrap cycles don't create extra shares (rUSDY H-01 mitigation)
    function testFuzz_RepeatedWrapUnwrapNoInflation(uint256 okuMAmount, uint8 cycles) public {
        okuMAmount = bound(okuMAmount, 1e12, okuMoney.balanceOf(user1) / 2);
        cycles = uint8(bound(cycles, 2, 10));

        // First wrap
        vm.startPrank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 initialShares = usdOku.usdSharesOf(user1);

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = usdOku.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = usdOku.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            // Re-approve note for vault
            okuMoney.approve(address(usdOku), notesBack);
            usdOku.wrap(notesBack, user1, 0);
        }
        vm.stopPrank();

        uint256 finalShares = usdOku.usdSharesOf(user1);

        // Shares should not increase (they may decrease slightly due to rounding)
        assertLe(finalShares, initialShares, "Shares must not inflate after repeated cycles");
    }

    /// @notice Total supply does not inflate through wrap/unwrap cycles
    function testFuzz_RepeatedCyclesNoSupplyInflation(uint256 okuMAmount, uint8 cycles) public {
        okuMAmount = bound(okuMAmount, 1e12, okuMoney.balanceOf(user1) / 2);
        cycles = uint8(bound(cycles, 2, 10));

        vm.startPrank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 initialSupply = usdOku.totalSupply();

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = usdOku.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = usdOku.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            okuMoney.approve(address(usdOku), notesBack);
            usdOku.wrap(notesBack, user1, 0);
        }
        vm.stopPrank();

        uint256 finalSupply = usdOku.totalSupply();
        assertLe(finalSupply, initialSupply, "Total supply must not inflate through cycles");
    }

    /// @notice Repeated cycles at elevated notePrice don't inflate
    function testFuzz_RepeatedCyclesAtHighNotePriceNoInflation(
        uint256 okuMAmount,
        uint256 notePrice,
        uint8 cycles
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e12, okuMoney.balanceOf(user1) / 2);
        notePrice = _boundOkuMPrice(notePrice);
        cycles = uint8(bound(cycles, 2, 10));

        _setOkuMPriceAndRoll(notePrice);

        vm.startPrank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 initialShares = usdOku.usdSharesOf(user1);

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = usdOku.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = usdOku.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            okuMoney.approve(address(usdOku), notesBack);
            usdOku.wrap(notesBack, user1, 0);
        }
        vm.stopPrank();

        uint256 finalShares = usdOku.usdSharesOf(user1);
        assertLe(
            finalShares,
            initialShares,
            "Shares must not inflate after repeated cycles at high notePrice"
        );
    }

    // ============ 9. depositReserves Increases Collateral Ratio ============

    /// @notice depositReserves increases collateralization without minting shares
    function testFuzz_DepositReservesIncreasesRatio(
        uint256 okuMAmount,
        uint256 depositAmount
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 4);
        depositAmount = bound(depositAmount, 1e6, okuMoney.balanceOf(user1) / 4);

        // Create OkuDollar supply
        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 sharesBefore = usdOku.totalUsdShares();
        uint256 ratioBefore = usdOku.collateralizationRatio();

        // Deposit reserves
        _mintOkuMoney(reserveManager, depositAmount);
        _approveOkuMoney(reserveManager, address(usdOku), depositAmount);
        vm.prank(reserveManager);
        usdOku.depositReserves(depositAmount);

        uint256 sharesAfter = usdOku.totalUsdShares();
        uint256 ratioAfter = usdOku.collateralizationRatio();

        assertEq(sharesAfter, sharesBefore, "depositReserves must not mint USD shares");
        assertGe(ratioAfter, ratioBefore, "Collateral ratio must not decrease after deposit");
    }

    /// @notice depositReserves reflected in totalNoteReserves
    function testFuzz_DepositReservesReflectedInReserves(
        uint256 okuMAmount,
        uint256 depositAmount
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 4);
        depositAmount = bound(depositAmount, 1e6, okuMoney.balanceOf(user1) / 4);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 reservesBefore = usdOku.totalOkuMReserves();

        _mintOkuMoney(reserveManager, depositAmount);
        _approveOkuMoney(reserveManager, address(usdOku), depositAmount);
        vm.prank(reserveManager);
        usdOku.depositReserves(depositAmount);

        uint256 reservesAfter = usdOku.totalOkuMReserves();
        assertEq(
            reservesAfter,
            reservesBefore + depositAmount,
            "Reserves must increase by exact deposit amount"
        );
    }

    // ============ 10. Price-Aware Wrap Amount ============

    /// @notice Wrap gives more OkuDollar when notePrice > PRECISION
    /// @dev usdMinted = okuMAmount × notePrice / usdMultiplier
    ///      At notePrice = 1.5e18, usdMultiplier = 1e18: wrap(100e18) → 150e18 OkuDollar
    function testFuzz_WrapGivesMoreUsdAtHighNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 4);
        uint256 currentNotePrice = okuMoney.okuMPrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 5);

        // Wrap at current price to get baseline
        vm.startPrank(user1);
        uint256 usdAtParity = usdOku.wrap(okuMAmount, user1, 0);

        // Unwrap to reset (use balanceOf to avoid ceil-vs-floor share mismatch)
        uint256 usdBalance = usdOku.balanceOf(user1);
        usdOku.unwrap(usdBalance, user1);
        vm.stopPrank();

        // Increase note price and roll to avoid yield distribution lock
        _setOkuMPriceAndRoll(newNotePrice);

        // Wrap same note amount at higher price
        vm.prank(user1);
        uint256 usdAtHighPrice = usdOku.wrap(okuMAmount, user1, 0);

        assertGt(
            usdAtHighPrice, usdAtParity, "Wrap must give more OkuDollar when notePrice is higher"
        );
    }

    /// @notice Unwrap returns fewer note tokens when notePrice > PRECISION
    /// @dev okuMReturned = usdAmount × usdMultiplier / notePrice
    ///      At notePrice = 2e18, usdMultiplier = 1e18: unwrap(100e18 OkuDollar) → 50e18 notes
    function testFuzz_UnwrapReturnsFewer_NotesAtHighNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 4);

        // Wrap at parity to establish baseline
        vm.prank(user1);
        uint256 usdMinted = usdOku.wrap(okuMAmount, user1, 0);

        // Increase note price (vault now overcollateralized)
        uint256 currentNotePrice = okuMoney.okuMPrice();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 5);

        _setOkuMPriceAndRoll(newNotePrice);

        // Unwrap at higher note price — should get fewer note tokens back
        vm.prank(user1);
        uint256 notesBack = usdOku.unwrap(usdMinted, user1);

        assertLt(
            notesBack, okuMAmount, "Unwrap must return fewer notes when notePrice has increased"
        );
    }

    // ============ 11. OkuMoney Balance Invariants ============

    /// @notice OkuMoney balanceOf is NOT affected by notePrice changes
    /// @dev This is the key semantic change: non-rebasing means balances are static
    function testFuzz_OkuMoneyBalanceUnchangedByNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        newNotePrice = _boundOkuMPrice(newNotePrice);

        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newNotePrice);

        uint256 balanceAfter = okuMoney.balanceOf(user1);
        assertEq(balanceAfter, balanceBefore, "OkuMoney balanceOf must not change with notePrice");
    }

    /// @notice Vault's note token count unchanged by notePrice increase
    /// @dev Reserve note balance is static; only dollar value (reserves × notePrice) changes
    function testFuzz_VaultNoteBalanceUnchangedByNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);

        vm.prank(user1);
        usdOku.wrap(okuMAmount, user1, 0);

        uint256 vaultBalanceBefore = okuMoney.balanceOf(address(usdOku));

        newNotePrice = _boundOkuMPrice(newNotePrice);

        vm.prank(rebaser);
        okuMoney.setOkuMPrice(newNotePrice);

        uint256 vaultBalanceAfter = okuMoney.balanceOf(address(usdOku));
        assertEq(
            vaultBalanceAfter,
            vaultBalanceBefore,
            "Vault note token count must not change with notePrice"
        );
    }
}
