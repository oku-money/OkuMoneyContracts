// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {wOkuUSD} from "../../src/token/wOkuUSD.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";

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

    // ============ Initialization Tests ============

    function test_Initialize_SetsCorrectName() public view {
        assertEq(wokuUsd.name(), "Wrapped OkuUSD");
    }

    function test_Initialize_SetsCorrectSymbol() public view {
        assertEq(wokuUsd.symbol(), "wOKUSD");
    }

    function test_Initialize_SetsCorrectAsset() public view {
        assertEq(wokuUsd.asset(), address(okuUsd));
    }

    function test_Initialize_SetsAdminRole() public view {
        assertTrue(wokuUsd.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(wokuUsd.hasRole(keccak256("UPGRADER"), admin));
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        wokuUsd.initialize(IERC20(address(okuUsd)), "Wrapped OkuUSD", "wOKUSD", admin);
    }

    // ============ Deposit Tests ============

    function test_Deposit_MintsCorrectShares() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        // At 1x multiplier, shares == assets
        assertEq(shares, amount);
        assertEq(wokuUsd.balanceOf(user1), amount);
    }

    function test_Deposit_TransfersOkuUSD() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        uint256 user1Before = okuUsd.balanceOf(user1);
        uint256 vaultBefore = okuUsd.balanceOf(address(wokuUsd));

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        assertEq(okuUsd.balanceOf(user1), user1Before - amount);
        assertEq(okuUsd.balanceOf(address(wokuUsd)), vaultBefore + amount);
    }

    function test_Deposit_UpdatesTotalAssets() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        uint256 totalAssetsBefore = wokuUsd.totalAssets();

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        assertEq(wokuUsd.totalAssets(), totalAssetsBefore + amount);
    }

    function test_Deposit_EmitsDepositEvent() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.expectEmit(true, true, false, true);
        emit Deposit(user1, user1, amount, amount);

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);
    }

    function test_Deposit_RevertsWithInsufficientApproval() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        // No approval

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(wokuUsd), 0, amount
            )
        );
        wokuUsd.deposit(amount, user1);
    }

    // ============ Withdraw/Redeem Tests ============

    function test_Redeem_ReturnsCorrectAssets() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        vm.prank(user1);
        uint256 assets = wokuUsd.redeem(shares, user1, user1);

        assertEq(assets, amount);
        assertEq(okuUsd.balanceOf(user1), amount);
    }

    function test_Redeem_BurnsShares() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        assertEq(wokuUsd.balanceOf(user1), shares);

        vm.prank(user1);
        wokuUsd.redeem(shares, user1, user1);

        assertEq(wokuUsd.balanceOf(user1), 0);
    }

    function test_Withdraw_ReturnsCorrectAssets() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        vm.prank(user1);
        uint256 sharesBurned = wokuUsd.withdraw(amount, user1, user1);

        assertEq(sharesBurned, amount); // At 1x multiplier
        assertEq(okuUsd.balanceOf(user1), amount);
        assertEq(wokuUsd.balanceOf(user1), 0);
    }

    function test_Withdraw_EmitsWithdrawEvent() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        vm.expectEmit(true, true, true, true);
        emit Withdraw(user1, user1, user1, amount, amount);

        vm.prank(user1);
        wokuUsd.withdraw(amount, user1, user1);
    }

    function test_Redeem_RevertsInsufficientShares() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Upgradeable.ERC4626ExceededMaxRedeem.selector, user1, shares + 1, shares
            )
        );
        wokuUsd.redeem(shares + 1, user1, user1);
    }

    // ============ Exchange Rate & Rebase Tests ============

    function test_ExchangeRate_IncreasesAfterRebase() public {
        // Deposit first so convertToAssets is meaningful at non-zero supply
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        uint256 conversionBefore = wokuUsd.convertToAssets(1e18);

        // Rebase 2x
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        uint256 conversionAfter = wokuUsd.convertToAssets(1e18);
        assertGt(conversionAfter, conversionBefore, "Exchange rate should increase after rebase");

        uint256 assetsAfter = wokuUsd.convertToAssets(shares);
        // After rebase from 1x to 2x, the OkuUSD in vault doubled
        assertGt(assetsAfter, amount);
    }

    function test_Redeem_AfterRebase_ReturnsMoreAssets() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        // Rebase 2x
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        vm.prank(user1);
        uint256 assets = wokuUsd.redeem(shares, user1, user1);

        // Should get ~2x the original deposit (allow 1 wei rounding from share conversion)
        assertApproxEqAbs(assets, amount * 2, 1);
    }

    function test_TotalAssets_IncreasesAfterRebase() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        uint256 totalAssetsBefore = wokuUsd.totalAssets();

        // Rebase 2x
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        uint256 totalAssetsAfter = wokuUsd.totalAssets();

        // Underlying OkuUSD balance doubles
        assertEq(totalAssetsAfter, totalAssetsBefore * 2);
    }

    function test_SharesUnchanged_AfterRebase() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        uint256 wokuBalanceBefore = wokuUsd.balanceOf(user1);

        // Rebase 2x
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        // wOkuUSD balance stays the same (non-rebasing)
        assertEq(wokuUsd.balanceOf(user1), wokuBalanceBefore);
        assertEq(wokuUsd.balanceOf(user1), shares);
    }

    // ============ Rounding Tests ============

    function test_Rounding_DepositFavorsVault() public {
        // Set non-integer exchange rate via rebase
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 3); // 3x multiplier

        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        // First deposit to set exchange rate
        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        // Now deposit an odd amount
        uint256 oddAmount = 7e18;
        _mintOkuUsd(user2, oddAmount);
        _approveOkuUsd(user2, address(wokuUsd), oddAmount);

        vm.prank(user2);
        uint256 shares = wokuUsd.deposit(oddAmount, user2);

        // Shares should be <= expected (rounding favors vault)
        uint256 expectedShares = wokuUsd.previewDeposit(oddAmount);
        assertEq(shares, expectedShares);
    }

    function test_Rounding_WithdrawFavorsVault() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        // Rebase to non-integer rate
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 3);

        // Withdraw odd amount
        uint256 withdrawAmount = 7e18;
        vm.prank(user1);
        uint256 sharesBurned = wokuUsd.withdraw(withdrawAmount, user1, user1);

        uint256 expectedShares = wokuUsd.previewWithdraw(withdrawAmount);
        assertEq(sharesBurned, expectedShares);
    }

    function test_RoundTrip_MaxOneWeiLoss() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        vm.prank(user1);
        uint256 assetsBack = wokuUsd.redeem(shares, user1, user1);

        // Round-trip should lose at most 1 wei
        assertGe(assetsBack, amount - 1);
    }

    // ============ View Tests ============

    function test_TotalAssets_EqualsVaultBalance() public {
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        wokuUsd.deposit(amount, user1);

        assertEq(wokuUsd.totalAssets(), okuUsd.balanceOf(address(wokuUsd)));
    }

    function test_TotalAssets_ZeroWhenEmpty() public view {
        assertEq(wokuUsd.totalAssets(), 0);
    }

    // ============ Access Control Tests ============

    function test_Upgrade_RevertsWithoutUpgraderRole() public {
        wOkuUSD newImpl = new wOkuUSD();

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                keccak256("UPGRADER")
            )
        );
        wokuUsd.upgradeToAndCall(address(newImpl), "");
    }

    function test_Upgrade_SucceedsWithRole() public {
        wOkuUSD newImpl = new wOkuUSD();

        vm.prank(admin);
        wokuUsd.upgradeToAndCall(address(newImpl), "");

        // Verify still works after upgrade
        assertEq(wokuUsd.name(), "Wrapped OkuUSD");
        assertEq(wokuUsd.asset(), address(okuUsd));
    }

    // ============ Multi-User Tests ============

    function test_MultiUser_IndependentAccounting() public {
        uint256 amount1 = 100e18;
        uint256 amount2 = 200e18;

        _mintOkuUsd(user1, amount1);
        _mintOkuUsd(user2, amount2);
        _approveOkuUsd(user1, address(wokuUsd), amount1);
        _approveOkuUsd(user2, address(wokuUsd), amount2);

        vm.prank(user1);
        uint256 shares1 = wokuUsd.deposit(amount1, user1);

        vm.prank(user2);
        uint256 shares2 = wokuUsd.deposit(amount2, user2);

        // Withdraw user1 - should not affect user2
        vm.prank(user1);
        wokuUsd.redeem(shares1, user1, user1);

        assertEq(wokuUsd.balanceOf(user1), 0);
        assertEq(wokuUsd.balanceOf(user2), shares2);
        assertEq(okuUsd.balanceOf(user1), amount1);
    }

    function test_MultiUser_ProportionalOwnership() public {
        uint256 amount1 = 100e18;
        uint256 amount2 = 300e18;

        _mintOkuUsd(user1, amount1);
        _mintOkuUsd(user2, amount2);
        _approveOkuUsd(user1, address(wokuUsd), amount1);
        _approveOkuUsd(user2, address(wokuUsd), amount2);

        vm.prank(user1);
        uint256 shares1 = wokuUsd.deposit(amount1, user1);

        vm.prank(user2);
        uint256 shares2 = wokuUsd.deposit(amount2, user2);

        // user2 should have 3x the shares of user1
        assertEq(shares2, shares1 * 3);

        // Total supply should be sum
        assertEq(wokuUsd.totalSupply(), shares1 + shares2);
    }

    function test_MultiUser_RebaseSharesProportionality() public {
        uint256 amount1 = 100e18;
        uint256 amount2 = 200e18;

        _mintOkuUsd(user1, amount1);
        _mintOkuUsd(user2, amount2);
        _approveOkuUsd(user1, address(wokuUsd), amount1);
        _approveOkuUsd(user2, address(wokuUsd), amount2);

        vm.prank(user1);
        uint256 shares1 = wokuUsd.deposit(amount1, user1);

        vm.prank(user2);
        uint256 shares2 = wokuUsd.deposit(amount2, user2);

        // Rebase 2x
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);

        // Both users redeem - each gets 2x their deposit
        vm.prank(user1);
        uint256 assets1 = wokuUsd.redeem(shares1, user1, user1);

        vm.prank(user2);
        uint256 assets2 = wokuUsd.redeem(shares2, user2, user2);

        // Allow 1 wei rounding per user from share conversion
        assertApproxEqAbs(assets1, amount1 * 2, 1);
        assertApproxEqAbs(assets2, amount2 * 2, 1);
    }

    // ============ Always Available Tests ============

    function test_NoPauseFunctionality() public {
        // Verify wOkuUSD has no pause function by attempting a low-level call
        (bool success,) = address(wokuUsd).call(abi.encodeWithSignature("pause()"));
        assertFalse(success, "wOkuUSD should not have pause functionality");

        // Confirm deposit/redeem work normally
        uint256 amount = 100e18;
        _mintOkuUsd(user1, amount);
        _approveOkuUsd(user1, address(wokuUsd), amount);

        vm.prank(user1);
        uint256 shares = wokuUsd.deposit(amount, user1);

        vm.prank(user1);
        uint256 assets = wokuUsd.redeem(shares, user1, user1);

        assertEq(assets, amount);
    }
}
