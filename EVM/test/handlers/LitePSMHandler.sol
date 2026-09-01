// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title LitePSMHandler
 * @notice Stateful handler for LitePSM invariants. Exercises the full public surface
 *         (mintOkuM, redeemOkuM, mintUsdOku, redeemUsdOku, depositBuffer,
 *         withdrawUsdc) and tracks
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
    address public rebaser;
    address public minter;
    /// @notice Address holding VAULT_REBASER on the OkuDollar instance. Allowed to be
    ///         address(0); in that case `setUsdYieldRate` becomes a no-op handler.
    address public usdRebaser;

    address[] public actors;
    mapping(address => bool) public isActor;

    uint256 public constant PRECISION = TestConstants.PRECISION;
    uint256 public constant MAX_FUZZ_PRICE = TestConstants.MAX_FUZZ_PRICE;
    uint256 public constant DECIMAL_MULTIPLIER = TestConstants.DECIMAL_MULTIPLIER;
    uint256 public constant MAX_RATE = TestConstants.MAX_RATE;
    uint256 public constant BASIS_POINTS = TestConstants.BASIS_POINTS;
    uint256 public constant MIN_EPOCH_DURATION = TestConstants.MIN_EPOCH_DURATION;
    uint256 public constant MAX_EPOCH_DURATION = TestConstants.MAX_EPOCH_DURATION;
    uint256 public constant MAX_IMPLIED_APR_BPS = TestConstants.MAX_IMPLIED_APR_BPS;
    uint256 public constant SECONDS_PER_YEAR = TestConstants.SECONDS_PER_YEAR;

    // ============ USDC flow ghost state ============
    uint256 public ghostUsdcDeposited;
    uint256 public ghostUsdcWithdrawn;

    // ============ Other ghost counters ============
    uint256 public ghostOkuMMinted;
    uint256 public ghostOkuMBurned;
    uint256 public ghostUsdOkuMinted;
    uint256 public ghostOkuDollarBurned;

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
    uint256 public ghostRebaseReverts;
    uint256 public ghostScheduleCalls;
    uint256 public ghostScheduleReverts;
    uint256 public ghostHaltCalls;
    uint256 public ghostHaltReverts;
    uint256 public ghostDepositBufferCalls;
    uint256 public ghostDepositBufferReverts;
    uint256 public ghostWithdrawUsdcCalls;
    uint256 public ghostWithdrawUsdcReverts;

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
        address _rebaser,
        address _minter
    ) {
        psm = _psm;
        okuMoney = _okuMoney;
        okuDollar = _okuDollar;
        usdc = _usdc;
        rebaser = _rebaser;
        minter = _minter;
        // usdRebaser defaults to zero; PSMInvariants sets it via setUsdRebaser
        // after granting VAULT_REBASER so this handler can exercise the USD-yield
        // path. Zero means the `setUsdYieldRate` handler is a no-op.

        _addActor(makeAddr("psmActor1"));
        _addActor(makeAddr("psmActor2"));
        _addActor(makeAddr("psmActor3"));

        ghostLastSeenMultiplier = okuMoney.okuMMultiplier();
    }

    /// @notice Set the USD rebaser address. Used by PSMInvariants after it grants
    ///         VAULT_REBASER on OkuDollar so this handler can drive USD yield rates.
    function setUsdRebaser(address _usdRebaser) external {
        usdRebaser = _usdRebaser;
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
            // Buffer-only: a successful redemption always paid out.
            ghostUsdcWithdrawn += expectedUsdc;
            ghostOkuMBurned += okuMAmount;
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

        // Buffer-only: any successful redemption moved USDC out of the PSM.
        uint256 psmUsdcBefore = usdc.balanceOf(address(psm));

        vm.prank(actor);
        try psm.redeemUsdOku(usdAmount) {
            ghostOkuDollarBurned += usdAmount;
            ghostUsdcWithdrawn += (psmUsdcBefore - usdc.balanceOf(address(psm)));
        } catch {
            ghostRedeemOkuDollarReverts++;
        }
    }

    /// @notice Start a yield epoch and warp into or through it.
    /// @dev The multiplier can no longer be written directly. Amount and duration are
    ///      fuzzed across the full valid range and deliberately allowed to exceed the
    ///      APR cap, so roughly half the draws are rejected — the handler explores the
    ///      guard boundary rather than assuming where it sits.
    function rebase(uint256 yieldAmount, uint256 durationSeed, bool warpToEnd) external {
        ghostRebaseCalls++;
        if (okuMoney.totalSupply() == 0) return;
        if (okuMoney.okuMMultiplier() >= MAX_FUZZ_PRICE) return;

        uint256 duration = bound(durationSeed, MIN_EPOCH_DURATION, MAX_EPOCH_DURATION);
        uint256 ceiling = _maxYieldForDuration(duration);
        if (ceiling == 0) return;
        yieldAmount = bound(yieldAmount, 1, ceiling * 2);

        vm.prank(rebaser);
        try okuMoney.startYieldEpoch(yieldAmount, duration) {
            vm.warp(block.timestamp + (warpToEnd ? duration : duration / 2));
            vm.roll(block.number + 1);
        } catch {
            ghostRebaseReverts++;
        }
    }

    /// @notice Schedule a successor epoch, optionally cancelling it again.
    function scheduleEpoch(uint256 yieldAmount, uint256 durationSeed, bool cancel) external {
        ghostScheduleCalls++;
        if (okuMoney.totalSupply() == 0) return;

        uint256 duration = bound(durationSeed, MIN_EPOCH_DURATION, MAX_EPOCH_DURATION);
        uint256 ceiling = _maxYieldForDuration(duration);
        if (ceiling == 0) return;
        yieldAmount = bound(yieldAmount, 1, ceiling * 2);

        vm.prank(rebaser);
        try OkuMoney(address(okuMoney)).scheduleYieldEpoch(yieldAmount, duration) {
            if (cancel) {
                vm.prank(rebaser);
                try OkuMoney(address(okuMoney)).cancelPendingYieldEpoch() {} catch {}
            }
        } catch {
            ghostScheduleReverts++;
        }
    }

    /// @notice Halt accrual then immediately resume.
    /// @dev Paired deliberately: leaving the latch engaged would wedge every later
    ///      `rebase` call and silently collapse coverage of the accrual paths.
    function haltAndResumeAccrual() external {
        ghostHaltCalls++;
        vm.prank(rebaser);
        try OkuMoney(address(okuMoney)).haltAccrual() {
            vm.prank(rebaser);
            OkuMoney(address(okuMoney)).resumeAccrual();
        } catch {
            ghostHaltReverts++;
        }
    }

    /// @dev Largest yield distributable over `duration` without breaching the APR cap.
    function _maxYieldForDuration(uint256 duration) internal view returns (uint256) {
        uint256 current = okuMoney.okuMMultiplier();
        uint256 supply = okuMoney.totalSupply();
        if (supply == 0) return 0;
        uint256 maxDelta =
            (current * MAX_IMPLIED_APR_BPS * duration) / (BASIS_POINTS * SECONDS_PER_YEAR);
        return (maxDelta * supply) / PRECISION;
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
        if (psmBalance == 0) {
            ghostWithdrawUsdcReverts++;
            return;
        }
        amount = bound(amount, 1, psmBalance);

        // Same role-grant note as depositBuffer: handler must hold PSM_BUFFER_WITHDRAWER.
        try psm.withdrawUsdc(recipient, amount) {
            ghostUsdcWithdrawn += amount;
        } catch {
            ghostWithdrawUsdcReverts++;
        }
    }

    // ============ USD Yield Rate (drives usdMultiplier compounding) ============

    uint256 public ghostSetUsdYieldRateCalls;
    uint256 public ghostSetUsdYieldRateReverts;

    /// @notice Drive `usdRatePerSecond` so that subsequent `warpTime` calls compound
    ///         `usdMultiplier()` above PRECISION. No-op if PSMInvariants did not
    ///         configure a usdRebaser address.
    function setUsdYieldRate(uint256 rate) external {
        if (usdRebaser == address(0)) return;
        ghostSetUsdYieldRateCalls++;
        rate = bound(rate, PRECISION, MAX_RATE);
        vm.prank(usdRebaser);
        try OkuDollar(address(okuDollar)).setUsdYieldRate(rate, 0) {}
        catch {
            ghostSetUsdYieldRateReverts++;
        }
    }

    // ============ Time Progression ============
    //
    // Required so that any active `usdRatePerSecond` actually compounds
    // `usdMultiplier()` during invariant runs. Without this, the multiplier stays
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
            + ghostWithdrawUsdcCalls + ghostWarpCalls + ghostScheduleCalls + ghostHaltCalls;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMReverts + ghostRedeemOkuMReverts + ghostMintOkuDollarReverts
            + ghostRedeemOkuDollarReverts + ghostDepositBufferReverts + ghostWithdrawUsdcReverts
            + ghostRebaseReverts + ghostScheduleReverts + ghostHaltReverts;
    }
}
