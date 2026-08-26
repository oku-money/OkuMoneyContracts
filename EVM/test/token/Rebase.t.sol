// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {USDOku} from "../../src/token/USDOku.sol";

/**
 * @title RebaseTest
 * @notice USDOku's share ledger and its continuous declared index (`M_usd`).
 *
 * @dev THE CORE ASYMMETRY THIS SUITE PINS: USDOku's `balanceOf` is *derived*
 *      (`shares * M_usd / 1e18`) and moves with no transfer to observe, while
 *      `sharesOf` is the invariant quantity. Every property worth asserting on a
 *      rebasing token is a statement about shares; every property that looks
 *      like it is about balances is really about shares plus an index read at a
 *      particular instant.
 *
 *      `M_usd` accrues CONTINUOUSLY, unlike OkuM's stepwise `M_oku`. That is
 *      deliberate: smoothing is USDOku's entire purpose, and a smoothed rate
 *      arriving in jumps would be neither smooth nor forward-looking. The
 *      consequence tested here is that a rate write moves only the SLOPE — the
 *      value is continuous across it, so there is nothing to front-run and no
 *      sandwich guard is needed.
 */
contract RebaseTest is BaseTest {
    /// @dev A funded USDOku position, created the only way one can be: by
    ///      wrapping OkuM. There is no privileged mint path to shortcut with.
    function _fundUsdOku(address user, uint256 usdcAmount) internal returns (uint256 usdOkuOut) {
        _seedBuffer(usdcAmount * 2);
        uint256 raw = _psmMint(user, usdcAmount);
        return _wrap(user, raw);
    }

    // ============ Ledger identities ============

    function test_BalanceIsSharesTimesIndex() public {
        _fundUsdOku(user1, 1000e6);
        assertEq(
            usdOku.balanceOf(user1),
            MathLib.toUiAmount(usdOku.sharesOf(user1), usdOku.usdOkuIndex())
        );
    }

    function test_TotalSupplyIsTotalSharesTimesIndex() public {
        _fundUsdOku(user1, 1000e6);
        assertEq(
            usdOku.totalSupply(), MathLib.toUiAmount(usdOku.totalShares(), usdOku.usdOkuIndex())
        );
    }

    /// @notice At the genesis index one dollar of USDOku is one share, so the
    ///         two ledgers coincide — which is exactly why every test that cares
    ///         about the distinction must run at an elevated index.
    function test_AtGenesisIndexSharesEqualDollars() public {
        uint256 out = _fundUsdOku(user1, 1000e6);
        assertEq(usdOku.usdOkuIndex(), Constants.PRECISION);
        assertEq(usdOku.sharesOf(user1), out);
    }

    // ============ Rebase ============

    /// @notice The defining behaviour: the balance grows with no transaction.
    function test_BalanceGrowsWithNoTransfer() public {
        _fundUsdOku(user1, 1000e6);
        uint256 sharesBefore = usdOku.sharesOf(user1);
        uint256 balBefore = usdOku.balanceOf(user1);

        _accrueUsd(RATE_5_PCT_APY, 30 days);

        assertEq(usdOku.sharesOf(user1), sharesBefore, "shares are invariant");
        assertGt(usdOku.balanceOf(user1), balBefore, "the balance is not");
    }

    /// @notice Yield is distributed strictly pro-rata by share, which is the
    ///         whole point of a share ledger.
    function test_RebaseIsProRataAcrossHolders() public {
        _seedBuffer(10_000e6);
        uint256 raw1 = _psmMint(user1, 1000e6);
        uint256 raw2 = _psmMint(user2, 3000e6);
        _wrap(user1, raw1);
        _wrap(user2, raw2);

        _accrueUsd(RATE_5_PCT_APY, 30 days);

        // 1:3 in shares must remain 1:3 in balances, to rounding.
        assertApproxEqRel(usdOku.balanceOf(user2), usdOku.balanceOf(user1) * 3, 1e12);
    }

    // ============ Index continuity ============

    /// @notice A RATE WRITE MOVES THE SLOPE, NOT THE VALUE. Read at the same
    ///         instant either side of `setUsdOkuRate`, the index is identical.
    ///
    /// @dev This is the property that lets USDOku ship with no sandwich guard,
    ///      no announcement window and no forward pricing. There is no instant
    ///      at which a cached index becomes wrong, because the setter re-anchors
    ///      `baseIndex` to the live value before installing the new rate.
    function test_IndexIsContinuousAcrossRateWrites() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 10 days);

        uint256 before = usdOku.usdOkuIndex();
        uint256 balBefore = usdOku.balanceOf(user1);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_2_PCT_APY, block.timestamp + 10 days);

        assertEq(usdOku.usdOkuIndex(), before, "no step at the write");
        assertEq(usdOku.balanceOf(user1), balBefore, "and no balance discontinuity");
        assertEq(usdOku.baseIndex(), before, "re-anchored to the live value");
    }

    /// @notice Re-upping before `rateEnd` extends accrual seamlessly, which is
    ///         why no separate pending-rate staging field exists.
    function test_ReAnchoringExtendsWithoutGap() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 20 days);
        uint256 mid = usdOku.usdOkuIndex();

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 20 days);
        vm.warp(block.timestamp + 20 days);

        // 40 days of compounding at one rate, delivered as two segments.
        uint256 expected =
            MathLib.toUiAmount(mid, MathLib.rpow(RATE_5_PCT_APY, 20 days, Constants.PRECISION));
        assertApproxEqAbs(usdOku.usdOkuIndex(), expected, 1e6);
    }

    /// @notice ACCRUAL HALTS AT `rateEnd`, and that is a safety mechanism rather
    ///         than mere scheduling: a dead rate setter freezes yield instead of
    ///         accruing indefinitely against assets that are not there.
    function test_IndexHaltsFlatAtRateEnd() public {
        _fundUsdOku(user1, 1000e6);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 10 days);

        vm.warp(block.timestamp + 10 days);
        uint256 atEnd = usdOku.usdOkuIndex();

        vm.warp(block.timestamp + 3650 days);
        assertEq(usdOku.usdOkuIndex(), atEnd, "ten years of silence changes nothing");
    }

    // ============ Rate bounds ============

    function test_Rate_RejectsBelowPrecision() public {
        vm.prank(rateSetter);
        vm.expectRevert(USDOku.IndexCannotDecrease.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION - 1, block.timestamp + 1 days);
    }

    function test_Rate_RejectsAboveAprCap() public {
        // The nominal cap is 1000 bps under SIMPLE annualization, so the
        // per-second ceiling is the largest `excess` satisfying
        // `excess * SECONDS_PER_YEAR * 10_000 / 1e18 <= 1000`, which is
        // 3_174_150_177. One unit past it:
        uint256 tooHigh = Constants.PRECISION + 3_174_150_178;
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.RateAboveMaximum.selector);
        usdOku.setUsdOkuRate(tooHigh, block.timestamp + 1 days);
    }

    function test_Rate_RejectsNonFutureEnd() public {
        vm.prank(rateSetter);
        vm.expectRevert(USDOku.RateEndNotInFuture.selector);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp);

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.RateEndNotInFuture.selector);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, 0);
    }

    function test_Rate_RejectsOverlongDuration() public {
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.RateDurationTooLong.selector);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION + 1);
    }

    function test_Rate_AcceptsExactlyMaxDuration() public {
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        assertEq(usdOku.rateEnd(), block.timestamp + Constants.MAX_RATE_DURATION);
    }

    function test_Rate_RequiresRateSetter() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 1 days);
    }

    /// @notice Not pause-gated, deliberately: an operator may need to zero the
    ///         rate during an incident, and pausing the setter would defeat that.
    function test_Rate_WorksWhilePaused() public {
        vm.prank(pauser);
        usdOku.pause();
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp + 1 days);
        assertEq(usdOku.ratePerSecond(), Constants.PRECISION);
    }

    function test_ImpliedAprWithinCap() public {
        _accrueUsd(RATE_5_PCT_APY, 1 days);
        assertLe(usdOku.impliedAprBps(), Constants.MAX_IMPLIED_APR);
        assertGt(usdOku.impliedAprBps(), 0);
    }

    // ============ Guardian halt ============

    function test_Halt_FreezesTheIndexImmediately() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 10 days);
        uint256 frozen = usdOku.usdOkuIndex();

        vm.prank(guardian);
        usdOku.haltUsdOkuAccrual();

        vm.warp(block.timestamp + 365 days);
        assertEq(usdOku.usdOkuIndex(), frozen);
        assertEq(usdOku.ratePerSecond(), Constants.PRECISION);
        assertEq(usdOku.rateEnd(), usdOku.lastAccrualTime(), "reads as halted, nothing pending");
    }

    /// @notice Monotone-safe: a halt withholds growth, it never claws back.
    function test_Halt_CannotReduceAnAccruedBalance() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 10 days);
        uint256 balBefore = usdOku.balanceOf(user1);

        vm.prank(guardian);
        usdOku.haltUsdOkuAccrual();
        assertEq(usdOku.balanceOf(user1), balBefore);
    }

    function test_Halt_RequiresGuardian() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.haltUsdOkuAccrual();
    }

    // ============ Transfers move shares ============

    function test_Transfer_MovesSharesNotBalances() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 30 days);

        uint256 sharesBefore = usdOku.sharesOf(user1);
        uint256 totalSharesBefore = usdOku.totalShares();
        uint256 send = usdOku.balanceOf(user1) / 4;

        vm.prank(user1);
        usdOku.transfer(user2, send);

        assertEq(
            usdOku.sharesOf(user1) + usdOku.sharesOf(user2),
            sharesBefore,
            "shares are conserved exactly"
        );
        assertEq(usdOku.totalShares(), totalSharesBefore, "and total shares never move");
        assertApproxEqAbs(usdOku.balanceOf(user2), send, 1);
    }

    function test_TransferFrom_SpendsAllowanceInDollars() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 30 days);

        uint256 send = 100e18;
        vm.prank(user1);
        usdOku.approve(user3, send);

        vm.prank(user3);
        usdOku.transferFrom(user1, user2, send);

        assertEq(usdOku.allowance(user1, user3), 0, "allowance is dollar-denominated");
        assertApproxEqAbs(usdOku.balanceOf(user2), send, 1);
    }

    function test_Transfer_RevertsOnInsufficientShares() public {
        _fundUsdOku(user1, 100e6);
        // Read before pranking: an external call in an argument position
        // consumes both `vm.prank` and `vm.expectRevert`.
        uint256 tooMuch = usdOku.balanceOf(user1) * 2;
        vm.prank(user1);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        usdOku.transfer(user2, tooMuch);
    }

    function test_Transfer_BlockedWhilePaused() public {
        _fundUsdOku(user1, 100e6);
        vm.prank(pauser);
        usdOku.pause();
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        usdOku.transfer(user2, 1e18);
    }

    function test_Transfer_BlockedByBlacklist() public {
        _fundUsdOku(user1, 100e6);
        vm.prank(blacklister);
        usdOku.blacklist(user2);

        vm.prank(user1);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.transfer(user2, 1e18);

        vm.prank(blacklister);
        usdOku.blacklist(user1);
        vm.prank(user1);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.transfer(user3, 1e18);
    }

    /// @notice MAX-SEND, THE USDOKU FLAVOUR. Sending the full `balanceOf` floors
    ///         to at most the shares held, so it always succeeds and leaves at
    ///         most dust — it never reverts.
    ///
    /// @dev The hazard here is different from OkuM's. On OkuM the danger is
    ///      round-tripping through the display layer. Here it is that
    ///      `balanceOf` MOVES between the read and the transaction: a UI that
    ///      reads a balance, waits for a signature, and submits it is submitting
    ///      a stale number by construction. Computing from `sharesOf` is the only
    ///      correct approach, and the reason `sharesOf` is exposed at all.
    function test_MaxSend_FromBalanceNeverReverts() public {
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 30 days);

        uint256 bal = usdOku.balanceOf(user1);
        vm.prank(user1);
        usdOku.transfer(user2, bal);
        assertLe(usdOku.sharesOf(user1), 1, "at most one share of dust remains");
    }

    function testFuzz_MaxSend_AtArbitraryIndex(uint256 elapsed, uint256 amountSeed) public {
        elapsed = _bound(elapsed, 1, Constants.MAX_RATE_DURATION);
        _fundUsdOku(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, elapsed);

        uint256 bal = usdOku.balanceOf(user1);
        uint256 send = _bound(amountSeed, 1, bal);
        vm.prank(user1);
        usdOku.transfer(user2, send);
    }

    // ============ Supply hooks ============

    function test_Mint_RequiresMinterRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.mint(user1, 1e18);
    }

    function test_BurnShares_RequiresBurnerRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.burnShares(1);
    }

    /// @notice The wrapper is the only minter, so USDOku supply cannot exist
    ///         without matching OkuM having been escrowed. This is the
    ///         structural half of the solvency story.
    function test_OnlyWrapperHoldsSupplyHooks() public view {
        assertTrue(usdOku.hasRole(Roles.OKU_MINTER, address(wrapper)));
        assertTrue(usdOku.hasRole(Roles.OKU_BURNER, address(wrapper)));
        assertFalse(usdOku.hasRole(Roles.OKU_MINTER, address(module)));
        assertFalse(usdOku.hasRole(Roles.OKU_MINTER, rateSetter));
    }

    function test_Mint_RejectsDustBelowOneShare() public {
        _accrueUsd(RATE_5_PCT_APY, 30 days);
        vm.prank(admin); // admin holds OKU_MINTER from initialize
        vm.expectRevert(USDOku.AmountTooSmall.selector);
        usdOku.mint(user1, 0);
    }

    // ============ Interface ============

    /// @notice USDOku MUST NOT claim ERC-8056. Its `balanceOf` already returns
    ///         dollars, so a multiplier on top would be a second scaling factor
    ///         over an already-scaled balance and an aware wallet would apply it
    ///         twice.
    function test_NeverClaimsScaledUiAmount() public view {
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_CORE));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_PENDING));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_CONVERSION));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_BALANCES));
    }

    function test_Metadata() public view {
        assertEq(usdOku.name(), "USD Oku");
        assertEq(usdOku.symbol(), "USDOku");
        assertEq(usdOku.decimals(), 18);
    }

    // ============ Blacklist / pause admin ============

    function test_Blacklist_RoleSplitIsOneWayForWarmKey() public {
        vm.prank(blacklister);
        usdOku.blacklist(user1);
        vm.prank(blacklister);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.unblacklist(user1);

        vm.prank(unblacklister);
        usdOku.unblacklist(user1);
        assertFalse(usdOku.isBlacklisted(user1));
    }

    function test_Pause_RoleSplitIsOneWayForWarmKey() public {
        vm.prank(pauser);
        usdOku.pause();
        vm.prank(pauser);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.unpause();

        vm.prank(unpauser);
        usdOku.unpause();
        assertFalse(usdOku.paused());
    }
}
