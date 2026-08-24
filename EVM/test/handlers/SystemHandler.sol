// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {Constants} from "../../src/lib/Constants.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title SystemHandler
 * @notice Stateful-fuzz driver over the whole three-contract system.
 *
 * @dev ADVERSARIAL BY DESIGN. In particular it includes `donateToken` and
 *      `donateUsdc`, which transfer tokens to the PSM and queue for free.
 *      Any invariant stated as an equality on those contracts' balances is
 *      permanently breakable this way, which is exactly why the backing
 *      invariants are stated as bounds. An earlier draft of this refactor
 *      asserted `queue.totalQueuedRaw == balanceOf(queue)` and
 *      `balanceOf(litePsm) <= 1 wei`; both would fail here within a few runs.
 */
contract SystemHandler is CommonBase, StdCheats, StdUtils {
    OkuDollar internal immutable token;
    LitePSM internal immutable litePsm;
    RedemptionQueue internal immutable queue;
    MockUSDC internal immutable usdc;

    address internal immutable rateSetter;
    address internal immutable guardian;
    address internal immutable bufferDepositor;
    address internal immutable queueProcessor;
    address internal immutable minter;
    address internal immutable capManager;

    address[4] internal actors;

    // ---- Ghost variables ----

    /// @notice Cumulative USDC deposited into the PSM from every source.
    uint256 public ghostUsdcIn;
    /// @notice Cumulative USDC paid out of the PSM to users.
    uint256 public ghostUsdcOut;
    /// @notice Highest multiplier ever observed, for the monotonicity invariant.
    uint256 public ghostMaxMultiplier;
    /// @notice Raw tokens donated (not minted) to the queue.
    uint256 public ghostQueueDonations;

    uint256 public calls;
    uint256 public successes;

    constructor(
        OkuDollar _token,
        LitePSM _litePsm,
        RedemptionQueue _queue,
        MockUSDC _usdc,
        address _rateSetter,
        address _guardian,
        address _bufferDepositor,
        address _queueProcessor,
        address _minter,
        address _capManager,
        address[4] memory _actors
    ) {
        token = _token;
        litePsm = _litePsm;
        queue = _queue;
        usdc = _usdc;
        rateSetter = _rateSetter;
        guardian = _guardian;
        bufferDepositor = _bufferDepositor;
        queueProcessor = _queueProcessor;
        minter = _minter;
        capManager = _capManager;
        actors = _actors;
        ghostMaxMultiplier = _token.uiMultiplier();

        // Seed the inflow ghost with whatever the PSM already holds. Without this
        // the solvency invariant would trip the first time an accrued redemption
        // paid out more than the redeemer originally deposited — which is correct
        // protocol behaviour (the yield comes from the pre-seeded buffer), not a
        // violation.
        ghostUsdcIn = _usdc.balanceOf(address(_litePsm));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _observe() internal {
        uint256 m = token.uiMultiplier();
        if (m > ghostMaxMultiplier) ghostMaxMultiplier = m;
    }

    // ============ Actions ============

    function psmMint(uint256 actorSeed, uint256 usdcAmount) external {
        calls++;
        address a = _actor(actorSeed);
        usdcAmount = _bound(usdcAmount, 1e6, 1_000_000e6);
        usdc.mint(a, usdcAmount);
        vm.startPrank(a);
        usdc.approve(address(litePsm), usdcAmount);
        try litePsm.mint(usdcAmount) {
            ghostUsdcIn += usdcAmount;
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function psmRedeem(uint256 actorSeed, uint256 rawAmount) external {
        calls++;
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        rawAmount = _bound(rawAmount, 1, bal);
        vm.startPrank(a);
        token.approve(address(litePsm), rawAmount);
        uint256 usdcBefore = usdc.balanceOf(a);
        try litePsm.redeem(rawAmount) {
            ghostUsdcOut += usdc.balanceOf(a) - usdcBefore;
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function psmRedeemUi(uint256 actorSeed, uint256 uiAmount) external {
        calls++;
        address a = _actor(actorSeed);
        uint256 balUi = token.balanceOfUI(a);
        if (balUi == 0) return;
        uiAmount = _bound(uiAmount, 1, balUi);
        vm.startPrank(a);
        token.approve(address(litePsm), type(uint256).max);
        uint256 usdcBefore = usdc.balanceOf(a);
        try litePsm.redeemUiAmount(uiAmount) {
            ghostUsdcOut += usdc.balanceOf(a) - usdcBefore;
            successes++;
        } catch {}
        vm.stopPrank();
        _observe();
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        calls++;
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

    function setRate(uint256 rateSeed, uint256 durationSeed) external {
        calls++;
        // Stay inside the APR cap so most calls succeed.
        uint256 rate = _bound(rateSeed, Constants.PRECISION, Constants.PRECISION + 3_170_979_198);
        uint256 duration = _bound(durationSeed, 1, Constants.MAX_RATE_DURATION);
        vm.prank(rateSetter);
        try token.setYieldRate(rate, block.timestamp + duration) {
            successes++;
        } catch {}
        _observe();
    }

    function halt() external {
        calls++;
        vm.prank(guardian);
        try token.haltAccrual() {
            successes++;
        } catch {}
        _observe();
    }

    function warp(uint256 secondsSeed) external {
        calls++;
        vm.warp(block.timestamp + _bound(secondsSeed, 1, 10 days));
        successes++;
        _observe();
    }

    function depositBuffer(uint256 amount) external {
        calls++;
        amount = _bound(amount, 1e6, 5_000_000e6);
        usdc.mint(bufferDepositor, amount);
        vm.startPrank(bufferDepositor);
        usdc.approve(address(litePsm), amount);
        try litePsm.depositBuffer(amount) {
            ghostUsdcIn += amount;
            successes++;
        } catch {}
        vm.stopPrank();
    }

    function processQueue(uint256 countSeed) external {
        calls++;
        uint256 head = queue.queueHead();
        uint256 tail = queue.queueTail();
        if (head >= tail) return;
        uint256 end = head + _bound(countSeed, 1, tail - head);
        uint256 owed = queue.totalQueuedUsdc();
        uint256 psmBefore = usdc.balanceOf(address(litePsm));
        vm.prank(queueProcessor);
        try litePsm.processQueue(head, end, owed) {
            uint256 psmAfter = usdc.balanceOf(address(litePsm));
            if (psmBefore > psmAfter) ghostUsdcOut += psmBefore - psmAfter;
            successes++;
        } catch {}
    }

    function advanceHead(uint256 slots) external {
        calls++;
        queue.advanceHead(_bound(slots, 1, 10));
        successes++;
    }

    // ============ Cross-chain sync window ============
    //
    // Deliberately paired open/close actions with a SHORT duration.
    //
    // The window gates `mint`, `redeem`, `redeemUiAmount` and `processQueue` —
    // i.e. every action that moves USDC in or out. An open-only action, or a
    // long duration, would suppress the handler's success rate and trip
    // `invariant_HandlerIsActuallyExercisingTheSystem` (>30%) with what looks
    // like a harness failure but is really the fuzzer wedging itself shut.
    // Keeping the duration a few seconds means `warp` reliably clears it even
    // when `endSyncWindow` is never selected.

    /// @notice Explore the full legal fee range, including zero.
    /// @dev Bounded to `[0, MAX_FEE_BPS]` so the call itself effectively always
    ///      succeeds — the point is to make every *other* action run against a
    ///      fee-bearing configuration, not to probe the bound (which
    ///      `FeesTest` does deterministically).
    function setFees(uint256 tinSeed, uint256 toutSeed) external {
        calls++;
        uint256 newTin = _bound(tinSeed, 0, Constants.MAX_FEE_BPS);
        uint256 newTout = _bound(toutSeed, 0, Constants.MAX_FEE_BPS);
        vm.prank(capManager);
        try litePsm.setFees(newTin, newTout) {
            successes++;
        } catch {}
    }

    /// @notice Enable a deliberately short window so the fuzzer explores the
    ///         gated paths without wedging itself closed.
    function setSyncWindowDuration(uint256 durationSeed) external {
        calls++;
        uint256 duration = _bound(durationSeed, 0, 30);
        vm.prank(capManager);
        try token.setSyncWindowDuration(duration) {
            successes++;
        } catch {}
    }

    /// @dev Warps past the inter-window gap when necessary.
    ///
    ///      Without this the action would fail on `SyncWindowGapNotElapsed`
    ///      almost every call — the gap is 6h and the fuzzer selects this far
    ///      more often than that much simulated time passes. That is pure noise:
    ///      it depresses the handler success rate without ever exercising the
    ///      gated paths, which is the opposite of what the action is for. The
    ///      gap itself is asserted properly in `SyncWindowTest`, where it can be
    ///      driven deterministically.
    function beginSyncWindow() external {
        calls++;
        uint256 lockedUntil = token.syncLockedUntil();
        if (lockedUntil != 0) {
            uint256 earliest = lockedUntil + Constants.MIN_SYNC_WINDOW_GAP;
            if (block.timestamp < earliest) vm.warp(earliest);
        }
        vm.prank(rateSetter);
        try token.beginSyncWindow(token.syncEpoch() + 1) {
            successes++;
        } catch {}
        _observe();
    }

    function endSyncWindow() external {
        calls++;
        vm.prank(rateSetter);
        try token.endSyncWindow(token.syncEpoch()) {
            successes++;
        } catch {}
    }

    // ============ Adversarial actions ============

    /// @notice Free, unpreventable donation of tokens to the queue.
    /// @dev Present specifically to break any equality-shaped backing invariant.
    function donateToken(uint256 actorSeed, uint256 amount) external {
        calls++;
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

    /// @notice Free donation of tokens to the PSM.
    function donateTokenToPsm(uint256 actorSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = _bound(amount, 1, bal);
        vm.prank(a);
        try token.transfer(address(litePsm), amount) {
            successes++;
        } catch {}
    }

    /// @notice Free donation of USDC to the PSM. Additive and benign, but it must
    ///         not be mistaken for tracked inflow.
    function donateUsdc(uint256 amount) external {
        calls++;
        amount = _bound(amount, 1, 1_000_000e6);
        usdc.mint(address(litePsm), amount);
        ghostUsdcIn += amount;
        successes++;
    }
}
