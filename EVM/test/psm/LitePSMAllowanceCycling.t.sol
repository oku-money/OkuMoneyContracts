// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyErrors} from "../../src/lib/errors/OkuMoneyErrors.sol";

/**
 * @title LitePSMAllowanceCyclingTest
 * @notice Regression for Cyfrin audit finding #1: permissionless fee-free mint/redeem
 *         cycling must not drain the PSM's minter allowance. Redeems burn through
 *         `OkuMoney.burn`, which restores the allowance up to the configured limit.
 */
contract LitePSMAllowanceCyclingTest is BaseTest {
    uint256 internal constant CAPITAL = 100e6;
    uint256 internal constant CYCLES = 10;

    uint256 internal perCycle;

    function setUp() public override {
        super.setUp();
        _mintUsdc(user1, CAPITAL * CYCLES);
        _mintUsdc(user2, 1000e6);

        _setOkuMMultiplierAndRoll(1.05e18);

        // PoC configuration: allowance sized for exactly CYCLES gross mints.
        perCycle = (CAPITAL * DECIMAL_MULTIPLIER * PRECISION) / okuMoney.okuMMultiplier();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), perCycle * CYCLES);
    }

    /// @notice The audit PoC loop no longer empties the allowance; a second user can still mint.
    function test_OkuMCycling_DoesNotDrainAllowance() public {
        uint256 configured = okuMoney.minterAllowance(address(litePsm));

        vm.startPrank(user1);
        usdc.approve(address(litePsm), type(uint256).max);
        okuMoney.approve(address(litePsm), type(uint256).max);
        // 3x the cycles that drained the allowance before the fix.
        for (uint256 i = 0; i < CYCLES * 3; i++) {
            litePsm.mintOkuM(CAPITAL / 3);
            litePsm.redeemOkuM(okuMoney.balanceOf(user1));
        }
        vm.stopPrank();

        assertEq(okuMoney.totalSupply(), 0, "no net supply issued");
        assertEq(okuMoney.minterAllowance(address(litePsm)), configured, "allowance restored");

        vm.startPrank(user2);
        usdc.approve(address(litePsm), 10e6);
        litePsm.mintOkuM(10e6);
        vm.stopPrank();
        assertGt(okuMoney.balanceOf(user2), 0, "victim mint succeeds");
    }

    /// @notice Same for the OkuDollar path (`mintUsdOku` / `redeemUsdOku`).
    function test_UsdOkuCycling_DoesNotDrainAllowance() public {
        uint256 configured = okuMoney.minterAllowance(address(litePsm));

        vm.startPrank(user1);
        usdc.approve(address(litePsm), type(uint256).max);
        okuDollar.approve(address(litePsm), type(uint256).max);
        for (uint256 i = 0; i < CYCLES * 3; i++) {
            litePsm.mintUsdOku(CAPITAL / 3);
            litePsm.redeemUsdOku(okuDollar.balanceOf(user1));
        }
        vm.stopPrank();

        // A redeemed position may leave one share of dust in the vault; the allowance
        // is restored for everything actually burned, so it ends within dust of the limit.
        uint256 outstanding = okuMoney.totalSupply();
        assertEq(
            okuMoney.minterAllowance(address(litePsm)),
            configured - outstanding,
            "allowance tracks net issuance"
        );

        vm.startPrank(user2);
        usdc.approve(address(litePsm), 10e6);
        litePsm.mintOkuM(10e6);
        vm.stopPrank();
        assertGt(okuMoney.balanceOf(user2), 0, "victim mint succeeds");
    }

    /// @notice The allowance still bounds net outstanding issuance: holding (not redeeming)
    ///         exhausts it, exactly as before.
    function test_NetIssuanceStillBounded() public {
        vm.startPrank(user1);
        usdc.approve(address(litePsm), type(uint256).max);
        for (uint256 i = 0; i < CYCLES; i++) {
            litePsm.mintOkuM(CAPITAL);
        }
        vm.stopPrank();
        assertEq(okuMoney.minterAllowance(address(litePsm)), 0, "net issuance hits allowance");

        vm.startPrank(user2);
        usdc.approve(address(litePsm), 10e6);
        vm.expectRevert(OkuMoneyErrors.ExceedsAllowance.selector);
        litePsm.mintOkuM(10e6);
        vm.stopPrank();

        // A redemption frees allowance for the next minter.
        vm.prank(user1);
        okuMoney.approve(address(litePsm), type(uint256).max);
        vm.prank(user1);
        litePsm.redeemOkuM(perCycle);

        vm.prank(user2);
        litePsm.mintOkuM(10e6);
        assertGt(okuMoney.balanceOf(user2), 0, "mint succeeds after redemption frees allowance");
    }

    /// @notice A configured zero allowance (incident cut-off) is not revived by redemptions.
    function test_ZeroAllowance_NotRestoredByRedeem() public {
        vm.startPrank(user1);
        usdc.approve(address(litePsm), type(uint256).max);
        okuMoney.approve(address(litePsm), type(uint256).max);
        litePsm.mintOkuM(CAPITAL);
        vm.stopPrank();

        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), 0);

        uint256 bal = okuMoney.balanceOf(user1);
        vm.prank(user1);
        litePsm.redeemOkuM(bal);
        assertEq(okuMoney.minterAllowance(address(litePsm)), 0);

        vm.startPrank(user2);
        usdc.approve(address(litePsm), 10e6);
        vm.expectRevert(OkuMoneyErrors.ExceedsAllowance.selector);
        litePsm.mintOkuM(10e6);
        vm.stopPrank();
    }
}
