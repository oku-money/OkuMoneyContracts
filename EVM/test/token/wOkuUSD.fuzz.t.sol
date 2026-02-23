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
        _mintOkuUsd(user1, MAX_SUPPLY / 4);
        _mintOkuUsd(user2, MAX_SUPPLY / 4);
    }

    // ============ Wrap/Unwrap Round-Trip Tests ============

    /// @notice Wrap then unwrap should return original amount (max 1 wei loss)
    function testFuzz_WrapUnwrapRoundTrip(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1));

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.startPrank(user1);
        uint256 shares = wokuUsd.deposit(depositAmount, user1);
        uint256 assetsBack = wokuUsd.redeem(shares, user1, user1);
        vm.stopPrank();

        // Max 1 wei rounding loss (from CLAUDE.md specification)
        assertGe(assetsBack, depositAmount - 1, "Max 1 wei loss on round trip");
        assertLe(assetsBack, depositAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip at various multipliers
    function testFuzz_WrapUnwrapRoundTripAtMultiplier(
        uint256 depositAmount,
        uint256 multiplier
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1) / 2);
        multiplier = _boundMultiplier(multiplier);

        // First, set the multiplier
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(multiplier);

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.startPrank(user1);
        uint256 shares = wokuUsd.deposit(depositAmount, user1);
        uint256 assetsBack = wokuUsd.redeem(shares, user1, user1);
        vm.stopPrank();

        // Allow for rounding at higher multipliers
        // At high multipliers, rounding can compound through deposit and redeem
        // Max loss is proportional to multiplier ratio
        uint256 maxLoss = (depositAmount * multiplier) / (PRECISION * PRECISION) + 10;
        assertGe(
            assetsBack,
            depositAmount > maxLoss ? depositAmount - maxLoss : 0,
            "Excessive loss on round trip"
        );
        assertLe(assetsBack, depositAmount, "Cannot gain on round trip");
    }

    /// @notice Round-trip with rebase in between
    function testFuzz_WrapRebaseUnwrap(uint256 depositAmount, uint256 newMultiplier) public {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1) / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(depositAmount, user1);

        // Rebase occurs
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Redeem after rebase
        vm.prank(user1);
        uint256 assetsBack = wokuUsd.redeem(shares, user1, user1);

        // User should receive scaled amount based on multiplier change
        uint256 expectedAssets = (depositAmount * newMultiplier) / PRECISION;
        assertApproxEqRel(
            assetsBack, expectedAssets, 0.0001e18, "Assets should scale with multiplier"
        );
    }

    // ============ Rebase Effect Tests ============

    /// @notice Rebase increases share value proportionally
    function testFuzz_RebaseIncreasesShareValue(
        uint256 depositAmount,
        uint256 newMultiplier
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1) / 2);
        // Ensure meaningful multiplier increase (at least 1% to avoid rounding issues)
        uint256 minMultiplier = okuUsd.rewardMultiplier() + (okuUsd.rewardMultiplier() / 100);
        newMultiplier = bound(newMultiplier, minMultiplier, okuUsd.rewardMultiplier() * 10);

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(depositAmount, user1);

        uint256 assetsBefore = wokuUsd.convertToAssets(shares);
        uint256 multiplierBefore = okuUsd.rewardMultiplier();

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        uint256 assetsAfter = wokuUsd.convertToAssets(shares);

        // Share value should increase (or stay same due to rounding for small increases)
        assertGe(assetsAfter, assetsBefore, "Share value should not decrease");

        uint256 expectedRatio = (newMultiplier * PRECISION) / multiplierBefore;
        uint256 actualRatio = (assetsAfter * PRECISION) / assetsBefore;
        assertApproxEqRel(actualRatio, expectedRatio, 0.01e18, "Value should scale with multiplier");
    }

    /// @notice Total assets equals vault's OkuUSD balance
    function testFuzz_TotalAssetsEqualsVaultBalance(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1) / 2);

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.prank(user1);
        wokuUsd.deposit(depositAmount, user1);

        // Invariant must hold
        assertEq(
            wokuUsd.totalAssets(),
            okuUsd.balanceOf(address(wokuUsd)),
            "totalAssets must equal actual balance"
        );
    }

    /// @notice Total assets invariant holds after rebase
    function testFuzz_TotalAssetsInvariantAfterRebase(
        uint256 depositAmount,
        uint256 newMultiplier
    )
        public
    {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1) / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.prank(user1);
        wokuUsd.deposit(depositAmount, user1);

        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Invariant still holds after rebase
        assertEq(
            wokuUsd.totalAssets(),
            okuUsd.balanceOf(address(wokuUsd)),
            "totalAssets invariant after rebase"
        );
    }

    // ============ Preview Function Tests ============

    /// @notice previewDeposit matches actual deposit
    function testFuzz_PreviewDeposit_MatchesActual(uint256 amount) public {
        amount = bound(amount, 1e18, okuUsd.balanceOf(user1) / 2);

        _approveOkuUsd(user1, address(wokuUsd), amount);
        uint256 preview = wokuUsd.previewDeposit(amount);

        vm.prank(user1);
        uint256 actual = wokuUsd.deposit(amount, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    /// @notice previewMint matches actual mint
    function testFuzz_PreviewMint_MatchesActual(uint256 shares) public {
        shares = bound(shares, 1e18, okuUsd.balanceOf(user1) / 2);

        _approveOkuUsd(user1, address(wokuUsd), type(uint256).max);
        uint256 preview = wokuUsd.previewMint(shares);

        vm.prank(user1);
        uint256 actual = wokuUsd.mint(shares, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    /// @notice previewWithdraw matches actual withdraw
    function testFuzz_PreviewWithdraw_MatchesActual(
        uint256 depositAmount,
        uint256 withdrawRatio
    )
        public
    {
        depositAmount = bound(depositAmount, 2e18, okuUsd.balanceOf(user1) / 2);
        withdrawRatio = bound(withdrawRatio, 1, 100); // 1% to 100%

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.prank(user1);
        wokuUsd.deposit(depositAmount, user1);

        uint256 withdrawAmount = (depositAmount * withdrawRatio) / 100;
        uint256 preview = wokuUsd.previewWithdraw(withdrawAmount);

        vm.prank(user1);
        uint256 actual = wokuUsd.withdraw(withdrawAmount, user1, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    /// @notice previewRedeem matches actual redeem
    function testFuzz_PreviewRedeem_MatchesActual(uint256 depositAmount) public {
        depositAmount = bound(depositAmount, 1e18, okuUsd.balanceOf(user1) / 2);

        _approveOkuUsd(user1, address(wokuUsd), depositAmount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(depositAmount, user1);

        uint256 preview = wokuUsd.previewRedeem(shares);

        vm.prank(user1);
        uint256 actual = wokuUsd.redeem(shares, user1, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    // ============ Conversion Function Tests ============

    /// @notice convertToShares and convertToAssets are inverse
    function testFuzz_ConversionFunctionsInverse(uint256 assets) public {
        assets = bound(assets, 1e18, MAX_SUPPLY / 10);

        // Need some liquidity in vault first
        _approveOkuUsd(user1, address(wokuUsd), assets);
        vm.prank(user1);
        wokuUsd.deposit(assets, user1);

        uint256 shares = wokuUsd.convertToShares(assets);
        uint256 recoveredAssets = wokuUsd.convertToAssets(shares);

        // Should be close (rounding may occur)
        assertLe(recoveredAssets, assets, "Should not gain assets");
        assertGe(recoveredAssets, assets - 1, "Max 1 wei loss");
    }

    /// @notice Conversion functions at various exchange rates
    function testFuzz_ConversionAtVariousRates(
        uint256 initialDeposit,
        uint256 newMultiplier,
        uint256 queryAmount
    )
        public
    {
        initialDeposit = bound(initialDeposit, 10e18, okuUsd.balanceOf(user1) / 4);
        newMultiplier = _boundMultiplier(newMultiplier);
        queryAmount = bound(queryAmount, 1e18, initialDeposit);

        // Create initial liquidity
        _approveOkuUsd(user1, address(wokuUsd), initialDeposit);
        vm.prank(user1);
        wokuUsd.deposit(initialDeposit, user1);

        // Rebase to change exchange rate
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Test conversions
        uint256 shares = wokuUsd.convertToShares(queryAmount);
        uint256 assets = wokuUsd.convertToAssets(shares);

        // Rounding should favor vault
        assertLe(assets, queryAmount, "Rounding favors vault");
    }

    // ============ Multiple Users Tests ============

    /// @notice Multiple deposits and withdrawals maintain correct accounting
    function testFuzz_MultipleUsersCorrectAccounting(
        uint256 deposit1,
        uint256 deposit2,
        uint256 withdraw1Ratio
    )
        public
    {
        deposit1 = bound(deposit1, 1e18, okuUsd.balanceOf(user1) / 2);
        deposit2 = bound(deposit2, 1e18, okuUsd.balanceOf(user2) / 2);
        withdraw1Ratio = bound(withdraw1Ratio, 1, 100);

        // User1 deposits
        _approveOkuUsd(user1, address(wokuUsd), deposit1);
        vm.prank(user1);
        uint256 shares1 = wokuUsd.deposit(deposit1, user1);

        // User2 deposits
        _approveOkuUsd(user2, address(wokuUsd), deposit2);
        vm.prank(user2);
        uint256 shares2 = wokuUsd.deposit(deposit2, user2);

        // Verify total shares and assets
        assertEq(wokuUsd.totalSupply(), shares1 + shares2, "Total shares correct");
        assertEq(wokuUsd.totalAssets(), deposit1 + deposit2, "Total assets correct");

        // User1 withdraws partial
        uint256 withdraw1Amount = (deposit1 * withdraw1Ratio) / 100;
        vm.prank(user1);
        wokuUsd.withdraw(withdraw1Amount, user1, user1);

        // Remaining should be consistent
        uint256 user1Assets = wokuUsd.convertToAssets(wokuUsd.balanceOf(user1));
        uint256 user2Assets = wokuUsd.convertToAssets(wokuUsd.balanceOf(user2));

        assertApproxEqAbs(
            user1Assets + user2Assets,
            wokuUsd.totalAssets(),
            2, // 2 wei tolerance for rounding
            "Sum of user assets equals total"
        );
    }

    /// @notice Users maintain proportional ownership after rebase
    function testFuzz_ProportionalOwnershipAfterRebase(
        uint256 deposit1,
        uint256 deposit2,
        uint256 newMultiplier
    )
        public
    {
        deposit1 = bound(deposit1, 1e18, okuUsd.balanceOf(user1) / 2);
        deposit2 = bound(deposit2, 1e18, okuUsd.balanceOf(user2) / 2);
        newMultiplier = _boundMultiplier(newMultiplier);

        _approveOkuUsd(user1, address(wokuUsd), deposit1);
        _approveOkuUsd(user2, address(wokuUsd), deposit2);

        vm.prank(user1);
        wokuUsd.deposit(deposit1, user1);

        vm.prank(user2);
        wokuUsd.deposit(deposit2, user2);

        // Calculate ownership ratios before rebase
        uint256 totalShares = wokuUsd.totalSupply();
        uint256 ratio1Before = (wokuUsd.balanceOf(user1) * PRECISION) / totalShares;
        uint256 ratio2Before = (wokuUsd.balanceOf(user2) * PRECISION) / totalShares;

        // Rebase
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Ownership ratios should be unchanged (shares don't change)
        uint256 ratio1After = (wokuUsd.balanceOf(user1) * PRECISION) / wokuUsd.totalSupply();
        uint256 ratio2After = (wokuUsd.balanceOf(user2) * PRECISION) / wokuUsd.totalSupply();

        assertEq(ratio1After, ratio1Before, "User1 ownership ratio preserved");
        assertEq(ratio2After, ratio2Before, "User2 ownership ratio preserved");
    }

    // ============ Edge Case Tests ============

    /// @notice Small deposits handled correctly
    function testFuzz_SmallDeposits(uint256 amount) public {
        amount = bound(amount, 1, 10_000); // Very small amounts

        _mintOkuUsd(user3, amount);
        _approveOkuUsd(user3, address(wokuUsd), amount);

        vm.prank(user3);
        uint256 shares = wokuUsd.deposit(amount, user3);

        if (shares > 0) {
            vm.prank(user3);
            uint256 assetsBack = wokuUsd.redeem(shares, user3, user3);
            assertGe(assetsBack, amount - 1, "Should receive at least amount minus 1 wei rounding");
        }
    }

    /// @notice Deposit and withdraw at high exchange rate
    function testFuzz_HighExchangeRate(uint256 depositAmount, uint256 multiplier) public {
        depositAmount = bound(depositAmount, 1e18, 1e22); // Smaller max to avoid supply cap
        multiplier = bound(multiplier, PRECISION * 10, PRECISION * 100);

        // Set high multiplier first
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(multiplier);

        // Increase max supply to accommodate high multiplier mints
        vm.prank(capManager);
        okuUsd.setMaxSupply(MAX_SUPPLY * 1000);

        // Need to also increase minter allowance
        vm.prank(allowanceManager);
        okuUsd.configureMinterAllowance(minter, MAX_SUPPLY * 1000);

        // Mint OkuUSD at high multiplier
        _mintOkuUsd(user3, depositAmount);

        _approveOkuUsd(user3, address(wokuUsd), depositAmount);

        vm.prank(user3);
        uint256 shares = wokuUsd.deposit(depositAmount, user3);

        // Should still be able to redeem
        vm.prank(user3);
        uint256 assetsBack = wokuUsd.redeem(shares, user3, user3);

        assertApproxEqRel(assetsBack, depositAmount, 0.001e18, "Should get back ~deposit amount");
    }
}
