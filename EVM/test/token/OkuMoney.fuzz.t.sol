// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";

/**
 * @title OkuMoneyFuzzTest
 * @notice Fuzz tests for OkuMoney (non-rebasing ERC-20 with separate okuMMultiplier tracking)
 * @dev OkuMoney is a standard ERC-20: balanceOf() returns raw token count, unaffected by
 *      okuMMultiplier(). Price appreciation is tracked separately for PSM/vault use.
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
        assertEq(
            okuMoney.totalSupply(), totalSupplyBefore, "Total supply should return to original"
        );
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

    // ============ okuMMultiplier Independence Tests ============

    /// @notice okuMMultiplier change does NOT affect any user balances
    function testFuzz_NotePriceDoesNotAffectBalances(uint256 mintAmount, uint256 newPrice) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 10);
        newPrice = _boundOkuMMultiplier(newPrice);

        _mintOkuMoney(user1, mintAmount);

        uint256 balanceBefore = okuMoney.balanceOf(user1);
        uint256 totalSupplyBefore = okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Balances must be completely unaffected
        assertEq(
            okuMoney.balanceOf(user1),
            balanceBefore,
            "balanceOf unchanged after okuMMultiplier update"
        );
        assertEq(
            okuMoney.totalSupply(),
            totalSupplyBefore,
            "totalSupply unchanged after okuMMultiplier update"
        );
    }

    /// @notice okuMMultiplier change does NOT affect multiple users' balances
    function testFuzz_NotePriceDoesNotAffectMultipleUsers(
        uint256 amount1,
        uint256 amount2,
        uint256 newPrice
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);
        newPrice = _boundOkuMMultiplier(newPrice);

        _mintOkuMoney(user1, amount1);
        _mintOkuMoney(user2, amount2);

        uint256 balance1Before = okuMoney.balanceOf(user1);
        uint256 balance2Before = okuMoney.balanceOf(user2);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        assertEq(okuMoney.balanceOf(user1), balance1Before, "User1 balance unchanged");
        assertEq(okuMoney.balanceOf(user2), balance2Before, "User2 balance unchanged");
    }

    /// @notice Balance ratios unchanged after okuMMultiplier update
    function testFuzz_BalanceRatiosUnchangedAfterPriceUpdate(
        uint256 amount1,
        uint256 amount2,
        uint256 newPrice
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);
        newPrice = _boundOkuMMultiplier(newPrice);

        _mintOkuMoney(user1, amount1);
        _mintOkuMoney(user2, amount2);

        uint256 ratio1Before = (okuMoney.balanceOf(user1) * PRECISION) / okuMoney.totalSupply();
        uint256 ratio2Before = (okuMoney.balanceOf(user2) * PRECISION) / okuMoney.totalSupply();

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        uint256 ratio1After = (okuMoney.balanceOf(user1) * PRECISION) / okuMoney.totalSupply();
        uint256 ratio2After = (okuMoney.balanceOf(user2) * PRECISION) / okuMoney.totalSupply();

        // Ratios must be exactly preserved (standard ERC-20, no rounding)
        assertEq(ratio1After, ratio1Before, "User1 ratio exactly preserved");
        assertEq(ratio2After, ratio2Before, "User2 ratio exactly preserved");
    }

    // ============ okuMMultiplier Monotonicity Tests ============

    /// @notice okuMMultiplier can only increase via setOkuMMultiplier
    function testFuzz_NotePriceNeverDecreases(uint256 newPrice) public {
        uint256 currentPrice = okuMoney.okuMMultiplier();
        newPrice = _boundOkuMMultiplier(newPrice);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        assertGe(okuMoney.okuMMultiplier(), currentPrice, "okuMMultiplier must never decrease");
    }

    /// @notice Sequential okuMMultiplier updates accumulate correctly
    function testFuzz_SequentialNotePriceUpdates(uint256 increase1, uint256 increase2) public {
        increase1 = _boundOkuMMultiplierIncrease(increase1);
        increase2 = _boundOkuMMultiplierIncrease(increase2);

        uint256 priceBefore = okuMoney.okuMMultiplier();

        // First price update
        uint256 price1 = priceBefore + increase1;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(price1);

        assertEq(okuMoney.okuMMultiplier(), price1, "Price after first update");

        // Second price update
        uint256 price2 = price1 + increase2;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(price2);

        assertEq(okuMoney.okuMMultiplier(), price2, "Price after second update");
        assertGt(okuMoney.okuMMultiplier(), priceBefore, "Final price greater than initial");
    }

    /// @notice okuMMultiplier reverts if new price is less than current
    function testFuzz_NoteMultiplierCannotDecrease(uint256 increase, uint256 decrease) public {
        increase = _boundOkuMMultiplierIncrease(increase);

        uint256 currentPrice = okuMoney.okuMMultiplier();
        uint256 higherPrice = currentPrice + increase;

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(higherPrice);

        // Try to set a lower price (any amount below current)
        decrease = bound(decrease, 1, higherPrice);
        uint256 lowerPrice = higherPrice - decrease;

        vm.prank(rebaser);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        okuMoney.setOkuMMultiplier(lowerPrice);
    }

    // ============ distributeYield Fuzz Tests ============

    /// @notice distributeYield increases the multiplier monotonically and matches the
    ///         exact arithmetic formula across a realistic range of yield sizes.
    /// @dev distributeYield itself has no rate cap (only setOkuMMultiplier does).
    ///      Bound the yield to up to 10x the existing supply (1000% jump per call) —
    ///      a wildly aggressive but mathematically valid distribution that still
    ///      exercises the truncation/dust branches near MAX_SUPPLY without overflowing.
    function testFuzz_DistributeYield(uint256 supply, uint256 yieldAmount) public {
        // Keep room for `supply * 10` in the bounded yieldAmount without overflowing
        // (MAX_SUPPLY = 1e27, so supply * 10 stays well below 2^256).
        supply = bound(supply, 1e18, MAX_SUPPLY / 100);

        // Realistic upper bound: 10x current supply per single distribution.
        yieldAmount = bound(yieldAmount, 1, supply * 10);

        _mintOkuMoney(user1, supply);

        uint256 priceBefore = okuMoney.okuMMultiplier();

        vm.prank(rebaser);
        okuMoney.distributeYield(yieldAmount);

        uint256 priceAfter = okuMoney.okuMMultiplier();
        // Exact arithmetic check. Note that for very small yieldAmount relative to
        // supply the integer division can produce 0, so the multiplier is unchanged.
        uint256 expectedIncrease = (yieldAmount * PRECISION) / supply;
        assertEq(priceAfter, priceBefore + expectedIncrease, "price increase equals yield/supply");
        assertGe(priceAfter, priceBefore, "multiplier must never decrease");

        // lastYieldDistributionBlock advanced.
        assertEq(okuMoney.lastYieldDistributionBlock(), block.number);
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
        newPrice = _boundOkuMMultiplier(newPrice);

        _mintOkuMoney(user1, mintAmount);

        // Update okuMMultiplier (should not affect balances)
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

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
        vm.expectRevert(OkuMoney.ExceedsSupplyCap.selector);
        okuMoney.mint(user2, extraAmount);
    }

    /// @notice okuMMultiplier update does NOT affect supply cap enforcement
    function testFuzz_NotePriceDoesNotAffectSupplyCap(uint256 newPrice) public {
        newPrice = _boundOkuMMultiplier(newPrice);

        // Mint half the supply
        _mintOkuMoney(user1, MAX_SUPPLY / 2);

        // Update okuMMultiplier
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Should still be able to mint up to the cap (totalSupply is unaffected by okuMMultiplier)
        uint256 remaining = MAX_SUPPLY - okuMoney.totalSupply();
        _mintOkuMoney(user2, remaining);

        assertEq(okuMoney.totalSupply(), MAX_SUPPLY, "Can mint up to cap after price update");

        // But no more
        vm.prank(minter);
        vm.expectRevert(OkuMoney.ExceedsSupplyCap.selector);
        okuMoney.mint(user3, 1);
    }

    // ============ Mint After okuMMultiplier Change Tests ============

    /// @notice Minting after okuMMultiplier change gives exact token amount (no share conversion)
    function testFuzz_MintAfterNotePriceChange(
        uint256 firstMint,
        uint256 newPrice,
        uint256 secondMint
    )
        public
    {
        firstMint = bound(firstMint, 1e18, MAX_SUPPLY / 4);
        newPrice = _boundOkuMMultiplier(newPrice);
        secondMint = bound(secondMint, 1e18, MAX_SUPPLY / 4);

        // First mint
        _mintOkuMoney(user1, firstMint);
        assertEq(okuMoney.balanceOf(user1), firstMint, "User1 gets exact first mint");

        // Update okuMMultiplier
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Second mint at new price — user still gets exact token amount
        _mintOkuMoney(user2, secondMint);
        assertEq(okuMoney.balanceOf(user2), secondMint, "User2 gets exact second mint");

        // User1 balance unaffected by okuMMultiplier change
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

    /// @notice Operations after okuMMultiplier update maintain exact precision
    function testFuzz_PrecisionAfterNotePriceUpdate(uint256 mintAmount, uint256 newPrice) public {
        mintAmount = bound(mintAmount, 1e18, 1e24); // 1 to 1M tokens
        newPrice = _boundOkuMMultiplier(newPrice);

        _mintOkuMoney(user1, mintAmount);

        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Balance unchanged (standard ERC-20)
        assertEq(okuMoney.balanceOf(user1), mintAmount, "Balance exact after okuMMultiplier update");

        // Transfer at any okuMMultiplier
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
}
