// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title wOkuUSDTest
 * @notice Unit tests for wOkuUSD ERC-4626 vault
 */
contract wOkuUSDTest is BaseTest {
    // ============ Events ============

    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Mint some OkuUSD to users for testing
        _mintOkuUSD(user1, 1000e18);
        _mintOkuUSD(user2, 1000e18);
    }

    // ============ ERC-4626 Compliance Tests ============

    function test_Asset_ReturnsOkuUSD() public view {
        assertEq(wokuUSD.asset(), address(okuUSD));
    }

    function test_TotalAssets_ReturnsOkuUSDBalance() public {
        assertEq(wokuUSD.totalAssets(), 0);

        // Deposit some OkuUSD
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        assertEq(wokuUSD.totalAssets(), 100e18);
        assertEq(wokuUSD.totalAssets(), okuUSD.balanceOf(address(wokuUSD)));
    }

    function test_Decimals_Matches18() public view {
        assertEq(wokuUSD.decimals(), 18);
    }

    function test_Name_IsCorrect() public view {
        assertEq(wokuUSD.name(), "Wrapped OkuUSD");
    }

    function test_Symbol_IsCorrect() public view {
        assertEq(wokuUSD.symbol(), "wOKUSD");
    }

    // ============ Deposit Tests ============

    function test_Deposit_TransfersOkuUSD() public {
        uint256 amount = 100e18;
        uint256 user1BalanceBefore = okuUSD.balanceOf(user1);
        uint256 vaultBalanceBefore = okuUSD.balanceOf(address(wokuUSD));

        _approveOkuUSD(user1, address(wokuUSD), amount);
        vm.prank(user1);
        wokuUSD.deposit(amount, user1);

        assertEq(okuUSD.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(okuUSD.balanceOf(address(wokuUSD)), vaultBalanceBefore + amount);
    }

    function test_Deposit_MintsShares() public {
        uint256 amount = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), amount);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(amount, user1);

        assertEq(wokuUSD.balanceOf(user1), shares);
        assertGt(shares, 0, "Should mint positive shares");
    }

    function test_Deposit_FirstDeposit() public {
        // First deposit: shares should equal assets (1:1)
        uint256 amount = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), amount);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(amount, user1);

        assertEq(shares, amount, "First deposit should be 1:1");
    }

    function test_Deposit_PreviewMatchesActual() public {
        uint256 amount = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), amount);
        uint256 preview = wokuUSD.previewDeposit(amount);

        vm.prank(user1);
        uint256 actual = wokuUSD.deposit(amount, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    function test_Deposit_ToDifferentReceiver() public {
        uint256 amount = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), amount);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(amount, user2);

        assertEq(wokuUSD.balanceOf(user1), 0);
        assertEq(wokuUSD.balanceOf(user2), shares);
    }

    function test_Deposit_EmitsEvent() public {
        uint256 amount = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), amount);

        vm.expectEmit(true, true, false, true);
        emit Deposit(user1, user1, amount, amount);

        vm.prank(user1);
        wokuUSD.deposit(amount, user1);
    }

    // ============ Mint (Share-based) Tests ============

    function test_Mint_TransfersCorrectOkuUSD() public {
        uint256 shares = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), type(uint256).max);

        uint256 balanceBefore = okuUSD.balanceOf(user1);

        vm.prank(user1);
        uint256 assets = wokuUSD.mint(shares, user1);

        assertEq(okuUSD.balanceOf(user1), balanceBefore - assets);
    }

    function test_Mint_MintsExactShares() public {
        uint256 shares = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), type(uint256).max);

        vm.prank(user1);
        wokuUSD.mint(shares, user1);

        assertEq(wokuUSD.balanceOf(user1), shares);
    }

    function test_Mint_PreviewMatchesActual() public {
        uint256 shares = 100e18;

        _approveOkuUSD(user1, address(wokuUSD), type(uint256).max);
        uint256 preview = wokuUSD.previewMint(shares);

        vm.prank(user1);
        uint256 actual = wokuUSD.mint(shares, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    // ============ Withdraw Tests ============

    function test_Withdraw_TransfersOkuUSD() public {
        // First deposit
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        uint256 user1BalanceBefore = okuUSD.balanceOf(user1);

        vm.prank(user1);
        wokuUSD.withdraw(50e18, user1, user1);

        assertEq(okuUSD.balanceOf(user1), user1BalanceBefore + 50e18);
    }

    function test_Withdraw_BurnsShares() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 depositedShares = wokuUSD.deposit(100e18, user1);

        vm.prank(user1);
        uint256 sharesBurned = wokuUSD.withdraw(50e18, user1, user1);

        assertEq(wokuUSD.balanceOf(user1), depositedShares - sharesBurned);
    }

    function test_Withdraw_PreviewMatchesActual() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        uint256 preview = wokuUSD.previewWithdraw(50e18);

        vm.prank(user1);
        uint256 actual = wokuUSD.withdraw(50e18, user1, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    function test_Withdraw_ToDifferentReceiver() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        uint256 user2BalanceBefore = okuUSD.balanceOf(user2);

        vm.prank(user1);
        wokuUSD.withdraw(50e18, user2, user1);

        assertEq(okuUSD.balanceOf(user2), user2BalanceBefore + 50e18);
    }

    function test_Withdraw_RevertsInsufficientShares() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        vm.prank(user1);
        vm.expectRevert();
        wokuUSD.withdraw(150e18, user1, user1);
    }

    // ============ Redeem Tests ============

    function test_Redeem_TransfersCorrectOkuUSD() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        uint256 user1BalanceBefore = okuUSD.balanceOf(user1);

        vm.prank(user1);
        uint256 assets = wokuUSD.redeem(shares, user1, user1);

        assertEq(okuUSD.balanceOf(user1), user1BalanceBefore + assets);
    }

    function test_Redeem_BurnsExactShares() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        vm.prank(user1);
        wokuUSD.redeem(shares / 2, user1, user1);

        assertEq(wokuUSD.balanceOf(user1), shares - shares / 2);
    }

    function test_Redeem_PreviewMatchesActual() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        uint256 preview = wokuUSD.previewRedeem(shares);

        vm.prank(user1);
        uint256 actual = wokuUSD.redeem(shares, user1, user1);

        assertEq(preview, actual, "Preview must match actual");
    }

    function test_Redeem_EmitsEvent() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        vm.expectEmit(true, true, true, true);
        emit Withdraw(user1, user1, user1, 100e18, shares);

        vm.prank(user1);
        wokuUSD.redeem(shares, user1, user1);
    }

    // ============ Rebase Interaction Tests ============

    function test_Rebase_IncreasesTotalAssets() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        uint256 totalAssetsBefore = wokuUSD.totalAssets();

        // Perform rebase (2x)
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        uint256 totalAssetsAfter = wokuUSD.totalAssets();
        assertEq(totalAssetsAfter, totalAssetsBefore * 2, "Total assets should double");
    }

    function test_Rebase_ShareValueIncreases() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        uint256 assetsBefore = wokuUSD.convertToAssets(shares);

        // Perform rebase (2x)
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        uint256 assetsAfter = wokuUSD.convertToAssets(shares);
        // Allow 1 wei rounding difference
        assertApproxEqAbs(assetsAfter, assetsBefore * 2, 1, "Share value should double");
    }

    function test_Rebase_ConversionRateChanges() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        uint256 sharesBefore = wokuUSD.convertToShares(50e18);

        // Perform rebase (2x)
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        uint256 sharesAfter = wokuUSD.convertToShares(50e18);

        // After rebase, same assets should get fewer shares
        assertLt(sharesAfter, sharesBefore, "Should get fewer shares after rebase");
    }

    function test_Rebase_DepositAfterGetsFewerShares() public {
        // User1 deposits before rebase
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 sharesBefore = wokuUSD.deposit(100e18, user1);

        // Perform rebase (2x)
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        // Mint more OkuUSD to user2 (at new multiplier they get same token amount)
        _mintOkuUSD(user2, 100e18);

        // User2 deposits same amount after rebase
        _approveOkuUSD(user2, address(wokuUSD), 100e18);
        vm.prank(user2);
        uint256 sharesAfter = wokuUSD.deposit(100e18, user2);

        // User2 should get fewer shares for same OkuUSD amount
        assertLt(sharesAfter, sharesBefore, "Should get fewer shares after rebase");
    }

    function test_Rebase_WithdrawReturnsMoreAfterRebase() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        // Perform rebase (2x)
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        // Redeem all shares
        vm.prank(user1);
        uint256 assets = wokuUSD.redeem(shares, user1, user1);

        // Should get back ~200e18 (2x original deposit), allow 1 wei rounding
        assertApproxEqAbs(assets, 200e18, 1, "Should receive 2x after rebase");
    }

    // ============ Rounding Tests ============

    function test_Deposit_RoundsDownShares() public {
        // Deposit, then rebase to create non-integer exchange rate
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        // Rebase to create odd ratio
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 3);

        // Mint more OkuUSD and deposit odd amount
        _mintOkuUSD(user2, 100e18);
        _approveOkuUSD(user2, address(wokuUSD), 100e18);

        vm.prank(user2);
        uint256 shares = wokuUSD.deposit(100e18, user2);

        // Verify rounding favors vault (less shares than might be expected)
        uint256 assetsBack = wokuUSD.convertToAssets(shares);
        assertLe(assetsBack, 100e18, "Rounding should favor vault");
    }

    function test_Withdraw_RoundsUpShares() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        // Rebase to create odd ratio
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 3);

        // Withdraw odd amount
        vm.prank(user1);
        uint256 sharesBurned = wokuUSD.withdraw(50e18, user1, user1);

        // More shares burned than minimum needed (rounding up favors vault)
        uint256 minSharesNeeded = wokuUSD.convertToShares(50e18);
        assertGe(sharesBurned, minSharesNeeded, "Should burn at least minimum shares needed");
    }

    // ============ Invariant Helper Tests ============

    function test_VaultBacking_Invariant() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        // Invariant: okuUSD.balanceOf(wokuUSD) == wokuUSD.totalAssets()
        assertEq(
            okuUSD.balanceOf(address(wokuUSD)), wokuUSD.totalAssets(), "Vault backing invariant"
        );

        // After rebase
        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2);

        assertEq(
            okuUSD.balanceOf(address(wokuUSD)),
            wokuUSD.totalAssets(),
            "Vault backing invariant after rebase"
        );
    }

    // ============ Max Functions Tests ============

    function test_MaxDeposit_ReturnsMaxUint() public view {
        assertEq(wokuUSD.maxDeposit(user1), type(uint256).max);
    }

    function test_MaxMint_ReturnsMaxUint() public view {
        assertEq(wokuUSD.maxMint(user1), type(uint256).max);
    }

    function test_MaxWithdraw_ReturnsUserAssets() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        wokuUSD.deposit(100e18, user1);

        uint256 maxWithdraw = wokuUSD.maxWithdraw(user1);
        uint256 userAssets = wokuUSD.convertToAssets(wokuUSD.balanceOf(user1));

        assertEq(maxWithdraw, userAssets, "Max withdraw equals user's assets");
    }

    function test_MaxRedeem_ReturnsUserShares() public {
        _approveOkuUSD(user1, address(wokuUSD), 100e18);
        vm.prank(user1);
        uint256 shares = wokuUSD.deposit(100e18, user1);

        assertEq(wokuUSD.maxRedeem(user1), shares, "Max redeem equals user's shares");
    }
}
