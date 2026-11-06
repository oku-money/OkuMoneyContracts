// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title LitePSMSequencerLagTest
 * @notice Cyfrin audit finding #3 (Accepted Risk #15). No contract change: the mitigation is
 *         operational (README § L2 sequencer outage). A rollup's `block.timestamp` can trail
 *         wall clock after a sequencer outage; these tests model that as a mint executing at
 *         a lagging `block.timestamp` and pin what the runbook relies on:
 *           - unmitigated, a mint at the lagging timestamp redeems for the rise over the lag;
 *           - once the forced-path `LitePSM.pause()` has executed, a queued stale-timestamp
 *             mint reverts (both mint paths);
 *           - reopened only after the clock has caught up, a mint gains nothing.
 */
contract LitePSMSequencerLagTest is BaseTest {
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant LAG = 1 days;
    // about 5% APY as a per-second rate
    uint256 internal constant RATE = 1_000_000_001_547_126_016;
    uint256 internal constant DEPOSIT = 1_000_000e6;

    function setUp() public override {
        super.setUp();
        vm.warp(T0);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(RATE, T0 + 30 days);
        _mintUsdc(user1, DEPOSIT);
        _mintUsdc(address(litePsm), 10_000e6); // other holders' buffer
        _approveUsdc(user1, address(litePsm), type(uint256).max);
        _approveOkuMoney(user1, address(litePsm), type(uint256).max);
    }

    /// @notice The finding, unmitigated: the stale-timestamp mint takes the lag's yield.
    function test_Unmitigated_StaleMintGainsTheLag() public {
        // Wall clock is T0 + LAG; the force-included mint executes at block.timestamp T0.
        vm.prank(user1);
        litePsm.mintOkuM(DEPOSIT);

        // The chain catches up; the attacker redeems.
        vm.warp(T0 + LAG);
        uint256 bal = okuMoney.balanceOf(user1);
        vm.prank(user1);
        uint256 out = litePsm.redeemOkuM(bal);

        uint256 gain = out - DEPOSIT;
        assertApproxEqAbs(gain, 133_680_000, 1_000_000, "~133.68 USDC per 1M per day at 5% APY");
    }

    /// @notice Forced messages execute in order: a mint queued behind the pause reverts, and the
    ///         PSM stays closed through the catch-up.
    function test_PauseFirst_BlocksStaleMints() public {
        // The automated pauser's forced-path pause executes first (still at the stale time).
        vm.prank(pauser);
        litePsm.pause();

        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mintOkuM(DEPOSIT);
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mintUsdOku(DEPOSIT);

        // Catching up: still closed.
        vm.warp(T0 + LAG / 2);
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.mintOkuM(DEPOSIT);
    }

    /// @notice Reopened only once the clock is back at wall time, a mint buys at the current
    ///         multiplier and an immediate redeem gains nothing.
    function test_UnpauseAfterCatchUp_NoGain() public {
        vm.prank(pauser);
        litePsm.pause();

        vm.warp(T0 + LAG);
        vm.prank(unpauser);
        litePsm.unpause();

        uint256 bufferBefore = usdc.balanceOf(address(litePsm));
        vm.prank(user1);
        litePsm.mintOkuM(DEPOSIT);
        uint256 bal = okuMoney.balanceOf(user1);
        vm.prank(user1);
        uint256 out = litePsm.redeemOkuM(bal);

        assertLe(out, DEPOSIT, "no gain over the deposit");
        assertGe(usdc.balanceOf(address(litePsm)), bufferBefore, "buffer not drained");
    }

    /// @notice The pause only closes the PSM: the schedule keeps accruing on OkuMoney, so the
    ///         chain is still on the fleet's curve when it reopens.
    function test_PsmPause_DoesNotStopAccrual() public {
        uint256 before = okuMoney.okuMMultiplier();
        vm.prank(pauser);
        litePsm.pause();
        vm.warp(T0 + LAG);
        assertGt(okuMoney.okuMMultiplier(), before);
        assertFalse(okuMoney.paused());
    }
}
