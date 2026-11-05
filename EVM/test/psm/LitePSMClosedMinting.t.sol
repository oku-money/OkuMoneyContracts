// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {Deploy} from "../shared/Deploy.sol";
import {OkuMoneyErrors} from "../../src/lib/errors/OkuMoneyErrors.sol";

/**
 * @title LitePSMClosedMintingTest
 * @notice Regression for Cyfrin audit finding #2. No contract change: the mitigation is the
 *         deployment ceremony and the laggard runbook (README § Opening PSM minting on a
 *         chain, § Chain lagging the fleet). These tests pin the contract properties that
 *         ceremony relies on:
 *           - a zero LitePSM minter allowance closes PSM minting (mainnet deploy state);
 *           - while closed, `setOkuMMultiplier`, yielding rate writes and redemptions work,
 *             and `configureMinterAllowance` works with LitePSM and OkuMoney paused;
 *           - redemptions never reopen a configured zero (finding #1 fix);
 *           - following the ceremony, nobody buys below the fleet's multiplier.
 */
contract LitePSMClosedMintingTest is BaseTest {
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant DAY = 1 days;
    // about 5% APY as a per-second rate
    uint256 internal constant RATE = 1_000_000_001_547_126_016;
    uint256 internal constant HONEST_USDC = 100_000e6;
    uint256 internal constant ENTRANT_USDC = 1_000_000e6;
    uint256 internal constant POLICY_ALLOWANCE = 10_000_000e18;

    function setUp() public override {
        super.setUp();
        // Mainnet deploy state: the deploy script never sets an allowance (0).
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), 0);
    }

    // smallest rate whose compounded multiplier reaches the target, as catchUpRate in packages/yield-tooling
    function _catchUpRate(
        uint256 cur,
        uint256 target,
        uint256 window
    )
        internal
        pure
        returns (uint256)
    {
        uint256 lo = PRECISION;
        uint256 hi = MAX_RATE;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (MathLib.compoundFor(cur, mid, window) >= target) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    function _openMinting() internal {
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), POLICY_ALLOWANCE);
    }

    /// @notice Cyfrin PoC 1 (fresh chain), following the ceremony: no mint at 1.00 is possible,
    ///         and once opened the early buyer extracts nothing from the buffer.
    function test_FreshChain_ClosedUntilSeeded() public {
        _mintUsdc(user1, 10_000e6);
        _mintUsdc(user2, 10_000e6);
        _mintUsdc(address(litePsm), 5000e6); // treasury top-up in the buffer
        assertEq(okuMoney.okuMMultiplier(), 1e18);

        // The PoC's mint at the hardcoded 1.00 now reverts.
        _approveUsdc(user1, address(litePsm), type(uint256).max);
        vm.prank(user1);
        vm.expectRevert(OkuMoneyErrors.ExceedsAllowance.selector);
        litePsm.mintOkuM(10_000e6);
        _approveUsdc(user2, address(litePsm), type(uint256).max);
        vm.prank(user2);
        vm.expectRevert(OkuMoneyErrors.ExceedsAllowance.selector);
        litePsm.mintUsdOku(10_000e6);

        // Ceremony: bring it to the fleet's 1.05 while closed, then open.
        _setOkuMMultiplierAndRoll(1.05e18);
        _openMinting();

        vm.prank(user1);
        litePsm.mintOkuM(10_000e6);
        uint256 bufferBefore = usdc.balanceOf(address(litePsm));
        uint256 bal = okuMoney.balanceOf(user1);
        _approveOkuMoney(user1, address(litePsm), bal);
        vm.prank(user1);
        uint256 out = litePsm.redeemOkuM(bal);

        assertLe(out, 10_000e6, "no gain over the deposit");
        assertEq(usdc.balanceOf(user1), out);
        assertGe(usdc.balanceOf(address(litePsm)), bufferBefore - 10_000e6, "buffer not drained");
    }

    /// @notice Every lever the ceremony needs works while PSM minting is closed.
    function test_ClosedMinting_LeversStillWork() public {
        // Override and a yielding rate write.
        _setOkuMMultiplierAndRoll(1.05e18);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(RATE, block.timestamp + DAY);

        // Allowance can be zeroed and set with BOTH LitePSM and OkuMoney paused.
        vm.prank(pauser);
        litePsm.pause();
        vm.prank(pauser);
        okuMoney.pause();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), POLICY_ALLOWANCE);
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), 0);
        assertEq(okuMoney.minterAllowance(address(litePsm)), 0);
        assertEq(okuMoney.minterAllowanceLimit(address(litePsm)), 0);
    }

    /// @notice A holder can always exit while minting is closed, and redeeming does not reopen it.
    function test_ClosedMinting_RedeemOpenAndDoesNotReopen() public {
        _openMinting();
        _mintUsdc(user1, 10_000e6);
        _approveUsdc(user1, address(litePsm), 10_000e6);
        vm.prank(user1);
        litePsm.mintOkuM(10_000e6);

        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), 0);

        uint256 bal = okuMoney.balanceOf(user1);
        _approveOkuMoney(user1, address(litePsm), bal);
        vm.prank(user1);
        litePsm.redeemOkuM(bal);
        assertEq(usdc.balanceOf(user1), 10_000e6);
        assertEq(okuMoney.minterAllowance(address(litePsm)), 0, "redeem does not reopen minting");
    }

    /// @notice Cyfrin PoC 2 (laggard catch-up), following § Chain lagging the fleet: the warm
    ///         pause lands before the laggard's accrual stops, the allowance is zeroed, the PSM
    ///         is unpaused for redemptions, and minting reopens only once the chains match.
    ///         The entrant can no longer buy at the lagging multiplier.
    function test_Laggard_ClosedDuringCatchUp() public {
        (OkuMoney leader,) = Deploy.deployOkuMoney(admin);
        vm.prank(admin);
        leader.grantRole(OKUM_RATE_MANAGER, rateManager);
        _mintUsdc(user2, HONEST_USDC);
        _mintUsdc(user1, ENTRANT_USDC);
        _openMinting();

        // identical epoch on both chains
        vm.warp(T0);
        vm.prank(rateManager);
        leader.setOkuMYieldRate(RATE, T0 + DAY);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(RATE, T0 + DAY);

        // an honest holder is on the laggard chain before the lag
        _approveUsdc(user2, address(litePsm), HONEST_USDC);
        vm.prank(user2);
        litePsm.mintOkuM(HONEST_USDC);

        // the next broadcast lands on the leader only
        vm.warp(T0 + DAY - 7 hours);
        vm.prank(rateManager);
        leader.setOkuMYieldRate(RATE, T0 + 5 * DAY);

        // LAG IMMINENT fires 6h before the laggard's rateEnd: warm pause, zero, cold unpause
        vm.warp(T0 + DAY - 6 hours);
        vm.prank(pauser);
        litePsm.pause();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(litePsm), 0);
        vm.prank(unpauser);
        litePsm.unpause();

        // three days later the operator applies the catch-up to the leader's rateEnd
        vm.warp(T0 + 4 * DAY);
        uint256 end = leader.okuMRateEnd();
        uint256 lagging = okuMoney.okuMMultiplier();
        uint256 target = MathLib.compoundFor(
            leader.okuMBaseMultiplier(),
            leader.okuMRatePerSecond(),
            end - leader.okuMLastAccrualTime()
        );
        uint256 rate = _catchUpRate(lagging, target, end - block.timestamp);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(rate, end);

        // the PoC's entrant mint at the lagging multiplier now reverts
        _approveUsdc(user1, address(litePsm), ENTRANT_USDC);
        vm.prank(user1);
        vm.expectRevert(OkuMoneyErrors.ExceedsAllowance.selector);
        litePsm.mintOkuM(ENTRANT_USDC);

        // redemptions stay open throughout the catch-up
        uint256 half = okuMoney.balanceOf(user2) / 2;
        _approveOkuMoney(user2, address(litePsm), type(uint256).max);
        vm.prank(user2);
        litePsm.redeemOkuM(half);

        // at the leader's rateEnd both chains agree; only then reopen
        vm.warp(end);
        // equal up to compounding rounding dust (README step 5)
        assertApproxEqAbs(okuMoney.okuMMultiplier(), leader.okuMMultiplier(), 10);
        _openMinting();

        // the entrant now buys at the fleet's multiplier and gains nothing by redeeming
        vm.prank(user1);
        litePsm.mintOkuM(ENTRANT_USDC);
        uint256 entrantOkuM = okuMoney.balanceOf(user1);
        _approveOkuMoney(user1, address(litePsm), entrantOkuM);
        vm.prank(user1);
        uint256 out = litePsm.redeemOkuM(entrantOkuM);
        assertLe(out, ENTRANT_USDC, "no gain over the deposit");
    }
}
