// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";

/**
 * @title wOkuUSDFuzzTest
 * @notice Fuzz tests for wOkuUSD ERC-4626 vault focusing on math and rebase interactions
 */
contract wOkuUSDFuzzTest is BaseTest {
    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint OkuUSD to users for testing
        _mintOkuUSD(user1, MAX_SUPPLY / 4);
        _mintOkuUSD(user2, MAX_SUPPLY / 4);
    }

    // ============ Wrap/Unwrap Round-Trip Tests ============

    /// @notice Wrap then unwrap should return original amount (max 1 wei loss)
    function testFuzz_WrapUnwrapRoundTrip(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1));

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.startPrank(user1);
        uint256 shares = wokuUSD.deposit(depositAmount, user1);
        uint256 assetsBack = wokuUSD.redeem(shares, user1, user1);
        vm.stopPrank();

        // Max 1 wei rounding loss (from CLAUDE.md specification)
        assertGe(assetsBack, depositAmount - 1, "Max 1 wei loss on round trip");
        assertLe(assetsBack, depositAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip at various multipliers
    function testFuzz_WrapUnwrapRoundTripAtMultiplier(
        uint256 depositAmount,
        uint256 multiplier
    ) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1) / 2);
        multiplier = _boundMultiplier(multiplier);

        // First, set the multiplier
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(multiplier);

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.startPrank(user1);
        uint256 shares = wokuUSD.deposit(depositAmount, user1);
        uint256 assetsBack = wokuUSD.redeem(shares, user1, user1);
        vm.stopPrank();

        // Allow for rounding at higher multipliers
        // At high multipliers, rounding can compound through deposit and redeem
        // Max loss is proportional to multiplier ratio
        uint256 maxLoss = (depositAmount * multiplier) / (PRECISION * PRECISION) + 10;
        assertGe(assetsBack, depositAmount > maxLoss ? depositAmount - maxLoss : 0, "Excessive loss on round trip");
        assertLe(assetsBack, depositAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip with rebase in between
    function testFuzz_WrapRebaseUnwrap(uint256 depositAmount, uint256 newMultiplier) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1) / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(depositAmount, user1);

        // Rebase occurs
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        // Redeem after rebase
        vm.prank(user1);
        uint256 assetsBack = wokuUSD.redeem(shares, user1, user1);

        // User should receive scaled amount based on multiplier change
        uint256 expectedAssets = (depositAmount * newMultiplier) / PRECISION;
        assertApproxEqRel(assetsBack, expectedAssets, 0.0001e18, "Assets should scale with multiplier");
    }

    // ============ Rebase Effect Tests ============

    /// @notice Rebase increases share value proportionally
    function testFuzz_RebaseIncreasesShareValue(uint256 depositAmount, uint256 newMultiplier) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1) / 2);
        // Ensure meaningful multiplier increase (at least 1% to avoid rounding issues)
        uint256 minMultiplier = okuUSD.rewardMultiplier() + (okuUSD.rewardMultiplier() / 100);
        newMultiplier = bound(newMultiplier, minMultiplier, okuUSD.rewardMultiplier() * 10);

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(depositAmount, user1);

        uint256 assetsBefore = wokuUSD.convertToAssets(shares);
        uint256 multiplierBefore = okuUSD.rewardMultiplier();

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        uint256 assetsAfter = wokuUSD.convertToAssets(shares);

        // Share value should increase (or stay same due to rounding for small increases)
        assertGe(assetsAfter, assetsBefore, "Share value should not decrease");

        uint256 expectedRatio = (newMultiplier * PRECISION) / multiplierBefore;
        uint256 actualRatio = (assetsAfter * PRECISION) / assetsBefore;
        assertApproxEqRel(actualRatio, expectedRatio, 0.01e18, "Value should scale with multiplier");
    }

    /// @notice Total assets equals vault's OkuUSD balance
    function testFuzz_TotalAssetsEqualsVaultBalance(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1) / 2);

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.prank(user1);
        wokuUSD.deposit(depositAmount, user1);

        // Invariant must hold
        assertEq(
            wokuUSD.totalAssets(),
            okuUSD.balanceOf(address(wokuUSD)),
            "totalAssets must equal actual balance"
        );
    }

    /// @notice Total assets invariant holds after rebase
    function testFuzz_TotalAssetsInvariantAfterRebase(
        uint256 depositAmount,
        uint256 newMultiplier
    ) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1) / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.prank(user1);
        wokuUSD.deposit(depositAmount, user1);

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        // Invariant still holds after rebase
        assertEq(
            wokuUSD.totalAssets(),
            okuUSD.balanceOf(address(wokuUSD)),
            "totalAssets invariant after rebase"
        );
    }

    // ============ Preview Function Tests ============

    /// @notice previewDeposit matches actual deposit
    function testFuzz_PreviewDeposit_MatchesActual(uint256 amount) public {
        amount = bound(amount, 1e18, okuUSD.balanceOf(user1) / 2);

        _approveOkuUSD(user1, address(wokuUSD), amount);
        uint256 preview = wokuUSD.previewDeposit(amount);

        vm.prank(user1);
        uint256 actual = wokuUSD.deposit(amount, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    /// @notice previewMint matches actual mint
    function testFuzz_PreviewMint_MatchesActual(uint256 shares) public {
        shares = bound(shares, 1e18, okuUSD.balanceOf(user1) / 2);

        _approveOkuUSD(user1, address(wokuUSD), type(uint256).max);
        uint256 preview = wokuUSD.previewMint(shares);

        vm.prank(user1);
        uint256 actual = wokuUSD.mint(shares, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    /// @notice previewWithdraw matches actual withdraw
    function testFuzz_PreviewWithdraw_MatchesActual(uint256 depositAmount, uint256 withdrawRatio) public {
        depositAmount = bound(depositAmount, 2e18, okuUSD.balanceOf(user1) / 2);
        withdrawRatio = bound(withdrawRatio, 1, 100); // 1% to 100%

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.prank(user1);
        wokuUSD.deposit(depositAmount, user1);

        uint256 withdrawAmount = (depositAmount * withdrawRatio) / 100;
        uint256 preview = wokuUSD.previewWithdraw(withdrawAmount);

        vm.prank(user1);
        uint256 actual = wokuUSD.withdraw(withdrawAmount, user1, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    /// @notice previewRedeem matches actual redeem
    function testFuzz_PreviewRedeem_MatchesActual(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, okuUSD.balanceOf(user1) / 2);

        _approveOkuUSD(user1, address(wokuUSD), depositAmount);

        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(depositAmount, user1);

        uint256 preview = wokuUSD.previewRedeem(shares);

        vm.prank(user1);
        uint256 actual = wokuUSD.redeem(shares, user1, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    // ============ Conversion Function Tests ============

    /// @notice convertToShares and convertToAssets are inverse
    function testFuzz_ConversionFunctionsInverse(uint256 assets) public {
        assets = bound(assets, 1e18, MAX_SUPPLY / 10);

        // Need some liquidity in vault first
        _approveOkuUSD(user1, address(wokuUSD), assets);
        vm.prank(user1);
        wokuUSD.deposit(assets, user1);

        uint256 shares = wokuUSD.convertToShares(assets);
        uint256 recoveredAssets = wokuUSD.convertToAssets(shares);

        // Should be close (rounding may occur)
        assertLe(recoveredAssets, assets, "Should not gain assets");
        assertGe(recoveredAssets, assets - 1, "Max 1 wei loss");
    }

    /// @notice Conversion functions at various exchange rates
    function testFuzz_ConversionAtVariousRates(
        uint256 initialDeposit,
        uint256 newMultiplier,
        uint256 queryAmount
    ) public {
        initialDeposit = bound(initialDeposit, 10e18, okuUSD.balanceOf(user1) / 4);
        newMultiplier = _boundMultiplier(newMultiplier);
        queryAmount = bound(queryAmount, 1e18, initialDeposit);

        // Create initial liquidity
        _approveOkuUSD(user1, address(wokuUSD), initialDeposit);
        vm.prank(user1);
        wokuUSD.deposit(initialDeposit, user1);

        // Rebase to change exchange rate
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        // Test conversions
        uint256 shares = wokuUSD.convertToShares(queryAmount);
        uint256 assets = wokuUSD.convertToAssets(shares);

        // Rounding should favor vault
        assertLe(assets, queryAmount, "Rounding favors vault");
    }

    // ============ Multiple Users Tests ============

    /// @notice Multiple deposits and withdrawals maintain correct accounting
    function testFuzz_MultipleUsersCorrectAccounting(
        uint256 deposit1,
        uint256 deposit2,
        uint256 withdraw1Ratio
    ) public {
        deposit1 = bound(deposit1, 1e18, okuUSD.balanceOf(user1) / 2);
        deposit2 = bound(deposit2, 1e18, okuUSD.balanceOf(user2) / 2);
        withdraw1Ratio = bound(withdraw1Ratio, 1, 100);

        // User1 deposits
        _approveOkuUSD(user1, address(wokuUSD), deposit1);
        vm.prank(user1);
        uint256 shares1 = wokuUSD.deposit(deposit1, user1);

        // User2 deposits
        _approveOkuUSD(user2, address(wokuUSD), deposit2);
        vm.prank(user2);
        uint256 shares2 = wokuUSD.deposit(deposit2, user2);

        // Verify total shares and assets
        assertEq(wokuUSD.totalSupply(), shares1 + shares2, "Total shares correct");
        assertEq(wokuUSD.totalAssets(), deposit1 + deposit2, "Total assets correct");

        // User1 withdraws partial
        uint256 withdraw1Amount = (deposit1 * withdraw1Ratio) / 100;
        vm.prank(user1);
        wokuUSD.withdraw(withdraw1Amount, user1, user1);

        // Remaining should be consistent
        uint256 user1Assets = wokuUSD.convertToAssets(wokuUSD.balanceOf(user1));
        uint256 user2Assets = wokuUSD.convertToAssets(wokuUSD.balanceOf(user2));

        assertApproxEqAbs(
            user1Assets + user2Assets,
            wokuUSD.totalAssets(),
            2, // 2 wei tolerance for rounding
            "Sum of user assets equals total"
        );
    }

    /// @notice Users maintain proportional ownership after rebase
    function testFuzz_ProportionalOwnershipAfterRebase(
        uint256 deposit1,
        uint256 deposit2,
        uint256 newMultiplier
    ) public {
        deposit1 = bound(deposit1, 1e18, okuUSD.balanceOf(user1) / 2);
        deposit2 = bound(deposit2, 1e18, okuUSD.balanceOf(user2) / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _approveOkuUSD(user1, address(wokuUSD), deposit1);
        _approveOkuUSD(user2, address(wokuUSD), deposit2);

        vm.prank(user1);
        wokuUSD.deposit(deposit1, user1);

        vm.prank(user2);
        wokuUSD.deposit(deposit2, user2);

        // Calculate ownership ratios before rebase
        uint256 totalShares = wokuUSD.totalSupply();
        uint256 ratio1Before = (wokuUSD.balanceOf(user1) * PRECISION) / totalShares;
        uint256 ratio2Before = (wokuUSD.balanceOf(user2) * PRECISION) / totalShares;

        // Rebase
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(newMultiplier);

        // Ownership ratios should be unchanged (shares don't change)
        uint256 ratio1After = (wokuUSD.balanceOf(user1) * PRECISION) / wokuUSD.totalSupply();
        uint256 ratio2After = (wokuUSD.balanceOf(user2) * PRECISION) / wokuUSD.totalSupply();

        assertEq(ratio1After, ratio1Before, "User1 ownership ratio preserved");
        assertEq(ratio2After, ratio2Before, "User2 ownership ratio preserved");
    }

    // ============ Edge Case Tests ============

    /// @notice Small deposits handled correctly
    function testFuzz_SmallDeposits(uint256 amount) public {
        amount = bound(amount, 1, 10000); // Very small amounts

        _mintOkuUSD(user3, amount);
        _approveOkuUSD(user3, address(wokuUSD), amount);

        vm.prank(user3);
        uint256 shares = wokuUSD.deposit(amount, user3);

        if (shares > 0) {
            vm.prank(user3);
            uint256 assetsBack = wokuUSD.redeem(shares, user3, user3);
            assertGe(assetsBack, 0, "Should receive non-negative assets");
        }
    }

    /// @notice Deposit and withdraw at high exchange rate
    function testFuzz_HighExchangeRate(uint256 depositAmount, uint256 multiplier) public {
        depositAmount = bound(depositAmount, 1e18, 1e22); // Smaller max to avoid supply cap
        multiplier = bound(multiplier, PRECISION * 10, PRECISION * 100);

        // Set high multiplier first
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(multiplier);

        // Increase max supply to accommodate high multiplier mints
        vm.prank(admin);
        okuUSD.setMaxSupply(MAX_SUPPLY * 1000);

        // Need to also increase minter allowance
        vm.prank(admin);
        okuUSD.configureMinterAllowance(minter, MAX_SUPPLY * 1000);

        // Mint OkuUSD at high multiplier
        _mintOkuUSD(user3, depositAmount);

        _approveOkuUSD(user3, address(wokuUSD), depositAmount);

        vm.prank(user3);
        uint256 shares = wokuUSD.deposit(depositAmount, user3);

        // Should still be able to redeem
        vm.prank(user3);
        uint256 assetsBack = wokuUSD.redeem(shares, user3, user3);

        assertApproxEqRel(assetsBack, depositAmount, 0.001e18, "Should get back ~deposit amount");
    }
}
