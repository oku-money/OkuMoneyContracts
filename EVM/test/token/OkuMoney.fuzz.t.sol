// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title OkuMoneyFuzzTest
 * @notice Fuzz tests for OkuMoney (non-rebasing ERC-20 with separate notePrice tracking)
 * @dev OkuMoney is a standard ERC-20: balanceOf() returns raw token count, unaffected by
 *      okuMPrice(). Price appreciation is tracked separately for PSM/vault use.
 */
contract OkuMoneyFuzzTest is BaseTest {
    // ============ Mint/Burn Consistency Tests ============

    /// @notice Minting then burning same amount returns to original state
    function testFuzz_MintBurnConsistency(uint256 amount) public {
        amount = _boundMintAmount(amount);

        uint256 totalSupplyBefore = okuMoney.totalSupply();

        // Mint to minter so it can self-burn
        _mintOkuMoney(minter, amount);

        vm.prank(minter);
        okuMoney.burn(amount);

        // Should return to original state
        assertEq(okuMoney.totalSupply(), totalSupplyBefore, "Total supply should return to original");
        assertEq(okuMoney.balanceOf(minter), 0, "Minter balance should be zero");
    }

    /// @notice Multiple mints and burns maintain consistency
    function testFuzz_MultipleMintBurnConsistency(
        uint256 amount1,
        uint256 amount2,
        uint256 burnAmount
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);

        // Mint to minter so it can self-burn
        _mintOkuMoney(minter, amount1);
        _mintOkuMoney(user2, amount2);

        uint256 totalSupplyAfterMints = okuMoney.totalSupply();
        assertEq(totalSupplyAfterMints, amount1 + amount2, "Supply should equal sum of mints");

        // Burn partial from minter (self-burn)
        burnAmount = bound(burnAmount, 1, amount1);
        vm.prank(minter);
        okuMoney.burn(burnAmount);

        assertEq(
            okuMoney.totalSupply(),
            amount1 + amount2 - burnAmount,
            "Supply should decrease by burn amount"
        );
    }

    // ============ Transfer Consistency Tests ============

    /// @notice Transfers preserve total supply and individual balances sum
    function testFuzz_TransferPreservesBalances(uint256 amount, uint256 transferAmount) public {
        amount = _boundMintAmount(amount);
        _mintOkuMoney(user1, amount);

        transferAmount = bound(transferAmount, 0, amount);

        uint256 totalSupplyBefore = okuMoney.totalSupply();
        uint256 combinedBalanceBefore = okuMoney.balanceOf(user1) + okuMoney.balanceOf(user2);

        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, transferAmount));

        assertEq(okuMoney.totalSupply(), totalSupplyBefore, "Total supply unchanged by transfer");
        assertEq(
            okuMoney.balanceOf(user1) + okuMoney.balanceOf(user2),
            combinedBalanceBefore,
            "Individual balances sum unchanged"
        );
        assertEq(okuMoney.balanceOf(user2), transferAmount, "Receiver got exact transfer amount");
        assertEq(
            okuMoney.balanceOf(user1), amount - transferAmount, "Sender lost exact transfer amount"
        );
    }

    /// @notice Multiple transfers between users maintain total supply
    function testFuzz_MultipleTransfersConsistency(
        uint256 mintAmount,
        uint256 transfer1,
        uint256 transfer2
    )
        public
    {
        mintAmount = bound(mintAmount, 10e18, MAX_SUPPLY / 2);
        _mintOkuMoney(user1, mintAmount);

        uint256 totalSupplyBefore = okuMoney.totalSupply();

        // Transfer user1 -> user2
        transfer1 = bound(transfer1, 1, mintAmount / 2);
        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, transfer1));

        // Transfer user2 -> user3
        transfer2 = bound(transfer2, 1, transfer1);
        vm.prank(user2);
        assertTrue(okuMoney.transfer(user3, transfer2));

        assertEq(okuMoney.totalSupply(), totalSupplyBefore, "Total supply unchanged by transfers");
        assertEq(
            okuMoney.balanceOf(user1) + okuMoney.balanceOf(user2) + okuMoney.balanceOf(user3),
            totalSupplyBefore,
            "Sum of balances equals total supply"
        );
    }

    // ============ notePrice Independence Tests ============

    /// @notice notePrice change does NOT affect any user balances
    function testFuzz_NotePriceDoesNotAffectBalances(uint256 mintAmount, uint256 newPrice) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 10);
        newPrice = _boundOkuMPrice(newPrice);

        _mintOkuMoney(user1, mintAmount);

        uint256 balanceBefore = okuMoney.balanceOf(user1);
        uint256 totalSupplyBefore = okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Balances must be completely unaffected
        assertEq(
            okuMoney.balanceOf(user1), balanceBefore, "balanceOf unchanged after notePrice update"
        );
        assertEq(
            okuMoney.totalSupply(), totalSupplyBefore, "totalSupply unchanged after notePrice update"
        );
    }

    /// @notice notePrice change does NOT affect multiple users' balances
    function testFuzz_NotePriceDoesNotAffectMultipleUsers(
        uint256 amount1,
        uint256 amount2,
        uint256 newPrice
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);
        newPrice = _boundOkuMPrice(newPrice);

        _mintOkuMoney(user1, amount1);
        _mintOkuMoney(user2, amount2);

        uint256 balance1Before = okuMoney.balanceOf(user1);
        uint256 balance2Before = okuMoney.balanceOf(user2);

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        assertEq(okuMoney.balanceOf(user1), balance1Before, "User1 balance unchanged");
        assertEq(okuMoney.balanceOf(user2), balance2Before, "User2 balance unchanged");
    }

    /// @notice Balance ratios unchanged after notePrice update
    function testFuzz_BalanceRatiosUnchangedAfterPriceUpdate(
        uint256 amount1,
        uint256 amount2,
        uint256 newPrice
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);
        newPrice = _boundOkuMPrice(newPrice);

        _mintOkuMoney(user1, amount1);
        _mintOkuMoney(user2, amount2);

        uint256 ratio1Before = (okuMoney.balanceOf(user1) * PRECISION) / okuMoney.totalSupply();
        uint256 ratio2Before = (okuMoney.balanceOf(user2) * PRECISION) / okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        uint256 ratio1After = (okuMoney.balanceOf(user1) * PRECISION) / okuMoney.totalSupply();
        uint256 ratio2After = (okuMoney.balanceOf(user2) * PRECISION) / okuMoney.totalSupply();

        // Ratios must be exactly preserved (standard ERC-20, no rounding)
        assertEq(ratio1After, ratio1Before, "User1 ratio exactly preserved");
        assertEq(ratio2After, ratio2Before, "User2 ratio exactly preserved");
    }

    // ============ notePrice Monotonicity Tests ============

    /// @notice notePrice can only increase via updateNotePrice
    function testFuzz_NotePriceNeverDecreases(uint256 newPrice) public {
        uint256 currentPrice = okuMoney.okuMPrice();
        newPrice = _boundOkuMPrice(newPrice);

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        assertGe(okuMoney.okuMPrice(), currentPrice, "notePrice must never decrease");
    }

    /// @notice Sequential notePrice updates accumulate correctly
    function testFuzz_SequentialNotePriceUpdates(uint256 increase1, uint256 increase2) public {
        increase1 = _boundOkuMPriceIncrease(increase1);
        increase2 = _boundOkuMPriceIncrease(increase2);

        uint256 priceBefore = okuMoney.okuMPrice();

        // First price update
        uint256 price1 = priceBefore + increase1;
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(price1);

        assertEq(okuMoney.okuMPrice(), price1, "Price after first update");

        // Second price update
        uint256 price2 = price1 + increase2;
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(price2);

        assertEq(okuMoney.okuMPrice(), price2, "Price after second update");
        assertGt(okuMoney.okuMPrice(), priceBefore, "Final price greater than initial");
    }

    /// @notice notePrice reverts if new price is less than current
    function testFuzz_NotePriceCannotDecrease(uint256 increase, uint256 decrease) public {
        increase = _boundOkuMPriceIncrease(increase);

        uint256 currentPrice = okuMoney.okuMPrice();
        uint256 higherPrice = currentPrice + increase;

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(higherPrice);

        // Try to set a lower price (any amount below current)
        decrease = bound(decrease, 1, higherPrice);
        uint256 lowerPrice = higherPrice - decrease;

        vm.prank(rebaser);
        vm.expectRevert("Price cannot decrease");
        okuMoney.updateOkuMPrice(lowerPrice);
    }

    // ============ Yield Rate Accrual Tests ============

    /// @notice notePrice accrues over time with setYieldRate
    function testFuzz_NotePriceAccruesWithYieldRate(uint256 elapsed) public {
        elapsed = bound(elapsed, 1, 365 days);

        // Set a modest yield rate (~4.5% APY = ~1.000000001395 per second)
        uint256 rate = PRECISION + 1_395_000_000; // ~4.5% APY

        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        uint256 priceBefore = okuMoney.okuMPrice();

        // Advance time
        vm.warp(block.timestamp + elapsed);

        uint256 priceAfter = okuMoney.okuMPrice();
        assertGt(priceAfter, priceBefore, "Price should increase over time with positive rate");
    }

    /// @notice Yield rate does not affect balances even after time passes
    function testFuzz_YieldRateDoesNotAffectBalances(uint256 mintAmount, uint256 elapsed) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 10);
        elapsed = bound(elapsed, 1, 365 days);

        _mintOkuMoney(user1, mintAmount);
        uint256 balanceBefore = okuMoney.balanceOf(user1);
        uint256 totalSupplyBefore = okuMoney.totalSupply();

        // Set yield rate
        uint256 rate = PRECISION + 1_395_000_000; // ~4.5% APY
        vm.prank(rebaser);
        okuMoney.setYieldRate(rate, 0);

        // Advance time
        vm.warp(block.timestamp + elapsed);

        // Balances MUST be unaffected
        assertEq(okuMoney.balanceOf(user1), balanceBefore, "Balance unchanged after yield accrual");
        assertEq(
            okuMoney.totalSupply(), totalSupplyBefore, "Total supply unchanged after yield accrual"
        );
        // But notePrice should have increased
        assertGt(okuMoney.okuMPrice(), PRECISION, "notePrice should have grown");
    }

    // ============ Minter Allowance Tests ============

    /// @notice Minter allowance only decreases (never increases from mint/burn)
    function testFuzz_MinterAllowanceOnlyDecreases(
        uint256 initialAllowance,
        uint256 mintAmount
    )
        public
    {
        initialAllowance = bound(initialAllowance, 1e18, MAX_SUPPLY);
        mintAmount = bound(mintAmount, 1, _min(initialAllowance, MAX_SUPPLY));

        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, initialAllowance);

        uint256 allowanceBefore = okuMoney.minterAllowance(minter);

        vm.prank(minter);
        okuMoney.mint(user1, mintAmount);

        uint256 allowanceAfterMint = okuMoney.minterAllowance(minter);
        assertEq(
            allowanceAfterMint, allowanceBefore - mintAmount, "Allowance decrements by mint amount"
        );

        // Transfer tokens to minter so it can self-burn
        vm.prank(user1);
        okuMoney.transfer(minter, mintAmount);

        // Burn should NOT restore allowance
        vm.prank(minter);
        okuMoney.burn(mintAmount);

        assertEq(
            okuMoney.minterAllowance(minter), allowanceAfterMint, "Burn does not restore allowance"
        );
    }

    /// @notice Only admin can increase allowance
    function testFuzz_OnlyAdminIncreasesAllowance(uint256 mintAmount, uint256 newAllowance) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 2);
        newAllowance = bound(newAllowance, 0, MAX_SUPPLY);

        // Mint some tokens to decrease allowance
        _mintOkuMoney(user1, mintAmount);

        // Admin resets allowance
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(minter, newAllowance);

        assertEq(okuMoney.minterAllowance(minter), newAllowance, "Admin can set any allowance");
    }

    // ============ Balance Invariant Tests (Standard ERC-20) ============

    /// @notice balanceOf always equals exact minted amount (standard ERC-20)
    function testFuzz_BalanceOfEqualsExactMintedAmount(uint256 mintAmount) public {
        mintAmount = bound(mintAmount, 1, MAX_SUPPLY);

        _mintOkuMoney(user1, mintAmount);

        assertEq(okuMoney.balanceOf(user1), mintAmount, "balanceOf equals exact minted amount");
    }

    /// @notice totalSupply always equals sum of all minted minus burned
    function testFuzz_TotalSupplyEqualsNetMinted(
        uint256 amount1,
        uint256 amount2,
        uint256 burnAmount
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);

        _mintOkuMoney(user1, amount1);
        _mintOkuMoney(minter, amount2);

        burnAmount = bound(burnAmount, 0, amount2);
        if (burnAmount > 0) {
            vm.prank(minter);
            okuMoney.burn(burnAmount);
        }

        assertEq(
            okuMoney.totalSupply(), amount1 + amount2 - burnAmount, "totalSupply equals net minted"
        );
    }

    /// @notice Sum of all balances equals totalSupply after multiple operations
    function testFuzz_SumOfBalancesEqualsTotalSupply(
        uint256 mintAmount,
        uint256 transfer1,
        uint256 newPrice
    )
        public
    {
        mintAmount = bound(mintAmount, 10e18, MAX_SUPPLY / 2);
        newPrice = _boundOkuMPrice(newPrice);

        _mintOkuMoney(user1, mintAmount);

        // Update notePrice (should not affect balances)
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Transfer some tokens
        transfer1 = bound(transfer1, 1, mintAmount / 2);
        vm.prank(user1);
        okuMoney.transfer(user2, transfer1);

        // Sum of all balances must equal totalSupply
        uint256 sumOfBalances =
            okuMoney.balanceOf(user1) + okuMoney.balanceOf(user2) + okuMoney.balanceOf(user3);
        assertEq(sumOfBalances, okuMoney.totalSupply(), "Sum of balances equals total supply");
    }

    // ============ Supply Cap Tests ============

    /// @notice Supply cap enforced on mint (raw token cap)
    function testFuzz_SupplyCapEnforcedOnMint(uint256 extraAmount) public {
        // Mint exactly at max supply
        _mintOkuMoney(user1, MAX_SUPPLY);

        extraAmount = bound(extraAmount, 1, MAX_SUPPLY);

        // Should not be able to mint more
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
        okuMoney.mint(user2, extraAmount);
    }

    /// @notice notePrice update does NOT affect supply cap enforcement
    function testFuzz_NotePriceDoesNotAffectSupplyCap(uint256 newPrice) public {
        newPrice = _boundOkuMPrice(newPrice);

        // Mint half the supply
        _mintOkuMoney(user1, MAX_SUPPLY / 2);

        // Update notePrice
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Should still be able to mint up to the cap (totalSupply is unaffected by notePrice)
        uint256 remaining = MAX_SUPPLY - okuMoney.totalSupply();
        _mintOkuMoney(user2, remaining);

        assertEq(okuMoney.totalSupply(), MAX_SUPPLY, "Can mint up to cap after price update");

        // But no more
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
        okuMoney.mint(user3, 1);
    }

    // ============ Mint After notePrice Change Tests ============

    /// @notice Minting after notePrice change gives exact token amount (no share conversion)
    function testFuzz_MintAfterNotePriceChange(
        uint256 firstMint,
        uint256 newPrice,
        uint256 secondMint
    )
        public
    {
        firstMint = bound(firstMint, 1e18, MAX_SUPPLY / 4);
        newPrice = _boundOkuMPrice(newPrice);
        secondMint = bound(secondMint, 1e18, MAX_SUPPLY / 4);

        // First mint
        _mintOkuMoney(user1, firstMint);
        assertEq(okuMoney.balanceOf(user1), firstMint, "User1 gets exact first mint");

        // Update notePrice
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Second mint at new price — user still gets exact token amount
        _mintOkuMoney(user2, secondMint);
        assertEq(okuMoney.balanceOf(user2), secondMint, "User2 gets exact second mint");

        // User1 balance unaffected by notePrice change
        assertEq(okuMoney.balanceOf(user1), firstMint, "User1 balance unchanged by price update");

        // Total supply is exact sum
        assertEq(okuMoney.totalSupply(), firstMint + secondMint, "Total supply equals sum of mints");
    }

    // ============ Edge Case Tests ============

    /// @notice Very small amounts handled correctly (standard ERC-20 precision)
    function testFuzz_VerySmallAmounts(uint256 amount) public {
        amount = bound(amount, 1, 1000); // 1 to 1000 wei

        _mintOkuMoney(user1, amount);

        assertEq(okuMoney.balanceOf(user1), amount, "Small mint gives exact balance");

        if (amount > 1) {
            vm.prank(user1);
            assertTrue(okuMoney.transfer(user2, amount - 1));

            assertEq(okuMoney.balanceOf(user2), amount - 1, "Transfer gives exact amount");
            assertEq(okuMoney.balanceOf(user1), 1, "Sender retains exact remainder");
        }
    }

    /// @notice Operations after notePrice update maintain exact precision
    function testFuzz_PrecisionAfterNotePriceUpdate(uint256 mintAmount, uint256 newPrice) public {
        mintAmount = bound(mintAmount, 1e18, 1e24); // 1 to 1M tokens
        newPrice = _boundOkuMPrice(newPrice);

        _mintOkuMoney(user1, mintAmount);

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Balance unchanged (standard ERC-20)
        assertEq(okuMoney.balanceOf(user1), mintAmount, "Balance exact after notePrice update");

        // Transfer at any notePrice
        uint256 transferAmount = mintAmount / 2;
        vm.prank(user1);
        assertTrue(okuMoney.transfer(user2, transferAmount));

        // Exact balance preservation (no rounding in standard ERC-20)
        assertEq(
            okuMoney.balanceOf(user1) + okuMoney.balanceOf(user2),
            mintAmount,
            "Total balance exactly preserved after transfer"
        );
        assertEq(okuMoney.balanceOf(user1), mintAmount - transferAmount, "Sender balance exact");
        assertEq(okuMoney.balanceOf(user2), transferAmount, "Receiver balance exact");
    }

    /// @notice basePrice reflects last snapshot before accrual
    function testFuzz_BasePriceReflectsSnapshot(uint256 newPrice) public {
        newPrice = _boundOkuMPrice(newPrice);

        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        assertEq(okuMoney.basePrice(), newPrice, "basePrice equals set price after updateNotePrice");
        assertEq(
            okuMoney.okuMPrice(),
            newPrice,
            "notePrice equals basePrice immediately after updateNotePrice"
        );
    }
}
