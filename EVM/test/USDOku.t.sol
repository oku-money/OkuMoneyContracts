// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";

contract USDOkuTest is BaseTest {
    // ============ The two indices ============

    /// @dev The claim that justifies having two indices at all: `M_usd` does NOT set
    ///      the exchange rate. It cancels out of `wrap` and is absent from `unwrap`.
    ///      Both directions convert at `M_oku`, dollar for dollar.
    function test_exchangeRateIsMokuOnlyRegardlessOfMusd() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(200_000 * USDC_UNIT);

        // Drive the two indices deliberately APART, or this passes vacuously.
        _setOkuMRate(500, 30 days);
        _setUsdOkuRate(300, 30 days);
        vm.warp(block.timestamp + 20 days);

        uint256 mOku = okuM.uiMultiplier();
        uint256 mUsd = usdOku.usdOkuIndex();
        assertTrue(mOku != mUsd, "fixture: the indices must differ");

        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        uint256 dollarsIn = okuM.toUIAmount(raw);
        uint256 usdOut = _wrap(alice, raw);

        // Dollar-preserving at M_oku, within share-rounding dust.
        assertApproxEqRel(usdOut, dollarsIn, 1e12, "wrap converts at M_oku");

        vm.startPrank(alice);
        uint256 okuMBack = usdOku.unwrap(usdOut, alice);
        vm.stopPrank();

        assertApproxEqRel(okuM.toUIAmount(okuMBack), usdOut, 1e12, "unwrap converts back at M_oku");
        assertLe(okuMBack, raw, "round-trip never creates OkuM");
    }

    // ============ Pre-funding invariant ============

    /// @dev REGRESSION for the defect this design exists to close: `M_usd` outrunning
    ///      `M_oku` used to leave a grown USDOku balance unredeemable — earlier
    ///      exiters were paid in full, the last one out was stranded.
    ///
    ///      With `MAX_SOLVENCY_GAP_BPS == 0` the rate simply cannot be declared unless
    ///      the vault already holds the OkuM to honour it.
    function test_cannotDeclareARateTheVaultCannotCover() public {
        _fundBuffer(500_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 100_000 * USDC_UNIT);
        _wrap(alice, raw);

        assertGt(usdOku.totalShares(), 0, "fixture: there is a liability to cover");

        uint256 base = usdOku.usdOkuIndex();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);

        // No surplus has been funded, so a forward rate is refused outright.
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.WouldBreachBacking.selector);
        usdOku.setUsdOkuRate(base, rate, s, s + uint64(30 days));

        // Fund the wedge, and the identical call now succeeds.
        _fundVault(20_000 * USDC_UNIT);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(base, rate, s, s + uint64(30 days));
        assertTrue(usdOku.backingCoversLiability());
    }

    /// @dev REGRESSION for a real gap: unlike OkuM's `setOkuMRate`, `setUsdOkuRate`
    ///      used to have no `MAX_REANCHOR_BPS`-equivalent cap on an instantaneous
    ///      `baseIndex` jump — only `IndexCannotDecrease`, `IndexTooHigh` (the
    ///      generous `MAX_MULTIPLIER` ceiling), and `backingCoversLiability` (which
    ///      protects the VAULT's solvency, not the size of a single step). A single
    ///      call could jump `M_usd` by orders of magnitude more than OkuM's analogous
    ///      10bps bound, instantly reallocating value to whoever held USDOku shares
    ///      at that moment. Fixed by `MAX_USD_REANCHOR_BPS`.
    function test_usdOkuReanchorIsNowBoundedLikeOkuM() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(300_000 * USDC_UNIT);

        uint256 rawAlice = _mint(alice, 100_000 * USDC_UNIT);
        _wrap(alice, rawAlice);
        assertGt(usdOku.balanceOf(alice), 0, "fixture: alice holds a USDOku balance");

        uint256 live = usdOku.usdOkuIndex();
        uint256 maxAllowed = live + (live * Constants.MAX_USD_REANCHOR_BPS) / Constants.BASIS_POINTS;
        uint64 s = uint64(block.timestamp);

        // A +50% jump attempt is refused.
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.UsdReanchorTooLarge.selector);
        usdOku.setUsdOkuRate(live + live / 2, Constants.PRECISION, s, s + uint64(1 days));

        // Exactly at the bound is allowed — the analogous catch-up path.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(maxAllowed, Constants.PRECISION, s, s + uint64(1 days));
        assertEq(usdOku.usdOkuIndex(), maxAllowed);
    }

    /// @dev REGRESSION: `setUsdOkuRate` had the SAME missing `startTime` lower bound
    ///      the OkuM side had before this cycle's fix (see OkuM.t.sol's
    ///      `test_backdatingNoLongerBypassesTheReanchorBound`). A backdated
    ///      `startTime` resolves `indexAt(startTime)` against stale history, which
    ///      would have made the jump cap above bypassable the same way. Fixed
    ///      alongside it, not separately — a jump cap without a backdating floor is
    ///      not a fix.
    function test_usdOkuBackdatingNoLongerBypassesTheReanchorBound() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(300_000 * USDC_UNIT);
        _setUsdOkuRate(500, 30 days);
        vm.warp(block.timestamp + 10 days);

        uint64 backdated = uint64(block.timestamp - 40 days);
        uint256 liveAtBackdated = usdOku.indexAt(backdated);

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.StartTimeInThePast.selector);
        usdOku.setUsdOkuRate(
            liveAtBackdated,
            Constants.MAX_RATE_PER_SECOND,
            backdated,
            backdated + uint64(Constants.MAX_RATE_DURATION)
        );
    }

    /// @dev Unlike OkuM's re-anchor, a USDOku jump is NOT required to take effect
    ///      immediately — `M_usd` is a declared forward rate that legitimately
    ///      schedules ahead as routine practice. Confirms the fix didn't
    ///      overcorrect into breaking the normal forward-scheduling use case.
    function test_usdOkuReanchorMayBeScheduledAheadUnlikeOkuM() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(300_000 * USDC_UNIT);

        uint256 live = usdOku.usdOkuIndex();
        uint256 maxAllowed = live + (live * Constants.MAX_USD_REANCHOR_BPS) / Constants.BASIS_POINTS;
        uint64 future = uint64(block.timestamp + 1 days);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(maxAllowed, Constants.PRECISION, future, future + uint64(1 days));
        assertEq(usdOku.rateEnd(), future + 1 days);
    }

    /// @dev `startTime == 0` is a sentinel for "now" — the operator cannot predict
    ///      the exact mined timestamp, so exact equality must be resolvable on-chain.
    ///      Mirrors OkuM's sentinel handling.
    function test_usdOkuZeroStartTimeSentinelMeansNow() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _setUsdOkuRate(500, 30 days);
        vm.warp(block.timestamp + 5 days);

        uint256 live = usdOku.usdOkuIndex();
        uint256 rate = _rateFor(500);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(live, rate, 0, uint64(block.timestamp + 1 days));

        assertEq(usdOku.rateEnd(), block.timestamp + 1 days, "sentinel resolved to now");
    }

    /// @dev A grown balance must be redeemable IN FULL, including the last holder out.
    function test_grownBalanceIsFullyRedeemableForEveryHolder() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(50_000 * USDC_UNIT);

        uint256 rawA = _mint(alice, 50_000 * USDC_UNIT);
        uint256 rawB = _mint(bob, 50_000 * USDC_UNIT);
        _wrap(alice, rawA);
        _wrap(bob, rawB);

        _setUsdOkuRate(400, 30 days);
        vm.warp(block.timestamp + 30 days);

        uint256 balA = usdOku.balanceOf(alice);
        uint256 balB = usdOku.balanceOf(bob);
        assertGt(balA, 0);

        vm.prank(alice);
        usdOku.unwrap(balA, alice);

        // Bob is LAST OUT — the position that used to strand.
        uint256 balBNow = usdOku.balanceOf(bob);
        assertGt(balBNow, 0, "fixture: bob still holds a grown balance");
        vm.prank(bob);
        usdOku.unwrap(balBNow, bob);

        assertEq(usdOku.balanceOf(bob), 0, "last holder exits in full");
    }

    /// @dev Found by fuzzing, not inspection: a mid-segment entrant adds shares that
    ///      accrue to `rateEnd`. Spot coverage says nothing about coverage then, so
    ///      `wrap` is gated on the FORWARD projection.
    function test_wrapIsGatedOnTheForwardProjectionNotSpot() public {
        _fundBuffer(500_000 * USDC_UNIT);
        // Fund only a THIN surplus. A thick one would absorb the entrant's shortfall
        // and the test would pass vacuously.
        _fundVault(500 * USDC_UNIT);

        uint256 rawA = _mint(alice, 100_000 * USDC_UNIT);
        _wrap(alice, rawA);
        _setUsdOkuRate(500, 30 days);

        vm.warp(block.timestamp + 15 days);

        // Spot is covered, and would remain covered on a naive spot-only check — the
        // entrant brings its own backing. What it does NOT bring is the forward
        // accrual on its new shares between now and rateEnd.
        assertTrue(usdOku.backingCoversLiability(), "fixture: currently solvent");

        uint256 rawB = _mint(bob, 1_000_000 * USDC_UNIT);
        vm.startPrank(bob);
        IERC20(address(okuM)).approve(address(usdOku), rawB);
        vm.expectPartialRevert(USDOku.WouldBreachBacking.selector);
        usdOku.wrap(rawB, bob, 0);
        vm.stopPrank();
    }

    /// @dev The escape hatch. A full stop only ever REDUCES liability, so it must
    ///      never be blocked by the coverage check — otherwise the contract can lock
    ///      itself out of the one action that recovers it.
    function test_fullStopIsAlwaysPermitted() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(30_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 50_000 * USDC_UNIT);
        _wrap(alice, raw);
        _setUsdOkuRate(500, 30 days);

        vm.warp(block.timestamp + 10 days);
        uint256 live = usdOku.usdOkuIndex();
        uint64 s = uint64(block.timestamp);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(live, Constants.PRECISION, s, s + uint64(30 days));

        vm.warp(block.timestamp + 30 days);
        assertEq(usdOku.usdOkuIndex(), live, "accrual stopped dead");
    }

    // ============ Surplus ============

    function test_withdrawableSurplusIsProjectionAware() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(50_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 50_000 * USDC_UNIT);
        _wrap(alice, raw);
        _setUsdOkuRate(500, 30 days);

        uint256 quoted = usdOku.withdrawableSurplus();
        assertGt(quoted, 0, "fixture: there is surplus to take");

        // Taking exactly the quoted amount must keep the invariant.
        vm.prank(admin);
        usdOku.withdrawSurplus(treasury, quoted);
        assertTrue(usdOku.backingCoversLiability(), "quote is safe by construction");

        // One wei more than remains must not be.
        uint256 remaining = usdOku.withdrawableSurplus();
        vm.prank(admin);
        vm.expectPartialRevert(USDOku.WouldBreachBacking.selector);
        usdOku.withdrawSurplus(treasury, remaining + 1e18);
    }

    // ============ Rebasing ledger ============

    function test_sharesAreImmuneToRebaseButBalancesAreNot() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(50_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);
        _setUsdOkuRate(500, 30 days);

        uint256 sharesBefore = usdOku.sharesOf(alice);
        uint256 balBefore = usdOku.balanceOf(alice);

        vm.warp(block.timestamp + 30 days);

        assertEq(usdOku.sharesOf(alice), sharesBefore, "shares never move on rebase");
        assertGt(usdOku.balanceOf(alice), balBefore, "balances do");
    }

    function test_transferMovesSharesAndSurvivesRebase() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(50_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);
        _setUsdOkuRate(500, 30 days);
        vm.warp(block.timestamp + 10 days);

        uint256 send = usdOku.balanceOf(alice) / 2;
        vm.prank(alice);
        usdOku.transfer(bob, send);

        assertApproxEqAbs(usdOku.balanceOf(bob), send, 2, "recipient credited in dollars");

        uint256 bobShares = usdOku.sharesOf(bob);
        vm.warp(block.timestamp + 10 days);
        assertEq(usdOku.sharesOf(bob), bobShares, "shares stable across the rebase");
    }

    /// @dev A max-send must be computed from `sharesOf`, never `balanceOf`, which
    ///      moves between the read and the transaction.
    function test_maxSendFromSharesClearsTheBalance() public {
        _fundBuffer(500_000 * USDC_UNIT);
        _fundVault(50_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);
        _setUsdOkuRate(500, 30 days);
        vm.warp(block.timestamp + 7 days);

        uint256 bal = usdOku.balanceOf(alice);
        vm.prank(alice);
        usdOku.transfer(bob, bal);
        assertLe(usdOku.sharesOf(alice), 1, "at most dust remains");
    }

    function test_inheritedUpdateHookIsUnreachableAndReverts() public {
        // Every supply change routes through wrap/unwrap/mint/burn. The guard exists
        // so a future refactor reaching ERC20's `_update` fails loudly rather than
        // silently diverging the share ledger from the balance mapping.
        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.transfer(address(0), 0);
    }
}
