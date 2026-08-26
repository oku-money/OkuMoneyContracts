// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {Constants} from "../../src/lib/Constants.sol";
import {SubscriptionModule} from "../../src/psm/SubscriptionModule.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {USDOku} from "../../src/token/USDOku.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title SystemHandler
 * @notice Stateful-fuzz driver over the whole five-contract system.
 *
 * @dev ADVERSARIAL BY DESIGN. In particular it includes `donateToken`,
 *      `donateTokenToPsm`, `donateTokenToWrapper` and `donateUsdc`, which
 *      transfer tokens to the module, queue and wrapper for free. Any invariant
 *      stated as an equality on those contracts' balances is permanently
 *      breakable this way, which is exactly why the backing invariants are
 *      stated as bounds. An earlier draft asserted
 *      `queue.totalQueuedRaw == balanceOf(queue)` and
 *      `balanceOf(module) <= 1 wei`; both would fail here within a few runs.
 *
 *      `donateTokenToWrapper` is not merely adversarial, though — donating OkuM
 *      to the wrapper IS the mechanism by which the solvency gap gets funded, so
 *      the action doubles as coverage of the intended remediation path.
 */
contract SystemHandler is CommonBase, StdCheats, StdUtils {
    OkuM internal immutable token;
    USDOku internal immutable usdOku;
    USDOkuWrapper internal immutable wrapper;
    SubscriptionModule internal immutable module;
    RedemptionQueue internal immutable queue;
    MockUSDC internal immutable usdc;

    address internal immutable rateSetter;
    address internal immutable guardian;
    address internal immutable bufferDepositor;
    address internal immutable queueProcessor;
    address internal immutable minter;
    address internal immutable capManager;
    address internal immutable wrapperReserveManager;
    address internal immutable treasury;

    address[4] internal actors;

    // ---- Ghost variables ----

    /// @notice Cumulative USDC deposited into the module from every source.
    uint256 public ghostUsdcIn;
    /// @notice Cumulative USDC paid out of the module to users.
    uint256 public ghostUsdcOut;
    /// @notice Highest `M_oku` ever observed, for the monotonicity invariant.
    uint256 public ghostMaxMultiplier;
    /// @notice Highest `M_usd` ever observed, for the monotonicity invariant.
    uint256 public ghostMaxUsdIndex;
    /// @notice Raw tokens donated (not minted) to the queue.
    uint256 public ghostQueueDonations;
    /// @notice True once `resetStepHighWaterMark` has fired, after which the
    ///         `tin + tout >= stepHighWaterMark` coupling no longer holds for
    ///         steps taken before the reset.
    bool public ghostStepFloorReset;
    /// @notice Largest declared liability the wrapper has ever carried.
    /// @dev The scale the absolute solvency shortfall is bounded against. A
    ///      HIGH-WATER MARK rather than the live figure, deliberately: exits
    ///      shrink liability while preserving the shortfall, so a live-figure
    ///      bound would tighten under the very operation that cannot widen the
    ///      shortfall. See
    ///      `SystemInvariants.invariant_ShortfallBoundedByPeakLiability`.
    uint256 public ghostPeakLiability;

    uint256 public calls;
    uint256 public successes;

    /// @dev Deployed contracts, grouped. Twelve flat constructor arguments blew
    ///      the legacy codegen's stack ("Stack too deep") once the two-token
    ///      refactor added three more; grouping into two structs is a cheaper
    ///      fix than turning on `viaIR` for the whole project.
    struct Deployment {
        OkuM token;
        USDOku usdOku;
        USDOkuWrapper wrapper;
        SubscriptionModule module;
        RedemptionQueue queue;
        MockUSDC usdc;
    }

    /// @dev The privileged actors the handler pranks as.
    struct Operators {
        address rateSetter;
        address guardian;
        address bufferDepositor;
        address queueProcessor;
        address minter;
        address capManager;
        address wrapperReserveManager;
        address treasury;
    }

    constructor(Deployment memory d, Operators memory o, address[4] memory _actors) {
        token = d.token;
        usdOku = d.usdOku;
        wrapper = d.wrapper;
        module = d.module;
        queue = d.queue;
        usdc = d.usdc;
        rateSetter = o.rateSetter;
        guardian = o.guardian;
        bufferDepositor = o.bufferDepositor;
        queueProcessor = o.queueProcessor;
        minter = o.minter;
        capManager = o.capManager;
        wrapperReserveManager = o.wrapperReserveManager;
        treasury = o.treasury;
        actors = _actors;
        ghostMaxMultiplier = d.token.uiMultiplier();
        ghostMaxUsdIndex = d.usdOku.usdOkuIndex();

        // Seed the inflow ghost with whatever the module already holds. Without
        // this the solvency invariant would trip the first time an accrued
        // redemption paid out more than the redeemer originally deposited —
        // which is correct protocol behaviour (the yield comes from the
        // pre-seeded buffer), not a violation.
        ghostUsdcIn = d.usdc.balanceOf(address(d.module));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Open every action: count it, and advance the clock a little.
    ///
    /// Real chains advance `block.timestamp` every block. This harness
    /// previously only moved time through its explicit `warp` action, which made
    /// short-lived time-based state — notably the sync window — behave nothing
    /// like production: a window armed by a step would stay engaged for a dozen
    /// unrelated actions instead of expiring in a few blocks.
    ///
    /// A ~12s bump per action models block progression, keeps the fuzzer from
    /// wedging itself shut behind its own guards, and makes every time-based
    /// invariant a fairer test. `warp` still exists for the long jumps that
    /// exercise `M_usd` accrual over days.
    function _beginCall() internal {
        calls++;
        vm.warp(block.timestamp + 12);
    }

    function _observe() internal {
        uint256 m = token.uiMultiplier();
        if (m > ghostMaxMultiplier) ghostMaxMultiplier = m;
        uint256 i = usdOku.usdOkuIndex();
        if (i > ghostMaxUsdIndex) ghostMaxUsdIndex = i;
        uint256 l = usdOku.totalSupply();
        if (l > ghostPeakLiability) ghostPeakLiability = l;
    }

    // ============ Module actions ============

    function psmMint(uint256 actorSeed, uint256 usdcAmount) external {
        _beginCall();
        address a = _actor(actorSeed);
        usdcAmount = _bound(usdcAmount, 1e6, 1_000_000e6);
        usdc.mint(a, usdcAmount);
        vm.startPrank(a);
        usdc.approve(address(module), usdcAmount);
        try module.mint(usdcAmount) {
            ghostUsdcIn += usdcAmount;
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function psmRedeem(uint256 actorSeed, uint256 rawAmount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        rawAmount = _bound(rawAmount, 1, bal);
        vm.startPrank(a);
        token.approve(address(module), rawAmount);
        uint256 usdcBefore = usdc.balanceOf(a);
        try module.redeem(rawAmount) {
            ghostUsdcOut += usdc.balanceOf(a) - usdcBefore;
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function psmRedeemUi(uint256 actorSeed, uint256 uiAmount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 balUi = token.balanceOfUI(a);
        if (balUi == 0) return;
        uiAmount = _bound(uiAmount, 1, balUi);
        vm.startPrank(a);
        token.approve(address(module), type(uint256).max);
        uint256 usdcBefore = usdc.balanceOf(a);
        try module.redeemUiAmount(uiAmount) {
            ghostUsdcOut += usdc.balanceOf(a) - usdcBefore;
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        _beginCall();
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.prank(from);
        try token.transfer(to, amount) {
            successes++;
        } catch {}
    }

    // ============ Wrapper actions ============

    function wrap(uint256 actorSeed, uint256 amount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.startPrank(a);
        token.approve(address(wrapper), amount);
        try wrapper.wrap(amount) {
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function unwrap(uint256 actorSeed, uint256 amount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 bal = usdOku.balanceOf(a);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.startPrank(a);
        usdOku.approve(address(wrapper), amount);
        try wrapper.unwrap(amount) {
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function transferUsdOku(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        _beginCall();
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 bal = usdOku.balanceOf(from);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.prank(from);
        try usdOku.transfer(to, amount) {
            successes++;
        } catch {}
    }

    // ============ M_oku authority ============

    /// @notice Take a legal step, setting covering fees first.
    ///
    /// @dev The step-coverage rule means a step is only possible when
    ///      `tin + tout >= stepBps`, so an action that stepped without
    ///      arranging coverage would revert `StepNotCovered` on essentially
    ///      every call — pure noise that depresses the success rate without ever
    ///      moving the multiplier. Arranging coverage here is what makes the
    ///      action exercise the *system* rather than the guard; the guard itself
    ///      is asserted deterministically in `StepArbitrageTest`.
    function stepMultiplier(uint256 stepSeed) external {
        _beginCall();
        uint256 stepBps = _bound(stepSeed, 1, Constants.MAX_STEP_BPS);

        uint256 half = (stepBps + 1) / 2;
        vm.prank(capManager);
        try module.setFees(half, stepBps > half ? stepBps - half : half) {} catch {}

        uint256 current = token.uiMultiplier();
        uint256 next = current + (current * stepBps) / Constants.BASIS_POINTS;
        if (next <= current) next = current + 1;

        vm.prank(rateSetter);
        try token.setOkuMultiplier(next) {
            successes++;
        } catch {}
        _observe();
    }

    function halt() external {
        _beginCall();
        vm.prank(guardian);
        try token.haltAccrual() {
            successes++;
        } catch {}
        _observe();
    }

    function resume() external {
        _beginCall();
        vm.prank(capManager);
        try token.resumeAccrual() {
            successes++;
        } catch {}
        _observe();
    }

    /// @notice The cold escape hatch under the step-coverage ratchet.
    /// @dev Sets the ghost flag so the `tin + tout >= stepHighWaterMark`
    ///      invariant knows the coupling was deliberately broken. This is the
    ///      only path by which that invariant may cease to hold, which is
    ///      exactly the property worth pinning.
    function resetStepFloor() external {
        _beginCall();
        vm.prank(capManager);
        try token.resetStepHighWaterMark() {
            ghostStepFloorReset = true;
            successes++;
        } catch {}
    }

    // ============ M_usd authority ============

    /// @notice Set a legal USDOku rate. Solvency rejections are expected and
    ///         are themselves the property under test elsewhere.
    function setUsdRate(uint256 rateSeed, uint256 durationSeed) external {
        _beginCall();
        // Stay inside the APR cap so most calls succeed.
        uint256 rate = _bound(rateSeed, Constants.PRECISION, Constants.PRECISION + 3_170_979_198);
        uint256 duration = _bound(durationSeed, 1, Constants.MAX_RATE_DURATION);
        vm.prank(rateSetter);
        try usdOku.setUsdOkuRate(rate, block.timestamp + duration) {
            successes++;
        } catch {}
        _observe();
    }

    function haltUsdOku() external {
        _beginCall();
        vm.prank(guardian);
        try usdOku.haltUsdOkuAccrual() {
            successes++;
        } catch {}
        _observe();
    }

    function warp(uint256 secondsSeed) external {
        _beginCall();
        vm.warp(block.timestamp + _bound(secondsSeed, 1, 10 days));
        successes++;
        _observe();
    }

    // ============ Buffer / queue ============

    function depositBuffer(uint256 amount) external {
        _beginCall();
        amount = _bound(amount, 1e6, 5_000_000e6);
        usdc.mint(bufferDepositor, amount);
        vm.startPrank(bufferDepositor);
        usdc.approve(address(module), amount);
        try module.depositBuffer(amount) {
            ghostUsdcIn += amount;
            successes++;
        } catch {}
        vm.stopPrank();
    }

    function processQueue(uint256 countSeed) external {
        _beginCall();
        uint256 head = queue.queueHead();
        uint256 tail = queue.queueTail();
        if (head >= tail) return;
        uint256 end = head + _bound(countSeed, 1, tail - head);
        uint256 owed = queue.totalQueuedUsdc();
        uint256 psmBefore = usdc.balanceOf(address(module));
        vm.prank(queueProcessor);
        try module.processQueue(head, end, owed) {
            uint256 psmAfter = usdc.balanceOf(address(module));
            if (psmBefore > psmAfter) ghostUsdcOut += psmBefore - psmAfter;
            successes++;
        } catch {}
    }

    function advanceHead(uint256 slots) external {
        _beginCall();
        queue.advanceHead(_bound(slots, 1, 10));
        successes++;
    }

    // ============ Fees and window ============

    /// @notice Explore the full legal fee range above the step floor.
    /// @dev Bounded below by `stepHighWaterMark` so the call effectively always
    ///      succeeds — the point is to make every *other* action run against a
    ///      fee-bearing configuration, not to probe the floor (which `FeesTest`
    ///      does deterministically).
    function setFees(uint256 tinSeed, uint256 toutSeed) external {
        _beginCall();
        uint256 floorBps = token.stepHighWaterMark();
        uint256 newTin = _bound(tinSeed, 0, Constants.MAX_FEE_BPS);
        uint256 minTout = floorBps > newTin ? floorBps - newTin : 0;
        if (minTout > Constants.MAX_FEE_BPS) return;
        uint256 newTout = _bound(toutSeed, minTout, Constants.MAX_FEE_BPS);
        vm.prank(capManager);
        try module.setFees(newTin, newTout) {
            successes++;
        } catch {}
    }

    /// @notice Enable a deliberately short window so the fuzzer explores the
    ///         gated paths without wedging itself closed.
    /// @dev The window gates `mint`, `redeem`, `redeemUiAmount`, `processQueue`,
    ///      `wrap` and `unwrap` — i.e. every action that moves value through the
    ///      multiplier. A long duration here would suppress the handler's
    ///      success rate and trip `invariant_HandlerIsActuallyExercisingTheSystem`
    ///      with what looks like a harness failure but is really the fuzzer
    ///      wedging itself shut. Keeping it a few seconds means `_beginCall`'s
    ///      12s bump reliably clears it. The real bound is asserted in
    ///      `SyncWindowTest`.
    function setSyncWindowDuration(uint256 durationSeed) external {
        _beginCall();
        uint256 duration = _bound(durationSeed, 0, 30);
        vm.prank(capManager);
        try token.setSyncWindowDuration(duration) {
            successes++;
        } catch {}
    }

    // ============ Adversarial actions ============

    /// @notice Free, unpreventable donation of tokens to the queue.
    /// @dev Present specifically to break any equality-shaped backing invariant.
    function donateToken(uint256 actorSeed, uint256 amount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.prank(a);
        try token.transfer(address(queue), amount) {
            ghostQueueDonations += amount;
            successes++;
        } catch {}
    }

    /// @notice Free donation of tokens to the module.
    function donateTokenToPsm(uint256 actorSeed, uint256 amount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.prank(a);
        try token.transfer(address(module), amount) {
            successes++;
        } catch {}
    }

    /// @notice Donation of OkuM to the wrapper.
    /// @dev Adversarial in shape, remedial in substance: this is precisely how
    ///      the solvency gap is funded, so it must not break any invariant — and
    ///      the wrapper backing bound has to tolerate it going UP unboundedly.
    function donateTokenToWrapper(uint256 actorSeed, uint256 amount) external {
        _beginCall();
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.prank(a);
        try token.transfer(address(wrapper), amount) {
            successes++;
        } catch {}
    }

    /// @notice Withdraw whatever surplus the wrapper currently reports.
    /// @dev The only path in the whole handler that can REDUCE backing —
    ///      without it, `invariant_ShortfallBoundedByPeakLiability` and
    ///      `invariant_WrapperBackingFloor` never see a withdrawal-shaped
    ///      state transition, only accrual-shaped ones. Bounded to whatever
    ///      `surplus()` reports right now, so it can never itself open a gap.
    /// @dev The `surplus() == 0` check runs BEFORE `_beginCall()`, deliberately
    ///      not counting toward `calls`. `surplus()` is zero unless a prior
    ///      donation left the wrapper over-backed, which is the uncommon case
    ///      throughout most of a campaign — counting every no-op call here
    ///      would depress `successes/calls` by a fixed amount unrelated to
    ///      whether the SYSTEM is being exercised, tripping
    ///      `invariant_HandlerIsActuallyExercisingTheSystem` on a harness
    ///      calibration issue rather than a protocol one. Every other
    ///      early-return action in this handler still counts its call because
    ///      its "nothing to do" case (e.g. an actor with a zero balance) is a
    ///      property of the fuzzer's random actor choice, not a near-permanent
    ///      background state — the distinction is what makes skipping the
    ///      counter here the right call and not a precedent to generalize.
    function withdrawWrapperSurplus() external {
        uint256 available = wrapper.surplus();
        if (available == 0) return;
        _beginCall();
        vm.prank(wrapperReserveManager);
        try wrapper.withdrawSurplus(treasury, available) {
            successes++;
        } catch {}
    }

    /// @notice Free donation of USDC to the module. Additive and benign, but it
    ///         must not be mistaken for tracked inflow.
    function donateUsdc(uint256 amount) external {
        _beginCall();
        amount = _bound(amount, 1, 1_000_000e6);
        usdc.mint(address(module), amount);
        ghostUsdcIn += amount;
        successes++;
    }
}
