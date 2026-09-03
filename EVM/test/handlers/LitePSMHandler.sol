// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";
// The concrete `OkuDollar` import is no longer needed: the yield rate is driven on
// OkuMoney under the single-multiplier design, so `IOkuDollar` suffices here.
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title LitePSMHandler
 * @notice Stateful handler for LitePSM invariants. Exercises the full public surface
 *         (mintOkuM, redeemOkuM, mintUsdOku, redeemUsdOku, depositBuffer,
 *         withdrawUsdc, processQueue, rescueQueueEntry) and tracks
 *         exact USDC flow + multiplier-observation ghost state.
 * @dev The PSM is granted the admin role at the test level; this handler invokes
 *      role-gated functions via `vm.prank(bridgeAdmin)` (where bridgeAdmin is the
 *      shared admin address from BaseTest). LitePSMHandler is constructed with
 *      `admin` (the BaseTest admin) so it can invoke admin-only functions.
 */
contract LitePSMHandler is Test {
    LitePSM public psm;
    IOkuMoney public okuMoney;
    IOkuDollar public okuDollar;
    IERC20 public usdc;
    RedemptionQueue public queue;
    address public rebaser;
    address public minter;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_FUZZ_PRICE = TestConstants.MAX_FUZZ_PRICE;
    uint256 public constant DECIMAL_MULTIPLIER = TestConstants.DECIMAL_MULTIPLIER;
    uint256 public constant MAX_RATE = TestConstants.MAX_RATE;

    // ============ USDC flow ghost state ============
    uint256 public ghostUsdcDeposited;
    uint256 public ghostUsdcWithdrawn;

    // ============ Other ghost counters ============
    uint256 public ghostOkuMMinted;
    uint256 public ghostOkuMBurned;
    uint256 public ghostUsdOkuMinted;
    uint256 public ghostOkuDollarBurned;
    uint256 public ghostQueuedCount;
    uint256 public ghostProcessedCount;
    uint256 public ghostRescuedCount;

    // Per-handler success counters (for HandlerSanity)
    uint256 public ghostMintOkuMCalls;
    uint256 public ghostMintOkuMReverts;
    uint256 public ghostRedeemOkuMCalls;
    uint256 public ghostRedeemOkuMReverts;
    uint256 public ghostMintOkuDollarCalls;
    uint256 public ghostMintOkuDollarReverts;
    uint256 public ghostRedeemOkuDollarCalls;
    uint256 public ghostRedeemOkuDollarReverts;
    uint256 public ghostRebaseCalls;
    uint256 public ghostDepositBufferCalls;
    uint256 public ghostDepositBufferReverts;
    uint256 public ghostWithdrawUsdcCalls;
    uint256 public ghostWithdrawUsdcReverts;
    uint256 public ghostProcessQueueCalls;
    uint256 public ghostProcessQueueReverts;
    uint256 public ghostRescueCalls;
    uint256 public ghostRescueReverts;

    // ============ Multiplier observation ============

    /// @notice Greatest okuMMultiplier observed at the end of any handler run.
    /// @dev Updated by PSMInvariants.afterInvariant() so observations happen even when
    ///      a handler call reverts. Used to assert "multiplier never decreases".
    uint256 public ghostLastSeenMultiplier;

    constructor(
        LitePSM _psm,
        IOkuMoney _okuMoney,
        IOkuDollar _okuDollar,
        IERC20 _usdc,
        RedemptionQueue _queue,
        address _rebaser,
        address _minter
    ) {
        psm = _psm;
        okuMoney = _okuMoney;
        okuDollar = _okuDollar;
        usdc = _usdc;
        queue = _queue;
        rebaser = _rebaser;
        minter = _minter;

        _addActor(makeAddr("psmActor1"));
        _addActor(makeAddr("psmActor2"));
        _addActor(makeAddr("psmActor3"));

        ghostLastSeenMultiplier = okuMoney.okuMMultiplier();
    }

    function _addActor(address actor) internal {
        if (!isActor[actor]) {
            actors.push(actor);
            isActor[actor] = true;
        }
    }

    function bound(uint256 x, uint256 min, uint256 max) internal pure override returns (uint256) {
        return _bound(x, min, max);
    }

    /// @notice Called from invariant suite's `afterInvariant` to observe the multiplier
    ///         after every fuzz run regardless of whether the handler call reverted.
    function recordMultiplierObservation() external {
        uint256 cur = okuMoney.okuMMultiplier();
        if (cur > ghostLastSeenMultiplier) ghostLastSeenMultiplier = cur;
    }

    // ============ Handler Functions ============

    function mintOkuM(uint256 actorSeed, uint256 usdcAmount) external {
        ghostMintOkuMCalls++;
        address actor = actors[actorSeed % actors.length];
        usdcAmount = bound(usdcAmount, 1e6, 100_000e6);

        if (usdc.balanceOf(actor) < usdcAmount) deal(address(usdc), actor, usdcAmount);
        vm.prank(actor);
        usdc.approve(address(psm), usdcAmount);

        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 expectedOkuM =
            Math.mulDiv(usdcAmount * DECIMAL_MULTIPLIER, PRECISION, okuMMult, Math.Rounding.Floor);

        vm.prank(actor);
        try psm.mintOkuM(usdcAmount) {
            ghostUsdcDeposited += usdcAmount;
            ghostOkuMMinted += expectedOkuM;
        } catch {
            ghostMintOkuMReverts++;
        }
    }

    function redeemOkuM(uint256 actorSeed, uint256 okuMAmount) external {
        ghostRedeemOkuMCalls++;
        address actor = actors[actorSeed % actors.length];

        uint256 actorBalance = okuMoney.balanceOf(actor);
        if (actorBalance == 0) return;
        okuMAmount = bound(okuMAmount, 1e18, actorBalance);

        vm.prank(actor);
        IERC20(address(okuMoney)).approve(address(psm), okuMAmount);

        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 expectedUsdc =
            Math.mulDiv(okuMAmount, okuMMult, PRECISION, Math.Rounding.Floor) / DECIMAL_MULTIPLIER;
        uint256 psmUsdcBalance = usdc.balanceOf(address(psm));

        vm.prank(actor);
        try psm.redeemOkuM(okuMAmount) {
            if (psmUsdcBalance >= expectedUsdc) {
                ghostUsdcWithdrawn += expectedUsdc;
                ghostOkuMBurned += okuMAmount;
            } else {
                ghostQueuedCount++;
            }
        } catch {
            ghostRedeemOkuMReverts++;
        }
    }

    function mintUsdOku(uint256 actorSeed, uint256 usdcAmount) external {
        ghostMintOkuDollarCalls++;
        address actor = actors[actorSeed % actors.length];
        usdcAmount = bound(usdcAmount, 1e6, 100_000e6);

        if (usdc.balanceOf(actor) < usdcAmount) deal(address(usdc), actor, usdcAmount);
        vm.prank(actor);
        usdc.approve(address(psm), usdcAmount);

        vm.prank(actor);
        try psm.mintUsdOku(usdcAmount) {
            ghostUsdcDeposited += usdcAmount;
            ghostUsdOkuMinted += usdcAmount * DECIMAL_MULTIPLIER;
        } catch {
            ghostMintOkuDollarReverts++;
        }
    }

    function redeemUsdOku(uint256 actorSeed, uint256 usdAmount) external {
        ghostRedeemOkuDollarCalls++;
        address actor = actors[actorSeed % actors.length];

        uint256 actorBalance = okuDollar.balanceOf(actor);
        if (actorBalance == 0) return;
        usdAmount = bound(usdAmount, 1e18, actorBalance);

        vm.prank(actor);
        IERC20(address(okuDollar)).approve(address(psm), usdAmount);

        // Compare PSM USDC balance pre/post to update ghostUsdcWithdrawn on the
        // instant-redemption path; if balance unchanged the redemption was queued.
        uint256 psmUsdcBefore = usdc.balanceOf(address(psm));

        vm.prank(actor);
        try psm.redeemUsdOku(usdAmount) {
            ghostOkuDollarBurned += usdAmount;
            uint256 psmUsdcAfter = usdc.balanceOf(address(psm));
            if (psmUsdcAfter < psmUsdcBefore) {
                ghostUsdcWithdrawn += (psmUsdcBefore - psmUsdcAfter);
            } else {
                ghostQueuedCount++;
            }
        } catch {
            ghostRedeemOkuDollarReverts++;
        }
    }

    /// @notice Trigger a multiplier change. Allowed range raised to allow occasional
    ///         large jumps so PSM truncation/dust branches surface in invariant runs.
    function rebase(uint256 priceIncrease, bool largeJump) external {
        ghostRebaseCalls++;
        uint256 currentPrice = okuMoney.okuMMultiplier();
        if (currentPrice >= MAX_FUZZ_PRICE) return;

        uint256 maxIncrease = largeJump ? currentPrice / 2 : currentPrice / 50; // 50% or 2%
        uint256 minIncrease = currentPrice / 10_000;
        uint256 increase = bound(priceIncrease, minIncrease, maxIncrease);

        uint256 newPrice = currentPrice + increase;
        if (newPrice > MAX_FUZZ_PRICE) newPrice = MAX_FUZZ_PRICE;

        vm.prank(rebaser);
        try okuMoney.setOkuMMultiplier(newPrice) {
            vm.roll(block.number + 1);
        } catch {}
    }

    // ============ Admin / Operator surface (newly added) ============

    function depositBuffer(uint256 amount) external {
        ghostDepositBufferCalls++;
        amount = bound(amount, 1e6, 1_000_000e6);

        // bufferDepositor is admin in BaseTest's role grants, but the handler doesn't
        // have a direct reference. Use deal() to give the PSM the depositor role
        // ergonomically: mint USDC straight to address(this) and approve/deposit.
        deal(address(usdc), address(this), amount);
        usdc.approve(address(psm), amount);

        // The handler itself needs PSM_BUFFER_DEPOSITOR. Grant via the test grants
        // BUFFER_DEPOSITOR to `bufferDepositor` (an actor address). We can use that
        // address by impersonation-style: deal+approve from bufferDepositor.
        // Simpler: grant the role to handler in setUp via the BaseTest admin? We
        // don't have admin access here. The cleanest fix: have PSMInvariants's
        // setUp pre-grant PSM_BUFFER_DEPOSITOR to address(this).
        try psm.depositBuffer(amount) {
            ghostUsdcDeposited += amount;
        } catch {
            ghostDepositBufferReverts++;
        }
    }

    function withdrawUsdc(uint256 actorSeed, uint256 amount) external {
        ghostWithdrawUsdcCalls++;
        address recipient = actors[actorSeed % actors.length];

        uint256 psmBalance = usdc.balanceOf(address(psm));
        uint256 obligation = queue.totalQueuedUsdc();
        if (psmBalance <= obligation) {
            ghostWithdrawUsdcReverts++;
            return;
        }
        uint256 maxWithdraw = psmBalance - obligation;
        amount = bound(amount, 1, maxWithdraw);

        // Same role-grant note as depositBuffer: handler must hold PSM_BUFFER_WITHDRAWER.
        try psm.withdrawUsdc(recipient, amount) {
            ghostUsdcWithdrawn += amount;
        } catch {
            ghostWithdrawUsdcReverts++;
        }
    }

    function processQueue(uint256 maxApprove) external {
        ghostProcessQueueCalls++;

        uint256 head = queue.queueHead();
        uint256 tail = queue.queueTail();
        if (head >= tail) return;

        // Process at most 5 entries per call.
        uint256 endIdx = head + 5 < tail ? head + 5 : tail;
        maxApprove = bound(maxApprove, 0, usdc.balanceOf(address(psm)));

        try psm.processQueue(head, endIdx, maxApprove) {
            ghostProcessedCount++;
        } catch {
            ghostProcessQueueReverts++;
        }
    }

    function rescueQueueEntry(uint256 indexSeed, uint256 actorSeed) external {
        ghostRescueCalls++;

        uint256 head = queue.queueHead();
        uint256 tail = queue.queueTail();
        if (head >= tail) return;

        uint256 idx = head + (indexSeed % (tail - head));
        address recipient = actors[actorSeed % actors.length];

        try psm.redemptionQueue().rescueQueueEntry(idx, recipient) {
            ghostRescuedCount++;
        } catch {
            ghostRescueReverts++;
        }
    }

    // ============ Yield Rate (drives multiplier compounding) ============

    uint256 public ghostSetUsdYieldRateCalls;
    uint256 public ghostSetUsdYieldRateReverts;

    /// @notice Drive `okuMRatePerSecond` so that subsequent `warpTime` calls compound
    ///         the (single) multiplier above PRECISION.
    /// @dev SINGLE MULTIPLIER: `okuDollar.usdMultiplier()` is exactly
    ///      `okuMoney.okuMMultiplier()`, so the rate is set on OkuMoney via
    ///      OKUM_REBASER. Retains the historical handler name so the fuzz selector
    ///      set is unchanged.
    function setUsdYieldRate(uint256 rate) external {
        ghostSetUsdYieldRateCalls++;
        rate = bound(rate, PRECISION, MAX_RATE);
        // A halted rate (== PRECISION) requires endTimestamp == 0; any yielding
        // rate requires a bounded future window.
        uint256 endTimestamp = rate == PRECISION ? 0 : block.timestamp + 365 days;
        vm.prank(rebaser);
        try okuMoney.setOkuMYieldRate(rate, endTimestamp) {}
        catch {
            ghostSetUsdYieldRateReverts++;
        }
    }

    // ============ Time Progression ============
    //
    // Required so that any active `okuMRatePerSecond` actually compounds
    // the multiplier during invariant runs. Without this, the multiplier stays
    // pinned at PRECISION and rounding-asymmetry bugs in PSM redeem paths
    // (historical: `_redeemUsdOku` InsufficientBalance) cannot be caught.

    uint256 public ghostWarpCalls;
    uint256 public ghostTotalElapsed;

    function warpTime(uint256 elapsed) external {
        ghostWarpCalls++;
        elapsed = bound(elapsed, 1, 30 days);
        ghostTotalElapsed += elapsed;
        vm.warp(block.timestamp + elapsed);
        vm.roll(block.number + 1);
    }

    // ============ View helpers ============

    function getActors() external view returns (address[] memory) {
        return actors;
    }

    function getActorCount() external view returns (uint256) {
        return actors.length;
    }

    function ghostTotalCalls() external view returns (uint256) {
        return ghostMintOkuMCalls + ghostRedeemOkuMCalls + ghostMintOkuDollarCalls
            + ghostRedeemOkuDollarCalls + ghostRebaseCalls + ghostDepositBufferCalls
            + ghostWithdrawUsdcCalls + ghostProcessQueueCalls + ghostRescueCalls + ghostWarpCalls;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMReverts + ghostRedeemOkuMReverts + ghostMintOkuDollarReverts
            + ghostRedeemOkuDollarReverts + ghostDepositBufferReverts + ghostWithdrawUsdcReverts
            + ghostProcessQueueReverts + ghostRescueReverts;
    }
}
