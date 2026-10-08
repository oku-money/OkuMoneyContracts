// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuDollarErrors} from "../../src/lib/errors/OkuDollarErrors.sol";

/**
 * @title OkuDollarFuzzTest
 * @notice Fuzz tests for OkuDollar rebasing vault: wrap/unwrap math, collateralization, and share invariants
 * @dev OkuMoney balanceOf is static; okuMMultiplier() tracks appreciation, and
 *      usdMultiplier() == okuMMultiplier(). Wrap/unwrap are multiplier-aware:
 *      sharesToMint = okuMAmount × okuMMultiplier / usdMultiplier,
 *      okuMReturned = usdAmount × PRECISION / okuMMultiplier.
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
        _approveOkuMoney(user1, address(okuDollar), type(uint256).max);
        _approveOkuMoney(user2, address(okuDollar), type(uint256).max);
    }

    // ============ 1. Wrap/Unwrap Round-Trip ============

    /// @notice Wrap then unwrap should return original note amount (max 1 wei loss)
    /// @dev At parity (okuMMultiplier == usdMultiplier == 1e18):
    ///      wrap(N) → usdMinted = N × 1e18 / 1e18 = N
    ///      unwrap(N) → okuMReturned = N × 1e18 / 1e18 = N
    ///      Round-trip: unwrap(wrap(okuMAmount)) ≈ okuMAmount
    function testFuzz_WrapUnwrapRoundTrip(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.startPrank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);
        uint256 notesBack = okuDollar.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertGe(notesBack, okuMAmount - 1, "Max 1 wei loss on round trip");
        assertLe(notesBack, okuMAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip at various USD multipliers (multiplier-aware)
    /// @dev wrap(N) → shares = N × okuMMultiplier / usdMultiplier; balanceOf = shares ×
    ///      usdMultiplier / PRECISION; unwrap(usd) → usd × PRECISION / okuMMultiplier.
    ///      usdMultiplier converts shares↔dollars only, so it never inflates OkuM output.
    function testFuzz_WrapUnwrapRoundTripAtMultiplier(
        uint256 okuMAmount,
        uint256 multiplier
    )
        public
    {
        // Tighten the lower bound so wrap(amount) at any allowed multiplier produces
        // a non-zero usdBalance (1e12 = enough to survive the largest 5x multiplier).
        okuMAmount = bound(okuMAmount, 1e12, okuMoney.balanceOf(user1) / 2);
        uint256 currentMult = okuDollar.usdMultiplier();
        multiplier = bound(multiplier, currentMult, currentMult * 5);

        _elevateUsdMultiplier(multiplier);

        uint256 price = okuMoney.okuMMultiplier();

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = okuDollar.balanceOf(user1);
        assertGt(usdBalance, 0, "wrap should always produce non-zero shares");

        uint256 notesBack = okuDollar.unwrap(usdBalance, user1);
        vm.stopPrank();

        uint256 expectedNotes = Math.mulDiv(usdBalance, PRECISION, price, Math.Rounding.Floor);

        assertLe(notesBack, expectedNotes + 1, "Cannot gain more than expected");
        assertGe(
            notesBack,
            expectedNotes > 1 ? expectedNotes - 1 : 0,
            "Should get approximately expected"
        );
    }

    /// @notice Round-trip at various note prices (multiplier-aware)
    /// @dev When okuMMultiplier > 1e18:
    ///      wrap(N) → usdMinted = N × okuMMultiplier / usdMultiplier (more OkuDollar)
    ///      unwrap(usdMinted) → okuMReturned = usdMinted × PRECISION / okuMMultiplier ≈ N
    function testFuzz_WrapUnwrapRoundTripAtNotePrice(
        uint256 okuMAmount,
        uint256 okuMMultiplier
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 2);
        okuMMultiplier = _boundOkuMMultiplier(okuMMultiplier);

        // Set note price and roll to next block to avoid yield distribution lock
        _setOkuMMultiplierAndRoll(okuMMultiplier);

        vm.startPrank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        if (usdMinted == 0) {
            vm.stopPrank();
            return;
        }

        uint256 notesBack = okuDollar.unwrap(usdMinted, user1);
        vm.stopPrank();

        assertLe(notesBack, okuMAmount, "Cannot gain on round trip");
        // Allow proportional tolerance for rounding at high prices
        uint256 maxLoss =
            Math.mulDiv(okuMAmount, okuMMultiplier, PRECISION * PRECISION, Math.Rounding.Floor) + 2;
        assertGe(
            notesBack,
            okuMAmount > maxLoss ? okuMAmount - maxLoss : 0,
            "Excessive loss on round trip"
        );
    }

    // ============ 2. Wrap Rounding Favors Vault ============

    /// @notice Wrap share calculation rounds DOWN, favoring the vault
    /// @dev usdMinted = okuMAmount × okuMMultiplier / usdMultiplier (truncated)
    ///      sharesToMint = usdMinted × PRECISION / usdMultiplier (truncated)
    ///      Both divisions round down → vault never overmints
    function testFuzz_WrapRoundingFavorsVault(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        uint256 mult = okuDollar.usdMultiplier();
        uint256 price = okuMoney.okuMMultiplier();

        // usdMinted = okuMAmount × okuMMultiplier / usdMultiplier (rounds down)
        uint256 expectedUsd = Math.mulDiv(okuMAmount, price, mult, Math.Rounding.Floor);
        // sharesToMint = usdMinted × PRECISION / usdMultiplier (rounds down)
        uint256 expectedShares = Math.mulDiv(expectedUsd, PRECISION, mult, Math.Rounding.Floor);

        if (expectedShares == 0) return;

        // Verify: implied dollar value of shares <= note dollar value deposited
        uint256 impliedDollarValue =
            Math.mulDiv(expectedShares, mult, PRECISION, Math.Rounding.Floor);
        uint256 notesDollarValue = Math.mulDiv(okuMAmount, price, PRECISION, Math.Rounding.Floor);
        assertLe(impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault");

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(okuDollar.usdSharesOf(user1), expectedShares, "Shares minted match expected");
    }

    /// @notice Wrap rounding at elevated USD multiplier (multiplier-aware)
    function testFuzz_WrapRoundingAtHighMultiplier(uint256 okuMAmount, uint256 multiplier) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);
        uint256 currentMult = okuDollar.usdMultiplier();
        multiplier = bound(multiplier, currentMult + 1, currentMult * 10);

        _elevateUsdMultiplier(multiplier);
        // Read achieved multiplier — `_elevateUsdMultiplier` may overshoot the target
        // because it drives the value via setOkuMYieldRate + warp.
        uint256 achievedMult = okuDollar.usdMultiplier();

        uint256 price = okuMoney.okuMMultiplier();

        // Contract logic: sharesToMint = okuMAmount × okuMMultiplier / usdMultiplier
        // (single division, NOT two sequential divisions)
        uint256 expectedShares = Math.mulDiv(okuMAmount, price, achievedMult, Math.Rounding.Floor);

        if (expectedShares == 0) return;

        uint256 impliedDollarValue =
            Math.mulDiv(expectedShares, achievedMult, PRECISION, Math.Rounding.Floor);
        uint256 notesDollarValue = Math.mulDiv(okuMAmount, price, PRECISION, Math.Rounding.Floor);
        assertLe(
            impliedDollarValue, notesDollarValue, "Wrap rounding must favor vault at any multiplier"
        );

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(
            okuDollar.usdSharesOf(user1), expectedShares, "Shares match at elevated multiplier"
        );
    }

    /// @notice Wrap share-minting at an elevated multiplier is the exact identity.
    /// @dev `wrap` assigns shares 1:1 with OkuM received (usdMultiplier == okuMMultiplier,
    ///      so the ratio is the identity). Only the dollar VALUE credited scales with the
    ///      multiplier, via a single `okuMToDollars` conversion.
    function testFuzz_WrapRoundingAtHighNotePrice(
        uint256 okuMAmount,
        uint256 okuMMultiplier
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);
        okuMMultiplier = _boundOkuMMultiplier(okuMMultiplier);

        _setOkuMMultiplierAndRoll(okuMMultiplier);

        uint256 mult = okuDollar.usdMultiplier();
        uint256 expectedDollarValue = Math.mulDiv(okuMAmount, mult, PRECISION, Math.Rounding.Floor);

        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        assertEq(okuDollar.usdSharesOf(user1), okuMAmount, "Shares are the exact identity");
        assertEq(usdMinted, expectedDollarValue, "Dollar value matches okuMToDollars exactly");
    }

    // ============ 3. Unwrap Rounding Favors Vault ============

    /// @notice Unwrap share burn rounds UP, favoring the vault
    /// @dev sharesToBurn = (usdAmount × PRECISION + mult - 1) / mult (ceil division)
    function testFuzz_UnwrapRoundingFavorsVault(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = okuDollar.balanceOf(user1);
        if (usdBalance == 0) return;

        uint256 mult = okuDollar.usdMultiplier();
        uint256 sharesBefore = okuDollar.usdSharesOf(user1);

        // Expected shares to burn (round UP)
        uint256 expectedBurn = Math.mulDiv(usdBalance, PRECISION, mult, Math.Rounding.Ceil);

        vm.prank(user1);
        okuDollar.unwrap(usdBalance, user1);

        uint256 sharesAfter = okuDollar.usdSharesOf(user1);
        uint256 actualBurn = sharesBefore - sharesAfter;

        assertGe(
            actualBurn,
            Math.mulDiv(usdBalance, PRECISION, mult, Math.Rounding.Floor),
            "Burn must be >= floor (round up)"
        );
        assertEq(actualBurn, expectedBurn, "Burn matches ceil division");
    }

    // ============ 4. Collateralization ============

    /// @notice Reserve/obligation views stay consistent and collateralization is exactly 1.0.
    /// @dev The ratio is computed manually to pin that it really is PRECISION (modulo the
    ///      single floor() in `totalSupply`): a multiplier move scales reserves' dollar
    ///      value and obligations by the identical factor.
    function testFuzz_CollateralizationIsExactlyOne(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 reserves = okuDollar.totalOkuMReserves();
        uint256 obligations = okuDollar.totalUsdObligations();
        uint256 price = okuMoney.okuMMultiplier();

        assertEq(obligations, okuDollar.totalSupply(), "Obligations == totalSupply");
        assertEq(reserves, okuMoney.balanceOf(address(okuDollar)), "Reserves == note balance");
        // Shares track raw OkuM 1:1 under the single multiplier.
        assertEq(okuDollar.totalUsdShares(), reserves, "Shares track raw OkuM 1:1");

        uint256 reservesDollarValue = Math.mulDiv(reserves, price, PRECISION, Math.Rounding.Floor);
        assertEq(reservesDollarValue, obligations, "Collateralization is exactly 1.0");
    }

    // ============ 5. Donation Rescue ============

    /// @notice `rescueDonation` can recover exactly the donated OkuM and no more.
    function testFuzz_RescueDonationBoundedByDonation(uint256 okuMAmount, uint256 donation) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 4);
        donation = bound(donation, 1e6, okuMoney.balanceOf(user2) / 4);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 backing = okuDollar.totalUsdShares();

        // Donate straight into the vault — accrues to nobody.
        vm.prank(user2);
        okuMoney.transfer(address(okuDollar), donation);

        // Over-rescuing must revert.
        vm.prank(vaultRescuer);
        vm.expectRevert(OkuDollarErrors.NoDonationAvailable.selector);
        okuDollar.rescueDonation(donation + 1, treasury);

        // Rescuing exactly the donation must succeed and leave backing intact.
        vm.prank(vaultRescuer);
        okuDollar.rescueDonation(donation, treasury);

        assertEq(okuMoney.balanceOf(treasury), donation, "Rescuer receives the donation");
        assertEq(okuDollar.totalOkuMReserves(), backing, "Share backing untouched");
    }

    // ============ 6. Balance Formula ============

    /// @notice balanceOf == usdShares * usdMultiplier / PRECISION
    function testFuzz_BalanceFormula(uint256 okuMAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 shares = okuDollar.usdSharesOf(user1);
        uint256 mult = okuDollar.usdMultiplier();
        uint256 expected = Math.mulDiv(shares, mult, PRECISION, Math.Rounding.Floor);

        assertEq(
            okuDollar.balanceOf(user1), expected, "balanceOf must equal shares * mult / PRECISION"
        );
    }

    /// @notice Balance formula holds after USD rebase
    function testFuzz_BalanceFormulaAfterRebase(uint256 okuMAmount, uint256 newMultiplier) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 currentMult = okuDollar.usdMultiplier();
        newMultiplier = bound(newMultiplier, currentMult, currentMult * 10);

        _elevateUsdMultiplier(newMultiplier);

        uint256 shares = okuDollar.usdSharesOf(user1);
        uint256 mult = okuDollar.usdMultiplier();
        uint256 expected = Math.mulDiv(shares, mult, PRECISION, Math.Rounding.Floor);

        assertEq(okuDollar.balanceOf(user1), expected, "Balance formula must hold after rebase");
    }

    /// @notice OkuDollar shares are untouched by an okuMMultiplier change; balance
    ///         moves in lockstep with it.
    /// @dev `usdMultiplier() == okuMMultiplier()`, so balance must track
    ///      shares × new multiplier / PRECISION exactly while share accounting is frozen.
    function testFuzz_OkuUsdBalanceTracksOkuMMultiplier(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 sharesBefore = okuDollar.usdSharesOf(user1);

        newNotePrice = _boundOkuMMultiplier(newNotePrice);

        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(newNotePrice);

        uint256 balanceAfter = okuDollar.balanceOf(user1);
        uint256 sharesAfter = okuDollar.usdSharesOf(user1);

        assertEq(sharesAfter, sharesBefore, "Shares unchanged by okuMMultiplier");
        assertEq(
            balanceAfter,
            Math.mulDiv(sharesAfter, newNotePrice, PRECISION, Math.Rounding.Floor),
            "Balance must track shares * okuMMultiplier / PRECISION exactly"
        );
    }

    /// @notice totalSupply == totalUsdShares * usdMultiplier / PRECISION
    function testFuzz_TotalSupplyFormula(uint256 amount1, uint256 amount2) public {
        amount1 = bound(amount1, 1e6, okuMoney.balanceOf(user1) / 2);
        amount2 = bound(amount2, 1e6, okuMoney.balanceOf(user2) / 2);

        vm.prank(user1);
        okuDollar.wrap(amount1, user1, 0);

        vm.prank(user2);
        okuDollar.wrap(amount2, user2, 0);

        uint256 totalShares = okuDollar.totalUsdShares();
        uint256 mult = okuDollar.usdMultiplier();
        uint256 expected = Math.mulDiv(totalShares, mult, PRECISION, Math.Rounding.Floor);

        assertEq(
            okuDollar.totalSupply(),
            expected,
            "totalSupply must equal totalShares * mult / PRECISION"
        );
    }

    // ============ 7. Transfer Preserves Shares ============

    /// @notice Total shares unchanged after transfer
    function testFuzz_TransferPreservesShares(uint256 okuMAmount, uint256 transferAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = okuDollar.balanceOf(user1);
        transferAmount = bound(transferAmount, 1, usdBalance);

        uint256 totalSharesBefore = okuDollar.totalUsdShares();

        vm.prank(user1);
        okuDollar.transfer(user2, transferAmount);

        uint256 totalSharesAfter = okuDollar.totalUsdShares();

        assertEq(totalSharesAfter, totalSharesBefore, "Total shares must not change on transfer");
    }

    /// @notice Individual shares sum preserved after transfer
    function testFuzz_TransferSharesSum(uint256 okuMAmount, uint256 transferAmount) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 usdBalance = okuDollar.balanceOf(user1);
        transferAmount = bound(transferAmount, 1, usdBalance);

        uint256 user1SharesBefore = okuDollar.usdSharesOf(user1);
        uint256 user2SharesBefore = okuDollar.usdSharesOf(user2);

        vm.prank(user1);
        okuDollar.transfer(user2, transferAmount);

        uint256 user1SharesAfter = okuDollar.usdSharesOf(user1);
        uint256 user2SharesAfter = okuDollar.usdSharesOf(user2);

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
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 initialShares = okuDollar.usdSharesOf(user1);

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = okuDollar.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            // Re-approve note for vault
            okuMoney.approve(address(okuDollar), notesBack);
            okuDollar.wrap(notesBack, user1, 0);
        }
        vm.stopPrank();

        uint256 finalShares = okuDollar.usdSharesOf(user1);

        // Shares should not increase (they may decrease slightly due to rounding)
        assertLe(finalShares, initialShares, "Shares must not inflate after repeated cycles");
    }

    /// @notice Total supply does not inflate through wrap/unwrap cycles
    function testFuzz_RepeatedCyclesNoSupplyInflation(uint256 okuMAmount, uint8 cycles) public {
        okuMAmount = bound(okuMAmount, 1e12, okuMoney.balanceOf(user1) / 2);
        cycles = uint8(bound(cycles, 2, 10));

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 initialSupply = okuDollar.totalSupply();

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = okuDollar.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            okuMoney.approve(address(okuDollar), notesBack);
            okuDollar.wrap(notesBack, user1, 0);
        }
        vm.stopPrank();

        uint256 finalSupply = okuDollar.totalSupply();
        assertLe(finalSupply, initialSupply, "Total supply must not inflate through cycles");
    }

    /// @notice Repeated cycles at elevated okuMMultiplier don't inflate
    function testFuzz_RepeatedCyclesAtHighNotePriceNoInflation(
        uint256 okuMAmount,
        uint256 okuMMultiplier,
        uint8 cycles
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e12, okuMoney.balanceOf(user1) / 2);
        okuMMultiplier = _boundOkuMMultiplier(okuMMultiplier);
        cycles = uint8(bound(cycles, 2, 10));

        _setOkuMMultiplierAndRoll(okuMMultiplier);

        vm.startPrank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 initialShares = okuDollar.usdSharesOf(user1);

        for (uint8 i = 0; i < cycles; i++) {
            uint256 usdBal = okuDollar.balanceOf(user1);
            if (usdBal == 0) break;

            uint256 notesBack = okuDollar.unwrap(usdBal, user1);
            if (notesBack == 0) break;

            okuMoney.approve(address(okuDollar), notesBack);
            okuDollar.wrap(notesBack, user1, 0);
        }
        vm.stopPrank();

        uint256 finalShares = okuDollar.usdSharesOf(user1);
        assertLe(
            finalShares,
            initialShares,
            "Shares must not inflate after repeated cycles at high okuMMultiplier"
        );
    }

    // ============ 9. Reserve donations ============

    /// @notice A bare OkuM transfer into the vault mints no shares and does not change
    ///         anyone's balance — it is purely a rescuable donation.
    /// @dev Donations accrue to nobody because conversions use the multiplier, not
    ///      totalAssets/totalSupply.
    function testFuzz_DonationMintsNoShares(uint256 okuMAmount, uint256 donation) public {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 4);
        donation = bound(donation, 1e6, okuMoney.balanceOf(user2) / 4);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 sharesBefore = okuDollar.totalUsdShares();
        uint256 supplyBefore = okuDollar.totalSupply();
        uint256 reservesBefore = okuDollar.totalOkuMReserves();

        vm.prank(user2);
        okuMoney.transfer(address(okuDollar), donation);

        assertEq(okuDollar.totalUsdShares(), sharesBefore, "Donation must not mint USD shares");
        assertEq(okuDollar.totalSupply(), supplyBefore, "Donation must not change totalSupply");
        assertEq(
            okuDollar.totalOkuMReserves(),
            reservesBefore + donation,
            "Reserves must increase by exact donation amount"
        );
    }

    // ============ 10. Price-Aware Wrap Amount ============

    /// @notice Wrap gives more OkuDollar when okuMMultiplier > PRECISION
    /// @dev usdMinted = okuMAmount × okuMMultiplier / usdMultiplier
    ///      At okuMMultiplier = 1.5e18, usdMultiplier = 1e18: wrap(100e18) → 150e18 OkuDollar
    function testFuzz_WrapGivesMoreUsdAtHighNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 4);
        uint256 currentNotePrice = okuMoney.okuMMultiplier();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 5);

        // Wrap at current price to get baseline
        vm.startPrank(user1);
        uint256 usdAtParity = okuDollar.wrap(okuMAmount, user1, 0);

        // Unwrap to reset (use balanceOf to avoid ceil-vs-floor share mismatch)
        uint256 usdBalance = okuDollar.balanceOf(user1);
        okuDollar.unwrap(usdBalance, user1);
        vm.stopPrank();

        // Increase note price and roll to avoid yield distribution lock
        _setOkuMMultiplierAndRoll(newNotePrice);

        // Wrap same note amount at higher price
        vm.prank(user1);
        uint256 usdAtHighPrice = okuDollar.wrap(okuMAmount, user1, 0);

        assertGt(
            usdAtHighPrice,
            usdAtParity,
            "Wrap must give more OkuDollar when okuMMultiplier is higher"
        );
    }

    /// @notice Unwrap returns fewer note tokens when okuMMultiplier > PRECISION
    /// @dev okuMReturned = usdAmount × usdMultiplier / okuMMultiplier
    ///      At okuMMultiplier = 2e18, usdMultiplier = 1e18: unwrap(100e18 OkuDollar) → 50e18 notes
    function testFuzz_UnwrapReturnsFewer_NotesAtHighNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e18, okuMoney.balanceOf(user1) / 4);

        // Wrap at parity to establish baseline
        vm.prank(user1);
        uint256 usdMinted = okuDollar.wrap(okuMAmount, user1, 0);

        // Increase note price
        uint256 currentNotePrice = okuMoney.okuMMultiplier();
        newNotePrice =
            bound(newNotePrice, currentNotePrice + currentNotePrice / 10, currentNotePrice * 5);

        _setOkuMMultiplierAndRoll(newNotePrice);

        // Unwrap at higher note price — should get fewer note tokens back
        vm.prank(user1);
        uint256 notesBack = okuDollar.unwrap(usdMinted, user1);

        assertLt(
            notesBack,
            okuMAmount,
            "Unwrap must return fewer notes when okuMMultiplier has increased"
        );
    }

    // ============ 11. OkuMoney Balance Invariants ============

    /// @notice OkuMoney balanceOf is NOT affected by okuMMultiplier changes
    /// @dev OkuMoney is non-rebasing: balances are static; only the multiplier moves.
    function testFuzz_OkuMoneyBalanceUnchangedByNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1));

        uint256 balanceBefore = okuMoney.balanceOf(user1);

        newNotePrice = _boundOkuMMultiplier(newNotePrice);

        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(newNotePrice);

        uint256 balanceAfter = okuMoney.balanceOf(user1);
        assertEq(
            balanceAfter, balanceBefore, "OkuMoney balanceOf must not change with okuMMultiplier"
        );
    }

    /// @notice Vault's note token count unchanged by okuMMultiplier increase
    /// @dev Reserve note balance is static; only dollar value (reserves × okuMMultiplier) changes
    function testFuzz_VaultNoteBalanceUnchangedByNotePrice(
        uint256 okuMAmount,
        uint256 newNotePrice
    )
        public
    {
        okuMAmount = bound(okuMAmount, 1e6, okuMoney.balanceOf(user1) / 2);

        vm.prank(user1);
        okuDollar.wrap(okuMAmount, user1, 0);

        uint256 vaultBalanceBefore = okuMoney.balanceOf(address(okuDollar));

        newNotePrice = _boundOkuMMultiplier(newNotePrice);

        vm.prank(rateManager);
        okuMoney.setOkuMMultiplier(newNotePrice);

        uint256 vaultBalanceAfter = okuMoney.balanceOf(address(okuDollar));
        assertEq(
            vaultBalanceAfter,
            vaultBalanceBefore,
            "Vault note token count must not change with okuMMultiplier"
        );
    }
}
