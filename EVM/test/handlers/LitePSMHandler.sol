// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";
import {IOkuDollar} from "../../src/interfaces/IOkuDollar.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title LitePSMHandler
 * @notice Stateful handler for LitePSM invariants. Exercises the full public surface
 *         (mintOkuM, redeemOkuM, mintUsdOku, redeemUsdOku, depositBuffer,
 *         withdrawUsdc) and tracks exact USDC flow + multiplier-observation ghost state.
 * @dev Role-gated OkuMoney/PSM calls are made by pranking the role holders passed to
 *      the constructor; PSMInvariants grants this handler the PSM buffer roles directly.
 */
contract LitePSMHandler is Test {
    LitePSM public psm;
    IOkuMoney public okuMoney;
    IOkuDollar public okuDollar;
    IERC20 public usdc;
    address public rateManager;
    address public minter;
    address public blacklister;
    address public unblacklister;
    address public pauser;
    address public unpauser;

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

    // ============ Policy violations (must stay 0) ============
    /// USDC received by an OkuMoney-blacklisted actor through a redeem.
    uint256 public ghostBlacklistedPaid;
    /// USDC that left the PSM during a call made while the PSM was paused.
    uint256 public ghostOutflowWhilePaused;
    uint256 public ghostBlacklistCalls;

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
        address _rateManager,
        address _minter,
        address[4] memory _compliance // blacklister, unblacklister, pauser, unpauser
    ) {
        psm = _psm;
        okuMoney = _okuMoney;
        okuDollar = _okuDollar;
        usdc = _usdc;
        rateManager = _rateManager;
        minter = _minter;
        (blacklister, unblacklister, pauser, unpauser) =
        (_compliance[0], _compliance[1], _compliance[2], _compliance[3]);

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

    // ============ Policy snapshot helpers ============

    struct Snapshot {
        uint256 psmUsdc;
        bool psmPaused;
        uint256[] actorUsdc;
        bool[] actorBlacklisted;
    }

    function _snap() internal view returns (Snapshot memory sn) {
        sn.psmUsdc = usdc.balanceOf(address(psm));
        sn.psmPaused = psm.paused();
        sn.actorUsdc = new uint256[](actors.length);
        sn.actorBlacklisted = new bool[](actors.length);
        for (uint256 i = 0; i < actors.length; i++) {
            sn.actorUsdc[i] = usdc.balanceOf(actors[i]);
            sn.actorBlacklisted[i] = okuMoney.isBlacklisted(actors[i]);
        }
    }

    /// @dev Call after every action that is meant to pay out USDC.
    function _checkPolicy(Snapshot memory sn) internal {
        uint256 psmAfter = usdc.balanceOf(address(psm));
        if (sn.psmPaused && psmAfter < sn.psmUsdc) {
            ghostOutflowWhilePaused += sn.psmUsdc - psmAfter;
        }
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 got = usdc.balanceOf(actors[i]) - sn.actorUsdc[i];
            if (sn.actorBlacklisted[i] && got > 0) ghostBlacklistedPaid += got;
        }
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
        if (actorBalance < 1e18) return;
        okuMAmount = bound(okuMAmount, 1e18, actorBalance);

        vm.prank(actor);
        IERC20(address(okuMoney)).approve(address(psm), okuMAmount);

        uint256 psmUsdcBefore = usdc.balanceOf(address(psm));
        Snapshot memory sn = _snap();

        vm.prank(actor);
        // InsufficientBuffer (buffer drained by withdrawUsdc) is counted as a revert.
        try psm.redeemOkuM(okuMAmount) {
            _checkPolicy(sn);
            ghostUsdcWithdrawn += psmUsdcBefore - usdc.balanceOf(address(psm));
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
        if (actorBalance < 1e18) return;
        usdAmount = bound(usdAmount, 1e18, actorBalance);

        vm.prank(actor);
        IERC20(address(okuDollar)).approve(address(psm), usdAmount);

        uint256 psmUsdcBefore = usdc.balanceOf(address(psm));
        Snapshot memory sn = _snap();

        vm.prank(actor);
        try psm.redeemUsdOku(usdAmount) {
            _checkPolicy(sn);
            ghostOkuDollarBurned += usdAmount;
            ghostUsdcWithdrawn += psmUsdcBefore - usdc.balanceOf(address(psm));
        } catch {
            ghostRedeemOkuDollarReverts++;
        }
    }

    /// @notice Trigger a multiplier change. Occasional large jumps make PSM
    ///         truncation/dust branches surface in invariant runs.
    function rebase(uint256 priceIncrease, bool largeJump) external {
        ghostRebaseCalls++;
        uint256 currentPrice = okuMoney.okuMMultiplier();
        if (currentPrice >= MAX_FUZZ_PRICE) return;

        uint256 maxIncrease = largeJump ? currentPrice / 2 : currentPrice / 50; // 50% or 2%
        uint256 minIncrease = currentPrice / 10_000;
        uint256 increase = bound(priceIncrease, minIncrease, maxIncrease);

        uint256 newPrice = currentPrice + increase;
        if (newPrice > MAX_FUZZ_PRICE) newPrice = MAX_FUZZ_PRICE;

        vm.prank(rateManager);
        try okuMoney.setOkuMMultiplier(newPrice) {
            vm.roll(block.number + 1);
        } catch {}
    }

    // ============ Admin / Operator surface ============

    function depositBuffer(uint256 amount) external {
        ghostDepositBufferCalls++;
        amount = bound(amount, 1e6, 1_000_000e6);

        // PSMInvariants grants this handler PSM_BUFFER_DEPOSITOR / PSM_BUFFER_WITHDRAWER.
        deal(address(usdc), address(this), amount);
        usdc.approve(address(psm), amount);

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
        if (psmBalance == 0) return;
        amount = bound(amount, 1, psmBalance);

        try psm.withdrawUsdc(recipient, amount) {
            ghostUsdcWithdrawn += amount;
        } catch {
            ghostWithdrawUsdcReverts++;
        }
    }

    // ============ Compliance / pause ============

    function blacklistActor(uint256 actorSeed, bool on) external {
        ghostBlacklistCalls++;
        address actor = actors[actorSeed % actors.length];
        if (on) {
            vm.prank(blacklister);
            try OkuMoney(address(okuMoney)).blacklist(actor) {} catch {}
        } else {
            vm.prank(unblacklister);
            try OkuMoney(address(okuMoney)).unblacklist(actor) {} catch {}
        }
    }

    function togglePsmPause() external {
        if (psm.paused()) {
            vm.prank(unpauser);
            psm.unpause();
        } else {
            vm.prank(pauser);
            psm.pause();
        }
    }

    // ============ Yield Rate (drives multiplier compounding) ============

    uint256 public ghostSetUsdYieldRateCalls;
    uint256 public ghostSetUsdYieldRateReverts;

    /// @notice Drive `okuMRatePerSecond` so that subsequent `warpTime` calls compound
    ///         the (single) multiplier above PRECISION.
    /// @dev `okuDollar.usdMultiplier()` is exactly `okuMoney.okuMMultiplier()`, so the
    ///      rate is set on OkuMoney via OKUM_RATE_MANAGER.
    function setUsdYieldRate(uint256 rate) external {
        ghostSetUsdYieldRateCalls++;
        rate = bound(rate, PRECISION, MAX_RATE);
        // A halted rate (== PRECISION) requires endTimestamp == 0; any yielding
        // rate requires a bounded future window.
        uint256 endTimestamp = rate == PRECISION ? 0 : block.timestamp + 90 days; // == MAX_RATE_WINDOW
        vm.prank(rateManager);
        try okuMoney.setOkuMYieldRate(rate, endTimestamp) {}
        catch {
            ghostSetUsdYieldRateReverts++;
        }
    }

    // ============ Time Progression ============
    //
    // Required so that any active `okuMRatePerSecond` actually compounds the
    // multiplier; otherwise it stays at PRECISION and rounding asymmetries in the
    // PSM redeem paths cannot surface.

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
            + ghostWithdrawUsdcCalls + ghostWarpCalls;
    }

    function ghostTotalReverts() external view returns (uint256) {
        return ghostMintOkuMReverts + ghostRedeemOkuMReverts + ghostMintOkuDollarReverts
            + ghostRedeemOkuDollarReverts + ghostDepositBufferReverts + ghostWithdrawUsdcReverts;
    }
}
