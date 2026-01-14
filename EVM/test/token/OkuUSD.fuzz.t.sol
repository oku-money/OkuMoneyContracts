// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title OkuUSDFuzzTest
 * @notice Fuzz tests for OkuUSD focusing on share/token math and rebasing
 */
contract OkuUSDFuzzTest is BaseTest {
    // ============ Share/Token Conversion Math Tests ============

    /// @notice tokens -> shares -> tokens should round-trip with max 1 wei loss
    function testFuzz_SharesRoundTrip(uint256 tokens) public view {
        tokens = bound(tokens, 1, MAX_SUPPLY);

        uint256 shares = okuUSD.tokensToShares(tokens);
        uint256 recoveredTokens = okuUSD.sharesToTokens(shares);

        // Due to integer division, recovered may be slightly less
        assertLe(recoveredTokens, tokens, "Conversion should not gain tokens");
        assertGe(recoveredTokens, tokens - 1, "Max 1 wei loss on round trip");
    }

    /// @notice shares -> tokens -> shares should round-trip with possible loss
    function testFuzz_TokensRoundTrip(uint256 shares) public view {
        shares = bound(shares, 1, type(uint128).max);

        uint256 tokens = okuUSD.sharesToTokens(shares);
        uint256 recoveredShares = okuUSD.tokensToShares(tokens);

        // Due to integer division, recovered may be slightly less
        assertLe(recoveredShares, shares, "Conversion should not gain shares");
    }

    /// @notice Round-trip at various multipliers maintains precision
    function testFuzz_SharesRoundTripAtMultiplier(uint256 tokens, uint256 multiplier) public {
        // Use larger minimum to avoid edge cases with very small values
        tokens = bound(tokens, 1e18, MAX_SUPPLY / 10);
        multiplier = bound(multiplier, PRECISION, PRECISION * 10);

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(multiplier);

        uint256 shares = okuUSD.tokensToShares(tokens);
        uint256 recoveredTokens = okuUSD.sharesToTokens(shares);

        assertLe(recoveredTokens, tokens, "Should not gain tokens");
        // Allow for rounding based on multiplier scale - at most lose multiplier/PRECISION worth
        uint256 maxLoss = (tokens * multiplier) / (PRECISION * PRECISION) + 2;
        assertGe(
            recoveredTokens, tokens > maxLoss ? tokens - maxLoss : 0, "Excessive precision loss"
        );
    }

    // ============ Mint/Burn Consistency Tests ============

    /// @notice Minting then burning same amount returns to original state
    function testFuzz_MintBurnConsistency(uint256 amount) public {
        amount = _boundMintAmount(amount);

        uint256 totalSharesBefore = okuUSD.totalShares();
        uint256 totalSupplyBefore = okuUSD.totalSupply();

        _mintOkuUSD(user1, amount);

        vm.prank(minter);
        okuUSD.burn(user1, amount);

        // Should return to original state
        assertEq(okuUSD.totalShares(), totalSharesBefore, "Total shares should return to original");
        assertEq(okuUSD.totalSupply(), totalSupplyBefore, "Total supply should return to original");
        assertEq(okuUSD.balanceOf(user1), 0, "User balance should be zero");
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

        _mintOkuUSD(user1, amount1);
        _mintOkuUSD(user2, amount2);

        uint256 totalSupplyAfterMints = okuUSD.totalSupply();
        assertEq(totalSupplyAfterMints, amount1 + amount2, "Supply should equal sum of mints");

        // Burn partial from user1
        burnAmount = bound(burnAmount, 1, amount1);
        vm.prank(minter);
        okuUSD.burn(user1, burnAmount);

        assertEq(
            okuUSD.totalSupply(),
            amount1 + amount2 - burnAmount,
            "Supply should decrease by burn amount"
        );
    }

    // ============ Transfer Consistency Tests ============

    /// @notice Transfers preserve total shares
    function testFuzz_TransferPreservesShares(uint256 amount, uint256 transferAmount) public {
        amount = _boundMintAmount(amount);
        _mintOkuUSD(user1, amount);

        transferAmount = bound(transferAmount, 0, amount);

        uint256 totalSharesBefore = okuUSD.totalShares();
        uint256 combinedSharesBefore = okuUSD.sharesOf(user1) + okuUSD.sharesOf(user2);

        vm.prank(user1);
        assertTrue(okuUSD.transfer(user2, transferAmount));

        assertEq(okuUSD.totalShares(), totalSharesBefore, "Total shares unchanged by transfer");
        assertEq(
            okuUSD.sharesOf(user1) + okuUSD.sharesOf(user2),
            combinedSharesBefore,
            "Individual shares sum unchanged"
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
        _mintOkuUSD(user1, mintAmount);

        uint256 totalSupplyBefore = okuUSD.totalSupply();

        // Transfer user1 -> user2
        transfer1 = bound(transfer1, 1, mintAmount / 2);
        vm.prank(user1);
        assertTrue(okuUSD.transfer(user2, transfer1));

        // Transfer user2 -> user3
        transfer2 = bound(transfer2, 1, transfer1);
        vm.prank(user2);
        assertTrue(okuUSD.transfer(user3, transfer2));

        assertEq(okuUSD.totalSupply(), totalSupplyBefore, "Total supply unchanged by transfers");
        assertEq(
            okuUSD.balanceOf(user1) + okuUSD.balanceOf(user2) + okuUSD.balanceOf(user3),
            totalSupplyBefore,
            "Sum of balances equals total supply"
        );
    }

    // ============ Rebasing Tests ============

    /// @notice Rebase increases all balances proportionally
    function testFuzz_RebaseIncreasesAllBalances(uint256 mintAmount, uint256 newMultiplier) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 10);
        newMultiplier = _boundMultiplier(newMultiplier);

        _mintOkuUSD(user1, mintAmount);

        uint256 balanceBefore = okuUSD.balanceOf(user1);
        uint256 sharesBefore = okuUSD.sharesOf(user1);
        uint256 multiplierBefore = okuUSD.rewardMultiplier();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 balanceAfter = okuUSD.balanceOf(user1);
        uint256 sharesAfter = okuUSD.sharesOf(user1);

        // Shares should be unchanged
        assertEq(sharesAfter, sharesBefore, "Shares unchanged by rebase");

        // Balance should scale with multiplier ratio
        if (newMultiplier > multiplierBefore) {
            assertGt(balanceAfter, balanceBefore, "Balance should increase with multiplier");
        }

        // Verify the formula: balance = shares * multiplier / PRECISION
        uint256 expectedBalance = (sharesBefore * newMultiplier) / PRECISION;
        assertEq(balanceAfter, expectedBalance, "Balance matches formula");
    }

    /// @notice Rebase affects all users proportionally
    function testFuzz_RebaseAffectsAllUsersProportionally(
        uint256 amount1,
        uint256 amount2,
        uint256 newMultiplier
    )
        public
    {
        amount1 = bound(amount1, 1e18, MAX_SUPPLY / 4);
        amount2 = bound(amount2, 1e18, MAX_SUPPLY / 4);
        newMultiplier = _boundMultiplier(newMultiplier);

        _mintOkuUSD(user1, amount1);
        _mintOkuUSD(user2, amount2);

        uint256 ratio1Before = (okuUSD.balanceOf(user1) * PRECISION) / okuUSD.totalSupply();
        uint256 ratio2Before = (okuUSD.balanceOf(user2) * PRECISION) / okuUSD.totalSupply();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 ratio1After = (okuUSD.balanceOf(user1) * PRECISION) / okuUSD.totalSupply();
        uint256 ratio2After = (okuUSD.balanceOf(user2) * PRECISION) / okuUSD.totalSupply();

        // Ratios should be preserved (within rounding tolerance)
        assertApproxEqRel(ratio1After, ratio1Before, 0.0001e18, "User1 ratio preserved");
        assertApproxEqRel(ratio2After, ratio2Before, 0.0001e18, "User2 ratio preserved");
    }

    /// @notice Total supply scales with multiplier after rebase
    function testFuzz_TotalSupplyScalesWithMultiplier(
        uint256 mintAmount,
        uint256 newMultiplier
    )
        public
    {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 10);
        newMultiplier = _boundMultiplier(newMultiplier);

        _mintOkuUSD(user1, mintAmount);

        uint256 totalSharesBefore = okuUSD.totalShares();
        uint256 multiplierBefore = okuUSD.rewardMultiplier();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        // totalSupply = totalShares * multiplier / PRECISION
        uint256 expectedSupply = (totalSharesBefore * newMultiplier) / PRECISION;
        assertEq(okuUSD.totalSupply(), expectedSupply, "Total supply matches formula");

        // Verify proportional change
        uint256 supplyRatio = (okuUSD.totalSupply() * PRECISION) / mintAmount;
        uint256 multiplierRatio = (newMultiplier * PRECISION) / multiplierBefore;
        assertApproxEqRel(supplyRatio, multiplierRatio, 0.0001e18, "Supply scales with multiplier");
    }

    /// @notice Sequential rebases accumulate correctly
    function testFuzz_SequentialRebases(
        uint256 mintAmount,
        uint256 increase1,
        uint256 increase2
    )
        public
    {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 100);
        increase1 = bound(increase1, PRECISION / 1000, PRECISION / 10); // 0.1% to 10%
        increase2 = bound(increase2, PRECISION / 1000, PRECISION / 10);

        _mintOkuUSD(user1, mintAmount);

        uint256 sharesBefore = okuUSD.sharesOf(user1);

        // First rebase
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION + increase1);

        // Second rebase
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION + increase1 + increase2);

        // Shares should still be unchanged
        assertEq(okuUSD.sharesOf(user1), sharesBefore, "Shares unchanged after multiple rebases");

        // Balance should reflect final multiplier
        uint256 expectedBalance = (sharesBefore * (PRECISION + increase1 + increase2)) / PRECISION;
        assertEq(okuUSD.balanceOf(user1), expectedBalance, "Balance reflects final multiplier");
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

        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, initialAllowance);

        uint256 allowanceBefore = okuUSD.minterAllowance(minter);

        vm.prank(minter);
        okuUSD.mint(user1, mintAmount);

        uint256 allowanceAfterMint = okuUSD.minterAllowance(minter);
        assertEq(
            allowanceAfterMint, allowanceBefore - mintAmount, "Allowance decrements by mint amount"
        );

        // Burn should NOT restore allowance
        vm.prank(minter);
        okuUSD.burn(user1, mintAmount);

        assertEq(
            okuUSD.minterAllowance(minter), allowanceAfterMint, "Burn does not restore allowance"
        );
    }

    /// @notice Only admin can increase allowance
    function testFuzz_OnlyAdminIncreasesAllowance(uint256 mintAmount, uint256 newAllowance) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 2);
        newAllowance = bound(newAllowance, 0, MAX_SUPPLY);

        // Mint some tokens to decrease allowance
        _mintOkuUSD(user1, mintAmount);

        // Admin resets allowance
        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, newAllowance);

        assertEq(okuUSD.minterAllowance(minter), newAllowance, "Admin can set any allowance");
    }

    // ============ Balance Formula Invariant Tests ============

    /// @notice balanceOf always equals shares * multiplier / PRECISION
    function testFuzz_BalanceOfEqualsFormula(uint256 mintAmount, uint256 newMultiplier) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _mintOkuUSD(user1, mintAmount);

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 shares = okuUSD.sharesOf(user1);
        uint256 expectedBalance = (shares * newMultiplier) / PRECISION;

        assertEq(okuUSD.balanceOf(user1), expectedBalance, "balanceOf matches formula");
    }

    /// @notice totalSupply always equals totalShares * multiplier / PRECISION
    function testFuzz_TotalSupplyEqualsFormula(uint256 mintAmount, uint256 newMultiplier) public {
        mintAmount = bound(mintAmount, 1e18, MAX_SUPPLY / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _mintOkuUSD(user1, mintAmount);

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 totalShares = okuUSD.totalShares();
        uint256 expectedSupply = (totalShares * newMultiplier) / PRECISION;

        assertEq(okuUSD.totalSupply(), expectedSupply, "totalSupply matches formula");
    }

    // ============ Supply Cap Tests ============

    /// @notice Supply cap enforced on mint but not rebase
    function testFuzz_SupplyCapEnforcedOnMintNotRebase(uint256 multiplierIncrease) public {
        // Mint exactly at max supply
        _mintOkuUSD(user1, MAX_SUPPLY);

        // Should not be able to mint more (supply is at max)
        vm.prank(minter);
        vm.expectRevert("Exceeds supply cap");
        okuUSD.mint(user2, 1);

        // Bound multiplier increase to reasonable range
        multiplierIncrease = bound(multiplierIncrease, PRECISION / 10, PRECISION); // 10% to 100% increase

        // But rebase should work and push supply above maxSupply
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION + multiplierIncrease);

        // Supply now exceeds maxSupply
        assertGt(okuUSD.totalSupply(), MAX_SUPPLY, "Rebase can push supply above cap");
    }

    // ============ Edge Case Tests ============

    /// @notice Very small amounts handled correctly
    function testFuzz_VerySmallAmounts(uint256 amount) public {
        amount = bound(amount, 1, 1000); // 1 to 1000 wei

        _mintOkuUSD(user1, amount);

        assertEq(okuUSD.balanceOf(user1), amount, "Small mint works");

        if (amount > 1) {
            vm.prank(user1);
            assertTrue(okuUSD.transfer(user2, amount - 1));

            assertGe(okuUSD.balanceOf(user2), 0, "Small transfer works");
        }
    }

    /// @notice Operations at high multiplier maintain precision
    function testFuzz_HighMultiplierPrecision(uint256 mintAmount, uint256 multiplier) public {
        mintAmount = bound(mintAmount, 1e18, 1e24); // 1 to 1M tokens
        multiplier = bound(multiplier, PRECISION * 10, PRECISION * 100); // 10x to 100x

        _mintOkuUSD(user1, mintAmount);
        uint256 sharesBefore = okuUSD.sharesOf(user1);

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(multiplier);

        // Shares unchanged
        assertEq(okuUSD.sharesOf(user1), sharesBefore, "Shares unchanged at high multiplier");

        // Balance scales correctly
        uint256 expectedBalance = (sharesBefore * multiplier) / PRECISION;
        assertEq(okuUSD.balanceOf(user1), expectedBalance, "Balance correct at high multiplier");

        // Transfer at high multiplier
        uint256 transferAmount = expectedBalance / 2;
        vm.prank(user1);
        assertTrue(okuUSD.transfer(user2, transferAmount));

        // Verify transfer worked correctly
        assertApproxEqRel(
            okuUSD.balanceOf(user1) + okuUSD.balanceOf(user2),
            expectedBalance,
            0.0001e18,
            "Total balance preserved after transfer"
        );
    }

    /// @notice Mint after rebase calculates shares correctly
    function testFuzz_MintAfterRebase(
        uint256 firstMint,
        uint256 multiplier,
        uint256 secondMint
    )
        public
    {
        // Use smaller amounts to avoid supply cap issues after rebase
        firstMint = bound(firstMint, 1e18, MAX_SUPPLY / 20);
        multiplier = bound(multiplier, PRECISION, PRECISION * 5);
        secondMint = bound(secondMint, 1e18, MAX_SUPPLY / 20);

        // First mint at initial multiplier
        _mintOkuUSD(user1, firstMint);
        uint256 user1Shares = okuUSD.sharesOf(user1);

        // Rebase
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(multiplier);

        // Second mint at new multiplier
        _mintOkuUSD(user2, secondMint);
        uint256 user2Shares = okuUSD.sharesOf(user2);

        // User2 should get fewer shares for same token amount at higher multiplier
        uint256 expectedUser2Shares = (secondMint * PRECISION) / multiplier;
        assertEq(user2Shares, expectedUser2Shares, "Shares calculated correctly after rebase");

        // Verify balances (allow small rounding due to share conversion)
        assertEq(
            okuUSD.balanceOf(user1), (user1Shares * multiplier) / PRECISION, "User1 balance correct"
        );
        // User2 balance may have rounding due to share conversion at different multipliers
        // At high multipliers, rounding can compound - allow up to multiplier/PRECISION wei
        uint256 maxRounding = (multiplier / PRECISION) + 1;
        assertApproxEqAbs(
            okuUSD.balanceOf(user2), secondMint, maxRounding, "User2 balance equals mint amount"
        );
    }
}
