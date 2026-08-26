// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {SystemHandler} from "../handlers/SystemHandler.sol";

/**
 * @title SystemInvariantsTest
 * @notice Stateful-fuzz invariants over the whole system, driven by an
 *         adversarial handler that donates tokens to the module, the queue and
 *         the wrapper.
 *
 * @dev Every backing invariant here is stated as a BOUND, never an equality.
 *      Free token donations are unpreventable, so an equality would be a
 *      permanent, griefable failure rather than a property of the protocol.
 *
 *      The exception is the SHARE layer on USDOku: shares are only ever created
 *      by `mint` and destroyed by `burnShares`, and no donation path can move
 *      them, so `sum(sharesOf) == totalShares` is asserted as an exact equality
 *      — and should be. Losing that equality would mean the rebasing ledger had
 *      developed a leak.
 */
contract SystemInvariantsTest is BaseTest {
    SystemHandler internal handler;

    function setUp() public override {
        super.setUp();
        _seedBuffer(1_000_000e6);

        address[4] memory actors = [user1, user2, user3, user4];
        handler = new SystemHandler(
            SystemHandler.Deployment({
                token: token,
                usdOku: usdOku,
                wrapper: wrapper,
                module: module,
                queue: queue,
                usdc: usdc
            }),
            SystemHandler.Operators({
                rateSetter: rateSetter,
                guardian: guardian,
                bufferDepositor: bufferDepositor,
                queueProcessor: queueProcessor,
                minter: minter,
                capManager: capManager,
                wrapperReserveManager: wrapperReserveManager,
                treasury: treasury
            }),
            actors
        );

        // NOTE: the sync window is deliberately left at its DEPLOYED DEFAULT
        // here rather than being disabled for the harness. Because
        // `SystemHandler._beginCall` advances `block.timestamp` every action,
        // windows expire the way they would on a real chain and the fuzzer
        // explores the gated paths without wedging itself shut. The handler
        // still drives `setSyncWindowDuration` (0-30s) on top.

        // The handler drives privileged paths by pranking; it also needs to mint.
        vm.startPrank(admin);
        token.grantRole(keccak256("OKU_MINTER"), address(handler));
        token.configureMinterAllowance(address(handler), MINTER_ALLOWANCE);
        vm.stopPrank();

        targetContract(address(handler));
    }

    // ============ OkuM raw ledger ============

    /// @notice The raw layer is stock OpenZeppelin: nothing overrides the ledger,
    ///         so the accounting identity must hold exactly.
    function invariant_RawSupplyEqualsSumOfBalances() public view {
        uint256 sum = token.balanceOf(user1) + token.balanceOf(user2) + token.balanceOf(user3)
            + token.balanceOf(user4) + token.balanceOf(address(module))
            + token.balanceOf(address(queue)) + token.balanceOf(address(wrapper))
            + token.balanceOf(treasury) + token.balanceOf(address(handler));
        assertEq(sum, token.totalSupply());
    }

    function invariant_SupplyWithinCap() public view {
        assertLe(token.totalSupply(), token.maxSupply());
        assertLe(token.maxSupply(), Constants.MAX_TOTAL_SUPPLY);
    }

    // ============ M_oku ============

    /// @notice Monotonic by deliberate narrowing of ERC-8056.
    function invariant_MultiplierNeverDecreases() public view {
        assertGe(token.uiMultiplier(), handler.ghostMaxMultiplier());
    }

    function invariant_MultiplierWithinCeiling() public view {
        assertLe(token.uiMultiplier(), Constants.MAX_MULTIPLIER);
        assertGe(token.uiMultiplier(), Constants.PRECISION);
    }

    /// @notice The immediate-step invariant. Steps take effect on write, so the
    ///         ERC-8056 pending value is the live value at every block — there is
    ///         never a scheduled-but-unapplied multiplier for anyone to plan
    ///         around, and no boundary at which the two disagree.
    function invariant_PendingEqualsCurrentAlways() public view {
        assertEq(token.uiMultiplier(), token.newUIMultiplier());
        assertLe(token.effectiveAt(), block.timestamp);
    }

    function invariant_StepHighWaterMarkWithinBound() public view {
        assertLe(token.stepHighWaterMark(), Constants.MAX_STEP_BPS);
    }

    /// @notice STEP COVERAGE, the economic invariant of the whole design. Once a
    ///         step of N bps has landed, the round-trip fee cannot fall below N —
    ///         which is what makes mint-at-M0 / redeem-at-M1 unprofitable.
    ///
    /// @dev Holds unconditionally UNLESS the cold escape hatch fired. That
    ///      conditional is not a weakening of the test: it is the honest
    ///      statement of the property, and the ghost flag exists so the one
    ///      permitted way out of the ratchet is the only way out the fuzzer can
    ///      find.
    function invariant_StepCoverageRatchet() public view {
        if (handler.ghostStepFloorReset()) return;
        assertGe(
            module.tin() + module.tout(),
            token.stepHighWaterMark(),
            "fees fell below a step already taken"
        );
    }

    // ============ M_usd ============

    /// @notice Monotone. A compromised rate setter can over-accrue but never
    ///         confiscate by writing the index down.
    function invariant_UsdIndexNeverDecreases() public view {
        assertGe(usdOku.usdOkuIndex(), handler.ghostMaxUsdIndex());
    }

    function invariant_UsdIndexWithinCeiling() public view {
        assertLe(usdOku.usdOkuIndex(), Constants.MAX_MULTIPLIER);
        assertGe(usdOku.usdOkuIndex(), Constants.PRECISION);
    }

    function invariant_UsdImpliedAprWithinCap() public view {
        assertLe(usdOku.impliedAprBps(), Constants.MAX_IMPLIED_APR);
    }

    /// @notice Accrual halts flat at `rateEnd`. This is the operator-absence
    ///         protection: a dead rate setter freezes yield rather than accruing
    ///         indefinitely against assets that are not there.
    function invariant_UsdIndexHaltsAtRateEnd() public view {
        if (block.timestamp >= usdOku.rateEnd()) {
            uint256 last = usdOku.lastAccrualTime();
            uint256 end = usdOku.rateEnd();
            // Past rateEnd the index is a pure function of stored state, so it
            // must equal the value computed from the frozen elapsed term.
            uint256 expected = end <= last
                ? usdOku.baseIndex()
                : MathLib.toUiAmount(
                    usdOku.baseIndex(),
                    MathLib.rpow(usdOku.ratePerSecond(), end - last, Constants.PRECISION)
                );
            assertEq(usdOku.usdOkuIndex(), expected, "index moved past rateEnd");
        }
    }

    // ============ Post-step sync window ============

    /// @notice The window can never outlive its bound, from any reachable state.
    ///
    /// @dev This is the property that keeps the mechanism from degenerating into
    ///      an unbounded pause on a warmer key. The handler drives
    ///      `stepMultiplier` (which arms) and `setSyncWindowDuration` in
    ///      arbitrary interleavings, so if any path could stack or extend a
    ///      window past `MAX_SYNC_WINDOW` the fuzzer should find it.
    ///
    ///      Note this holds *by construction* now in a way it did not under the
    ///      begin/end design: there is exactly one write site
    ///      (`_armSyncWindow`), and it assigns rather than extends.
    function invariant_SyncWindowWithinBound() public view {
        uint256 lockedUntil = token.syncLockedUntil();
        if (lockedUntil > block.timestamp) {
            assertLe(
                lockedUntil - block.timestamp,
                Constants.MAX_SYNC_WINDOW,
                "sync window exceeded its ceiling"
            );
        }
        assertLe(token.syncWindowDuration(), Constants.MAX_SYNC_WINDOW);
    }

    // ============ Display / value coherence ============

    function invariant_TotalSupplyUiMatchesConversion() public view {
        assertEq(
            token.totalSupplyUI(), MathLib.toUiAmount(token.totalSupply(), token.uiMultiplier())
        );
    }

    /// @notice Per-balance flooring: the sum of displayed balances is bounded above
    ///         by the displayed total, with a gap of at most one wei per holder.
    function invariant_DisplaySumBoundedByTotal() public view {
        uint256 sum = token.balanceOfUI(user1) + token.balanceOfUI(user2) + token.balanceOfUI(user3)
            + token.balanceOfUI(user4) + token.balanceOfUI(address(module))
            + token.balanceOfUI(address(queue)) + token.balanceOfUI(address(wrapper))
            + token.balanceOfUI(treasury) + token.balanceOfUI(address(handler));
        assertLe(sum, token.totalSupplyUI());
        assertGe(sum + 9, token.totalSupplyUI());
    }

    /// @notice The value/display parity bound. Not an equality: `convertToAssets`
    ///         returns USDC at 6 dp while `uiMultiplier()` is 18 dp.
    function invariant_ValueDisplayParity() public view {
        uint256 cta = token.convertToAssets(Constants.PRECISION);
        uint256 m = token.uiMultiplier();
        uint256 dm = token.usdcDecimalMultiplier();
        assertLe(cta * dm, m);
        assertLt(m, (cta + 1) * dm);
    }

    // ============ USDOku share ledger ============

    /// @notice EXACT, unlike every other conservation property here. Shares move
    ///         only through `mint` / `burnShares` / share transfers; no donation
    ///         path can create or destroy them, so a discrepancy would be a leak
    ///         in the rebasing ledger rather than a griefing artefact.
    function invariant_UsdOkuSharesConserved() public view {
        uint256 sum = usdOku.sharesOf(user1) + usdOku.sharesOf(user2) + usdOku.sharesOf(user3)
            + usdOku.sharesOf(user4) + usdOku.sharesOf(address(wrapper))
            + usdOku.sharesOf(address(handler));
        assertEq(sum, usdOku.totalShares());
    }

    function invariant_UsdOkuSupplyMatchesShares() public view {
        assertEq(
            usdOku.totalSupply(), MathLib.toUiAmount(usdOku.totalShares(), usdOku.usdOkuIndex())
        );
    }

    /// @notice USDOku must NEVER claim ERC-8056. Its `balanceOf` is already
    ///         dollar-denominated, so an aware wallet applying a multiplier on
    ///         top would double-scale. Asserted here so no future refactor
    ///         quietly adds it.
    function invariant_UsdOkuNeverClaimsScaledUi() public view {
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_CORE));
        assertTrue(token.supportsInterface(Constants.IID_SCALED_UI_CORE));
    }

    // ============ Solvency ============

    /// @notice The solvency bound, stated as the property that is ACTUALLY true.
    ///
    /// @dev READ THIS BEFORE "STRENGTHENING" IT TO A RATIO BOUND. The obvious
    ///      invariant — `solvencyGapBps() <= MAX_SOLVENCY_GAP_BPS` at every
    ///      block — is FALSE, and the fuzzer found the counterexample: a
    ///      sequence ending in three `unwrap` calls drove the ratio to 146 bps
    ///      against a 100 bps bound with no rate write involved at all.
    ///
    ///      The arithmetic, because it is not obvious and an earlier version of
    ///      this comment asserted the opposite:
    ///
    ///        An unwrap of dollar value `d` burns `d` of liability and pays out
    ///        `d / M_oku` of OkuM, which is `d` of backing. Both legs fall by
    ///        the same `d`, so the ABSOLUTE shortfall `L - B` is preserved
    ///        exactly — but `gapBps = (L - B) * 10_000 / B` keeps the same
    ///        numerator over a SMALLER denominator. Every ratio therefore grows
    ///        as holders exit, and diverges as backing approaches the shortfall.
    ///        Denominating in liability instead does not help: `L` shrinks too.
    ///
    ///      So the ratio is a monitoring signal, not an invariant — and a
    ///      genuinely useful one, since a small absolute shortfall presenting as
    ///      a large ratio is exactly the shape of a wrapper draining toward its
    ///      last holders. `SolvencyTest.test_Unwrap_PreservesShortfallButInflatesTheRatio`
    ///      pins that behaviour directly.
    ///
    ///      WHAT IS INVARIANT is the absolute shortfall, bounded against the
    ///      PEAK liability the wrapper has ever carried:
    ///
    ///        - Conversions cannot move it: wrap adds matching liability and
    ///          backing, unwrap removes matching liability and backing (both
    ///          price at `M_oku` — that is what this bound is really testing).
    ///        - `M_oku` marks and donations only add backing, shrinking it.
    ///        - Only `M_usd` accrual widens it, and every rate write bounds the
    ///          accrual it may add to `MAX_SOLVENCY_GAP_BPS` of backing at that
    ///          instant.
    ///
    ///      The peak rather than the live liability, deliberately: exits shrink
    ///      `L` while preserving the shortfall, so a live-figure denominator
    ///      would tighten under precisely the operation that cannot widen the
    ///      quantity being bounded. A high-water mark is the honest scale.
    ///
    ///      One further allowance is required and is not slack for its own sake:
    ///      `L` is `floor(totalShares * M_usd)` computed on the AGGREGATE, while
    ///      each `wrap` floored its own share credit individually. Aggregating
    ///      per-holder floors is not the same as flooring the aggregate, so a
    ///      sub-wei-per-holder discrepancy accumulates into the shortfall. It is
    ///      bounded by the liability scale, which is exactly what the envelope
    ///      below is expressed in.
    function invariant_ShortfallBoundedByPeakLiability() public view {
        uint256 liability = wrapper.declaredLiability();
        uint256 backing = wrapper.realizedBacking();
        if (liability <= backing) return; // over-backed: always acceptable.

        uint256 shortfall = liability - backing;
        uint256 peak = handler.ghostPeakLiability();

        // `MAX_SOLVENCY_GAP_BPS` of the peak liability, plus one wei so a
        // dust-only shortfall against a zero peak is not a failure.
        uint256 envelope = (peak * Constants.MAX_SOLVENCY_GAP_BPS) / Constants.BASIS_POINTS + 1;

        assertLe(
            shortfall,
            envelope,
            "absolute shortfall exceeded MAX_SOLVENCY_GAP_BPS of peak liability"
        );
    }

    // ============ Queue backing ============

    /// @notice BOUND, not equality. `donateToken` in the handler exists precisely
    ///         to prove why: anyone can transfer tokens to the queue for free, and
    ///         an equality here would be permanently griefable.
    function invariant_QueueEscrowIsBacked() public view {
        assertLe(queue.totalQueuedRaw(), token.balanceOf(address(queue)));
    }

    function invariant_QueueHeadNeverPassesTail() public view {
        assertLe(queue.queueHead(), queue.queueTail());
    }

    /// @notice The queue's reported USDC obligation is exactly the conversion of
    ///         its escrowed raw total at the live multiplier.
    /// @dev There is deliberately NO invariant asserting the buffer covers the
    ///      obligation: entries queue precisely when it does not. `WouldStrandQueue`
    ///      only stops the withdrawer from making an existing shortfall worse.
    function invariant_QueueObligationIsDerivedFromEscrow() public view {
        assertEq(
            queue.totalQueuedUsdc(),
            MathLib.dollarsToUsdc(
                MathLib.toUiAmount(queue.totalQueuedRaw(), token.uiMultiplier()),
                token.usdcDecimalMultiplier()
            )
        );
    }

    // ============ Module solvency ============

    /// @notice The module cannot pay out more USDC than it has ever received.
    /// @dev Inflow includes the pre-seeded buffer and free donations, both of
    ///      which are additive. This is near-tautological by conservation — its
    ///      value is as a cross-check that the handler's accounting of the
    ///      mint/redeem/process paths matches reality. It caught a genuine bug in
    ///      an earlier revision, where the ghost omitted the seeded buffer and the
    ///      invariant tripped the first time an accrued redemption paid out more
    ///      than its principal.
    function invariant_PsmOutflowBoundedByInflow() public view {
        assertLe(handler.ghostUsdcOut(), handler.ghostUsdcIn());
    }

    // ============ Handler sanity ============

    /// @notice Guards against a silently-degenerate run: if almost every action
    ///         reverts, the invariants above are being checked against a system
    ///         that never moved.
    function invariant_HandlerIsActuallyExercisingTheSystem() public view {
        if (handler.calls() > 50) {
            assertGt(handler.successes() * 100 / handler.calls(), 30, "handler success rate < 30%");
        }
    }
}
