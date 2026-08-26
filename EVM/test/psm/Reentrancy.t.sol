// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {ReentrantUSDC} from "../mocks/ReentrantUSDC.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {SubscriptionModule} from "../../src/psm/SubscriptionModule.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {ReentrancyGuardUpgradeable} from "../../src/lib/ReentrancyGuardUpgradeable.sol";

/**
 * @title ReentrancyTest
 * @notice Integration-level reentrancy: every `nonReentrant` guard in the
 *         system, exercised against an actual reentrant callback rather than
 *         against a harness.
 *
 * @dev WHAT THIS COVERS THAT `ReentrancyGuardTest` DOES NOT. That suite tests
 *      the guard primitive in isolation — that the flag flips, that a direct
 *      self-call reverts. It says nothing about whether the guard is APPLIED to
 *      the right functions, or whether a real external call inside a real payout
 *      path can be turned back on the protocol. Before this file, every
 *      `nonReentrant` on `SubscriptionModule`, `RedemptionQueue` and
 *      `USDOkuWrapper` was unexercised against a hostile counterparty: the
 *      modifier could have been deleted from any of them and the suite would
 *      still have been green.
 *
 *      THE VECTOR. The protocol's only calls into code it does not control are
 *      the USDC transfers on the payout paths. `ReentrantUSDC` fires a
 *      configurable callback from inside that transfer, so the reentrant attempt
 *      lands exactly where a real one would — mid-state-update, after the
 *      external call has begun.
 *
 *      Substituting the ASSET rather than `OkuM` is deliberate and is argued in
 *      `ReentrantUSDC`'s header: it keeps every production contract in the test
 *      real, and makes the untrusted party the one that actually is untrusted.
 *
 *      HOW TO READ A TEST HERE. Three assertions, and all three matter:
 *        1. `callbackCount > 0`  — the hook fired. Without this the test would
 *           pass vacuously if the callback silently never ran, which is the
 *           failure mode that makes reentrancy suites worthless.
 *        2. `!lastCallSucceeded` — the reentrant call was rejected.
 *        3. the outer operation still settled correctly — the guard blocked the
 *           reentrant call without corrupting the legitimate one.
 */
contract ReentrancyTest is BaseTest {
    ReentrantUSDC internal hostile;

    /// @dev Swap the asset for the hostile variant. The rest of the stack —
    ///      `OkuM`, module, queue, `USDOku`, wrapper — is deployed by
    ///      `BaseTest.setUp` exactly as every other suite gets it.
    function _deployAsset() internal override returns (MockUSDC) {
        hostile = new ReentrantUSDC();
        return MockUSDC(address(hostile));
    }

    function setUp() public override {
        super.setUp();
        _seedBuffer(1_000_000e6);
    }

    /// @dev Assert the armed callback fired and was rejected BY THE GUARD.
    ///
    ///      Checking the revert selector, not merely that the call failed, is
    ///      what makes these tests mean anything: a callback with a wrong
    ///      selector, a missing approval or an insufficient balance would also
    ///      "fail", and would satisfy a bare `assertFalse` while proving nothing
    ///      about `nonReentrant`.
    function _assertReentrancyBlocked() internal view {
        assertGt(hostile.callbackCount(), 0, "callback never fired - test is vacuous");
        assertFalse(hostile.lastCallSucceeded(), "reentrant call was NOT blocked");
        _assertGuardReverted(hostile.lastRevertData());
    }

    function _assertGuardReverted(bytes memory data) internal pure {
        assertEq(data.length, 4, "expected a bare 4-byte custom error selector");
        bytes4 got = bytes4(data);
        assertEq(
            got,
            ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector,
            "blocked, but not by nonReentrant"
        );
    }

    // ============ SubscriptionModule ============

    /// @notice `redeem` -> USDC payout -> reentrant `mint`. The classic
    ///         cross-function pair: the attacker mints against a buffer that has
    ///         already been debited but not yet reflected.
    function test_Redeem_ReentrantMint_IsBlocked() public {
        uint256 raw = _psmMint(user1, 1000e6);
        usdc.mint(user1, 500e6);

        vm.prank(user1);
        usdc.approve(address(module), 500e6);

        hostile.armReentrancy(address(module), abi.encodeCall(SubscriptionModule.mint, (500e6)));

        vm.startPrank(user1);
        token.approve(address(module), raw);
        uint256 out = module.redeem(raw);
        vm.stopPrank();

        _assertReentrancyBlocked();
        assertGt(out, 0, "the legitimate redemption still settled");
        assertEq(token.balanceOf(user1), 0);
    }

    /// @notice `redeem` -> reentrant `redeem`. Same function, which is the case a
    ///         naive "guard only cross-function calls" reading would miss.
    function test_Redeem_ReentrantRedeem_IsBlocked() public {
        uint256 raw = _psmMint(user1, 1000e6);

        vm.startPrank(user1);
        token.approve(address(module), raw);
        vm.stopPrank();

        hostile.armReentrancy(address(module), abi.encodeCall(SubscriptionModule.redeem, (raw / 2)));

        vm.prank(user1);
        module.redeem(raw);

        _assertReentrancyBlocked();
    }

    /// @notice `redeem` -> reentrant `redeemUiAmount`.
    function test_Redeem_ReentrantRedeemUiAmount_IsBlocked() public {
        uint256 raw = _psmMint(user1, 1000e6);

        vm.prank(user1);
        token.approve(address(module), raw);

        hostile.armReentrancy(
            address(module), abi.encodeCall(SubscriptionModule.redeemUiAmount, (10e18))
        );

        vm.prank(user1);
        module.redeem(raw);

        _assertReentrancyBlocked();
    }

    /// @notice `depositBuffer` has NO `nonReentrant`, and does not need one.
    ///
    /// @dev Found by this suite: an earlier version of this file asserted the
    ///      guard fired here and "passed" because the call was rejected by
    ///      `onlyRole` instead — the reentrant caller is the token contract,
    ///      which holds no role. Checking the revert SELECTOR rather than merely
    ///      that the call failed is what surfaced it.
    ///
    ///      `depositBuffer` is safe unguarded: it is role-gated, it only pulls
    ///      USDC inward, and it reads no state across the external call that it
    ///      then writes. Recorded as a deliberate absence so a future reviewer
    ///      does not "fix" it by adding a guard and assume this suite covers it.
    function test_DepositBuffer_IsRoleGatedNotGuarded() public {
        usdc.mint(bufferDepositor, 100e6);
        vm.prank(bufferDepositor);
        usdc.approve(address(module), 100e6);

        uint256 raw = _psmMint(user1, 1000e6);
        hostile.armReentrancy(
            address(module), abi.encodeCall(SubscriptionModule.depositBuffer, (100e6))
        );

        vm.startPrank(user1);
        token.approve(address(module), raw);
        module.redeem(raw);
        vm.stopPrank();

        assertGt(hostile.callbackCount(), 0, "callback fired");
        assertFalse(hostile.lastCallSucceeded(), "rejected");
        // Rejected by the role check (2-arg custom error), NOT by the guard.
        assertEq(hostile.lastRevertData().length, 68, "rejected by onlyRole, not nonReentrant");
    }

    /// @notice `sweepToken` -> reentrant `mint`. The one path where a hostile
    ///         ERC-20 is not hypothetical: the token address is caller-supplied.
    function test_SweepToken_ReentrantMint_IsBlocked() public {
        // A second hostile token, donated to the module and then swept. Cannot
        // reuse `usdc` — `sweepToken` refuses the asset (`CannotSweepAsset`).
        ReentrantUSDC donated = new ReentrantUSDC();
        donated.mint(address(module), 1000e6);

        usdc.mint(user1, 500e6);
        vm.prank(user1);
        usdc.approve(address(module), 500e6);

        donated.armReentrancy(address(module), abi.encodeCall(SubscriptionModule.mint, (500e6)));

        vm.prank(bufferWithdrawer);
        module.sweepToken(address(donated), treasury);

        assertGt(donated.callbackCount(), 0, "callback never fired - test is vacuous");
        assertFalse(donated.lastCallSucceeded(), "reentrant call was NOT blocked");
        _assertGuardReverted(donated.lastRevertData());
        assertEq(donated.balanceOf(treasury), 1000e6, "the sweep still settled");
    }

    // ============ RedemptionQueue ============

    /// @notice `processQueue` -> USDC payout -> reentrant `mint`.
    /// @dev The pre-refactor suite's second case, preserved. Note the payout
    ///      here is a `transferFrom` from the module rather than a `transfer`,
    ///      which is why `ReentrantUSDC` hooks `_update` rather than either
    ///      entry point.
    function test_ProcessQueue_ReentrantMint_IsBlocked() public {
        _queueOneRedemption();
        _seedBuffer(10_000e6);

        usdc.mint(user1, 500e6);
        vm.prank(user1);
        usdc.approve(address(module), 500e6);

        hostile.armReentrancy(address(module), abi.encodeCall(SubscriptionModule.mint, (500e6)));

        vm.prank(queueProcessor);
        module.processQueue(0, 1, 5000e6);

        _assertReentrancyBlocked();
        assertEq(queue.totalQueuedRaw(), 0, "the legitimate payout still settled");
    }

    /// @notice `processQueue` -> reentrant `processQueue`. Double-processing the
    ///         same entry is the worst outcome available here, so this is the
    ///         single most important assertion in the file.
    function test_ProcessQueue_ReentrantProcessQueue_IsBlocked() public {
        _queueOneRedemption();
        _seedBuffer(10_000e6);

        uint256 supplyBefore = token.totalSupply();

        hostile.armReentrancy(
            address(module), abi.encodeCall(SubscriptionModule.processQueue, (0, 1, 5000e6))
        );

        vm.prank(queueProcessor);
        module.processQueue(0, 1, 5000e6);

        _assertReentrancyBlocked();
        assertEq(queue.totalQueuedRaw(), 0);
        assertLt(token.totalSupply(), supplyBefore, "burned exactly once");
    }

    /// @notice `processQueue` -> reentrant `redeem`, i.e. re-entering to enqueue
    ///         while the queue is mid-drain.
    function test_ProcessQueue_ReentrantRedeem_IsBlocked() public {
        _queueOneRedemption();
        _seedBuffer(10_000e6);

        uint256 raw = _psmMint(user2, 500e6);
        vm.prank(user2);
        token.approve(address(module), raw);

        hostile.armReentrancy(address(module), abi.encodeCall(SubscriptionModule.redeem, (raw)));

        vm.prank(queueProcessor);
        module.processQueue(0, 1, 5000e6);

        _assertReentrancyBlocked();
    }

    // ============ USDOkuWrapper: out of reach of this harness ============

    /// @notice The wrapper's five `nonReentrant` guards CANNOT be exercised by a
    ///         hostile asset, and this documents why rather than pretending
    ///         otherwise.
    ///
    /// @dev `USDOkuWrapper` never touches USDC. Its only external calls are to
    ///      `OkuM` and `USDOku`, both of which the protocol deploys and
    ///      controls, so there is no untrusted callee anywhere in `wrap`,
    ///      `unwrap` or `withdrawSurplus` to reenter from. Its guards are
    ///      defence-in-depth against a future change that introduces one, not
    ///      protection against a present vector.
    ///
    ///      An earlier version of this file appeared to cover them by arming a
    ///      callback during `module.redeemUsdOku`. That does not work and the
    ///      selector assertion proved it: the module calls `wrapper.unwrap`
    ///      FIRST and pays USDC out afterwards, so by the time the hostile
    ///      transfer fires the wrapper's guard has already been released. The
    ///      reentrant `wrap` was failing on an allowance check, not on the
    ///      guard.
    ///
    ///      Covering these properly needs a hostile `OkuM` or `USDOku` — the
    ///      shape the pre-refactor suite used. Tracked in TRACKER.md rather than
    ///      approximated here.
    function test_WrapperGuardsAreNotReachableViaHostileAsset() public {
        uint256 usdOkuOut = _mintUsdOku(user1, 1000e6);
        uint256 spare = _psmMint(user2, 100e6);

        vm.prank(user2);
        token.approve(address(wrapper), spare);

        hostile.armReentrancy(address(wrapper), abi.encodeWithSignature("wrap(uint256)", spare));

        vm.startPrank(user1);
        usdOku.approve(address(module), usdOkuOut);
        module.redeemUsdOku(usdOkuOut);
        vm.stopPrank();

        assertGt(hostile.callbackCount(), 0, "callback fired");
        // NOT blocked by the wrapper's guard: it was already released. Asserted
        // so the day this becomes guard-blocked, someone reads this comment.
        assertFalse(hostile.lastCallSucceeded());
        assertNotEq(
            hostile.lastRevertData().length,
            4,
            "if this is now a bare selector, the wrapper guard became reachable - update this test"
        );
    }

    // ============ Sanity: the harness is capable of succeeding ============

    /// @notice CONTROL. An UNGUARDED reentrant call succeeds through the same
    ///         harness, proving the blocks above are the guards firing rather
    ///         than the callback mechanism being broken.
    ///
    /// @dev Without this, every assertion in this file could be satisfied by a
    ///      callback that always failed for an unrelated reason — a wrong
    ///      selector, a missing approval, an out-of-gas. `balanceOf` is a view
    ///      on the token and carries no guard, so it must come back `true`.
    function test_Control_UnguardedReentrantCallSucceeds() public {
        uint256 raw = _psmMint(user1, 1000e6);

        hostile.armReentrancy(address(token), abi.encodeWithSignature("totalSupply()"));

        vm.startPrank(user1);
        token.approve(address(module), raw);
        module.redeem(raw);
        vm.stopPrank();

        assertGt(hostile.callbackCount(), 0, "callback fired");
        assertTrue(
            hostile.lastCallSucceeded(),
            "an unguarded reentrant call must succeed, or this suite proves nothing"
        );
    }

    // ============ Helpers ============

    /// @dev Drain the buffer, then redeem so the redemption escrows into the queue.
    function _queueOneRedemption() internal {
        uint256 raw = _psmMint(user1, 1000e6);
        uint256 buffer = usdc.balanceOf(address(module));
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, buffer);

        vm.startPrank(user1);
        token.approve(address(module), raw);
        module.redeem(raw);
        vm.stopPrank();
        assertEq(queue.queueTail(), 1);
    }
}
